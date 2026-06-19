/**
 * Senzor Queue Collector (push mode)
 * ---------------------------------------------------------------------------
 * Runs INSIDE the customer's network — the broker never has to be exposed to
 * Senzor. It samples the broker on an interval using the SAME adapter code as
 * the agentless poller, then POSTs the samples to /api/ingest/queue, where they
 * flow through the identical persistence layer. Pull and push produce identical
 * data.
 *
 * Configure entirely via environment variables, then run:
 *   node dist/collector/queue.js     (or: npm run collector:queue)
 *
 * Required:
 *   SENZOR_API_ENDPOINT      e.g. https://api.senzor.dev
 *   SENZOR_QUEUE_API_KEY     the collector key shown when you registered the source
 *   SENZOR_QUEUE_SYSTEM      bullmq | rabbitmq | kafka | sqs
 *
 * Per-system connection (see buildConfig below). Optional:
 *   SENZOR_QUEUE_INTERVAL_SEC (default 60)
 *   SENZOR_QUEUE_FILTER       comma-separated allowlist (default: auto-discover)
 *   SENZOR_QUEUE_MAX          max queues per cycle (default 250)
 */
import axios from 'axios';
import { getAdapter, DEFAULT_MAX_QUEUES } from '../worker/queue/adapters';
import type { QueueSystem } from '../models/Queue';

const env = (k: string): string | undefined => process.env[k];
const required = (k: string): string => {
  const v = process.env[k];
  if (!v) {
    console.error(`[QueueCollector] Missing required env var: ${k}`);
    process.exit(1);
  }
  return v;
};

const buildConfig = (system: QueueSystem): any => {
  switch (system) {
    case 'bullmq':
      return { uri: required('SENZOR_QUEUE_REDIS_URL'), prefix: env('SENZOR_QUEUE_PREFIX') || 'bull' };
    case 'rabbitmq':
      return {
        apiUrl: required('SENZOR_QUEUE_RABBIT_API_URL'),
        username: required('SENZOR_QUEUE_RABBIT_USER'),
        password: required('SENZOR_QUEUE_RABBIT_PASS'),
        vhost: env('SENZOR_QUEUE_RABBIT_VHOST') || '/'
      };
    case 'kafka':
      return {
        brokers: required('SENZOR_QUEUE_KAFKA_BROKERS').split(',').map(s => s.trim()).filter(Boolean),
        ssl: env('SENZOR_QUEUE_KAFKA_SSL') === 'true',
        saslMechanism: env('SENZOR_QUEUE_KAFKA_SASL_MECHANISM') || undefined,
        username: env('SENZOR_QUEUE_KAFKA_USER') || undefined,
        password: env('SENZOR_QUEUE_KAFKA_PASS') || undefined
      };
    case 'sqs':
      return {
        region: required('AWS_REGION'),
        accessKeyId: required('AWS_ACCESS_KEY_ID'),
        secretAccessKey: required('AWS_SECRET_ACCESS_KEY')
      };
    default:
      console.error(`[QueueCollector] Unsupported system: ${system}`);
      process.exit(1);
  }
};

const run = async () => {
  const endpoint = required('SENZOR_API_ENDPOINT').replace(/\/+$/, '');
  const apiKey = required('SENZOR_QUEUE_API_KEY');
  const system = required('SENZOR_QUEUE_SYSTEM') as QueueSystem;
  const intervalMs = Math.max(15, Number(env('SENZOR_QUEUE_INTERVAL_SEC')) || 60) * 1000;
  const maxQueues = Number(env('SENZOR_QUEUE_MAX')) || DEFAULT_MAX_QUEUES;
  const queueFilter = (env('SENZOR_QUEUE_FILTER') || '').split(',').map(s => s.trim()).filter(Boolean);

  const adapter = getAdapter(system);
  const config = buildConfig(system);
  const ingestUrl = `${endpoint}/api/ingest/queue`;

  console.log(`[QueueCollector] Starting — system=${system} interval=${intervalMs / 1000}s endpoint=${ingestUrl}`);

  let stopping = false;

  const cycle = async () => {
    try {
      const { samples, discovered, truncated, version } = await adapter.sample('collector', config, {
        queueFilter,
        maxQueues
      });

      await axios.post(
        ingestUrl,
        { samples, discovered, truncated, version },
        { headers: { 'x-service-api-key': apiKey }, timeout: 15000 }
      );

      console.log(`[QueueCollector] Pushed ${samples.length} queues (${discovered} discovered)`);
    } catch (err: any) {
      const detail = err?.response?.data?.error || err.message;
      console.error(`[QueueCollector] Cycle failed: ${detail}`);
    }
  };

  await cycle();
  const timer = setInterval(() => { if (!stopping) cycle(); }, intervalMs);

  const shutdown = async () => {
    stopping = true;
    clearInterval(timer);
    try { await adapter.dispose('collector'); } catch { /* ignore */ }
    console.log('[QueueCollector] Stopped.');
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

run().catch(err => {
  console.error('[QueueCollector] Fatal:', err);
  process.exit(1);
});
