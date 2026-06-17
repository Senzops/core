import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { DashboardShare, IDashboardShare, ShareScopeType } from '../models/DashboardShare';
import { cacheGet, cacheSet } from '../lib/cache';
import { logger } from '../utils/logger';

declare global {
  namespace Express {
    interface Request {
      share?: IDashboardShare;
    }
  }
}

export function hashShareToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Resolves a public dashboard-share token into a trusted workspace context.
 *
 * The token arrives in `req.params.token`. We look it up by its sha256 hash,
 * reject revoked/expired links, then set `req.ownerId` FROM THE SHARE RECORD —
 * never from the client. Downstream controllers (re-used unchanged from the
 * authenticated path) therefore enforce tenant isolation exactly as they do for
 * logged-in users, because they already filter by `{ _id, ownerId }`.
 */
export const resolveShareContext = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.params.token;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Missing share token.' });
    }

    const tokenHash = hashShareToken(token);
    const share = await DashboardShare.findOne({ tokenHash });

    if (!share) {
      return res.status(404).json({ error: 'This shared dashboard does not exist.' });
    }

    if (share.revokedAt) {
      return res.status(410).json({ error: 'This share link has been revoked.', code: 'SHARE_REVOKED' });
    }

    if (share.expiresAt && share.expiresAt.getTime() < Date.now()) {
      return res.status(410).json({ error: 'This share link has expired.', code: 'SHARE_EXPIRED' });
    }

    // Trusted context for the re-used read controllers.
    (req as any).ownerId = share.ownerId;
    req.share = share;

    // Best-effort usage analytics; never block or fail the read on this.
    DashboardShare.updateOne(
      { _id: share._id },
      { $inc: { accessCount: 1 }, $set: { lastAccessedAt: new Date() } }
    ).catch((err) => logger.warn(`[ShareAuth] Failed to record share access: ${err.message}`));

    next();
  } catch (error: any) {
    logger.error(`[ShareAuth] Failed to resolve share context: ${error.message}`);
    return res.status(500).json({ error: 'Failed to resolve shared dashboard.' });
  }
};

/**
 * Pins a share to exactly one dashboard. Asserts the share's scope type matches
 * the route, and (for per-resource routes) that the requested `:id` is the exact
 * resource the link was created for. Without this a viewer could swap the id in
 * the URL to read a different resource owned by the same workspace.
 */
export const enforceShareScope = (expectedType: ShareScopeType) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const share = req.share;
    if (!share) {
      return res.status(500).json({ error: 'Share context missing.' });
    }

    if (share.scopeType !== expectedType) {
      return res.status(403).json({ error: 'This link does not grant access to this dashboard.' });
    }

    // Routes that carry a resource id must match the pinned scope exactly.
    if (req.params.id !== undefined && req.params.id !== share.scopeId) {
      return res.status(403).json({ error: 'This link does not grant access to this resource.' });
    }

    next();
  };
};

/**
 * Normalizes the time range for the public read path before the re-used
 * controllers run. Locked shares force their fixed window and ignore any
 * client-supplied range; flexible shares fall back to the share's default range
 * when the viewer hasn't picked one. The owner's retention cap is still enforced
 * downstream by the controllers via `resolveTimeRange`.
 */
export const applyShareTimeRange = (req: Request, _res: Response, next: NextFunction) => {
  const share = req.share;
  if (!share) return next();

  if (share.timeRangeMode === 'locked' && share.lockedStart && share.lockedEnd) {
    req.query.start = share.lockedStart.toISOString();
    req.query.end = share.lockedEnd.toISOString();
    delete req.query.range;
  } else if (!req.query.range && !req.query.start && !req.query.end) {
    req.query.range = share.defaultRange || '24h';
  }

  next();
};

/**
 * Short-TTL response cache for the public read path. Keyed by the share's token
 * hash + the sub-path/query, so distinct dashboards and time ranges are isolated.
 * Fail-open: any cache error simply falls through to live execution.
 */
export const cachePublicShare = (ttlSeconds = 20) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const share = req.share;
    if (!share) return next();

    const subPath = req.originalUrl.split(`/${req.params.token}`)[1] || req.originalUrl;
    const key = `pshare:${share.tokenHash}:${subPath}`;

    const cached = await cacheGet(key);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).send(cached);
    }

    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        cacheSet(key, JSON.stringify(body), ttlSeconds);
      }
      res.setHeader('X-Cache', 'MISS');
      return originalJson(body);
    };

    next();
  };
};
