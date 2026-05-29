import { Request, Response } from 'express';
import crypto from 'crypto';
import { PLANS, getPlanConfig } from '../config/pricing';
import { Subscription } from '../models/Subscription';
import { Transaction } from '../models/Transaction';
import { WebhookEvent } from '../models/WebhookEvent';
import { dodoRequest, DodoApiError } from '../utils/dodoClient';
import { logger } from '../utils/logger';

// ============================================================================
// CONSTANTS
// ============================================================================

const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300; // 5 minutes

// ============================================================================
// PUBLIC API ENDPOINTS
// ============================================================================

export const getActivePlans = async (req: Request, res: Response) => {
  try {
    const publicPlans = Object.values(PLANS).map(plan => ({
      id: plan.id,
      name: plan.name,
      priceMonthly: plan.priceMonthly,
      priceAnnual: plan.priceAnnual,
      maxServicesPerType: plan.maxServicesPerType,
      maxIngestionBytes: plan.maxIngestionBytes,
      maxOrganizations: plan.maxOrganizations,
      retentionDays: plan.retentionDays,
      dodoProductIdMonthly: plan.dodoProductIdMonthly,
      dodoProductIdAnnual: plan.dodoProductIdAnnual,
    }));

    res.json({ plans: publicPlans });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch pricing plans." });
  }
};

export const getCurrentSubscription = async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).ownerId;

    if (!ownerId) {
      return res.status(401).json({ error: "Unauthorized. Missing user context." });
    }

    let sub: any = await Subscription.findOne({ ownerId }).lean();

    if (!sub) {
      logger.info(`[Billing] Legacy user detected (${ownerId}). Auto-provisioning Starter plan.`);

      const nextMonth = new Date();
      nextMonth.setMonth(nextMonth.getMonth() + 1);

      const newSub = await Subscription.create({
        ownerId,
        planId: 'starter',
        status: 'active',
        provider: 'none',
        billingInterval: 'monthly',
        startedAt: new Date(),
        currentMonthBytes: 0,
        quotaResetAt: nextMonth,
        billingCycleReset: nextMonth,
      });

      sub = newSub.toObject();
    }

    const plan = getPlanConfig(sub.planId);

    res.json({
      subscription: sub,
      plan: {
        name: plan.name,
        maxIngestionBytes: plan.maxIngestionBytes,
        maxServicesPerType: plan.maxServicesPerType,
      },
    });
  } catch (error: any) {
    logger.error(`[Billing] Failed to fetch/provision subscription: ${error.message}`);
    res.status(500).json({ error: "Failed to fetch subscription." });
  }
};

export const getStorageStats = async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).ownerId;
    const mongoose = await import('mongoose');

    // Fetch subscription (authoritative ingestion counter) and service IDs in parallel
    const [sub, apmServices, rumServices, taskServices] = await Promise.all([
      Subscription.findOne({ ownerId }).select('planId currentMonthBytes').lean(),
      mongoose.default.models.ApmService ? mongoose.default.models.ApmService.find({ ownerId }).select('_id').lean() : [],
      mongoose.default.models.RumService ? mongoose.default.models.RumService.find({ ownerId }).select('_id').lean() : [],
      mongoose.default.models.TaskService ? mongoose.default.models.TaskService.find({ ownerId }).select('_id').lean() : [],
    ]);

    const apmIds = apmServices.map((s: any) => s._id);
    const rumIds = rumServices.map((s: any) => s._id);
    const taskIds = taskServices.map((s: any) => s._id);

    const [apmCount, logsCount, rumCount, taskCount] = await Promise.all([
      apmIds.length > 0 && mongoose.default.models.ApmTrace ? mongoose.default.models.ApmTrace.countDocuments({ serviceId: { $in: apmIds } }) : 0,
      mongoose.default.models.LogEvent ? mongoose.default.models.LogEvent.countDocuments({ ownerId }) : 0,
      rumIds.length > 0 && mongoose.default.models.RumTrace ? mongoose.default.models.RumTrace.countDocuments({ serviceId: { $in: rumIds } }) : 0,
      taskIds.length > 0 && mongoose.default.models.TaskRun ? mongoose.default.models.TaskRun.countDocuments({ serviceId: { $in: taskIds } }) : 0,
    ]);

    const stats = [
      { service: 'APM Traces', count: apmCount, color: '#f97316' },
      { service: 'Logs', count: logsCount, color: '#3b82f6' },
      { service: 'RUM Events', count: rumCount, color: '#ec4899' },
      { service: 'Tasks', count: taskCount, color: '#6366f1' },
    ];

    const totalCount = apmCount + logsCount + rumCount + taskCount;
    const plan = getPlanConfig(sub?.planId || 'starter');

    res.json({
      stats,
      totalCount,
      currentMonthBytes: sub?.currentMonthBytes || 0,
      maxIngestionBytes: plan.maxIngestionBytes,
    });
  } catch (error: any) {
    logger.error(`[Storage Stats] Error: ${error.message}`);
    res.status(500).json({ error: "Failed to calculate storage footprint." });
  }
};

export const getTransactions = async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).ownerId;
    const transactions = await Transaction.find({ ownerId })
      .sort({ billedAt: -1 })
      .limit(24)
      .lean();

    const formattedTransactions = transactions.map(tx => ({
      transactionId: tx.dodoTransactionId || tx.paddleTransactionId,
      provider: tx.provider,
      amount: tx.amount,
      currency: tx.currency,
      status: tx.status,
      receiptUrl: tx.receiptUrl,
      billedAt: tx.billedAt,
    }));

    res.json({ transactions: formattedTransactions });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch billing history." });
  }
};

export const getTransactionReceipt = async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).ownerId;
    const { transactionId } = req.params;

    const tx = await Transaction.findOne({
      $or: [{ paddleTransactionId: transactionId }, { dodoTransactionId: transactionId }],
      ownerId,
    });

    if (!tx) {
      return res.status(404).json({ error: "Transaction not found." });
    }

    if (tx.dodoTransactionId) {
      if (tx.receiptUrl) {
        return res.json({ url: tx.receiptUrl });
      }

      try {
        const data = await dodoRequest(`/payments/${tx.dodoTransactionId}`, { method: 'GET' });
        const invoiceUrl = data.invoice_url;

        if (invoiceUrl) {
          tx.receiptUrl = invoiceUrl;
          await tx.save();
          return res.json({ url: invoiceUrl });
        }
      } catch (err) {
        logger.error(`[Billing Receipt] Failed to fetch Dodo invoice: ${(err as Error).message}`);
      }

      return res.status(404).json({ error: "Invoice is unavailable. Please try again later." });
    }

    // Paddle receipt fallback
    const isSandbox = process.env.PADDLE_ENV === 'sandbox';
    const paddleApiUrl = isSandbox ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
    const paddleApiKey = process.env.PADDLE_API_KEY;

    if (!paddleApiKey) {
      return res.status(500).json({ error: "Internal payment configuration error." });
    }

    const response = await fetch(`${paddleApiUrl}/transactions/${transactionId}/invoice`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${paddleApiKey}`, 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      return res.status(404).json({ error: "Invoice is still generating. Please try again in a few minutes." });
    }

    const data = await response.json();
    const invoiceUrl = data.data?.url;

    if (invoiceUrl) return res.json({ url: invoiceUrl });
    return res.status(404).json({ error: "Invoice unavailable." });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to retrieve receipt." });
  }
};

// ============================================================================
// CHECKOUT SESSION (SERVER-SIDE)
// ============================================================================

export const createCheckoutSession = async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).ownerId;
    const userEmail = (req as any).user?.email;
    const userName = (req as any).user?.name || '';
    const { productId, themeMode } = req.body;

    if (!productId) {
      return res.status(400).json({ error: "Product ID is required." });
    }

    if (!ownerId) {
      return res.status(401).json({ error: "Unauthorized." });
    }

    // Guard: prevent duplicate subscriptions for users who already have an active paid plan
    const existingSub = await Subscription.findOne({ ownerId }).select('planId status provider').lean();
    if (existingSub && existingSub.planId !== 'starter' && existingSub.provider === 'dodo' &&
      existingSub.status === 'active') {
      return res.status(409).json({
        error: "You already have an active subscription. Use the plan change option in your profile to switch plans.",
        code: "ACTIVE_SUBSCRIPTION_EXISTS",
      });
    }

    const frontendUrl = req.headers.origin || process.env.FRONTEND_URL;
    if (!frontendUrl) {
      logger.error('[Billing] CRITICAL: FRONTEND_URL env variable is not configured.');
      return res.status(500).json({ error: "Payment gateway is not configured." });
    }

    try {
      const data = await dodoRequest('/checkouts', {
        method: 'POST',
        body: JSON.stringify({
          product_cart: [{ product_id: productId, quantity: 1 }],
          customer: {
            email: userEmail,
            name: userName || userEmail.split('@')[0],
          },
          feature_flags: { allow_discount_code: true },
          return_url: `${frontendUrl}/checkout/success`,
          metadata: { ownerId },
          customization: { theme: themeMode || 'system' },
        }),
      });

      return res.json({ checkoutUrl: data.checkout_url });
    } catch (err) {
      if (err instanceof DodoApiError) {
        logger.error(`[Billing] Dodo checkout session creation failed: ${JSON.stringify(err.body)}`);
        return res.status(400).json({ error: "Failed to create checkout session with payment provider." });
      }
      throw err;
    }
  } catch (error: any) {
    logger.error(`[Billing Checkout Session] Error: ${error.message}`);
    res.status(500).json({ error: "Internal server error creating checkout session." });
  }
};

// ============================================================================
// SUBSCRIPTION CANCELLATION
// ============================================================================

export const cancelSubscription = async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).ownerId;
    const sub = await Subscription.findOne({ ownerId });

    if (!sub || sub.planId === 'starter') {
      return res.status(400).json({ error: "No active paid subscription to cancel." });
    }

    if (sub.status === 'canceled') {
      return res.status(400).json({ error: "Subscription is already scheduled for cancellation." });
    }

    const isOnHold = sub.status === 'on_hold';

    if (sub.provider === 'dodo' && sub.providerSubscriptionId) {
      try {
        // On-hold subscriptions: cancel immediately — no paid service period to honor.
        // Active subscriptions: defer to end of billing cycle so user keeps access.
        const cancelPayload = isOnHold
          ? { status: 'cancelled' }
          : { cancel_at_next_billing_date: true };

        await dodoRequest(`/subscriptions/${sub.providerSubscriptionId}`, {
          method: 'PATCH',
          body: JSON.stringify(cancelPayload),
        });
      } catch (err) {
        logger.error(`[Billing] Dodo cancel API error for ${sub.providerSubscriptionId}: ${(err as Error).message}`);
        return res.status(400).json({ error: "Failed to communicate cancellation to payment provider. Please contact support." });
      }
    } else if (sub.provider === 'paddle' && sub.providerSubscriptionId) {
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
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ effective_from: 'next_billing_period' }),
      });

      if (!response.ok) {
        const errData = await response.json();
        logger.error(`[Billing] Paddle cancel API error for ${sub.providerSubscriptionId}: ${JSON.stringify(errData)}`);
        return res.status(400).json({ error: "Failed to communicate cancellation to payment provider. Please contact support." });
      }
    }

    if (isOnHold) {
      // On-hold: payment already failed, no service period remaining.
      // Downgrade to starter immediately — don't wait for webhook/cron.
      const nextMonth = new Date();
      nextMonth.setMonth(nextMonth.getMonth() + 1);

      sub.status = 'canceled';
      sub.planId = 'starter';
      sub.provider = 'none';
      sub.providerSubscriptionId = undefined;
      sub.providerCustomerId = undefined;
      sub.billingInterval = 'monthly';
      sub.cancelRequestedAt = new Date();
      sub.cancelEffectiveAt = new Date();
      sub.onHoldSince = undefined;
      sub.currentMonthBytes = 0;
      sub.billingCycleReset = nextMonth;
      await sub.save();

      logger.info(`[Billing] User ${ownerId} canceled on-hold subscription. Immediate downgrade to starter.`);

      return res.json({
        message: "Subscription canceled and downgraded to the Free Starter plan. You can re-subscribe at any time.",
        cancelEffectiveAt: sub.cancelEffectiveAt,
        immediateDowngrade: true,
      });
    }

    // Active subscriptions: defer downgrade to end of billing cycle
    sub.cancelRequestedAt = new Date();
    sub.cancelEffectiveAt = sub.billingCycleReset;
    await sub.save();

    logger.info(`[Billing] User ${ownerId} requested subscription cancellation. Effective: ${sub.cancelEffectiveAt}`);

    res.json({
      message: "Subscription cancellation requested. Your plan remains active until the end of your current billing cycle.",
      cancelEffectiveAt: sub.cancelEffectiveAt,
    });
  } catch (error: any) {
    logger.error(`[Billing Cancel] Error: ${error.message}`);
    res.status(500).json({ error: "Failed to cancel subscription." });
  }
};

// ============================================================================
// PLAN CHANGE / UPGRADE / DOWNGRADE
// ============================================================================

export const changePlan = async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).ownerId;
    const { productId } = req.body;

    if (!productId) {
      return res.status(400).json({ error: "Product ID is required." });
    }

    if (!ownerId) {
      return res.status(401).json({ error: "Unauthorized." });
    }

    const sub = await Subscription.findOne({ ownerId });
    if (!sub) {
      return res.status(400).json({ error: "No subscription found. Please subscribe first." });
    }

    if (sub.provider !== 'dodo' || !sub.providerSubscriptionId) {
      return res.status(400).json({ error: "Plan changes are only supported for active Dodo subscriptions. Please contact support." });
    }

    if (sub.status === 'on_hold') {
      return res.status(409).json({
        error: "Plan changes are not available while your subscription is on hold. Please cancel your current subscription first, then re-subscribe to the desired plan.",
        code: "SUBSCRIPTION_ON_HOLD",
      });
    }

    if (sub.status !== 'active') {
      return res.status(400).json({ error: "Plan changes require an active subscription." });
    }

    // Validate the target product maps to a known plan
    const targetPlan = Object.values(PLANS).find(
      p => p.dodoProductIdMonthly === productId || p.dodoProductIdAnnual === productId,
    );

    if (!targetPlan || targetPlan.id === 'starter' || targetPlan.id === 'enterprise') {
      return res.status(400).json({ error: "Invalid target plan." });
    }

    // Prevent no-op changes (same plan + same interval)
    const isTargetAnnual = productId === targetPlan.dodoProductIdAnnual;
    if (targetPlan.id === sub.planId) {
      const sameInterval = (isTargetAnnual && sub.billingInterval === 'annual') ||
        (!isTargetAnnual && sub.billingInterval === 'monthly');
      if (sameInterval) {
        return res.status(400).json({ error: "You are already on this plan and billing interval." });
      }
    }

    const currentPlan = getPlanConfig(sub.planId);
    const isUpgrade = targetPlan.priceMonthly > currentPlan.priceMonthly;

    try {
      await dodoRequest(`/subscriptions/${sub.providerSubscriptionId}/change-plan`, {
        method: 'POST',
        body: JSON.stringify({
          product_id: productId,
          quantity: 1,
          proration_billing_mode: isUpgrade ? 'prorated_immediately' : 'difference_immediately',
        }),
      });
    } catch (err) {
      if (err instanceof DodoApiError) {
        logger.error(`[Billing] Plan change failed for ${ownerId}: ${JSON.stringify(err.body)}`);
        return res.status(400).json({ error: "Failed to process plan change. Please try again or contact support." });
      }
      throw err;
    }

    // Clear pending cancellation — user is actively choosing to stay
    if (sub.cancelRequestedAt) {
      sub.cancelRequestedAt = undefined;
      sub.cancelEffectiveAt = undefined;
      await sub.save();
    }

    logger.info(`[Billing] Plan change initiated: ${ownerId} ${currentPlan.id} → ${targetPlan.id} (${isUpgrade ? 'upgrade' : 'downgrade'})`);

    res.json({
      message: `Plan change to ${targetPlan.name} (${isTargetAnnual ? 'annual' : 'monthly'}) initiated successfully.`,
      targetPlan: targetPlan.id,
      targetPlanName: targetPlan.name,
      billingInterval: isTargetAnnual ? 'annual' : 'monthly',
      isUpgrade,
    });
  } catch (error: any) {
    logger.error(`[Billing Plan Change] Error: ${error.message}`);
    res.status(500).json({ error: "Failed to change plan." });
  }
};

// ============================================================================
// WEBHOOK SIGNATURE VERIFICATION
// ============================================================================

export const verifyDodoSignature = ({
  webhookId,
  webhookTimestamp,
  signatureHeader,
  rawBody,
  secret,
}: {
  webhookId: string;
  webhookTimestamp: string;
  signatureHeader: string;
  rawBody: string;
  secret: string;
}): boolean => {
  try {
    let cleanSecret = secret;
    if (secret.startsWith('whsec_')) {
      cleanSecret = secret.substring(6);
    }
    const secretBuffer = Buffer.from(cleanSecret, 'base64');
    const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;

    const expectedSignature = crypto
      .createHmac('sha256', secretBuffer)
      .update(signedContent)
      .digest('base64');

    const parts = signatureHeader.split(' ');
    for (const part of parts) {
      if (part.startsWith('v1,')) {
        const signatureVal = part.substring(3);
        const signatureBuffer = Buffer.from(signatureVal, 'base64');
        const expectedBuffer = Buffer.from(expectedSignature, 'base64');

        if (
          signatureBuffer.length === expectedBuffer.length &&
          crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
        ) {
          return true;
        }
      }
    }
    return false;
  } catch (error: any) {
    logger.error(`[Dodo Webhook Signature Verification Error]: ${error.message}`);
    return false;
  }
};

function verifyPaddleSignature(rawBody: string, signature: string, secret: string): boolean {
  try {
    const parts = signature.split(';');
    const tsStr = parts.find(p => p.startsWith('ts='))?.split('=')[1];
    const h1 = parts.find(p => p.startsWith('h1='))?.split('=')[1];

    if (!tsStr || !h1) return false;

    const signedPayload = `${tsStr}:${rawBody}`;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(signedPayload)
      .digest('hex');

    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    const receivedBuffer = Buffer.from(h1, 'hex');

    if (expectedBuffer.length !== receivedBuffer.length) return false;
    return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
  } catch (error: any) {
    logger.error(`[Paddle Webhook Signature Verification Error]: ${error.message}`);
    return false;
  }
}

// ============================================================================
// DODO WEBHOOK HANDLER
// ============================================================================

export const handleDodoWebhook = async (req: Request, res: Response) => {
  try {
    const webhookId = req.headers['webhook-id'] as string;
    const webhookTimestamp = req.headers['webhook-timestamp'] as string;
    const signatureHeader = req.headers['webhook-signature'] as string;

    if (!webhookId || !webhookTimestamp || !signatureHeader) {
      logger.error('[Dodo Webhook] Missing required headers');
      return res.status(401).send('Unauthorized: Missing webhook headers');
    }

    // Replay protection: reject events older than tolerance window
    const timestampSeconds = parseInt(webhookTimestamp, 10);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (isNaN(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
      logger.error(`[Dodo Webhook] Timestamp outside tolerance: ${webhookTimestamp}`);
      return res.status(401).send('Unauthorized: Timestamp too old or too new');
    }

    // Extract raw body for signature verification
    let rawBody = '';
    if ((req as any).rawBody) {
      rawBody = (req as any).rawBody.toString('utf8');
    } else if (Buffer.isBuffer(req.body)) {
      rawBody = req.body.toString('utf8');
    } else if (typeof req.body === 'string') {
      rawBody = req.body;
    }

    const secret = process.env.DODO_WEBHOOK_SECRET;
    if (!secret) {
      logger.error('[Dodo Webhook] CRITICAL: DODO_WEBHOOK_SECRET is not configured');
      return res.status(500).send('Internal Server Error');
    }

    const isValid = verifyDodoSignature({ webhookId, webhookTimestamp, signatureHeader, rawBody, secret });
    if (!isValid) {
      logger.error('[Dodo Webhook] Invalid signature');
      return res.status(401).send('Unauthorized: Invalid signature');
    }

    // Idempotency: skip events that were already handled successfully.
    // Failed events are allowed through so provider retries can be reprocessed.
    const existingEvent = await WebhookEvent.findOne({ webhookId }).select('status').lean();
    if (existingEvent && existingEvent.status !== 'failed') {
      logger.info(`[Dodo Webhook] Skipping duplicate event: ${webhookId}`);
      return res.status(200).send('OK');
    }

    const event = JSON.parse(rawBody);
    const eventType = event.type;
    const payload = event.data;
    const ownerId = payload.metadata?.ownerId;

    let processingStatus: 'processed' | 'failed' | 'skipped' = 'processed';
    let processingError: string | undefined;

    try {
      if (!ownerId) {
        // Some events like dispute.* may not carry ownerId — log and skip gracefully
        if (eventType.startsWith('subscription.') || eventType.startsWith('payment.')) {
          logger.error(`[Dodo Webhook] CRITICAL: ${eventType} received without metadata.ownerId`);
          processingStatus = 'failed';
          processingError = 'Missing ownerId in metadata';
          return res.status(400).send('Missing ownerId');
        }
        processingStatus = 'skipped';
        return res.status(200).send('OK');
      }

      await processDodoEvent(eventType, payload, ownerId);
    } catch (err: any) {
      processingStatus = 'failed';
      processingError = err.message;
      logger.error(`[Dodo Webhook] Processing error for ${eventType}: ${err.message}`);
    } finally {
      // Persist audit log regardless of processing outcome.
      // Uses upsert so retries of failed events update the existing record
      // rather than throwing a duplicate key error on webhookId.
      await WebhookEvent.findOneAndUpdate(
        { webhookId },
        {
          $set: {
            provider: 'dodo',
            eventType,
            status: processingStatus,
            ownerId,
            payload: event,
            error: processingError,
            processedAt: new Date(),
          },
        },
        { upsert: true },
      ).catch(auditErr => {
        logger.error(`[Dodo Webhook] Failed to persist audit log: ${(auditErr as Error).message}`);
      });
    }

    // Return 500 on processing failure so the provider retries delivery.
    // Returning 200 on failure silently swallows the event — the provider
    // considers it delivered and never retries, causing data loss.
    if (processingStatus === 'failed') {
      return res.status(500).send('Webhook processing failed');
    }

    res.status(200).send('OK');
  } catch (error: any) {
    logger.error(`[Dodo Webhook] Error: ${error.message}`);
    res.status(500).send('Webhook Failed');
  }
};

async function processDodoEvent(eventType: string, payload: any, ownerId: string): Promise<void> {
  switch (eventType) {
    // ---- Payment Events ----
    case 'payment.succeeded': {
      const rawAmount = payload.total_amount || payload.amount || 0;
      await Transaction.findOneAndUpdate(
        { dodoTransactionId: payload.payment_id },
        {
          $set: {
            ownerId,
            provider: 'dodo',
            amount: rawAmount / 100,
            currency: payload.currency || 'USD',
            status: 'completed',
            billedAt: new Date(payload.created_at || Date.now()),
            receiptUrl: payload.invoice_url,
          },
        },
        { upsert: true, new: true },
      );
      logger.info(`[Dodo Webhook] payment.succeeded recorded for ${ownerId}`);
      break;
    }

    case 'payment.failed': {
      const rawAmount = payload.total_amount || payload.amount || 0;
      await Transaction.findOneAndUpdate(
        { dodoTransactionId: payload.payment_id },
        {
          $set: {
            ownerId,
            provider: 'dodo',
            amount: rawAmount / 100,
            currency: payload.currency || 'USD',
            status: 'failed',
            billedAt: new Date(payload.created_at || Date.now()),
          },
        },
        { upsert: true, new: true },
      );
      logger.info(`[Dodo Webhook] payment.failed recorded for ${ownerId}`);
      break;
    }

    case 'payment.refunded': {
      await Transaction.findOneAndUpdate(
        { dodoTransactionId: payload.payment_id },
        { $set: { status: 'refunded' } },
      );
      logger.info(`[Dodo Webhook] payment.refunded recorded for ${ownerId}`);
      break;
    }

    // ---- Subscription Events ----
    case 'subscription.created': {
      // Initial creation — subscription may not be active yet
      logger.info(`[Dodo Webhook] subscription.created for ${ownerId}, awaiting activation`);
      break;
    }

    case 'subscription.active': {
      await handleDodoSubscriptionActivation(payload, ownerId);
      break;
    }

    case 'subscription.renewed': {
      await handleDodoSubscriptionRenewal(payload, ownerId);
      break;
    }

    case 'subscription.updated': {
      await handleDodoSubscriptionUpdate(payload, ownerId);
      break;
    }

    case 'subscription.on_hold': {
      await Subscription.findOneAndUpdate(
        { ownerId },
        {
          $set: {
            status: 'on_hold',
            onHoldSince: new Date(),
          },
        },
      );
      logger.warn(`[Dodo Webhook] subscription.on_hold for ${ownerId} — renewal payment failed, dunning in progress`);
      break;
    }

    case 'subscription.failed': {
      await Subscription.findOneAndUpdate(
        { ownerId },
        { $set: { status: 'past_due' } },
      );
      logger.error(`[Dodo Webhook] subscription.failed for ${ownerId} — mandate creation failed`);
      break;
    }

    case 'subscription.cancelled': {
      await handleDodoSubscriptionCancelled(payload, ownerId);
      break;
    }

    // ---- Dispute Events ----
    case 'dispute.created':
    case 'dispute.updated': {
      if (payload.payment_id) {
        await Transaction.findOneAndUpdate(
          { dodoTransactionId: payload.payment_id },
          { $set: { status: 'disputed' } },
        );
      }
      logger.warn(`[Dodo Webhook] ${eventType} for ${ownerId} — payment_id: ${payload.payment_id}`);
      break;
    }

    case 'dispute.won': {
      if (payload.payment_id) {
        await Transaction.findOneAndUpdate(
          { dodoTransactionId: payload.payment_id },
          { $set: { status: 'completed' } },
        );
      }
      logger.info(`[Dodo Webhook] dispute.won for ${ownerId}`);
      break;
    }

    case 'dispute.lost': {
      if (payload.payment_id) {
        await Transaction.findOneAndUpdate(
          { dodoTransactionId: payload.payment_id },
          { $set: { status: 'refunded' } },
        );
      }
      logger.warn(`[Dodo Webhook] dispute.lost for ${ownerId}`);
      break;
    }

    default:
      logger.info(`[Dodo Webhook] Unhandled event type: ${eventType}`);
  }
}

async function handleDodoSubscriptionActivation(payload: any, ownerId: string): Promise<void> {
  const matchedPlan = resolveDodonPlan(payload.product_id);
  const targetPlanId = matchedPlan ? matchedPlan.id : 'starter';
  const isAnnual = matchedPlan ? payload.product_id === matchedPlan.dodoProductIdAnnual : false;
  const nextBillingDate = payload.next_billing_date ? new Date(payload.next_billing_date) : new Date();

  const nextQuota = new Date(payload.created_at || Date.now());
  nextQuota.setMonth(nextQuota.getMonth() + 1);

  await Subscription.findOneAndUpdate(
    { ownerId },
    {
      $set: {
        planId: targetPlanId,
        status: 'active',
        provider: 'dodo',
        providerCustomerId: payload.customer?.customer_id,
        providerSubscriptionId: payload.subscription_id,
        billingInterval: isAnnual ? 'annual' : 'monthly',
        billingCycleReset: nextBillingDate,
        quotaResetAt: nextQuota,
        currentMonthBytes: 0,
        onHoldSince: null,
        cancelRequestedAt: null,
        cancelEffectiveAt: null,
      },
      $setOnInsert: {
        startedAt: new Date(payload.created_at || Date.now()),
      },
    },
    { upsert: true },
  );

  logger.info(`[Dodo Webhook] subscription.active — ${ownerId} upgraded to ${targetPlanId}`);
}

async function handleDodoSubscriptionRenewal(payload: any, ownerId: string): Promise<void> {
  const nextBillingDate = payload.next_billing_date ? new Date(payload.next_billing_date) : new Date();

  const nextQuota = new Date();
  nextQuota.setMonth(nextQuota.getMonth() + 1);

  await Subscription.findOneAndUpdate(
    { ownerId },
    {
      $set: {
        status: 'active',
        billingCycleReset: nextBillingDate,
        quotaResetAt: nextQuota,
        currentMonthBytes: 0,
        onHoldSince: null,
      },
    },
  );

  logger.info(`[Dodo Webhook] subscription.renewed for ${ownerId}, next billing: ${nextBillingDate.toISOString()}`);
}

async function handleDodoSubscriptionUpdate(payload: any, ownerId: string): Promise<void> {
  const updateFields: Record<string, any> = {};

  if (payload.product_id) {
    const matchedPlan = resolveDodonPlan(payload.product_id);
    if (matchedPlan) {
      updateFields.planId = matchedPlan.id;
      updateFields.billingInterval = payload.product_id === matchedPlan.dodoProductIdAnnual ? 'annual' : 'monthly';
    }
  }

  if (payload.status) {
    const statusMap: Record<string, string> = {
      active: 'active',
      on_hold: 'on_hold',
      cancelled: 'canceled',
      failed: 'past_due',
    };
    if (statusMap[payload.status]) {
      updateFields.status = statusMap[payload.status];
    }
  }

  if (payload.next_billing_date) {
    updateFields.billingCycleReset = new Date(payload.next_billing_date);
  }

  if (payload.customer?.customer_id) {
    updateFields.providerCustomerId = payload.customer.customer_id;
  }

  if (Object.keys(updateFields).length > 0) {
    await Subscription.findOneAndUpdate({ ownerId }, { $set: updateFields });
    logger.info(`[Dodo Webhook] subscription.updated for ${ownerId}: ${Object.keys(updateFields).join(', ')}`);
  }
}

async function handleDodoSubscriptionCancelled(payload: any, ownerId: string): Promise<void> {
  const nextMonth = new Date();
  nextMonth.setMonth(nextMonth.getMonth() + 1);

  await Subscription.findOneAndUpdate(
    { ownerId },
    {
      $set: {
        status: 'canceled',
        planId: 'starter',
        provider: 'none',
        providerSubscriptionId: null,
        providerCustomerId: null,
        billingInterval: 'monthly',
        cancelEffectiveAt: new Date(),
        billingCycleReset: nextMonth,
        onHoldSince: null,
      },
    },
  );

  logger.info(`[Dodo Webhook] subscription.cancelled — ${ownerId} downgraded to starter`);
}

function resolveDodonPlan(productId: string | undefined) {
  if (!productId) return null;
  return Object.values(PLANS).find(
    p => p.dodoProductIdMonthly === productId || p.dodoProductIdAnnual === productId,
  ) || null;
}

// ============================================================================
// PADDLE WEBHOOK HANDLER (LEGACY — SIGNATURE VERIFICATION ADDED)
// ============================================================================

export const handlePaddleWebhook = async (req: Request, res: Response) => {
  try {
    const signature = req.headers['paddle-signature'] as string;
    if (!signature) return res.status(401).send('Unauthorized');

    const paddleWebhookSecret = process.env.PADDLE_WEBHOOK_SECRET;
    if (paddleWebhookSecret) {
      let rawBody = '';
      if ((req as any).rawBody) {
        rawBody = (req as any).rawBody.toString('utf8');
      } else if (typeof req.body === 'string') {
        rawBody = req.body;
      } else {
        rawBody = JSON.stringify(req.body);
      }

      if (!verifyPaddleSignature(rawBody, signature, paddleWebhookSecret)) {
        logger.error('[Paddle Webhook] Invalid signature');
        return res.status(401).send('Unauthorized: Invalid signature');
      }
    } else {
      logger.warn('[Paddle Webhook] PADDLE_WEBHOOK_SECRET not configured — signature verification skipped');
    }

    const event = req.body;
    const eventType = event.event_type;
    const payload = event.data;
    const ownerId = payload.custom_data?.ownerId;

    if (!ownerId) {
      logger.error('[Paddle Webhook] CRITICAL: Webhook received without custom_data.ownerId');
      return res.status(400).send('Missing ownerId');
    }

    // Idempotency via webhook event ID — allow retries for previously failed events
    const paddleEventId = event.event_id || `paddle_${eventType}_${Date.now()}`;
    const existingPaddleEvent = await WebhookEvent.findOne({ webhookId: paddleEventId }).select('status').lean();
    if (existingPaddleEvent && existingPaddleEvent.status !== 'failed') {
      return res.status(200).send('OK');
    }

    let paddleProcessingStatus: 'processed' | 'failed' = 'processed';
    let paddleProcessingError: string | undefined;

    try {
      if (eventType === 'transaction.completed' || eventType === 'transaction.paid') {
        const rawAmount = payload.details?.totals?.grand_total || payload.amount || "0";

        await Transaction.findOneAndUpdate(
          { paddleTransactionId: payload.id },
          {
            $set: {
              ownerId,
              provider: 'paddle',
              amount: parseFloat(rawAmount) / 100,
              currency: payload.currency_code || 'USD',
              status: 'completed',
              billedAt: new Date(payload.created_at || payload.billed_at || Date.now()),
            },
          },
          { upsert: true, new: true },
        );
      }

      if (eventType === 'subscription.activated' || eventType === 'subscription.updated') {
        const incomingPriceId = payload.items?.[0]?.price?.id || payload.items?.[0]?.product?.id;
        const matchedPlan = Object.values(PLANS).find(
          p => p.paddlePriceIdMonthly === incomingPriceId || p.paddlePriceIdAnnual === incomingPriceId,
        );

        const targetPlanId = matchedPlan ? matchedPlan.id : 'starter';
        const isAnnual = matchedPlan && incomingPriceId === matchedPlan.paddlePriceIdAnnual;
        const nextBillingDate = new Date(payload.current_billing_period.ends_at);

        const updatePayload: any = {
          planId: targetPlanId,
          status: payload.status === 'active' ? 'active' : 'past_due',
          provider: 'paddle',
          providerCustomerId: payload.customer_id,
          providerSubscriptionId: payload.id,
          billingInterval: isAnnual ? 'annual' : 'monthly',
          billingCycleReset: nextBillingDate,
        };

        if (eventType === 'subscription.activated') {
          const nextQuota = new Date(payload.created_at || Date.now());
          nextQuota.setMonth(nextQuota.getMonth() + 1);
          updatePayload.quotaResetAt = nextQuota;
          updatePayload.currentMonthBytes = 0;
        }

        await Subscription.findOneAndUpdate(
          { ownerId },
          {
            $set: updatePayload,
            $setOnInsert: { startedAt: new Date(payload.created_at || Date.now()) },
          },
          { upsert: true },
        );
      } else if (eventType === 'subscription.canceled' || eventType === 'subscription.past_due') {
        await Subscription.findOneAndUpdate(
          { ownerId },
          { $set: { status: eventType === 'subscription.canceled' ? 'canceled' : 'past_due' } },
        );
      }
    } catch (err: any) {
      paddleProcessingStatus = 'failed';
      paddleProcessingError = err.message;
      logger.error(`[Paddle Webhook] Processing error for ${eventType}: ${err.message}`);
    }

    await WebhookEvent.findOneAndUpdate(
      { webhookId: paddleEventId },
      {
        $set: {
          provider: 'paddle',
          eventType,
          status: paddleProcessingStatus,
          ownerId,
          payload: event,
          error: paddleProcessingError,
          processedAt: new Date(),
        },
      },
      { upsert: true },
    ).catch(auditErr => {
      logger.error(`[Paddle Webhook] Failed to persist audit log: ${(auditErr as Error).message}`);
    });

    if (paddleProcessingStatus === 'failed') {
      return res.status(500).send('Webhook processing failed');
    }

    res.status(200).send('OK');
  } catch (error: any) {
    logger.error(`[Paddle Webhook] Error: ${error.message}`);
    res.status(500).send('Webhook Failed');
  }
};
