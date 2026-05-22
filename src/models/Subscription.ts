import mongoose, { Schema, Document } from 'mongoose';

export interface ISubscription extends Document {
  ownerId: string;
  planId: string;
  status: 'active' | 'past_due' | 'canceled' | 'trialing';
  provider: 'paddle' | 'dodo' | 'stripe' | 'none';

  providerCustomerId?: string;
  providerSubscriptionId?: string;

  // Enterprise Billing Mechanics
  billingInterval: 'monthly' | 'annual';
  startedAt: Date;

  currentMonthBytes: number;
  quotaResetAt: Date;        // Strict monthly data cycle
  billingCycleReset: Date;   // Payment/Renewal cycle

  createdAt: Date;
  updatedAt: Date;
}

const SubscriptionSchema = new Schema<ISubscription>(
  {
    ownerId: { type: String, required: true, unique: true, index: true },
    planId: { type: String, required: true, default: 'starter' },
    status: { type: String, required: true, default: 'active' },
    provider: { type: String, enum: ['paddle', 'dodo', 'stripe', 'none'], default: 'none' },

    providerCustomerId: { type: String },
    providerSubscriptionId: { type: String, index: true },

    billingInterval: { type: String, enum: ['monthly', 'annual'], default: 'monthly' },
    startedAt: { type: Date, default: Date.now },

    currentMonthBytes: { type: Number, default: 0, min: 0 },
    quotaResetAt: { type: Date, required: true },
    billingCycleReset: { type: Date, required: true },
  },
  { timestamps: true }
);

// Indexes for ultra-fast background cron evaluation
SubscriptionSchema.index({ quotaResetAt: 1 });
SubscriptionSchema.index({ billingCycleReset: 1 });

export const Subscription = mongoose.model<ISubscription>('Subscription', SubscriptionSchema);