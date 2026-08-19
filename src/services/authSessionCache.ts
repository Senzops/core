// ============================================================================
// Auth Session Cache — hot-path resolver for OTP verification state.
// ----------------------------------------------------------------------------
// `requireOtpVerified` runs on every authenticated API request, so it must not
// cost a database round-trip each time. This keeps a small in-process map of
// verified (uid, authTime) pairs with a short TTL.
//
// ONLY POSITIVE results are cached. An unverified caller always re-reads, which
// costs one lean lookup on a path that is exercised for a few seconds between
// sign-in and code entry — and in exchange, a verification performed on one
// process is honoured by every other process immediately. Caching negatives
// would trade that correctness for a saving on a request path that barely runs.
//
// Entries are bounded and evicted oldest-first; a multi-process deployment
// simply warms its own map. Revocation clears both the row and the cache.
// ============================================================================

import { AuthSession } from '../models/AuthSession';
import { logger } from '../utils/logger';

/** How long a proven-verified session is trusted before re-reading the row. */
const CACHE_TTL_MS = 60 * 1000;

/** Safety bound on cache size to avoid unbounded growth in large fleets. */
const MAX_ENTRIES = 50_000;

/** Cached value is the session's own absolute expiry, so it can't outlive it. */
interface CacheEntry {
  /** Session expiry (epoch ms) — independent of the cache-entry TTL below. */
  sessionExpiresAt: number;
  /** Cache-entry expiry (epoch ms). */
  refreshAt: number;
}

const cache = new Map<string, CacheEntry>();

const keyOf = (uid: string, authTime: number) => `${uid}:${authTime}`;

function remember(uid: string, authTime: number, sessionExpiresAt: number): void {
  if (cache.size >= MAX_ENTRIES && !cache.has(keyOf(uid, authTime))) {
    // Cheap eviction: drop the oldest-inserted entry. Map preserves order.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(keyOf(uid, authTime), {
    sessionExpiresAt,
    refreshAt: Date.now() + CACHE_TTL_MS,
  });
}

/**
 * True when this exact sign-in has cleared the OTP step and the session has not
 * expired. Fails CLOSED on a database error: an unavailable session store must
 * not silently downgrade the second factor to "assume verified".
 */
export async function isOtpVerified(uid: string, authTime: number): Promise<boolean> {
  const now = Date.now();

  const cached = cache.get(keyOf(uid, authTime));
  if (cached && cached.refreshAt > now) {
    if (cached.sessionExpiresAt > now) return true;
    // Session lapsed inside its cache window — drop it and fall through.
    cache.delete(keyOf(uid, authTime));
  }

  try {
    const session = await AuthSession.findOne({ uid, authTime })
      .select('expiresAt')
      .lean();

    if (!session) return false;

    const expiresAt = new Date(session.expiresAt).getTime();
    if (expiresAt <= now) return false;

    remember(uid, authTime, expiresAt);
    return true;
  } catch (err: any) {
    logger.error(`[Auth] Session lookup failed for ${uid}: ${err?.message}`);
    return false;
  }
}

/** Primes the cache immediately after a successful verification. */
export function markVerified(uid: string, authTime: number, expiresAt: Date): void {
  remember(uid, authTime, expiresAt.getTime());
}

/** Drops every cached session for a user (call on revoke / sign-out-everywhere). */
export function invalidateUserSessions(uid: string): void {
  const prefix = `${uid}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/** Clears the entire cache. Primarily for tests / administrative resets. */
export function clearAuthSessionCache(): void {
  cache.clear();
}
