import { SQSClient, ListQueuesCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { QueueAdapter, QueueSample, SampleOpts, SampleResult, TestResult, emptyDepth } from './types';

// ============================================================================
// AWS SQS adapter — GetQueueAttributes approximate depths.
// ----------------------------------------------------------------------------
// SQS exposes approximate counts: visible (backlog), not-visible (in-flight),
// and delayed. There is no consumer concept and oldest-message age requires
// CloudWatch, so consumerCount/oldestAge are 0 here. A DLQ is a separate SQS
// queue (referenced by a redrive policy) and appears as its own entity.
//
// Connection config: { region, accessKeyId, secretAccessKey }
// ============================================================================

interface SqsConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

interface PoolEntry { client: SQSClient; sig: string; }

const pool = new Map<string, PoolEntry>();
const ATTR_BATCH = 10;
const REQUEST_TIMEOUT_MS = 8000;

const sigOf = (c: SqsConfig) => `${c.region}|${c.accessKeyId}|${c.secretAccessKey}`;

const buildClient = (config: SqsConfig): SQSClient =>
  new SQSClient({
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 2,
    requestHandler: { requestTimeout: REQUEST_TIMEOUT_MS } as any
  });

const getPooled = (sourceId: string, config: SqsConfig): SQSClient => {
  const sig = sigOf(config);
  const existing = pool.get(sourceId);
  if (existing && existing.sig === sig) return existing.client;
  if (existing) {
    existing.client.destroy();
    pool.delete(sourceId);
  }
  const client = buildClient(config);
  pool.set(sourceId, { client, sig });
  return client;
};

const nameFromUrl = (url: string): string => url.split('/').filter(Boolean).pop() || url;

const listQueueUrls = async (client: SQSClient, max: number): Promise<{ urls: string[]; truncated: boolean }> => {
  const urls: string[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(new ListQueuesCommand({ MaxResults: 1000, NextToken: nextToken }));
    for (const u of res.QueueUrls || []) {
      urls.push(u);
      if (urls.length >= max) return { urls, truncated: Boolean(res.NextToken) || (res.QueueUrls || []).length > 0 };
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return { urls, truncated: false };
};

const sampleQueue = async (client: SQSClient, url: string): Promise<QueueSample | null> => {
  try {
    const res = await client.send(new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
        'ApproximateNumberOfMessagesDelayed'
      ]
    }));
    const a = res.Attributes || {};
    const visible = Number(a.ApproximateNumberOfMessages) || 0;
    const inFlight = Number(a.ApproximateNumberOfMessagesNotVisible) || 0;
    const delayed = Number(a.ApproximateNumberOfMessagesDelayed) || 0;

    const depth = emptyDepth();
    depth.waiting = visible;
    depth.active = inFlight;
    depth.delayed = delayed;

    return {
      queueName: nameFromUrl(url),
      depth,
      pending: visible + delayed,
      dlqDepth: 0,
      completed: 0,
      oldestWaitingAgeMs: 0,
      oldestDelayedAgeMs: 0,
      consumerCount: 0,
      isPaused: false
    };
  } catch {
    return null;
  }
};

export const sqsAdapter: QueueAdapter = {
  system: 'sqs',

  async testConnection(config: SqsConfig): Promise<TestResult> {
    const client = buildClient(config);
    try {
      const res = await client.send(new ListQueuesCommand({ MaxResults: 1000 }));
      const count = (res.QueueUrls || []).length;
      return { discoveredQueues: count, truncated: Boolean(res.NextToken) };
    } finally {
      client.destroy();
    }
  },

  async sample(sourceId: string, config: SqsConfig, opts: SampleOpts): Promise<SampleResult> {
    const client = getPooled(sourceId, config);
    const { urls, truncated } = await listQueueUrls(client, opts.maxQueues);

    let targets = urls;
    if (opts.queueFilter.length > 0) {
      const allow = new Set(opts.queueFilter);
      targets = urls.filter(u => allow.has(nameFromUrl(u)) || allow.has(u));
    }

    const samples: QueueSample[] = [];
    for (let i = 0; i < targets.length; i += ATTR_BATCH) {
      const batch = targets.slice(i, i + ATTR_BATCH);
      const results = await Promise.all(batch.map(u => sampleQueue(client, u)));
      for (const s of results) if (s) samples.push(s);
    }

    return { samples, discovered: urls.length, truncated: truncated && opts.queueFilter.length === 0 };
  },

  dispose(sourceId: string) {
    const entry = pool.get(sourceId);
    if (entry) {
      entry.client.destroy();
      pool.delete(sourceId);
    }
  }
};
