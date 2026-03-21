import mongoose, { Schema, Document } from 'mongoose';

// --- 1. RUM Service Registry ---
export interface IRumService extends Document {
  ownerId: string;
  name: string;
  domains: string[];
  apiKey: string;
  samplingRate: number;
  lastSeen: Date;
  createdAt: Date;
}

const RumServiceSchema = new Schema<IRumService>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  domains: [{ type: String, required: true }],
  apiKey: { type: String, required: true, select: false, unique: true, index: true },
  samplingRate: { type: Number, default: 1.0, min: 0.0, max: 1.0 },
  lastSeen: { type: Date, default: null }
}, { timestamps: true });

export const RumService = mongoose.model<IRumService>('RumService', RumServiceSchema);


// --- 2. RUM Trace (Page Load / SPA Route Change) ---
export interface IRumSpan {
  spanId: string;
  name: string;       // e.g., "GET /api/v1/users", "app.bundle.js", "button#submit"
  type: string;       // 'fetch', 'xhr', 'resource', 'long-task', 'click'
  method?: string;    // GET, POST
  status?: number;    // HTTP Status
  size?: number;      // Bytes transferred
  startTime: number;
  duration: number;
  meta?: any;         // Explicitly allow flexible metadata
}

export interface IRumTrace extends Document {
  serviceId: mongoose.Types.ObjectId;
  traceId: string;    // W3C Traceparent ID
  sessionId: string;
  traceType: 'initial_load' | 'route_change';

  url: string;
  path: string;
  referrer: string;

  // Google Core Web Vitals
  vitals: {
    lcp?: number;
    inp?: number;
    cls?: number;
    fcp?: number;
  };

  // W3C Navigation Timings (ms)
  timings: {
    dns?: number;
    tcp?: number;
    ssl?: number;
    ttfb?: number;
    domInteractive?: number;
    domComplete?: number;
  };

  // User UX Frustration
  frustration: {
    rageClicks: number;
    deadClicks: number;
    errorCount: number;
  };

  // Hardware & Network Context
  connectionType?: string; // '4g', '3g', 'wifi'
  deviceMemory?: number;   // RAM in GB

  // Geography & Device
  ip: string;
  country: string;
  city: string;
  userAgent: string;
  browser: string;
  os: string;
  device: string;

  spans: IRumSpan[];
  duration: number;
  timestamp: Date;
}

const RumSpanSchema = new Schema({
  spanId: String,
  name: String,
  type: String,
  method: String,
  status: Number,
  size: Number,
  startTime: Number,
  duration: Number,
  meta: { type: mongoose.Schema.Types.Mixed }
}, { _id: false });

const RumTraceSchema = new Schema<IRumTrace>({
  serviceId: { type: Schema.Types.ObjectId, ref: 'RumService', required: true, index: true },
  traceId: { type: String, required: true, index: true },
  sessionId: { type: String, required: true, index: true },
  traceType: { type: String, enum: ['initial_load', 'route_change'], required: true },

  url: { type: String, required: true },
  path: { type: String, required: true, index: true },
  referrer: String,

  vitals: { lcp: Number, inp: Number, cls: Number, fcp: Number },
  timings: { dns: Number, tcp: Number, ssl: Number, ttfb: Number, domInteractive: Number, domComplete: Number },
  frustration: {
    rageClicks: { type: Number, default: 0 },
    deadClicks: { type: Number, default: 0 },
    errorCount: { type: Number, default: 0 }
  },

  connectionType: String,
  deviceMemory: Number,

  ip: String, country: String, city: String, userAgent: String, browser: String, os: String, device: String,
  spans: [RumSpanSchema],
  duration: { type: Number, required: true },
  timestamp: { type: Date, required: true }
}, { timestamps: true });

RumTraceSchema.index({ serviceId: 1, timestamp: -1 });
RumTraceSchema.index({ serviceId: 1, path: 1, timestamp: -1 });
RumTraceSchema.index({ timestamp: 1 }, { expireAfterSeconds: 604800 }); // 7 Days TTL

export const RumTrace = mongoose.model<IRumTrace>('RumTrace', RumTraceSchema);


// --- 3. RUM Metrics (Time-Series Aggregation) ---
export interface IRumMetric extends Document {
  serviceId: mongoose.Types.ObjectId;
  timestamp: Date;

  pageViews: number;
  sessions: number;

  // Vitals Accumulators
  vitalsSum: { lcp: number; inp: number; cls: number; fcp: number; };
  vitalsCount: { lcp: number; inp: number; cls: number; fcp: number; };

  // Timing Accumulators
  timingsSum: { dns: number; tcp: number; ssl: number; ttfb: number; domComplete: number; };
  timingsCount: { dns: number; tcp: number; ssl: number; ttfb: number; domComplete: number; };

  // Frustration Accumulators
  frustrationTotal: { rageClicks: number; deadClicks: number; errors: number; };

  // Dimensions
  paths: Map<string, number>;
  countries: Map<string, number>;
  browsers: Map<string, number>;
  os: Map<string, number>;
  devices: Map<string, number>;
}

const RumMetricSchema = new Schema<IRumMetric>({
  serviceId: { type: Schema.Types.ObjectId, ref: 'RumService', required: true },
  timestamp: { type: Date, required: true },

  pageViews: { type: Number, default: 0 },
  sessions: { type: Number, default: 0 },

  vitalsSum: { lcp: { type: Number, default: 0 }, inp: { type: Number, default: 0 }, cls: { type: Number, default: 0 }, fcp: { type: Number, default: 0 } },
  vitalsCount: { lcp: { type: Number, default: 0 }, inp: { type: Number, default: 0 }, cls: { type: Number, default: 0 }, fcp: { type: Number, default: 0 } },

  timingsSum: { dns: { type: Number, default: 0 }, tcp: { type: Number, default: 0 }, ssl: { type: Number, default: 0 }, ttfb: { type: Number, default: 0 }, domComplete: { type: Number, default: 0 } },
  timingsCount: { dns: { type: Number, default: 0 }, tcp: { type: Number, default: 0 }, ssl: { type: Number, default: 0 }, ttfb: { type: Number, default: 0 }, domComplete: { type: Number, default: 0 } },

  frustrationTotal: {
    rageClicks: { type: Number, default: 0 },
    deadClicks: { type: Number, default: 0 },
    errors: { type: Number, default: 0 }
  },

  paths: { type: Map, of: Number, default: {} },
  countries: { type: Map, of: Number, default: {} },
  browsers: { type: Map, of: Number, default: {} },
  os: { type: Map, of: Number, default: {} },
  devices: { type: Map, of: Number, default: {} },
});

RumMetricSchema.index({ serviceId: 1, timestamp: 1 });
RumMetricSchema.index({ timestamp: 1 }, { expireAfterSeconds: 691200 }); // 8 Days TTL

export const RumMetric = mongoose.model<IRumMetric>('RumMetric', RumMetricSchema);