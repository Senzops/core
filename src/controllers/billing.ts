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
    // Force the use of the Firebase UID string to maintain parity across the platform
    const ownerId = (req as any).user?.uid;

    if (!ownerId) {
      return res.status(401).json({ error: "Unauthorized. Missing user context." });
    }

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
 * PRODUCTION FIX: Estimate DB Footprint safely.
 * Resolves service IDs first, then uses indexed $in arrays for blazing-fast counts.
 */
export const getStorageStats = async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).user?.uid;

    // 1. Instantly resolve all Service IDs owned by this tenant
    const [apmServices, rumServices, taskServices] = await Promise.all([
      mongoose.models.ApmService ? mongoose.models.ApmService.find({ ownerId }).select('_id').lean() : [],
      mongoose.models.RumService ? mongoose.models.RumService.find({ ownerId }).select('_id').lean() : [],
      mongoose.models.TaskService ? mongoose.models.TaskService.find({ ownerId }).select('_id').lean() : [],
    ]);

    const apmIds = apmServices.map(s => s._id);
    const rumIds = rumServices.map(s => s._id);
    const taskIds = taskServices.map(s => s._id);

    // 2. Parallel execution of ultra-fast index scans using the resolved IDs
    const [apmCount, logsCount, rumCount, taskCount] = await Promise.all([
      apmIds.length > 0 && mongoose.models.ApmTrace ? mongoose.models.ApmTrace.countDocuments({ serviceId: { $in: apmIds } }) : 0,
      mongoose.models.LogEvent ? mongoose.models.LogEvent.countDocuments({ ownerId }) : 0,
      rumIds.length > 0 && mongoose.models.RumTrace ? mongoose.models.RumTrace.countDocuments({ serviceId: { $in: rumIds } }) : 0,
      taskIds.length > 0 && mongoose.models.TaskRun ? mongoose.models.TaskRun.countDocuments({ serviceId: { $in: taskIds } }) : 0,
    ]);

    // Enterprise Heuristics (Average bytes per document type)
    const APM_TRACE_BYTES = 2500;   // ~2.5KB per complex trace
    const LOG_BYTES = 800;          // ~0.8KB per log line
    const RUM_EVENT_BYTES = 1200;   // ~1.2KB per RUM payload
    const TASK_RUN_BYTES = 1500;    // ~1.5KB per background job record

    const stats = [
      { service: 'APM Traces', bytes: apmCount * APM_TRACE_BYTES, count: apmCount, color: '#f97316' }, // Orange
      { service: 'Logs', bytes: logsCount * LOG_BYTES, count: logsCount, color: '#3b82f6' },           // Blue
      { service: 'RUM Events', bytes: rumCount * RUM_EVENT_BYTES, count: rumCount, color: '#ec4899' }, // Pink
      { service: 'Tasks', bytes: taskCount * TASK_RUN_BYTES, count: taskCount, color: '#6366f1' },     // Indigo
    ];

    res.json({ stats, totalCalculatedBytes: stats.reduce((acc, curr) => acc + curr.bytes, 0) });
  } catch (error: any) {
    logger.error(`[Storage Stats] Error: ${error.message}`);
    res.status(500).json({ error: "Failed to calculate storage footprint." });
  }
};

/**
 * Fetch Billing History
 */
export const getTransactions = async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).user?.uid;
    const transactions = await Transaction.find({ ownerId })
      .select('paddleTransactionId amount currency status receiptUrl billedAt')
      .sort({ billedAt: -1 })
      .limit(24) // Last 2 years
      .lean();

    res.json({ transactions });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch billing history." });
  }
};

/**
 * Cancel Subscription Workflow
 */
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

    // 1. Communicate with Paddle via Server-to-Server API
    if (sub.provider === 'paddle' && sub.providerSubscriptionId) {
      const isSandbox = process.env.PADDLE_ENV === 'sandbox';
      const paddleApiUrl = isSandbox ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
      const paddleApiKey = process.env.PADDLE_API_KEY; // Must be added to your backend .env

      if (!paddleApiKey) {
         logger.error(`[Billing] CRITICAL: Missing PADDLE_API_KEY environment variable.`);
         return res.status(500).json({ error: "Internal payment gateway misconfiguration." });
      }

      // Call Paddle v2 API to cancel the subscription
      const response = await fetch(`${paddleApiUrl}/subscriptions/${sub.providerSubscriptionId}/cancel`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${paddleApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          // 'next_billing_period' ensures they keep access until the end of the month they paid for
          effective_from: 'next_billing_period' 
        })
      });

      if (!response.ok) {
        const errData = await response.json();
        logger.error(`[Billing] Paddle API Error cancelling subscription ${sub.providerSubscriptionId}: ${JSON.stringify(errData)}`);
        return res.status(400).json({ error: "Failed to communicate cancellation to payment provider. Please contact support." });
      }
    }
    
    // 2. Update local database state to reflect intention
    sub.status = 'canceled';
    await sub.save();

    logger.info(`[Billing] User ${ownerId} successfully scheduled subscription cancellation via Paddle.`);
    
    res.json({ message: "Subscription scheduled for cancellation. You will be downgraded to the Starter plan at the end of your current cycle." });
  } catch (error: any) {
    logger.error(`[Billing Cancel] Error: ${error.message}`);
    res.status(500).json({ error: "Failed to cancel subscription." });
  }
};


/**
 * POST /api/billing/paddle-webhook
 * Zero-Trust Webhook Receiver. This is hit by Paddle's servers, NOT your frontend.
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

    // 1. Handle Successful Payments & Invoice Generation
    if (eventType === 'transaction.completed' || eventType === 'transaction.paid') {
      
      // Enterprise Safe Parsing: Safely traverse Paddle's deep nested objects.
      // Falls back to null if the transaction has no receipt (e.g., 100% discount or trial)
      const parsedReceiptUrl = payload.receipt_data?.receipt_url || payload.checkout?.receipt_url || null;
      
      // Convert raw amount strings to proper floats. Fallback to 0.
      const rawAmount = payload.details?.totals?.grand_total || payload.amount || "0";

      await Transaction.create({
        ownerId,
        paddleTransactionId: payload.id,
        amount: parseFloat(rawAmount) / 100, // Paddle v2 sends amounts in cents/lowest denomination
        currency: payload.currency_code || 'USD',
        status: 'completed',
        receiptUrl: parsedReceiptUrl,
        billedAt: new Date(payload.created_at || payload.billed_at || Date.now())
      });
      logger.info(`[Billing Webhook] Saved transaction receipt for ${ownerId}`);
    }

    // 2. Handle Subscription Upgrades/Downgrades
    if (eventType === 'subscription.activated' || eventType === 'subscription.updated') {
      const incomingPriceId = payload.items?.[0]?.price?.id || payload.items?.[0]?.product?.id;
      const matchedPlan = Object.values(PLANS).find(p => p.paddlePriceIdMonthly === incomingPriceId || p.paddlePriceIdAnnual === incomingPriceId);
      const targetPlanId = matchedPlan ? matchedPlan.id : 'starter';
      const nextBillingDate = new Date(payload.current_billing_period.ends_at);

      await Subscription.findOneAndUpdate(
        { ownerId },
        { $set: { planId: targetPlanId, status: payload.status === 'active' ? 'active' : 'past_due', provider: 'paddle', providerCustomerId: payload.customer_id, providerSubscriptionId: payload.id, billingCycleReset: nextBillingDate } },
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

    // 1. Verify ownership (Security Check)
    const tx = await Transaction.findOne({ paddleTransactionId: transactionId, ownerId });
    if (!tx) {
      return res.status(404).json({ error: "Transaction not found." });
    }

    // 2. Fast Path: If we already captured it during the webhook, return immediately
    if (tx.receiptUrl) {
      return res.json({ url: tx.receiptUrl });
    }

    // 3. JIT Fetch: Ask Paddle API for the Invoice URL
    const isSandbox = process.env.PADDLE_ENV === 'sandbox';
    const paddleApiUrl = isSandbox ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
    const paddleApiKey = process.env.PADDLE_API_KEY;

    if (!paddleApiKey) {
      logger.error(`[Billing] Missing PADDLE_API_KEY for receipt retrieval.`);
      return res.status(500).json({ error: "Internal payment configuration error." });
    }

    const response = await fetch(`${paddleApiUrl}/transactions/${transactionId}/invoice`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${paddleApiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      logger.error(`[Billing] Paddle API failed to generate invoice for ${transactionId}`);
      return res.status(404).json({ error: "Invoice is still generating. Please try again in a few minutes." });
    }

    const data = await response.json();
    const invoiceUrl = data.data?.url;

    if (invoiceUrl) {
      // Opportunistically save the URL to the database to speed up future requests
      tx.receiptUrl = invoiceUrl;
      await tx.save();
      
      return res.json({ url: invoiceUrl });
    }

    return res.status(404).json({ error: "Invoice unavailable." });

  } catch (error: any) {
    logger.error(`[Billing Receipt] Error: ${error.message}`);
    res.status(500).json({ error: "Failed to retrieve receipt." });
  }
};