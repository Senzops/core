import pg from 'pg';
import type {
  DbAdapter, DbSample, Capabilities, SampleContext, CollectionStat,
  InsightContext, InsightSample, QueryStatSample, SlowOpSample, IndexCensus,
  TopologySnapshot, CurrentOperation,
} from './types';
import { capable, incapable, safeNum, perSecond, toMb } from './types';
import {
  getPrevious, setPrevious, clearPrevious, elapsedSeconds,
  getInsightBaseline, setInsightBaseline, clearInsightBaseline, type DigestCounters,
} from '../state';
import { normalizeSqlText, digestOf, classifyOperation } from '../redact';
import { logger } from '../../../utils/logger';

// ============================================================================
// PostgreSQL adapter.
// ----------------------------------------------------------------------------
// Every statement is a read against the statistics views, capped by the pool's
// statement_timeout. Optional views are queried defensively: a monitoring role
// without pg_read_all_stats, or a server without pg_stat_statements installed,
// degrades that one signal rather than failing the whole cycle.
// ============================================================================

const pool = new Map<string, pg.Pool>();

const connect = (dbId: string, uri: string): pg.Pool => {
  let p = pool.get(dbId);
  if (!p) {
    p = new pg.Pool({
      connectionString: uri,
      max: 2,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    // A pooled client can emit after an upstream restart; unhandled, that is a
    // process-level crash.
    p.on('error', () => {});
    pool.set(dbId, p);
  }
  return p;
};

/** Runs an optional query, returning undefined instead of throwing. */
const tryQuery = async (p: pg.Pool, sql: string): Promise<any | undefined> => {
  try {
    const res = await p.query(sql);
    return res.rows[0];
  } catch {
    return undefined;
  }
};

const isPermissionError = (err: any): boolean =>
  err?.code === '42501' || /permission denied|must be superuser|not allowed/i.test(err?.message || '');

const isMissingRelation = (err: any): boolean =>
  err?.code === '42P01' || /does not exist/i.test(err?.message || '');

interface PgCounters {
  tupReturned: number;
  tupFetched: number;
  tupInserted: number;
  tupUpdated: number;
  tupDeleted: number;
  xactCommit: number;
  xactRollback: number;
  deadlocks: number;
  tempBytes: number;
  tempFiles: number;
  blksRead: number;
  blksHit: number;
  seqScans: number;
  idxScans: number;
  checkpointsTimed: number;
  checkpointsRequested: number;
  buffersCheckpoint: number;
  buffersClean: number;
  buffersBackend: number;
  walBytes: number;
}

const probeCapabilities = async (p: pg.Pool): Promise<Capabilities> => {
  const caps: Capabilities = { serverStats: capable() };

  const check = async (
    key: keyof Capabilities,
    sql: string,
    denied: string,
    remediation: string,
    missing?: { reason: string; remediation: string }
  ) => {
    try {
      await p.query(sql);
      caps[key] = capable();
    } catch (err: any) {
      if (isMissingRelation(err) && missing) {
        caps[key] = incapable(missing.reason, missing.remediation);
        return;
      }
      caps[key] = isPermissionError(err)
        ? incapable(denied, remediation)
        : incapable(err?.message || 'Unavailable on this server.', remediation);
    }
  };

  await check(
    'storageStats',
    'SELECT pg_database_size(current_database())',
    'The monitored role cannot read database size.',
    'Grant CONNECT on the database, or grant pg_read_all_stats.'
  );

  await check(
    'collectionStats',
    'SELECT relid FROM pg_stat_user_tables LIMIT 1',
    'The monitored role cannot read pg_stat_user_tables.',
    'GRANT pg_read_all_stats TO <role>.'
  );

  await check(
    'indexStats',
    'SELECT indexrelid FROM pg_stat_user_indexes LIMIT 1',
    'The monitored role cannot read pg_stat_user_indexes.',
    'GRANT pg_read_all_stats TO <role>.'
  );

  await check(
    'queryStats',
    'SELECT queryid FROM pg_stat_statements LIMIT 1',
    'The monitored role cannot read pg_stat_statements.',
    'GRANT pg_read_all_stats TO <role>.',
    {
      reason: 'The pg_stat_statements extension is not installed.',
      remediation:
        "Add pg_stat_statements to shared_preload_libraries, restart, then run CREATE EXTENSION pg_stat_statements;",
    }
  );

  // Seeing OTHER sessions' query text requires elevated stats access; without
  // it pg_stat_activity returns rows with the query column blanked, which would
  // look like an idle server rather than a permissions boundary.
  await check(
    'slowLog',
    "SELECT query FROM pg_stat_activity WHERE pid <> pg_backend_pid() LIMIT 1",
    'The monitored role can only see its own sessions.',
    'GRANT pg_read_all_stats TO <role> so query text from other sessions is visible.'
  );

  await check(
    'currentOps',
    "SELECT state FROM pg_stat_activity LIMIT 1",
    'The monitored role cannot read pg_stat_activity.',
    'GRANT pg_read_all_stats TO <role>.'
  );

  await check(
    'replication',
    'SELECT slot_name FROM pg_replication_slots LIMIT 1',
    'The monitored role cannot read replication state.',
    'GRANT pg_monitor TO <role>.'
  );

  return caps;
};

/**
 * Checkpoint statistics moved in PostgreSQL 17: the checkpointer counters were
 * split out of pg_stat_bgwriter into pg_stat_checkpointer. Trying the modern
 * view first and falling back keeps the signal alive on both.
 */
const readCheckpointStats = async (p: pg.Pool) => {
  const modern = await tryQuery(
    p,
    `SELECT c.num_timed AS timed, c.num_requested AS requested, c.buffers_written AS buffers_checkpoint,
            b.buffers_clean, 0::bigint AS buffers_backend
     FROM pg_stat_checkpointer c, pg_stat_bgwriter b`
  );
  if (modern) return modern;

  return (
    (await tryQuery(
      p,
      `SELECT checkpoints_timed AS timed, checkpoints_req AS requested,
              buffers_checkpoint, buffers_clean, buffers_backend
       FROM pg_stat_bgwriter`
    )) || {}
  );
};

/** WAL position as a byte offset. Differs on a primary vs a standby. */
const readWalBytes = async (p: pg.Pool): Promise<number> => {
  const row = await tryQuery(
    p,
    `SELECT CASE WHEN pg_is_in_recovery()
              THEN pg_wal_lsn_diff(pg_last_wal_receive_lsn(), '0/0')
              ELSE pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')
            END AS wal_bytes`
  );
  return safeNum(row?.wal_bytes);
};

const runCensus = async (p: pg.Pool): Promise<CollectionStat[] | undefined> => {
  try {
    const res = await p.query(`
      SELECT schemaname || '.' || relname AS name,
             n_live_tup AS count,
             pg_total_relation_size(relid) AS total_size,
             pg_relation_size(relid) AS data_size,
             pg_indexes_size(relid) AS index_size
      FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(relid) DESC
      LIMIT 100
    `);
    return res.rows.map((r: any) => ({
      name: r.name,
      count: safeNum(r.count),
      size: toMb(r.data_size),
      storageSize: toMb(r.total_size),
      indexSize: toMb(r.index_size),
    }));
  } catch (err: any) {
    logger.warn(`[DB Engine] Postgres census failed: ${err.message}`);
    return undefined;
  }
};

export const postgresAdapter: DbAdapter = {
  type: 'postgresql',

  async probe(uri: string): Promise<Capabilities> {
    const client = new pg.Pool({
      connectionString: uri,
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    client.on('error', () => {});
    try {
      await client.query('SELECT 1');
      return await probeCapabilities(client);
    } finally {
      await client.end().catch(() => {});
    }
  },

  async sample({ dbId, uri, censusDue, probeDue }: SampleContext): Promise<DbSample> {
    const p = connect(dbId, uri);

    const pingStart = performance.now();
    await p.query('SELECT 1');
    const pingLatency = performance.now() - pingStart;

    const [dbStatsRes, activityRes, settingsRes, sizeRes, replRes, locksRes, scanRes, uptimeRes] =
      await Promise.all([
        p.query(`SELECT * FROM pg_stat_database WHERE datname = current_database()`),
        p.query(`SELECT
            count(*) FILTER (WHERE state = 'active') AS active,
            count(*) FILTER (WHERE wait_event_type IS NOT NULL AND state = 'active') AS blocked,
            count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_tx,
            count(*) FILTER (WHERE state = 'active' AND now() - query_start > interval '1 second') AS slow,
            COALESCE(EXTRACT(EPOCH FROM max(now() - xact_start)), 0) AS longest_tx_seconds,
            count(*) AS total
          FROM pg_stat_activity WHERE backend_type = 'client backend'`),
        p.query(`SELECT name, setting FROM pg_settings WHERE name IN ('max_connections', 'shared_buffers', 'work_mem')`),
        p.query(`SELECT pg_database_size(current_database()) AS db_size,
            (SELECT COALESCE(SUM(pg_indexes_size(c.oid)), 0) FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')) AS total_index_size`),
        p.query(`SELECT CASE WHEN pg_is_in_recovery()
              THEN COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000, -1)
              ELSE -1 END AS lag_ms, pg_is_in_recovery() AS in_recovery`),
        p.query(`SELECT count(*) FILTER (WHERE granted) AS granted,
                        count(*) FILTER (WHERE NOT granted) AS waiting FROM pg_locks`),
        p.query(`SELECT COALESCE(sum(seq_scan), 0) AS seq_scans,
                        COALESCE(sum(idx_scan), 0) AS idx_scans,
                        COALESCE(sum(n_dead_tup), 0) AS dead_tuples,
                        COALESCE(sum(n_live_tup), 0) AS live_tuples,
                        COALESCE(EXTRACT(EPOCH FROM (now() - min(last_autovacuum))), 0) AS oldest_autovacuum_age
                 FROM pg_stat_user_tables`),
        p.query(`SELECT EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time())) AS uptime,
                        current_setting('server_version') AS version`),
      ]);

    const dbStats = dbStatsRes.rows[0] || {};
    const activity = activityRes.rows[0] || {};
    const scans = scanRes.rows[0] || {};
    const settings: Record<string, string> = {};
    for (const row of settingsRes.rows) settings[row.name] = row.setting;

    // Optional signals — each degrades on its own.
    const [checkpoints, walBytes, xidRow, slotRow, vacuumRow] = await Promise.all([
      readCheckpointStats(p),
      readWalBytes(p),
      tryQuery(p, `SELECT age(datfrozenxid) AS xid_age FROM pg_database WHERE datname = current_database()`),
      tryQuery(
        p,
        `SELECT COALESCE(MAX(pg_wal_lsn_diff(
            CASE WHEN pg_is_in_recovery() THEN pg_last_wal_receive_lsn() ELSE pg_current_wal_lsn() END,
            restart_lsn)), 0) AS slot_lag_bytes FROM pg_replication_slots WHERE restart_lsn IS NOT NULL`
      ),
      tryQuery(p, `SELECT count(*) AS workers FROM pg_stat_activity WHERE backend_type = 'autovacuum worker'`),
    ]);

    const now = Date.now();
    const previous = getPrevious<PgCounters>(dbId);
    const seconds = elapsedSeconds(previous, now);

    const counters: PgCounters = {
      tupReturned: safeNum(dbStats.tup_returned),
      tupFetched: safeNum(dbStats.tup_fetched),
      tupInserted: safeNum(dbStats.tup_inserted),
      tupUpdated: safeNum(dbStats.tup_updated),
      tupDeleted: safeNum(dbStats.tup_deleted),
      xactCommit: safeNum(dbStats.xact_commit),
      xactRollback: safeNum(dbStats.xact_rollback),
      deadlocks: safeNum(dbStats.deadlocks),
      tempBytes: safeNum(dbStats.temp_bytes),
      tempFiles: safeNum(dbStats.temp_files),
      blksRead: safeNum(dbStats.blks_read),
      blksHit: safeNum(dbStats.blks_hit),
      seqScans: safeNum(scans.seq_scans),
      idxScans: safeNum(scans.idx_scans),
      checkpointsTimed: safeNum(checkpoints?.timed),
      checkpointsRequested: safeNum(checkpoints?.requested),
      buffersCheckpoint: safeNum(checkpoints?.buffers_checkpoint),
      buffersClean: safeNum(checkpoints?.buffers_clean),
      buffersBackend: safeNum(checkpoints?.buffers_backend),
      walBytes,
    };

    const rate = (key: keyof PgCounters) =>
      previous ? perSecond(counters[key], previous.counters[key], seconds) : 0;

    const writeRate = rate('tupInserted') + rate('tupUpdated') + rate('tupDeleted');
    const totalBlocks = counters.blksHit + counters.blksRead;
    const maxConn = safeNum(settings['max_connections'], 100);
    const currentConns = safeNum(activity.total);
    // shared_buffers is reported in 8KB pages.
    const sharedBuffersMb = (safeNum(settings['shared_buffers']) * 8192) / (1024 * 1024);

    setPrevious(dbId, counters, previous?.lastCensusAt ?? now);

    return {
      version: uptimeRes.rows[0]?.version || undefined,
      metric: {
        throughput: { read: rate('tupFetched'), write: writeRate },
        latency: { read: { avg: 0, max: 0 }, write: { avg: 0, max: 0 }, ping: pingLatency },
        uptimeSeconds: safeNum(uptimeRes.rows[0]?.uptime),
        connections: {
          current: currentConns,
          available: Math.max(0, maxConn - currentConns),
          totalCreated: 0,
        },
        memory: {
          resident: sharedBuffersMb,
          virtual: sharedBuffersMb + (safeNum(settings['work_mem']) * currentConns) / 1024,
          mapped: 0,
        },
        // PostgreSQL exposes no server-side byte counters; requests/sec is the
        // honest stand-in, and the byte series stays at zero rather than
        // fabricating a number.
        network: { bytesIn: 0, bytesOut: 0, numRequests: rate('tupFetched') + writeRate },
        ops: { insert: 0, query: 0, update: 0, delete: 0, command: 0 },
        scans: { collectionScans: rate('seqScans'), indexScans: rate('idxScans') },
        storage: {
          dataSize: toMb(sizeRes.rows[0]?.db_size),
          indexSize: toMb(sizeRes.rows[0]?.total_index_size),
          storageSize: toMb(sizeRes.rows[0]?.db_size),
          objects: safeNum(scans.live_tuples),
        },
        locks: {
          activeReaders: safeNum(locksRes.rows[0]?.granted),
          activeWriters: 0,
          queuedReaders: 0,
          queuedWriters: safeNum(locksRes.rows[0]?.waiting),
        },
        sql: {
          activeQueries: safeNum(activity.active),
          blockedQueries: safeNum(activity.blocked),
          deadlocks: previous ? Math.max(0, counters.deadlocks - previous.counters.deadlocks) : 0,
          cacheHitRate: totalBlocks > 0 ? (counters.blksHit / totalBlocks) * 100 : 0,
          tempBytesWritten: previous
            ? Math.max(0, toMb(counters.tempBytes - previous.counters.tempBytes))
            : 0,
          replicationLagMs: safeNum(replRes.rows[0]?.lag_ms, -1),
          tableScans: rate('seqScans'),
          indexScans: rate('idxScans'),
          rowsReturned: rate('tupReturned'),
          rowsModified: writeRate,
          transactionsCommitted: rate('xactCommit'),
          transactionsRolledBack: rate('xactRollback'),
          waitEvents: safeNum(activity.blocked),
          slowQueries: safeNum(activity.slow),
        },
        pg: {
          checkpointsTimedRate: rate('checkpointsTimed'),
          checkpointsRequestedRate: rate('checkpointsRequested'),
          buffersCheckpointRate: rate('buffersCheckpoint'),
          buffersCleanRate: rate('buffersClean'),
          buffersBackendRate: rate('buffersBackend'),
          walBytesRate: rate('walBytes'),
          tempFilesRate: rate('tempFiles'),
          deadTuples: safeNum(scans.dead_tuples),
          liveTuples: safeNum(scans.live_tuples),
          // Share of the ~2 billion transaction-ID budget consumed before a
          // forced anti-wraparound vacuum becomes unavoidable.
          xidAgePercent: xidRow ? (safeNum(xidRow.xid_age) / 2_000_000_000) * 100 : undefined,
          idleInTransaction: safeNum(activity.idle_in_tx),
          longestTransactionSeconds: safeNum(activity.longest_tx_seconds),
          oldestAutovacuumAgeSeconds: safeNum(scans.oldest_autovacuum_age),
          autovacuumWorkersActive: vacuumRow ? safeNum(vacuumRow.workers) : undefined,
          replicationSlotLagBytes: slotRow ? safeNum(slotRow.slot_lag_bytes) : undefined,
        },
      },
      topology: await readTopology(p),
      ...(censusDue ? { collections: await runCensus(p) } : {}),
      ...(probeDue ? { capabilities: await probeCapabilities(p) } : {}),
    };
  },

  async dispose(dbId: string): Promise<void> {
    const p = pool.get(dbId);
    if (p) {
      await p.end().catch(() => {});
      pool.delete(dbId);
    }
    clearPrevious(dbId);
    clearInsightBaseline(dbId);
  },

  collectInsights: (ctx: InsightContext) => collectPostgresInsights(ctx),
  collectIndexes: (ctx: InsightContext) => collectPostgresIndexes(ctx),
  getCurrentOperations: (dbId: string, uri: string) => getPostgresCurrentOperations(dbId, uri),
};

// ---------------------------------------------------------------------------
// Query insights — pg_stat_statements.
//
// The view is cumulative per (userid, dbid, queryid), so a window's cost is the
// difference against the previous reading. Shapes whose counters went BACKWARDS
// are treated as new rather than negative: that happens after
// pg_stat_statements_reset() or an eviction, and reporting a negative cost
// would be worse than briefly over-reporting one interval.
// ---------------------------------------------------------------------------

/** Column names differ across versions: total_time became total_exec_time in 13. */
const buildStatementsQuery = (totalCol: string, meanCol: string) => `
  SELECT queryid::text AS digest,
         query,
         calls,
         ${totalCol} AS total_ms,
         ${meanCol} AS mean_ms,
         max_exec_time AS max_ms,
         rows,
         shared_blks_hit,
         shared_blks_read,
         temp_blks_written
  FROM pg_stat_statements
  WHERE queryid IS NOT NULL
  ORDER BY ${totalCol} DESC
  LIMIT 500
`;

const readStatements = async (p: pg.Pool): Promise<any[]> => {
  try {
    const res = await p.query(buildStatementsQuery('total_exec_time', 'mean_exec_time'));
    return res.rows;
  } catch {
    // PostgreSQL 12 and earlier: no max_exec_time, and the totals are unprefixed.
    try {
      const res = await p.query(`
        SELECT queryid::text AS digest, query, calls,
               total_time AS total_ms, mean_time AS mean_ms, 0 AS max_ms,
               rows, shared_blks_hit, shared_blks_read, temp_blks_written
        FROM pg_stat_statements
        WHERE queryid IS NOT NULL
        ORDER BY total_time DESC
        LIMIT 500
      `);
      return res.rows;
    } catch {
      return [];
    }
  }
};

/** Long-running statements observed in flight, as the profiler substitute. */
const readActiveSlowOps = async (p: pg.Pool, thresholdMs: number): Promise<SlowOpSample[]> => {
  try {
    const res = await p.query(
      `SELECT query, EXTRACT(EPOCH FROM (now() - query_start)) * 1000 AS duration_ms,
              application_name
       FROM pg_stat_activity
       WHERE state = 'active'
         AND backend_type = 'client backend'
         AND pid <> pg_backend_pid()
         AND query_start IS NOT NULL
         AND (EXTRACT(EPOCH FROM (now() - query_start)) * 1000) >= $1
       ORDER BY duration_ms DESC
       LIMIT 50`,
      [thresholdMs]
    );

    const now = new Date();
    return res.rows.map((r: any) => {
      const text = normalizeSqlText(r.query || '');
      return {
        timestamp: now,
        durationMs: safeNum(r.duration_ms),
        operation: classifyOperation(r.query?.trim().split(/\s+/)[0]),
        queryText: text,
        digestHash: digestOf(text),
        source: r.application_name || undefined,
      };
    });
  } catch {
    return [];
  }
};

export const collectPostgresInsights = async (
  { dbId, uri, maxDigests, slowMsThreshold }: InsightContext
): Promise<InsightSample> => {
  const p = connect(dbId, uri);

  const [rows, slowOps] = await Promise.all([
    readStatements(p),
    readActiveSlowOps(p, slowMsThreshold),
  ]);

  if (rows.length === 0) return { queryStats: [], slowOps };

  const baseline = getInsightBaseline(dbId);
  const nextBaseline = new Map<string, DigestCounters>();
  const stats: QueryStatSample[] = [];

  for (const row of rows) {
    const digest = String(row.digest);
    const current: DigestCounters = {
      executions: safeNum(row.calls),
      totalTimeMs: safeNum(row.total_ms),
      rowsReturned: safeNum(row.rows),
      blocksHit: safeNum(row.shared_blks_hit),
      blocksRead: safeNum(row.shared_blks_read),
      tempBlocks: safeNum(row.temp_blks_written),
    };
    nextBaseline.set(digest, current);

    const prior = baseline?.digests.get(digest);
    // No baseline yet, or the counters reset: skip this shape for one interval
    // rather than reporting a cumulative total as if it were a window.
    if (!prior || current.executions < prior.executions) continue;

    const executions = current.executions - prior.executions;
    if (executions <= 0) continue;

    const totalTimeMs = Math.max(0, current.totalTimeMs - prior.totalTimeMs);
    const rowsReturned = Math.max(0, (current.rowsReturned || 0) - (prior.rowsReturned || 0));
    const blocksRead = Math.max(0, (current.blocksRead || 0) - (prior.blocksRead || 0));
    const blocksHit = Math.max(0, (current.blocksHit || 0) - (prior.blocksHit || 0));
    const text = normalizeSqlText(row.query || '');

    stats.push({
      digestHash: digest,
      queryText: text,
      operation: classifyOperation(String(row.query || '').trim().split(/\s+/)[0]),
      executions,
      totalTimeMs,
      meanTimeMs: totalTimeMs / executions,
      maxTimeMs: safeNum(row.max_ms),
      rowsReturned,
      // Blocks touched per row delivered is Postgres's closest analogue to
      // "documents examined per document returned".
      examinedPerReturned: rowsReturned > 0 ? (blocksHit + blocksRead) / rowsReturned : undefined,
      blocksHit,
      blocksRead,
      tempBlocks: Math.max(0, (current.tempBlocks || 0) - (prior.tempBlocks || 0)),
    });
  }

  setInsightBaseline(dbId, nextBaseline);

  stats.sort((a, b) => b.totalTimeMs - a.totalTimeMs);
  return { queryStats: stats.slice(0, maxDigests), slowOps };
};

// ---------------------------------------------------------------------------
// Index census.
//
// `indnkeyatts` is the count of KEY columns, distinct from `indnatts` which
// also counts INCLUDE columns (PostgreSQL 11+). Prefix redundancy is a property
// of key columns only, so using indnatts would treat an INCLUDE column as part
// of the ordering and miss real redundancy.
// ---------------------------------------------------------------------------

export const collectPostgresIndexes = async (
  { dbId, uri }: InsightContext
): Promise<IndexCensus> => {
  const p = connect(dbId, uri);

  const [indexRes, uptimeRes] = await Promise.all([
    p.query(`
      SELECT s.schemaname || '.' || s.relname          AS namespace,
             s.indexrelname                            AS name,
             s.idx_scan                                AS scans,
             pg_relation_size(s.indexrelid)            AS size_bytes,
             i.indisunique                             AS is_unique,
             i.indisprimary                            AS is_primary,
             (i.indpred IS NOT NULL)                   AS is_partial,
             pg_get_indexdef(s.indexrelid)             AS definition,
             ARRAY(
               SELECT pg_get_indexdef(s.indexrelid, k + 1, true)
               FROM generate_series(0, COALESCE(i.indnkeyatts, i.indnatts) - 1) AS k
             )                                         AS keys
      FROM pg_stat_user_indexes s
      JOIN pg_index i ON i.indexrelid = s.indexrelid
      ORDER BY pg_relation_size(s.indexrelid) DESC
      LIMIT 500
    `),
    p.query(`SELECT EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time())) AS uptime`),
  ]);

  return {
    serverUptimeSeconds: safeNum(uptimeRes.rows[0]?.uptime),
    indexes: indexRes.rows.map((r: any) => ({
      namespace: String(r.namespace),
      name: String(r.name),
      definition: String(r.definition || ''),
      keys: Array.isArray(r.keys) ? r.keys.map((k: any) => String(k)) : [],
      unique: !!r.is_unique,
      primary: !!r.is_primary,
      partial: !!r.is_partial,
      sizeBytes: safeNum(r.size_bytes),
      scans: safeNum(r.scans),
    })),
  };
};

// ---------------------------------------------------------------------------
// Topology & live operations.
// ---------------------------------------------------------------------------

const readTopology = async (p: pg.Pool): Promise<TopologySnapshot | undefined> => {
  try {
    const recovery = await tryQuery(p, 'SELECT pg_is_in_recovery() AS in_recovery');
    const isReplica = !!recovery?.in_recovery;

    if (isReplica) {
      // A standby cannot enumerate its siblings; it knows only its own lag.
      const lag = await tryQuery(
        p,
        `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000, 0) AS lag_ms`
      );
      return {
        kind: 'primary-replica',
        isReplica: true,
        members: [
          {
            name: 'this standby',
            role: 'standby',
            state: 'streaming',
            healthy: true,
            lagMs: safeNum(lag?.lag_ms),
            self: true,
          },
        ],
      };
    }

    const res = await p.query(`
      SELECT client_addr::text AS name, state, sync_state,
             pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS lag_bytes
      FROM pg_stat_replication
    `);

    return {
      kind: res.rows.length > 0 ? 'primary-replica' : 'standalone',
      isReplica: false,
      members: [
        { name: 'this primary', role: 'primary', state: 'accepting writes', healthy: true, self: true },
        ...res.rows.map((r: any) => ({
          name: String(r.name || 'unknown standby'),
          role: String(r.sync_state || 'async'),
          state: String(r.state || 'unknown'),
          healthy: r.state === 'streaming',
          lagBytes: safeNum(r.lag_bytes),
        })),
      ],
    };
  } catch {
    return undefined;
  }
};

export const getPostgresCurrentOperations = async (
  dbId: string,
  uri: string
): Promise<CurrentOperation[]> => {
  const p = connect(dbId, uri);
  const res = await p.query(`
    SELECT pid::text AS id,
           EXTRACT(EPOCH FROM (now() - query_start)) * 1000 AS duration_ms,
           state, wait_event_type, wait_event, application_name, query
    FROM pg_stat_activity
    WHERE state <> 'idle'
      AND backend_type = 'client backend'
      AND pid <> pg_backend_pid()
    ORDER BY duration_ms DESC NULLS LAST
    LIMIT 100
  `);

  return res.rows.map((r: any) => ({
    id: String(r.id),
    durationMs: safeNum(r.duration_ms),
    operation: classifyOperation(String(r.query || '').trim().split(/\s+/)[0]),
    queryText: normalizeSqlText(String(r.query || '')),
    state: r.state || undefined,
    waitingOn: r.wait_event_type ? `${r.wait_event_type}: ${r.wait_event}` : undefined,
    source: r.application_name || undefined,
  }));
};
