import {
  createWorker,
  registerWorker,
  UnrecoverableError,
  type ApmIngestPayload,
  type RumIngestPayload,
  type TaskIngestPayload,
  type LogIngestPayload,
  type WebIngestPayload,
  type VpsIngestPayload,
  type OtlpTracePayload,
  type OtlpLogPayload,
} from '../lib/queue';
import { logger } from '../utils/logger';

// Models (for service hydration)
import { ApmService } from '../models/Apm';
import { RumService } from '../models/Rum';
import { TaskService } from '../models/Task';

// Processors
import { processBatchBackground } from '../controllers/apm/ingest';
import { processRumBatchBackground } from '../controllers/rum/ingest';
import { processTaskBatchBackground } from '../controllers/task/ingest';
import { processLogIngestion } from '../controllers/logs/index';
import { processWebIngestion } from '../controllers/web/webIngest';
import { processVpsIngestion } from '../controllers/vps';
import { translateOtlpTraces } from '../controllers/otlp/traceTranslator';
import { translateOtlpLogs } from '../controllers/otlp/logTranslator';

// OTLP heartbeat helper
const updateLastSeen = async (context: { serviceId: string; target: 'apm' | 'rum' | 'task' }) => {
  const now = new Date();
  if (context.target === 'apm') {
    await ApmService.findByIdAndUpdate(context.serviceId, { lastSeen: now });
  } else if (context.target === 'rum') {
    await RumService.findByIdAndUpdate(context.serviceId, { lastSeen: now });
  } else if (context.target === 'task') {
    await TaskService.findByIdAndUpdate(context.serviceId, { lastSeen: now });
  }
};

// ---------------------------------------------------------------------------
// Boot all ingestion queue workers
// ---------------------------------------------------------------------------

// Lock durations: heavy processors (geo + bulk writes) get 300s,
// light processors (single inserts) use the 120s default.
// BullMQ auto-renews locks every lockDuration/2, so these are safety ceilings,
// not expected processing times. Generous values prevent false stall detection.
const HEAVY_LOCK_MS = 300_000;

export function startQueueWorkers(): void {
  // --- APM Ingestion (heavy: geo lookups, trace/error/metric bulk writes) ---
  registerWorker(createWorker<ApmIngestPayload>('ingest.apm', async (job) => {
    const service = await ApmService.findById(job.data.serviceId).lean();
    if (!service) throw new UnrecoverableError(`APM service ${job.data.serviceId} not found`);
    await processBatchBackground(job.data.batchData, service);
  }, 5, HEAVY_LOCK_MS));

  // --- RUM Ingestion (heavy: geo + vitals + error fingerprinting + bulk writes) ---
  registerWorker(createWorker<RumIngestPayload>('ingest.rum', async (job) => {
    const service = await RumService.findById(job.data.serviceId).lean();
    if (!service) throw new UnrecoverableError(`RUM service ${job.data.serviceId} not found`);
    await processRumBatchBackground(job.data.batchData, service, job.data.clientIp);
  }, 5, HEAVY_LOCK_MS));

  // --- Task Ingestion (heavy: signatures + error fingerprinting + bulk writes) ---
  registerWorker(createWorker<TaskIngestPayload>('ingest.task', async (job) => {
    const service = await TaskService.findById(job.data.serviceId).lean();
    if (!service) throw new UnrecoverableError(`Task service ${job.data.serviceId} not found`);
    await processTaskBatchBackground(job.data.batchData, service);
  }, 5, HEAVY_LOCK_MS));

  // --- Log Ingestion (light: single insertMany) ---
  registerWorker(createWorker<LogIngestPayload>('ingest.logs', async (job) => {
    await processLogIngestion(job.data.payloads, job.data.ownerId);
  }, 10));

  // --- Web Analytics Ingestion (light: single event + metric update) ---
  registerWorker(createWorker<WebIngestPayload>('ingest.web', async (job) => {
    await processWebIngestion(job.data);
  }, 5));

  // --- VPS Telemetry Ingestion (light: save + create) ---
  registerWorker(createWorker<VpsIngestPayload>('ingest.vps', async (job) => {
    await processVpsIngestion(job.data.vpsId, job.data.metrics);
  }, 3));

  // --- OTLP Trace Ingestion (heavy: translation + multi-target bulk writes) ---
  registerWorker(createWorker<OtlpTracePayload>('ingest.otlp-traces', async (job) => {
    const { context, resourceSpans, requestIp, requestUserAgent } = job.data;
    await translateOtlpTraces(context, resourceSpans, requestIp, requestUserAgent);
    await updateLastSeen(context);
  }, 5, HEAVY_LOCK_MS));

  // --- OTLP Log Ingestion (light: translation + insertMany) ---
  registerWorker(createWorker<OtlpLogPayload>('ingest.otlp-logs', async (job) => {
    const { context, resourceLogs } = job.data;
    await translateOtlpLogs(context, resourceLogs);
    await updateLastSeen(context);
  }, 5));

  logger.info('[Queue] All ingestion workers started (apm×5, rum×5, task×5, logs×10, web×5, vps×3, otlp-traces×5, otlp-logs×5)');
}
