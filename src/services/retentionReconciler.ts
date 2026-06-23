// ============================================================================
// Retention Reconciler — re-applies plan-based TTL on plan change
// ----------------------------------------------------------------------------
// New documents already receive a plan-correct `expiresAt` at write time (see
// retentionCache.ts), and actively-written metric buckets refresh it on every
// upsert. What that does NOT cover is data ALREADY stored when an owner's plan
// changes — e.g. an upgrade that should extend the survival of recent data, or
// a downgrade that should shrink it.
//
// This module rewrites `expiresAt = anchor + newRetention` across every
// plan-based collection for a single owner, using one server-side aggregation
// `updateMany` per collection (no documents travel to the app). MongoDB's TTL
// monitor then removes anything whose recomputed expiry is already in the past
// (downgrade) within its next sweep (~60s), and extends survivors (upgrade).
//
// It is invoked from billing flows after the Subscription has been updated.
// Failures are isolated and logged — retention drift is self-healing (the next
// upsert or a later plan change re-applies it) and must never break billing.
// ============================================================================

import { invalidateRetention, getRetentionMs } from './retentionCache';
import { invalidateMcpRateLimit } from '../middlewares/mcpRateLimit';
import { RETENTION_COLLECTIONS } from './retentionRegistry';
import { logger } from '../utils/logger';

/**
 * Recomputes `expiresAt` for all of an owner's stored telemetry to match their
 * current plan. Resolves the new window fresh (the caller must have persisted
 * the Subscription change first). Never throws.
 */
export async function reconcileOwnerRetention(ownerId: string): Promise<void> {
  if (!ownerId) return;

  // Drop any cached (pre-change) window so subsequent writes use the new plan,
  // then resolve the authoritative new window. Also evict the MCP rate-limit
  // budget cache so the new plan's request budget applies immediately.
  invalidateRetention(ownerId);
  invalidateMcpRateLimit(ownerId);

  let retentionMs: number;
  try {
    retentionMs = await getRetentionMs(ownerId);
  } catch (err: any) {
    logger.error(`[Retention] Reconcile aborted for ${ownerId}: window resolution failed: ${err?.message}`);
    return;
  }

  let updated = 0;
  let failed = 0;

  await Promise.all(
    RETENTION_COLLECTIONS.map(async (coll) => {
      try {
        const filter = await coll.ownerFilter(ownerId);
        if (!filter) return; // owner has nothing in this collection

        const res = await coll.model.updateMany(filter, [
          { $set: { expiresAt: { $add: [`$${coll.anchorField}`, retentionMs] } } },
        ]);
        updated += res.modifiedCount ?? 0;
      } catch (err: any) {
        failed++;
        logger.error(`[Retention] Reconcile ${coll.label} failed for ${ownerId}: ${err?.message}`);
      }
    })
  );

  logger.info(
    `[Retention] Reconciled ${ownerId} to ${retentionMs / (24 * 60 * 60 * 1000)}d ` +
    `(${updated} docs updated${failed ? `, ${failed} collection(s) errored` : ''})`
  );
}

/**
 * Fire-and-forget wrapper for use on request/webhook paths. Schedules the
 * reconcile to run after the current handler returns and swallows all errors so
 * it can never affect the billing response.
 */
export function reconcileOwnerRetentionInBackground(ownerId: string): void {
  void reconcileOwnerRetention(ownerId).catch((err) => {
    logger.error(`[Retention] Background reconcile crashed for ${ownerId}: ${err?.message}`);
  });
}
