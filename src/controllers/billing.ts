import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { PLANS, getPlanConfig } from '../config/pricing';
import { Subscription } from '../models/Subscription';
import { Transaction } from '../models/Transaction';
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
    const ownerId = (req as any).user?.uid;

    if (!ownerId) {
      return res.status(401).json({ error: "Unauthorized. Missing user context." });
    }

    let sub: any = await Subscription.findOne({ ownerId }).lean();

    // --- ENTERPRISE FIX: JIT Legacy User Auto-Provisioning ---
    if (!sub) {
      logger.info(`[Billing] Legacy user detected (${ownerId}). Auto-provisioning Starter plan.`);

      const nextMonth = new Date();
      nextMonth.setMonth(nextMonth.getMonth() + 1);

      const newSub = await Subscription.create({
        ownerId: ownerId,
        planId: 'starter',
        status: 'active',
        provider: 'none',
        billingInterval: 'monthly',
        startedAt: new Date(),
        currentMonthBytes: 0,
        billingCycleReset: nextMonth
      });

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


export const getStorageStats = async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).user?.uid;

    const [apmServices, rumServices, taskServices] = await Promise.all([
      mongoose.models.ApmService ? mongoose.models.ApmService.find({ ownerId }).select('_id').lean() : [],
      mongoose.models.RumService ? mongoose.models.RumService.find({ ownerId }).select('_id').lean() : [],
      mongoose.models.TaskService ? mongoose.models.TaskService.find({ ownerId }).select('_id').lean() : [],
    ]);

    const apmIds = apmServices.map(s => s._id);
    const rumIds = rumServices.map(s => s._id);
    const taskIds = taskServices.map(s => s._id);

    const [apmCount, logsCount, rumCount, taskCount] = await Promise.all([
      apmIds.length > 0 && mongoose.models.ApmTrace ? mongoose.models.ApmTrace.countDocuments({ serviceId: { $in: apmIds } }) : 0,
      mongoose.models.LogEvent ? mongoose.models.LogEvent.countDocuments({ ownerId }) : 0,
      rumIds.length > 0 && mongoose.models.RumTrace ? mongoose.models.RumTrace.countDocuments({ serviceId: { $in: rumIds } }) : 0,
      taskIds.length > 0 && mongoose.models.TaskRun ? mongoose.models.TaskRun.countDocuments({ serviceId: { $in: taskIds } }) : 0,
    ]);

    const APM_TRACE_BYTES = 2500;
    const LOG_BYTES = 800;
    const RUM_EVENT_BYTES = 1200;
    const TASK_RUN_BYTES = 1500;

    const stats = [
      { service: 'APM Traces', bytes: apmCount * APM_TRACE_BYTES, count: apmCount, color: '#f97316' },
      { service: 'Logs', bytes: logsCount * LOG_BYTES, count: logsCount, color: '#3b82f6' },
      { service: 'RUM Events', bytes: rumCount * RUM_EVENT_BYTES, count: rumCount, color: '#ec4899' },
      { service: 'Tasks', bytes: taskCount * TASK_RUN_BYTES, count: taskCount, color: '#6366f1' },
    ];

    res.json({ stats, totalCalculatedBytes: stats.reduce((acc, curr) => acc + curr.bytes, 0) });
  } catch (error: any) {
    logger.error(`[Storage Stats] Error: ${error.message}`);
    res.status(500).json({ error: "Failed to calculate storage footprint." });
  }
};

export const getTransactions = async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).user?.uid;
    const transactions = await Transaction.find({ ownerId })
      .select('paddleTransactionId amount currency status receiptUrl billedAt')
      .sort({ billedAt: -1 })
      .limit(24)
      .lean();

    res.json({ transactions });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch billing history." });
  }
};

export const cancelSubscription = async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).user?.uid;
    const sub = await Subscription.findOne({ ownerId });

    if (!sub || sub.planId === 'starter') {
      return res.status(400).json({ error: "No active paid subscription to cancel." });
    }

    if (sub.status === 'canceled') {
      return res.status(400).json({ error: "Subscription is already scheduled for cancellation." });
    }

    if (sub.provider === 'paddle' && sub.providerSubscriptionId) {
      const isSandbox = process.env.PADDLE_ENV === 'sandbox';
      const paddleApiUrl = isSandbox ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
      const paddleApiKey = process.env.PADDLE_API_KEY;

      if (!paddleApiKey) {
        logger.error(`[Billing] CRITICAL: Missing PADDLE_API_KEY environment variable.`);
        return res.status(500).json({ error: "Internal payment gateway misconfiguration." });
      }

      const response = await fetch(`${paddleApiUrl}/subscriptions/${sub.providerSubscriptionId}/cancel`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${paddleApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          effective_from: 'next_billing_period'
        })
      });

      if (!response.ok) {
        const errData = await response.json();
        logger.error(`[Billing] Paddle API Error cancelling subscription ${sub.providerSubscriptionId}: ${JSON.stringify(errData)}`);
        return res.status(400).json({ error: "Failed to communicate cancellation to payment provider. Please contact support." });
      }
    }

    sub.status = 'canceled';
    await sub.save();

    logger.info(`[Billing] User ${ownerId} successfully scheduled subscription cancellation.`);

    res.json({ message: "Subscription scheduled for cancellation. You will be downgraded to the Starter plan at the end of your current cycle." });
  } catch (error: any) {
    logger.error(`[Billing Cancel] Error: ${error.message}`);
    res.status(500).json({ error: "Failed to cancel subscription." });
  }
};

/**
 * POST /api/billing/paddle-webhook
 */
export const handlePaddleWebhook = async (req: Request, res: Response) => {
  try {
    const signature = req.headers['paddle-signature'];
    if (!signature) return res.status(401).send('Unauthorized');

    const event = req.body;
    const eventType = event.event_type;
    const payload = event.data;
    const ownerId = payload.custom_data?.ownerId;

    if (!ownerId) {
      logger.error('[Billing Webhook] CRITICAL: Webhook received without custom_data.ownerId');
      return res.status(400).send('Missing ownerId');
    }

    if (eventType === 'transaction.completed' || eventType === 'transaction.paid') {
      const rawAmount = payload.details?.totals?.grand_total || payload.amount || "0";

      await Transaction.findOneAndUpdate(
        { paddleTransactionId: payload.id },
        {
          $set: {
            ownerId,
            amount: parseFloat(rawAmount) / 100,
            currency: payload.currency_code || 'USD',
            status: 'completed',
            billedAt: new Date(payload.created_at || payload.billed_at || Date.now())
          }
        },
        { upsert: true, new: true }
      );

      logger.info(`[Billing Webhook] Saved transaction receipt for ${ownerId}`);
    }

    // ENTERPRISE FIX: Infer Monthly/Annual Interval and preserve startedAt
    if (eventType === 'subscription.activated' || eventType === 'subscription.updated') {
      const incomingPriceId = payload.items?.[0]?.price?.id || payload.items?.[0]?.product?.id;
      const matchedPlan = Object.values(PLANS).find(p => p.paddlePriceIdMonthly === incomingPriceId || p.paddlePriceIdAnnual === incomingPriceId);

      const targetPlanId = matchedPlan ? matchedPlan.id : 'starter';
      const isAnnual = matchedPlan && incomingPriceId === matchedPlan.paddlePriceIdAnnual;
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
            billingInterval: isAnnual ? 'annual' : 'monthly',
            billingCycleReset: nextBillingDate
          },
          // Protects original start date if this is an update, populates it if brand new
          $setOnInsert: {
            startedAt: new Date(payload.created_at || Date.now())
          }
        },
        { upsert: true }
      );
    }
    else if (eventType === 'subscription.canceled' || eventType === 'subscription.past_due') {
      await Subscription.findOneAndUpdate({ ownerId }, { $set: { status: eventType === 'subscription.canceled' ? 'canceled' : 'past_due' } });
    }

    res.status(200).send('OK');
  } catch (error: any) {
    logger.error(`[Billing Webhook] Error: ${error.message}`);
    res.status(500).send('Webhook Failed');
  }
};

export const getTransactionReceipt = async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).user?.uid;
    const { transactionId } = req.params;

    const tx = await Transaction.findOne({ paddleTransactionId: transactionId, ownerId });
    if (!tx) {
      return res.status(404).json({ error: "Transaction not found." });
    }

    const isSandbox = process.env.PADDLE_ENV === 'sandbox';
    const paddleApiUrl = isSandbox ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
    const paddleApiKey = process.env.PADDLE_API_KEY;

    if (!paddleApiKey) {
      return res.status(500).json({ error: "Internal payment configuration error." });
    }

    const response = await fetch(`${paddleApiUrl}/transactions/${transactionId}/invoice`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${paddleApiKey}`, 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
      return res.status(404).json({ error: "Invoice is still generating. Please try again in a few minutes." });
    }

    const data = await response.json();
    const invoiceUrl = data.data?.url;

    if (invoiceUrl) {
      return res.json({ url: invoiceUrl });
    }

    return res.status(404).json({ error: "Invoice unavailable." });

  } catch (error: any) {
    res.status(500).json({ error: "Failed to retrieve receipt." });
  }
};