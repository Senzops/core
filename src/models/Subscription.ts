import mongoose, { Schema, Document } from 'mongoose';

export interface ISubscription extends Document {
  ownerId: string;
  planId: string;
  status: 'active' | 'past_due' | 'canceled' | 'on_hold' | 'trialing';
  provider: 'paddle' | 'dodo' | 'stripe' | 'none';

  providerCustomerId?: string;
  providerSubscriptionId?: string;

  billingInterval: 'monthly' | 'annual';
  startedAt: Date;

  currentMonthBytes: number;
  quotaResetAt: Date;
  billingCycleReset: Date;

  cancelRequestedAt?: Date;
  cancelEffectiveAt?: Date;
  onHoldSince?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const SubscriptionSchema = new Schema<ISubscription>(
  {
    ownerId: { type: String, required: true, unique: true, index: true },
    planId: { type: String, required: true, default: 'starter' },
    status: { type: String, enum: ['active', 'past_due', 'canceled', 'on_hold', 'trialing'], required: true, default: 'active' },
    provider: { type: String, enum: ['paddle', 'dodo', 'stripe', 'none'], default: 'none' },

    providerCustomerId: { type: String },
    providerSubscriptionId: { type: String, index: true },

    billingInterval: { type: String, enum: ['monthly', 'annual'], default: 'monthly' },
    startedAt: { type: Date, default: Date.now },

    currentMonthBytes: { type: Number, default: 0, min: 0 },
    quotaResetAt: { type: Date, required: true },
    billingCycleReset: { type: Date, required: true },

    cancelRequestedAt: { type: Date },
    cancelEffectiveAt: { type: Date },
    onHoldSince: { type: Date },
  },
  { timestamps: true }
);

// Indexes for ultra-fast background cron evaluation
SubscriptionSchema.index({ quotaResetAt: 1 });
SubscriptionSchema.index({ billingCycleReset: 1 });

export const Subscription = mongoose.model<ISubscription>('Subscription', SubscriptionSchema);