import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { QueueAdapter, QueueSample, SampleOpts, SampleResult, TestResult } from './types';

// ============================================================================
// BullMQ adapter.
// ----------------------------------------------------------------------------
// Depth, consumer count, and pause state come from BullMQ's OFFICIAL Queue API
// (getJobCounts / getWorkersCount / isPaused) rather than hand-rolled Redis
// commands. This guarantees correctness across BullMQ versions and across the
// many ways workers name their connections (named workers use a `<name>:w:…`
// suffix that a naive CLIENT LIST match would miss).
//
// Prefix resolution is forgiving: BullMQ's documented Redis-Cluster pattern puts
// a hash tag in the prefix (e.g. `{bull}`), so a source registered with the
// default `bull` would otherwise silently observe zero queues. We try the
// configured prefix, then its hash-tagged form, then the common defaults, and
// report back the one that actually matched so the source can self-correct.
//
// Connection: a single ioredis socket is pooled per source. Passing it to
// `new Queue(name, { connection })` makes BullMQ treat it as SHARED, so
// queue.close() never disconnects our pooled socket.
//
// Config: { uri, prefix }
// ============================================================================

const SCAN_COUNT = 200;
const MAX_SCAN_ITERATIONS = 2000;
const META_SUFFIX = ':meta';

interface BullmqConfig { uri: string; prefix?: string; }
interface PoolEntry { client: Redis; uri: string; }

const pool = new Map<string, PoolEntry>();

const buildClient = (uri: string): Redis => {
  const client = new Redis(uri, {
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    commandTimeout: 5000,
    enableReadyCheck: true,
    lazyConnect: true,
    retryStrategy: () => null
  });
  client.on('error', () => {});
  return client;
};

const getPooled = async (sourceId: string, uri: string): Promise<Redis> => {
  const existing = pool.get(sourceId);
  if (existing && existing.uri === uri && existing.client.status !== 'end') return existing.client;
  if (existing) { existing.client.disconnect(); pool.delete(sourceId); }
  const client = buildClient(uri);
  await client.connect();
  pool.set(sourceId, { client, uri });
  return client;
};

const readVersion = async (redis: Redis): Promise<string | undefined> => {
  try {
    const info = await redis.info('server');
    return info.split('\n').find(l => l.startsWith('redis_version:'))?.split(':')[1]?.trim();
  } catch { return undefined; }
};

/** Scan for keys matching a glob pattern, bounded by a cap + iteration ceiling. */
const scanKeys = async (redis: Redis, pattern: string, cap: number): Promise<{ keys: string[]; truncated: boolean }> => {
  const keys: string[] = [];
  let cursor = '0';
  let iterations = 0;
  let truncated = false;
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
    cursor = next;
    iterations++;
    for (const k of batch) {
      keys.push(k);
      if (keys.length >= cap) { truncated = true; break; }
    }
    if (keys.length >= cap || iterations >= MAX_SCAN_ITERATIONS) {
      if (cursor !== '0') truncated = true;
      break;
    }
  } while (cursor !== '0');
  return { keys, truncated };
};

const namesFromMeta = (keys: string[], prefix: string): string[] => {
  const head = `${prefix}:`;
  return keys
    .filter(k => k.startsWith(head) && k.endsWith(META_SUFFIX))
    .map(k => k.slice(head.length, k.length - META_SUFFIX.length))
    .filter(Boolean);
};

/**
 * Resolve the effective prefix + queue names. Tries the configured prefix, then
 * its hash-tagged variant, then the common BullMQ defaults — the first that
 * yields any queue wins. Returns `truncated` if the queue cap was hit.
 */
const resolveQueues = async (
  redis: Redis,
  configuredPrefix: string,
  maxQueues: number
): Promise<{ prefix: string; names: string[]; truncated: boolean }> => {
  const wrapped = `{${configuredPrefix.replace(/^\{|\}$/g, '')}}`;
  const candidates = Array.from(new Set([configuredPrefix, wrapped, 'bull', '{bull}']));

  for (const prefix of candidates) {
    const { keys, truncated } = await scanKeys(redis, `${prefix}:*${META_SUFFIX}`, maxQueues);
    const names = namesFromMeta(keys, prefix);
    if (names.length > 0) return { prefix, names: names.slice(0, maxQueues), truncated };
  }
  return { prefix: configuredPrefix, names: [], truncated: false };
};

/** Best-effort oldest-job age (ms) for a list key whose tail is the next job. */
const oldestAgeFromList = async (redis: Redis, listKey: string, base: string, now: number): Promise<number> => {
  try {
    const headId = await redis.lindex(listKey, -1);
    if (!headId) return 0;
    const ts = Number(await redis.hget(`${base}:${headId}`, 'timestamp'));
    return Number.isFinite(ts) && ts > 0 ? Math.max(0, now - ts) : 0;
  } catch { return 0; }
};

const sampleQueues = async (redis: Redis, prefix: string, names: string[]): Promise<QueueSample[]> => {
  const samples: QueueSample[] = [];
  const now = Date.now();

  for (const queueName of names) {
    let queue: Queue | undefined;
    try {
      const base = `${prefix}:${queueName}`;
      queue = new Queue(queueName, { connection: redis as any, prefix });

      const [counts, isPaused, consumerCount, oldestWaitingAgeMs, idVal] = await Promise.all([
        queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized', 'waiting-children', 'paused', 'failed', 'completed'),
        queue.isPaused().catch(() => false),
        queue.getWorkersCount().catch(() => 0),
        oldestAgeFromList(redis, `${base}:wait`, base, now),
        redis.get(`${base}:id`).catch(() => null)
      ]);

      const c = (k: string) => Number((counts as any)[k]) || 0;
      const waiting = c('waiting');
      const active = c('active');
      const delayed = c('delayed');
      const prioritized = c('prioritized');
      const waitingChildren = c('waiting-children');
      const paused = c('paused');
      const failed = c('failed');
      const completed = c('completed');

      const idNum = Number(idVal);

      samples.push({
        queueName,
        depth: { waiting, active, delayed, prioritized, waitingChildren, paused },
        pending: waiting + delayed + prioritized + waitingChildren + paused,
        dlqDepth: failed,
        completed,
        oldestWaitingAgeMs,
        oldestDelayedAgeMs: 0,
        consumerCount,
        isPaused,
        // Cumulative jobs ever produced (BullMQ's per-queue id counter). The
        // poller turns its delta into incoming rate, then derives processed/sec.
        incomingTotal: Number.isFinite(idNum) ? idNum : undefined
      });
    } catch {
      continue;
    } finally {
      if (queue) await queue.close().catch(() => {});
    }
  }

  return samples;
};

export const bullmqAdapter: QueueAdapter = {
  system: 'bullmq',

  async testConnection(config: BullmqConfig): Promise<TestResult> {
    const client = buildClient(config.uri);
    try {
      await client.connect();
      await client.ping();
      const version = await readVersion(client);
      const { prefix, names, truncated } = await resolveQueues(client, config.prefix || 'bull', 250);
      return { version, discoveredQueues: names.length, truncated, effectivePrefix: prefix };
    } finally {
      client.disconnect();
    }
  },

  async sample(sourceId: string, config: BullmqConfig, opts: SampleOpts): Promise<SampleResult> {
    const client = await getPooled(sourceId, config.uri);

    let prefix = config.prefix || 'bull';
    let names: string[];
    let truncated = false;

    if (opts.queueFilter.length > 0) {
      names = opts.queueFilter.slice(0, opts.maxQueues);
      truncated = opts.queueFilter.length > opts.maxQueues;
    } else {
      const resolved = await resolveQueues(client, prefix, opts.maxQueues);
      prefix = resolved.prefix;
      names = resolved.names;
      truncated = resolved.truncated;
    }

    const samples = await sampleQueues(client, prefix, names);
    const version = await readVersion(client);
    return { samples, discovered: names.length, truncated, version };
  },

  dispose(sourceId: string) {
    const entry = pool.get(sourceId);
    if (entry) {
      entry.client.disconnect();
      pool.delete(sourceId);
    }
  }
};
