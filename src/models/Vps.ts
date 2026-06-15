import mongoose, { Schema, Document } from 'mongoose';
import { applyPlanBasedTtl } from '../utils/ttl';

// --- VPS Schema ---
export interface IVps extends Document {
  ownerId: string; // Firebase UID
  name: string;
  apiKey: string; // The secret key used by the agent
  status: 'online' | 'offline';
  lastSeen: Date;
  metadata?: {
    os: string;
    hostname: string;
    ip?: string;
  };
  // Track which integrations are sending data
  activeIntegrations?: {
    nginx: boolean;
    traefik: boolean;
    terminal: boolean;
  };
}

const VpsSchema = new Schema<IVps>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  apiKey: { type: String, required: true, select: false }, // Hidden by default
  status: { type: String, enum: ['online', 'offline'], default: 'offline' },
  lastSeen: { type: Date, default: null },
  metadata: { type: Object, default: {} },
  // Default to false
  activeIntegrations: {
    nginx: { type: Boolean, default: false },
    traefik: { type: Boolean, default: false },
    terminal: { type: Boolean, default: false },
  },
}, { timestamps: true });

export const Vps = mongoose.model<IVps>('Vps', VpsSchema);

// --- Telemetry (Run) Schema ---
export interface IRun extends Document {
  vpsId: mongoose.Types.ObjectId;
  metrics: any; // Storing the full JSON payload
  createdAt: Date;
  expiresAt?: Date; // Plan-based TTL (anchor: createdAt)
}

const RunSchema = new Schema<IRun>({
  vpsId: { type: Schema.Types.ObjectId, ref: 'Vps', required: true, index: true },
  metrics: { type: Object, required: true },
}, { timestamps: true });

// Range + sort for dashboard/downsampling queries (match vpsId, filter+sort by time)
RunSchema.index({ vpsId: 1, createdAt: 1 });

// Plan-based retention (per-document expiresAt + hard-cap backstop on createdAt)
applyPlanBasedTtl(RunSchema, 'createdAt');

export const VpsRun = mongoose.model<IRun>('VpsRun', RunSchema);