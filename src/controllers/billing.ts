import { Request, Response } from 'express';
import { PLANS, getPlanConfig } from '../config/pricing';
import { Subscription } from '../models/Subscription';
import { logger } from '../utils/logger';

/**
 * GET /api/billing/plans
 * Exposes the active plans and limits to the Frontend Pricing Page.
 */
export const getActivePlans = async (req: Request, res: Response) => {
  try {
    const publicPlans = Object.values(PLANS).map(plan => ({
      id: plan.id,
      name: plan.name,
      priceMonthly: plan.priceMonthly,
      priceAnnual: plan.priceAnnual,
      maxServicesPerType: plan.maxServicesPerType,
      maxIngestionBytes: plan.maxIngestionBytes,
      retentionDays: plan.retentionDays,
      paddlePriceIdMonthly: plan.paddlePriceIdMonthly,
      paddlePriceIdAnnual: plan.paddlePriceIdAnnual
    }));

    res.json({ plans: publicPlans });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch pricing plans." });
  }
};

/**
 * GET /api/billing/subscription
 * Returns the active user's current subscription and usage.
 * Features JIT (Just-In-Time) provisioning for legacy users.
 */
export const getCurrentSubscription = async (req: Request, res: Response) => {
  try {
    // Safely capture Firebase UID or Mongo _id depending on your auth payload structure
    const ownerId = (req as any).user?.uid || (req as any).user?._id;

    // Explicitly type as 'any' to bypass Mongoose's strict union types between .lean() and .toObject()
    let sub: any = await Subscription.findOne({ ownerId }).lean();

    // --- ENTERPRISE FIX: JIT Legacy User Auto-Provisioning ---
    // If the user registered before the billing system was deployed, they won't 
    // have a Subscription document. We silently create their free tier here.
    if (!sub) {
      logger.info(`[Billing] Legacy user detected (${ownerId}). Auto-provisioning Starter plan.`);

      const nextMonth = new Date();
      nextMonth.setMonth(nextMonth.getMonth() + 1);

      const newSub = await Subscription.create({
        ownerId: ownerId,
        planId: 'starter',
        status: 'active',
        provider: 'none',
        currentMonthBytes: 0,
        billingCycleReset: nextMonth
      });

      // Convert the Mongoose document back to a plain object to match the `.lean()` format
      sub = newSub.toObject();
    }

    const plan = getPlanConfig(sub.planId);

    res.json({
      subscription: sub,
      plan: {
        name: plan.name,
        maxIngestionBytes: plan.maxIngestionBytes,
        maxServicesPerType: plan.maxServicesPerType
      }
    });
  } catch (error: any) {
    logger.error(`[Billing] Failed to fetch/provision subscription: ${error.message}`);
    res.status(500).json({ error: "Failed to fetch subscription." });
  }
};

/**
 * POST /api/billing/paddle-webhook
 * Zero-Trust Webhook Receiver. This is hit by Paddle's servers, NOT your frontend.
 */
export const handlePaddleWebhook = async (req: Request, res: Response) => {
  try {
    // 1. Verify Paddle Signature 
    // (Requires raw body parsing usually. Check Paddle docs for your specific framework setup)
    const signature = req.headers['paddle-signature'];
    if (!signature) {
      logger.warn('[Billing Webhook] Blocked unsigned Paddle webhook attempt.');
      return res.status(401).send('Unauthorized');
    }

    const event = req.body;
    const eventType = event.event_type; // e.g., 'subscription.activated', 'subscription.updated'
    const payload = event.data;

    logger.info(`[Billing Webhook] Received ${eventType} for Customer: ${payload.customer_id}`);

    // Paddle allows passing 'custom_data' during checkout. 
    // We pass the user._id in custom_data from the frontend so Paddle returns it to us here.
    const ownerId = payload.custom_data?.ownerId;

    if (!ownerId) {
      logger.error('[Billing Webhook] CRITICAL: Webhook received without custom_data.ownerId attached.');
      return res.status(400).send('Missing ownerId in custom_data');
    }

    // --- THE FIX: Map Paddle Product/Price IDs to our internal Plan IDs ---
    const incomingPriceId = payload.items?.[0]?.price?.id || payload.items?.[0]?.product?.id;

    const matchedPlan = Object.values(PLANS).find(p =>
      p.paddlePriceIdMonthly === incomingPriceId ||
      p.paddlePriceIdAnnual === incomingPriceId
    );

    const targetPlanId = matchedPlan ? matchedPlan.id : 'starter';

    // 2. Handle Subscription Lifecycle Events
    if (eventType === 'subscription.activated' || eventType === 'subscription.updated') {
      const nextBillingDate = new Date(payload.current_billing_period.ends_at);

      await Subscription.findOneAndUpdate(
        { ownerId },
        {
          $set: {
            planId: targetPlanId,
            status: payload.status === 'active' ? 'active' : 'past_due',
            provider: 'paddle',
            providerCustomerId: payload.customer_id,
            providerSubscriptionId: payload.id,
            billingCycleReset: nextBillingDate
          }
        },
        { upsert: true }
      );
      logger.info(`[Billing Webhook] Upgraded user ${ownerId} to plan: ${targetPlanId}`);
    }
    else if (eventType === 'subscription.canceled' || eventType === 'subscription.past_due') {
      await Subscription.findOneAndUpdate(
        { ownerId },
        { $set: { status: eventType === 'subscription.canceled' ? 'canceled' : 'past_due' } }
      );
      logger.warn(`[Billing Webhook] Downgraded/Canceled user ${ownerId}`);
    }

    // Acknowledge receipt to Paddle
    res.status(200).send('OK');
  } catch (error: any) {
    logger.error(`[Billing Webhook] Error: ${error.message}`);
    res.status(500).send('Webhook Processing Failed');
  }
};