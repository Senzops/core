import cron from 'node-cron';
import { DatabaseService, DbCollectionStat, DbMetric } from '../../models/Database';
import { decrypt } from '../../utils/crypto';
import { logger } from '../../utils/logger';
import { getRetentionMs } from '../../services/retentionCache';
import { getAdapter, isSupportedDbType, disposeAllAdapters } from './adapters';
import { censusDue as isCensusDue, markCensus, clearPrevious, trackedIds } from './state';
import { DbQueryStat, DbSlowOp } from '../../models/DbQueryInsight';
import { DbIndexStat } from '../../models/DbIndexStat';
import { analyzeIndexes } from '../../services/dbIndexAdvisor';
import { ownerMeetsPlan } from '../../middlewares/planGate';
import type { PlanId } from '../../config/pricing';

// ============================================================================
// Database monitoring scheduler.
// ----------------------------------------------------------------------------
// Engine-agnostic by construction: it leases instances that are due, decrypts
// their connection string, hands off to the matching adapter, and persists what
// comes back. Every engine-specific concern — which counters exist, which
// privileges they need, how a client is pooled — lives behind the adapter
// contract in ./adapters/types.ts.
// ============================================================================

const PROCESSOR_TIMEOUT_MS = 30_000;

/** Privileges change on the order of deployments, so re-probe on the census cadence. */
const PROBE_INTERVAL_MS = 60 * 60 * 1000;

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });

export const startDatabaseWorker = () => {
  logger.info('[Worker] Database Monitoring Engine Started');

  cron.schedule('* * * * *', async () => {
    try {
      await pollDatabases();
    } catch (error: any) {
      logger.error(`[DB Engine] Poll cycle failed: ${error.message}`);
    }
  }, { name: 'database-monitoring-schedule' });

  cron.schedule('0 * * * *', async () => {
    try {
      await cleanupPools();
    } catch (error: any) {
      logger.error(`[DB Engine] Pool cleanup failed: ${error.message}`);
    }
  }, { name: 'database-cleanup-connection-pool' });
};

const pollDatabases = async () => {
  const now = new Date();

  let due: any[];
  try {
    due = await DatabaseService.find({
      $expr: {
        $lte: [
          { $ifNull: ['$lastCheck', new Date(0)] },
          { $subtract: [now, { $multiply: ['$interval', 60000] }] },
        ],
      },
    });
  } catch (error: any) {
    logger.error(`[DB Engine] Failed to query due databases: ${error.message}`);
    return;
  }

  if (due.length === 0) return;

  await Promise.allSettled(
    due.map((db) => {
      const dbId = db._id?.toString() || 'unknown';
      if (!isSupportedDbType(db.type)) return Promise.resolve();
      return withTimeout(pollOne(db, now), PROCESSOR_TIMEOUT_MS, `${db.type}/${dbId}`);
    })
  );
};

const pollOne = async (db: any, checkTime: Date): Promise<void> => {
  const dbId = db._id.toString();
  const adapter = getAdapter(db.type);

  try {
    const censusDue = isCensusDue(dbId);
    const lastProbe = db.capabilitiesCheckedAt ? new Date(db.capabilitiesCheckedAt).getTime() : 0;
    const probeDue = Date.now() - lastProbe > PROBE_INTERVAL_MS;

    const sample = await adapter.sample({
      dbId,
      uri: decrypt(db.encryptedUri),
      checkTime,
      censusDue,
      probeDue,
    });

    await DbMetric.create({
      ...sample.metric,
      dbId: db._id,
      timestamp: checkTime,
      expiresAt: new Date(checkTime.getTime() + (await getRetentionMs(db.ownerId))),
    });

    // Absent collections mean "not a census cycle" or "census failed"; either
    // way the previous census stays, rather than being replaced with nothing.
    if (sample.collections) {
      await DbCollectionStat.findOneAndUpdate(
        { dbId: db._id },
        { lastCheck: new Date(), collections: sample.collections },
        { upsert: true }
      );
      markCensus(dbId, Date.now());
    }

    const update: Record<string, any> = {
      status: 'online',
      lastCheck: checkTime,
      errorMessage: '',
      ...(sample.version ? { version: sample.version } : {}),
      ...(sample.topology ? { topology: sample.topology, topologyCheckedAt: new Date() } : {}),
    };

    if (sample.capabilities) {
      update.capabilities = sample.capabilities;
      update.capabilitiesCheckedAt = new Date();
    }

    await DatabaseService.updateOne({ _id: db._id }, update);
  } catch (error: any) {
    logger.warn(`[DB Engine] Failed to poll ${db.type} ${dbId}: ${error.message}`);

    // Drop the pooled client so the next cycle reconnects rather than reusing a
    // socket the server has already given up on.
    await Promise.resolve(adapter.dispose(dbId)).catch(() => {});

    await DatabaseService.updateOne(
      { _id: db._id },
      { status: 'error', lastCheck: checkTime, errorMessage: error.message }
    );
  }
};

/** Releases clients and delta state for instances that no longer exist. */
const cleanupPools = async () => {
  let activeIds: string[];
  try {
    const ids = await DatabaseService.find().distinct('_id');
    activeIds = ids.map((id: any) => id.toString());
  } catch (error: any) {
    logger.error(`[DB Engine] Cleanup: failed to fetch active database list: ${error.message}`);
    return;
  }

  const active = new Set(activeIds);
  for (const dbId of trackedIds()) {
    if (!active.has(dbId)) {
      await disposeAllAdapters(dbId);
      clearPrevious(dbId);
    }
  }
};

// ============================================================================
// Query insight collection.
// ----------------------------------------------------------------------------
// Deliberately separate from the metric poll:
//   * Digest tables are far more expensive to read than a counter snapshot, so
//     they run on a slower cadence.
//   * The feature is plan-gated, and the gate belongs at the collection
//     boundary — withholding data at render time would still have cost the
//     customer's database the work.
//   * A source that keeps failing is backed off rather than retried every
//     cycle, so a broken permission or an overloaded instance does not turn
//     into sustained load against it.
// ============================================================================

const INSIGHTS_CADENCE_CRON = '*/5 * * * *';
const INSIGHTS_MIN_PLAN: PlanId = 'pro';
const INSIGHTS_TIMEOUT_MS = 20_000;
const MAX_DIGESTS_PER_CYCLE = 100;
const SLOW_OP_THRESHOLD_MS = 100;

/** Consecutive failures before a source is rested, and for how long. */
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30 * 60 * 1000;

interface BreakerState { failures: number; restUntil: number; }
const breakers = new Map<string, BreakerState>();

const breakerAllows = (dbId: string): boolean => {
  const state = breakers.get(dbId);
  return !state || Date.now() >= state.restUntil;
};

const recordSuccess = (dbId: string) => breakers.delete(dbId);

const recordFailure = (dbId: string) => {
  const state = breakers.get(dbId) || { failures: 0, restUntil: 0 };
  state.failures += 1;
  if (state.failures >= BREAKER_THRESHOLD) {
    state.restUntil = Date.now() + BREAKER_COOLDOWN_MS;
    state.failures = 0;
    logger.warn(`[DB Insights] ${dbId} rested for ${BREAKER_COOLDOWN_MS / 60000}m after repeated failures`);
  }
  breakers.set(dbId, state);
};

/** True when the instance exposes at least one insight source we may read. */
const insightsPermitted = (db: any): boolean => {
  const caps = db.capabilities;
  const read = (key: string) =>
    caps instanceof Map ? caps.get(key) : caps?.[key];
  return !!(read('queryStats')?.available || read('slowLog')?.available);
};

export const startDatabaseInsightsWorker = () => {
  logger.info('[Worker] Database Query Insights Started');

  cron.schedule(INSIGHTS_CADENCE_CRON, async () => {
    try {
      await collectInsightsCycle();
    } catch (error: any) {
      logger.error(`[DB Insights] Cycle failed: ${error.message}`);
    }
  }, { name: 'database-query-insights' });
};

const collectInsightsCycle = async () => {
  let sources: any[];
  try {
    sources = await DatabaseService.find({ status: 'online' });
  } catch (error: any) {
    logger.error(`[DB Insights] Failed to list sources: ${error.message}`);
    return;
  }

  // Plan lookups are per owner, not per instance: a fleet of twenty databases
  // under one account should cost one subscription read, not twenty.
  const planCache = new Map<string, boolean>();
  const eligible: any[] = [];

  for (const db of sources) {
    if (!isSupportedDbType(db.type)) continue;
    if (!getAdapter(db.type).collectInsights) continue;
    if (!insightsPermitted(db)) continue;
    if (!breakerAllows(db._id.toString())) continue;

    let allowed = planCache.get(db.ownerId);
    if (allowed === undefined) {
      allowed = await ownerMeetsPlan(db.ownerId, INSIGHTS_MIN_PLAN);
      planCache.set(db.ownerId, allowed);
    }
    if (allowed) eligible.push(db);
  }

  if (eligible.length === 0) return;

  await Promise.allSettled(eligible.map((db) => collectInsightsFor(db)));
};

const collectInsightsFor = async (db: any): Promise<void> => {
  const dbId = db._id.toString();
  const adapter = getAdapter(db.type);
  if (!adapter.collectInsights) return;

  try {
    const sample = await withTimeout(
      adapter.collectInsights({
        dbId,
        uri: decrypt(db.encryptedUri),
        maxDigests: MAX_DIGESTS_PER_CYCLE,
        slowMsThreshold: SLOW_OP_THRESHOLD_MS,
      }),
      INSIGHTS_TIMEOUT_MS,
      `insights/${db.type}/${dbId}`
    );

    const timestamp = new Date();
    const retentionMs = await getRetentionMs(db.ownerId);
    const expiresAt = new Date(timestamp.getTime() + retentionMs);

    if (sample.queryStats.length > 0) {
      await DbQueryStat.insertMany(
        sample.queryStats.map((s) => ({ ...s, dbId: db._id, timestamp, expiresAt })),
        { ordered: false }
      );
    }

    if (sample.slowOps.length > 0) {
      await DbSlowOp.insertMany(
        sample.slowOps.map((s) => ({
          ...s,
          dbId: db._id,
          // Each slow op carries its own observation time; expiry is anchored
          // to that, not to the collection cycle.
          expiresAt: new Date(s.timestamp.getTime() + retentionMs),
        })),
        { ordered: false }
      );
    }

    recordSuccess(dbId);
  } catch (error: any) {
    logger.warn(`[DB Insights] ${db.type} ${dbId}: ${error.message}`);
    recordFailure(dbId);
  }
};

// ---------------------------------------------------------------------------
// Index census — hourly. Index definitions and usage counters move on the order
// of deployments, and the per-collection enumeration is the most expensive read
// Senzor performs against a monitored instance.
// ---------------------------------------------------------------------------

const INDEX_CENSUS_CRON = '7 * * * *'; // offset from the hour to avoid piling onto other hourly work
const INDEX_TIMEOUT_MS = 45_000;

export const startDatabaseIndexWorker = () => {
  cron.schedule(INDEX_CENSUS_CRON, async () => {
    try {
      await collectIndexCycle();
    } catch (error: any) {
      logger.error(`[DB Indexes] Cycle failed: ${error.message}`);
    }
  }, { name: 'database-index-census' });
};

const collectIndexCycle = async () => {
  let sources: any[];
  try {
    sources = await DatabaseService.find({ status: 'online' });
  } catch (error: any) {
    logger.error(`[DB Indexes] Failed to list sources: ${error.message}`);
    return;
  }

  const planCache = new Map<string, boolean>();

  for (const db of sources) {
    const dbId = db._id.toString();
    if (!isSupportedDbType(db.type)) continue;

    const adapter = getAdapter(db.type);
    if (!adapter.collectIndexes) continue;
    if (!breakerAllows(dbId)) continue;

    const caps = db.capabilities;
    const indexCap = caps instanceof Map ? caps.get('indexStats') : caps?.indexStats;
    if (indexCap && !indexCap.available) continue;

    let allowed = planCache.get(db.ownerId);
    if (allowed === undefined) {
      allowed = await ownerMeetsPlan(db.ownerId, INSIGHTS_MIN_PLAN);
      planCache.set(db.ownerId, allowed);
    }
    if (!allowed) continue;

    try {
      const census = await withTimeout(
        adapter.collectIndexes({
          dbId,
          uri: decrypt(db.encryptedUri),
          maxDigests: MAX_DIGESTS_PER_CYCLE,
          slowMsThreshold: SLOW_OP_THRESHOLD_MS,
        }),
        INDEX_TIMEOUT_MS,
        `indexes/${db.type}/${dbId}`
      );

      // Flags are computed here, once, rather than on every dashboard read.
      const analyzed = analyzeIndexes(census.indexes as any, census.serverUptimeSeconds);
      const totalSizeBytes = analyzed.reduce((sum, i) => sum + i.sizeBytes, 0);
      const unusedSizeBytes = analyzed
        .filter((i) => i.flags.includes('unused'))
        .reduce((sum, i) => sum + i.sizeBytes, 0);

      await DbIndexStat.findOneAndUpdate(
        { dbId: db._id },
        {
          collectedAt: new Date(),
          serverUptimeSeconds: census.serverUptimeSeconds,
          indexes: analyzed,
          totalIndexes: analyzed.length,
          totalSizeBytes,
          unusedSizeBytes,
        },
        { upsert: true }
      );

      recordSuccess(dbId);
    } catch (error: any) {
      logger.warn(`[DB Indexes] ${db.type} ${dbId}: ${error.message}`);
      recordFailure(dbId);
    }
  }
};
