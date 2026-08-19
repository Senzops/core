import mongoose, { Schema, Document } from 'mongoose';
import { applyPlanBasedTtl } from '../utils/ttl';

// ============================================================================
// Query insight models.
// ----------------------------------------------------------------------------
// Two shapes, because operators ask two different questions:
//
//   DbQueryStat — "which query SHAPES cost the most over this window?"
//     One row per (instance, digest, collection interval), holding the DELTA
//     for that interval. Storing deltas rather than a running total is what
//     makes a time range answerable: summing rows across the range gives the
//     cost within it, and a single digest's rows form its trend.
//
//   DbSlowOp — "what exactly ran slowly, and when?"
//     Individual operations above a threshold. This is the profiler view.
//
// Query text in both is normalized and redacted before it ever reaches this
// file — see worker/database/redact.ts. Literals from a customer's database are
// user data, and a monitoring product has no business durably storing them.
// ============================================================================

export type DbQueryOperation =
  | 'select' | 'insert' | 'update' | 'delete'
  | 'aggregate' | 'command' | 'other';

export interface IDbQueryStat extends Document {
  dbId: mongoose.Types.ObjectId;
  timestamp: Date;
  expiresAt?: Date;
  /** Stable identity for a query shape, from the engine where it supplies one. */
  digestHash: string;
  /** Normalized, redacted representation. Never raw customer literals. */
  queryText: string;
  /** Collection / table the shape touches, where the engine attributes one. */
  namespace?: string;
  operation: DbQueryOperation;

  /** Executions within this interval. */
  executions: number;
  totalTimeMs: number;
  meanTimeMs: number;
  maxTimeMs: number;
  /** Only where the engine reports a distribution; absent is not zero. */
  p95TimeMs?: number;

  rowsReturned?: number;
  rowsExamined?: number;
  /** Rows read per row delivered — the index-health headline for a shape. */
  examinedPerReturned?: number;

  /** PostgreSQL buffer accounting. */
  blocksHit?: number;
  blocksRead?: number;
  tempBlocks?: number;
  /** MongoDB plan summary, e.g. COLLSCAN / IXSCAN { field: 1 }. */
  planSummary?: string;
}

const DbQueryStatSchema = new Schema<IDbQueryStat>({
  dbId: { type: Schema.Types.ObjectId, ref: 'DatabaseService', required: true },
  timestamp: { type: Date, required: true },
  digestHash: { type: String, required: true },
  queryText: { type: String, required: true },
  namespace: { type: String },
  operation: {
    type: String,
    enum: ['select', 'insert', 'update', 'delete', 'aggregate', 'command', 'other'],
    default: 'other',
  },
  executions: { type: Number, default: 0 },
  totalTimeMs: { type: Number, default: 0 },
  meanTimeMs: { type: Number, default: 0 },
  maxTimeMs: { type: Number, default: 0 },
  p95TimeMs: { type: Number },
  rowsReturned: { type: Number },
  rowsExamined: { type: Number },
  examinedPerReturned: { type: Number },
  blocksHit: { type: Number },
  blocksRead: { type: Number },
  tempBlocks: { type: Number },
  planSummary: { type: String },
});

// Range scans for the insights table, and per-digest trend lookups.
DbQueryStatSchema.index({ dbId: 1, timestamp: -1 });
DbQueryStatSchema.index({ dbId: 1, digestHash: 1, timestamp: -1 });
applyPlanBasedTtl(DbQueryStatSchema, 'timestamp');

export interface IDbSlowOp extends Document {
  dbId: mongoose.Types.ObjectId;
  timestamp: Date;
  expiresAt?: Date;
  durationMs: number;
  operation: DbQueryOperation;
  namespace?: string;
  queryText: string;
  /** Links an individual operation back to its shape in DbQueryStat. */
  digestHash?: string;
  planSummary?: string;
  docsExamined?: number;
  docsReturned?: number;
  keysExamined?: number;
  /** Application/user attribution where the engine exposes it, never raw hosts. */
  source?: string;
}

const DbSlowOpSchema = new Schema<IDbSlowOp>({
  dbId: { type: Schema.Types.ObjectId, ref: 'DatabaseService', required: true },
  timestamp: { type: Date, required: true },
  durationMs: { type: Number, required: true },
  operation: {
    type: String,
    enum: ['select', 'insert', 'update', 'delete', 'aggregate', 'command', 'other'],
    default: 'other',
  },
  namespace: { type: String },
  queryText: { type: String, required: true },
  digestHash: { type: String },
  planSummary: { type: String },
  docsExamined: { type: Number },
  docsReturned: { type: Number },
  keysExamined: { type: Number },
  source: { type: String },
});

DbSlowOpSchema.index({ dbId: 1, timestamp: -1 });
DbSlowOpSchema.index({ dbId: 1, durationMs: -1 });
applyPlanBasedTtl(DbSlowOpSchema, 'timestamp');

export const DbQueryStat = mongoose.model<IDbQueryStat>('DbQueryStat', DbQueryStatSchema);
export const DbSlowOp = mongoose.model<IDbSlowOp>('DbSlowOp', DbSlowOpSchema);
