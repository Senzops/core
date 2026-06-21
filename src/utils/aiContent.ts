// ============================================================================
// AI Content Masking
// ----------------------------------------------------------------------------
// Prompts and completions are the highest-risk data in AI monitoring. This
// helper enforces the per-source content policy on ingest:
//
//   1. If the source has not opted in (captureContent=false) OR is a browser
//      source, content is dropped entirely — never persisted.
//   2. When captured, secret/PII patterns are ALWAYS scrubbed (unlike logs,
//      which are opt-in globally) because the blast radius of a leaked prompt
//      is high. Per-source `maskingRules` redact additional object keys.
//   3. Content is bounded in depth and size so a pathological payload can't
//      bloat a document or the ingest path.
// ============================================================================

import { redactString } from './logRedaction';

const MASK = '[REDACTED]';
const MAX_DEPTH = 6;
const MAX_STRING_LEN = 10_000;
const MAX_ARRAY_LEN = 200;
const MAX_KEYS = 100;

const truncate = (s: string): string =>
  s.length > MAX_STRING_LEN ? s.slice(0, MAX_STRING_LEN) + '…[truncated]' : s;

/**
 * Recursively mask a captured-content value in place-safe fashion (returns a
 * new structure). Scrubs secret/PII patterns from every string, redacts object
 * keys whose name matches a custom masking rule, and bounds depth/size.
 */
const maskValue = (value: any, rules: string[], depth: number): any => {
  if (depth > MAX_DEPTH) return MASK;

  if (typeof value === 'string') return truncate(redactString(value));
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY_LEN).map((v) => maskValue(v, rules, depth + 1));
    if (value.length > MAX_ARRAY_LEN) out.push(`…[${value.length - MAX_ARRAY_LEN} more]`);
    return out;
  }

  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    let count = 0;
    for (const key of Object.keys(value)) {
      if (count >= MAX_KEYS) break;
      count++;
      const lowered = key.toLowerCase();
      if (rules.some((r) => r && lowered.includes(r.toLowerCase()))) {
        out[key] = MASK;
      } else {
        out[key] = maskValue(value[key], rules, depth + 1);
      }
    }
    return out;
  }

  // Functions, symbols, bigint, undefined — not persistable.
  return undefined;
};

/**
 * Apply the source's content-capture policy to a single captured field.
 * Returns `undefined` (field omitted) when capture is disabled.
 */
export const maskAiContent = (
  content: any,
  opts: { captureContent: boolean; maskingRules?: string[] }
): any => {
  if (content === undefined || content === null) return undefined;
  if (!opts.captureContent) return undefined;
  return maskValue(content, opts.maskingRules ?? [], 0);
};
