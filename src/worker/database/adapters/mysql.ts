import mysql2 from 'mysql2';
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
import { normalizeSqlText, classifyOperation } from '../redact';
import { logger } from '../../../utils/logger';

// Runtime hotfix: @senzops/apm-node <=1.3.5 naively checks
// `typeof result.then === 'function'` on mysql2 callback query objects. mysql2
// defines a dummy .then() that throws on invocation, crashing the APM wrapper.
// Deleting it from Query.prototype neutralizes the check.
// Safe: actual promise queries use native Promise.then(), not the prototype method.
// See: rca_mysql_apm_issue.md
try {
  const dummyQuery = (mysql2.Connection as any).createQuery('SELECT 1', [], () => {}, {});
  const QueryProto = Object.getPrototypeOf(dummyQuery);
  if (QueryProto && typeof QueryProto.then === 'function') {
    delete QueryProto.then;
  }
} catch {
  // Non-critical: defense-in-depth measure, not required with apm-node >=1.3.6
}

// ============================================================================
// MySQL adapter.
// ----------------------------------------------------------------------------
// Connection-per-poll rather than pooled: MySQL closes idle connections on its
// own schedule (wait_timeout), and a pool that outlives the server's patience
// spends every cycle recovering from a socket the server already dropped.
// ============================================================================

const EXCLUDED_SCHEMAS = "'information_schema', 'mysql', 'performance_schema', 'sys'";

type Conn = ReturnType<ReturnType<typeof mysql2.createConnection>['promise']>;

const isPermissionError = (err: any): boolean =>
  err?.errno === 1142 || err?.errno === 1227 || err?.errno === 1045 ||
  /access denied|permission/i.test(err?.message || '');

const isMissingTable = (err: any): boolean =>
  err?.errno === 1109 || err?.errno === 1146 || /doesn't exist|unknown table/i.test(err?.message || '');

const kv = (rows: any[], keyField: string, valueField: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const row of rows) out[row[keyField]] = row[valueField];
  return out;
};

interface MysqlCounters {
  comSelect: number;
  comInsert: number;
  comUpdate: number;
  comDelete: number;
  bytesReceived: number;
  bytesSent: number;
  questions: number;
  xactCommit: number;
  xactRollback: number;
  deadlocks: number;
  selectScan: number;
  selectRange: number;
  slowQueries: number;
  rowsRead: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsDeleted: number;
  tmpDiskTables: number;
  rowLockWaits: number;
  abortedConnects: number;
  innodbLogWaits: number;
  threadsCreated: number;
  connections: number;
  tableCacheHits: number;
  tableCacheMisses: number;
}

const readCounters = (s: Record<string, string>): MysqlCounters => ({
  comSelect: safeNum(s['Com_select']),
  comInsert: safeNum(s['Com_insert']),
  comUpdate: safeNum(s['Com_update']),
  comDelete: safeNum(s['Com_delete']),
  bytesReceived: safeNum(s['Bytes_received']),
  bytesSent: safeNum(s['Bytes_sent']),
  questions: safeNum(s['Questions']),
  xactCommit: safeNum(s['Com_commit']),
  xactRollback: safeNum(s['Com_rollback']),
  deadlocks: safeNum(s['Innodb_deadlocks']),
  selectScan: safeNum(s['Select_scan']),
  selectRange: safeNum(s['Select_range']),
  slowQueries: safeNum(s['Slow_queries']),
  rowsRead: safeNum(s['Innodb_rows_read']),
  rowsInserted: safeNum(s['Innodb_rows_inserted']),
  rowsUpdated: safeNum(s['Innodb_rows_updated']),
  rowsDeleted: safeNum(s['Innodb_rows_deleted']),
  tmpDiskTables: safeNum(s['Created_tmp_disk_tables']),
  rowLockWaits: safeNum(s['Innodb_row_lock_waits']),
  abortedConnects: safeNum(s['Aborted_connects']),
  innodbLogWaits: safeNum(s['Innodb_log_waits']),
  threadsCreated: safeNum(s['Threads_created']),
  connections: safeNum(s['Connections']),
  tableCacheHits: safeNum(s['Table_open_cache_hits']),
  tableCacheMisses: safeNum(s['Table_open_cache_misses']),
});

const probeCapabilities = async (conn: Conn): Promise<Capabilities> => {
  const caps: Capabilities = { serverStats: capable() };

  const check = async (
    key: keyof Capabilities,
    sql: string,
    denied: string,
    remediation: string,
    missing?: { reason: string; remediation: string }
  ) => {
    try {
      await conn.query(sql);
      caps[key] = capable();
    } catch (err: any) {
      if (isMissingTable(err) && missing) {
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
    `SELECT 1 FROM information_schema.TABLES LIMIT 1`,
    'The monitored user cannot read information_schema.TABLES.',
    'GRANT SELECT ON *.* TO <user>, or at minimum on the monitored schemas.'
  );

  await check(
    'collectionStats',
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN (${EXCLUDED_SCHEMAS}) LIMIT 1`,
    'The monitored user cannot enumerate tables.',
    'GRANT SELECT on the monitored schemas to <user>.'
  );

  await check(
    'queryStats',
    `SELECT DIGEST FROM performance_schema.events_statements_summary_by_digest LIMIT 1`,
    'The monitored user cannot read the statement digest table.',
    'GRANT SELECT ON performance_schema.* TO <user>.',
    {
      reason: 'performance_schema is disabled on this server.',
      remediation: 'Set performance_schema = ON in my.cnf and restart the server.',
    }
  );

  await check(
    'slowLog',
    `SELECT EVENT_ID FROM performance_schema.events_statements_history_long LIMIT 1`,
    'The monitored user cannot read statement history.',
    'GRANT SELECT ON performance_schema.* TO <user>.',
    {
      reason: 'The events_statements_history_long consumer is not enabled.',
      remediation:
        "Enable it: UPDATE performance_schema.setup_consumers SET ENABLED='YES' WHERE NAME='events_statements_history_long';",
    }
  );

  await check(
    'indexStats',
    `SELECT INDEX_NAME FROM performance_schema.table_io_waits_summary_by_index_usage LIMIT 1`,
    'The monitored user cannot read index usage statistics.',
    'GRANT SELECT ON performance_schema.* TO <user>.'
  );

  await check(
    'currentOps',
    `SELECT ID FROM information_schema.PROCESSLIST LIMIT 1`,
    'The monitored user can only see its own threads.',
    'GRANT PROCESS ON *.* TO <user>.'
  );

  // SHOW REPLICA STATUS is the 8.0.22+ spelling; older servers only know the
  // legacy form. Trying both distinguishes "old server" from "no privilege".
  try {
    await conn.query('SHOW REPLICA STATUS');
    caps.replication = capable();
  } catch {
    try {
      await conn.query('SHOW SLAVE STATUS');
      caps.replication = capable();
    } catch (legacyErr: any) {
      caps.replication = isPermissionError(legacyErr)
        ? incapable(
            'The monitored user cannot read replication status.',
            'GRANT REPLICATION CLIENT ON *.* TO <user>.'
          )
        : incapable(
            legacyErr?.message || 'Unavailable on this server.',
            'GRANT REPLICATION CLIENT ON *.* TO <user>.'
          );
    }
  }

  return caps;
};

/** Replication lag in ms; -1 when this server is not a replica. */
const readReplicationLag = async (conn: Conn): Promise<number> => {
  for (const stmt of ['SHOW REPLICA STATUS', 'SHOW SLAVE STATUS']) {
    try {
      const [rows] = await conn.query(stmt);
      const row = (rows as any[])[0];
      if (!row) return -1; // reachable, but this server is a primary
      const behind = safeNum(row.Seconds_Behind_Source, -1);
      if (behind >= 0) return behind * 1000;
      const legacy = safeNum(row.Seconds_Behind_Master, -1);
      return legacy >= 0 ? legacy * 1000 : -1;
    } catch {
      // try the next spelling
    }
  }
  return -1;
};

/**
 * Undo records awaiting purge. Sustained growth means the purge thread is
 * falling behind long-running transactions, which inflates the undo tablespace
 * and slows reads. Exposed through INNODB_METRICS, which some builds disable.
 */
const readHistoryListLength = async (conn: Conn): Promise<number | undefined> => {
  try {
    const [rows] = await conn.query(
      `SELECT COUNT FROM information_schema.INNODB_METRICS WHERE NAME = 'trx_rseg_history_len'`
    );
    const row = (rows as any[])[0];
    return row ? safeNum(row.COUNT ?? row.count) : undefined;
  } catch {
    return undefined;
  }
};

const runCensus = async (conn: Conn): Promise<CollectionStat[] | undefined> => {
  try {
    const [rows] = await conn.query(`
      SELECT CONCAT(TABLE_SCHEMA, '.', TABLE_NAME) AS name,
             TABLE_ROWS AS \`count\`,
             DATA_LENGTH AS data_size,
             INDEX_LENGTH AS index_size,
             (DATA_LENGTH + INDEX_LENGTH) AS total_size
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA NOT IN (${EXCLUDED_SCHEMAS}) AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC
      LIMIT 100
    `);
    return (rows as any[]).map((r) => ({
      name: r.name,
      count: safeNum(r.count),
      size: toMb(r.data_size),
      storageSize: toMb(r.total_size),
      indexSize: toMb(r.index_size),
    }));
  } catch (err: any) {
    logger.warn(`[DB Engine] MySQL census failed: ${err.message}`);
    return undefined;
  }
};

export const mysqlAdapter: DbAdapter = {
  type: 'mysql',

  async probe(uri: string): Promise<Capabilities> {
    const raw = mysql2.createConnection({ uri, connectTimeout: 5000 });
    raw.on('error', () => {});
    const conn = raw.promise();
    try {
      await conn.query('SELECT 1');
      return await probeCapabilities(conn);
    } finally {
      raw.end(() => {});
    }
  },

  async sample({ uri, dbId, censusDue, probeDue }: SampleContext): Promise<DbSample> {
    const raw = mysql2.createConnection({ uri, connectTimeout: 5000 });
    raw.on('error', () => {});
    const conn = raw.promise();

    try {
      const pingStart = performance.now();
      await conn.query('SELECT 1');
      const pingLatency = performance.now() - pingStart;

      const [[statusRows], [variableRows]] = await Promise.all([
        conn.query('SHOW GLOBAL STATUS'),
        conn.query('SHOW GLOBAL VARIABLES'),
      ]);

      const status = kv(statusRows as any[], 'Variable_name', 'Value');
      const variables = kv(variableRows as any[], 'Variable_name', 'Value');

      const now = Date.now();
      const previous = getPrevious<MysqlCounters>(dbId);
      const seconds = elapsedSeconds(previous, now);
      const counters = readCounters(status);

      const rate = (key: keyof MysqlCounters) =>
        previous ? perSecond(counters[key], previous.counters[key], seconds) : 0;
      const delta = (key: keyof MysqlCounters) =>
        previous ? Math.max(0, counters[key] - previous.counters[key]) : 0;

      // InnoDB buffer pool
      const bpReadRequests = safeNum(status['Innodb_buffer_pool_read_requests']);
      const bpReads = safeNum(status['Innodb_buffer_pool_reads']);
      const cacheHitRate = bpReadRequests > 0 ? ((bpReadRequests - bpReads) / bpReadRequests) * 100 : 0;

      const bpPageSize = safeNum(variables['innodb_page_size'], 16384);
      const bpPagesTotal = safeNum(status['Innodb_buffer_pool_pages_total']);
      const bpPagesFree = safeNum(status['Innodb_buffer_pool_pages_free']);
      const bpUsedMb = ((bpPagesTotal - bpPagesFree) * bpPageSize) / (1024 * 1024);
      const bpTotalMb = (bpPagesTotal * bpPageSize) / (1024 * 1024);

      const maxConn = safeNum(variables['max_connections'], 151);
      const currentConns = safeNum(status['Threads_connected']);

      const [sizeRows] = await conn
        .query(
          `SELECT COALESCE(SUM(DATA_LENGTH), 0) AS total_data,
                  COALESCE(SUM(INDEX_LENGTH), 0) AS total_idx,
                  COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS total,
                  COALESCE(SUM(TABLE_ROWS), 0) AS total_rows
           FROM information_schema.TABLES
           WHERE TABLE_SCHEMA NOT IN (${EXCLUDED_SCHEMAS})`
        )
        .catch(() => [[{}]] as any);
      const sizes = (sizeRows as any[])[0] || {};

      const [replicationLagMs, historyListLength] = await Promise.all([
        readReplicationLag(conn),
        readHistoryListLength(conn),
      ]);

      const cacheLookups = counters.tableCacheHits + counters.tableCacheMisses;
      const blockedQueries = safeNum(status['Innodb_row_lock_current_waits']);

      const topology = await readTopology(conn);
      const collections = censusDue ? await runCensus(conn) : undefined;
      const capabilities = probeDue ? await probeCapabilities(conn) : undefined;

      setPrevious(dbId, counters, previous?.lastCensusAt ?? now);

      return {
        version: variables['version'] || undefined,
        topology,
        metric: {
          throughput: {
            read: rate('comSelect'),
            write: rate('comInsert') + rate('comUpdate') + rate('comDelete'),
          },
          latency: { read: { avg: 0, max: 0 }, write: { avg: 0, max: 0 }, ping: pingLatency },
          uptimeSeconds: safeNum(status['Uptime']),
          connections: {
            current: currentConns,
            available: Math.max(0, maxConn - currentConns),
            totalCreated: counters.connections,
          },
          memory: { resident: bpUsedMb, virtual: bpTotalMb, mapped: 0 },
          network: {
            bytesIn: rate('bytesReceived'),
            bytesOut: rate('bytesSent'),
            numRequests: rate('questions'),
          },
          ops: { insert: 0, query: 0, update: 0, delete: 0, command: 0 },
          scans: { collectionScans: rate('selectScan'), indexScans: rate('selectRange') },
          // DATA_LENGTH and INDEX_LENGTH are disjoint; their sum is the disk
          // footprint. Reporting the sum as dataSize as well repeated the index
          // bytes. See the contract on IDbMetricFields.storage.
          storage: {
            dataSize: toMb(sizes.total_data),
            indexSize: toMb(sizes.total_idx),
            storageSize: toMb(sizes.total),
            objects: safeNum(sizes.total_rows),
          },
          locks: {
            activeReaders: blockedQueries,
            activeWriters: 0,
            queuedReaders: 0,
            queuedWriters: safeNum(status['Table_locks_waited']),
          },
          sql: {
            activeQueries: safeNum(status['Threads_running']),
            blockedQueries,
            deadlocks: delta('deadlocks'),
            cacheHitRate,
            tempBytesWritten: delta('tmpDiskTables'),
            replicationLagMs,
            tableScans: rate('selectScan'),
            indexScans: rate('selectRange'),
            rowsReturned: rate('rowsRead'),
            rowsModified: rate('rowsInserted') + rate('rowsUpdated') + rate('rowsDeleted'),
            transactionsCommitted: rate('xactCommit'),
            transactionsRolledBack: rate('xactRollback'),
            waitEvents: blockedQueries,
            slowQueries: delta('slowQueries'),
          },
          mysql: {
            historyListLength,
            rowLockWaitsRate: rate('rowLockWaits'),
            rowLockTimeAvgMs: safeNum(status['Innodb_row_lock_time_avg']),
            tmpDiskTablesRate: rate('tmpDiskTables'),
            // Threads served from the cache rather than spawned fresh. A low
            // value means connection churn is costing thread creation.
            threadCacheHitRate:
              counters.connections > 0
                ? Math.max(0, (1 - counters.threadsCreated / counters.connections) * 100)
                : undefined,
            abortedConnectsRate: rate('abortedConnects'),
            tableCacheHitRate:
              cacheLookups > 0 ? (counters.tableCacheHits / cacheLookups) * 100 : undefined,
            innodbLogWaitsRate: rate('innodbLogWaits'),
            openTables: safeNum(status['Open_tables']),
          },
        },
        ...(collections ? { collections } : {}),
        ...(capabilities ? { capabilities } : {}),
      };
    } finally {
      raw.end(() => {});
    }
  },

  dispose(dbId: string): void {
    // Nothing pooled — the connection closes at the end of every cycle.
    clearPrevious(dbId);
    clearInsightBaseline(dbId);
  },

  collectInsights: (ctx: InsightContext) => collectMysqlInsights(ctx),
  collectIndexes: (ctx: InsightContext) => collectMysqlIndexes(ctx),
  getCurrentOperations: (dbId: string, uri: string) => getMysqlCurrentOperations(dbId, uri),
};

// ---------------------------------------------------------------------------
// Query insights — performance_schema statement digests.
//
// Timer columns are picoseconds; every duration here is converted once, at the
// boundary, so nothing downstream has to remember the unit.
//
// DIGEST_TEXT is used throughout rather than SQL_TEXT. The former is MySQL's
// own normalized form with literals already replaced by `?`; the latter is the
// statement verbatim, including values. Reading the wrong column is the single
// easiest way to leak customer data into a monitoring product.
// ---------------------------------------------------------------------------

const PICOSECONDS_PER_MS = 1_000_000_000;
const psToMs = (value: any): number => safeNum(value) / PICOSECONDS_PER_MS;

const readDigests = async (conn: Conn): Promise<any[]> => {
  try {
    const [rows] = await conn.query(`
      SELECT DIGEST, DIGEST_TEXT, SCHEMA_NAME,
             COUNT_STAR, SUM_TIMER_WAIT, MAX_TIMER_WAIT,
             SUM_ROWS_SENT, SUM_ROWS_EXAMINED,
             SUM_CREATED_TMP_DISK_TABLES, SUM_NO_INDEX_USED
      FROM performance_schema.events_statements_summary_by_digest
      WHERE DIGEST IS NOT NULL
      ORDER BY SUM_TIMER_WAIT DESC
      LIMIT 500
    `);
    return rows as any[];
  } catch {
    return [];
  }
};

const readSlowStatements = async (conn: Conn, thresholdMs: number): Promise<SlowOpSample[]> => {
  try {
    const [rows] = await conn.query(
      `SELECT DIGEST, DIGEST_TEXT, CURRENT_SCHEMA, TIMER_WAIT, ROWS_SENT, ROWS_EXAMINED, NO_INDEX_USED
       FROM performance_schema.events_statements_history_long
       WHERE TIMER_WAIT >= ? AND DIGEST_TEXT IS NOT NULL
       ORDER BY TIMER_WAIT DESC
       LIMIT 50`,
      [thresholdMs * PICOSECONDS_PER_MS]
    );

    const now = new Date();
    return (rows as any[]).map((r) => ({
      timestamp: now,
      durationMs: psToMs(r.TIMER_WAIT),
      operation: classifyOperation(String(r.DIGEST_TEXT || '').trim().split(/\s+/)[0]),
      namespace: r.CURRENT_SCHEMA || undefined,
      queryText: normalizeSqlText(String(r.DIGEST_TEXT || '')),
      digestHash: r.DIGEST ? String(r.DIGEST) : undefined,
      docsReturned: safeNum(r.ROWS_SENT),
      docsExamined: safeNum(r.ROWS_EXAMINED),
      planSummary: safeNum(r.NO_INDEX_USED) > 0 ? 'NO INDEX USED' : undefined,
    }));
  } catch {
    return [];
  }
};

export const collectMysqlInsights = async (
  { dbId, uri, maxDigests, slowMsThreshold }: InsightContext
): Promise<InsightSample> => {
  const raw = mysql2.createConnection({ uri, connectTimeout: 5000 });
  raw.on('error', () => {});
  const conn = raw.promise();

  try {
    const [rows, slowOps] = await Promise.all([
      readDigests(conn),
      readSlowStatements(conn, slowMsThreshold),
    ]);

    if (rows.length === 0) return { queryStats: [], slowOps };

    const baseline = getInsightBaseline(dbId);
    const nextBaseline = new Map<string, DigestCounters>();
    const stats: QueryStatSample[] = [];

    for (const row of rows) {
      const digest = String(row.DIGEST);
      const current: DigestCounters = {
        executions: safeNum(row.COUNT_STAR),
        totalTimeMs: psToMs(row.SUM_TIMER_WAIT),
        rowsReturned: safeNum(row.SUM_ROWS_SENT),
        rowsExamined: safeNum(row.SUM_ROWS_EXAMINED),
      };
      nextBaseline.set(digest, current);

      const prior = baseline?.digests.get(digest);
      // performance_schema truncates its digest table when full, and TRUNCATE
      // resets it outright. Either way a decreased counter means the baseline
      // is meaningless, so the shape sits out one interval.
      if (!prior || current.executions < prior.executions) continue;

      const executions = current.executions - prior.executions;
      if (executions <= 0) continue;

      const totalTimeMs = Math.max(0, current.totalTimeMs - prior.totalTimeMs);
      const rowsReturned = Math.max(0, (current.rowsReturned || 0) - (prior.rowsReturned || 0));
      const rowsExamined = Math.max(0, (current.rowsExamined || 0) - (prior.rowsExamined || 0));

      stats.push({
        digestHash: digest,
        queryText: normalizeSqlText(String(row.DIGEST_TEXT || '')),
        namespace: row.SCHEMA_NAME || undefined,
        operation: classifyOperation(String(row.DIGEST_TEXT || '').trim().split(/\s+/)[0]),
        executions,
        totalTimeMs,
        meanTimeMs: totalTimeMs / executions,
        maxTimeMs: psToMs(row.MAX_TIMER_WAIT),
        rowsReturned,
        rowsExamined,
        examinedPerReturned: rowsReturned > 0 ? rowsExamined / rowsReturned : undefined,
        planSummary: safeNum(row.SUM_NO_INDEX_USED) > 0 ? 'NO INDEX USED' : undefined,
      });
    }

    setInsightBaseline(dbId, nextBaseline);

    stats.sort((a, b) => b.totalTimeMs - a.totalTimeMs);
    return { queryStats: stats.slice(0, maxDigests), slowOps };
  } finally {
    raw.end(() => {});
  }
};

// ---------------------------------------------------------------------------
// Index census.
//
// Three sources, because MySQL splits the information:
//   information_schema.STATISTICS  — definitions and column ordering
//   performance_schema...index_usage — usage counters
//   mysql.innodb_index_stats       — per-index size, where readable
//
// Size is genuinely optional here: innodb_index_stats requires privileges that
// many managed providers withhold, and there is no portable substitute. Zero is
// reported rather than a guess, and the UI renders that as unknown.
// ---------------------------------------------------------------------------

export const collectMysqlIndexes = async (
  { uri }: InsightContext
): Promise<IndexCensus> => {
  const raw = mysql2.createConnection({ uri, connectTimeout: 5000 });
  raw.on('error', () => {});
  const conn = raw.promise();

  try {
    const [[columnRows], [usageRows], [statusRows]] = await Promise.all([
      conn.query(`
        SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, NON_UNIQUE
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA NOT IN (${EXCLUDED_SCHEMAS})
        ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
      `),
      conn.query(`
        SELECT OBJECT_SCHEMA, OBJECT_NAME, INDEX_NAME, COUNT_STAR
        FROM performance_schema.table_io_waits_summary_by_index_usage
        WHERE INDEX_NAME IS NOT NULL AND OBJECT_SCHEMA NOT IN (${EXCLUDED_SCHEMAS})
      `).catch(() => [[]] as any),
      conn.query(`SHOW GLOBAL STATUS LIKE 'Uptime'`),
    ]);

    const [sizeRows] = await conn
      .query(`
        SELECT database_name, table_name, index_name, stat_value, @@innodb_page_size AS page_size
        FROM mysql.innodb_index_stats
        WHERE stat_name = 'size'
      `)
      .catch(() => [[]] as any);

    const usage = new Map<string, number>();
    for (const r of usageRows as any[]) {
      usage.set(`${r.OBJECT_SCHEMA}.${r.OBJECT_NAME}|${r.INDEX_NAME}`, safeNum(r.COUNT_STAR));
    }

    const sizes = new Map<string, number>();
    for (const r of sizeRows as any[]) {
      const pageSize = safeNum(r.page_size, 16384);
      sizes.set(`${r.database_name}.${r.table_name}|${r.index_name}`, safeNum(r.stat_value) * pageSize);
    }

    // STATISTICS returns one row per column; fold them back into one index each,
    // preserving SEQ_IN_INDEX order.
    const grouped = new Map<string, { namespace: string; name: string; keys: string[]; unique: boolean }>();
    for (const r of columnRows as any[]) {
      const namespace = `${r.TABLE_SCHEMA}.${r.TABLE_NAME}`;
      const key = `${namespace}|${r.INDEX_NAME}`;
      const entry = grouped.get(key) || {
        namespace,
        name: String(r.INDEX_NAME),
        keys: [],
        unique: safeNum(r.NON_UNIQUE) === 0,
      };
      entry.keys.push(String(r.COLUMN_NAME));
      grouped.set(key, entry);
    }

    const uptime = safeNum((statusRows as any[])[0]?.Value);

    const indexes = [...grouped.entries()].map(([key, entry]) => ({
      namespace: entry.namespace,
      name: entry.name,
      definition: `(${entry.keys.join(', ')})`,
      keys: entry.keys,
      unique: entry.unique,
      // MySQL names the clustered primary key PRIMARY; there is no other marker.
      primary: entry.name === 'PRIMARY',
      partial: false, // MySQL has no partial indexes
      sizeBytes: sizes.get(key) ?? 0,
      scans: usage.get(key) ?? 0,
    }));

    return { indexes, serverUptimeSeconds: uptime };
  } finally {
    raw.end(() => {});
  }
};

// ---------------------------------------------------------------------------
// Topology & live operations.
// ---------------------------------------------------------------------------

const readTopology = async (conn: Conn): Promise<TopologySnapshot | undefined> => {
  try {
    // A replica knows its source; a source can enumerate its replicas. Which
    // query answers depends on which side we are connected to, so both run.
    for (const stmt of ['SHOW REPLICA STATUS', 'SHOW SLAVE STATUS']) {
      try {
        const [rows] = await conn.query(stmt);
        const row = (rows as any[])[0];
        if (!row) break; // reachable but not a replica — fall through to the source path
        const behind = safeNum(row.Seconds_Behind_Source ?? row.Seconds_Behind_Master, -1);
        const ioOk = (row.Replica_IO_Running ?? row.Slave_IO_Running) === 'Yes';
        const sqlOk = (row.Replica_SQL_Running ?? row.Slave_SQL_Running) === 'Yes';
        return {
          kind: 'primary-replica',
          isReplica: true,
          members: [
            {
              name: `${row.Source_Host ?? row.Master_Host ?? 'source'}:${row.Source_Port ?? row.Master_Port ?? ''}`,
              role: 'source',
              state: ioOk ? 'connected' : 'disconnected',
              healthy: ioOk,
            },
            {
              name: 'this replica',
              role: 'replica',
              state: sqlOk ? 'applying' : 'stopped',
              healthy: ioOk && sqlOk,
              lagMs: behind >= 0 ? behind * 1000 : undefined,
              self: true,
            },
          ],
        };
      } catch {
        // try the other spelling
      }
    }

    for (const stmt of ['SHOW REPLICAS', 'SHOW SLAVE HOSTS']) {
      try {
        const [rows] = await conn.query(stmt);
        const replicas = rows as any[];
        return {
          kind: replicas.length > 0 ? 'primary-replica' : 'standalone',
          isReplica: false,
          members: [
            { name: 'this source', role: 'source', state: 'accepting writes', healthy: true, self: true },
            ...replicas.map((r) => ({
              name: `${r.Host || 'replica'}:${r.Port || ''}`,
              role: 'replica',
              state: 'registered',
              healthy: true,
            })),
          ],
        };
      } catch {
        // try the other spelling
      }
    }

    return { kind: 'standalone', isReplica: false, members: [] };
  } catch {
    return undefined;
  }
};

export const getMysqlCurrentOperations = async (
  _dbId: string,
  uri: string
): Promise<CurrentOperation[]> => {
  const raw = mysql2.createConnection({ uri, connectTimeout: 5000 });
  raw.on('error', () => {});
  const conn = raw.promise();

  try {
    const [rows] = await conn.query(`
      SELECT ID, TIME, STATE, DB, INFO, COMMAND, USER
      FROM information_schema.PROCESSLIST
      WHERE COMMAND <> 'Sleep' AND ID <> CONNECTION_ID()
      ORDER BY TIME DESC
      LIMIT 100
    `);

    return (rows as any[]).map((r) => ({
      id: String(r.ID),
      durationMs: safeNum(r.TIME) * 1000,
      operation: classifyOperation(String(r.INFO || r.COMMAND || '').trim().split(/\s+/)[0]),
      namespace: r.DB || undefined,
      // PROCESSLIST.INFO is the statement verbatim, values included, so it is
      // normalized here before it can leave the adapter.
      queryText: normalizeSqlText(String(r.INFO || r.COMMAND || '')),
      state: r.STATE || undefined,
      source: r.USER || undefined,
    }));
  } finally {
    raw.end(() => {});
  }
};
