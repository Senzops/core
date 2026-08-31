import { MongoClient } from 'mongodb';
import type {
  DbAdapter, DbSample, Capabilities, SampleContext, CollectionStat,
  InsightContext, InsightSample, QueryStatSample, SlowOpSample, IndexCensus, IndexSample,
  TopologySnapshot, CurrentOperation,
} from './types';
import { capable, incapable, safeNum, perSecond, toMb } from './types';
import {
  getPrevious, setPrevious, clearPrevious, elapsedSeconds,
  getInsightBaseline, setInsightBaseline, clearInsightBaseline, type DigestCounters,
} from '../state';
import { redactMongoCommand, digestOf, classifyOperation } from '../redact';
import { logger } from '../../../utils/logger';

// ============================================================================
// MongoDB adapter.
// ----------------------------------------------------------------------------
// Reads only. The profiler is never enabled, no operation is ever killed, and
// no index is ever created — Senzor observes, it does not administer.
// ============================================================================

const pool = new Map<string, MongoClient>();
const CENSUS_COLLECTION_CAP = 3000;
const CENSUS_BATCH = 50;
const CENSUS_KEEP = 100;

const connect = async (dbId: string, uri: string): Promise<MongoClient> => {
  let client = pool.get(dbId);
  if (!client) {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 1 });
    await client.connect();
    pool.set(dbId, client);
  }
  return client;
};

/** MongoDB's "not authorized" is code 13; anything else is a real fault. */
const isAuthError = (err: any): boolean =>
  err?.code === 13 || /not authorized|requires authentication/i.test(err?.message || '');

/** Code 76 = this node is not running as a replica set member. */
const isStandalone = (err: any): boolean =>
  err?.code === 76 || /not running with --replSet/i.test(err?.message || '');

interface MongoCounters {
  query: number;
  getmore: number;
  insert: number;
  update: number;
  delete: number;
  command: number;
  netIn: number;
  netOut: number;
  netRequests: number;
  opLatencies: any;
  keysExamined: number;
  docsExamined: number;
  docsReturned: number;
  scanAndOrder: number;
  cacheEvictions: number;
  cursorsTimedOut: number;
  asserts: number;
}

const sumAsserts = (a: any): number =>
  safeNum(a?.regular) + safeNum(a?.warning) + safeNum(a?.msg) + safeNum(a?.user);

const readCounters = (status: any): MongoCounters => ({
  query: safeNum(status.opcounters?.query),
  getmore: safeNum(status.opcounters?.getmore),
  insert: safeNum(status.opcounters?.insert),
  update: safeNum(status.opcounters?.update),
  delete: safeNum(status.opcounters?.delete),
  command: safeNum(status.opcounters?.command),
  netIn: safeNum(status.network?.bytesIn),
  netOut: safeNum(status.network?.bytesOut),
  netRequests: safeNum(status.network?.numRequests),
  opLatencies: status.opLatencies || {},
  keysExamined: safeNum(status.metrics?.queryExecutor?.scanned),
  docsExamined: safeNum(status.metrics?.queryExecutor?.scannedObjects),
  docsReturned: safeNum(status.metrics?.document?.returned),
  scanAndOrder: safeNum(status.metrics?.operation?.scanAndOrder),
  cacheEvictions:
    safeNum(status.wiredTiger?.cache?.['unmodified pages evicted']) +
    safeNum(status.wiredTiger?.cache?.['modified pages evicted']),
  cursorsTimedOut: safeNum(status.metrics?.cursor?.timedOut),
  asserts: sumAsserts(status.asserts),
});

/**
 * Concurrency tickets moved between releases: WiredTiger exposed them under
 * `concurrentTransactions` through 6.x, and 7.0 promoted them to `queues.execution`.
 * Reading both keeps the saturation signal alive across supported versions
 * instead of silently reporting nothing on one of them.
 */
const readTickets = (status: any): { read?: number; write?: number } => {
  const modern = status.queues?.execution;
  if (modern?.read || modern?.write) {
    return { read: safeNum(modern.read?.available), write: safeNum(modern.write?.available) };
  }
  const legacy = status.wiredTiger?.concurrentTransactions;
  if (legacy?.read || legacy?.write) {
    return { read: safeNum(legacy.read?.available), write: safeNum(legacy.write?.available) };
  }
  return {};
};

// ---------------------------------------------------------------------------
// Connection scope.
//
// `client.db()` returns the database named in the connection string — and
// silently falls back to `test` when the string names none, which is the
// normal shape for a cluster-level monitoring URI
// (mongodb+srv://user:pass@cluster/?retryWrites=true). Every read routed
// through it then reports on an empty database: zero storage, zero
// collections, zero indexes, and a capability probe that "succeeds".
//
// Resolving the scope explicitly keeps both shapes correct: a URI that names
// a database is measured on exactly that database, and one that does not is
// measured across the cluster it points at.
// ---------------------------------------------------------------------------

const SYSTEM_DATABASES = new Set(['admin', 'local', 'config']);

/** Concurrent dbStats commands when a scope spans several databases. */
const STORAGE_BATCH = 5;

/** Bounds the per-database command fan-out on a cluster-scoped connection. */
const MAX_SCOPE_DATABASES = 25;

/**
 * The database named in a MongoDB connection string, or null when it targets
 * the cluster. Parsed rather than read back off the driver, because the driver
 * resolves an absent name to `test` and so cannot distinguish "no database"
 * from "a database actually called test".
 *
 * Credentials are required to be percent-encoded, so the first slash after the
 * host section always begins the path.
 */
export const databaseFromUri = (uri: string): string | null => {
  try {
    const withoutQuery = uri.split('?')[0];
    const afterScheme = withoutQuery.replace(/^mongodb(\+srv)?:\/\//i, '');
    const slash = afterScheme.indexOf('/');
    if (slash === -1) return null;
    const name = decodeURIComponent(afterScheme.slice(slash + 1)).trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
};

/**
 * The databases this connection should be measured over. One entry for a
 * URI that names a database; every non-system database on the cluster
 * otherwise, capped so a large fleet cannot turn one poll into hundreds of
 * commands against the instance being observed.
 */
/**
 * Cluster-scoped resolutions are memoised briefly: storage, the census, the
 * capability probe and the index census each need the scope, and on a cycle
 * where several coincide they would otherwise issue listDatabases once apiece.
 * Only successful lookups are cached, so a transient privilege error cannot
 * stick; the window is short enough that a newly created database is picked up
 * within a few polls.
 */
const SCOPE_CACHE_TTL_MS = 5 * 60 * 1000;
const scopeCache = new Map<string, { names: string[]; expiresAt: number }>();

const resolveScope = async (client: MongoClient, uri: string): Promise<string[]> => {
  const named = databaseFromUri(uri);
  if (named) return [named]; // no I/O — nothing worth caching

  const cached = scopeCache.get(uri);
  if (cached && cached.expiresAt > Date.now()) return cached.names;

  try {
    const result: any = await client.db('admin').command({ listDatabases: 1, nameOnly: true });
    const names = (result.databases || [])
      .map((d: any) => String(d.name))
      .filter((name: string) => !SYSTEM_DATABASES.has(name))
      .slice(0, MAX_SCOPE_DATABASES);

    scopeCache.set(uri, { names, expiresAt: Date.now() + SCOPE_CACHE_TTL_MS });
    return names;
  } catch {
    // Without listDatabases privileges the best available answer is whatever
    // the driver defaults to. Deliberately not cached — the next cycle should
    // retry rather than inherit a degraded answer.
    return [client.db().databaseName];
  }
};

/** Whether entries need a `db.collection` prefix to stay unambiguous. */
const isClusterScope = (scope: string[]) => scope.length > 1;

const probeCapabilities = async (client: MongoClient, uri: string): Promise<Capabilities> => {
  const admin = client.db('admin');
  // Probe the database the instance is actually measured on; probing an
  // empty `test` would report every capability as available.
  const [primary] = await resolveScope(client, uri);
  const target = client.db(primary);
  const caps: Capabilities = { serverStats: capable() };

  const check = async (
    key: keyof Capabilities,
    run: () => Promise<any>,
    denied: string,
    remediation: string,
    /** Return true to omit the key entirely — the feature does not apply here. */
    notApplicable?: (err: any) => boolean
  ) => {
    try {
      await run();
      caps[key] = capable();
    } catch (err: any) {
      if (notApplicable?.(err)) return; // absent = not applicable to this topology
      caps[key] = isAuthError(err)
        ? incapable(denied, remediation)
        : incapable(err?.message || 'Unavailable on this deployment.', remediation);
    }
  };

  await check(
    'storageStats',
    () => target.command({ dbStats: 1 }),
    'The monitored user cannot run dbStats on this database.',
    'Grant the clusterMonitor role, or read on the target database.'
  );

  await check(
    'collectionStats',
    () => target.listCollections({}, { nameOnly: true }).toArray(),
    'The monitored user cannot list collections.',
    'Grant listCollections on the target database (included in read).'
  );

  await check(
    'indexStats',
    async () => {
      const first = await target.listCollections({}, { nameOnly: true }).next();
      if (!first) return; // empty database is not a permission problem
      await target.collection(first.name).aggregate([{ $indexStats: {} }]).limit(1).toArray();
    },
    'The monitored user cannot read $indexStats.',
    'Grant the clusterMonitor role, which includes indexStats.'
  );

  await check(
    'queryStats',
    () => admin.aggregate([{ $queryStats: {} }]).limit(1).toArray(),
    'The monitored user cannot read $queryStats.',
    'Grant the clusterMonitor role. $queryStats requires MongoDB 7.0 or later.'
  );

  await check(
    'slowLog',
    async () => {
      const level = await target.command({ profile: -1 });
      // Profiling off is a configuration choice, not a permission problem, and
      // Senzor will not turn it on: enabling it writes to the user's database.
      if (safeNum(level?.was) === 0) {
        throw Object.assign(new Error('Database profiler is disabled on this database.'), { senzorConfig: true });
      }
      await target.collection('system.profile').find({}).limit(1).toArray();
    },
    'The monitored user cannot read system.profile.',
    'Enable the profiler on the target database (db.setProfilingLevel(1, { slowms: 100 })) and grant read on system.profile. Senzor never changes this setting for you.'
  );

  await check(
    'replication',
    () => admin.command({ replSetGetStatus: 1 }),
    'The monitored user cannot read replica set status.',
    'Grant the clusterMonitor role.',
    isStandalone
  );

  await check(
    'currentOps',
    () => admin.aggregate([{ $currentOp: { allUsers: true, idleConnections: false } }]).limit(1).toArray(),
    'The monitored user cannot read $currentOp for all users.',
    'Grant the clusterMonitor role (inprog privilege).'
  );

  return caps;
};

/**
 * Real storage figures, measured over the resolved scope.
 *
 * The original implementation reported `listDatabases.totalSize` for BOTH
 * dataSize and storageSize and hardcoded indexSize to zero, so the chart drew
 * two identical lines and a flat zero. dbStats separates all three — but read
 * through the driver default it measures an empty `test` database whenever the
 * connection string names none, which reports zero for a cluster that is
 * plainly not empty. Summing dbStats across the scope keeps the separation
 * without narrowing what is measured.
 */
const readStorage = async (client: MongoClient, uri: string) => {
  const totals = { dataSize: 0, indexSize: 0, storageSize: 0, objects: 0 };

  try {
    const scope = await resolveScope(client, uri);

    // dbStats is a round-trip each, measured at roughly 150-200ms against a
    // hosted cluster. Run sequentially, a 25-database scope would spend four
    // seconds of every polling cycle here; batched, it costs well under one
    // while never putting more than STORAGE_BATCH commands in flight against
    // the instance being observed. A URI that names a database is a single
    // call and takes neither path.
    for (let i = 0; i < scope.length; i += STORAGE_BATCH) {
      const batch = scope.slice(i, i + STORAGE_BATCH).map(async (name) => {
        try {
          return await client.db(name).command({ dbStats: 1 });
        } catch {
          // One unreadable database must not zero the whole figure.
          return null;
        }
      });

      for (const stats of await Promise.all(batch)) {
        if (!stats) continue;
        totals.dataSize += toMb((stats as any).dataSize);
        totals.indexSize += toMb((stats as any).indexSize);
        totals.storageSize += toMb((stats as any).storageSize);
        totals.objects += safeNum((stats as any).objects);
      }
    }
  } catch {
    // Fall through with zeros — the capability probe explains why.
  }

  return totals;
};

/** Seconds of history the oplog retains — a replica's recovery budget. */
const readOplogWindow = async (client: MongoClient): Promise<number | undefined> => {
  try {
    const oplog = client.db('local').collection('oplog.rs');
    const [first] = await oplog.find({}, { projection: { ts: 1 } }).sort({ $natural: 1 }).limit(1).toArray();
    const [last] = await oplog.find({}, { projection: { ts: 1 } }).sort({ $natural: -1 }).limit(1).toArray();
    if (!first?.ts || !last?.ts) return undefined;
    return Math.max(0, (last.ts as any).getHighBits() - (first.ts as any).getHighBits());
  } catch {
    return undefined;
  }
};

/**
 * Worst replication lag across secondaries, derived from the topology
 * snapshot rather than read separately.
 *
 * Both come from the same replSetGetStatus response, and issuing it twice per
 * poll doubled the administrative command load on every monitored replica set
 * for a number the snapshot already carries.
 */
const lagFromTopology = (topology?: TopologySnapshot): number | undefined => {
  if (!topology || topology.kind === 'standalone') return undefined;
  const lags = topology.members
    .filter((m) => m.role === 'SECONDARY' && typeof m.lagMs === 'number')
    .map((m) => m.lagMs as number);
  if (lags.length === 0) return topology.members.length > 0 ? 0 : undefined;
  return Math.max(0, ...lags);
};

const runCensus = async (client: MongoClient, uri: string): Promise<CollectionStat[] | undefined> => {
  try {
    const scope = await resolveScope(client, uri);
    const qualify = isClusterScope(scope);
    const results: CollectionStat[] = [];

    for (const dbName of scope) {
      // Remaining budget, so one enormous database cannot crowd out the rest
      // of the cluster.
      if (results.length >= CENSUS_COLLECTION_CAP) break;

      const target = client.db(dbName);
      let names: string[];
      try {
        const all = await target.listCollections({}, { nameOnly: true }).toArray();
        names = all.map((c: any) => String(c.name));
      } catch {
        continue; // not readable with these privileges — skip, do not fail
      }

      const subset = names.slice(0, CENSUS_COLLECTION_CAP - results.length);

      // Batched so a database with thousands of collections cannot open
      // thousands of concurrent commands against the instance we are supposed
      // to be observing unobtrusively.
      for (let i = 0; i < subset.length; i += CENSUS_BATCH) {
        const batch = subset.slice(i, i + CENSUS_BATCH).map(async (name) => {
          try {
            const stats: any = await target.command({ collStats: name, scale: 1048576 });
            return {
              // Qualified only when the scope spans databases, so a
              // single-database connection keeps the names users know.
              name: qualify ? `${dbName}.${name}` : name,
              count: safeNum(stats.count),
              size: safeNum(stats.size),
              storageSize: safeNum(stats.storageSize),
              indexSize: safeNum(stats.totalIndexSize),
            };
          } catch {
            return null;
          }
        });
        results.push(...((await Promise.all(batch)).filter(Boolean) as CollectionStat[]));
      }
    }

    return results.sort((a, b) => b.storageSize - a.storageSize).slice(0, CENSUS_KEEP);
  } catch (err: any) {
    logger.warn(`[DB Engine] Mongo census failed: ${err.message}`);
    return undefined;
  }
};

export const mongoAdapter: DbAdapter = {
  type: 'mongodb',

  async probe(uri: string): Promise<Capabilities> {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 1 });
    try {
      await client.connect();
      await client.db('admin').command({ serverStatus: 1 });
      return await probeCapabilities(client, uri);
    } finally {
      await client.close(true).catch(() => {});
    }
  },

  async sample({ dbId, uri, censusDue, probeDue }: SampleContext): Promise<DbSample> {
    const client = await connect(dbId, uri);
    const admin = client.db('admin');

    const [status, storage] = await Promise.all([
      admin.command({ serverStatus: 1 }),
      readStorage(client, uri),
    ]);

    const now = Date.now();
    const previous = getPrevious<MongoCounters>(dbId);
    const seconds = elapsedSeconds(previous, now);
    const counters = readCounters(status);

    const rate = (current: number, key: keyof MongoCounters) =>
      previous ? perSecond(current, previous.counters[key] as number, seconds) : 0;

    const readRate = rate(counters.query, 'query') + rate(counters.getmore, 'getmore');
    const writeRate =
      rate(counters.insert, 'insert') + rate(counters.update, 'update') + rate(counters.delete, 'delete');

    // opLatencies accumulates total microseconds and an operation count; the
    // per-operation average for THIS interval is the ratio of their deltas.
    const intervalLatencyMs = (kind: 'reads' | 'writes'): number => {
      const current = counters.opLatencies?.[kind];
      const prior = previous?.counters?.opLatencies?.[kind];
      if (!current || !prior) return 0;
      const ops = safeNum(current.ops) - safeNum(prior.ops);
      const micros = safeNum(current.latency) - safeNum(prior.latency);
      return ops > 0 ? micros / ops / 1000 : 0;
    };

    const avgReadMs = intervalLatencyMs('reads');
    const avgWriteMs = intervalLatencyMs('writes');

    const keysExaminedRate = rate(counters.keysExamined, 'keysExamined');
    const docsExaminedRate = rate(counters.docsExamined, 'docsExamined');
    const docsReturnedRate = rate(counters.docsReturned, 'docsReturned');

    const cache = status.wiredTiger?.cache;
    const cacheUsed = safeNum(cache?.['bytes currently in the cache']);
    const cacheMax = safeNum(cache?.['maximum bytes configured']);
    const tickets = readTickets(status);

    const [oplogWindowSeconds, topology] = await Promise.all([
      readOplogWindow(client),
      readTopology(client),
    ]);
    const replicationLagMs = lagFromTopology(topology);

    setPrevious(dbId, counters, previous?.lastCensusAt ?? now);

    return {
      version: status.version || undefined,
      metric: {
        throughput: { read: readRate, write: writeRate },
        latency: {
          // Mongo exposes no per-interval maximum, so max mirrors the average
          // rather than inventing a number the server never reported.
          read: { avg: avgReadMs, max: avgReadMs },
          write: { avg: avgWriteMs, max: avgWriteMs },
        },
        uptimeSeconds: safeNum(status.uptime),
        connections: {
          current: safeNum(status.connections?.current),
          available: safeNum(status.connections?.available),
          totalCreated: safeNum(status.connections?.totalCreated),
        },
        memory: {
          resident: safeNum(status.mem?.resident),
          virtual: safeNum(status.mem?.virtual),
          mapped: safeNum(status.mem?.mapped),
        },
        network: {
          bytesIn: rate(counters.netIn, 'netIn'),
          bytesOut: rate(counters.netOut, 'netOut'),
          numRequests: rate(counters.netRequests, 'netRequests'),
        },
        ops: {
          insert: counters.insert,
          query: counters.query,
          update: counters.update,
          delete: counters.delete,
          command: counters.command,
        },
        // Rates, not the raw cumulative counters the previous implementation
        // stored — those only ever produced a line that climbed forever.
        scans: { collectionScans: docsExaminedRate, indexScans: keysExaminedRate },
        storage,
        locks: {
          activeReaders: safeNum(status.globalLock?.activeClients?.readers),
          activeWriters: safeNum(status.globalLock?.activeClients?.writers),
          queuedReaders: safeNum(status.globalLock?.currentQueue?.readers),
          queuedWriters: safeNum(status.globalLock?.currentQueue?.writers),
        },
        mongo: {
          cacheUsedMb: toMb(cacheUsed),
          cacheDirtyMb: toMb(cache?.['tracked dirty bytes in the cache']),
          cacheMaxMb: toMb(cacheMax),
          cacheUsedPercent: cacheMax > 0 ? (cacheUsed / cacheMax) * 100 : undefined,
          cacheEvictionsRate: rate(counters.cacheEvictions, 'cacheEvictions'),
          ticketsAvailableRead: tickets.read,
          ticketsAvailableWrite: tickets.write,
          cursorsOpen: safeNum(status.metrics?.cursor?.open?.total),
          cursorsTimedOutRate: rate(counters.cursorsTimedOut, 'cursorsTimedOut'),
          assertsRate: rate(counters.asserts, 'asserts'),
          keysExaminedRate,
          docsExaminedRate,
          docsReturnedRate,
          // Documents read per document delivered. 1 is a perfectly targeted
          // query; large values mean the planner is scanning to find matches.
          scanRatio: docsReturnedRate > 0 ? docsExaminedRate / docsReturnedRate : undefined,
          scanAndOrderRate: rate(counters.scanAndOrder, 'scanAndOrder'),
          oplogWindowSeconds,
          replicationLagMs,
        },
      },
      topology,
      ...(censusDue ? { collections: await runCensus(client, uri) } : {}),
      ...(probeDue ? { capabilities: await probeCapabilities(client, uri) } : {}),
    };
  },

  async dispose(dbId: string): Promise<void> {
    const client = pool.get(dbId);
    if (client) {
      await client.close(true).catch(() => {});
      pool.delete(dbId);
    }
    clearPrevious(dbId);
    clearInsightBaseline(dbId);
  },

  collectInsights: (ctx: InsightContext) => collectMongoInsights(ctx),
  collectIndexes: (ctx: InsightContext) => collectMongoIndexes(ctx),
  getCurrentOperations: (dbId: string, uri: string) => getMongoCurrentOperations(dbId, uri),
};

// ---------------------------------------------------------------------------
// Query insights.
//
// Two sources, in preference order:
//   $queryStats    — MongoDB 7.0+, cumulative per shape, so it needs a baseline.
//   system.profile — a capped collection of individual operations. Each entry
//                    is already an event inside the window, so the interval
//                    aggregation is exact and needs no baseline at all.
//
// Senzor never enables the profiler. Turning it on writes to the customer's
// database and adds overhead to their workload; that is their decision, and the
// capability probe explains how to make it.
// ---------------------------------------------------------------------------

const SLOW_OP_LIMIT = 50;
const PROFILE_SCAN_LIMIT = 2000;

const readQueryStats = async (
  client: MongoClient,
  dbId: string,
  maxDigests: number
): Promise<QueryStatSample[]> => {
  const rows = await client
    .db('admin')
    .aggregate([{ $queryStats: {} }], { allowDiskUse: false })
    .limit(1000)
    .toArray();

  if (rows.length === 0) return [];

  const baseline = getInsightBaseline(dbId);
  const nextBaseline = new Map<string, DigestCounters>();
  const stats: QueryStatSample[] = [];

  for (const row of rows as any[]) {
    const shape = row.key?.queryShape || row.key || {};
    const namespace = shape.cmdNs ? `${shape.cmdNs.db}.${shape.cmdNs.coll}` : undefined;
    const queryText = redactMongoCommand(shape);
    const digest = String(row.key?.queryShapeHash || digestOf(queryText));

    const metrics = row.metrics || {};
    const current: DigestCounters = {
      executions: safeNum(metrics.execCount),
      totalTimeMs: safeNum(metrics.totalExecMicros?.sum) / 1000,
      rowsReturned: safeNum(metrics.docsReturned?.sum),
      rowsExamined: safeNum(metrics.docsExamined?.sum),
    };
    nextBaseline.set(digest, current);

    const prior = baseline?.digests.get(digest);
    if (!prior || current.executions < prior.executions) continue;

    const executions = current.executions - prior.executions;
    if (executions <= 0) continue;

    const totalTimeMs = Math.max(0, current.totalTimeMs - prior.totalTimeMs);
    const rowsReturned = Math.max(0, (current.rowsReturned || 0) - (prior.rowsReturned || 0));
    const rowsExamined = Math.max(0, (current.rowsExamined || 0) - (prior.rowsExamined || 0));

    stats.push({
      digestHash: digest,
      queryText,
      namespace,
      operation: classifyOperation(shape.command || Object.keys(shape)[0]),
      executions,
      totalTimeMs,
      meanTimeMs: totalTimeMs / executions,
      maxTimeMs: safeNum(metrics.totalExecMicros?.max) / 1000,
      rowsReturned,
      rowsExamined,
      examinedPerReturned: rowsReturned > 0 ? rowsExamined / rowsReturned : undefined,
    });
  }

  setInsightBaseline(dbId, nextBaseline);
  stats.sort((a, b) => b.totalTimeMs - a.totalTimeMs);
  return stats.slice(0, maxDigests);
};

/**
 * Reads profiler entries recorded since the previous collection and folds them
 * into per-shape totals for that window, plus the individual slow operations.
 */
const readProfileEntries = async (
  client: MongoClient,
  uri: string,
  since: Date,
  slowMsThreshold: number,
  maxDigests: number
): Promise<InsightSample> => {
  // The profiler is per-database, and system.profile only exists where it has
  // been enabled. Reading through the driver default would look at `test` on a
  // cluster-scoped connection and always come back empty.
  const scope = await resolveScope(client, uri);
  const entries: any[] = [];

  for (const dbName of scope) {
    if (entries.length >= PROFILE_SCAN_LIMIT) break;
    try {
      const rows = await client
        .db(dbName)
        .collection('system.profile')
        .find({ ts: { $gt: since } })
        .sort({ ts: -1 })
        .limit(PROFILE_SCAN_LIMIT - entries.length)
        .toArray();
      entries.push(...rows);
    } catch {
      // Profiling not enabled on this database, or not readable — skip it.
    }
  }

  if (entries.length === 0) return { queryStats: [], slowOps: [] };

  const shapes = new Map<string, QueryStatSample>();
  const slowOps: SlowOpSample[] = [];

  for (const entry of entries as any[]) {
    // Skip our own reads of the profile collection — counting them would make
    // Senzor its own top query.
    const ns = String(entry.ns || '');
    if (ns.endsWith('.system.profile')) continue;

    const durationMs = safeNum(entry.millis);
    const queryText = redactMongoCommand(entry);
    const digest = digestOf(`${ns}|${queryText}`);
    const operation = classifyOperation(entry.op);

    const existing = shapes.get(digest);
    if (existing) {
      existing.executions += 1;
      existing.totalTimeMs += durationMs;
      existing.maxTimeMs = Math.max(existing.maxTimeMs, durationMs);
      existing.rowsExamined = (existing.rowsExamined || 0) + safeNum(entry.docsExamined);
      existing.rowsReturned = (existing.rowsReturned || 0) + safeNum(entry.nreturned);
    } else {
      shapes.set(digest, {
        digestHash: digest,
        queryText,
        namespace: ns || undefined,
        operation,
        executions: 1,
        totalTimeMs: durationMs,
        meanTimeMs: durationMs,
        maxTimeMs: durationMs,
        rowsExamined: safeNum(entry.docsExamined),
        rowsReturned: safeNum(entry.nreturned),
        planSummary: entry.planSummary || undefined,
      });
    }

    if (durationMs >= slowMsThreshold && slowOps.length < SLOW_OP_LIMIT) {
      slowOps.push({
        timestamp: entry.ts instanceof Date ? entry.ts : new Date(),
        durationMs,
        operation,
        namespace: ns || undefined,
        queryText,
        digestHash: digest,
        planSummary: entry.planSummary || undefined,
        docsExamined: safeNum(entry.docsExamined),
        docsReturned: safeNum(entry.nreturned),
        keysExamined: safeNum(entry.keysExamined),
        source: entry.appName || undefined,
      });
    }
  }

  const queryStats = [...shapes.values()]
    .map((s) => ({
      ...s,
      meanTimeMs: s.totalTimeMs / s.executions,
      examinedPerReturned:
        (s.rowsReturned || 0) > 0 ? (s.rowsExamined || 0) / (s.rowsReturned as number) : undefined,
    }))
    .sort((a, b) => b.totalTimeMs - a.totalTimeMs)
    .slice(0, maxDigests);

  return { queryStats, slowOps };
};

export const collectMongoInsights = async (
  { dbId, uri, maxDigests, slowMsThreshold }: InsightContext
): Promise<InsightSample> => {
  const client = await connect(dbId, uri);

  // $queryStats covers the whole workload, not just what crossed the profiler
  // threshold, so it is preferred wherever the server offers it.
  try {
    const queryStats = await readQueryStats(client, dbId, maxDigests);
    if (queryStats.length > 0) return { queryStats, slowOps: [] };
  } catch {
    // Not available on this version, or not permitted — fall through.
  }

  const baseline = getInsightBaseline(dbId);
  const since = baseline ? new Date(baseline.at) : new Date(Date.now() - 5 * 60 * 1000);

  try {
    const sample = await readProfileEntries(client, uri, since, slowMsThreshold, maxDigests);
    // The profile path aggregates events directly, so the baseline serves only
    // as a watermark. An empty digest map keeps `at` moving forward.
    setInsightBaseline(dbId, new Map());
    return sample;
  } catch {
    return { queryStats: [], slowOps: [] };
  }
};

// ---------------------------------------------------------------------------
// Index census.
//
// MongoDB splits this across three commands, none of which alone is enough:
//   listIndexes  — the key specification, uniqueness, partial filters
//   $indexStats  — accesses.ops, the usage counter
//   collStats    — indexSizes, keyed by index name
//
// Collections are capped and processed in batches: a database with thousands of
// collections must not turn an hourly census into thousands of concurrent
// commands against the instance we are meant to be observing quietly.
// ---------------------------------------------------------------------------

const INDEX_CENSUS_COLLECTIONS = 50;
const INDEX_CENSUS_BATCH = 10;

export const collectMongoIndexes = async (
  { dbId, uri }: InsightContext
): Promise<IndexCensus> => {
  const client = await connect(dbId, uri);

  const [status, scope] = await Promise.all([
    client.db('admin').command({ serverStatus: 1 }).catch(() => ({ uptime: 0 })),
    resolveScope(client, uri),
  ]);

  // (database, collection) pairs across the scope, bounded overall so a
  // cluster-scoped connection cannot fan out without limit.
  const targets: { dbName: string; name: string }[] = [];
  for (const dbName of scope) {
    if (targets.length >= INDEX_CENSUS_COLLECTIONS) break;
    try {
      const collections = await client.db(dbName).listCollections({}, { nameOnly: true }).toArray();
      for (const c of collections) {
        if (targets.length >= INDEX_CENSUS_COLLECTIONS) break;
        targets.push({ dbName, name: String((c as any).name) });
      }
    } catch {
      // Not readable with these privileges — skip this database.
    }
  }

  const indexes: IndexSample[] = [];

  for (let i = 0; i < targets.length; i += INDEX_CENSUS_BATCH) {
    const batch = targets.slice(i, i + INDEX_CENSUS_BATCH).map(async ({ dbName, name }) => {
      try {
        const target = client.db(dbName);
        const collection = target.collection(name);
        const [definitions, usage, stats] = await Promise.all([
          collection.listIndexes().toArray(),
          collection.aggregate([{ $indexStats: {} }]).toArray().catch(() => [] as any[]),
          target.command({ collStats: name }).catch(() => ({} as any)),
        ]);

        const opsByName = new Map<string, number>(
          (usage as any[]).map((u) => [String(u.name), safeNum(u.accesses?.ops)])
        );
        const sizeByName: Record<string, number> = (stats as any).indexSizes || {};

        return (definitions as any[]).map((def) => {
          const keys = Object.keys(def.key || {});
          return {
            namespace: `${dbName}.${name}`,
            name: String(def.name),
            definition: JSON.stringify(def.key || {}),
            keys,
            unique: !!def.unique,
            primary: def.name === '_id_',
            partial: !!def.partialFilterExpression,
            sizeBytes: safeNum(sizeByName[def.name]),
            scans: opsByName.get(String(def.name)) ?? 0,
          } as IndexSample;
        });
      } catch {
        return [] as IndexSample[];
      }
    });

    for (const result of await Promise.all(batch)) indexes.push(...result);
  }

  return { indexes, serverUptimeSeconds: safeNum((status as any).uptime) };
};

// ---------------------------------------------------------------------------
// Topology & live operations.
// ---------------------------------------------------------------------------

const readTopology = async (client: MongoClient): Promise<TopologySnapshot | undefined> => {
  try {
    const status: any = await client.db('admin').command({ replSetGetStatus: 1 });
    const members: any[] = status.members || [];
    const primary = members.find((m) => m.stateStr === 'PRIMARY');
    const primaryMs = primary?.optimeDate ? new Date(primary.optimeDate).getTime() : undefined;

    return {
      kind: 'replicaset',
      isReplica: status.myState !== 1, // 1 = PRIMARY
      members: members.map((m) => ({
        name: String(m.name),
        role: String(m.stateStr || 'UNKNOWN'),
        state: String(m.stateStr || 'UNKNOWN'),
        // health 1 = reachable; an ARBITER has no data but is still healthy.
        healthy: m.health === 1,
        lagMs:
          primaryMs && m.optimeDate && m.stateStr === 'SECONDARY'
            ? Math.max(0, primaryMs - new Date(m.optimeDate).getTime())
            : m.stateStr === 'PRIMARY' ? 0 : undefined,
        self: !!m.self,
      })),
    };
  } catch (err: any) {
    // Standalone deployments are not a failure — they simply have no topology.
    if (isStandalone(err)) return { kind: 'standalone', isReplica: false, members: [] };
    return undefined;
  }
};

export const getMongoCurrentOperations = async (
  dbId: string,
  uri: string
): Promise<CurrentOperation[]> => {
  const client = await connect(dbId, uri);
  const rows = await client
    .db('admin')
    .aggregate([
      { $currentOp: { allUsers: true, idleConnections: false } },
      { $match: { active: true, 'command.$currentOp': { $exists: false } } },
    ])
    .limit(100)
    .toArray();

  return (rows as any[])
    .map((op) => ({
      id: String(op.opid ?? op.connectionId ?? ''),
      durationMs: safeNum(op.microsecs_running) / 1000 || safeNum(op.secs_running) * 1000,
      operation: String(op.op || 'command'),
      namespace: op.ns ? String(op.ns) : undefined,
      queryText: redactMongoCommand(op),
      state: op.waitingForLock ? 'waiting for lock' : 'running',
      waitingOn: op.waitingForLatch?.type ? String(op.waitingForLatch.type) : undefined,
      source: op.appName || op.clientMetadata?.application?.name || undefined,
    }))
    .sort((a, b) => b.durationMs - a.durationMs);
};
