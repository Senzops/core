import { z } from 'zod';

export const RegisterVpsSchema = z.object({
  name: z.string().min(1).max(50),
});

export const UpdateVpsSchema = z.object({
  name: z.string().min(1).max(50),
});

const NginxStatsSchema = z.object({
  activeConnections: z.number(),
  accepts: z.number(),
  handled: z.number(),
  requests: z.number(),
  reading: z.number(),
  writing: z.number(),
  waiting: z.number(),
  reqPerSec: z.number(),
}).nullable().optional();

const TraefikComponentSchema = z.object({
  total: z.number(),
  active: z.number(),
  failed: z.number(),
});

const TraefikStatsSchema = z.object({
  routers: TraefikComponentSchema,
  services: TraefikComponentSchema,
  middlewares: TraefikComponentSchema,
}).nullable().optional();

// --- HARDWARE SCHEMAS ---
const DiskSchema = z.object({
  total: z.number(),
  used: z.number(),
  usagePercent: z.number(),
  name: z.string(),
}).passthrough();

const HardwareSchema = z.object({
  temperature: z.number().default(0),
  powerDraw: z.number().default(0),
}).passthrough();

const GpuSchema = z.object({
  id: z.string(),
  model: z.string(),
  utilization: z.number(),
  temperature: z.number(),
  powerDraw: z.number(),
  vramUsed: z.number(),
  vramTotal: z.number(),
}).passthrough();

export const TelemetrySchema = z.object({
  os: z.object({
    platform: z.string(),
    distro: z.string(),
    hostname: z.string(),
  }).passthrough(),
  cpu: z.object({
    usagePercent: z.number(),
    cores: z.number(),
  }).passthrough(),
  memory: z.object({
    total: z.number(),
    used: z.number(),
    usagePercent: z.number(),
  }).passthrough(),
  
  // Upgraded Structures
  disk: z.array(DiskSchema).default([]),
  hardware: HardwareSchema.default({ temperature: 0, powerDraw: 0 }),
  gpus: z.array(GpuSchema).default([]),
  
  network: z.object({
    bytesRecvSec: z.number(),
    bytesSentSec: z.number(),
    latencyMs: z.number().optional(),
  }),
  processes: z.object({
    total: z.number(),
    running: z.number(),
    blocked: z.number(),
    sleeping: z.number(),
  }).optional(),
  docker: z.array(z.object({
    name: z.string(),
    state: z.string(),
    cpuPercent: z.number().optional(),
    memoryUsage: z.number().optional(),
  }).passthrough()).optional().default([]),


  // Integrations
  nginx: NginxStatsSchema,
  traefik: TraefikStatsSchema,
  terminalEnabled: z.boolean().optional().default(false),

  uptimeSeconds: z.number(),
  timestamp: z.string(),
});

//  Web Analytics Schemas 
export const RegisterWebsiteSchema = z.object({
  name: z.string().min(1).max(50),
  domain: z.string().min(3).max(253).regex(
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/,
    "Invalid domain or subdomain format"
  )
});

export const UpdateWebsiteSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  domain: z.string().min(3).max(253).regex(
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/,
    "Invalid domain or subdomain format"
  ).optional(),
}).refine(data => data.name || data.domain, { message: 'At least one field must be provided' });

export const WebStatsQuerySchema = z.object({
  range: z.enum(['30m', '1h', '3h', '6h', '12h', '24h', '3d', '7d']).optional(),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
}).refine(
  (d) => d.range || (d.start && d.end),
  { message: "Either 'range' or both 'start' and 'end' are required" }
);

export const DashboardTimeRangeSchema = z.object({
  range: z.enum(['30m', '1h', '3h', '6h', '12h', '24h', '3d', '7d']).optional(),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
}).refine(
  (d) => d.range || (d.start && d.end) || (!d.range && !d.start && !d.end),
  { message: "Provide 'range' or both 'start' and 'end'" }
);

// --- Web Ingestion Schema ---

// Custom-event properties. Schema-less but bounded: a capped number of keys,
// each a scalar (string/number/boolean) with a length-limited string form.
// Keeps WebEventData cardinality and per-event payload size under control.
export const MAX_EVENT_PROPS = 50;
const WebEventPropsSchema = z
  .record(
    z.string().max(64),
    z.union([z.string().max(512), z.number(), z.boolean(), z.null()])
  )
  .refine((obj) => Object.keys(obj).length <= MAX_EVENT_PROPS, {
    message: `At most ${MAX_EVENT_PROPS} event properties are allowed`,
  });

export const WebIngestSchema = z.object({
  webId: z.string().min(1).max(50),
  visitorId: z.string().min(1).max(100),
  sessionId: z.string().min(1).max(100),
  type: z.enum(['pageview', 'ping', 'event']),
  eventName: z.string().min(1).max(64).optional(),
  props: WebEventPropsSchema.optional(),
  url: z.string().max(2048).optional().default(''),
  path: z.string().max(512).optional().default('/'),
  title: z.string().max(512).optional().default('Unknown'),
  referrer: z.string().max(2048).optional().default('Direct'),
  width: z.number().int().min(0).max(10000).optional(),
  height: z.number().int().min(0).max(10000).optional(),
  language: z.string().max(35).optional(),
  duration: z.number().int().min(0).max(86400).optional(),
  timezone: z.string().max(100).optional(),
}).refine((d) => d.type !== 'event' || (typeof d.eventName === 'string' && d.eventName.length > 0), {
  message: "eventName is required when type is 'event'",
  path: ['eventName'],
});

// Query schema for the custom-events explorer (top events + property drill-down).
export const WebEventsQuerySchema = z.object({
  range: z.enum(['30m', '1h', '3h', '6h', '12h', '24h', '3d', '7d']).optional(),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
  event: z.string().max(64).optional(),
}).refine(
  (d) => d.range || (d.start && d.end) || (!d.range && !d.start && !d.end),
  { message: "Provide 'range' or both 'start' and 'end'" }
);

// --- Funnels (conversion paths) ---
export const MAX_FUNNEL_STEPS = 10;

const FunnelStepSchema = z.object({
  type: z.enum(['page', 'event']),
  value: z.string().min(1).max(200),
  match: z.enum(['exact', 'contains', 'startsWith']).optional().default('exact'),
  label: z.string().max(80).optional(),
});

export const CreateFunnelSchema = z.object({
  name: z.string().min(1).max(80),
  steps: z.array(FunnelStepSchema).min(1).max(MAX_FUNNEL_STEPS),
});

export const UpdateFunnelSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  steps: z.array(FunnelStepSchema).min(1).max(MAX_FUNNEL_STEPS).optional(),
}).refine((d) => d.name !== undefined || d.steps !== undefined, {
  message: 'At least one field (name or steps) must be provided',
});

export const FunnelAnalyzeQuerySchema = z.object({
  range: z.enum(['30m', '1h', '3h', '6h', '12h', '24h', '3d', '7d']).optional(),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
}).refine(
  (d) => d.range || (d.start && d.end) || (!d.range && !d.start && !d.end),
  { message: "Provide 'range' or both 'start' and 'end'" }
);

// --- Annotations (timeline notes) ---
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const CreateAnnotationSchema = z.object({
  date: z.string().datetime(),
  text: z.string().min(1).max(200),
  color: z.string().regex(HEX_COLOR, 'Color must be a hex value').optional(),
});

export const UpdateAnnotationSchema = z.object({
  date: z.string().datetime().optional(),
  text: z.string().min(1).max(200).optional(),
  color: z.string().regex(HEX_COLOR, 'Color must be a hex value').optional(),
}).refine((d) => d.date !== undefined || d.text !== undefined || d.color !== undefined, {
  message: 'At least one field must be provided',
});

// --- Uptime Schemas ---

const MonitorHeaderSchema = z.record(z.string().max(500))
  .refine(
    (headers) => Object.keys(headers).length <= 10,
    { message: 'Maximum 10 custom headers allowed' }
  )
  .refine(
    (headers) => Object.keys(headers).every(k => /^[a-zA-Z0-9\-_]+$/.test(k) && k.length <= 64),
    { message: 'Header names must be alphanumeric (with hyphens/underscores), max 64 chars' }
  )
  .refine(
    (headers) => !Object.keys(headers).some(k => /^(host|content-length|transfer-encoding|cookie|set-cookie)$/i.test(k)),
    { message: 'host, content-length, transfer-encoding, and cookie headers are not allowed' }
  );

export const VALID_INTERVALS = [1, 2, 3, 5, 10, 15, 30, 60] as const;
export const PREMIUM_INTERVALS = [1, 2, 3] as const;

export const RegisterMonitorSchema = z.object({
  name: z.string().min(1).max(50),
  url: z.string().url(),
  interval: z.enum(['1', '2', '3', '5', '10', '15', '30', '60']).transform(Number),
  method: z.enum(['GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'OPTIONS']).default('GET'),
  headers: MonitorHeaderSchema.optional().default({}),
  body: z.string().max(4096).optional().default(''),
  expectedStatus: z.number().int().min(0).max(599).optional().default(0),
});

export const UpdateMonitorSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  url: z.string().url().optional(),
  interval: z.enum(['1', '2', '3', '5', '10', '15', '30', '60']).transform(Number).optional(),
  method: z.enum(['GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'OPTIONS']).optional(),
  headers: MonitorHeaderSchema.optional(),
  body: z.string().max(4096).optional(),
  expectedStatus: z.number().int().min(0).max(599).optional(),
}).refine(data => data.name || data.url || data.interval !== undefined || data.method || data.headers || data.body !== undefined || data.expectedStatus !== undefined, { message: 'At least one field must be provided' });

// Log Payload
export const LogPayloadSchema = z.object({
  level: z.string().default('info'),
  message: z.string(),
  attributes: z.record(z.any()).default({}),
  traceId: z.string().optional(),
  runId: z.string().optional(), // Task runs use runId
  spanId: z.string().optional(),
  timestamp: z.string().optional()
});

//  APM
export const RegisterApmSchema = z.object({
  name: z.string().min(1).max(50),
  framework: z.string().optional(),
});

export const UpdateApmSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  framework: z.string().optional(),
}).refine(data => data.name || data.framework, { message: 'At least one field must be provided' });

const ApmSpanSchema = z.object({
  spanId: z.string().optional(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  type: z.string(),
  startTime: z.number().min(0),
  duration: z.number().min(0),
  status: z.number().optional(),
  meta: z.record(z.any()).optional(),
});

const ApmErrorSchema = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional()
}).optional();

const ApmTraceItem = z.object({
  traceId: z.string().optional(), // SDK should generate this
  parentTraceId: z.string().optional().nullable(),
  parentSpanId: z.string().optional().nullable(),
  method: z.string(),
  route: z.string(),
  path: z.string(),
  status: z.number().int(),
  duration: z.number().nonnegative(),
  ip: z.string().optional(),
  userAgent: z.string().optional(),
  spans: z.array(ApmSpanSchema).optional().default([]),
  error: ApmErrorSchema,
  timestamp: z.string().datetime(),
});

// Standalone Error Event Schema
const ApmErrorItemSchema = z.object({
  errorClass: z.string(),
  message: z.string(),
  stackTrace: z.string().optional(),
  traceId: z.string().optional(),
  context: z.any().optional(),
  timestamp: z.string().datetime().optional()
});

// --- Runtime Metrics Schema ---
const RuntimeMetricsEventLoopSchema = z.object({
  lagMs: z.number().nonnegative(),
  lagP50Ms: z.number().nonnegative().optional(),
  lagP99Ms: z.number().nonnegative().optional(),
  utilizationPercent: z.number().min(0).max(100).optional(),
});

const RuntimeMetricsGcSchema = z.object({
  totalDurationMs: z.number().nonnegative(),
  totalCount: z.number().nonnegative(),
  majorCount: z.number().nonnegative(),
  minorCount: z.number().nonnegative(),
  incrementalCount: z.number().nonnegative(),
  weakCallbackCount: z.number().nonnegative(),
});

const RuntimeMetricsMemorySchema = z.object({
  heapUsedBytes: z.number().nonnegative(),
  heapTotalBytes: z.number().nonnegative(),
  externalBytes: z.number().nonnegative(),
  arrayBuffersBytes: z.number().nonnegative(),
  rssBytes: z.number().nonnegative(),
  heapUsedPercent: z.number().min(0).max(100),
});

const RuntimeMetricsProcessSchema = z.object({
  activeHandles: z.number().nonnegative(),
  activeRequests: z.number().nonnegative(),
  cpuUserUs: z.number().nonnegative(),
  cpuSystemUs: z.number().nonnegative(),
  uptimeSeconds: z.number().nonnegative(),
});

const RuntimeMetricsSchema = z.object({
  eventLoop: RuntimeMetricsEventLoopSchema,
  gc: RuntimeMetricsGcSchema,
  memory: RuntimeMetricsMemorySchema,
  process: RuntimeMetricsProcessSchema,
});

const RuntimeMetricsPayloadSchema = z.object({
  timestamp: z.string().datetime(),
  metrics: RuntimeMetricsSchema,
});

// Batch Payload (Upgraded to accept { traces, errors } but falls back to Array for legacy)
export const ApmBatchSchema = z.union([
  z.array(ApmTraceItem).transform(traces => ({ traces, errors: [], logs: [], runtimeMetrics: [] })),
  z.object({
    traces: z.array(ApmTraceItem).optional().default([]),
    errors: z.array(ApmErrorItemSchema).optional().default([]),
    logs: z.array(LogPayloadSchema).default([]),
    runtimeMetrics: z.array(RuntimeMetricsPayloadSchema).optional().default([]),
  })
]);

// Database
export const RegisterDbSchema = z.object({
  name: z.string().min(1).max(50),
  type: z.enum(['mongodb', 'postgresql', 'mysql', 'redis']),
  uri: z.string(),
  interval: z.number().min(1).max(60).default(5)
});

export const UpdateDbSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  type: z.enum(['mongodb', 'postgresql', 'mysql', 'redis']).optional(),
  uri: z.string().optional(),
  interval: z.number().min(1).max(60).optional(),
}).refine(data => data.name || data.type || data.uri || data.interval !== undefined, { message: 'At least one field must be provided' });

// --- Queue Monitoring Validation ---
// Per-broker connection schemas. Secrets are encrypted at rest; the controller
// derives a non-secret `connectionMeta` for UI prefill from the same object.
export const BullmqConnSchema = z.object({
  uri: z.string().min(1), // redis:// or rediss:// (TLS)
  prefix: z.string().min(1).max(100).default('bull'),
});
export const RabbitmqConnSchema = z.object({
  apiUrl: z.string().url(), // Management API base, e.g. http://host:15672
  username: z.string().min(1),
  password: z.string().min(1),
  vhost: z.string().max(255).default('/'),
});
export const KafkaConnSchema = z.object({
  brokers: z.array(z.string().min(1)).min(1).max(50),
  ssl: z.boolean().default(false),
  saslMechanism: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']).optional(),
  username: z.string().optional(),
  password: z.string().optional(),
});
export const SqsConnSchema = z.object({
  region: z.string().min(1).max(50),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
});

export const queueConnectionSchema = (system: string) => {
  switch (system) {
    case 'bullmq': return BullmqConnSchema;
    case 'rabbitmq': return RabbitmqConnSchema;
    case 'kafka': return KafkaConnSchema;
    case 'sqs': return SqsConnSchema;
    default: return null;
  }
};

export const RegisterQueueSchema = z.object({
  name: z.string().min(1).max(50),
  system: z.enum(['bullmq', 'rabbitmq', 'kafka', 'sqs']),
  // 'agentless' (default) requires `connection`; 'collector' issues an apiKey
  // and needs no server-side connection.
  mode: z.enum(['agentless', 'collector']).default('agentless'),
  connection: z.record(z.any()).optional(),
  managementUrl: z.union([z.string().url(), z.literal('')]).optional(),
  queueFilter: z.array(z.string().min(1).max(500)).max(1000).default([]),
  interval: z.number().min(1).max(60).default(1),
});

// --- Collector push ingest ---
const QueueSampleSchema = z.object({
  queueName: z.string().min(1).max(500),
  depth: z.object({
    waiting: z.number().default(0),
    active: z.number().default(0),
    delayed: z.number().default(0),
    prioritized: z.number().default(0),
    waitingChildren: z.number().default(0),
    paused: z.number().default(0),
  }).default({}),
  pending: z.number().default(0),
  dlqDepth: z.number().default(0),
  completed: z.number().default(0),
  oldestWaitingAgeMs: z.number().default(0),
  oldestDelayedAgeMs: z.number().default(0),
  consumerCount: z.number().default(0),
  isPaused: z.boolean().default(false),
  completedRate: z.number().optional(),
  failedRate: z.number().optional(),
  processedTotal: z.number().optional(),
});

export const QueueIngestSchema = z.object({
  samples: z.array(QueueSampleSchema).max(1000),
  version: z.string().max(80).optional(),
  discovered: z.number().optional(),
  truncated: z.boolean().optional(),
});

export const UpdateQueueSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  connection: z.record(z.any()).optional(),
  managementUrl: z.union([z.string().url(), z.literal('')]).optional(),
  queueFilter: z.array(z.string().min(1).max(500)).max(1000).optional(),
  interval: z.number().min(1).max(60).optional(),
}).refine(
  data => data.name || data.connection || data.managementUrl !== undefined || data.queueFilter !== undefined || data.interval !== undefined,
  { message: 'At least one field must be provided' }
);

// --- APM Error Ingest Validation ---
export const ApmErrorIngestSchema = z.object({
  namespace: z.string().default('default'),
  errorType: z.string(),
  errorMessage: z.string(),
  traceId: z.string().optional(), // Link to active APM trace
  stackTrace: z.array(z.object({
    filename: z.string().optional().default('unknown'),
    function: z.string().optional().default('anonymous'),
    lineno: z.number().optional().default(0),
    colno: z.number().optional().default(0),
    inApp: z.boolean().default(true)
  })).default([]),
  requestContext: z.object({
    url: z.string().optional(),
    method: z.string().optional(),
    headers: z.any().optional(),
    body: z.any().optional(),
    ip: z.string().optional()
  }).optional(),
  metadata: z.any().optional(),
  timestamp: z.string().datetime().optional()
});

// --- TASK MONITORING SCHEMAS ---
const TaskSpanSchema = z.object({
  spanId: z.string().optional(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  type: z.string(),
  startTime: z.number().min(0),
  duration: z.number().min(0),
  status: z.number().optional(),
  meta: z.record(z.any()).optional(),
});

const ResourceMetricsSchema = z.object({
  memoryDeltaBytes: z.number(),
  cpuUserUs: z.number(),
  cpuSystemUs: z.number(),
});

const TaskRunItem = z.object({
  runId: z.string(),
  taskName: z.string(),
  taskType: z.enum(['cron', 'queue', 'pipeline', 'custom']).default('custom'),
  status: z.enum(['success', 'failed']),
  duration: z.number().nonnegative(),
  queueDelay: z.number().nonnegative().optional().default(0),
  attempts: z.number().positive().optional().default(1),
  triggerTraceId: z.string().optional(),
  metadata: z.record(z.any()).optional(),
  resourceMetrics: ResourceMetricsSchema.optional(),
  isDeadLetter: z.boolean().optional().default(false),
  spans: z.array(TaskSpanSchema).optional().default([]),
  timestamp: z.string().datetime(),
});

const TaskErrorItemSchema = z.object({
  errorClass: z.string(),
  message: z.string(),
  stackTrace: z.string().optional(),
  runId: z.string().optional(), // Links error to the specific Task Run
  context: z.any().optional(),
  timestamp: z.string().datetime().optional()
});

export const TaskBatchSchema = z.object({
  runs: z.array(TaskRunItem).optional().default([]),
  errors: z.array(TaskErrorItemSchema).optional().default([]),
  logs: z.array(LogPayloadSchema).default([])
});

// ============================================================================
// --- RUM (WEB APM) MONITORING SCHEMAS ---
// ============================================================================

export const UpdateTaskSchema = z.object({
  name: z.string().min(1).max(50),
});

export const UpdateRumSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  domains: z.string().min(3).max(253).regex(
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/,
    "Invalid domain or subdomain format"
  ).optional(),
}).refine(data => data.name || data.domains, { message: 'At least one field must be provided' });

export const RegisterRumSchema = z.object({
  name: z.string().min(1).max(50),
  domain: z.string().min(3).max(253).regex(
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/,
    "Invalid domain or subdomain format"
  )
});

const RumSpanSchema = z.object({
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  type: z.enum(['fetch', 'xhr', 'http', 'resource', 'long-task', 'longtask', 'click', 'custom', 'visibility', 'interaction', 'navigation_stage']),
  method: z.string().optional(),
  status: z.number().optional(),
  size: z.number().optional(),
  startTime: z.number().min(0),
  duration: z.number().min(0),
  meta: z.record(z.any()).optional().nullable(),
});

const CoreWebVitalsSchema = z.object({
  lcp: z.number().optional(),
  inp: z.number().optional(),
  cls: z.number().optional(),
  fcp: z.number().optional(),
});

const NavigationTimingsSchema = z.object({
  dns: z.number().optional(),
  tcp: z.number().optional(),
  ssl: z.number().optional(),
  ttfb: z.number().optional(),
  domInteractive: z.number().optional(),
  domComplete: z.number().optional(),
});

const FrustrationSchema = z.object({
  rageClicks: z.number().nonnegative().default(0),
  deadClicks: z.number().nonnegative().default(0),
  errorCount: z.number().nonnegative().default(0),
});

const RumTraceItem = z.object({
  traceId: z.string(),   // W3C Traceparent ID
  sessionId: z.string(),
  traceType: z.enum(['initial_load', 'route_change', 'span_update']),

  url: z.string().url(),
  path: z.string(),
  referrer: z.string().optional().default(''),

  vitals: CoreWebVitalsSchema.optional().default({}),
  timings: NavigationTimingsSchema.optional().default({}),
  frustration: FrustrationSchema.optional().default({ rageClicks: 0, deadClicks: 0, errorCount: 0 }),

  connectionType: z.string().optional(), // '4g', 'wifi', etc.
  deviceMemory: z.number().optional(),

  spans: z.array(RumSpanSchema).optional().default([]),
  duration: z.number().nonnegative(),
  timestamp: z.string().datetime(),
});

const RumErrorItemSchema = z.object({
  errorClass: z.string(),
  message: z.string(),
  stackTrace: z.string().optional(),
  traceId: z.string().optional(),
  context: z.any().optional(),    // Holds Breadcrumbs, DOM state
  timestamp: z.string().datetime().optional()
});

export const RumBatchSchema = z.object({
  traces: z.array(RumTraceItem).optional().default([]),
  errors: z.array(RumErrorItemSchema).optional().default([]),
  logs: z.array(LogPayloadSchema).default([])
});

// --- AI MONITORING (LLM OBSERVABILITY) SCHEMAS ---
// The SDK pushes AI traces (workflow groupings) and their generations
// (individual LLM/tool/retrieval calls). Cost is intentionally NOT accepted
// from the client — it is recomputed server-side from the pricing table.
// Content (input/output) is accepted but only persisted when the source opts
// in, and is masked on ingest.

export const AI_OBSERVATION_TYPES = [
  'generation', 'embedding', 'agent', 'tool', 'mcp',
  'retrieval', 'chain', 'handoff', 'reasoning', 'guardrail', 'span',
] as const;

const AiGenerationItem = z.object({
  generationId: z.string(),
  parentGenerationId: z.string().optional().nullable(),
  type: z.enum(AI_OBSERVATION_TYPES).default('generation'),
  name: z.string().max(200).optional(),
  provider: z.string().max(80).optional(),
  operation: z.string().max(80).optional(),

  requestModel: z.string().max(200).optional(),
  responseModel: z.string().max(200).optional(),

  tokensIn: z.number().nonnegative().optional().default(0),
  tokensOut: z.number().nonnegative().optional().default(0),

  startTime: z.number().min(0).optional().default(0),
  latencyMs: z.number().nonnegative().optional().default(0),
  timeToFirstTokenMs: z.number().nonnegative().optional(),
  streaming: z.boolean().optional().default(false),

  params: z.record(z.any()).optional(),
  finishReason: z.string().max(80).optional(),

  status: z.enum(['ok', 'error']).optional().default('ok'),
  statusCode: z.number().optional(),
  errorType: z.string().max(200).optional(),
  errorMessage: z.string().max(2000).optional(),

  // Optional captured content — persisted only when the source opts in.
  input: z.any().optional(),
  output: z.any().optional(),
  toolCalls: z.array(z.any()).optional(),

  // Structural span enrichment (agent-observability). Identity fields are kept
  // regardless of content capture; tool args/result are masked on ingest.
  agent: z.object({
    name: z.string().max(200),
    role: z.string().max(120).optional(),
    step: z.number().optional(),
  }).optional(),
  tool: z.object({
    name: z.string().max(200),
    args: z.any().optional(),
    result: z.any().optional(),
  }).optional(),
  mcp: z.object({
    server: z.string().max(200),
    transport: z.string().max(40).optional(),
    method: z.string().max(120).optional(),
    toolName: z.string().max(200).optional(),
    resourceUri: z.string().max(500).optional(),
  }).optional(),
  handoff: z.object({
    from: z.string().max(200).optional(),
    to: z.string().max(200),
    reason: z.string().max(500).optional(),
  }).optional(),
  reasoningTokens: z.number().nonnegative().optional(),
  depth: z.number().min(0).optional(),

  metadata: z.record(z.any()).optional(),
  timestamp: z.string().datetime(),
});

const AiTraceItem = z.object({
  traceId: z.string(),
  apmTraceId: z.string().optional().nullable(),
  sessionId: z.string().max(200).optional(),
  userId: z.string().max(200).optional(),
  name: z.string().max(200).optional(),
  tags: z.array(z.string().max(80)).max(50).optional().default([]),
  status: z.enum(['ok', 'error']).optional().default('ok'),
  latencyMs: z.number().nonnegative().optional().default(0),
  metadata: z.record(z.any()).optional(),
  timestamp: z.string().datetime(),
});

const AiScoreItem = z.object({
  traceId: z.string(),
  generationId: z.string().optional().nullable(),
  name: z.string().min(1).max(120),
  dataType: z.enum(['numeric', 'boolean', 'categorical']).optional().default('numeric'),
  value: z.number().optional().default(0),
  stringValue: z.string().max(500).optional(),
  comment: z.string().max(2000).optional(),
  authorId: z.string().max(200).optional(),
  timestamp: z.string().datetime(),
});

export const AiBatchSchema = z.object({
  aiTraces: z.array(AiTraceItem).optional().default([]),
  aiGenerations: z.array(AiGenerationItem.extend({ traceId: z.string() })).optional().default([]),
  aiScores: z.array(AiScoreItem).optional().default([]),
  errors: z.array(ApmErrorItemSchema).optional().default([]),
  logs: z.array(LogPayloadSchema).optional().default([]),
});

// Authenticated user-feedback / eval score (dashboard or external API).
export const AiScoreSubmitSchema = z.object({
  traceId: z.string().min(1),
  generationId: z.string().optional(),
  name: z.string().min(1).max(120),
  dataType: z.enum(['numeric', 'boolean', 'categorical']).optional().default('numeric'),
  value: z.number().optional().default(0),
  stringValue: z.string().max(500).optional(),
  comment: z.string().max(2000).optional(),
});

// --- AI Source management (dashboard CRUD) ---
const AiModelPriceSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
});

const AiSourceSettingsSchema = z.object({
  captureContent: z.boolean().optional(),
  maskingRules: z.array(z.string().min(1).max(100)).max(200).optional(),
  pricingOverrides: z.record(AiModelPriceSchema).optional(),
  sampleRate: z.number().min(0).max(1).optional(),
});

export const RegisterAiSchema = z.object({
  name: z.string().min(1).max(50),
  type: z.enum(['server', 'browser']).default('server'),
  settings: AiSourceSettingsSchema.optional(),
  managementUrl: z.union([z.string().url(), z.literal('')]).optional(),
});

export const UpdateAiSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  settings: AiSourceSettingsSchema.optional(),
  managementUrl: z.union([z.string().url(), z.literal('')]).optional(),
}).refine(
  data => data.name !== undefined || data.settings !== undefined || data.managementUrl !== undefined,
  { message: 'At least one field must be provided' }
);