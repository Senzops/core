import cron from 'node-cron';
import os from 'os';
import {
  QueueSource, QueueMetric, QueueSnapshot, QueueRollup,
  IQueueSnapshotEntry
} from '../../models/Queue';
import { SystemLock } from '../../models/Task';
import { decrypt } from '../../utils/crypto';
import { logger } from '../../utils/logger';
import { getRetentionMs, stampExpiry } from '../../services/retentionCache';
import { getAdapter, disposeAllAdapters, DEFAULT_MAX_QUEUES, QueueSample } from './adapters';

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

  // Previous state for stateless rate derivation comes from the persisted
  // snapshot — survives restarts and is shared across replicas.
  const prevSnapshot = await QueueSnapshot.findOne({ sourceId: source._id }).lean();
  const prevByQueue = new Map<string, IQueueSnapshotEntry>(
    (prevSnapshot?.queues || []).map(q => [q.queueName, q])
  );
  const prevTimeMs = prevSnapshot?.lastCheck ? new Date(prevSnapshot.lastCheck).getTime() : 0;
  const elapsedSec = prevTimeMs > 0 ? Math.max(1, (now.getTime() - prevTimeMs) / 1000) : 0;

  const retentionMs = await getRetentionMs(source.ownerId);

  const metricDocs: any[] = [];
  const snapshotEntries: IQueueSnapshotEntry[] = [];

  for (const sample of samples) {
    const prev = prevByQueue.get(sample.queueName);
    const { netRate, etaToEmptyMs, completedRate, failedRate } = computeRates(sample, prev, elapsedSec);

    metricDocs.push({
      sourceId: source._id,
      queueName: sample.queueName,
      timestamp: now,
      depth: sample.depth,
      pending: sample.pending,
      dlqDepth: sample.dlqDepth,
      oldestWaitingAgeMs: sample.oldestWaitingAgeMs,
      oldestDelayedAgeMs: sample.oldestDelayedAgeMs,
      consumerCount: sample.consumerCount,
      isPaused: sample.isPaused,
      netRate,
      completedRate,
      failedRate,
      etaToEmptyMs
    });

    snapshotEntries.push({
      queueName: sample.queueName,
      pending: sample.pending,
      active: sample.depth.active,
      dlqDepth: sample.dlqDepth,
      consumerCount: sample.consumerCount,
      isPaused: sample.isPaused,
      oldestWaitingAgeMs: sample.oldestWaitingAgeMs,
      netRate,
      processedTotal: sample.processedTotal
    });
  }

  if (metricDocs.length > 0) {
    stampExpiry(metricDocs, 'timestamp', retentionMs);
    await QueueMetric.insertMany(metricDocs, { ordered: false });
  }

  await QueueSnapshot.updateOne(
    { sourceId: source._id },
    { $set: { lastCheck: now, queues: snapshotEntries } },
    { upsert: true }
  );

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

/**
 * Net backlog rate (signed jobs/sec), drain ETA, and throughput — all derived
 * statelessly from the previous persisted snapshot.
 *
 * Throughput precedence: a broker-provided direct rate (RabbitMQ message_stats)
 * wins; otherwise it's derived from the delta of a cumulative processed counter
 * (Kafka committed-offset sum). Brokers exposing neither report 0.
 */
const computeRates = (
  sample: QueueSample,
  prev: IQueueSnapshotEntry | undefined,
  elapsedSec: number
): { netRate: number; etaToEmptyMs: number; completedRate: number; failedRate: number } => {
  let netRate = 0;
  let etaToEmptyMs = -1;
  if (prev && elapsedSec > 0) {
    netRate = (sample.pending - prev.pending) / elapsedSec;
    etaToEmptyMs = netRate < 0 && sample.pending > 0
      ? Math.round((sample.pending / -netRate) * 1000)
      : -1;
  }

  let completedRate = sample.completedRate ?? 0;
  const failedRate = sample.failedRate ?? 0;

  // Derive consumed/sec from a cumulative counter when no direct rate is given.
  if (
    sample.completedRate === undefined &&
    sample.processedTotal !== undefined &&
    prev?.processedTotal !== undefined &&
    elapsedSec > 0
  ) {
    completedRate = Math.max(0, (sample.processedTotal - prev.processedTotal) / elapsedSec);
  }

  return { netRate, etaToEmptyMs, completedRate, failedRate };
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
