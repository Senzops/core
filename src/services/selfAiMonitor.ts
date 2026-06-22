import Senzor from '@senzops/apm-node';
import { logger } from '../utils/logger';

// ============================================================================
// Self AI Monitoring (dogfooding)
// ----------------------------------------------------------------------------
// Records Senzor's OWN LLM usage (currently the Gemini-powered incident
// analysis) into the AI Monitoring pillar — using the public @senzops/apm-node
// SDK exactly as a customer would, NOT internal ingest functions.
//
// The SDK is initialized once in src/worker/senzor-init.ts with a dedicated AI
// source key (`ai.apiKey` = SENZOR_AI_API_KEY). Here we simply group each
// analysis run into a `Senzor.ai.trace()` and record the LLM call with
// `Senzor.ai.generation()`. The SDK batches, sends to /api/ingest/ai with the
// AI key, and the backend computes cost / masks content / rolls up metrics —
// identical to any external customer. No key configured ⇒ the SDK no-ops.
//
// Fully isolated: any failure here is swallowed and never affects the host.
// ============================================================================

export interface SelfGenerationInput {
  /** Workflow name for the trace (e.g. 'incident-analysis'). */
  traceName: string;
  /** Operation kind (chat | completions | embeddings | ...). */
  operation?: string;
  /** Model id (e.g. 'gemini-2.5-flash'). */
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
  status?: 'ok' | 'error';
  errorType?: string;
  errorMessage?: string;
  /** Optional grouping key (e.g. incidentId) — stored as the trace sessionId. */
  sessionId?: string;
  metadata?: Record<string, any>;
}

/**
 * Record a single first-class AI generation for an internal LLM call, via the
 * SDK. Synchronous + isolated — never throws into the caller.
 */
export function recordSelfGeneration(input: SelfGenerationInput): void {
  try {
    Senzor.ai.trace(
      { name: input.traceName, sessionId: input.sessionId, metadata: input.metadata },
      () => {
        Senzor.ai.generation({
          provider: 'google-genai',
          operation: input.operation || 'chat',
          model: input.model,
          tokensIn: input.tokensIn,
          tokensOut: input.tokensOut,
          latencyMs: input.latencyMs,
          status: input.status,
          errorType: input.errorType,
          errorMessage: input.errorMessage,
          metadata: input.metadata,
        });
      },
    );
  } catch (err: any) {
    logger.warn(`[SelfAiMonitor] Failed to record generation: ${err?.message}`);
  }
}
