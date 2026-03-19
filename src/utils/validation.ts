import { z } from 'zod';

export const RegisterVpsSchema = z.object({
  name: z.string().min(1).max(50),
});

// Integration Sub-Schemas

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


// Matches the Agent's TelemetryPayload interface
export const TelemetrySchema = z.object({
  os: z.object({
    platform: z.string(),
    distro: z.string(),
    hostname: z.string(),
  }).passthrough(), // Allow extra OS fields
  cpu: z.object({
    usagePercent: z.number(),
    cores: z.number(),
  }).passthrough(),
  memory: z.object({
    total: z.number(),
    used: z.number(),
    usagePercent: z.number(),
  }).passthrough(),
  disk: z.object({
    total: z.number(),
    used: z.number(),
    usagePercent: z.number(),
  }).passthrough(),
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

export const WebStatsQuerySchema = z.object({
  range: z.enum(['24h', '7d', '30d']).default('24h'),
});

// --- Uptime Schemas ---
export const RegisterMonitorSchema = z.object({
  name: z.string().min(1).max(50),
  url: z.string().url(),
  interval: z.enum(['15', '30', '60']).transform(Number), // accept strings, convert to number
});

export const RegisterApmSchema = z.object({
  name: z.string().min(1).max(50),
  framework: z.string().optional(),
});

const ApmSpanSchema = z.object({
  spanId: z.string().optional(),
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

// Batch Payload (Upgraded to accept { traces, errors } but falls back to Array for legacy)
export const ApmBatchSchema = z.union([
  z.array(ApmTraceItem).transform(traces => ({ traces, errors: [] })),
  z.object({
    traces: z.array(ApmTraceItem).optional().default([]),
    errors: z.array(ApmErrorItemSchema).optional().default([])
  })
]);

// Database
export const RegisterDbSchema = z.object({
  name: z.string().min(1).max(50),
  type: z.enum(['mongodb', 'postgresql', 'mysql']),
  uri: z.string().url(),
  interval: z.number().min(1).max(60).default(5)
});

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
  errors: z.array(TaskErrorItemSchema).optional().default([])
});

// ============================================================================
// --- RUM (WEB APM) MONITORING SCHEMAS ---
// ============================================================================

export const RegisterRumSchema = z.object({
  name: z.string().min(1).max(50),
  domain: z.string().min(3).max(253).regex(
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/,
    "Invalid domain or subdomain format"
  )
});

const RumSpanSchema = z.object({
  spanId: z.string(),
  name: z.string(),
  type: z.enum(['fetch', 'xhr', 'resource', 'long-task', 'click', 'custom']),
  method: z.string().optional(),
  status: z.number().optional(),
  size: z.number().optional(),
  startTime: z.number().min(0),
  duration: z.number().min(0),
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
  traceType: z.enum(['initial_load', 'route_change']),

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
  errors: z.array(RumErrorItemSchema).optional().default([])
});