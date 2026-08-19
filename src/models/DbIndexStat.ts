import mongoose, { Schema, Document } from 'mongoose';

// ============================================================================
// Index census.
// ----------------------------------------------------------------------------
// Current state, not a time series: "which indexes exist, are they used, and
// what do they cost" is a question about now. One upserted document per
// instance, matching how DbCollectionStat models the same shape of question.
//
// Usage counters are cumulative since the server last started, which is exactly
// what "never used" needs — a per-interval delta could not distinguish an index
// nothing touched this hour from one nothing has ever touched. `serverUptime`
// is recorded alongside so the UI can say how long that judgement covers; an
// index unused for eleven minutes is not evidence of anything.
// ============================================================================

export type IndexFlag = 'unused' | 'redundant' | 'duplicate' | 'rarely-used' | 'oversized';

export interface IIndexEntry {
  namespace: string;
  name: string;
  /** Human-readable definition, e.g. `{ email: 1, createdAt: -1 }` or `(a, b)`. */
  definition: string;
  /** Ordered key names — the basis for prefix-redundancy analysis. */
  keys: string[];
  unique: boolean;
  primary: boolean;
  partial: boolean;
  sizeBytes: number;
  /** Cumulative scans since the server started. */
  scans: number;
  flags: IndexFlag[];
  /** When redundant, the index that already covers this one. */
  redundantWith?: string;
}

export interface IDbIndexStat extends Document {
  dbId: mongoose.Types.ObjectId;
  collectedAt: Date;
  /** Seconds the instance had been up when counters were read. */
  serverUptimeSeconds: number;
  indexes: IIndexEntry[];
  /** Totals, precomputed so the list view needs no client-side reduction. */
  totalIndexes: number;
  totalSizeBytes: number;
  unusedSizeBytes: number;
}

const IndexEntrySchema = new Schema<IIndexEntry>({
  namespace: { type: String, required: true },
  name: { type: String, required: true },
  definition: { type: String, default: '' },
  keys: [{ type: String }],
  unique: { type: Boolean, default: false },
  primary: { type: Boolean, default: false },
  partial: { type: Boolean, default: false },
  sizeBytes: { type: Number, default: 0 },
  scans: { type: Number, default: 0 },
  flags: [{ type: String }],
  redundantWith: { type: String },
}, { _id: false });

const DbIndexStatSchema = new Schema<IDbIndexStat>({
  dbId: { type: Schema.Types.ObjectId, ref: 'DatabaseService', required: true, unique: true },
  collectedAt: { type: Date, required: true },
  serverUptimeSeconds: { type: Number, default: 0 },
  indexes: [IndexEntrySchema],
  totalIndexes: { type: Number, default: 0 },
  totalSizeBytes: { type: Number, default: 0 },
  unusedSizeBytes: { type: Number, default: 0 },
});

export const DbIndexStat = mongoose.model<IDbIndexStat>('DbIndexStat', DbIndexStatSchema);
