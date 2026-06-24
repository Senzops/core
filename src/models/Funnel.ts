import mongoose, { Schema, Document } from 'mongoose';

/**
 * Funnel — a saved, ordered conversion path for a website.
 *
 * Each step matches either a pageview (by path) or a custom event (by name).
 * A single-step funnel is effectively a Goal; two or more steps form a true
 * conversion funnel. Definitions are permanent until deleted (not plan-based
 * telemetry), so they carry no TTL. Results are computed on demand from the
 * WebEvent firehose and cached separately.
 */

export type FunnelStepType = 'page' | 'event';
export type FunnelMatchMode = 'exact' | 'contains' | 'startsWith';

export interface IFunnelStep {
  type: FunnelStepType;
  value: string;            // path (for 'page') or eventName (for 'event')
  match: FunnelMatchMode;   // path matching mode (ignored for 'event')
  label?: string;           // optional display label
}

export interface IFunnel extends Document {
  ownerId: string;
  webId: mongoose.Types.ObjectId;
  name: string;
  steps: IFunnelStep[];
  createdAt: Date;
  updatedAt: Date;
}

const FunnelStepSchema = new Schema<IFunnelStep>({
  type: { type: String, enum: ['page', 'event'], required: true },
  value: { type: String, required: true },
  match: { type: String, enum: ['exact', 'contains', 'startsWith'], default: 'exact' },
  label: { type: String },
}, { _id: false });

const FunnelSchema = new Schema<IFunnel>({
  ownerId: { type: String, required: true, index: true },
  webId: { type: Schema.Types.ObjectId, ref: 'Website', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  steps: { type: [FunnelStepSchema], required: true },
}, { timestamps: true });

// Listing a site's funnels within a workspace.
FunnelSchema.index({ ownerId: 1, webId: 1, createdAt: -1 });

export const Funnel = mongoose.model<IFunnel>('Funnel', FunnelSchema);
