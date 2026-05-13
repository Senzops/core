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
    const exists = await Subscription.exists({ ownerId: doc.firebaseUid });
    if (exists) return;

    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);

    await Subscription.create({
      ownerId: doc.firebaseUid,
      planId: 'starter',
      status: 'active',
      provider: 'none',
      billingInterval: 'monthly',
      startedAt: new Date(),
      currentMonthBytes: 0,
      quotaResetAt: nextMonth,       // Populates the Quota Cycle
      billingCycleReset: nextMonth   // Populates the Renewal Cycle
    });

    logger.info(`[Billing] Provisioned 'starter' subscription for new user: ${doc.firebaseUid}`);
  } catch (error: any) {
    logger.error(`[Billing] CRITICAL: Failed to provision subscription for ${doc.firebaseUid}: ${error.message}`);
  }
});

export const User = mongoose.model<IUser>('User', UserSchema);