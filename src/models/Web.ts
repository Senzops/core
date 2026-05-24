import mongoose, { Schema, Document } from 'mongoose';

// --- Website Registry Schema ---
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

// --- Web Event Schema ---
export interface IWebEvent extends Document {
  webId: mongoose.Types.ObjectId;
  visitorId: string;
  sessionId: string;
  type: 'pageview' | 'ping';
  url: string;
  path: string;
  title: string;
  referrer: string;
  channel: string;
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
  title: { type: String, index: true },
  referrer: { type: String, index: true },
  channel: { type: String, index: true },
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

/**
 * Metrics
 */
export interface IWebMetric extends Document {
  webId: mongoose.Types.ObjectId;
  timestamp: Date; // Minute bucket
  
  // Counters
  views: number;
  durationSum: number; // For Avg Duration calculation
  
  // Dimensions (Maps for High Cardinality)
  paths: Map<string, number>;
  referrers: Map<string, number>;
  channels: Map<string, number>; // Search, Direct, Social
  
  // Context
  countries: Map<string, number>;
  cities: Map<string, number>;
  browsers: Map<string, number>;
  os: Map<string, number>;
  devices: Map<string, number>;
}

const WebMetricSchema = new Schema<IWebMetric>({
  webId: { type: Schema.Types.ObjectId, ref: 'Website', required: true },
  timestamp: { type: Date, required: true },
  
  views: { type: Number, default: 0 },
  durationSum: { type: Number, default: 0 },
  
  paths: { type: Map, of: Number, default: {} },
  referrers: { type: Map, of: Number, default: {} },
  channels: { type: Map, of: Number, default: {} },
  
  countries: { type: Map, of: Number, default: {} },
  cities: { type: Map, of: Number, default: {} },
  browsers: { type: Map, of: Number, default: {} },
  os: { type: Map, of: Number, default: {} },
  devices: { type: Map, of: Number, default: {} },
});

// Compound unique index — prevents duplicate metric buckets under concurrency
WebMetricSchema.index({ webId: 1, timestamp: 1 }, { unique: true });

// TTL: Keep aggregated stats for 32 days
WebMetricSchema.index({ timestamp: 1 }, { expireAfterSeconds: 2764800 });

export const WebMetric = mongoose.model<IWebMetric>('WebMetric', WebMetricSchema);