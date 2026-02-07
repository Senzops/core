import mongoose, { Schema, Document } from 'mongoose';

// --- 1. Service Registry ---
export interface IApmService extends Document {
  ownerId: string;       // User who owns this service
  name: string;          // e.g. "Payment Microservice"
  apiKey: string;        // Secret key for the SDK
  framework: string;     // e.g. "node", "go", "python" (detected by SDK)
  lastSeen: Date;
}

const ApmServiceSchema = new Schema<IApmService>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  apiKey: { type: String, required: true, select: false, index: true }, // Hidden by default
  framework: { type: String, default: 'unknown' },
  lastSeen: { type: Date, default: null }
}, { timestamps: true });

export const ApmService = mongoose.model<IApmService>('ApmService', ApmServiceSchema);

// --- 2. Raw Trace Data (The Hybrid Model) ---
export interface IApmTrace extends Document {
  serviceId: mongoose.Types.ObjectId;

  // HTTP Details
  method: string;        // GET, POST
  route: string;         // /api/users/:id (Normalized)
  path: string;          // /api/users/123 (Raw)
  status: number;        // 200, 404, 500
  duration: number;      // ms

  // Context (Web Analytics Style)
  ip: string;
  country: string;
  city: string;
  userAgent: string;
  browser: string;
  os: string;
  device: string;

  timestamp: Date;
}

const ApmTraceSchema = new Schema<IApmTrace>({
  serviceId: { type: Schema.Types.ObjectId, ref: 'ApmService', required: true, index: true },

  method: { type: String, required: true },
  route: { type: String, required: true, index: true }, // Indexed for aggregation
  path: String,
  status: { type: Number, required: true },
  duration: { type: Number, required: true },

  // Context
  ip: String,
  country: String,
  city: String,
  userAgent: String,
  browser: String,
  os: String,
  device: String,

  timestamp: { type: Date, default: Date.now, index: true }
}, { timestamps: true });

// TTL: Delete raw traces after 7 days (604800 seconds)
// For long term stats, we will implement an aggregation worker in Phase 3
ApmTraceSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });

export const ApmTrace = mongoose.model<IApmTrace>('ApmTrace', ApmTraceSchema);