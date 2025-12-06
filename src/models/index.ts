import mongoose, { Schema, Document } from 'mongoose';

// --- 1. User Schema ---
export interface IUser extends Document {
  firebaseUid: string;
  email: string;
  createdAt: Date;
}

const UserSchema = new Schema<IUser>({
  firebaseUid: { type: String, required: true, unique: true, index: true },
  email: { type: String, required: true },
}, { timestamps: true });

export const User = mongoose.model<IUser>('User', UserSchema);

// --- 2. VPS Schema ---
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
}

const VpsSchema = new Schema<IVps>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  apiKey: { type: String, required: true, select: false }, // Hidden by default
  status: { type: String, enum: ['online', 'offline'], default: 'offline' },
  lastSeen: { type: Date, default: null },
  metadata: { type: Object, default: {} }
}, { timestamps: true });

export const Vps = mongoose.model<IVps>('Vps', VpsSchema);

// --- 3. Telemetry (Run) Schema ---
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

// --- 4. Website Registry Schema ---
export interface IWebsite extends Document {
  ownerId: string; // Firebase UID
  name: string;    // e.g. "My Portfolio"
  domain: string;  // e.g. "senzor.dev"
  createdAt: Date;
}

const WebsiteSchema = new Schema<IWebsite>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  domain: { type: String, required: true }, // Used for CORS checks later if needed
}, { timestamps: true });

export const Website = mongoose.model<IWebsite>('Website', WebsiteSchema);

// --- 5. Web Event Schema ---
export interface IWebEvent extends Document {
  webId: mongoose.Types.ObjectId;
  visitorId: string;
  sessionId: string;
  type: 'pageview' | 'ping';
  url: string;
  path: string;
  referrer: string;
  duration: number; // In seconds

  // Enriched Data
  browser: string;
  os: string;
  device: string; // desktop, mobile, tablet
  country: string;
  city: string;

  createdAt: Date;
}

const WebEventSchema = new Schema<IWebEvent>({
  webId: { type: Schema.Types.ObjectId, ref: 'Website', required: true, index: true },
  visitorId: { type: String, required: true, index: true }, // For Unique Visitors
  sessionId: { type: String, required: true, index: true }, // For Sessions/Bounce Rate
  type: { type: String, enum: ['pageview', 'ping'], required: true },

  url: String,
  path: { type: String, index: true }, // Index for Top Pages query
  referrer: String,
  duration: { type: Number, default: 0 },

  // Metadata
  browser: String,
  os: String,
  device: String,
  country: String,
  city: String,

}, { timestamps: true });

// TTL Index: Delete logs after 30 days (2592000 seconds)
WebEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2592000 });

export const WebEvent = mongoose.model<IWebEvent>('WebEvent', WebEventSchema);