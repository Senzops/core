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

/** A tool call the agent made during the run, recorded as a nested tool span. */
export interface SelfToolCall {
  name: string;
  latencyMs?: number;
  status?: 'ok' | 'error';
  errorMessage?: string;
}

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
  /** Agent name to wrap the run under (defaults to the trace name). */
  agentName?: string;
  /** Tool calls made during the run — recorded as nested `tool` spans under the agent. */
  toolCalls?: SelfToolCall[];
}

/**
 * Record an internal agent run via the SDK, then flush. The run is modelled as
 * an `agent` scope wrapping the LLM generation plus a nested `tool` span per
 * tool the agent invoked — so Senzor's own incident-analysis shows up as a real
 * agent trace (agent → generation + tools), exactly as a customer's would.
 *
 * Incident analysis is low-frequency, so we flush immediately rather than wait
 * on the SDK's background interval (a single queued batch would otherwise never
 * hit the batch-size flush trigger). Fully isolated — never throws into the
 * caller; if the installed SDK predates the agent/tool API, this simply no-ops.
 */
export async function recordSelfGeneration(input: SelfGenerationInput): Promise<void> {
  try {
    Senzor.ai.trace(
      { name: input.traceName, sessionId: input.sessionId, metadata: input.metadata },
      () => {
        Senzor.ai.agent({ name: input.agentName || input.traceName }, () => {
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
          // Nested tool spans (auto-parented under the agent scope).
          for (const t of input.toolCalls || []) {
            Senzor.ai.generation({
              type: 'tool',
              name: t.name,
              tool: { name: t.name },
              latencyMs: t.latencyMs,
              status: t.status || 'ok',
              errorType: t.errorMessage ? 'ToolError' : undefined,
              errorMessage: t.errorMessage,
            });
          }
        });
      },
    );
    // Deterministic delivery for this low-frequency, high-value event.
    await Senzor.flush();
  } catch (err: any) {
    logger.warn(`[SelfAiMonitor] Failed to record generation: ${err?.message}`);
  }
}
