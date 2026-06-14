// ============================================================================
// Log PII / Secret Redaction
// ----------------------------------------------------------------------------
// Best-effort scrubbing of common secrets and PII from log content before it is
// persisted. Conservative by design (favours precision over recall) to avoid
// mangling legitimate log data.
//
// DISABLED BY DEFAULT. Enable globally with LOG_REDACTION_ENABLED=true. A
// per-tenant toggle can be layered on later (Phase 4/5) by passing `enabled`
// explicitly to redactLogDoc(). When disabled this module is a no-op and adds
// zero overhead to the ingestion path.
// ============================================================================

const MASK = '[REDACTED]';

// All patterns are linear-time (bounded quantifiers, no nested repetition) to
// keep the hot path ReDoS-safe.
const PATTERNS: RegExp[] = [
  // Emails
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  // JWTs (header.payload.signature)
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Bearer tokens
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
  // Provider-style prefixed secrets, e.g. sk_live_..., pk_test_..., rk_prod_...
  /\b[a-z]{2,4}_(?:live|test|prod)_[A-Za-z0-9]{8,}\b/gi,
  // Senzor ingestion keys accidentally logged
  /\bsz_[a-z]+_[A-Za-z0-9]{16,}\b/g,
  // Generic prefixed secrets/tokens
  /\b(?:api[_-]?key|secret|token)[_-][A-Za-z0-9]{12,}\b/gi,
  // Card numbers — grouped (4-4-4-4) and contiguous (13-16 digits)
  /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,4}\b/g,
  /\b\d{13,16}\b/g,
];

const MAX_DEPTH = 4;
const MAX_STRING_LEN = 50_000;

export const isRedactionEnabled = (): boolean =>
  process.env.LOG_REDACTION_ENABLED === 'true';

/** Applies all redaction patterns to a single string. */
export function redactString(input: string): string {
  if (!input || input.length > MAX_STRING_LEN) return input;
  let out = input;
  for (const re of PATTERNS) out = out.replace(re, MASK);
  return out;
}

// Recursively redact string values inside a parsed attributes object, in place.
function redactValue(value: any, depth: number): any {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) value[k] = redactValue(value[k], depth + 1);
    return value;
  }
  return value;
}

/**
 * Redacts a fully-built log document in place (message + attributes).
 * No-op unless redaction is enabled (globally or via the `enabled` override).
 */
export function redactLogDoc(doc: { message?: string; attributes?: Record<string, any> }, enabled?: boolean): void {
  const on = enabled ?? isRedactionEnabled();
  if (!on) return;
  if (typeof doc.message === 'string') doc.message = redactString(doc.message);
  if (doc.attributes && typeof doc.attributes === 'object') {
    redactValue(doc.attributes, 0);
  }
}
