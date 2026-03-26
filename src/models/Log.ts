import mongoose, { Schema, Document } from 'mongoose';

export interface ILogEvent extends Document {
  ownerId: string;
  serviceId?: mongoose.Types.ObjectId;
  serviceModel?: 'ApmService' | 'RumService' | 'TaskService' | 'External';
  traceId?: string;
  spanId?: string;
  level: string; // 'info', 'warn', 'error', 'debug', 'fatal'
  message: string;
  attributes: Record<string, any>;
  timestamp: Date;
}

const LogEventSchema = new Schema<ILogEvent>({
  ownerId: { type: String, required: true, index: true },
  serviceId: { type: Schema.Types.ObjectId, refPath: 'serviceModel', index: true },
  serviceModel: { type: String, enum: ['ApmService', 'RumService', 'TaskService', 'External'], default: 'External' },
  traceId: { type: String, index: true },
  spanId: { type: String },
  level: { type: String, default: 'info', index: true },
  message: { type: String, required: true },
  attributes: { type: Schema.Types.Mixed, default: {} },
  timestamp: { type: Date, required: true }
}, { timestamps: true });

// --- Indexes for Enterprise Performance ---
// 1. 7-Day TTL Index (Auto-deletes old logs)
LogEventSchema.index({ timestamp: 1 }, { expireAfterSeconds: 604800 });

// 2. Compound Index for Dashboard Filtering
LogEventSchema.index({ ownerId: 1, timestamp: -1, level: 1 });

// 3. Text Index for Free-Text Message Search
LogEventSchema.index({ message: 'text' });

// 4. Wildcard Index for Dynamic Attribute Search (MongoDB 4.2+)
// Allows O(1) lookups for queries like `attributes.userId: 123`
LogEventSchema.index({ 'attributes.$**': 1 });

export const LogEvent = mongoose.model<ILogEvent>('LogEvent', LogEventSchema);

// --- Global Account Ingestion Key ---
export interface ILogApiKey extends Document {
  ownerId: string;
  key: string;
}

const LogApiKeySchema = new Schema<ILogApiKey>({
  ownerId: { type: String, required: true, unique: true },
  key: { type: String, required: true, unique: true, index: true }
}, { timestamps: true });

export const LogApiKey = mongoose.model<ILogApiKey>('LogApiKey', LogApiKeySchema);