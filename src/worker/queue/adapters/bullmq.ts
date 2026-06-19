import Redis from 'ioredis';
import { QueueAdapter, QueueSample, SampleOpts, SampleResult, TestResult, emptyDepth } from './types';

// ============================================================================
// BullMQ adapter — samples queue state directly from Redis.
// ----------------------------------------------------------------------------
// We read BullMQ's documented key layout via raw Redis commands rather than
// instantiating bullmq.Queue objects per queue: one pipeline per queue, no
// per-poll object allocation, no connection-lifecycle ambiguity.
//
// BullMQ v5 key layout, prefix default 'bull':
//   <prefix>:<queue>:wait              (LIST)  waiting jobs
//   <prefix>:<queue>:active            (LIST)  jobs being processed
//   <prefix>:<queue>:delayed           (ZSET)  scheduled / backoff
//   <prefix>:<queue>:prioritized       (ZSET)  prioritized waiting
//   <prefix>:<queue>:waiting-children  (ZSET)  parents awaiting children
//   <prefix>:<queue>:paused            (LIST)  waiting jobs while paused
//   <prefix>:<queue>:failed            (ZSET)  exhausted-retry jobs (DLQ)
//   <prefix>:<queue>:completed         (ZSET)  retained completed jobs
//   <prefix>:<queue>:meta              (HASH)  field 'paused' present ⇒ paused
//   <prefix>:<queue>:<jobId>           (HASH)  field 'timestamp' = enqueue time
// Workers set their Redis client name to '<prefix>:<queue>', so CLIENT LIST
// names give the consumer count.
//
// Connection config: { uri, prefix }
// ============================================================================

const SCAN_COUNT = 200;
const MAX_SCAN_ITERATIONS = 2000;

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
  client.on('error', () => {}); // surfaced via command rejections
  return client;
};

const getPooled = async (sourceId: string, uri: string): Promise<Redis> => {
  const existing = pool.get(sourceId);
  if (existing && existing.uri === uri && existing.client.status !== 'end') {
    return existing.client;
  }
  if (existing) {
    existing.client.disconnect();
    pool.delete(sourceId);
  }
  const client = buildClient(uri);
  await client.connect();
  pool.set(sourceId, { client, uri });
  return client;
};

const readVersion = async (redis: Redis): Promise<string | undefined> => {
  try {
    const info = await redis.info('server');
    return info.split('\n').find(l => l.startsWith('redis_version:'))?.split(':')[1]?.trim();
  } catch {
    return undefined;
  }
};

const discoverQueues = async (
  redis: Redis,
  prefix: string,
  maxQueues: number
): Promise<{ names: string[]; truncated: boolean }> => {
  const match = `${prefix}:*:meta`;
  const suffix = ':meta';
  const head = `${prefix}:`;
  const found = new Set<string>();

  let cursor = '0';
  let iterations = 0;
  let truncated = false;

  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', match, 'COUNT', SCAN_COUNT);
    cursor = next;
    iterations++;

    for (const key of keys) {
      if (key.startsWith(head) && key.endsWith(suffix)) {
        const name = key.slice(head.length, key.length - suffix.length);
        if (name) found.add(name);
      }
      if (found.size >= maxQueues) { truncated = true; break; }
    }

    if (found.size >= maxQueues || iterations >= MAX_SCAN_ITERATIONS) {
      if (cursor !== '0') truncated = true;
      break;
    }
  } while (cursor !== '0');

  return { names: Array.from(found), truncated };
};

const parseConsumerCounts = (clientList: string): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const line of clientList.split('\n')) {
    if (!line) continue;
    const nameMatch = line.match(/(?:^| )name=([^ ]*)/);
    const name = nameMatch?.[1];
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
};

const sampleQueues = async (
  redis: Redis,
  prefix: string,
  names: string[]
): Promise<QueueSample[]> => {
  let consumerCounts = new Map<string, number>();
  try {
    const clientList = (await redis.client('LIST')) as string;
    consumerCounts = parseConsumerCounts(clientList);
  } catch {
    consumerCounts = new Map();
  }

  const now = Date.now();
  const samples: QueueSample[] = [];

  for (const queueName of names) {
    try {
      const base = `${prefix}:${queueName}`;
      const pipeline = redis.pipeline();
      pipeline.llen(`${base}:wait`);
      pipeline.llen(`${base}:active`);
      pipeline.zcard(`${base}:delayed`);
      pipeline.zcard(`${base}:prioritized`);
      pipeline.zcard(`${base}:waiting-children`);
      pipeline.llen(`${base}:paused`);
      pipeline.zcard(`${base}:failed`);
      pipeline.zcard(`${base}:completed`);
      pipeline.hexists(`${base}:meta`, 'paused');
      pipeline.lindex(`${base}:wait`, -1);
      pipeline.zrange(`${base}:delayed`, 0, 0);

      const res = await pipeline.exec();
      if (!res) continue;

      const num = (i: number): number => {
        const [err, val] = res[i];
        if (err) return 0;
        const n = Number(val);
        return Number.isFinite(n) ? n : 0;
      };

      const waiting = num(0);
      const active = num(1);
      const delayed = num(2);
      const prioritized = num(3);
      const waitingChildren = num(4);
      const paused = num(5);
      const dlqDepth = num(6);
      const completed = num(7);
      const isPaused = num(8) === 1;
      const waitHeadId = res[9]?.[1] as string | null;
      const delayedHead = res[10]?.[1] as string[] | null;

      const pending = waiting + delayed + prioritized + waitingChildren + paused;

      let oldestWaitingAgeMs = 0;
      let oldestDelayedAgeMs = 0;
      const ageTargets: string[] = [];
      if (waitHeadId) ageTargets.push(waitHeadId);
      const delayedHeadId = delayedHead && delayedHead.length > 0 ? delayedHead[0] : null;
      if (delayedHeadId) ageTargets.push(delayedHeadId);

      if (ageTargets.length > 0) {
        const agePipe = redis.pipeline();
        for (const jobId of ageTargets) agePipe.hget(`${base}:${jobId}`, 'timestamp');
        const ageRes = await agePipe.exec();
        if (ageRes) {
          let idx = 0;
          if (waitHeadId) {
            const ts = Number(ageRes[idx]?.[1]);
            if (Number.isFinite(ts) && ts > 0) oldestWaitingAgeMs = Math.max(0, now - ts);
            idx++;
          }
          if (delayedHeadId) {
            const ts = Number(ageRes[idx]?.[1]);
            if (Number.isFinite(ts) && ts > 0) oldestDelayedAgeMs = Math.max(0, now - ts);
          }
        }
      }

      samples.push({
        queueName,
        depth: { waiting, active, delayed, prioritized, waitingChildren, paused },
        pending,
        dlqDepth,
        completed,
        oldestWaitingAgeMs,
        oldestDelayedAgeMs,
        consumerCount: consumerCounts.get(base) || 0,
        isPaused
      });
    } catch {
      continue;
    }
  }

  return samples;
};

export const bullmqAdapter: QueueAdapter = {
  system: 'bullmq',

  async testConnection(config: BullmqConfig): Promise<TestResult> {
    const prefix = config.prefix || 'bull';
    const client = buildClient(config.uri);
    try {
      await client.connect();
      await client.ping();
      const version = await readVersion(client);
      const { names, truncated } = await discoverQueues(client, prefix, 250);
      return { version, discoveredQueues: names.length, truncated };
    } finally {
      client.disconnect();
    }
  },

  async sample(sourceId: string, config: BullmqConfig, opts: SampleOpts): Promise<SampleResult> {
    const prefix = config.prefix || 'bull';
    const client = await getPooled(sourceId, config.uri);

    let names: string[];
    let truncated = false;
    if (opts.queueFilter.length > 0) {
      names = opts.queueFilter.slice(0, opts.maxQueues);
      truncated = opts.queueFilter.length > opts.maxQueues;
    } else {
      const discovery = await discoverQueues(client, prefix, opts.maxQueues);
      names = discovery.names;
      truncated = discovery.truncated;
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

export { emptyDepth };
