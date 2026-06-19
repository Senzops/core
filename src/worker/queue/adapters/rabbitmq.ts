import axios, { AxiosInstance } from 'axios';
import { QueueAdapter, QueueSample, SampleOpts, SampleResult, TestResult, emptyDepth } from './types';

// ============================================================================
// RabbitMQ adapter — RabbitMQ Management HTTP API (port 15672 by default).
// ----------------------------------------------------------------------------
// Stateless: each poll issues authenticated HTTP calls, so there is no pooled
// client to manage. Depth, in-flight (unacked), and consumer counts come
// straight from /api/queues. A dead-letter queue surfaces as its own queue row
// (RabbitMQ DLX routes to a normal queue), so dlqDepth is reported per-queue
// as 0 here and the DLQ is visible as its own entity.
//
// Connection config: { apiUrl, username, password, vhost }
// ============================================================================

interface RabbitConfig {
  apiUrl: string;   // e.g. http://host:15672
  username: string;
  password: string;
  vhost?: string;   // default '/'
}

const REQUEST_TIMEOUT_MS = 8000;

const buildClient = (config: RabbitConfig): AxiosInstance =>
  axios.create({
    baseURL: config.apiUrl.replace(/\/+$/, ''),
    auth: { username: config.username, password: config.password },
    timeout: REQUEST_TIMEOUT_MS,
    // Management API can return large payloads on big clusters.
    maxContentLength: 50 * 1024 * 1024,
    maxBodyLength: 50 * 1024 * 1024
  });

const queuesPath = (vhost?: string): string => {
  if (!vhost || vhost === 'all' || vhost === '*') return '/api/queues';
  return `/api/queues/${encodeURIComponent(vhost)}`;
};

/** Management API returns a bare array, or { items: [...] } when paginated. */
const unwrap = (data: any): any[] => {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
};

const mapQueue = (q: any): QueueSample => {
  const ready = Number(q.messages_ready) || 0;
  const unacked = Number(q.messages_unacknowledged) || 0;
  const depth = emptyDepth();
  depth.waiting = ready;
  depth.active = unacked;

  let oldestWaitingAgeMs = 0;
  if (q.head_message_timestamp) {
    // RabbitMQ reports this in seconds.
    const tsMs = Number(q.head_message_timestamp) * 1000;
    if (Number.isFinite(tsMs) && tsMs > 0) oldestWaitingAgeMs = Math.max(0, Date.now() - tsMs);
  }

  return {
    queueName: q.vhost && q.vhost !== '/' ? `${q.vhost}/${q.name}` : q.name,
    depth,
    pending: ready,
    dlqDepth: 0,
    completed: 0,
    oldestWaitingAgeMs,
    oldestDelayedAgeMs: 0,
    consumerCount: Number(q.consumers) || 0,
    isPaused: false
  };
};

export const rabbitmqAdapter: QueueAdapter = {
  system: 'rabbitmq',

  async testConnection(config: RabbitConfig): Promise<TestResult> {
    const client = buildClient(config);
    let version: string | undefined;
    try {
      const overview = await client.get('/api/overview');
      version = overview.data?.rabbitmq_version || overview.data?.product_version;
    } catch {
      // overview may be restricted for some users; connectivity still matters.
    }
    const res = await client.get(queuesPath(config.vhost), {
      params: { page: 1, page_size: 250, pagination: true }
    });
    const items = unwrap(res.data);
    return {
      version,
      discoveredQueues: typeof res.data?.total_count === 'number' ? res.data.total_count : items.length,
      truncated: typeof res.data?.total_count === 'number' ? res.data.total_count > items.length : false
    };
  },

  async sample(_sourceId: string, config: RabbitConfig, opts: SampleOpts): Promise<SampleResult> {
    const client = buildClient(config);
    const res = await client.get(queuesPath(config.vhost), {
      params: { page: 1, page_size: opts.maxQueues, pagination: true }
    });

    let items = unwrap(res.data);
    const totalCount = typeof res.data?.total_count === 'number' ? res.data.total_count : items.length;

    if (opts.queueFilter.length > 0) {
      const allow = new Set(opts.queueFilter);
      items = items.filter((q: any) =>
        allow.has(q.name) || allow.has(`${q.vhost}/${q.name}`)
      );
    }

    const truncated = totalCount > items.length && opts.queueFilter.length === 0;
    const samples = items.slice(0, opts.maxQueues).map(mapQueue);

    return { samples, discovered: totalCount, truncated };
  },

  dispose() { /* stateless — nothing to release */ }
};
