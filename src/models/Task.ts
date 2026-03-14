import mongoose, { Schema, Document } from 'mongoose';

// --- 1. Task Service (The Registered Environment) ---
export interface ITaskService extends Document {
  ownerId: string;
  name: string;
  apiKey: string;
  status: 'online' | 'offline';
  lastSeen: Date;
  createdAt: Date;
}

const TaskServiceSchema = new Schema<ITaskService>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  apiKey: { type: String, required: true, unique: true, index: true },
  status: { type: String, enum: ['online', 'offline'], default: 'offline' },
  lastSeen: { type: Date, default: Date.now }
}, { timestamps: true });


// --- Task Signature (State Tracking) ---
export interface ITaskSignature extends Document {
  serviceId: mongoose.Types.ObjectId;
  taskName: string;
  taskType: 'cron' | 'queue' | 'pipeline' | 'custom';
  scheduleExpression?: string; // e.g., '0 * * * *'
  lastRunAt?: Date;
  lastStatus?: 'success' | 'failed';
  avgDuration: number; // Exponential Moving Average (EMA)
  healthState: 'healthy' | 'missing' | 'stalled' | 'failing';
}
const TaskSignatureSchema = new Schema<ITaskSignature>({
  serviceId: { type: Schema.Types.ObjectId, ref: 'TaskService', required: true },
  taskName: { type: String, required: true },
  taskType: { type: String, required: true },
  scheduleExpression: { type: String },
  lastRunAt: { type: Date },
  lastStatus: { type: String, enum: ['success', 'failed'] },
  avgDuration: { type: Number, default: 0 },
  healthState: { type: String, enum: ['healthy', 'missing', 'stalled', 'failing'], default: 'healthy' }
});
// Critical for fast upserts during ingestion
TaskSignatureSchema.index({ serviceId: 1, taskName: 1 }, { unique: true });
TaskSignatureSchema.index({ taskType: 1, healthState: 1 }); // For Watchdog queries


// --- 2. Task Run (The Individual Execution) ---
export interface ITaskRun extends Document {
  serviceId: mongoose.Types.ObjectId;
  runId: string; // SDK generated UUID
  taskName: string; // e.g., 'weekly-report', 'video-encode'
  taskType: 'cron' | 'queue' | 'pipeline' | 'custom';
  status: 'success' | 'failed';
  duration: number; // Execution time in ms
  queueDelay?: number; // Time spent waiting in queue before execution
  attempts?: number; // For retry tracking
  triggerTraceId?: string; // Distributed tracing: Link to the APM HTTP trace that spawned this
  metadata?: any; // Job payload, worker hostname, etc.
  resourceMetrics?: {
    memoryDeltaBytes: number;
    cpuUserUs: number;
    cpuSystemUs: number;
  };
  isDeadLetter?: boolean;
  spans: any[]; // The waterfall spans
  timestamp: Date;
}

const TaskRunSchema = new Schema<ITaskRun>({
  serviceId: { type: Schema.Types.ObjectId, ref: 'TaskService', required: true, index: true },
  runId: { type: String, required: true, index: true },
  taskName: { type: String, required: true, index: true },
  taskType: { type: String, required: true },
  status: { type: String, enum: ['success', 'failed'], required: true },
  duration: { type: Number, required: true },
  queueDelay: { type: Number, default: 0 },
  attempts: { type: Number, default: 1 },
  triggerTraceId: { type: String, index: true },
  metadata: { type: Schema.Types.Mixed },
  resourceMetrics: {
    memoryDeltaBytes: { type: Number },
    cpuUserUs: { type: Number },
    cpuSystemUs: { type: Number }
  },
  isDeadLetter: { type: Boolean, default: false },
  spans: [{ type: Schema.Types.Mixed }],
  timestamp: { type: Date, required: true }
});

TaskRunSchema.index({ timestamp: 1 }, { expireAfterSeconds: 604800 }); // 7 Day TTL

// --- 3. Task Metric (Time-Series Aggregation) ---
export interface ITaskMetric extends Document {
  serviceId: mongoose.Types.ObjectId;
  taskName: string;
  timestamp: Date; // Minute/Hour bucket
  runs: number;
  failures: number;
  durationSum: number;
  durationMax: number;
  queueDelaySum: number;
  attemptsSum: number;
}

const TaskMetricSchema = new Schema<ITaskMetric>({
  serviceId: { type: Schema.Types.ObjectId, ref: 'TaskService', required: true },
  taskName: { type: String, required: true },
  timestamp: { type: Date, required: true },
  runs: { type: Number, default: 0 },
  failures: { type: Number, default: 0 },
  durationSum: { type: Number, default: 0 },
  durationMax: { type: Number, default: 0 },
  queueDelaySum: { type: Number, default: 0 },
  attemptsSum: { type: Number, default: 0 },
});

// High-performance compound index for dashboard rendering
TaskMetricSchema.index({ serviceId: 1, taskName: 1, timestamp: -1 }, { unique: true });
TaskMetricSchema.index({ timestamp: 1 }, { expireAfterSeconds: 2592000 }); // 30 Day TTL for metrics

export const TaskService = mongoose.model<ITaskService>('TaskService', TaskServiceSchema);
export const TaskSignature = mongoose.model<ITaskSignature>('TaskSignature', TaskSignatureSchema);
export const TaskRun = mongoose.model<ITaskRun>('TaskRun', TaskRunSchema);
export const TaskMetric = mongoose.model<ITaskMetric>('TaskMetric', TaskMetricSchema);