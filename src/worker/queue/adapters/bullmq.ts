import type Redis from 'ioredis';

// ============================================================================
// BullMQ adapter — samples queue state directly from Redis.
// ----------------------------------------------------------------------------
// We read BullMQ's documented key layout via raw Redis commands rather than
// instantiating bullmq.Queue objects per queue. This is the most efficient and
// lifecycle-safe path: one pipeline per queue, no per-poll object allocation,
// and no ambiguity about who owns the (pooled, source-level) connection.
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
// ============================================================================

const SCAN_COUNT = 200;
const MAX_SCAN_ITERATIONS = 2000; // hard ceiling so a huge keyspace can't stall a poll
export const DEFAULT_MAX_QUEUES = 250;

export interface QueueSample {
  queueName: string;
  depth: {
    waiting: number;
    active: number;
    delayed: number;
    prioritized: number;
    waitingChildren: number;
    paused: number;
  };
  pending: number;
  dlqDepth: number;
  completed: number;
  oldestWaitingAgeMs: number;
  oldestDelayedAgeMs: number;
  consumerCount: number;
  isPaused: boolean;
}

/**
 * Discover BullMQ queues on the instance by scanning for `<prefix>:*:meta`
 * marker keys. Bounded by both an iteration ceiling and `maxQueues` so a large
 * shared Redis can never stall or balloon a poll cycle.
 */
export const discoverQueues = async (
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
        // Flow-producer child meta keys never appear here; a queue name is the
        // segment between the prefix and the ':meta' suffix.
        if (name) found.add(name);
      }
      if (found.size >= maxQueues) {
        truncated = true;
        break;
      }
    }

    if (found.size >= maxQueues || iterations >= MAX_SCAN_ITERATIONS) {
      if (cursor !== '0') truncated = true;
      break;
    }
  } while (cursor !== '0');

  return { names: Array.from(found), truncated };
};

/** Parse CLIENT LIST output into per-queue consumer counts keyed by client name. */
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

/**
 * Sample every (filtered/discovered) queue on a source's Redis instance.
 * Never throws per-queue: a single malformed queue is skipped, not fatal.
 */
export const sampleBullMqSource = async (
  redis: Redis,
  opts: { prefix: string; queueFilter: string[]; maxQueues: number }
): Promise<{ samples: QueueSample[]; discovered: number; truncated: boolean }> => {
  const prefix = opts.prefix || 'bull';

  let names: string[];
  let truncated = false;
  if (opts.queueFilter && opts.queueFilter.length > 0) {
    names = opts.queueFilter.slice(0, opts.maxQueues);
    truncated = opts.queueFilter.length > opts.maxQueues;
  } else {
    const discovery = await discoverQueues(redis, prefix, opts.maxQueues);
    names = discovery.names;
    truncated = discovery.truncated;
  }

  // Consumer counts: one CLIENT LIST for the whole instance. Best-effort —
  // managed Redis may deny the command (NOPERM); degrade to 0 rather than fail.
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
      // Head jobs for oldest-age (next to be processed sits at the tail of wait).
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

      // Oldest ages: fetch the head jobs' enqueue timestamps (bounded — at most
      // two HGETs per queue, only when a head exists).
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
      // Skip a single problematic queue; never abort the whole source.
      continue;
    }
  }

  return { samples, discovered: names.length, truncated };
};
