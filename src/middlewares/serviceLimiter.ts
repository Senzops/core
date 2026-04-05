import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Subscription } from '../models/Subscription';
import { getPlanConfig } from '../config/pricing';
import { logger } from '../utils/logger';

/**
 * Dynamically limits service creation based on the user's active billing plan.
 * Uses string-based model resolution to prevent circular dependencies on server boot.
 * * @param modelName The exact Mongoose Model name string (e.g., 'ApmService')
 * @param serviceName Friendly name for the UI error message (e.g., 'APM Tracing')
 */
export const requireServiceQuota = (modelName: string, serviceName: string) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ownerId = (req as any).user?._id || (req as any).workspaceId;
      if (!ownerId) {
        return res.status(401).json({ error: "Unauthorized: Missing user context." });
      }

      const sub = await Subscription.findOne({ ownerId }).select('planId').lean();
      const plan = getPlanConfig(sub?.planId);

      // Dynamically resolve the model from the Mongoose registry
      const Model = mongoose.models[modelName];
      if (!Model) {
        logger.error(`[Service Limiter] CRITICAL: Model '${modelName}' not found in mongoose registry.`);
        return res.status(500).json({ error: "Internal server error validating quotas." });
      }

      // Count currently active services of this specific type for the tenant
      const currentServiceCount = await Model.countDocuments({ ownerId, status: { $ne: 'deleted' } });

      if (currentServiceCount >= plan.maxServicesPerType) {
        return res.status(402).json({
          error: `${serviceName} Limit Reached.`,
          details: `Your ${plan.name} plan allows up to ${plan.maxServicesPerType} ${serviceName} services. Please upgrade your billing plan to register more.`,
          code: "SERVICE_LIMIT_EXCEEDED"
        });
      }

      next();
    } catch (error: any) {
      logger.error(`[Service Limiter] Error: ${error.message}`);
      res.status(500).json({ error: "Failed to validate service quotas." });
    }
  };
};