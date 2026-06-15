// ============================================================================
// Retention Cache — hot-path resolver for plan-based TTL
// ----------------------------------------------------------------------------
// Ingestion is high-throughput, so resolving an owner's retention window must
// not hit the database on every write. This module keeps a small in-process
// cache of `ownerId -> retention window`, refreshed lazily with a short TTL.
// Each cache miss performs a single lean `Subscription` lookup; hits are a
// plain Map read.
//
// The cache is intentionally per-process and bounded by natural tenant churn.
// On a plan change, billing flows call `invalidateRetention(ownerId)` so the
// next write resolves the new window immediately (the reconciler additionally
// rewrites already-stored documents — see retentionReconciler.ts).
// ============================================================================

import { Subscription } from '../models/Subscription';
import { retentionDaysForPlan } from '../config/retention';
import { logger } from '../utils/logger';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a resolved retention window is trusted before re-reading the sub. */
const CACHE_TTL_MS = 60 * 1000;

/** Safety bound on cache size to avoid unbounded growth in large fleets. */
const MAX_ENTRIES = 50_000;

interface CacheEntry {
  retentionDays: number;
  expiresAt: number; // cache-entry expiry (epoch ms), not document expiry
}

const cache = new Map<string, CacheEntry>();

/**
 * Resolves the retention window (in days) for an owner, using the cache where
 * possible. Falls back to the Starter window if no subscription exists or the
 * lookup fails — failing safe toward the platform default rather than throwing
 * on an ingestion path.
 */
export async function getRetentionDays(ownerId: string): Promise<number> {
  const now = Date.now();
  const cached = cache.get(ownerId);
  if (cached && cached.expiresAt > now) {
    return cached.retentionDays;
  }

  let retentionDays: number;
  try {
    const sub = await Subscription.findOne({ ownerId }).select('planId').lean();
    retentionDays = retentionDaysForPlan(sub?.planId);
  } catch (err: any) {
    // Never let retention resolution break ingestion. Reuse a stale value if we
    // have one, otherwise fall back to the platform default (Starter).
    logger.warn(`[Retention] Subscription lookup failed for ${ownerId}: ${err?.message}`);
    retentionDays = cached?.retentionDays ?? retentionDaysForPlan(undefined);
  }

  if (cache.size >= MAX_ENTRIES && !cache.has(ownerId)) {
    // Cheap eviction: drop the oldest-inserted entry. Map preserves insertion order.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(ownerId, { retentionDays, expiresAt: now + CACHE_TTL_MS });
  return retentionDays;
}

/** Resolves the retention window for an owner in milliseconds. */
export async function getRetentionMs(ownerId: string): Promise<number> {
  return (await getRetentionDays(ownerId)) * DAY_MS;
}

/**
 * Computes the absolute `expiresAt` for a single document given its time anchor.
 * Convenience for low-volume single-document writes; batch writers should
 * resolve `getRetentionMs` once and compute `anchor + retentionMs` per doc.
 */
export async function computeExpiresAt(ownerId: string, anchor: Date | number): Promise<Date> {
  const retentionMs = await getRetentionMs(ownerId);
  const anchorMs = anchor instanceof Date ? anchor.getTime() : anchor;
  return new Date(anchorMs + retentionMs);
}

/**
 * Stamps `expiresAt` on a batch of documents about to be inserted, anchored on
 * the SAME field the collection's TTL/reconciler uses, so write-time and
 * reconcile-time expiry stay consistent. When the anchor field is not present
 * on the doc yet (e.g. Mongoose `timestamps` populates `createdAt` at insert),
 * it falls back to "now" — which equals the eventual anchor value.
 *
 * Resolve `retentionMs` once per request via `getRetentionMs`, then call this.
 */
export function stampExpiry<T extends Record<string, any>>(
  docs: T[],
  anchorField: string,
  retentionMs: number
): T[] {
  const now = Date.now();
  for (const doc of docs) {
    const anchor = doc[anchorField];
    const anchorMs =
      anchor instanceof Date ? anchor.getTime() : anchor ? new Date(anchor).getTime() : now;
    (doc as Record<string, any>).expiresAt = new Date(anchorMs + retentionMs);
  }
  return docs;
}

/** Invalidates the cached window for an owner (call on plan change). */
export function invalidateRetention(ownerId: string): void {
  cache.delete(ownerId);
}

/** Clears the entire cache. Primarily for tests / administrative resets. */
export function clearRetentionCache(): void {
  cache.clear();
}
