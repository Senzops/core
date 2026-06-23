import rateLimit from 'express-rate-limit';
import { Request } from 'express';
import { Subscription } from '../models/Subscription';
import { getPlanConfig } from '../config/pricing';
import { logger } from '../utils/logger';

// ============================================================================
// MCP Rate Limiting — per-owner, plan-aware
// ----------------------------------------------------------------------------
// The previous limiter keyed on IP, which is wrong for MCP: agents run in shared
// cloud egress (many tenants behind one IP) and a single tenant could exhaust
// the budget for everyone. We key on the authenticated `ownerId` instead, and
// size the per-minute budget by the owner's plan tier (PlanConfig.mcpRequestsPerMin).
//
// `authenticateMcp` runs before this middleware, so `req.ownerId` is always set.
// Plan tiers are resolved through a tiny per-process cache (60s TTL) so the hot
// path never hits the database; failures fail OPEN to the Starter budget rather
// than blocking a paying customer on a transient lookup error.
// ============================================================================

const CACHE_TTL_MS = 60 * 1000;
const MAX_ENTRIES = 50_000;

interface LimitEntry {
  limit: number;
  expiresAt: number;
}

const cache = new Map<string, LimitEntry>();

const resolveLimit = async (ownerId: string): Promise<number> => {
  const now = Date.now();
  const cached = cache.get(ownerId);
  if (cached && cached.expiresAt > now) return cached.limit;

  let limit: number;
  try {
    const sub = await Subscription.findOne({ ownerId }).select('planId').lean();
    limit = getPlanConfig(sub?.planId).mcpRequestsPerMin;
  } catch (err: any) {
    logger.warn(`[MCP] Rate-limit plan lookup failed for ${ownerId}: ${err?.message}`);
    limit = cached?.limit ?? getPlanConfig(undefined).mcpRequestsPerMin;
  }

  if (cache.size >= MAX_ENTRIES && !cache.has(ownerId)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(ownerId, { limit, expiresAt: now + CACHE_TTL_MS });
  return limit;
};

/** Invalidates the cached MCP budget for an owner (call on plan change). */
export const invalidateMcpRateLimit = (ownerId: string): void => {
  cache.delete(ownerId);
};

export const mcpRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  standardHeaders: true,
  legacyHeaders: false,
  // Key strictly on the authenticated owner (never IP). A constant fallback is
  // only reachable if auth somehow didn't run, in which case all such requests
  // share one bucket — safe and intentional.
  keyGenerator: (req: Request) => (req as any).ownerId || 'mcp:anonymous',
  limit: async (req: Request) => resolveLimit((req as any).ownerId || 'mcp:anonymous'),
  message: {
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: 'Rate limit exceeded for this MCP key. Slow down and summarize findings, or upgrade your plan for a higher budget.',
    },
    id: null,
  },
});
