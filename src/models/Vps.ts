import mongoose, { Schema, Document } from 'mongoose';

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
}

const RunSchema = new Schema<IRun>({
  vpsId: { type: Schema.Types.ObjectId, ref: 'Vps', required: true, index: true },
  metrics: { type: Object, required: true },
}, { timestamps: true });

// CRITICAL: Auto-delete documents after 24 hours (86400 seconds)
RunSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

export const Run = mongoose.model<IRun>('Run', RunSchema);