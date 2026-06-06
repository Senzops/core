import { Queue, Worker } from 'bullmq';
import { redisConnection, registerWorker } from './queue';
import { AlertIncident, AlertPolicy } from '../models/Alert';
import { Subscription } from '../models/Subscription';
import { getPlanConfig, PlanId } from '../config/pricing';
import { runIncidentAnalysis, IncidentContext } from '../services/aiAnalysis';
import { dispatchAnalysisUpdate } from '../services/alertTransport';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Queue Constants
// ---------------------------------------------------------------------------

const QUEUE_NAME = 'ai.incident-analysis';
const QUEUE_PREFIX = '{bull}';

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
    attempts: 1,  // No retries — analysis is best-effort, one shot
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
// Worker (Consumer)
// ---------------------------------------------------------------------------

export const createAiAnalysisWorker = (): Worker<AiAnalysisPayload> => {
  const worker = new Worker<AiAnalysisPayload>(
    QUEUE_NAME,
    async (job) => {
      const payload = job.data;
      const { incidentId, ownerId } = payload;

      logger.info(`[AI Analysis] Starting analysis for incident ${incidentId}`);

      // 1. Plan gate check
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

      // 2. Mark as pending
      await AlertIncident.findByIdAndUpdate(incidentId, {
        'aiAnalysis.status': 'pending',
      });

      // 3. Run the analysis
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

      // 4. Save result to incident
      await AlertIncident.findByIdAndUpdate(incidentId, { aiAnalysis: result });

      logger.info(
        `[AI Analysis] Completed for ${incidentId} — ` +
        `status=${result.status}, confidence=${result.confidence}, ` +
        `tools=${result.toolCallsUsed}, tokens=${result.tokensUsed.input + result.tokensUsed.output}, ` +
        `duration=${result.durationMs}ms`
      );

      // 5. Send follow-up notifications with analysis (if completed successfully)
      if (result.status === 'completed' && result.summary) {
        try {
          const incident = await AlertIncident.findById(incidentId).lean();
          if (incident && incident.status !== 'resolved') {
            const policy = await AlertPolicy.findById(payload.policyId)
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
    },
    {
      connection: redisConnection,
      prefix: QUEUE_PREFIX,
      concurrency: 3,  // Process up to 3 analyses in parallel
      lockDuration: 60_000,  // 60s lock — analysis can take up to 30s + overhead
    }
  );

  worker.on('failed', (job, err) => {
    logger.error(`[AI Analysis] Job ${job?.id} failed: ${err.message}`);
  });

  registerWorker(worker);
  return worker;
};

// ---------------------------------------------------------------------------
// Enqueue Helper
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
    // Non-fatal: if Redis is down, we just skip AI analysis
    logger.warn(`[AI Analysis] Failed to enqueue analysis for ${payload.incidentId}: ${err.message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
