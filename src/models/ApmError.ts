import mongoose, { Schema, Document } from 'mongoose';

// --- 1. Error Group (The Aggregated Trend) ---
export interface IApmErrorGroup extends Document {
  ownerId: string;
  apmId: mongoose.Types.ObjectId;
  fingerprint: string; // Hash of errorClass + message
  errorClass: string;
  message: string;
  firstSeen: Date;
  lastSeen: Date;
  totalCount: number;
  status: 'unresolved' | 'resolved' | 'ignored';
}

const ApmErrorGroupSchema = new Schema<IApmErrorGroup>({
  ownerId: { type: String, required: true, index: true },
  apmId: { type: Schema.Types.ObjectId, ref: 'ApmService', required: true, index: true },
  fingerprint: { type: String, required: true },
  errorClass: { type: String, required: true },
  message: { type: String, required: true },
  firstSeen: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now, index: true },
  totalCount: { type: Number, default: 1 },
  status: { type: String, enum: ['unresolved', 'resolved', 'ignored'], default: 'unresolved' }
});

// Compound unique index so we can atomically upsert occurrences
ApmErrorGroupSchema.index({ apmId: 1, fingerprint: 1 }, { unique: true });
ApmErrorGroupSchema.index({ ownerId: 1, status: 1, lastSeen: -1 });

// --- 2. Error Event (The Individual Occurrence) ---
export interface IApmErrorEvent extends Document {
  groupId: mongoose.Types.ObjectId;
  apmId: mongoose.Types.ObjectId;
  traceId?: string; // Links to your existing APM Invocations
  stackTrace: string;
  context?: any;
  timestamp: Date;
}

const ApmErrorEventSchema = new Schema<IApmErrorEvent>({
  groupId: { type: Schema.Types.ObjectId, ref: 'ApmErrorGroup', required: true, index: true },
  apmId: { type: Schema.Types.ObjectId, ref: 'ApmService', required: true },
  traceId: { type: String, index: true },
  stackTrace: { type: String, required: true },
  context: { type: Schema.Types.Mixed },
  timestamp: { type: Date, required: true, index: true }
});

// TTL Index: Auto-delete individual stack traces after 14 days to prevent DB bloat. 
// The Group (trend) will remain forever, but the granular events clean themselves up.
ApmErrorEventSchema.index({ timestamp: 1 }, { expireAfterSeconds: 1209600 });

export const ApmErrorGroup = mongoose.model<IApmErrorGroup>('ApmErrorGroup', ApmErrorGroupSchema);
export const ApmErrorEvent = mongoose.model<IApmErrorEvent>('ApmErrorEvent', ApmErrorEventSchema);