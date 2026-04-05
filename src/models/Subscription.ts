import mongoose, { Schema, Document } from 'mongoose';

export interface ISubscription extends Document {
  ownerId: mongoose.Types.ObjectId; // Links to User or Workspace
  planId: string;
  status: 'active' | 'past_due' | 'canceled' | 'trialing';
  provider: 'paddle' | 'stripe' | 'none';

  // Provider Specifics
  providerCustomerId?: string;
  providerSubscriptionId?: string;

  // Usage Tracking
  currentMonthBytes: number;
  billingCycleReset: Date;

  createdAt: Date;
  updatedAt: Date;
}

const SubscriptionSchema = new Schema<ISubscription>(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, unique: true, index: true },
    planId: { type: String, required: true, default: 'starter' },
    status: { type: String, required: true, default: 'active' },
    provider: { type: String, enum: ['paddle', 'stripe', 'none'], default: 'none' },

    providerCustomerId: { type: String },
    providerSubscriptionId: { type: String, index: true },

    currentMonthBytes: { type: Number, default: 0, min: 0 },
    billingCycleReset: { type: Date, required: true },
  },
  { timestamps: true }
);

// Indexes for fast lookup during ingestion and background resets
SubscriptionSchema.index({ billingCycleReset: 1 });

export const Subscription = mongoose.model<ISubscription>('Subscription', SubscriptionSchema);