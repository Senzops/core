import { Queue, Worker, UnrecoverableError, type ConnectionOptions, type JobsOptions, type Processor } from 'bullmq';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Redis Connection
// ---------------------------------------------------------------------------

function parseRedisUrl(url: string): ConnectionOptions {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || 'localhost',
      port: parseInt(parsed.port) || 6379,
      password: parsed.password || undefined,
      username: parsed.username || undefined,
      db: parsed.pathname ? parseInt(parsed.pathname.slice(1)) || 0 : 0,
      maxRetriesPerRequest: null,
    };
  } catch {
    return { host: 'localhost', port: 6379, maxRetriesPerRequest: null };
  }
}

export const redisConnection: ConnectionOptions = parseRedisUrl(
  process.env.REDIS_QUEUE_URL || 'redis://localhost:6379'
);

// ---------------------------------------------------------------------------
// Default Job Options
// ---------------------------------------------------------------------------

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 3600, count: 5000 },
  removeOnFail: { age: 604800, count: 10000 },
};

// ---------------------------------------------------------------------------
// Job Payload Types
// ---------------------------------------------------------------------------

export interface ApmIngestPayload {
  batchData: { traces: any[]; errors: any[]; logs: any[]; runtimeMetrics?: any[] };
  serviceId: string;
}

export interface RumIngestPayload {
  batchData: { traces: any[]; errors: any[]; logs?: any[] };
  serviceId: string;
  clientIp: string;
}

export interface TaskIngestPayload {
  batchData: { runs: any[]; errors: any[]; logs: any[] };
  serviceId: string;
}

export interface AiIngestPayload {
  batchData: { aiTraces: any[]; aiGenerations: any[]; aiScores: any[]; errors: any[]; logs: any[] };
  sourceId: string;
}

export interface LogIngestPayload {
  payloads: any[];
  ownerId: string;
}

export interface WebIngestPayload {
  eventData: {
    webId: string;
    visitorId: string;
    sessionId: string;
    type: string;
    eventName?: string;
    props?: Record<string, string | number | boolean | null>;
    url: string;
    path: string;
    title?: string;
    referrer?: string;
    width?: number;
    height?: number;
    language?: string;
    duration?: number;
  };
  ownerId: string;
  clientIp: string;
  userAgent: string;
}

export interface VpsIngestPayload {
  vpsId: string;
  metrics: any;
}

export interface OtlpTracePayload {
  resourceSpans: any[];
  context: { ownerId: string; serviceId: string; target: 'apm' | 'rum' | 'task'; serviceName: string };
  requestIp: string;
  requestUserAgent?: string;
}

export interface OtlpLogPayload {
  resourceLogs: any[];
  context: { ownerId: string; serviceId: string; target: 'apm' | 'rum' | 'task'; serviceName: string };
}

// ---------------------------------------------------------------------------
// Queue Instances (Producer Side — used by API server)
// ---------------------------------------------------------------------------

// BullMQ Queue has 6 type params; we must supply all 6 so the computed NameType
// resolves to `string` instead of the deferred conditional `ExtractNameType<T, string>`.
type IngestionQueue<T> = Queue<T, any, string, T, any, string>;

// Redis Cluster / managed Redis (Upstash, Redis Cloud, etc.) requires all keys
// touched by a Lua script to hash to the same slot. BullMQ's Lua scripts derive
// keys internally via string ops — managed proxies reject these unless a {hash tag}
// in the prefix guarantees same-slot routing for ALL derived keys.
//
// Placing the tag in the prefix (not the queue name) is the official BullMQ
// recommendation: https://docs.bullmq.io/bull/patterns/redis-cluster
const QUEUE_PREFIX = '{bull}';

function createQueue<T>(name: string, opts?: Partial<JobsOptions>): IngestionQueue<T> {
  return new Queue<T, any, string, T, any, string>(name, {
    connection: redisConnection,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, ...opts },
  });
}

export const apmIngestQueue = createQueue<ApmIngestPayload>('ingest.apm');
export const rumIngestQueue = createQueue<RumIngestPayload>('ingest.rum');
export const taskIngestQueue = createQueue<TaskIngestPayload>('ingest.task');
export const aiIngestQueue = createQueue<AiIngestPayload>('ingest.ai');
export const logIngestQueue = createQueue<LogIngestPayload>('ingest.logs');
export const webIngestQueue = createQueue<WebIngestPayload>('ingest.web');
export const vpsIngestQueue = createQueue<VpsIngestPayload>('ingest.vps');
export const otlpTraceQueue = createQueue<OtlpTracePayload>('ingest.otlp-traces');
export const otlpLogQueue = createQueue<OtlpLogPayload>('ingest.otlp-logs');

const allQueues: Queue[] = [
  apmIngestQueue, rumIngestQueue, taskIngestQueue, aiIngestQueue, logIngestQueue,
  webIngestQueue, vpsIngestQueue, otlpTraceQueue, otlpLogQueue,
];

// ---------------------------------------------------------------------------
// Worker Factory (Consumer Side — used by Worker process)
// ---------------------------------------------------------------------------

export function createWorker<T>(
  queueName: string,
  processor: Processor<T>,
  concurrency: number,
  lockDurationMs: number = 120000,
): Worker<T> {
  const worker = new Worker<T>(queueName, processor, {
    connection: redisConnection,
    prefix: QUEUE_PREFIX,
    concurrency,
    lockDuration: lockDurationMs,
    // stalledInterval intentionally omitted — BullMQ's default (30s) is correct.
    // Setting it equal to lockDuration caused a race between the stalled check
    // and the auto-renew timer, leading to false stall detection and lock mismatch.
  });

  worker.on('failed', (job, err) => {
    logger.error(`[Queue] ${queueName} job ${job?.id} failed (attempt ${job?.attemptsMade}/${job?.opts?.attempts}): ${err.message}`);
  });

  worker.on('stalled', (jobId) => {
    logger.warn(`[Queue] ${queueName} job ${jobId} stalled — will be retried`);
  });

  return worker;
}

export { UnrecoverableError };

// ---------------------------------------------------------------------------
// Enqueue with Graceful Fallback
// ---------------------------------------------------------------------------

// If Redis is completely unreachable, queue.add() with maxRetriesPerRequest:null
// will hang indefinitely (ioredis offline queue). A timeout guarantees the handler
// always completes and the fallback fires within a bounded window.
const ENQUEUE_TIMEOUT_MS = 5000;

export async function enqueue<T>(
  queue: IngestionQueue<T>,
  data: T,
  fallback: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addPromise = queue.add('process', data);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Redis enqueue timeout')), ENQUEUE_TIMEOUT_MS);
    });
    await Promise.race([addPromise, timeoutPromise]);
  } catch (err: any) {
    logger.warn(`[Queue] ${queue.name} — Redis unavailable, falling back to in-process: ${err.message}`);
    setImmediate(fallback);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Graceful Shutdown
// ---------------------------------------------------------------------------

const registeredWorkers: Worker[] = [];

export function registerWorker(worker: Worker): void {
  registeredWorkers.push(worker);
}

export async function shutdownQueues(): Promise<void> {
  logger.info('[Queue] Draining workers and closing queues...');

  await Promise.allSettled(
    registeredWorkers.map(w => w.close())
  );

  await Promise.allSettled(
    allQueues.map(q => q.close())
  );

  logger.info('[Queue] All queues and workers shut down');
}
