// ============================================================================
// parseUtm — extract UTM / campaign attribution from a landing URL.
// ----------------------------------------------------------------------------
// Standard Google Analytics campaign parameters. Values are trimmed and length-
// capped to keep map cardinality and document size bounded. Returns `null` when
// no UTM parameter is present so callers can skip storage/aggregation entirely.
// Never throws on malformed input.
// ============================================================================

import type { IUtm } from '../models/Web';

const UTM_VALUE_MAX = 200;

const UTM_KEYS: Array<[keyof IUtm, string]> = [
  ['source', 'utm_source'],
  ['medium', 'utm_medium'],
  ['campaign', 'utm_campaign'],
  ['term', 'utm_term'],
  ['content', 'utm_content'],
];

/**
 * Parses UTM parameters from a full URL string.
 * @returns an IUtm object containing only the present params, or null if none.
 */
export function parseUtm(rawUrl?: string | null): IUtm | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;

  let params: URLSearchParams;
  try {
    // Base allows parsing of path-only or relative URLs without throwing.
    params = new URL(rawUrl, 'http://localhost').searchParams;
  } catch {
    return null;
  }

  const utm: IUtm = {};
  let found = false;

  for (const [field, param] of UTM_KEYS) {
    const value = params.get(param);
    if (value) {
      const clean = value.trim().slice(0, UTM_VALUE_MAX);
      if (clean) {
        utm[field] = clean;
        found = true;
      }
    }
  }

  return found ? utm : null;
}
