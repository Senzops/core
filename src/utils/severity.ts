// ============================================================================
// Canonical Log Severity Normalization
// ----------------------------------------------------------------------------
// Logs arrive from many sources (raw HTTP forwarders, OTLP exporters, language
// loggers) with wildly inconsistent severity representations: "ERROR", "err",
// "warning", "critical", numeric OTLP severity numbers (1-24), etc.
//
// This module is the single source of truth that collapses any of those into a
// canonical pair used everywhere downstream (storage, querying, UI colouring,
// alerting): { severityText, severityNumber }. severityNumber follows the
// OpenTelemetry severity number model so OTLP fidelity is preserved end-to-end.
//   https://opentelemetry.io/docs/specs/otel/logs/data-model/#severity-fields
// ============================================================================

export type SeverityText = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const SEVERITY_ORDER: SeverityText[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

// Representative OTLP severity number for each canonical band (band base value).
const SEVERITY_BASE: Record<SeverityText, number> = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
};

// Common textual aliases emitted by real-world loggers / forwarders.
const ALIAS: Record<string, SeverityText> = {
  // trace
  trace: 'trace', trc: 'trace', verbose: 'trace',
  // debug
  debug: 'debug', dbg: 'debug', fine: 'debug', finer: 'debug', finest: 'debug',
  // info
  info: 'info', information: 'info', informational: 'info', notice: 'info', log: 'info', default: 'info',
  // warn
  warn: 'warn', warning: 'warn', wrn: 'warn',
  // error
  error: 'error', err: 'error', severe: 'error', failure: 'error', fail: 'error',
  // fatal
  fatal: 'fatal', critical: 'fatal', crit: 'fatal', panic: 'fatal', alert: 'fatal',
  emerg: 'fatal', emergency: 'fatal',
};

const MIN_SEVERITY_NUMBER = 1;
const MAX_SEVERITY_NUMBER = 24;

/** Maps an OTLP severity number (1-24) to its canonical band text. */
export function severityTextFromNumber(n: number): SeverityText {
  if (n <= 4) return 'trace';
  if (n <= 8) return 'debug';
  if (n <= 12) return 'info';
  if (n <= 16) return 'warn';
  if (n <= 20) return 'error';
  return 'fatal';
}

export interface NormalizedSeverity {
  /** Canonical band, e.g. 'error'. */
  severityText: SeverityText;
  /** OTLP-aligned severity number (1-24). */
  severityNumber: number;
  /** Back-compat alias kept equal to severityText so legacy `level` reads keep working. */
  level: SeverityText;
}

interface SeverityInput {
  level?: unknown;
  severity?: unknown;
  severityText?: unknown;
  severityNumber?: unknown;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function build(text: SeverityText, severityNumber: number): NormalizedSeverity {
  return { severityText: text, severityNumber, level: text };
}

/**
 * Normalizes any combination of severity signals into a canonical pair.
 *
 * Precedence:
 *   1. An explicit, in-range OTLP severityNumber (full fidelity preserved).
 *   2. A recognised textual level/severity ("ERROR", "warn", "critical", ...).
 *   3. A numeric string used as a level ("17").
 *   4. Fallback to 'info'.
 *
 * Always returns a valid canonical value — never throws — so it is safe to call
 * on the hot ingestion path without risking a dropped document.
 */
export function normalizeSeverity(input: SeverityInput): NormalizedSeverity {
  // 1. Explicit OTLP severity number wins (preserves fidelity within the band).
  const explicitNumber = coerceNumber(input.severityNumber);
  if (explicitNumber !== null && explicitNumber >= MIN_SEVERITY_NUMBER) {
    const clamped = Math.min(Math.round(explicitNumber), MAX_SEVERITY_NUMBER);
    return build(severityTextFromNumber(clamped), clamped);
  }

  // 2. Textual level / severity.
  const rawText = input.severityText ?? input.level ?? input.severity;
  if (typeof rawText === 'string') {
    const key = rawText.trim().toLowerCase();
    if (key) {
      const mapped = ALIAS[key];
      if (mapped) return build(mapped, SEVERITY_BASE[mapped]);

      // 3. Numeric string used as a level (e.g. syslog-style "3").
      const asNumber = coerceNumber(key);
      if (asNumber !== null && asNumber >= MIN_SEVERITY_NUMBER) {
        const clamped = Math.min(Math.round(asNumber), MAX_SEVERITY_NUMBER);
        return build(severityTextFromNumber(clamped), clamped);
      }
    }
  }

  // 4. Fallback.
  return build('info', SEVERITY_BASE.info);
}
