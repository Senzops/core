import { Kafka, Admin, logLevel } from 'kafkajs';
import { QueueAdapter, QueueSample, SampleOpts, SampleResult, TestResult, emptyDepth } from './types';

// ============================================================================
// Kafka adapter — consumer-group lag via the kafkajs Admin API.
// ----------------------------------------------------------------------------
// Kafka has no "queue depth"; the enterprise-meaningful backlog is *consumer
// lag* = log-end-offset − committed-offset, summed over a group's partitions.
// We model one entity per (consumerGroup → topic): pending = total lag,
// consumerCount = live group members. This maps cleanly onto the same backlog /
// drain-rate UI as the other brokers.
//
// A persistent Admin client is pooled per source and reconnected when the
// connection config changes.
//
// Connection config: { brokers: string[], ssl, saslMechanism?, username?, password? }
// ============================================================================

interface KafkaConfig {
  brokers: string[];
  ssl?: boolean;
  saslMechanism?: 'plain' | 'scram-sha-256' | 'scram-sha-512';
  username?: string;
  password?: string;
}

interface PoolEntry { admin: Admin; sig: string; }

const pool = new Map<string, PoolEntry>();
const REQUEST_TIMEOUT_MS = 10000;

const sigOf = (c: KafkaConfig) =>
  JSON.stringify([c.brokers, c.ssl, c.saslMechanism, c.username, c.password]);

const buildKafka = (config: KafkaConfig): Kafka => {
  const sasl =
    config.saslMechanism && config.username && config.password
      ? ({ mechanism: config.saslMechanism, username: config.username, password: config.password } as any)
      : undefined;

  return new Kafka({
    clientId: 'senzor-queue-monitor',
    brokers: config.brokers,
    ssl: config.ssl ?? false,
    sasl,
    connectionTimeout: REQUEST_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
    retry: { retries: 1 },
    logLevel: logLevel.NOTHING
  });
};

const getPooled = async (sourceId: string, config: KafkaConfig): Promise<Admin> => {
  const sig = sigOf(config);
  const existing = pool.get(sourceId);
  if (existing && existing.sig === sig) return existing.admin;

  if (existing) {
    await existing.admin.disconnect().catch(() => {});
    pool.delete(sourceId);
  }
  const admin = buildKafka(config).admin();
  await admin.connect();
  pool.set(sourceId, { admin, sig });
  return admin;
};

const toNum = (v: any): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const kafkaAdapter: QueueAdapter = {
  system: 'kafka',

  async testConnection(config: KafkaConfig): Promise<TestResult> {
    const admin = buildKafka(config).admin();
    try {
      await admin.connect();
      const { groups } = await admin.listGroups();
      return { discoveredQueues: groups.length, truncated: false };
    } finally {
      await admin.disconnect().catch(() => {});
    }
  },

  async sample(sourceId: string, config: KafkaConfig, opts: SampleOpts): Promise<SampleResult> {
    const admin = await getPooled(sourceId, config);

    const { groups: allGroups } = await admin.listGroups();
    let groupIds = allGroups
      .filter(g => g.protocolType === 'consumer' || !g.protocolType)
      .map(g => g.groupId);

    const discovered = groupIds.length;
    if (opts.queueFilter.length > 0) {
      const allow = new Set(opts.queueFilter);
      groupIds = groupIds.filter(id => allow.has(id));
    }
    const truncated = opts.queueFilter.length === 0 && groupIds.length > opts.maxQueues;
    groupIds = groupIds.slice(0, opts.maxQueues);

    const samples: QueueSample[] = [];
    // Cache topic high-watermarks within a single poll to avoid refetching.
    const topicHighCache = new Map<string, Map<number, number>>();

    const memberCounts = new Map<string, number>();
    if (groupIds.length > 0) {
      try {
        const described = await admin.describeGroups(groupIds);
        for (const g of described.groups) memberCounts.set(g.groupId, g.members.length);
      } catch { /* best-effort */ }
    }

    for (const groupId of groupIds) {
      if (samples.length >= opts.maxQueues) break;
      try {
        const committed = await admin.fetchOffsets({ groupId });
        for (const t of committed) {
          if (samples.length >= opts.maxQueues) break;

          let highs = topicHighCache.get(t.topic);
          if (!highs) {
            highs = new Map<number, number>();
            try {
              const topicOffsets = await admin.fetchTopicOffsets(t.topic);
              for (const p of topicOffsets) highs.set(p.partition, toNum(p.high ?? p.offset));
            } catch { /* topic may be gone */ }
            topicHighCache.set(t.topic, highs);
          }

          let lag = 0;
          let committedTotal = 0;
          for (const p of t.partitions) {
            const c = toNum(p.offset);
            if (c < 0) continue; // no committed offset for this partition
            committedTotal += c;
            const high = highs.get(p.partition) ?? c;
            lag += Math.max(0, high - c);
          }

          const depth = emptyDepth();
          depth.waiting = lag;
          samples.push({
            queueName: `${groupId} → ${t.topic}`,
            depth,
            pending: lag,
            dlqDepth: 0,
            completed: 0,
            oldestWaitingAgeMs: 0,
            oldestDelayedAgeMs: 0,
            consumerCount: memberCounts.get(groupId) || 0,
            isPaused: false,
            // Cumulative consumed messages (sum of committed offsets). The poller
            // turns successive samples into a consumed/sec rate.
            processedTotal: committedTotal
          });
        }
      } catch {
        continue;
      }
    }

    return { samples, discovered, truncated };
  },

  async dispose(sourceId: string) {
    const entry = pool.get(sourceId);
    if (entry) {
      await entry.admin.disconnect().catch(() => {});
      pool.delete(sourceId);
    }
  }
};
