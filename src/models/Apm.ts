import mongoose, { Schema, Document } from 'mongoose';
import { applyPlanBasedTtl } from '../utils/ttl';
/**
 * Service
 * */
// --- 1. Service Registry (Existing) ---
export interface IApmService extends Document {
  ownerId: string;
  name: string;
  apiKey: string;
  framework: string;
  lastSeen: Date;
}
const ApmServiceSchema = new Schema<IApmService>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  apiKey: { type: String, required: true, select: false, index: true },
  framework: { type: String, default: 'unknown' },
  lastSeen: { type: Date, default: null }
}, { timestamps: true });
export const ApmService = mongoose.model<IApmService>('ApmService', ApmServiceSchema);

// --- 2. Trace Spans (NEW) ---
export interface ISpan {
  spanId?: string;
  parentSpanId?: string;
  name: string;       // e.g. "SELECT * FROM users", "External /api/stripe"
  type: string;       // 'db', 'http', 'custom', 'middleware'
  startTime: number;  // Offset in ms from trace start
  duration: number;   // Duration in ms
  status?: number;    // 0 = OK, 1 = Error (or HTTP status)
  meta?: any;         // Arbitrary metadata (sql query, headers)
}

export interface IError {
  name?: String,
  message?: String,
  stack?: String
}
/**
 * Trace
 * */
// --- 3. Raw Trace Data ---
export interface IApmTrace extends Document {
  serviceId: mongoose.Types.ObjectId;
  traceId: string;    // Client-generated UUID for correlation
  parentTraceId?: string; // NEW
  parentSpanId?: string;  // NEW

  method: string;
  route: string;
  path: string;
  status: number;
  duration: number;

  ip: string;
  country: string;
  city: string;
  userAgent: string;
  browser: string;
  os: string;
  device: string;

  spans: ISpan[]; // NEW: Detailed breakdown
  error?: IError,

  timestamp: Date;
  expiresAt?: Date; // Plan-based TTL (anchor: createdAt)
}

const SpanSchema = new Schema({
  spanId: String,
  parentSpanId: String,
  name: String,
  type: String,
  startTime: Number,
  duration: Number,
  status: Number,
  meta: Object
}, { _id: false });

const TraceErrorSchema = new Schema({
  name: String,
  message: String,
  stack: String
}, { _id: false });

const ApmTraceSchema = new Schema<IApmTrace>({
  serviceId: { type: Schema.Types.ObjectId, ref: 'ApmService', required: true, index: true },
  traceId: { type: String, index: true }, // Helpful for lookup

  // Linkage
  parentTraceId: { type: String, index: true }, // Index for fast "Find Child" queries
  parentSpanId: { type: String, index: true },

  method: { type: String, required: true },
  route: { type: String, required: true },
  path: String,
  status: { type: Number, required: true },
  duration: { type: Number, required: true },

  ip: String,
  country: String,
  city: String,
  userAgent: String,
  browser: String,
  os: String,
  device: String,

  spans: [SpanSchema], // Embedded array for read performance
  error: TraceErrorSchema,

  timestamp: { type: Date, default: Date.now }
}, { timestamps: true });

// --- OPTIMIZATION: Compound Indexes ---

// 1. Main Dashboard Query: Find by Service, Filter by Date, Sort by Date
// Covers: { serviceId: 1, timestamp: 1 }
ApmTraceSchema.index({ serviceId: 1, timestamp: -1 });

// 2. Drill-down Query: Find by Service AND Route, Filter by Date
// Covers: { serviceId: 1, route: 1, timestamp: 1 }
ApmTraceSchema.index({ serviceId: 1, route: 1, timestamp: -1 });

// Plan-based retention (per-document expiresAt + hard-cap backstop on createdAt)
applyPlanBasedTtl(ApmTraceSchema, 'createdAt');

export const ApmTrace = mongoose.model<IApmTrace>('ApmTrace', ApmTraceSchema);

/**
 * Metric
 * */
export interface IApmMetric extends Document {
  serviceId: mongoose.Types.ObjectId;
  timestamp: Date; // Minute bucket (e.g. 10:00, 10:01)

  // Golden Signals
  requests: number;
  errorCount: number; // RENAMED: 'errors' conflicts with Mongoose Document property
  durationSum: number;
  durationMax: number;

  // Dimensions (Maps)
  // Enterprise Evolution: 'routes' map now handles Objects to support robust dashboard aggregates
  routes: Map<string, any>; 
  statusCodes: Map<string, number>;

  // Context
  countries: Map<string, number>;
  browsers: Map<string, number>;
  os: Map<string, number>;
  devices: Map<string, number>;

  expiresAt?: Date; // Plan-based TTL (anchor: timestamp)
}

const ApmMetricSchema = new Schema<IApmMetric>({
  serviceId: { type: Schema.Types.ObjectId, ref: 'ApmService', required: true },
  timestamp: { type: Date, required: true },

  requests: { type: Number, default: 0 },
  errorCount: { type: Number, default: 0 }, // RENAMED
  durationSum: { type: Number, default: 0 },
  durationMax: { type: Number, default: 0 },

  // Using Mixed Type dynamically protects legacy "number only" records from failing Mongoose validation mapping
  routes: { type: Map, of: Schema.Types.Mixed, default: {} },
  statusCodes: { type: Map, of: Number, default: {} },

  countries: { type: Map, of: Number, default: {} },
  browsers: { type: Map, of: Number, default: {} },
  os: { type: Map, of: Number, default: {} },
  devices: { type: Map, of: Number, default: {} },
});

// Compound Index for fast range queries
ApmMetricSchema.index({ serviceId: 1, timestamp: 1 });

// Plan-based retention (per-document expiresAt + hard-cap backstop on timestamp)
applyPlanBasedTtl(ApmMetricSchema, 'timestamp');

export const ApmMetric = mongoose.model<IApmMetric>('ApmMetric', ApmMetricSchema);