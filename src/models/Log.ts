import mongoose, { Schema, Document } from 'mongoose';
import { applyPlanBasedTtl } from '../utils/ttl';

export interface ILogEvent extends Document {
  ownerId: string;
  serviceId?: mongoose.Types.ObjectId;
  serviceModel?: 'ApmService' | 'RumService' | 'TaskService' | 'External';
  traceId?: string;
  spanId?: string;
  // Canonical severity (normalized by src/utils/severity.ts).
  severityText: string;    // 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  severityNumber: number;  // OTLP severity number (1-24)
  level: string;           // Back-compat alias, dual-written equal to severityText
  source: string;          // Ingestion source, e.g. 'external' | 'otlp'
  host?: string;           // Originating host / instance
  environment?: string;    // Deployment environment, e.g. 'production'
  message: string;
  attributes: Record<string, any>;
  timestamp: Date;
  expiresAt?: Date; // Plan-based TTL (anchor: timestamp)
}

const LogEventSchema = new Schema<ILogEvent>({
  ownerId: { type: String, required: true, index: true },
  serviceId: { type: Schema.Types.ObjectId, refPath: 'serviceModel', index: true },
  serviceModel: { type: String, enum: ['ApmService', 'RumService', 'TaskService', 'External'], default: 'External' },
  traceId: { type: String, index: true },
  spanId: { type: String },
  // Canonical severity fields. Kept as plain strings/numbers (no enum) so a stray
  // value can never trigger a silent insertMany drop — normalizeSeverity guarantees
  // canonical values on every write, and Phase 2 adds validated error accounting.
  severityText: { type: String, default: 'info' },
  severityNumber: { type: Number, default: 9 },
  level: { type: String, default: 'info', index: true },
  source: { type: String, default: 'external' },
  host: { type: String },
  environment: { type: String },
  message: { type: String, required: true },
  attributes: { type: Schema.Types.Mixed, default: {} },
  timestamp: { type: Date, required: true }
}, { timestamps: true });

// --- Indexes for Enterprise Performance ---
// 1. Plan-based retention: each log expires at `expiresAt` (timestamp + the
//    owner's plan retention window), with a hard-cap backstop on `timestamp`.
//    See src/utils/ttl.ts and src/config/retention.ts.
applyPlanBasedTtl(LogEventSchema, 'timestamp');

// 2. Compound Index for Dashboard Filtering (legacy `level`).
LogEventSchema.index({ ownerId: 1, timestamp: -1, level: 1 });

// 3. Keyset (cursor) pagination index — sorts by timestamp then _id as a stable
//    tiebreaker for deterministic, O(1) "next page" reads at any depth.
LogEventSchema.index({ ownerId: 1, timestamp: -1, _id: -1 });

// 4. Severity-filtered time queries (e.g. severityNumber >= 17 over a window).
LogEventSchema.index({ ownerId: 1, severityNumber: 1, timestamp: -1 });

// 5. Text Index for Free-Text Message Search
LogEventSchema.index({ message: 'text' });

// 6. Wildcard Index for Dynamic Attribute Search (MongoDB 4.2+)
// Allows efficient lookups for queries like `attributes.userId: 123`
LogEventSchema.index({ 'attributes.$**': 1 });

export const LogEvent = mongoose.model<ILogEvent>('LogEvent', LogEventSchema);

// --- Log Ingestion API Keys (hashed, multi-key, revocable) ---
export interface ILogApiKey extends Document {
  ownerId: string;
  name: string;
  /** SHA-256 hex of the full key. The plaintext is shown once and never stored. */
  keyHash: string;
  /** Display prefix, e.g. 'sz_log_ab12cd' — safe to show in the UI. */
  prefix: string;
  /** Capability scopes; reserved for future granular permissions. */
  scopes: string[];
  lastUsedAt?: Date;
  createdBy?: string;
  revokedAt?: Date | null;
  /**
   * Legacy plaintext key. Only present on records created before the hashed-key
   * migration; retained so the pre-Phase-4 UI can still display them. New keys
   * are hash-only. Removed by a later cleanup migration.
   */
  key?: string;
}

const LogApiKeySchema = new Schema<ILogApiKey>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true, default: 'Default Key' },
  // unique + sparse: enforces uniqueness across present hashes while tolerating
  // the brief window before the backfill populates legacy records.
  keyHash: { type: String, unique: true, sparse: true },
  prefix: { type: String, default: '' },
  scopes: { type: [String], default: ['ingest'] },
  lastUsedAt: { type: Date },
  createdBy: { type: String },
  revokedAt: { type: Date, default: null },
  key: { type: String },
}, { timestamps: true });

export const LogApiKey = mongoose.model<ILogApiKey>('LogApiKey', LogApiKeySchema);

// --- Ingestion Observability: hourly accepted/dropped counters per tenant ---
export interface ILogIngestStat extends Document {
  ownerId: string;
  bucket: Date;     // hour-aligned
  accepted: number;
  dropped: number;
}

const LogIngestStatSchema = new Schema<ILogIngestStat>({
  ownerId: { type: String, required: true },
  bucket: { type: Date, required: true },
  accepted: { type: Number, default: 0 },
  dropped: { type: Number, default: 0 },
}, { timestamps: false });

// One counter doc per tenant per hour (upsert target).
LogIngestStatSchema.index({ ownerId: 1, bucket: 1 }, { unique: true });
// Auto-expire after 8 days (slightly beyond the 7-day log window).
LogIngestStatSchema.index({ bucket: 1 }, { expireAfterSeconds: 8 * 24 * 60 * 60 });

export const LogIngestStat = mongoose.model<ILogIngestStat>('LogIngestStat', LogIngestStatSchema);