import mongoose, { Schema, Document } from 'mongoose';

export interface ISubscription extends Document {
  ownerId: string; // Changed to match Firebase UID typing universally
  planId: string;
  status: 'active' | 'past_due' | 'canceled' | 'trialing';
  provider: 'paddle' | 'stripe' | 'none';

  providerCustomerId?: string;
  providerSubscriptionId?: string;

  currentMonthBytes: number;
  billingCycleReset: Date;

  createdAt: Date;
  updatedAt: Date;
}

const SubscriptionSchema = new Schema<ISubscription>(
  {
    // CRITICAL FIX: type is now String to match the Firebase UID schema used platform-wide
    ownerId: { type: String, required: true, unique: true, index: true },
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