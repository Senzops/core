import { Request, Response, NextFunction } from 'express';
import { Subscription } from '../models/Subscription';
import { getPlanConfig, PlanId } from '../config/pricing';

/**
 * Middleware factory that gates a route behind a minimum plan tier.
 *
 * Plan hierarchy: starter < pro < business < enterprise
 *
 * Usage:
 *   apiRouter.get('/some/route', requirePlan('business'), handler);
 */

const PLAN_RANK: Record<PlanId, number> = {
  starter: 0,
  pro: 1,
  business: 2,
  enterprise: 3,
};

export const requirePlan = (minimumPlan: PlanId) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ownerId = (req as any).ownerId;
      if (!ownerId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const subscription = await Subscription.findOne({
        ownerId,
        status: { $in: ['active', 'trialing'] },
      }).lean();

      const currentPlan = (subscription?.planId as PlanId) || 'starter';
      const currentRank = PLAN_RANK[currentPlan] ?? 0;
      const requiredRank = PLAN_RANK[minimumPlan] ?? 0;

      if (currentRank < requiredRank) {
        return res.status(403).json({
          error: 'Plan upgrade required',
          requiredPlan: minimumPlan,
          currentPlan,
          message: `This feature requires the ${minimumPlan.charAt(0).toUpperCase() + minimumPlan.slice(1)} plan or higher.`,
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Utility: Check if an ownerId has access to AI analysis.
 * Used in non-middleware contexts (e.g., worker jobs).
 */
export const checkAiAnalysisAccess = async (ownerId: string): Promise<{
  allowed: boolean;
  plan: PlanId;
  monthlyQuota: number;
}> => {
  const subscription = await Subscription.findOne({
    ownerId,
    status: { $in: ['active', 'trialing'] },
  }).lean();

  const planId = (subscription?.planId as PlanId) || 'starter';
  const config = getPlanConfig(planId);

  return {
    allowed: config.aiAnalysis,
    plan: planId,
    monthlyQuota: config.aiAnalysisMonthlyQuota,
  };
};

/**
 * Resolves an owner's effective plan outside a request context (worker jobs).
 * Falls back to Starter when no active subscription exists, so a lookup failure
 * withholds paid capability rather than granting it.
 */
export const getOwnerPlan = async (ownerId: string): Promise<PlanId> => {
  try {
    const subscription = await Subscription.findOne({
      ownerId,
      status: { $in: ['active', 'trialing'] },
    }).select('planId').lean();
    return (subscription?.planId as PlanId) || 'starter';
  } catch {
    return 'starter';
  }
};

/** True when the owner's plan is at least `minimumPlan`. */
export const ownerMeetsPlan = async (ownerId: string, minimumPlan: PlanId): Promise<boolean> => {
  const plan = await getOwnerPlan(ownerId);
  return (PLAN_RANK[plan] ?? 0) >= (PLAN_RANK[minimumPlan] ?? 0);
};
