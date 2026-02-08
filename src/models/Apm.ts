import mongoose, { Schema, Document } from 'mongoose';

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
  name: string;       // e.g. "SELECT * FROM users", "External /api/stripe"
  type: string;       // 'db', 'http', 'custom', 'middleware'
  startTime: number;  // Offset in ms from trace start
  duration: number;   // Duration in ms
  status?: number;    // 0 = OK, 1 = Error (or HTTP status)
  meta?: any;         // Arbitrary metadata (sql query, headers)
}

// --- 3. Raw Trace Data ---
export interface IApmTrace extends Document {
  serviceId: mongoose.Types.ObjectId;
  traceId: string;    // Client-generated UUID for correlation

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

  timestamp: Date;
}

const SpanSchema = new Schema({
  name: String,
  type: String,
  startTime: Number,
  duration: Number,
  status: Number,
  meta: Object
}, { _id: false });

const ApmTraceSchema = new Schema<IApmTrace>({
  serviceId: { type: Schema.Types.ObjectId, ref: 'ApmService', required: true, index: true },
  traceId: { type: String, index: true }, // Helpful for lookup

  method: { type: String, required: true },
  route: { type: String, required: true, index: true },
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

  timestamp: { type: Date, default: Date.now, index: true }
}, { timestamps: true });

// 7 Days Retention
ApmTraceSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });

export const ApmTrace = mongoose.model<IApmTrace>('ApmTrace', ApmTraceSchema);