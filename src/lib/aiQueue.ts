import { Queue, Worker } from 'bullmq';
import { redisConnection, registerWorker } from './queue';
import { AlertIncident, AlertPolicy } from '../models/Alert';
import { Subscription } from '../models/Subscription';
import { getPlanConfig, PlanId } from '../config/pricing';
import {
  runIncidentAnalysis,
  IncidentContext,
  RetryableAnalysisError,
  GEMINI_MODEL,
} from '../services/aiAnalysis';
import { dispatchAnalysisUpdate } from '../services/alertTransport';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Queue Constants
// ---------------------------------------------------------------------------

const QUEUE_NAME = 'ai.incident-analysis';
const QUEUE_PREFIX = '{bull}';

// ---------------------------------------------------------------------------
// Retry Configuration
// ---------------------------------------------------------------------------

/** Total number of attempts (initial + retries). 6 attempts ≈ 15 min window. */
const MAX_ATTEMPTS = 6;

/**
 * Base delay for exponential backoff in milliseconds.
 * Schedule: 30s → 60s → 120s → 240s → 480s (total ≈ 15.5 min).
 */
const INITIAL_BACKOFF_MS = 30_000;

// ---------------------------------------------------------------------------
// Payload Type
// ---------------------------------------------------------------------------

export interface AiAnalysisPayload {
  incidentId: string;
  ownerId: string;
  conditionName: string;
  conditionDescription: string;
  target: string;
  triggerValue: number;
  threshold: { operator: string; value: number; windowMins: number };
  severity: string;
  labels: string[];
  title: string;
  policyId: string;
}

// ---------------------------------------------------------------------------
// Queue Instance (Producer)
// ---------------------------------------------------------------------------

export const aiAnalysisQueue = new Queue<AiAnalysisPayload>(QUEUE_NAME, {
  connection: redisConnection,
  prefix: QUEUE_PREFIX,
  defaultJobOptions: {
    attempts: MAX_ATTEMPTS,
    backoff: {
      type: 'exponential',
      delay: INITIAL_BACKOFF_MS, // 30s → 60s → 120s → 240s → 480s
    },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86400, count: 5000 },
  },
});

// ---------------------------------------------------------------------------
// Monthly Quota Check
// ---------------------------------------------------------------------------

const checkMonthlyQuota = async (ownerId: string): Promise<{ allowed: boolean; reason?: string }> => {
  const subscription = await Subscription.findOne({
    ownerId,
    status: { $in: ['active', 'trialing'] },
  }).lean();

  const planId = (subscription?.planId as PlanId) || 'starter';
  const config = getPlanConfig(planId);

  if (!config.aiAnalysis) {
    return { allowed: false, reason: `AI analysis not available on ${config.name} plan` };
  }

  // Unlimited quota
  if (config.aiAnalysisMonthlyQuota === -1) {
    return { allowed: true };
  }

  // Count analyses this month
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const usedThisMonth = await AlertIncident.countDocuments({
    ownerId,
    'aiAnalysis.status': { $in: ['completed', 'failed'] },
    'aiAnalysis.analyzedAt': { $gte: monthStart },
  });

  if (usedThisMonth >= config.aiAnalysisMonthlyQuota) {
    return {
      allowed: false,
      reason: `Monthly AI analysis quota reached (${usedThisMonth}/${config.aiAnalysisMonthlyQuota})`,
    };
  }

  return { allowed: true };
};

// ---------------------------------------------------------------------------
// Core Analysis Pipeline
// ---------------------------------------------------------------------------

/**
 * Runs the full analysis pipeline: quota check → pending → analysis → save → notify.
 *
 * Shared by both the BullMQ worker (with retry) and the in-process fallback
 * (without retry). On transient Gemini errors, throws RetryableAnalysisError —
 * the caller decides whether to retry or persist failure.
 *
 * Non-retryable errors are caught internally and saved as `status: 'failed'`.
 */
async function executeAnalysis(payload: AiAnalysisPayload): Promise<void> {
  const { incidentId, ownerId, policyId } = payload;

  // 1. Plan & quota gate
  const quotaCheck = await checkMonthlyQuota(ownerId);
  if (!quotaCheck.allowed) {
    logger.info(`[AI Analysis] Skipped for ${incidentId}: ${quotaCheck.reason}`);
    await AlertIncident.findByIdAndUpdate(incidentId, {
      aiAnalysis: {
        status: 'skipped',
        summary: '',
        findings: { rootCause: '', affectedServices: [], correlatedEvents: [], recommendedActions: [] },
        confidence: 'low',
        toolCallsUsed: 0,
        tokensUsed: { input: 0, output: 0 },
        model: '',
        analyzedAt: null,
        durationMs: 0,
        error: quotaCheck.reason,
      },
    });
    return;
  }

  // 2. Ensure status is 'pending' (idempotent — safe on retries)
  await AlertIncident.findByIdAndUpdate(incidentId, {
    'aiAnalysis.status': 'pending',
  });

  // 3. Run analysis — throws RetryableAnalysisError for transient failures
  const ctx: IncidentContext = {
    incidentId: payload.incidentId,
    ownerId: payload.ownerId,
    conditionName: payload.conditionName,
    conditionDescription: payload.conditionDescription,
    target: payload.target,
    triggerValue: payload.triggerValue,
    threshold: payload.threshold,
    severity: payload.severity,
    labels: payload.labels,
    title: payload.title,
  };

  const result = await runIncidentAnalysis(ctx);

  // 4. Save result
  await AlertIncident.findByIdAndUpdate(incidentId, { aiAnalysis: result });

  logger.info(
    `[AI Analysis] Completed for ${incidentId} — ` +
    `status=${result.status}, confidence=${result.confidence}, ` +
    `tools=${result.toolCallsUsed}, tokens=${result.tokensUsed.input + result.tokensUsed.output}, ` +
    `duration=${result.durationMs}ms`
  );

  // 5. Follow-up notifications (completed analyses only)
  if (result.status === 'completed' && result.summary) {
    try {
      const incident = await AlertIncident.findById(incidentId).lean();
      if (incident && incident.status !== 'resolved') {
        const policy = await AlertPolicy.findById(policyId)
          .populate('destinations')
          .lean();

        if (policy?.destinations?.length) {
          await dispatchAnalysisUpdate(policy.destinations, incident, result, policy);
        }
      }
    } catch (notifyErr: any) {
      // Non-fatal: analysis is saved, notification is best-effort
      logger.warn(`[AI Analysis] Follow-up notification failed for ${incidentId}: ${notifyErr.message}`);
    }
  }
}

/**
 * Persists a failed analysis state to the incident document.
 * Wrapped in try/catch to prevent secondary failures from masking the original error.
 */
async function persistFailure(incidentId: string, errorMessage: string): Promise<void> {
  try {
    await AlertIncident.findByIdAndUpdate(incidentId, {
      aiAnalysis: {
        status: 'failed',
        summary: '',
        findings: { rootCause: '', affectedServices: [], correlatedEvents: [], recommendedActions: [] },
        confidence: 'low',
        toolCallsUsed: 0,
        tokensUsed: { input: 0, output: 0 },
        model: GEMINI_MODEL,
        analyzedAt: new Date(),
        durationMs: 0,
        error: errorMessage,
      },
    });
  } catch (dbErr: any) {
    logger.error(`[AI Analysis] Failed to persist error state for ${incidentId}: ${dbErr.message}`);
  }
}

// ---------------------------------------------------------------------------
// Worker (Consumer) — BullMQ with exponential backoff retries
// ---------------------------------------------------------------------------

export const createAiAnalysisWorker = (): Worker<AiAnalysisPayload> => {
  const worker = new Worker<AiAnalysisPayload>(
    QUEUE_NAME,
    async (job) => {
      const { incidentId } = job.data;
      const attemptNum = job.attemptsMade + 1;

      logger.info(
        `[AI Analysis] Starting analysis for incident ${incidentId} (attempt ${attemptNum}/${MAX_ATTEMPTS})`
      );

      try {
        await executeAnalysis(job.data);
      } catch (err: any) {
        // ---------------------------------------------------------------
        // Retry Logic — exponential backoff for transient Gemini errors
        // ---------------------------------------------------------------
        const isRetryable = err instanceof RetryableAnalysisError;
        const hasRetriesLeft = attemptNum < MAX_ATTEMPTS;

        if (isRetryable && hasRetriesLeft) {
          // Transient error with retries remaining — re-throw for BullMQ backoff.
          // Status stays 'pending' so the frontend shows the spinner, not an error.
          const nextDelay = INITIAL_BACKOFF_MS * Math.pow(2, job.attemptsMade);
          logger.warn(
            `[AI Analysis] Transient error for ${incidentId} (HTTP ${err.statusCode || 'N/A'}), ` +
            `retrying in ${Math.round(nextDelay / 1000)}s ` +
            `(attempt ${attemptNum}/${MAX_ATTEMPTS}): ${err.shortMessage}`
          );
          throw err; // BullMQ schedules retry with exponential backoff
        }

        // All retries exhausted OR non-retryable error — persist failure
        const errorMessage = isRetryable
          ? `Failed after ${attemptNum} attempt(s): ${err.shortMessage}`
          : (err.message || 'Unknown error');

        logger.error(
          `[AI Analysis] ${isRetryable ? `All ${MAX_ATTEMPTS} attempts exhausted` : 'Non-retryable failure'} ` +
          `for ${incidentId}: ${errorMessage}`
        );

        await persistFailure(incidentId, errorMessage);
        // Return — completes the job, prevents further retries
      }
    },
    {
      connection: redisConnection,
      prefix: QUEUE_PREFIX,
      concurrency: 3,     // Process up to 3 analyses in parallel
      lockDuration: 90_000, // 90s — analysis up to 30s + tool calls + overhead
    }
  );

  worker.on('failed', (job, err) => {
    // Fires when BullMQ exhausts all retries (safety net — normally handled above)
    logger.error(`[AI Analysis] Job ${job?.id} permanently failed: ${err.message}`);
  });

  registerWorker(worker);
  return worker;
};

// ---------------------------------------------------------------------------
// Enqueue with In-Process Fallback
// ---------------------------------------------------------------------------

const ENQUEUE_TIMEOUT_MS = 3000;

export const enqueueIncidentAnalysis = async (payload: AiAnalysisPayload): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addPromise = aiAnalysisQueue.add('analyze', payload, {
      // Deduplicate by incident ID — prevent duplicate analyses
      jobId: `analysis-${payload.incidentId}`,
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('AI queue enqueue timeout')), ENQUEUE_TIMEOUT_MS);
    });

    await Promise.race([addPromise, timeoutPromise]);
    logger.info(`[AI Analysis] Enqueued analysis for incident ${payload.incidentId}`);
  } catch (err: any) {
    // Redis unavailable — fall back to in-process analysis (same as other queues)
    logger.warn(
      `[AI Analysis] Redis unavailable, falling back to in-process for ${payload.incidentId}: ${err.message}`
    );
    setImmediate(() => {
      executeAnalysisInline(payload).catch((fallbackErr) => {
        logger.error(
          `[AI Analysis] In-process fallback failed for ${payload.incidentId}: ${fallbackErr.message}`
        );
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * In-process fallback when Redis is unavailable.
 * Runs the full analysis pipeline without BullMQ retry support.
 * Transient Gemini errors are caught and saved as failures since there is
 * no queue infrastructure to schedule retries.
 */
async function executeAnalysisInline(payload: AiAnalysisPayload): Promise<void> {
  const { incidentId } = payload;

  logger.info(`[AI Analysis] Running in-process analysis for ${incidentId} (no retry support)`);

  try {
    await executeAnalysis(payload);
  } catch (err: any) {
    // No retry infrastructure available — persist failure directly
    const errorMessage = err instanceof RetryableAnalysisError
      ? `${err.shortMessage} (in-process fallback — retries unavailable)`
      : (err.message || 'Unknown error');

    logger.error(`[AI Analysis] In-process analysis failed for ${incidentId}: ${errorMessage}`);
    await persistFailure(incidentId, errorMessage);
  }
}
