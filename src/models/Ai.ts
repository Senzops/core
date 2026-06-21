import mongoose, { Schema, Document } from 'mongoose';
import { applyPlanBasedTtl } from '../utils/ttl';

// ============================================================================
// AI Monitoring (LLM Observability)
// ----------------------------------------------------------------------------
// A first-class, standalone pillar — independent of APM, RUM and Task. A user
// registers an `AiSource` (a logical "AI project/app") and instruments their
// code with @senzops/apm-node, which auto-instruments major LLM providers and
// also exposes a manual `Senzor.ai.*` wrap API. Telemetry is pushed to
// /api/ingest/ai and authenticated by the source's apiKey.
//
// Data model (OTel GenAI semantic-convention aligned, Langfuse-style):
//   - AiTrace      — the parent grouping for one AI interaction / workflow.
//                    Holds rollup totals (cost, tokens, latency) and the link
//                    back to an APM trace (`apmTraceId`) for cross-pillar nav.
//   - AiGeneration — a single observation: an LLM call, tool call, retrieval
//                    or embedding. The queryable unit ("Generations" table)
//                    and the building block of the trace waterfall.
//   - AiMetric     — 1-minute time-series buckets for cheap cost/token/latency
//                    trend charts and per-model/provider/operation breakdowns.
//
// Cost is ALWAYS computed server-side from a maintained pricing table
// (see services/aiPricing.ts) — the client cost field is never trusted.
//
// Prompt/completion content capture is OPT-IN per source (default OFF) and is
// masked on ingest. All collections carry plan-based TTL.
// ============================================================================

// --- Shared enums ---------------------------------------------------------

/** Provider identifier (OTel `gen_ai.system`). Free-form to allow custom/self-hosted. */
export type AiProvider =
  | 'openai'
  | 'anthropic'
  | 'google-genai'
  | 'azure-openai'
  | 'cohere'
  | 'mistral'
  | 'bedrock'
  | 'groq'
  | 'ollama'
  | 'openrouter'
  | 'webllm'
  | 'custom'
  | string;

/** The kind of observation recorded. */
export type AiObservationType = 'generation' | 'tool' | 'retrieval' | 'embedding' | 'span';
export const AI_OBSERVATION_TYPES: AiObservationType[] = ['generation', 'tool', 'retrieval', 'embedding', 'span'];

export type AiStatus = 'ok' | 'error';

// ---------------------------------------------------------------------------
// 1. AI Source (registered AI project / app)
// ---------------------------------------------------------------------------
export interface IAiSourceSettings {
  /** When true, raw prompts/completions are stored (masked). Default false. */
  captureContent: boolean;
  /**
   * Extra attribute/field names to redact from captured content and metadata,
   * on top of the SDK + ingest default deny-list.
   */
  maskingRules: string[];
  /**
   * Per-model price overrides (USD per 1M tokens). Wins over the built-in
   * pricing table — used for negotiated rates or self-hosted models.
   * Shape: { [modelId]: { input: number, output: number } }
   */
  pricingOverrides: Record<string, { input: number; output: number }>;
  /** Head-sampling rate (0..1) applied at query/ingest time. Default 1 (keep all). */
  sampleRate: number;
}

export interface IAiSource extends Document {
  ownerId: string;
  name: string;
  apiKey: string;
  /**
   * 'server'  — instrumented via @senzops/apm-node in a Node/edge runtime.
   * 'browser' — in-browser AI (e.g. WebLLM); ingest is CORS + rate-limited and
   *             content capture is forced off regardless of settings.
   */
  type: 'server' | 'browser';
  settings: IAiSourceSettings;
  /** Optional deep-link to the team's model provider console / runbook. */
  managementUrl?: string;
  lastSeen: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const AiSourceSchema = new Schema<IAiSource>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  apiKey: { type: String, required: true, select: false, unique: true, index: true },
  type: { type: String, enum: ['server', 'browser'], default: 'server', index: true },
  settings: {
    captureContent: { type: Boolean, default: false },
    maskingRules: { type: [String], default: [] },
    pricingOverrides: { type: Schema.Types.Mixed, default: {} },
    sampleRate: { type: Number, default: 1, min: 0, max: 1 },
  },
  managementUrl: { type: String },
  lastSeen: { type: Date, default: null },
}, { timestamps: true });

export const AiSource = mongoose.model<IAiSource>('AiSource', AiSourceSchema);

// ---------------------------------------------------------------------------
// 2. AI Trace (parent grouping for one AI interaction / workflow)
// ---------------------------------------------------------------------------
export interface IAiTrace extends Document {
  sourceId: mongoose.Types.ObjectId;
  /** Client-generated correlation id (stable within a source). */
  traceId: string;
  /** Link back to an APM trace, when the AI call happened inside an HTTP request. */
  apmTraceId?: string;
  /** Optional grouping of related traces (a conversation / agent session). */
  sessionId?: string;
  /** Hashed/opaque end-user identifier — never raw PII. */
  userId?: string;

  name: string;
  tags: string[];
  status: AiStatus;

  // Rollup totals (recomputed from child generations on ingest).
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalTokens: number;
  generationCount: number;
  latencyMs: number;

  metadata?: Record<string, any>;

  timestamp: Date;
  expiresAt?: Date; // Plan-based TTL (anchor: createdAt)
  createdAt: Date;
}

const AiTraceSchema = new Schema<IAiTrace>({
  sourceId: { type: Schema.Types.ObjectId, ref: 'AiSource', required: true, index: true },
  traceId: { type: String, required: true },
  apmTraceId: { type: String, index: true },
  sessionId: { type: String },
  userId: { type: String },

  name: { type: String, default: 'ai.trace' },
  tags: { type: [String], default: [] },
  status: { type: String, enum: ['ok', 'error'], default: 'ok' },

  totalCostUsd: { type: Number, default: 0 },
  totalTokensIn: { type: Number, default: 0 },
  totalTokensOut: { type: Number, default: 0 },
  totalTokens: { type: Number, default: 0 },
  generationCount: { type: Number, default: 0 },
  latencyMs: { type: Number, default: 0 },

  metadata: { type: Schema.Types.Mixed },

  timestamp: { type: Date, default: Date.now },
}, { timestamps: true });

// One trace doc per (source, traceId): ingest upserts so late generations in a
// streamed/multi-step workflow merge into the same trace.
AiTraceSchema.index({ sourceId: 1, traceId: 1 }, { unique: true });
// Main list query: a source's traces over a time window.
AiTraceSchema.index({ sourceId: 1, timestamp: -1 });
// Session drill-down (conversation view).
AiTraceSchema.index({ sourceId: 1, sessionId: 1, timestamp: -1 });

applyPlanBasedTtl(AiTraceSchema, 'createdAt');

export const AiTrace = mongoose.model<IAiTrace>('AiTrace', AiTraceSchema);

// ---------------------------------------------------------------------------
// 3. AI Generation (a single observation — the queryable LLM-call unit)
// ---------------------------------------------------------------------------
export interface IAiContentMessage {
  role?: string;
  content?: any;
}

export interface IAiGeneration extends Document {
  sourceId: mongoose.Types.ObjectId;
  traceId: string;
  /** Stable id for this observation within the trace. */
  generationId: string;
  /** Parent observation id for nested agent / RAG steps. */
  parentGenerationId?: string;

  type: AiObservationType;
  name: string;
  provider: AiProvider;
  operation: string; // chat, completions, embeddings, images, tool, retrieval, ...

  requestModel?: string;
  responseModel?: string;

  // Usage + cost (cost is server-computed; see services/aiPricing.ts).
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  costUsd: number;
  /** True when cost came from the pricing table; false when model was unknown (cost=0). */
  costEstimated: boolean;

  // Timing.
  startTime: number; // ms offset from trace start (waterfall ordering)
  latencyMs: number; // total duration
  timeToFirstTokenMs?: number; // streaming only
  streaming: boolean;

  // Request parameters (sanitised on ingest).
  params?: Record<string, any>;
  finishReason?: string;

  // Outcome.
  status: AiStatus;
  statusCode?: number;
  errorType?: string;
  errorMessage?: string;

  // Optional captured content (only when the source opts in; masked on ingest).
  input?: IAiContentMessage[] | any;
  output?: IAiContentMessage[] | any;
  toolCalls?: any[];

  metadata?: Record<string, any>;

  timestamp: Date;
  expiresAt?: Date; // Plan-based TTL (anchor: createdAt)
  createdAt: Date;
}

const AiGenerationSchema = new Schema<IAiGeneration>({
  sourceId: { type: Schema.Types.ObjectId, ref: 'AiSource', required: true, index: true },
  traceId: { type: String, required: true },
  generationId: { type: String, required: true },
  parentGenerationId: { type: String },

  type: { type: String, enum: AI_OBSERVATION_TYPES, default: 'generation' },
  name: { type: String, default: 'ai.generation' },
  provider: { type: String, default: 'custom' },
  operation: { type: String, default: 'chat' },

  requestModel: { type: String },
  responseModel: { type: String },

  tokensIn: { type: Number, default: 0 },
  tokensOut: { type: Number, default: 0 },
  totalTokens: { type: Number, default: 0 },
  costUsd: { type: Number, default: 0 },
  costEstimated: { type: Boolean, default: false },

  startTime: { type: Number, default: 0 },
  latencyMs: { type: Number, default: 0 },
  timeToFirstTokenMs: { type: Number },
  streaming: { type: Boolean, default: false },

  params: { type: Schema.Types.Mixed },
  finishReason: { type: String },

  status: { type: String, enum: ['ok', 'error'], default: 'ok' },
  statusCode: { type: Number },
  errorType: { type: String },
  errorMessage: { type: String },

  input: { type: Schema.Types.Mixed },
  output: { type: Schema.Types.Mixed },
  toolCalls: { type: [Schema.Types.Mixed] },

  metadata: { type: Schema.Types.Mixed },

  timestamp: { type: Date, default: Date.now },
}, { timestamps: true });

// Waterfall: all observations of a trace, ordered.
AiGenerationSchema.index({ sourceId: 1, traceId: 1, startTime: 1 });
// Generations table + global feeds.
AiGenerationSchema.index({ sourceId: 1, timestamp: -1 });
// Filtered analytics (by model / provider / outcome).
AiGenerationSchema.index({ sourceId: 1, requestModel: 1, timestamp: -1 });
AiGenerationSchema.index({ sourceId: 1, provider: 1, timestamp: -1 });
AiGenerationSchema.index({ sourceId: 1, status: 1, timestamp: -1 });

applyPlanBasedTtl(AiGenerationSchema, 'createdAt');

export const AiGeneration = mongoose.model<IAiGeneration>('AiGeneration', AiGenerationSchema);

// ---------------------------------------------------------------------------
// 4. AI Metric (1-minute time-series buckets)
// ---------------------------------------------------------------------------
// Powers cheap trend charts (cost, tokens, calls, error rate, avg latency) and
// per-model/provider/operation breakdowns without scanning raw generations.
// Latency percentiles (p50/p95/p99) are computed from raw generations in the
// stats controller over the queried window (buckets can't aggregate percentiles).
export interface IAiMetric extends Document {
  sourceId: mongoose.Types.ObjectId;
  timestamp: Date; // minute bucket

  calls: number;
  errorCount: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencySum: number;
  latencyMax: number;
  ttftSum: number;    // sum of time-to-first-token (streaming)
  ttftCount: number;  // count of streaming calls with a ttft sample

  // Dimension breakdowns. Each value is an object:
  //   { calls, errors, tokensIn, tokensOut, costUsd, durationSum }
  models: Map<string, any>;
  providers: Map<string, any>;
  operations: Map<string, any>;

  expiresAt?: Date; // Plan-based TTL (anchor: timestamp)
}

const AiMetricSchema = new Schema<IAiMetric>({
  sourceId: { type: Schema.Types.ObjectId, ref: 'AiSource', required: true },
  timestamp: { type: Date, required: true },

  calls: { type: Number, default: 0 },
  errorCount: { type: Number, default: 0 },
  tokensIn: { type: Number, default: 0 },
  tokensOut: { type: Number, default: 0 },
  costUsd: { type: Number, default: 0 },
  latencySum: { type: Number, default: 0 },
  latencyMax: { type: Number, default: 0 },
  ttftSum: { type: Number, default: 0 },
  ttftCount: { type: Number, default: 0 },

  models: { type: Map, of: Schema.Types.Mixed, default: {} },
  providers: { type: Map, of: Schema.Types.Mixed, default: {} },
  operations: { type: Map, of: Schema.Types.Mixed, default: {} },
});

AiMetricSchema.index({ sourceId: 1, timestamp: 1 });

applyPlanBasedTtl(AiMetricSchema, 'timestamp');

export const AiMetric = mongoose.model<IAiMetric>('AiMetric', AiMetricSchema);

// ---------------------------------------------------------------------------
// 5. AI Score (quality / evaluation / user feedback)
// ---------------------------------------------------------------------------
// A score attached to a trace (or a specific generation). Covers product
// signals (thumbs up/down), automated evals (relevance, toxicity, ...) and
// programmatic scores from the SDK. Numeric scores power averages and trends;
// boolean is stored as 0/1; categorical keeps a label in `stringValue`.
export type AiScoreDataType = 'numeric' | 'boolean' | 'categorical';
export type AiScoreSource = 'user' | 'eval' | 'api' | 'sdk';

export interface IAiScore extends Document {
  sourceId: mongoose.Types.ObjectId;
  traceId: string;
  generationId?: string;
  name: string;
  dataType: AiScoreDataType;
  value: number;          // numeric value; boolean → 0/1; categorical → 0 (use stringValue)
  stringValue?: string;   // categorical label
  comment?: string;
  scoredBy: AiScoreSource;
  /** Hashed/opaque author id (e.g. the end-user who gave feedback). Never raw PII. */
  authorId?: string;
  timestamp: Date;
  expiresAt?: Date; // Plan-based TTL (anchor: createdAt)
  createdAt: Date;
}

const AiScoreSchema = new Schema<IAiScore>({
  sourceId: { type: Schema.Types.ObjectId, ref: 'AiSource', required: true, index: true },
  traceId: { type: String, required: true },
  generationId: { type: String },
  name: { type: String, required: true },
  dataType: { type: String, enum: ['numeric', 'boolean', 'categorical'], default: 'numeric' },
  value: { type: Number, default: 0 },
  stringValue: { type: String },
  comment: { type: String },
  scoredBy: { type: String, enum: ['user', 'eval', 'api', 'sdk'], default: 'sdk' },
  authorId: { type: String },
  timestamp: { type: Date, default: Date.now },
}, { timestamps: true });

// All scores of a trace (shown in trace detail).
AiScoreSchema.index({ sourceId: 1, traceId: 1 });
// Score analytics over time (avg by name).
AiScoreSchema.index({ sourceId: 1, name: 1, timestamp: -1 });

applyPlanBasedTtl(AiScoreSchema, 'createdAt');

export const AiScore = mongoose.model<IAiScore>('AiScore', AiScoreSchema);
