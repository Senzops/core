import { GoogleGenAI, Type } from '@google/genai';
import { IAiAnalysis } from '../models/Alert';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_TOOL_CALLS = 15;
const ANALYSIS_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Retryable Error Classification
// ---------------------------------------------------------------------------

/**
 * Thrown when a Gemini API call fails with a transient error (503, 429, etc.)
 * that should be retried with exponential backoff at the queue level.
 */
export class RetryableAnalysisError extends Error {
  public readonly statusCode: number;
  public readonly shortMessage: string;

  constructor(originalMessage: string, statusCode: number, shortMessage: string) {
    super(originalMessage);
    this.name = 'RetryableAnalysisError';
    this.statusCode = statusCode;
    this.shortMessage = shortMessage;
  }
}

/** HTTP status codes that indicate transient Gemini API issues. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);

/** gRPC status strings that map to transient failures. */
const RETRYABLE_GRPC_STATUSES = new Set([
  'UNAVAILABLE',
  'INTERNAL',
  'RESOURCE_EXHAUSTED',
  'DEADLINE_EXCEEDED',
]);

/**
 * Classifies a Gemini API error as retryable (transient) or permanent.
 * Parses multiple error formats: structured JSON, SDK properties, pattern matching.
 */
function classifyGeminiError(err: any): {
  retryable: boolean;
  statusCode: number;
  shortMessage: string;
} {
  const rawMessage = (err.message || '').toString();

  // 1. Check SDK error object properties (varies by SDK version)
  for (const prop of ['status', 'code', 'httpStatusCode'] as const) {
    const val = (err as any)[prop];
    if (typeof val === 'number' && RETRYABLE_STATUS_CODES.has(val)) {
      return { retryable: true, statusCode: val, shortMessage: rawMessage.substring(0, 250) };
    }
  }

  // 2. Parse structured Gemini error: {"error":{"code":503,"status":"UNAVAILABLE","message":"..."}}
  try {
    const parsed = JSON.parse(rawMessage);
    const errObj = parsed?.error || parsed;
    const code = errObj?.code;
    const status = errObj?.status;
    const msg: string = errObj?.message || rawMessage;

    if (typeof code === 'number' && RETRYABLE_STATUS_CODES.has(code)) {
      return { retryable: true, statusCode: code, shortMessage: msg.substring(0, 250) };
    }
    if (typeof status === 'string' && RETRYABLE_GRPC_STATUSES.has(status)) {
      return { retryable: true, statusCode: code || 503, shortMessage: msg.substring(0, 250) };
    }
  } catch {
    // Not structured JSON — fall through to pattern matching
  }

  // 3. Pattern match for status codes embedded in message
  const codeMatch = rawMessage.match(/"code"\s*:\s*(429|500|502|503)\b/);
  if (codeMatch) {
    return {
      retryable: true,
      statusCode: parseInt(codeMatch[1], 10),
      shortMessage: rawMessage.substring(0, 250),
    };
  }

  // 4. Network-level transient errors
  if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EPIPE|socket hang up|fetch failed/i.test(rawMessage)) {
    return { retryable: true, statusCode: 0, shortMessage: rawMessage.substring(0, 250) };
  }

  // 5. Non-retryable (400 bad request, 403 permission denied, 404 not found, etc.)
  return { retryable: false, statusCode: 0, shortMessage: rawMessage.substring(0, 250) };
}

// ---------------------------------------------------------------------------
// Tool Definitions for Gemini (subset of MCP tools relevant to incident triage)
// ---------------------------------------------------------------------------

// We use the same controller layer as the MCP agent, but call them directly
// rather than going through the MCP protocol. This avoids SSE overhead and
// keeps the analysis path simple.

import { listServices as listApmServices } from '../controllers/apm/main';
import { getApmStats } from '../controllers/apm/stats';
import { getInvocations } from '../controllers/apm/traces';
import { getRuntimeStats } from '../controllers/apm/runtimeStats';
import { listServices as listRumServices } from '../controllers/rum/main';
import { getRumDashboard } from '../controllers/rum/stats';
import { listTaskServices } from '../controllers/task/main';
import { getTaskServiceDashboard } from '../controllers/task/stats';
import { getDashboardLogs } from '../controllers/logs';
import { getGlobalErrors, getErrorGroupDetails } from '../controllers/error';
import { listMonitors, getMonitorStats } from '../controllers/monitor';
import { listVps, getVpsStats } from '../controllers/vps';
import { listDatabases } from '../controllers/database/main';
import { getDatabaseStats } from '../controllers/database/stats';
import { listQueueSources } from '../controllers/queue/main';
import { getQueueStats } from '../controllers/queue/stats';
import { listAiSources, getAiStats, getAiTraces, getAiConsumers } from '../controllers/ai/observability';
import { Request, Response } from 'express';
import { recordSelfGeneration } from './selfAiMonitor';

// Simulated Express call — same pattern as mcp/tools.ts
const simulateExpressCall = async (
  controller: Function,
  ownerId: string,
  params: Record<string, any> = {},
  query: Record<string, any> = {}
): Promise<{ status: number; data: any }> => {
  return new Promise((resolve, reject) => {
    const req = {
      ownerId,
      user: { uid: ownerId },
      params,
      query,
      body: {},
      headers: {},
      ip: '127.0.0.1',
    } as unknown as Request;

    let currentStatus = 200;

    const res = {
      status: (code: number) => { currentStatus = code; return res; },
      json: (data: any) => { resolve({ status: currentStatus, data }); return res; },
      send: (data: any) => { resolve({ status: currentStatus, data }); return res; },
    } as unknown as Response;

    const next = (err?: any) => {
      if (err) reject(err);
      else resolve({ status: 500, data: { error: 'Next() called' } });
    };

    try {
      Promise.resolve(controller(req, res, next)).catch(reject);
    } catch (error) {
      reject(error);
    }
  });
};

// ---------------------------------------------------------------------------
// Tool Registry (tool name → executor mapping)
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute: (args: any, ownerId: string) => Promise<any>;
}

const INVESTIGATION_TOOLS: ToolDef[] = [
  {
    name: 'apm_list_services',
    description: 'List all active APM (Backend) services and their IDs.',
    parameters: { type: 'object', properties: {} },
    execute: (args, uid) => simulateExpressCall(listApmServices, uid),
  },
  {
    name: 'apm_get_stats',
    description: 'Get performance aggregations (latency percentiles, RPS, error rate) for an APM service.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, range: { type: 'string' } }, required: ['id'] },
    execute: (args, uid) => simulateExpressCall(getApmStats, uid, { id: args.id }, { range: args.range || '1h' }),
  },
  {
    name: 'apm_get_invocations',
    description: 'Get recent HTTP trace invocations for a service, including status codes and latency.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    execute: (args, uid) => simulateExpressCall(getInvocations, uid, { id: args.id }, { limit: 15 }),
  },
  {
    name: 'apm_get_runtime_stats',
    description: 'Get Node.js runtime health: event loop lag, GC, heap, CPU for an APM service.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, range: { type: 'string' } }, required: ['id'] },
    execute: (args, uid) => simulateExpressCall(getRuntimeStats, uid, { id: args.id }, { range: args.range || '1h' }),
  },
  {
    name: 'rum_list_services',
    description: 'List all active RUM (Frontend) applications.',
    parameters: { type: 'object', properties: {} },
    execute: (args, uid) => simulateExpressCall(listRumServices, uid),
  },
  {
    name: 'rum_get_dashboard',
    description: 'Get Web Vitals (LCP, INP, CLS) and page views for a RUM app.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, range: { type: 'string' } }, required: ['id'] },
    execute: (args, uid) => simulateExpressCall(getRumDashboard, uid, { id: args.id }, { range: args.range || '1h' }),
  },
  {
    name: 'task_list_services',
    description: 'List all Background Task services.',
    parameters: { type: 'object', properties: {} },
    execute: (args, uid) => simulateExpressCall(listTaskServices, uid),
  },
  {
    name: 'task_get_dashboard',
    description: 'Get job execution metrics (failure rate, delays, durations) for a task service.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, range: { type: 'string' } }, required: ['id'] },
    execute: (args, uid) => simulateExpressCall(getTaskServiceDashboard, uid, { id: args.id }, { range: args.range || '1h' }),
  },
  {
    name: 'logs_query',
    description: 'Search system logs. Supports text search and level filtering (e.g. "level:error database timeout").',
    parameters: { type: 'object', properties: { search: { type: 'string' }, range: { type: 'string' }, limit: { type: 'number' } } },
    execute: (args, uid) => simulateExpressCall(getDashboardLogs, uid, {}, { search: args.search, range: args.range || '1h', limit: Math.min(args.limit || 20, 30) }),
  },
  {
    name: 'error_get_global',
    description: 'Get unresolved exception groups across the platform with occurrence counts.',
    parameters: { type: 'object', properties: {} },
    execute: (args, uid) => simulateExpressCall(getGlobalErrors, uid, {}, { status: 'unresolved', limit: 15 }),
  },
  {
    name: 'error_get_group_detail',
    description: 'Get details and recent occurrences of a specific error fingerprint.',
    parameters: { type: 'object', properties: { groupId: { type: 'string' }, range: { type: 'string' } }, required: ['groupId'] },
    execute: (args, uid) => simulateExpressCall(getErrorGroupDetails, uid, { groupId: args.groupId }, { range: args.range || '1h' }),
  },
  {
    name: 'uptime_list_monitors',
    description: 'List all uptime monitors with their current status (up/down/timeout).',
    parameters: { type: 'object', properties: {} },
    execute: (args, uid) => simulateExpressCall(listMonitors, uid),
  },
  {
    name: 'uptime_get_stats',
    description: 'Get uptime percentage, latency percentiles, and status history for a monitor.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, range: { type: 'string' } }, required: ['id'] },
    execute: (args, uid) => simulateExpressCall(getMonitorStats, uid, { id: args.id }, { range: args.range || '1h' }),
  },
  {
    name: 'vps_list',
    description: 'List monitored Linux VPS servers with their last-seen status.',
    parameters: { type: 'object', properties: {} },
    execute: (args, uid) => simulateExpressCall(listVps, uid),
  },
  {
    name: 'vps_get_stats',
    description: 'Get CPU, RAM, Disk, Network, and Docker metrics for a VPS.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, range: { type: 'string' } }, required: ['id'] },
    execute: (args, uid) => simulateExpressCall(getVpsStats, uid, { id: args.id }, { range: args.range || '1h' }),
  },
  {
    name: 'database_list',
    description: 'List monitored database instances (MongoDB, Redis, PostgreSQL, MySQL).',
    parameters: { type: 'object', properties: {} },
    execute: (args, uid) => simulateExpressCall(listDatabases, uid),
  },
  {
    name: 'database_get_stats',
    description: 'Get database throughput, latency metrics, and connection stats.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, range: { type: 'string' } }, required: ['id'] },
    execute: (args, uid) => simulateExpressCall(getDatabaseStats, uid, { id: args.id }, { range: args.range || '1h' }),
  },
  {
    name: 'queue_list',
    description: 'List monitored queue sources (BullMQ, RabbitMQ, Kafka, AWS SQS) and their status.',
    parameters: { type: 'object', properties: {} },
    execute: (args, uid) => simulateExpressCall(listQueueSources, uid),
  },
  {
    name: 'queue_get_stats',
    description: 'Get a queue source overview: total backlog, in-flight, dead-letter depth, consumer count, per-queue table, and throughput/backlog history. Use to check whether a backed-up or dead-lettering queue is causing an incident.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, range: { type: 'string' } }, required: ['id'] },
    execute: (args, uid) => simulateExpressCall(getQueueStats, uid, { id: args.id }, { range: args.range || '1h' }),
  },
  {
    name: 'ai_list_sources',
    description: 'List all AI Monitoring sources (LLM observability projects) and their IDs.',
    parameters: { type: 'object', properties: {} },
    execute: (args, uid) => simulateExpressCall(listAiSources, uid),
  },
  {
    name: 'ai_get_stats',
    description: 'Get an AI source overview: total cost (USD), LLM calls, tokens, error rate, latency p50/p95/p99, and breakdowns by model, provider and operation. Use to check whether LLM cost spikes, error rates or latency are driving an incident.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, range: { type: 'string' } }, required: ['id'] },
    execute: (args, uid) => simulateExpressCall(getAiStats, uid, { id: args.id }, { range: args.range || '1h' }),
  },
  {
    name: 'ai_get_traces',
    description: "List recent AI traces for a source with status, cost, tokens and latency. Filter by status ('error') to find failing LLM workflows.",
    parameters: { type: 'object', properties: { id: { type: 'string' }, range: { type: 'string' }, status: { type: 'string' } }, required: ['id'] },
    execute: (args, uid) => simulateExpressCall(getAiTraces, uid, { id: args.id }, { range: args.range || '1h', status: args.status, limit: 15 }),
  },
  {
    name: 'ai_get_consumers',
    description: 'Get the top users and sessions for an AI source by cost — useful to attribute an LLM cost spike to a specific user or conversation.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, range: { type: 'string' } }, required: ['id'] },
    execute: (args, uid) => simulateExpressCall(getAiConsumers, uid, { id: args.id }, { range: args.range || '1h' }),
  },
];

// Build Gemini-format tool declarations
const geminiToolDeclarations = INVESTIGATION_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: t.parameters,
}));

const toolMap = new Map(INVESTIGATION_TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Senzor's Incident Analysis Engine — an expert SRE AI that investigates fired alert incidents.

Your job: When an alert fires, investigate the user's observability data to determine the root cause, which services are affected, and what the operator should do.

INVESTIGATION PROTOCOL:
1. Start by understanding the alert condition (target type, threshold, trigger value).
2. List the relevant services for that target type to identify IDs.
3. Get stats for those services to find anomalies.
4. Check error groups for recent spikes.
5. Search logs for error-level entries in the incident time window.
6. Check related systems (if APM is affected, check VPS/database; if uptime is affected, check APM).
7. Cross-correlate findings to form a root cause hypothesis.

RULES:
- Be concise and precise. Operators are under pressure during incidents.
- Always cite evidence from tool results (specific metric values, error messages, service names).
- If you cannot determine a root cause, say so honestly and state what you checked.
- Never fabricate data. Only report what the tools return.
- Focus investigation on the time window relevant to the incident (use range:"1h" or shorter).
- Maximum ${MAX_TOOL_CALLS} tool calls per analysis — prioritize high-signal investigations.
- CRITICAL: The "trigger value" is the count of matching EVENT RECORDS in the alert time window — NOT the number of distinct affected resources. Example: trigger value 10 for a "VPS down" condition means 10 "down" health-check records were found — this could be 2 servers each reporting down 5 times, not 10 servers. Always verify the actual resource state with tools before drawing conclusions about the scale of impact.`;

// ---------------------------------------------------------------------------
// Structured Output Schema
// ---------------------------------------------------------------------------

const ANALYSIS_OUTPUT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: {
      type: Type.STRING,
      description: 'A concise 1-3 sentence summary of the incident and its likely cause. Written for a busy SRE reading an alert notification.',
    },
    rootCause: {
      type: Type.STRING,
      description: 'Detailed root cause hypothesis with evidence from the investigation. Cite specific metrics, error messages, and service names.',
    },
    affectedServices: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Names of affected services, monitors, or infrastructure components.',
    },
    correlatedEvents: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Other notable events discovered during investigation (error spikes, latency changes, resource exhaustion).',
    },
    recommendedActions: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Specific, actionable steps the operator should take. Be concrete (e.g., "Restart auth-service pod" not "Check services").',
    },
    confidence: {
      type: Type.STRING,
      enum: ['high', 'medium', 'low'],
      description: 'Confidence in the root cause: high = clear evidence, medium = likely but some uncertainty, low = best guess based on limited data.',
    },
  },
  required: ['summary', 'rootCause', 'affectedServices', 'correlatedEvents', 'recommendedActions', 'confidence'],
};

// ---------------------------------------------------------------------------
// Core Analysis Function
// ---------------------------------------------------------------------------

export interface IncidentContext {
  incidentId: string;
  ownerId: string;
  conditionName: string;
  conditionDescription: string;
  target: string;
  triggerValue: number;
  threshold: { operator: string; value: number; windowMins: number };
  severity: string;
  labels: string[];
  title: string;
  query?: Record<string, unknown>;
}

// Record this analysis run into our own AI Monitoring pillar (dogfooding).
// Fire-and-forget; never affects the analysis outcome. Skipped runs (no Gemini
// key) and retryable failures are intentionally not recorded — only terminal
// outcomes with real token usage.
const recordAnalysisUsage = async (ctx: IncidentContext, result: IAiAnalysis): Promise<void> => {
  if (result.status === 'skipped') return;
  await recordSelfGeneration({
    traceName: 'incident-analysis',
    operation: 'chat',
    model: result.model,
    tokensIn: result.tokensUsed.input,
    tokensOut: result.tokensUsed.output,
    latencyMs: result.durationMs,
    status: result.status === 'completed' ? 'ok' : 'error',
    errorMessage: result.error,
    sessionId: ctx.incidentId,
    metadata: {
      incidentId: ctx.incidentId,
      target: ctx.target,
      severity: ctx.severity,
      toolCalls: result.toolCallsUsed,
    },
  });
};

export const runIncidentAnalysis = async (ctx: IncidentContext): Promise<IAiAnalysis> => {
  const startTime = Date.now();
  let toolCallsUsed = 0;
  let tokensUsed = { input: 0, output: 0 };

  // Guard: no API key configured
  if (!process.env.GEMINI_API_KEY) {
    logger.warn('[AI Analysis] GEMINI_API_KEY not configured, skipping analysis');
    return createSkippedResult('GEMINI_API_KEY not configured');
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const operatorSymbol = ({ gt: '>', lt: '<', eq: '==', gte: '>=', lte: '<=', neq: '!=' } as Record<string, string>)[ctx.threshold.operator] || ctx.threshold.operator;

  // Build query display — show the filter the alert system used to count events
  const queryDisplay = ctx.query
    ? (() => {
        const raw = JSON.stringify(ctx.query);
        return raw.length > 300 ? raw.substring(0, 300) + '…' : raw;
      })()
    : null;

  const userPrompt = `INCIDENT FIRED — Investigate immediately.

ALERT DETAILS:
- Incident: ${ctx.title}
- Condition: ${ctx.conditionName}${ctx.conditionDescription ? ` — ${ctx.conditionDescription}` : ''}
- Monitoring Target: ${ctx.target.toUpperCase()}
- Severity: ${ctx.severity.toUpperCase()}
${ctx.labels.length > 0 ? `- Labels: ${ctx.labels.join(', ')}\n` : ''}
BREACH DETAILS:
- Alert rule: fire when matching event count ${operatorSymbol} ${ctx.threshold.value} within ${ctx.threshold.windowMins} minute(s)
- Actual count: ${ctx.triggerValue} matching events detected (threshold breached)
${queryDisplay ? `- Event filter applied: ${queryDisplay}\n` : ''}
IMPORTANT: The trigger value (${ctx.triggerValue}) is the number of matching EVENT RECORDS found in the monitoring database during the ${ctx.threshold.windowMins}-minute window. It is NOT a count of distinct affected resources. For example, 2 VPS servers each reporting "down" 5 times produces a count of 10 events, not 10 servers. Always verify the actual current state of resources using the investigation tools.

Time: ${new Date().toISOString()}

Begin investigation: check the current state of ${ctx.target.toUpperCase()} resources, then expand to correlated systems.`;

  try {
    // Create a chat session with tools
    const chat = ai.chats.create({
      model: GEMINI_MODEL,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ functionDeclarations: geminiToolDeclarations }],
        temperature: 0.1,  // Deterministic for reliability
      },
    });

    // Set up abort timer
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), ANALYSIS_TIMEOUT_MS);

    let response = await chat.sendMessage({ message: userPrompt });

    // Agentic tool-calling loop
    while (response.functionCalls && response.functionCalls.length > 0 && toolCallsUsed < MAX_TOOL_CALLS) {
      if (abortController.signal.aborted) break;

      const responseParts: any[] = [];

      for (const call of response.functionCalls) {
        if (toolCallsUsed >= MAX_TOOL_CALLS) break;
        toolCallsUsed++;

        const callName = call.name ?? '';
        const tool = toolMap.get(callName);
        if (!tool) {
          responseParts.push({
            functionResponse: { name: callName, response: { error: `Unknown tool: ${callName}` } },
          });
          continue;
        }

        try {
          const result = await tool.execute(call.args || {}, ctx.ownerId);
          // Gemini's FunctionResponse.response is a google.protobuf.Struct,
          // which MUST be a JSON object — never an array or primitive.
          // Many controllers return raw arrays (e.g. res.json(services)),
          // so we always wrap in { output: ... } per Gemini's convention.
          const resultStr = JSON.stringify(result.data);
          let responseData: Record<string, unknown>;
          if (resultStr.length > 8000) {
            responseData = { output: resultStr.substring(0, 8000), truncated: true };
          } else if (Array.isArray(result.data)) {
            // Arrays cannot be Struct — wrap in object
            responseData = { output: result.data };
          } else if (result.data && typeof result.data === 'object') {
            responseData = result.data;
          } else {
            responseData = { output: result.data };
          }
          responseParts.push({
            functionResponse: { name: callName, response: responseData },
          });
        } catch (err: any) {
          responseParts.push({
            functionResponse: { name: callName, response: { error: err.message } },
          });
          logger.warn(`[AI Analysis] Tool ${callName} failed: ${err.message}`);
        }
      }

      // Send tool results back to Gemini
      response = await chat.sendMessage({ message: responseParts });
    }

    clearTimeout(timeout);

    // Extract usage metadata
    if (response.usageMetadata) {
      tokensUsed.input = response.usageMetadata.promptTokenCount || 0;
      tokensUsed.output = response.usageMetadata.candidatesTokenCount || 0;
    }

    // Now ask for structured output
    const structuredResponse = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: `Based on the following investigation, produce a structured incident analysis.

Investigation transcript:
${response.text || 'No text response from investigation.'}

Produce the structured analysis now.`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: ANALYSIS_OUTPUT_SCHEMA,
        temperature: 0.1,
      },
    });

    // Accumulate tokens from structured call
    if (structuredResponse.usageMetadata) {
      tokensUsed.input += structuredResponse.usageMetadata.promptTokenCount || 0;
      tokensUsed.output += structuredResponse.usageMetadata.candidatesTokenCount || 0;
    }

    // Parse structured output
    const rawText = structuredResponse.text || '';
    let parsed: any;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // Fallback: use the raw investigation text as summary
      logger.warn('[AI Analysis] Failed to parse structured output, using raw text');
      const fallbackResult: IAiAnalysis = {
        status: 'completed',
        summary: response.text?.substring(0, 500) || 'Analysis completed but structured output parsing failed.',
        findings: {
          rootCause: response.text || 'See summary.',
          affectedServices: [],
          correlatedEvents: [],
          recommendedActions: [],
        },
        confidence: 'low',
        toolCallsUsed,
        tokensUsed,
        model: GEMINI_MODEL,
        analyzedAt: new Date(),
        durationMs: Date.now() - startTime,
      };
      await recordAnalysisUsage(ctx, fallbackResult);
      return fallbackResult;
    }

    const result: IAiAnalysis = {
      status: 'completed',
      summary: parsed.summary || '',
      findings: {
        rootCause: parsed.rootCause || '',
        affectedServices: parsed.affectedServices || [],
        correlatedEvents: parsed.correlatedEvents || [],
        recommendedActions: parsed.recommendedActions || [],
      },
      confidence: parsed.confidence || 'low',
      toolCallsUsed,
      tokensUsed,
      model: GEMINI_MODEL,
      analyzedAt: new Date(),
      durationMs: Date.now() - startTime,
    };
    await recordAnalysisUsage(ctx, result);
    return result;
  } catch (err: any) {
    const { retryable, statusCode, shortMessage } = classifyGeminiError(err);

    if (retryable) {
      // Throw for BullMQ worker to handle retry scheduling
      throw new RetryableAnalysisError(err.message, statusCode, shortMessage);
    }

    // Non-retryable error — return failed result immediately
    logger.error(`[AI Analysis] Non-retryable failure for incident ${ctx.incidentId}: ${shortMessage}`);
    const failedResult: IAiAnalysis = {
      status: 'failed',
      summary: '',
      findings: {
        rootCause: '',
        affectedServices: [],
        correlatedEvents: [],
        recommendedActions: [],
      },
      confidence: 'low',
      toolCallsUsed,
      tokensUsed,
      model: GEMINI_MODEL,
      analyzedAt: new Date(),
      durationMs: Date.now() - startTime,
      error: shortMessage,
    };
    await recordAnalysisUsage(ctx, failedResult);
    return failedResult;
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createSkippedResult = (reason: string): IAiAnalysis => ({
  status: 'skipped',
  summary: '',
  findings: {
    rootCause: '',
    affectedServices: [],
    correlatedEvents: [],
    recommendedActions: [],
  },
  confidence: 'low',
  toolCallsUsed: 0,
  tokensUsed: { input: 0, output: 0 },
  model: GEMINI_MODEL,
  analyzedAt: null,
  durationMs: 0,
  error: reason,
});
