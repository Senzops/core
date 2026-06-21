// ============================================================================
// AI Pricing Service — server-authoritative LLM cost computation
// ----------------------------------------------------------------------------
// Cost is NEVER trusted from the client. The ingest pipeline calls
// `computeCost()` with the resolved model id and token usage, and this module
// is the single source of truth for token pricing.
//
// Prices are USD per 1,000,000 tokens (the unit every major provider now
// publishes). They change over time — update this table on provider price
// changes; per-source overrides (AiSource.settings.pricingOverrides) take
// precedence for negotiated rates and self-hosted models.
//
// Matching is longest-prefix on a normalised model id, so dated snapshots
// (e.g. "gpt-4o-2024-08-06") resolve to their family ("gpt-4o") without a row
// per snapshot. Unknown models resolve to cost 0 with `estimated: false` so the
// UI can flag "cost unavailable" rather than silently undercount.
// ============================================================================

export interface ModelPrice {
  /** USD per 1M input (prompt) tokens. */
  input: number;
  /** USD per 1M output (completion) tokens. */
  output: number;
}

export interface CostResult {
  costUsd: number;
  /** True when a price was found (table or override); false for unknown models. */
  estimated: boolean;
}

const PER_MILLION = 1_000_000;

// ---------------------------------------------------------------------------
// Built-in pricing table (USD / 1M tokens). Approximate public list prices;
// override per source for negotiated/committed-use rates. Embeddings have no
// output cost. Keep keys lowercase; matching normalises the incoming id.
// ---------------------------------------------------------------------------
const PRICING: Record<string, ModelPrice> = {
  // --- OpenAI ---
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-4-32k': { input: 60, output: 120 },
  'gpt-4': { input: 30, output: 60 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'o1-mini': { input: 1.1, output: 4.4 },
  'o1-preview': { input: 15, output: 60 },
  'o1': { input: 15, output: 60 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
  'text-embedding-ada-002': { input: 0.1, output: 0 },

  // --- Anthropic ---
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-3-opus': { input: 15, output: 75 },
  'claude-3-sonnet': { input: 3, output: 15 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },

  // --- Google Gemini ---
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-1.5-pro': { input: 1.25, output: 5 },
  'gemini-1.5-flash-8b': { input: 0.0375, output: 0.15 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },

  // --- Mistral ---
  'mistral-large': { input: 2, output: 6 },
  'mistral-small': { input: 0.2, output: 0.6 },
  'open-mistral-nemo': { input: 0.15, output: 0.15 },

  // --- Cohere ---
  'command-r-plus': { input: 2.5, output: 10 },
  'command-r': { input: 0.15, output: 0.6 },

  // --- Groq (Llama hosted) ---
  'llama-3.3-70b': { input: 0.59, output: 0.79 },
  'llama-3.1-8b': { input: 0.05, output: 0.08 },
};

/**
 * Normalise a raw model id for table lookup:
 *   - lowercase
 *   - drop a leading provider/path prefix ("anthropic/", "models/", "openai.")
 *   - strip a trailing version/date snapshot ("-2024-08-06", "-v1:0", "@001")
 */
export const normalizeModelId = (model: string): string => {
  let m = model.trim().toLowerCase();
  // Provider-qualified ids: take the last path segment.
  if (m.includes('/')) m = m.substring(m.lastIndexOf('/') + 1);
  // Bedrock-style suffixes: "...-v1:0", "...:128k"
  m = m.replace(/[:@][\w.-]+$/g, '');
  // Trailing date snapshot: "-2024-08-06" or "-20240620"
  m = m.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/g, '');
  // Trailing "-latest"
  m = m.replace(/-latest$/g, '');
  return m;
};

/** Resolve a price for a model id via override map, then exact, then longest-prefix. */
export const resolvePrice = (
  model: string | undefined,
  overrides?: Record<string, ModelPrice>
): ModelPrice | null => {
  if (!model) return null;
  const normalized = normalizeModelId(model);

  // 1. Per-source overrides win (check raw + normalized).
  if (overrides) {
    if (overrides[model]) return overrides[model];
    if (overrides[normalized]) return overrides[normalized];
  }

  // 2. Exact table hit.
  if (PRICING[normalized]) return PRICING[normalized];

  // 3. Longest-prefix match (e.g. "gpt-4o-audio-preview" -> "gpt-4o").
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(PRICING)) {
    if (normalized.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, price };
    }
  }
  return best?.price ?? null;
};

/**
 * Compute the USD cost of a single generation. Returns cost 0 with
 * `estimated: false` when the model is unknown / unpriced (e.g. self-hosted
 * without an override), so callers can surface "cost unavailable".
 */
export const computeCost = (
  model: string | undefined,
  tokensIn: number,
  tokensOut: number,
  overrides?: Record<string, ModelPrice>
): CostResult => {
  const price = resolvePrice(model, overrides);
  if (!price) return { costUsd: 0, estimated: false };

  const inTok = Number.isFinite(tokensIn) && tokensIn > 0 ? tokensIn : 0;
  const outTok = Number.isFinite(tokensOut) && tokensOut > 0 ? tokensOut : 0;
  const costUsd = (inTok * price.input + outTok * price.output) / PER_MILLION;

  return { costUsd, estimated: true };
};
