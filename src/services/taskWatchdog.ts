import mongoose from 'mongoose';
import { CronExpressionParser } from 'cron-parser';
import os from 'os';
import { TaskSignature, TaskService, TaskRun, TaskMetric, SystemLock } from '../models/Task';
import { ErrorGroup, ErrorEvent, generateErrorFingerprint } from '../models/Error';
import { logger } from '../utils/logger';

const WORKER_ID = `${os.hostname()}-${process.pid}`;
const LOCK_NAME = 'task-watchdog-sweep';
const LOCK_TTL_MS = 4 * 60 * 1000;
const BATCH_SIZE = 500;

const DEFAULT_GRACE_PERIOD_MS = 120_000;
const DEFAULT_EARLY_JITTER_MS = 5_000;
const DEFAULT_FAILURE_RATE_THRESHOLD = 0.5;
const DEFAULT_FAILURE_RATE_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_FAILURE_RATE_MIN_RUNS = 3;
const DEFAULT_DURATION_ANOMALY_MULTIPLIER = 3;
const DEFAULT_DURATION_SHORT_RATIO = 0.1;
const DEFAULT_DURATION_MIN_AVG_MS = 1_000;
const DEFAULT_SCHEDULE_LATE_THRESHOLD_MS = 60_000;
const DEFAULT_SCHEDULE_EARLY_THRESHOLD_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_DEAD_LETTER_THRESHOLD = 5;
const DEFAULT_DEAD_LETTER_WINDOW_MS = 30 * 60 * 1000;
const SWEEP_WINDOW_MS = 3 * 60 * 1000;

interface SweepContext {
  now: Date;
  nowMs: number;
  activeServices: Map<string, any>;
  signatureUpdates: any[];
  serviceUpdates: any[];
  anomalies: any[];
  counters: {
    missed: number;
    recovered: number;
    failing: number;
    heartbeatLost: number;
    deadLetters: number;
    durationAnomalies: number;
    shortDurations: number;
    lateRuns: number;
    earlyRuns: number;
  };
}

interface StrategyResult {
  name: string;
  success: boolean;
  error?: string;
}

const createSweepContext = (now: Date, services: Map<string, any>): SweepContext => ({
  now,
  nowMs: now.getTime(),
  activeServices: services,
  signatureUpdates: [],
  serviceUpdates: [],
  anomalies: [],
  counters: {
    missed: 0,
    recovered: 0,
    failing: 0,
    heartbeatLost: 0,
    deadLetters: 0,
    durationAnomalies: 0,
    shortDurations: 0,
    lateRuns: 0,
    earlyRuns: 0,
  },
});

const pushHealthTransition = (
  ctx: SweepContext,
  sigId: mongoose.Types.ObjectId,
  newState: string,
  extras: Record<string, any> = {}
) => {
  ctx.signatureUpdates.push({
    updateOne: {
      filter: { _id: sigId },
      update: { $set: { healthState: newState, lastHealthTransition: ctx.now, ...extras } },
    },
  });
};

const pushAnomaly = (
  ctx: SweepContext,
  service: any,
  sig: any,
  errorClass: string,
  message: string,
  stackTrace: string,
  context: Record<string, any> = {}
) => {
  const fingerprint = generateErrorFingerprint(service._id, errorClass, message);
  ctx.anomalies.push({ sig, service, fingerprint, errorClass, message, stackTrace, context, timestamp: ctx.now });
};

// ─── Strategy 1: Missed Cron Detection ───────────────────────────────────────
// Detects crons that did not execute within their expected schedule window + grace period.
// Health transition: healthy → missing (recovers when a run lands in the next window).

const evaluateMissedCrons = async (ctx: SweepContext) => {
  const cursor = TaskSignature.find({
    taskType: 'cron',
    scheduleExpression: { $exists: true, $ne: null },
  })
    .select('_id taskName serviceId scheduleExpression lastRunAt healthState consecutiveMisses gracePeriodMs')
    .lean()
    .cursor();

  for await (const sig of cursor) {
    const service = ctx.activeServices.get(sig.serviceId.toString());
    if (!service || !sig.scheduleExpression) continue;

    try {
      const interval = CronExpressionParser.parse(sig.scheduleExpression, { currentDate: ctx.now });
      const expectedPreviousRun = interval.prev().toDate();
      const gracePeriod = sig.gracePeriodMs || DEFAULT_GRACE_PERIOD_MS;
      const expectedWithGrace = new Date(expectedPreviousRun.getTime() + gracePeriod);
      const expectedMinusJitter = new Date(expectedPreviousRun.getTime() - DEFAULT_EARLY_JITTER_MS);

      if (ctx.now < expectedWithGrace) continue;

      const hasMissed = !sig.lastRunAt || new Date(sig.lastRunAt) < expectedMinusJitter;

      if (hasMissed) {
        const newMisses = (sig.consecutiveMisses || 0) + 1;

        if (sig.healthState !== 'missing') {
          ctx.counters.missed++;
          pushHealthTransition(ctx, sig._id, 'missing', { consecutiveMisses: newMisses });

          const message = `Cron job "${sig.taskName}" missed its scheduled execution.`;
          pushAnomaly(
            ctx, service, sig, 'MissedCronRun', message,
            `Watchdog detected missed cron execution for "${sig.taskName}"\n` +
            `Schedule: ${sig.scheduleExpression}\n` +
            `Expected: ${expectedPreviousRun.toISOString()}\n` +
            `Last Run: ${sig.lastRunAt ? new Date(sig.lastRunAt).toISOString() : 'Never'}\n` +
            `Consecutive Misses: ${newMisses}`,
            { expectedPreviousRun, lastRunAt: sig.lastRunAt, consecutiveMisses: newMisses }
          );
        } else {
          ctx.signatureUpdates.push({
            updateOne: {
              filter: { _id: sig._id },
              update: { $set: { consecutiveMisses: newMisses } },
            },
          });
        }
      } else if (sig.healthState === 'missing') {
        ctx.counters.recovered++;
        pushHealthTransition(ctx, sig._id, 'healthy', { consecutiveMisses: 0 });
      }
    } catch {
      // Invalid cron expression — don't change health, just skip
    }
  }
};

// ─── Strategy 2: Schedule Deviation Detection ────────────────────────────────
// Detects crons that ran but started significantly early or late relative to
// their cron schedule. This is an anomaly alert only — does NOT change health state,
// because the task did execute (just at the wrong time).

const evaluateScheduleDeviations = async (ctx: SweepContext) => {
  const windowStart = new Date(ctx.nowMs - SWEEP_WINDOW_MS);

  const cronSignatures = await TaskSignature.find({
    taskType: 'cron',
    scheduleExpression: { $exists: true, $ne: null },
    lastRunAt: { $gte: windowStart },
  })
    .select('_id taskName serviceId scheduleExpression lastRunAt')
    .lean();

  if (cronSignatures.length === 0) return;

  for (const sig of cronSignatures) {
    const service = ctx.activeServices.get(sig.serviceId.toString());
    if (!service || !sig.scheduleExpression || !sig.lastRunAt) continue;

    try {
      const runTime = new Date(sig.lastRunAt);
      const runMs = runTime.getTime();

      const prevInterval = CronExpressionParser.parse(sig.scheduleExpression, { currentDate: runTime });
      const prevTick = prevInterval.prev().toDate();
      const nextInterval = CronExpressionParser.parse(sig.scheduleExpression, { currentDate: runTime });
      const nextTick = nextInterval.next().toDate();

      const distToPrev = runMs - prevTick.getTime();
      const distToNext = nextTick.getTime() - runMs;

      if (distToPrev <= distToNext) {
        if (distToPrev > DEFAULT_SCHEDULE_LATE_THRESHOLD_MS) {
          ctx.counters.lateRuns++;
          const message = `Cron "${sig.taskName}" started ${Math.round(distToPrev / 1000)}s late.`;
          pushAnomaly(
            ctx, service, sig, 'LateScheduleExecution', message,
            `Watchdog detected late cron start for "${sig.taskName}"\n` +
            `Schedule: ${sig.scheduleExpression}\n` +
            `Expected: ${prevTick.toISOString()}\n` +
            `Actual: ${runTime.toISOString()}\n` +
            `Deviation: +${Math.round(distToPrev / 1000)}s\n` +
            `Threshold: ${DEFAULT_SCHEDULE_LATE_THRESHOLD_MS / 1000}s`,
            { expectedRun: prevTick, actualRun: runTime, deviationMs: distToPrev }
          );
        }
      } else {
        if (distToNext > DEFAULT_SCHEDULE_EARLY_THRESHOLD_MS) {
          ctx.counters.earlyRuns++;
          const message = `Cron "${sig.taskName}" started ${Math.round(distToNext / 1000)}s early.`;
          pushAnomaly(
            ctx, service, sig, 'EarlyScheduleExecution', message,
            `Watchdog detected early cron start for "${sig.taskName}"\n` +
            `Schedule: ${sig.scheduleExpression}\n` +
            `Expected: ${nextTick.toISOString()}\n` +
            `Actual: ${runTime.toISOString()}\n` +
            `Deviation: -${Math.round(distToNext / 1000)}s\n` +
            `Threshold: ${DEFAULT_SCHEDULE_EARLY_THRESHOLD_MS / 1000}s`,
            { expectedRun: nextTick, actualRun: runTime, deviationMs: -distToNext }
          );
        }
      }
    } catch {
      // Invalid cron expression — skip
    }
  }
};

// ─── Strategy 3: Failure Rate Detection ──────────────────────────────────────
// Evaluates failure rate over a sliding 10-minute window.
// Health transition: healthy → failing at ≥50%, recovers at <25% (hysteresis).

const evaluateFailureRates = async (ctx: SweepContext) => {
  const activeServiceIds = Array.from(ctx.activeServices.keys()).map(
    id => new mongoose.Types.ObjectId(id)
  );

  if (activeServiceIds.length === 0) return;

  const windowStart = new Date(ctx.nowMs - DEFAULT_FAILURE_RATE_WINDOW_MS);

  const metrics = await TaskMetric.aggregate([
    {
      $match: {
        serviceId: { $in: activeServiceIds },
        timestamp: { $gte: windowStart, $lte: ctx.now },
      },
    },
    {
      $group: {
        _id: { serviceId: '$serviceId', taskName: '$taskName' },
        totalRuns: { $sum: '$runs' },
        totalFailures: { $sum: '$failures' },
      },
    },
    {
      $match: {
        totalRuns: { $gte: DEFAULT_FAILURE_RATE_MIN_RUNS },
      },
    },
  ]);

  if (metrics.length === 0) return;

  const signatureKeys = metrics.map((m: any) => ({
    serviceId: m._id.serviceId,
    taskName: m._id.taskName,
  }));

  const signatures = await TaskSignature.find({
    $or: signatureKeys.map(k => ({ serviceId: k.serviceId, taskName: k.taskName })),
  })
    .select('_id taskName serviceId healthState consecutiveFailures failureRateThreshold')
    .lean();

  const sigMap = new Map(signatures.map(s => [`${s.serviceId}_${s.taskName}`, s]));

  for (const m of metrics) {
    const key = `${m._id.serviceId}_${m._id.taskName}`;
    const sig = sigMap.get(key);
    if (!sig) continue;

    if (sig.healthState === 'missing') continue;

    const service = ctx.activeServices.get(m._id.serviceId.toString());
    if (!service) continue;

    const failureRate = m.totalFailures / m.totalRuns;
    const threshold = sig.failureRateThreshold || DEFAULT_FAILURE_RATE_THRESHOLD;

    if (failureRate >= threshold) {
      const newConsecutive = (sig.consecutiveFailures || 0) + 1;

      if (sig.healthState !== 'failing') {
        ctx.counters.failing++;
        pushHealthTransition(ctx, sig._id, 'failing', { consecutiveFailures: newConsecutive });

        const pct = (failureRate * 100).toFixed(1);
        const message = `Task "${sig.taskName}" has a ${pct}% failure rate (${m.totalFailures}/${m.totalRuns} in last 10m).`;
        pushAnomaly(
          ctx, service, sig, 'HighFailureRate', message,
          `Watchdog detected high failure rate for "${sig.taskName}"\n` +
          `Failure Rate: ${pct}%\n` +
          `Failures: ${m.totalFailures} / ${m.totalRuns} runs\n` +
          `Window: Last 10 minutes\n` +
          `Threshold: ${(threshold * 100).toFixed(0)}%\n` +
          `Consecutive Evaluations Failing: ${newConsecutive}`,
          { failureRate, totalRuns: m.totalRuns, totalFailures: m.totalFailures, consecutiveFailures: newConsecutive }
        );
      } else {
        ctx.signatureUpdates.push({
          updateOne: {
            filter: { _id: sig._id },
            update: { $set: { consecutiveFailures: newConsecutive } },
          },
        });
      }
    } else if (sig.healthState === 'failing' && failureRate < threshold * 0.5) {
      ctx.counters.recovered++;
      pushHealthTransition(ctx, sig._id, 'healthy', { consecutiveFailures: 0 });
    }
  }
};

// ─── Strategy 4: Duration Anomaly Detection ──────────────────────────────────
// Two sub-checks:
//   Slow: maxDuration in window >= avgDuration × 3 (task took abnormally long)
//   Fast: minDuration in window <= avgDuration × 0.1 (suspiciously quick — may have skipped work)
// Both require avgDuration >= 1s to avoid noise on trivial tasks.
// Anomaly events only — does NOT change health state.

const evaluateDurationAnomalies = async (ctx: SweepContext) => {
  const activeServiceIds = Array.from(ctx.activeServices.keys()).map(
    id => new mongoose.Types.ObjectId(id)
  );

  if (activeServiceIds.length === 0) return;

  const windowStart = new Date(ctx.nowMs - DEFAULT_FAILURE_RATE_WINDOW_MS);

  const recentDurations = await TaskMetric.aggregate([
    {
      $match: {
        serviceId: { $in: activeServiceIds },
        timestamp: { $gte: windowStart, $lte: ctx.now },
      },
    },
    {
      $group: {
        _id: { serviceId: '$serviceId', taskName: '$taskName' },
        maxDuration: { $max: '$durationMax' },
        minDuration: { $min: '$durationMin' },
        totalRuns: { $sum: '$runs' },
      },
    },
    {
      $match: { totalRuns: { $gte: 1 } },
    },
  ]);

  if (recentDurations.length === 0) return;

  const signatureKeys = recentDurations.map((m: any) => ({
    serviceId: m._id.serviceId,
    taskName: m._id.taskName,
  }));

  const signatures = await TaskSignature.find({
    $or: signatureKeys.map(k => ({ serviceId: k.serviceId, taskName: k.taskName })),
    avgDuration: { $gt: 0 },
  })
    .select('_id taskName serviceId avgDuration')
    .lean();

  const sigMap = new Map(signatures.map(s => [`${s.serviceId}_${s.taskName}`, s]));

  for (const m of recentDurations) {
    const key = `${m._id.serviceId}_${m._id.taskName}`;
    const sig = sigMap.get(key);
    if (!sig || sig.avgDuration < DEFAULT_DURATION_MIN_AVG_MS) continue;

    const service = ctx.activeServices.get(m._id.serviceId.toString());
    if (!service) continue;

    const slowRatio = m.maxDuration / sig.avgDuration;
    if (slowRatio >= DEFAULT_DURATION_ANOMALY_MULTIPLIER) {
      ctx.counters.durationAnomalies++;

      const message = `Task "${sig.taskName}" took ${Math.round(m.maxDuration)}ms (${slowRatio.toFixed(1)}x avg of ${Math.round(sig.avgDuration)}ms).`;
      pushAnomaly(
        ctx, service, sig, 'SlowTaskExecution', message,
        `Watchdog detected abnormally slow execution for "${sig.taskName}"\n` +
        `Max Duration (window): ${Math.round(m.maxDuration)}ms\n` +
        `Avg Duration (EMA): ${Math.round(sig.avgDuration)}ms\n` +
        `Ratio: ${slowRatio.toFixed(1)}x\n` +
        `Threshold: ${DEFAULT_DURATION_ANOMALY_MULTIPLIER}x`,
        { maxDuration: m.maxDuration, avgDuration: sig.avgDuration, ratio: slowRatio }
      );
    }

    if (m.minDuration != null && m.minDuration > 0 && m.minDuration < Number.MAX_SAFE_INTEGER) {
      const fastRatio = m.minDuration / sig.avgDuration;
      if (fastRatio <= DEFAULT_DURATION_SHORT_RATIO) {
        ctx.counters.shortDurations++;

        const message = `Task "${sig.taskName}" completed in ${Math.round(m.minDuration)}ms (${(fastRatio * 100).toFixed(1)}% of avg ${Math.round(sig.avgDuration)}ms) — may have skipped work.`;
        pushAnomaly(
          ctx, service, sig, 'SuspiciouslyFastExecution', message,
          `Watchdog detected abnormally fast execution for "${sig.taskName}"\n` +
          `Min Duration (window): ${Math.round(m.minDuration)}ms\n` +
          `Avg Duration (EMA): ${Math.round(sig.avgDuration)}ms\n` +
          `Ratio: ${(fastRatio * 100).toFixed(1)}% of avg\n` +
          `Threshold: <${(DEFAULT_DURATION_SHORT_RATIO * 100).toFixed(0)}% of avg`,
          { minDuration: m.minDuration, avgDuration: sig.avgDuration, ratio: fastRatio }
        );
      }
    }
  }
};

// ─── Strategy 5: Service Heartbeat Staleness ─────────────────────────────────
// Marks services as offline if no heartbeat (lastSeen) in 5 minutes.

const evaluateHeartbeats = async (ctx: SweepContext) => {
  const staleThreshold = new Date(ctx.nowMs - DEFAULT_HEARTBEAT_TIMEOUT_MS);

  const staleServices = await TaskService.find({
    status: 'online',
    lastSeen: { $lt: staleThreshold },
  })
    .select('_id ownerId name lastSeen')
    .lean();

  for (const svc of staleServices) {
    ctx.counters.heartbeatLost++;

    ctx.serviceUpdates.push({
      updateOne: {
        filter: { _id: svc._id },
        update: { $set: { status: 'offline' } },
      },
    });

    const message = `Task service "${svc.name}" stopped reporting heartbeats.`;
    const fingerprint = generateErrorFingerprint(svc._id, 'ServiceHeartbeatLost', message);

    ctx.anomalies.push({
      sig: { taskName: '__service__', _id: svc._id },
      service: svc,
      fingerprint,
      errorClass: 'ServiceHeartbeatLost',
      message,
      stackTrace:
        `Watchdog detected heartbeat loss for service "${svc.name}"\n` +
        `Last Seen: ${svc.lastSeen ? new Date(svc.lastSeen).toISOString() : 'Never'}\n` +
        `Timeout Threshold: ${DEFAULT_HEARTBEAT_TIMEOUT_MS / 1000}s`,
      context: { lastSeen: svc.lastSeen, thresholdMs: DEFAULT_HEARTBEAT_TIMEOUT_MS },
      timestamp: ctx.now,
    });
  }
};

// ─── Strategy 6: Dead Letter Queue Monitoring ────────────────────────────────
// Flags tasks accumulating ≥5 dead-lettered runs in 30 minutes. Alert only.

const evaluateDeadLetters = async (ctx: SweepContext) => {
  const activeServiceIds = Array.from(ctx.activeServices.keys()).map(
    id => new mongoose.Types.ObjectId(id)
  );

  if (activeServiceIds.length === 0) return;

  const windowStart = new Date(ctx.nowMs - DEFAULT_DEAD_LETTER_WINDOW_MS);

  const deadLetterCounts = await TaskRun.aggregate([
    {
      $match: {
        serviceId: { $in: activeServiceIds },
        isDeadLetter: true,
        timestamp: { $gte: windowStart, $lte: ctx.now },
      },
    },
    {
      $group: {
        _id: { serviceId: '$serviceId', taskName: '$taskName' },
        count: { $sum: 1 },
      },
    },
    {
      $match: { count: { $gte: DEFAULT_DEAD_LETTER_THRESHOLD } },
    },
  ]);

  for (const dl of deadLetterCounts) {
    const service = ctx.activeServices.get(dl._id.serviceId.toString());
    if (!service) continue;

    ctx.counters.deadLetters++;

    const message = `Task "${dl._id.taskName}" has ${dl.count} dead-lettered runs in the last 30m.`;
    const fingerprint = generateErrorFingerprint(service._id, 'DeadLetterAccumulation', message);

    ctx.anomalies.push({
      sig: { taskName: dl._id.taskName },
      service,
      fingerprint,
      errorClass: 'DeadLetterAccumulation',
      message,
      stackTrace:
        `Watchdog detected dead letter accumulation for "${dl._id.taskName}"\n` +
        `Dead Letters: ${dl.count} in last 30 minutes\n` +
        `Threshold: ${DEFAULT_DEAD_LETTER_THRESHOLD}`,
      context: { count: dl.count, windowMs: DEFAULT_DEAD_LETTER_WINDOW_MS },
      timestamp: ctx.now,
    });
  }
};

// ─── Batch Flush ─────────────────────────────────────────────────────────────

const flushBatches = async (ctx: SweepContext) => {
  if (ctx.signatureUpdates.length > 0) {
    const batches = [];
    for (let i = 0; i < ctx.signatureUpdates.length; i += BATCH_SIZE) {
      batches.push(ctx.signatureUpdates.slice(i, i + BATCH_SIZE));
    }
    for (const batch of batches) {
      await TaskSignature.bulkWrite(batch, { ordered: false });
    }
  }

  if (ctx.serviceUpdates.length > 0) {
    await TaskService.bulkWrite(ctx.serviceUpdates, { ordered: false });
  }

  if (ctx.anomalies.length > 0) {
    const fingerprints = ctx.anomalies.map(a => a.fingerprint);
    const existingGroups = await ErrorGroup.find({ fingerprint: { $in: fingerprints } })
      .select('_id fingerprint')
      .lean();
    const existingGroupMap = new Map(existingGroups.map(g => [g.fingerprint, g._id]));

    const groupBulkOps: any[] = [];
    const eventDocs: any[] = [];

    for (const anomaly of ctx.anomalies) {
      let groupId = existingGroupMap.get(anomaly.fingerprint);

      if (groupId) {
        groupBulkOps.push({
          updateOne: {
            filter: { _id: groupId },
            update: { $max: { lastSeen: anomaly.timestamp }, $inc: { totalCount: 1 } },
          },
        });
      } else {
        groupId = new mongoose.Types.ObjectId();
        existingGroupMap.set(anomaly.fingerprint, groupId);

        groupBulkOps.push({
          insertOne: {
            document: {
              _id: groupId,
              ownerId: anomaly.service.ownerId,
              serviceId: anomaly.service._id,
              serviceModel: 'TaskService',
              fingerprint: anomaly.fingerprint,
              errorClass: anomaly.errorClass,
              message: anomaly.message,
              firstSeen: anomaly.timestamp,
              lastSeen: anomaly.timestamp,
              totalCount: 1,
              status: 'unresolved',
            },
          },
        });
      }

      eventDocs.push({
        groupId,
        serviceId: anomaly.service._id,
        serviceModel: 'TaskService',
        traceId: `watchdog_${anomaly.errorClass}_${anomaly.sig.taskName}_${anomaly.timestamp.getTime()}`,
        stackTrace: anomaly.stackTrace,
        context: anomaly.context,
        timestamp: anomaly.timestamp,
      });
    }

    if (groupBulkOps.length > 0) await ErrorGroup.bulkWrite(groupBulkOps, { ordered: false });
    if (eventDocs.length > 0) await ErrorEvent.insertMany(eventDocs, { ordered: false });
  }
};

// ─── Run Strategy with Isolation ─────────────────────────────────────────────

const runStrategy = async (
  name: string,
  fn: (ctx: SweepContext) => Promise<void>,
  ctx: SweepContext
): Promise<StrategyResult> => {
  try {
    await fn(ctx);
    return { name, success: true };
  } catch (error: any) {
    logger.error(`[Watchdog] Strategy "${name}" failed: ${error.message}`);
    return { name, success: false, error: error.message };
  }
};

// ─── Main Sweep Orchestrator ─────────────────────────────────────────────────

export const runTaskWatchdogSweep = async () => {
  const now = new Date();

  try {
    await SystemLock.findOneAndUpdate(
      { lockName: LOCK_NAME },
      { $set: { lockedAt: now, lockedBy: WORKER_ID, expiresAt: new Date(now.getTime() + LOCK_TTL_MS) } },
      { upsert: true, new: true, rawResult: true }
    );
  } catch (lockError: any) {
    if (lockError.code === 11000) {
      logger.debug('[Watchdog] Another pod holds the sweep lock. Skipping.');
      return;
    }
    throw lockError;
  }

  const startTime = Date.now();
  logger.info(`[Watchdog] Sweep started by ${WORKER_ID}`);

  try {
    const services = await TaskService.find({ status: 'online' }).select('_id ownerId name').lean();
    const activeServiceMap = new Map(services.map(s => [s._id.toString(), s]));

    const ctx = createSweepContext(now, activeServiceMap);

    const strategies = [
      { name: 'MissedCron', fn: evaluateMissedCrons },
      { name: 'ScheduleDeviation', fn: evaluateScheduleDeviations },
      { name: 'FailureRate', fn: evaluateFailureRates },
      { name: 'DurationAnomaly', fn: evaluateDurationAnomalies },
      { name: 'Heartbeat', fn: evaluateHeartbeats },
      { name: 'DeadLetter', fn: evaluateDeadLetters },
    ];

    const results: StrategyResult[] = [];
    for (const strategy of strategies) {
      const result = await runStrategy(strategy.name, strategy.fn, ctx);
      results.push(result);
    }

    await flushBatches(ctx);

    const elapsed = Date.now() - startTime;
    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success);

    const c = ctx.counters;
    const totalAnomalies = c.missed + c.failing + c.heartbeatLost + c.deadLetters +
      c.durationAnomalies + c.shortDurations + c.lateRuns + c.earlyRuns;

    logger.info(
      `[Watchdog] Sweep complete in ${elapsed}ms | ` +
      `Strategies: ${succeeded}/${strategies.length} | ` +
      `Anomalies: ${totalAnomalies} (missed=${c.missed} failing=${c.failing} ` +
      `late=${c.lateRuns} early=${c.earlyRuns} slow=${c.durationAnomalies} fast=${c.shortDurations} ` +
      `heartbeat=${c.heartbeatLost} deadLetter=${c.deadLetters}) | ` +
      `Recovered: ${c.recovered}`
    );

    if (failed.length > 0) {
      logger.warn(`[Watchdog] Failed strategies: ${failed.map(f => `${f.name}: ${f.error}`).join(', ')}`);
    }
  } catch (error) {
    logger.error('[Watchdog] Fatal sweep error:', error);
  } finally {
    await SystemLock.findOneAndDelete({ lockName: LOCK_NAME, lockedBy: WORKER_ID }).catch(() => {});
  }
};
