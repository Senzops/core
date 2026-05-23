import cron from 'node-cron';
import { Subscription } from '../models/Subscription';
import { logger } from '../utils/logger';

export const startBillingCron = () => {
  cron.schedule('*/15 * * * *', async () => {
    try {
      const now = new Date();
      
      const cursor = Subscription.find({
        $or: [
          { quotaResetAt: { $lte: now } },
          { billingCycleReset: { $lte: now }, provider: 'none' },
          { status: 'canceled', cancelEffectiveAt: { $lte: now }, planId: { $ne: 'starter' } },
        ]
      }).cursor();
      
      const bulkOps = [];
      let processed = 0;

      for await (const sub of cursor) {
        const updateFields: any = {};
        
        // --- 1. Monthly Quota Reset (Regardless of Plan or Provider) ---
        if (sub.quotaResetAt && sub.quotaResetAt <= now) {
          const nextQuota = new Date(sub.quotaResetAt);
          // Safely fast-forward past the current date to prevent infinite loops on stalled accounts
          while (nextQuota <= now) {
            nextQuota.setMonth(nextQuota.getMonth() + 1);
          }
          updateFields.currentMonthBytes = 0;
          updateFields.quotaResetAt = nextQuota;
        }

        // --- 2. Auto-Renewal for Internal Plans (Starter / Enterprise) ---
        if (sub.provider === 'none' && sub.billingCycleReset && sub.billingCycleReset <= now) {
          const nextBilling = new Date(sub.billingCycleReset);
          while (nextBilling <= now) {
            if (sub.billingInterval === 'annual') {
              nextBilling.setFullYear(nextBilling.getFullYear() + 1);
            } else {
              nextBilling.setMonth(nextBilling.getMonth() + 1);
            }
          }
          updateFields.billingCycleReset = nextBilling;
          updateFields.status = 'active'; // Guarantee active status
        }

        // --- 3. Downgrade Canceled Subscriptions Past Their Effective Date ---
        if (sub.status === 'canceled' && sub.cancelEffectiveAt && sub.cancelEffectiveAt <= now && sub.planId !== 'starter') {
          updateFields.planId = 'starter';
          updateFields.provider = 'none';
          updateFields.billingInterval = 'monthly';
          updateFields.providerSubscriptionId = null;
          updateFields.providerCustomerId = null;
          updateFields.currentMonthBytes = 0;
          const nextBilling = new Date(now);
          nextBilling.setMonth(nextBilling.getMonth() + 1);
          updateFields.billingCycleReset = nextBilling;
          updateFields.quotaResetAt = nextBilling;
          logger.info(`[Worker] Downgrading canceled subscription for ${sub.ownerId} to starter`);
        }

        if (Object.keys(updateFields).length > 0) {
          bulkOps.push({
            updateOne: {
              filter: { _id: sub._id },
              update: { $set: updateFields }
            }
          });
          processed++;
        }

        // Write safely to MongoDB in batches of 500
        if (bulkOps.length >= 500) {
          await Subscription.bulkWrite(bulkOps, { ordered: false });
          bulkOps.length = 0; // Flush array memory
        }
      }

      // Execute remaining batch
      if (bulkOps.length > 0) {
        await Subscription.bulkWrite(bulkOps, { ordered: false });
      }

      if (processed > 0) {
        logger.info(`[Worker] Processed ${processed} subscription renewals/quota resets.`);
      }
    } catch (error) {
      logger.error('[Worker] Billing cron encountered an unhandled exception:', error);
    }
  }, {
    name: 'senzor-billing-worker',
    timezone: 'UTC'
  });
  
  logger.info('[Worker] Billing & Quota Engine scheduled.');
};