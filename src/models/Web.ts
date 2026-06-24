import mongoose, { Schema, Document } from 'mongoose';
import { applyPlanBasedTtl } from '../utils/ttl';

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

// --- UTM / Campaign attribution (parsed server-side from the landing URL) ---
export interface IUtm {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
}

const UtmSchema = new Schema<IUtm>({
  source: String,
  medium: String,
  campaign: String,
  term: String,
  content: String,
}, { _id: false });

// --- Web Event Schema ---
export interface IWebEvent extends Document {
  webId: mongoose.Types.ObjectId;
  visitorId: string;
  sessionId: string;
  type: 'pageview' | 'ping' | 'event';
  eventName?: string; // Present only for custom events (type === 'event')
  url: string;
  path: string;
  title: string;
  referrer: string;
  channel: string;
  utm?: IUtm;
  duration: number; // In seconds

  // Enriched Data
  browser: string;
  os: string;
  device: string; // desktop, mobile, tablet
  country: string;
  region: string;  // Subdivision / state
  city: string;
  language: string; // BCP-47 tag, e.g. "en-US"
  screen: string;   // Resolution bucket, e.g. "1920x1080"

  createdAt: Date;
  expiresAt?: Date; // Plan-based TTL (anchor: createdAt)
}

const WebEventSchema = new Schema<IWebEvent>({
  webId: { type: Schema.Types.ObjectId, ref: 'Website', required: true, index: true },
  visitorId: { type: String, required: true, index: true }, // For Unique Visitors
  sessionId: { type: String, required: true, index: true }, // For Sessions/Bounce Rate
  type: { type: String, enum: ['pageview', 'ping', 'event'], required: true },
  eventName: { type: String }, // Sparse-indexed below; only set for custom events

  url: String,
  path: { type: String, index: true }, // Index for Top Pages query
  title: { type: String, index: true },
  referrer: { type: String, index: true },
  channel: { type: String, index: true },
  utm: { type: UtmSchema, default: undefined },
  duration: { type: Number, default: 0 },

  // Metadata
  browser: String,
  os: String,
  device: String,
  country: String,
  region: String,
  city: String,
  language: String,
  screen: String,

}, { timestamps: true });

// Custom-event lookups (top events / event drill-down) within a site + window.
WebEventSchema.index({ webId: 1, eventName: 1, createdAt: -1 }, { sparse: true });

// Filtered (segmented) dashboard scans: narrow by site + type + window, then
// the segmentation filter is applied on the remaining dimensions. A single
// well-chosen compound index (rather than one per dimension) keeps the hot
// write path cheap while still bounding the raw scan.
WebEventSchema.index({ webId: 1, type: 1, createdAt: -1 });

// Plan-based retention (per-document expiresAt + hard-cap backstop on createdAt)
applyPlanBasedTtl(WebEventSchema, 'createdAt');

export const WebEvent = mongoose.model<IWebEvent>('WebEvent', WebEventSchema);

/**
 * Web Event Data — typed custom-event properties.
 *
 * Each property of a custom event is stored as its own document (the Umami
 * `event_data` pattern) so high-cardinality, schema-less properties never bloat
 * the hot WebEvent doc and can be aggregated into per-property value breakdowns.
 * Exactly one of stringValue / numberValue / boolValue / dateValue is populated,
 * indicated by `dataType`.
 */
export type WebEventDataType = 'string' | 'number' | 'boolean' | 'date';

export interface IWebEventData extends Document {
  webId: mongoose.Types.ObjectId;
  eventId: mongoose.Types.ObjectId;
  eventName: string;
  key: string;
  dataType: WebEventDataType;
  stringValue?: string;
  numberValue?: number;
  boolValue?: boolean;
  dateValue?: Date;
  createdAt: Date;
  expiresAt?: Date; // Plan-based TTL (anchor: createdAt)
}

const WebEventDataSchema = new Schema<IWebEventData>({
  webId: { type: Schema.Types.ObjectId, ref: 'Website', required: true },
  eventId: { type: Schema.Types.ObjectId, ref: 'WebEvent', required: true, index: true },
  eventName: { type: String, required: true },
  key: { type: String, required: true },
  dataType: { type: String, enum: ['string', 'number', 'boolean', 'date'], required: true },
  stringValue: String,
  numberValue: Number,
  boolValue: Boolean,
  dateValue: Date,
}, { timestamps: { createdAt: true, updatedAt: false } });

// Property value breakdown for a given event within a site + window.
WebEventDataSchema.index({ webId: 1, eventName: 1, key: 1, createdAt: -1 });

// Plan-based retention (per-document expiresAt + hard-cap backstop on createdAt)
applyPlanBasedTtl(WebEventDataSchema, 'createdAt');

export const WebEventData = mongoose.model<IWebEventData>('WebEventData', WebEventDataSchema);

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

  // Custom events (eventName -> count). Counted independently of `views`.
  events: Map<string, number>;

  // Campaign attribution
  utmSources: Map<string, number>;
  utmMediums: Map<string, number>;
  utmCampaigns: Map<string, number>;

  // Context
  countries: Map<string, number>;
  regions: Map<string, number>;
  cities: Map<string, number>;
  browsers: Map<string, number>;
  os: Map<string, number>;
  devices: Map<string, number>;
  languages: Map<string, number>;
  screens: Map<string, number>;

  expiresAt?: Date; // Plan-based TTL (anchor: timestamp)
}

const WebMetricSchema = new Schema<IWebMetric>({
  webId: { type: Schema.Types.ObjectId, ref: 'Website', required: true },
  timestamp: { type: Date, required: true },
  
  views: { type: Number, default: 0 },
  durationSum: { type: Number, default: 0 },
  
  paths: { type: Map, of: Number, default: {} },
  referrers: { type: Map, of: Number, default: {} },
  channels: { type: Map, of: Number, default: {} },

  events: { type: Map, of: Number, default: {} },

  utmSources: { type: Map, of: Number, default: {} },
  utmMediums: { type: Map, of: Number, default: {} },
  utmCampaigns: { type: Map, of: Number, default: {} },

  countries: { type: Map, of: Number, default: {} },
  regions: { type: Map, of: Number, default: {} },
  cities: { type: Map, of: Number, default: {} },
  browsers: { type: Map, of: Number, default: {} },
  os: { type: Map, of: Number, default: {} },
  devices: { type: Map, of: Number, default: {} },
  languages: { type: Map, of: Number, default: {} },
  screens: { type: Map, of: Number, default: {} },
});

// Compound unique index — prevents duplicate metric buckets under concurrency
WebMetricSchema.index({ webId: 1, timestamp: 1 }, { unique: true });

// Plan-based retention (per-document expiresAt + hard-cap backstop on timestamp)
applyPlanBasedTtl(WebMetricSchema, 'timestamp');

export const WebMetric = mongoose.model<IWebMetric>('WebMetric', WebMetricSchema);

/**
 * Web Annotation — a dated note overlaid on the analytics timeline (e.g. a
 * deploy, a campaign launch, an outage). A definition, not telemetry, so it
 * carries no TTL and persists until deleted.
 */
export interface IWebAnnotation extends Document {
  ownerId: string;
  webId: mongoose.Types.ObjectId;
  date: Date;
  text: string;
  color?: string;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const WebAnnotationSchema = new Schema<IWebAnnotation>({
  ownerId: { type: String, required: true, index: true },
  webId: { type: Schema.Types.ObjectId, ref: 'Website', required: true, index: true },
  date: { type: Date, required: true },
  text: { type: String, required: true, trim: true, maxlength: 200 },
  color: { type: String, maxlength: 9 },
  createdBy: { type: String },
}, { timestamps: true });

// Range lookup of a site's annotations within a workspace.
WebAnnotationSchema.index({ ownerId: 1, webId: 1, date: 1 });

export const WebAnnotation = mongoose.model<IWebAnnotation>('WebAnnotation', WebAnnotationSchema);

/**
 * Web API Key — grants programmatic, read-only access to one website's analytics
 * through the public `/api/v1/web` query API. Only the SHA-256 hash is stored;
 * the plaintext is shown once at creation (GitHub PAT / Stripe model).
 */
export interface IWebApiKey extends Document {
  ownerId: string;
  webId: mongoose.Types.ObjectId;
  name: string;
  keyHash: string;
  prefix: string;        // First chars of the raw key, safe to display.
  status: 'active' | 'revoked';
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const WebApiKeySchema = new Schema<IWebApiKey>({
  ownerId: { type: String, required: true, index: true },
  webId: { type: Schema.Types.ObjectId, ref: 'Website', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  keyHash: { type: String, required: true, unique: true, index: true },
  prefix: { type: String, required: true },
  status: { type: String, enum: ['active', 'revoked'], default: 'active' },
  lastUsedAt: { type: Date },
}, { timestamps: true });

export const WebApiKey = mongoose.model<IWebApiKey>('WebApiKey', WebApiKeySchema);