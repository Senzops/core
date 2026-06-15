// ============================================================================
// Data Retention Policy — Single Source of Truth
// ----------------------------------------------------------------------------
// Senzor applies a UNIFIED, plan-based retention policy across every telemetry
// collection. A document lives for exactly its owner's plan retention window,
// enforced per-document via MongoDB TTL on an absolute `expiresAt` date
// (expireAfterSeconds: 0). See src/services/retentionCache.ts for how the
// window is resolved and src/services/retentionReconciler.ts for how it is
// re-applied when a plan changes.
//
// Plan retention values themselves are owned by src/config/pricing.ts
// (`PlanConfig.retentionDays`) so billing and retention can never drift apart:
//   Starter    3 days
//   Pro       15 days
//   Business  30 days
//   Enterprise 90 days
//
// Defense-in-depth: alongside the per-document `expiresAt` index, every
// telemetry collection also keeps a "hard cap" TTL on its native time anchor
// set to HARD_CAP_DAYS. If `expiresAt` is ever missing on a document (e.g. a
// write path was missed), the hard cap still guarantees the data cannot live
// beyond the platform maximum plus a small grace window — storage can never
// leak unbounded.
//
// Operational (non-telemetry) collections — WebhookEvent, OtpCode,
// OrganizationInvitation, SystemLock, LogIngestStat — are intentionally NOT
// plan-based and keep their own fixed TTLs.
// ============================================================================

import { getPlanConfig, PLANS, PlanId } from './pricing';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Highest retention any plan grants (Enterprise, 90 days). */
export const PLATFORM_MAX_RETENTION_DAYS = Math.max(
  ...Object.values(PLANS).map((p) => p.retentionDays)
);

/**
 * Hard-cap backstop window (days). Platform maximum plus a 10-day grace so the
 * native anchor TTL never deletes data a plan still legitimately owns, while
 * still bounding storage if a per-document `expiresAt` is ever absent.
 */
export const HARD_CAP_DAYS = PLATFORM_MAX_RETENTION_DAYS + 10;

/** Hard-cap window expressed in seconds, for `expireAfterSeconds` indexes. */
export const HARD_CAP_SECONDS = HARD_CAP_DAYS * 24 * 60 * 60;

/** Retention window (days) for a plan id. Unknown/empty → Starter default. */
export function retentionDaysForPlan(planId?: string): number {
  return getPlanConfig(planId).retentionDays;
}

/** Retention window (milliseconds) for a plan id. */
export function retentionMsForPlan(planId?: string): number {
  return retentionDaysForPlan(planId) * DAY_MS;
}

/**
 * Computes the absolute expiry instant for a document, given its time anchor
 * (the logical timestamp the retention window is measured from) and the owner's
 * plan retention in milliseconds.
 */
export function expiresAtFor(anchor: Date | number, retentionMs: number): Date {
  const anchorMs = anchor instanceof Date ? anchor.getTime() : anchor;
  return new Date(anchorMs + retentionMs);
}

export type { PlanId };
