import mongoose, { Schema, Document } from 'mongoose';
import crypto from 'crypto';
import { applyPlanBasedTtl } from '../utils/ttl';

// --- Utility: Deterministic & Isolated Fingerprinting ---
/**
 * Generates a universally unique fingerprint for an error.
 * By permanently baking the serviceId into the hash, two different
 * services can NEVER share an error group, even for identical errors.
 */
export const generateErrorFingerprint = (
  serviceId: string | mongoose.Types.ObjectId,
  errorClass: string,
  message: string
): string => {
  const normalizedClass = (errorClass || 'Error').trim();
  const normalizedMessage = (message || '').trim();
  const hashInput = `${serviceId.toString()}::${normalizedClass}::${normalizedMessage}`;

  return crypto.createHash('sha256').update(hashInput).digest('hex');
};

// --- 1. Error Group (The Aggregated Trend & State) ---
export interface IErrorGroup extends Document {
  ownerId: string;

  // Polymorphic Relationship
  serviceId: mongoose.Types.ObjectId;
  serviceModel: 'ApmService' | 'TaskService' | 'RumService' | 'AiSource'; // Tells Mongoose which collection to populate from

  fingerprint: string; // Cryptographic hash
  errorClass: string;
  message: string;
  firstSeen: Date;
  lastSeen: Date;
  totalCount: number;
  status: 'unresolved' | 'resolved' | 'ignored';
  expiresAt?: Date; // Plan-based TTL (anchor: lastSeen)
}

const ErrorGroupSchema = new Schema<IErrorGroup>({
  ownerId: { type: String, required: true, index: true },

  // Polymorphic Relations
  serviceId: { type: Schema.Types.ObjectId, required: true, refPath: 'serviceModel' },
  serviceModel: { type: String, required: true, enum: ['ApmService', 'TaskService', 'RumService', 'AiSource'] },

  fingerprint: { type: String, required: true },
  errorClass: { type: String, required: true },
  message: { type: String, required: true },
  firstSeen: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now },
  totalCount: { type: Number, default: 1 },
  status: { type: String, enum: ['unresolved', 'resolved', 'ignored'], default: 'unresolved' }
});

// Compound unique index so we can atomically upsert occurrences per owner + fingerprint
ErrorGroupSchema.index({ ownerId: 1, fingerprint: 1 }, { unique: true });

// Index for dashboard queries and filtering
ErrorGroupSchema.index({ ownerId: 1, status: 1, lastSeen: -1 });

// Plan-based retention: a group is kept for the owner's retention window after
// its last occurrence (anchor: lastSeen), with a hard-cap backstop on lastSeen.
applyPlanBasedTtl(ErrorGroupSchema, 'lastSeen');


// --- 2. Error Event (The Individual Occurrence) ---
export interface IErrorEvent extends Document {
  groupId: mongoose.Types.ObjectId;

  // Polymorphic Relationship
  serviceId: mongoose.Types.ObjectId;
  serviceModel: 'ApmService' | 'TaskService' | 'RumService' | 'AiSource';

  traceId?: string; // Generic: Links to APM traceIds or Task runIds
  stackTrace: string;
  context?: any;
  timestamp: Date;
  expiresAt?: Date; // Plan-based TTL (anchor: timestamp)
}

const ErrorEventSchema = new Schema<IErrorEvent>({
  groupId: { type: Schema.Types.ObjectId, ref: 'ErrorGroup', required: true, index: true },

  // Polymorphic Relations
  serviceId: { type: Schema.Types.ObjectId, required: true, refPath: 'serviceModel', index: true },
  serviceModel: { type: String, required: true, enum: ['ApmService', 'TaskService', 'RumService', 'AiSource'] },

  traceId: { type: String, index: true },
  stackTrace: { type: String, required: true },
  context: { type: Schema.Types.Mixed },
  timestamp: { type: Date, required: true }
});

// Plan-based retention (per-document expiresAt + hard-cap backstop on timestamp)
applyPlanBasedTtl(ErrorEventSchema, 'timestamp');

export const ErrorGroup = mongoose.model<IErrorGroup>('ErrorGroup', ErrorGroupSchema);
export const ErrorEvent = mongoose.model<IErrorEvent>('ErrorEvent', ErrorEventSchema);