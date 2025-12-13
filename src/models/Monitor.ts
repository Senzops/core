import mongoose, { Schema, Document } from 'mongoose';

// --- Monitor Registry ---
export interface IMonitor extends Document {
  ownerId: string;
  name: string;
  url: string;
  interval: number; // 15, 30, 60 minutes
  status: 'up' | 'down' | 'timeout' | 'pending';
  lastCheck: Date;
  nextCheck: Date;

  // Locking for Concurrency
  isLocked: boolean;
  lockTime: Date; // To auto-expire locks if worker crashes
}

const MonitorSchema = new Schema<IMonitor>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  url: { type: String, required: true },
  interval: { type: Number, enum: [15, 30, 60], default: 15 },
  status: { type: String, enum: ['up', 'down', 'timeout', 'pending'], default: 'pending' },

  lastCheck: { type: Date, default: null },
  nextCheck: { type: Date, default: Date.now, index: true }, // Index for fast worker queries

  isLocked: { type: Boolean, default: false },
  lockTime: { type: Date, default: null }
}, { timestamps: true });

export const Monitor = mongoose.model<IMonitor>('Monitor', MonitorSchema);

// --- Monitor Run (History) ---
export interface IMonitorRun extends Document {
  monitorId: mongoose.Types.ObjectId;
  status: 'up' | 'down' | 'timeout';
  latency: number; // ms
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