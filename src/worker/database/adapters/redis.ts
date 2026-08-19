import Redis from 'ioredis';
import type {
  DbAdapter, DbSample, Capabilities, SampleContext, CollectionStat,
  InsightContext, InsightSample, QueryStatSample, SlowOpSample,
  TopologySnapshot, CurrentOperation,
} from './types';
import { capable, incapable, safeNum, perSecond, toMb } from './types';
import {
  getPrevious, setPrevious, clearPrevious, elapsedSeconds,
  getInsightBaseline, setInsightBaseline, clearInsightBaseline, type DigestCounters,
} from '../state';
import { redactRedisCommand, digestOf, classifyOperation } from '../redact';

// ============================================================================
// Redis adapter.
// ----------------------------------------------------------------------------
// Everything here is derived from INFO, which is O(1) and safe to call on a
// production instance every cycle. Nothing scans the keyspace.
// ============================================================================

const pool = new Map<string, Redis>();

/** Redis reports the same INFO block whether or not the field applies. */
const parseInfo = (raw: string): Record<string, string> => {
  const info: Record<string, string> = {};
  for (const line of raw.split('\r\n')) {
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    info[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return info;
};

const connect = (dbId: string, uri: string): Redis => {
  let client = pool.get(dbId);
  if (!client || client.status === 'end') {
    client = new Redis(uri, { maxRetriesPerRequest: 1, commandTimeout: 5000 });
    // ioredis emits on a dead socket; without a listener this becomes an
    // unhandled 'error' event and takes the worker process down.
    client.on('error', () => {});
    pool.set(dbId, client);
  }
  return client;
};

interface RedisCounters {
  commands: number;
  netIn: number;
  netOut: number;
  hits: number;
  misses: number;
  evicted: number;
  expired: number;
  errors: number;
  rejected: number;
}

const readCounters = (info: Record<string, string>): RedisCounters => ({
  commands: safeNum(info.total_commands_processed),
  netIn: safeNum(info.total_net_input_bytes),
  netOut: safeNum(info.total_net_output_bytes),
  hits: safeNum(info.keyspace_hits),
  misses: safeNum(info.keyspace_misses),
  evicted: safeNum(info.evicted_keys),
  expired: safeNum(info.expired_keys),
  errors: safeNum(info.total_error_replies),
  rejected: safeNum(info.rejected_connections),
});

/** Total keys across every logical database. */
const totalKeys = (info: Record<string, string>): number =>
  Object.keys(info)
    .filter((k) => /^dbd+$/.test(k))
    .reduce((sum, k) => sum + safeNum(info[k].split(',')[0]?.split('=')[1]), 0);

/** INFO keyspace exposes db0/db1/... — mapped onto the census table. */
const keyspaceCensus = (info: Record<string, string>): CollectionStat[] => {
  const rows: CollectionStat[] = [];
  for (const key of Object.keys(info)) {
    if (!/^db\d+$/.test(key)) continue;
    const parts = info[key].split(',');
    const keys = safeNum(parts[0]?.split('=')[1]);
    const expires = safeNum(parts[1]?.split('=')[1]);
    rows.push({
      name: key,
      count: keys,
      size: 0,          // not obtainable without scanning the keyspace
      storageSize: 0,
      indexSize: expires, // volatile keys, surfaced in the census "expiring" column
    });
  }
  return rows;
};

/**
 * Capability probe. Managed providers routinely block CONFIG and the admin
 * subset, so each optional source is attempted once and its failure recorded
 * with the grant that would fix it.
 */
const probeCapabilities = async (client: Redis): Promise<Capabilities> => {
  const caps: Capabilities = {
    serverStats: capable(),
    collectionStats: capable(),
    replication: capable(),
    // Redis has no secondary indexes or planner, so these keys are omitted
    // rather than reported unavailable — see Capabilities in ./types.
  };

  const [commandstats, slowlog, clients] = await Promise.all([
    client.info('commandstats').then(() => true).catch(() => false),
    client.slowlog('GET', 1).then(() => true).catch(() => false),
    client.client('LIST').then(() => true).catch(() => false),
  ]);

  caps.queryStats = commandstats
    ? capable()
    : incapable(
        'INFO commandstats is not permitted for this user.',
        'Grant the monitored user access to INFO, or use a role that includes the "admin" command category.'
      );

  caps.slowLog = slowlog
    ? capable()
    : incapable(
        'SLOWLOG is not permitted for this user.',
        'Grant +slowlog to the monitored user (ACL SETUSER <user> +slowlog).'
      );

  caps.currentOps = clients
    ? capable()
    : incapable(
        'CLIENT LIST is not permitted for this user.',
        'Grant +client|list to the monitored user.'
      );

  return caps;
};

export const redisAdapter: DbAdapter = {
  type: 'redis',

  async probe(uri: string): Promise<Capabilities> {
    const client = new Redis(uri, { maxRetriesPerRequest: 1, commandTimeout: 5000, lazyConnect: true });
    client.on('error', () => {});
    try {
      await client.connect();
      await client.ping();
      return await probeCapabilities(client);
    } finally {
      client.disconnect();
    }
  },

  async sample({ dbId, uri, censusDue, probeDue }: SampleContext): Promise<DbSample> {
    const client = connect(dbId, uri);

    const pingStart = performance.now();
    await client.ping();
    const pingLatency = performance.now() - pingStart;

    // CONFIG is commonly blocked on managed Redis; INFO already carries
    // maxclients on modern servers, so the CONFIG call is only a fallback.
    const [infoRaw, configRes] = await Promise.all([
      client.info('all'),
      client.config('GET', 'maxclients').catch(() => null),
    ]);

    const info = parseInfo(infoRaw);

    let maxClients = safeNum(info.maxclients);
    if (!maxClients && configRes) {
      if (Array.isArray(configRes) && configRes.length >= 2) maxClients = safeNum(configRes[1]);
      else if (typeof configRes === 'object') maxClients = safeNum((configRes as any).maxclients);
    }
    if (!maxClients) maxClients = 10000; // universal Redis default

    const now = Date.now();
    const previous = getPrevious<RedisCounters>(dbId);
    const seconds = elapsedSeconds(previous, now);
    const counters = readCounters(info);

    const rate = (current: number, key: keyof RedisCounters) =>
      previous ? perSecond(current, previous.counters[key], seconds) : 0;

    const hitsRate = rate(counters.hits, 'hits');
    const missesRate = rate(counters.misses, 'misses');
    const lookups = hitsRate + missesRate;

    const commandsRate = rate(counters.commands, 'commands');

    const usedMemory = safeNum(info.used_memory);
    const maxMemory = safeNum(info.maxmemory);
    const currentClients = safeNum(info.connected_clients);
    const isReplica = (info.role || '').toLowerCase() === 'slave';

    setPrevious(dbId, counters, previous?.lastCensusAt ?? now);

    const sample: DbSample = {
      version: info.redis_version || undefined,
      metric: {
        throughput: { read: 0, write: 0, total: commandsRate },
        latency: { read: { avg: 0, max: 0 }, write: { avg: 0, max: 0 }, ping: pingLatency },
        uptimeSeconds: safeNum(info.uptime_in_seconds),
        connections: {
          current: currentClients,
          available: Math.max(0, maxClients - currentClients),
          totalCreated: safeNum(info.total_connections_received),
        },
        memory: {
          resident: toMb(info.used_memory_rss),
          virtual: toMb(usedMemory),
          mapped: 0,
        },
        network: {
          bytesIn: rate(counters.netIn, 'netIn'),
          bytesOut: rate(counters.netOut, 'netOut'),
          numRequests: commandsRate,
        },
        ops: { insert: 0, query: 0, update: 0, delete: 0, command: 0 },
        scans: { collectionScans: 0, indexScans: 0 },
        storage: { dataSize: 0, indexSize: 0, storageSize: 0, objects: totalKeys(info) },
        redis: {
          keyspaceHits: hitsRate,
          keyspaceMisses: missesRate,
          hitRate: lookups > 0 ? (hitsRate / lookups) * 100 : 0,
          evictedKeys: rate(counters.evicted, 'evicted'),
          expiredKeys: rate(counters.expired, 'expired'),
          usedMemoryPeak: toMb(info.used_memory_peak),
          fragmentationRatio: safeNum(info.mem_fragmentation_ratio),
          blockedClients: safeNum(info.blocked_clients),
          memDatasetMb: toMb(info.used_memory_dataset),
          memOverheadMb: toMb(info.used_memory_overhead),
          memClientsMb: toMb(info.mem_clients_normal),
          // -1 distinguishes "no bound configured" from "0% of a bound used".
          memoryUsedPercent: maxMemory > 0 ? (usedMemory / maxMemory) * 100 : -1,
          rdbChangesSinceSave: safeNum(info.rdb_changes_since_last_save),
          rdbLastBgsaveOk: info.rdb_last_bgsave_status === 'ok' ? 1 : 0,
          aofLastWriteOk: info.aof_last_write_status ? (info.aof_last_write_status === 'ok' ? 1 : 0) : 1,
          connectedReplicas: safeNum(info.connected_slaves),
          masterLinkUp: isReplica ? (info.master_link_status === 'up' ? 1 : 0) : 1,
          masterReplOffsetLagBytes: isReplica
            ? Math.max(0, safeNum(info.master_repl_offset) - safeNum(info.slave_repl_offset))
            : 0,
          pubsubChannels: safeNum(info.pubsub_channels),
          commandsFailedRate: rate(counters.errors, 'errors'),
          commandsRejectedRate: rate(counters.rejected, 'rejected'),
        },
      },
      topology: readTopology(info),
      ...(censusDue ? { collections: keyspaceCensus(info) } : {}),
      ...(probeDue ? { capabilities: await probeCapabilities(client) } : {}),
    };

    return sample;
  },

  dispose(dbId: string): void {
    const client = pool.get(dbId);
    if (client) {
      client.disconnect();
      pool.delete(dbId);
    }
    clearPrevious(dbId);
    clearInsightBaseline(dbId);
  },

  collectInsights: (ctx: InsightContext) => collectRedisInsights(ctx),
  getCurrentOperations: (dbId: string, uri: string) => getRedisCurrentOperations(dbId, uri),
};

/** Exposed so the scheduler can tear down a failed connection before retrying. */
export const dropRedisConnection = (dbId: string): void => {
  const client = pool.get(dbId);
  if (client) {
    client.disconnect();
    pool.delete(dbId);
  }
};

// ---------------------------------------------------------------------------
// Query insights.
//
// Redis has no query planner, so "shapes" here are commands: INFO commandstats
// gives cumulative calls and microseconds per command, and SLOWLOG gives the
// individual operations that crossed the server's own threshold.
//
// SLOWLOG entries carry the full argument vector, which is raw customer data —
// keys, values, and on a misconfigured server, credentials. Everything is
// reduced to verb plus key namespace before it leaves this function.
// ---------------------------------------------------------------------------

const SLOWLOG_FETCH = 128;

/** `cmdstat_get:calls=100,usec=500,usec_per_call=5.00,rejected_calls=0,failed_calls=0` */
const parseCommandStats = (raw: string): Map<string, { calls: number; usec: number }> => {
  const out = new Map<string, { calls: number; usec: number }>();
  for (const line of raw.split('\r\n')) {
    if (!line.startsWith('cmdstat_')) continue;
    const [name, body] = line.split(':');
    if (!name || !body) continue;
    const fields: Record<string, string> = {};
    for (const pair of body.split(',')) {
      const [k, v] = pair.split('=');
      if (k && v) fields[k] = v;
    }
    out.set(name.replace('cmdstat_', '').toUpperCase(), {
      calls: safeNum(fields.calls),
      usec: safeNum(fields.usec),
    });
  }
  return out;
};

export const collectRedisInsights = async (
  { dbId, uri, maxDigests, slowMsThreshold }: InsightContext
): Promise<InsightSample> => {
  const client = connect(dbId, uri);

  const [commandStatsRaw, slowlogRaw] = await Promise.all([
    client.info('commandstats').catch(() => ''),
    client.slowlog('GET', SLOWLOG_FETCH).catch(() => [] as any),
  ]);

  // --- Slow operations -----------------------------------------------------
  const slowOps: SlowOpSample[] = [];
  if (Array.isArray(slowlogRaw)) {
    for (const entry of slowlogRaw as any[]) {
      // [id, unixSeconds, durationMicros, args[], clientAddr, clientName]
      if (!Array.isArray(entry) || entry.length < 4) continue;
      const durationMs = safeNum(entry[2]) / 1000;
      if (durationMs < slowMsThreshold) continue;

      const args = Array.isArray(entry[3]) ? entry[3].map(String) : [];
      const queryText = redactRedisCommand(args);
      slowOps.push({
        timestamp: new Date(safeNum(entry[1]) * 1000),
        durationMs,
        operation: classifyOperation(args[0]),
        queryText,
        digestHash: digestOf(queryText),
        // The client name is operator-assigned; the address is not recorded.
        source: entry[5] ? String(entry[5]) : undefined,
      });
    }
  }

  // --- Per-command cost ----------------------------------------------------
  const current = parseCommandStats(commandStatsRaw);
  if (current.size === 0) return { queryStats: [], slowOps };

  const baseline = getInsightBaseline(dbId);
  const nextBaseline = new Map<string, DigestCounters>();
  const stats: QueryStatSample[] = [];

  for (const [command, value] of current) {
    const counters: DigestCounters = { executions: value.calls, totalTimeMs: value.usec / 1000 };
    nextBaseline.set(command, counters);

    const prior = baseline?.digests.get(command);
    // CONFIG RESETSTAT zeroes these counters; a decrease means the baseline is
    // meaningless rather than the workload being negative.
    if (!prior || counters.executions < prior.executions) continue;

    const executions = counters.executions - prior.executions;
    if (executions <= 0) continue;

    const totalTimeMs = Math.max(0, counters.totalTimeMs - prior.totalTimeMs);
    stats.push({
      digestHash: command,
      queryText: command,
      operation: classifyOperation(command),
      executions,
      totalTimeMs,
      meanTimeMs: totalTimeMs / executions,
      // Redis reports no per-command maximum, only the running total, so the
      // mean is the honest ceiling to show rather than inventing a peak.
      maxTimeMs: totalTimeMs / executions,
    });
  }

  setInsightBaseline(dbId, nextBaseline);
  stats.sort((a, b) => b.totalTimeMs - a.totalTimeMs);
  return { queryStats: stats.slice(0, maxDigests), slowOps };
};

// ---------------------------------------------------------------------------
// Topology & live operations.
// ---------------------------------------------------------------------------

/** `slave0:ip=10.0.0.2,port=6379,state=online,offset=1234,lag=0` */
const parseReplicaLine = (value: string) => {
  const fields: Record<string, string> = {};
  for (const pair of value.split(',')) {
    const [k, v] = pair.split('=');
    if (k && v) fields[k] = v;
  }
  return fields;
};

const readTopology = (info: Record<string, string>): TopologySnapshot => {
  const role = (info.role || 'master').toLowerCase();
  const isReplica = role === 'slave';

  if (isReplica) {
    return {
      kind: 'primary-replica',
      isReplica: true,
      members: [
        {
          name: `${info.master_host || 'primary'}:${info.master_port || ''}`,
          role: 'primary',
          state: info.master_link_status || 'unknown',
          healthy: info.master_link_status === 'up',
        },
        {
          name: 'this replica',
          role: 'replica',
          state: 'online',
          healthy: true,
          lagBytes: Math.max(0, safeNum(info.master_repl_offset) - safeNum(info.slave_repl_offset)),
          self: true,
        },
      ],
    };
  }

  const replicas = Object.keys(info)
    .filter((k) => /^slave\d+$/.test(k))
    .map((k) => {
      const f = parseReplicaLine(info[k]);
      return {
        name: `${f.ip || 'replica'}:${f.port || ''}`,
        role: 'replica',
        state: f.state || 'unknown',
        healthy: f.state === 'online',
        // Redis reports replica lag in seconds on the primary's view.
        lagMs: f.lag !== undefined ? safeNum(f.lag) * 1000 : undefined,
      };
    });

  return {
    kind: info.cluster_enabled === '1' ? 'cluster' : replicas.length > 0 ? 'primary-replica' : 'standalone',
    isReplica: false,
    members: [
      { name: 'this primary', role: 'primary', state: 'online', healthy: true, self: true },
      ...replicas,
    ],
  };
};

export const getRedisCurrentOperations = async (
  dbId: string,
  uri: string
): Promise<CurrentOperation[]> => {
  const client = connect(dbId, uri);
  const raw = await client.client('LIST');
  if (typeof raw !== 'string') return [];

  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const fields: Record<string, string> = {};
      for (const pair of line.split(' ')) {
        const idx = pair.indexOf('=');
        if (idx > 0) fields[pair.slice(0, idx)] = pair.slice(idx + 1);
      }
      const command = fields.cmd || 'unknown';
      return {
        id: fields.id || '',
        // `age` is the connection's lifetime; `idle` is time since its last
        // command. Their difference is the closest thing Redis exposes to
        // "how long has this client been doing something".
        durationMs: Math.max(0, safeNum(fields.age) - safeNum(fields.idle)) * 1000,
        operation: classifyOperation(command),
        // CLIENT LIST reports only the command name, never its arguments, so
        // there is nothing here to redact.
        queryText: command.toUpperCase(),
        state: safeNum(fields.idle) === 0 ? 'active' : 'idle',
        source: fields.name || undefined,
      };
    })
    .filter((op) => op.state === 'active')
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 100);
};
