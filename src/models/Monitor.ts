import mongoose, { Schema, Document } from 'mongoose';

// --- Monitor Registry ---

export interface ISslInfo {
  valid: boolean;
  issuer: string;
  subject: string;
  validFrom: Date | null;
  validTo: Date | null;
  daysRemaining: number;
  protocol: string;
  lastCheckedAt: Date | null;
  error: string | null;
}

export interface IMonitor extends Document {
  ownerId: string;
  name: string;
  url: string;
  interval: number;
  status: 'up' | 'down' | 'timeout' | 'pending';
  lastCheck: Date;
  nextCheck: Date;

  // Request configuration
  method: 'GET' | 'POST' | 'HEAD' | 'PUT' | 'PATCH' | 'OPTIONS';
  headers: Record<string, string>;
  body: string;
  expectedStatus: number;

  // Uptime tracking
  lastDownAt: Date | null;

  // SSL certificate info
  ssl: ISslInfo;

  // Locking for Concurrency
  isLocked: boolean;
  lockTime: Date;
}

const SslInfoSchema = new Schema<ISslInfo>({
  valid: { type: Boolean, default: false },
  issuer: { type: String, default: '' },
  subject: { type: String, default: '' },
  validFrom: { type: Date, default: null },
  validTo: { type: Date, default: null },
  daysRemaining: { type: Number, default: -1 },
  protocol: { type: String, default: '' },
  lastCheckedAt: { type: Date, default: null },
  error: { type: String, default: null },
}, { _id: false });

const MonitorSchema = new Schema<IMonitor>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  url: { type: String, required: true },
  interval: { type: Number, enum: [1, 2, 3, 5, 10, 15, 30, 60], default: 5 },
  status: { type: String, enum: ['up', 'down', 'timeout', 'pending'], default: 'pending' },

  lastCheck: { type: Date, default: null },
  nextCheck: { type: Date, default: Date.now, index: true },

  // Request configuration
  method: { type: String, enum: ['GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'OPTIONS'], default: 'GET' },
  headers: { type: Schema.Types.Mixed, default: {} },
  body: { type: String, default: '' },
  expectedStatus: { type: Number, default: 0 },

  // Uptime tracking
  lastDownAt: { type: Date, default: null },

  // SSL
  ssl: { type: SslInfoSchema, default: () => ({}) },

  isLocked: { type: Boolean, default: false },
  lockTime: { type: Date, default: null }
}, { timestamps: true });

export const Monitor = mongoose.model<IMonitor>('Monitor', MonitorSchema);

// --- Monitor Run (History) ---
export interface IMonitorRun extends Document {
  monitorId: mongoose.Types.ObjectId;
  status: 'up' | 'down' | 'timeout';
  latency: number;
  statusCode: number;
  createdAt: Date;
}

const MonitorRunSchema = new Schema<IMonitorRun>({
  monitorId: { type: Schema.Types.ObjectId, ref: 'Monitor', required: true, index: true },
  status: { type: String, required: true },
  latency: { type: Number, default: 0 },
  statusCode: { type: Number, default: 0 },
}, { timestamps: true });

// TTL: 7 Days (60s * 60m * 24h * 7d = 604800 seconds)
MonitorRunSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });

export const MonitorRun = mongoose.model<IMonitorRun>('MonitorRun', MonitorRunSchema);

// --- Monitor Incident ---
export interface IMonitorIncident extends Document {
  monitorId: mongoose.Types.ObjectId;
  ownerId: string;
  startedAt: Date;
  resolvedAt: Date | null;
  duration: number | null;
  cause: string;
  statusCode: number;
}

const MonitorIncidentSchema = new Schema<IMonitorIncident>({
  monitorId: { type: Schema.Types.ObjectId, ref: 'Monitor', required: true, index: true },
  ownerId: { type: String, required: true, index: true },
  startedAt: { type: Date, required: true },
  resolvedAt: { type: Date, default: null },
  duration: { type: Number, default: null },
  cause: { type: String, enum: ['down', 'timeout'], default: 'down' },
  statusCode: { type: Number, default: 0 },
}, { timestamps: true });

MonitorIncidentSchema.index({ monitorId: 1, resolvedAt: 1 });
// TTL: 90 days — incidents are historical records, keep longer than run data
MonitorIncidentSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const MonitorIncident = mongoose.model<IMonitorIncident>('MonitorIncident', MonitorIncidentSchema);