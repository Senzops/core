import mongoose, { Schema, Document } from 'mongoose';
import { Subscription } from './Subscription';
import { logger } from '../utils/logger';

export interface IUser extends Document {
  firebaseUid: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>({
  firebaseUid: { type: String, required: true, unique: true, index: true },
  email: { type: String, required: true },
}, { timestamps: true });

// ============================================================================
// ENTERPRISE HOOK: Auto-Provision Billing Profile
// ============================================================================
UserSchema.post('save', async function (doc) {
  try {
    // Check if subscription already exists (idempotency)
    const exists = await Subscription.exists({ ownerId: doc._id });
    if (exists) return;

    // Set the billing cycle reset to exactly 1 month from now
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);

    await Subscription.create({
      ownerId: doc._id,
      planId: 'starter',
      status: 'active',
      provider: 'none', // 'none' because Starter is free and unlinked to an MoR
      currentMonthBytes: 0,
      billingCycleReset: nextMonth
    });

    logger.info(`[Billing] Provisioned 'starter' subscription for new user: ${doc._id}`);
  } catch (error: any) {
    logger.error(`[Billing] CRITICAL: Failed to provision subscription for ${doc._id}: ${error.message}`);
  }
});

export const User = mongoose.model<IUser>('User', UserSchema);