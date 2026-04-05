import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Subscription } from '../models/Subscription';
import { getPlanConfig } from '../config/pricing';
import { UsageTracker } from '../services/UsageTracker';
import { logger } from '../utils/logger';

/**
 * Ultra-fast middleware to enforce pooled GB limits across all ingestion routes.
 * Dynamically resolves tenant identity across Native Agents, Web SDKs, and OTLP.
 */
export const requireIngestionQuota = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // 1. Unified Identity Resolution
    // Check if previous middlewares (like authenticateOtlp or authenticateAgent) already attached the ID
    let ownerId = 
      req.otlpContext?.ownerId || 
      (req as any).service?.ownerId || 
      (req as any).website?.ownerId || 
      (req as any).vps?.ownerId ||
      (req as any).ownerId || 
      (req as any).user?._id;

    // Fallback: If identity isn't attached to req yet, dynamically resolve it from headers
    if (!ownerId) {
      const apiKey = req.headers['x-api-key'] || 
        (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.split(' ')[1] : null);
      
      if (apiKey) {
         // Parallel lookup across all native agent registries to find the tenant instantly
         const [apm, rum, task, vps, web] = await Promise.all([
            mongoose.models.ApmService?.findOne({ apiKey }).select('ownerId').lean(),
            mongoose.models.RumService?.findOne({ apiKey }).select('ownerId').lean(),
            mongoose.models.TaskService?.findOne({ apiKey }).select('ownerId').lean(),
            mongoose.models.Vps?.findOne({ apiKey }).select('ownerId').lean(),
            mongoose.models.Website?.findOne({ apiKey }).select('ownerId').lean()
         ]);
         
         // Cast to any to safely bypass Mongoose's complex union type limitations
         const match = (apm || rum || task || vps || web) as any;
         if (match) ownerId = match.ownerId;
      }
    }

    if (!ownerId) {
      logger.warn('[Ingestion Limiter] Blocked payload: Unable to resolve tenant identity.');
      return res.status(401).json({ error: "Missing or invalid API Key for telemetry ingestion." });
    }

    const ownerIdStr = ownerId.toString();

    // 2. Accurately Calculate Payload Size
    // Fallback to stringified body length if proxies (like Cloudflare) strip the content-length header
    const payloadSizeBytes = Number(req.headers['content-length']) || Buffer.byteLength(JSON.stringify(req.body || {}));

    // 3. Fetch Subscription Status
    const sub = await Subscription.findOne({ ownerId: ownerIdStr }).select('planId status currentMonthBytes').lean();
    
    if (!sub) {
      return res.status(402).json({ error: "Active subscription required. Please register your account to start ingesting telemetry." });
    }

    if (sub.status !== 'active' && sub.status !== 'trialing') {
      return res.status(402).json({ error: "Subscription is past due or canceled. Please update your billing details." });
    }

    // 4. Calculate Total Combined Usage
    const plan = getPlanConfig(sub.planId);
    const dbUsage = sub.currentMonthBytes || 0;
    const pendingUsage = UsageTracker.getPendingUsage(ownerIdStr);
    const totalProposedUsage = dbUsage + pendingUsage + payloadSizeBytes;

    // 5. Enforce Pooled Quota
    if (totalProposedUsage > plan.maxIngestionBytes) {
      logger.warn(`[Ingestion] Blocked ${ownerIdStr}: Quota exceeded. Plan: ${plan.name}`);
      
      return res.status(402).json({ 
        error: "Monthly ingestion limit reached.",
        details: `Your ${plan.name} plan allows up to ${plan.maxIngestionBytes / (1024*1024*1024)}GB of combined ingestion. Please upgrade your plan in the dashboard.`,
        code: "QUOTA_EXCEEDED"
      });
    }

    // 6. Track Usage in Ultra-Fast RAM Cache
    UsageTracker.addUsage(ownerIdStr, payloadSizeBytes);
    
    next();
  } catch (error: any) {
    logger.error(`[Ingestion Limiter] Error: ${error.message}`);
    res.status(500).json({ error: "Internal server error validating quotas." });
  }
};