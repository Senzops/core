import cron from 'node-cron';
import os from 'os';
import { QueueSource, QueueMetric, QueueRollup } from '../../models/Queue';
import { SystemLock } from '../../models/Task';
import { decrypt } from '../../utils/crypto';
import { logger } from '../../utils/logger';
import { getRetentionMs } from '../../services/retentionCache';
import { getAdapter, disposeAllAdapters, DEFAULT_MAX_QUEUES } from './adapters';
import { persistQueueSamples } from './persist';

// ============================================================================
// Queue Monitoring poller (agentless, pull-plane, multi-broker).
// ----------------------------------------------------------------------------
// Distributed and horizontally scalable: each tick atomically *leases* due
// sources, so polling shards across worker replicas with no double-polling.
// Rates are derived from the last persisted snapshot (not in-memory state), so
// they stay correct across restarts and across pods. A per-source circuit
// breaker backs off failing sources with exponential delay.
//
// The poller is broker-agnostic: it resolves the source's adapter from the
// registry and delegates all connection + sampling concerns to it.
// ============================================================================

const WORKER_ID = `${os.hostname()}-${process.pid}`;

const LEASE_TTL_MS = 60_000;
const PROCESSOR_TIMEOUT_MS = 30_000;
const MAX_SOURCES_PER_TICK = 50;
const MIN_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const ROLLUP_LOCK = 'queue-rollup-sweep';
const ROLLUP_LOCK_TTL_MS = 5 * 60_000;

// Source ids this replica has opened adapter connections for, so cleanup can
// release pooled clients of sources that were deleted out from under us.
const touchedSources = new Set<string>();

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });

export const startQueueWorker = () => {
  logger.info('[Worker] Queue Monitoring Engine Started');

  cron.schedule('* * * * *', async () => {
    try {
      await pollDueSources();
    } catch (error: any) {
      logger.error(`[Queue Engine] Poll cycle failed: ${error.message}`);
    }
  }, { name: 'queue-monitoring-schedule' });

  cron.schedule('5 * * * *', async () => {
    try {
      await rollupPreviousHour();
    } catch (error: any) {
      logger.error(`[Queue Engine] Rollup failed: ${error.message}`);
    }
  }, { name: 'queue-monitoring-rollup', timezone: 'UTC' });

  cron.schedule('0 * * * *', async () => {
    try {
      await cleanupPools();
    } catch (error: any) {
      logger.error(`[Queue Engine] Pool cleanup failed: ${error.message}`);
    }
  }, { name: 'queue-monitoring-pool-cleanup' });
};

// ─── Lease-based claiming ────────────────────────────────────────────────────

const claimDueSources = async (limit: number): Promise<any[]> => {
  const claimed: any[] = [];
  for (let i = 0; i < limit; i++) {
    const now = new Date();
    const src = await QueueSource.findOneAndUpdate(
      {
        // Collector-mode sources are pushed to, not polled.
        mode: { $ne: 'collector' },
        nextPollAt: { $lte: now },
        $or: [
          { leaseExpiresAt: { $exists: false } },
          { leaseExpiresAt: null },
          { leaseExpiresAt: { $lt: now } }
        ]
      },
      { $set: { leasedBy: WORKER_ID, leaseExpiresAt: new Date(now.getTime() + LEASE_TTL_MS) } },
      { sort: { nextPollAt: 1 }, new: true }
    );
    if (!src) break;
    claimed.push(src);
  }
  return claimed;
};

const pollDueSources = async () => {
  const sources = await claimDueSources(MAX_SOURCES_PER_TICK);
  if (sources.length === 0) return;

  await Promise.allSettled(
    sources.map(src =>
      withTimeout(processSource(src), PROCESSOR_TIMEOUT_MS, `queue/${src._id}`)
        .catch(err => handleSourceFailure(src, err))
    )
  );
};

// ─── Per-source processing ───────────────────────────────────────────────────

const processSource = async (source: any) => {
  const sourceId = source._id.toString();
  const adapter = getAdapter(source.system);

  let config: any;
  try {
    config = JSON.parse(decrypt(source.encryptedConfig));
  } catch {
    throw new Error('Failed to decrypt connection config');
  }

  touchedSources.add(sourceId);

  const { samples, discovered, truncated, version } = await adapter.sample(sourceId, config, {
    queueFilter: source.queueFilter || [],
    maxQueues: DEFAULT_MAX_QUEUES
  });

  const now = new Date();
  await persistQueueSamples(source, samples);

  const intervalMs = (source.interval || 1) * 60_000;
  await QueueSource.updateOne(
    { _id: source._id },
    {
      $set: {
        status: 'online',
        lastCheck: now,
        nextPollAt: new Date(now.getTime() + intervalMs),
        errorMessage: truncated
          ? `Queue limit reached: monitoring first ${DEFAULT_MAX_QUEUES} of ${discovered}+ queues.`
          : undefined,
        version,
        discoveredQueues: discovered,
        consecutiveFailures: 0,
        backoffUntil: undefined,
        leasedBy: undefined,
        leaseExpiresAt: undefined
      }
    }
  );

  logger.debug(`[Queue Engine] Polled ${source.system} source ${sourceId}: ${samples.length} entities`);
};

// ─── Circuit breaker on failure ──────────────────────────────────────────────

const handleSourceFailure = async (source: any, error: any) => {
  const failures = (source.consecutiveFailures || 0) + 1;
  const backoff = Math.min(MIN_BACKOFF_MS * Math.pow(2, failures - 1), MAX_BACKOFF_MS);
  const now = Date.now();
  const message = (error?.message || String(error)).slice(0, 500);

  await QueueSource.updateOne(
    { _id: source._id },
    {
      $set: {
        status: 'error',
        errorMessage: message,
        consecutiveFailures: failures,
        backoffUntil: new Date(now + backoff),
        nextPollAt: new Date(now + backoff),
        leasedBy: undefined,
        leaseExpiresAt: undefined
      }
    }
  ).catch(() => {});

  logger.warn(`[Queue Engine] Source ${source._id} failed (${failures}x, backoff ${Math.round(backoff / 1000)}s): ${message}`);
};

// ─── Hourly rollup (single-writer via SystemLock) ────────────────────────────

const rollupPreviousHour = async () => {
  const now = new Date();
  try {
    await SystemLock.findOneAndUpdate(
      { lockName: ROLLUP_LOCK },
      { $set: { lockedAt: now, lockedBy: WORKER_ID, expiresAt: new Date(now.getTime() + ROLLUP_LOCK_TTL_MS) } },
      { upsert: true }
    );
  } catch (err: any) {
    if (err.code === 11000) return;
    throw err;
  }

  try {
    const end = new Date(now);
    end.setMinutes(0, 0, 0);
    const start = new Date(end.getTime() - 60 * 60_000);

    const grouped = await QueueMetric.aggregate([
      { $match: { timestamp: { $gte: start, $lt: end } } },
      {
        $group: {
          _id: { sourceId: '$sourceId', queueName: '$queueName' },
          pendingAvg: { $avg: '$pending' },
          pendingMax: { $max: '$pending' },
          activeAvg: { $avg: '$depth.active' },
          delayedAvg: { $avg: '$depth.delayed' },
          dlqDepthAvg: { $avg: '$dlqDepth' },
          dlqDepthMax: { $max: '$dlqDepth' },
          oldestWaitingAgeMaxMs: { $max: '$oldestWaitingAgeMs' },
          consumerCountAvg: { $avg: '$consumerCount' },
          consumerCountMin: { $min: '$consumerCount' },
          netRateAvg: { $avg: '$netRate' },
          completedRateAvg: { $avg: '$completedRate' },
          failedRateAvg: { $avg: '$failedRate' },
          samples: { $sum: 1 }
        }
      }
    ]);

    if (grouped.length === 0) return;

    const sourceIds = [...new Set(grouped.map(g => g._id.sourceId.toString()))];
    const sources = await QueueSource.find({ _id: { $in: sourceIds } }).select('ownerId').lean();
    const ownerBySource = new Map(sources.map(s => [s._id.toString(), s.ownerId]));
    const retentionCache = new Map<string, number>();

    const ops: any[] = [];
    for (const g of grouped) {
      const sid = g._id.sourceId.toString();
      const ownerId = ownerBySource.get(sid);
      if (!ownerId) continue;

      let retentionMs = retentionCache.get(ownerId);
      if (retentionMs === undefined) {
        retentionMs = await getRetentionMs(ownerId);
        retentionCache.set(ownerId, retentionMs);
      }

      ops.push({
        updateOne: {
          filter: { sourceId: g._id.sourceId, queueName: g._id.queueName, timestamp: start },
          update: {
            $set: {
              pendingAvg: g.pendingAvg, pendingMax: g.pendingMax,
              activeAvg: g.activeAvg, delayedAvg: g.delayedAvg,
              dlqDepthAvg: g.dlqDepthAvg, dlqDepthMax: g.dlqDepthMax,
              oldestWaitingAgeMaxMs: g.oldestWaitingAgeMaxMs,
              consumerCountAvg: g.consumerCountAvg, consumerCountMin: g.consumerCountMin,
              netRateAvg: g.netRateAvg, completedRateAvg: g.completedRateAvg,
              failedRateAvg: g.failedRateAvg, samples: g.samples,
              expiresAt: new Date(start.getTime() + retentionMs)
            }
          },
          upsert: true
        }
      });
    }

    if (ops.length > 0) await QueueRollup.bulkWrite(ops, { ordered: false });
    logger.info(`[Queue Engine] Rollup complete: ${ops.length} queue-hours aggregated`);
  } finally {
    await SystemLock.findOneAndDelete({ lockName: ROLLUP_LOCK, lockedBy: WORKER_ID }).catch(() => {});
  }
};

// ─── Pool cleanup ────────────────────────────────────────────────────────────
// Release adapter connections for sources that were deleted out from under us.

const cleanupPools = async () => {
  if (touchedSources.size === 0) return;
  const ids = [...touchedSources];
  const alive = await QueueSource.find({ _id: { $in: ids } }).select('_id').lean();
  const aliveSet = new Set(alive.map(s => s._id.toString()));

  for (const id of ids) {
    if (!aliveSet.has(id)) {
      await disposeAllAdapters(id);
      touchedSources.delete(id);
    }
  }
};
