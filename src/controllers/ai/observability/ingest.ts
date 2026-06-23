import { Request, Response } from 'express';
import { AiSource, AiTrace, AiGeneration, AiMetric, AiScore, AI_MODEL_OBSERVATION_TYPES } from '../../../models/Ai';
import { ErrorGroup, ErrorEvent, generateErrorFingerprint } from '../../../models/Error';
import { LogEvent } from '../../../models/Log';
import { buildServiceLogDoc } from '../../../utils/buildLogDoc';
import { logger } from '../../../utils/logger';
import { AiBatchSchema } from '../../../utils/validation';
import { maskAiContent } from '../../../utils/aiContent';
import { computeCost } from '../../../services/aiPricing';
import { aiIngestQueue, enqueue, type AiIngestPayload } from '../../../lib/queue';
import { getRetentionMs, stampExpiry } from '../../../services/retentionCache';

// ---------------------------------------------------------------------------
// AI Monitoring Ingest
// ----------------------------------------------------------------------------
// Authenticated by the AiSource apiKey. Accepts a batch of AI traces + their
// generations, acknowledges immediately (202), and processes in the background:
//   - cost is recomputed server-side (never trusted from the client)
//   - prompt/completion content is masked per the source's capture policy
//   - per-trace rollups are upserted (so streamed/multi-step traces merge)
//   - 1-minute metric buckets are aggregated for trend charts
// ---------------------------------------------------------------------------

const cleanMessageForFingerprint = (message: string): string =>
  message
    .replace(/[0-9a-fA-F]{24}/g, '<id>')
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      '<uuid>'
    )
    .replace(/\d+/g, '<num>');

export const ingestAiBatch = async (req: Request, res: Response) => {
  try {
    const apiKey = req.headers['x-service-api-key'] as string;
    if (!apiKey) return res.status(401).json({ error: 'Missing API Key' });

    const source = await AiSource.findOne({ apiKey }).select('+apiKey');
    if (!source) return res.status(403).json({ error: 'Invalid API Key' });

    const batch = AiBatchSchema.safeParse(req.body);
    if (!batch.success) {
      return res.status(400).json({
        error: 'Invalid payload format',
        details: batch.error,
      });
    }

    res.status(202).json({
      status: 'accepted',
      queuedTraces: batch.data.aiTraces.length,
      queuedGenerations: batch.data.aiGenerations.length,
      queuedScores: batch.data.aiScores.length,
      queuedErrors: batch.data.errors.length,
      queuedLogs: batch.data.logs.length,
    });

    await enqueue<AiIngestPayload>(
      aiIngestQueue,
      { batchData: batch.data, sourceId: source._id.toString() },
      () => { processAiBatchBackground(batch.data, source).catch((err) => logger.error(`[AI] Background processing failed: ${err.message}`)); },
    );
  } catch (error) {
    logger.error('[AI] Ingest Error', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
};

// ---------------------------------------------------------------------------
// Background processor
// ---------------------------------------------------------------------------

interface AiBatchData {
  aiTraces: any[];
  aiGenerations: any[];
  aiScores: any[];
  errors: any[];
  logs: any[];
}

interface TraceAccumulator {
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  generationCount: number;
  latencyMs: number;
  hasError: boolean;
  firstSeen: Date;
}

export const processAiBatchBackground = async (data: AiBatchData, source: any) => {
  await AiSource.findByIdAndUpdate(source._id, { lastSeen: new Date() });

  const retentionMs = await getRetentionMs(source.ownerId);

  // Browser sources never persist content, regardless of stored settings.
  const captureContent = source.type === 'browser' ? false : !!source.settings?.captureContent;
  const maskingRules: string[] = source.settings?.maskingRules ?? [];
  const overrides = source.settings?.pricingOverrides ?? {};

  const generationDocs: any[] = [];
  const metricsMap = new Map<string, any>();
  // Per-trace rollups derived from this batch's generations, merged into the
  // (possibly pre-existing) trace doc via $inc so multi-batch traces stay correct.
  const traceAcc = new Map<string, TraceAccumulator>();

  // -------------------------------------------------------------------------
  // 1. Generations — cost, masking, metric aggregation, per-trace rollup
  // -------------------------------------------------------------------------
  for (const gen of data.aiGenerations) {
    const tokensIn = gen.tokensIn || 0;
    const tokensOut = gen.tokensOut || 0;
    const totalTokens = tokensIn + tokensOut;

    // Server-authoritative cost.
    const { costUsd, estimated } = computeCost(
      gen.responseModel || gen.requestModel,
      tokensIn,
      tokensOut,
      overrides
    );

    const timestamp = new Date(gen.timestamp);
    const provider = gen.provider || 'custom';
    const operation = gen.operation || 'chat';
    const model = gen.responseModel || gen.requestModel || 'unknown';
    const isError = gen.status === 'error';
    // Structural spans (agent/tool/mcp/handoff/...) are stored for the trace
    // tree but excluded from cost/call metrics so they never pollute the
    // model/provider breakdowns or inflate the "calls" counters.
    const isModelCall = AI_MODEL_OBSERVATION_TYPES.has(gen.type || 'generation');

    generationDocs.push({
      sourceId: source._id,
      traceId: gen.traceId,
      generationId: gen.generationId,
      parentGenerationId: gen.parentGenerationId || undefined,
      type: gen.type || 'generation',
      name: gen.name || 'ai.generation',
      provider,
      operation,
      requestModel: gen.requestModel,
      responseModel: gen.responseModel,
      tokensIn,
      tokensOut,
      totalTokens,
      costUsd,
      costEstimated: estimated,
      startTime: gen.startTime || 0,
      latencyMs: gen.latencyMs || 0,
      timeToFirstTokenMs: gen.timeToFirstTokenMs,
      streaming: !!gen.streaming,
      params: gen.params,
      finishReason: gen.finishReason,
      status: gen.status || 'ok',
      statusCode: gen.statusCode,
      errorType: gen.errorType,
      errorMessage: gen.errorMessage,
      input: maskAiContent(gen.input, { captureContent, maskingRules }),
      output: maskAiContent(gen.output, { captureContent, maskingRules }),
      toolCalls: maskAiContent(gen.toolCalls, { captureContent, maskingRules }),
      // Structural enrichment. Identity (agent.name, tool.name, mcp.server, ...)
      // is always kept so failures stay attributable even with content OFF;
      // tool args/result are content and are masked under the capture policy.
      agent: gen.agent,
      tool: gen.tool ? {
        name: gen.tool.name,
        args: maskAiContent(gen.tool.args, { captureContent, maskingRules }),
        result: maskAiContent(gen.tool.result, { captureContent, maskingRules }),
      } : undefined,
      mcp: gen.mcp,
      handoff: gen.handoff,
      reasoningTokens: gen.reasoningTokens,
      depth: gen.depth,
      metadata: gen.metadata,
      timestamp,
    });

    // Per-trace rollup. Cost/tokens are summed across all observations
    // (structural spans contribute 0); generationCount counts model calls only.
    const acc = traceAcc.get(gen.traceId) ?? {
      totalCostUsd: 0, totalTokensIn: 0, totalTokensOut: 0,
      generationCount: 0, latencyMs: 0, hasError: false, firstSeen: timestamp,
    };
    acc.totalCostUsd += costUsd;
    acc.totalTokensIn += tokensIn;
    acc.totalTokensOut += tokensOut;
    if (isModelCall) {
      acc.generationCount += 1;
      // Only sum model-call latency: a parent agent/tool span's duration
      // already spans its children, so summing structural spans double-counts.
      acc.latencyMs += gen.latencyMs || 0;
      // Only a model-call (LLM/embedding) error fails the trace. A failed
      // tool/MCP/structural span is normal agent behaviour the workflow can
      // recover from and must NOT flip the whole trace to error — the explicit
      // trace status (meta.status from the SDK) stays authoritative otherwise.
      if (isError) acc.hasError = true;
    }
    if (timestamp < acc.firstSeen) acc.firstSeen = timestamp;
    traceAcc.set(gen.traceId, acc);

    // Metric bucket (1-minute resolution) — model calls only.
    if (!isModelCall) continue;
    const bucketTime = new Date(timestamp);
    bucketTime.setSeconds(0, 0);
    const bucketKey = bucketTime.toISOString();

    if (!metricsMap.has(bucketKey)) {
      metricsMap.set(bucketKey, {
        timestamp: bucketTime,
        calls: 0, errorCount: 0, tokensIn: 0, tokensOut: 0, costUsd: 0,
        latencySum: 0, latencyMax: 0, ttftSum: 0, ttftCount: 0,
        models: {}, providers: {}, operations: {},
      });
    }
    const m = metricsMap.get(bucketKey);
    m.calls += 1;
    if (isError) m.errorCount += 1;
    m.tokensIn += tokensIn;
    m.tokensOut += tokensOut;
    m.costUsd += costUsd;
    m.latencySum += gen.latencyMs || 0;
    if ((gen.latencyMs || 0) > m.latencyMax) m.latencyMax = gen.latencyMs || 0;
    if (typeof gen.timeToFirstTokenMs === 'number') {
      m.ttftSum += gen.timeToFirstTokenMs;
      m.ttftCount += 1;
    }

    const bump = (dim: Record<string, any>, key: string) => {
      const safeKey = key.replace(/\./g, '_').replace(/\$/g, '');
      if (!dim[safeKey]) dim[safeKey] = { calls: 0, errors: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, durationSum: 0 };
      const d = dim[safeKey];
      d.calls += 1;
      if (isError) d.errors += 1;
      d.tokensIn += tokensIn;
      d.tokensOut += tokensOut;
      d.costUsd += costUsd;
      d.durationSum += gen.latencyMs || 0;
    };
    bump(m.models, model);
    bump(m.providers, provider);
    bump(m.operations, operation);
  }

  // -------------------------------------------------------------------------
  // 2. Write generations
  // -------------------------------------------------------------------------
  if (generationDocs.length > 0) {
    stampExpiry(generationDocs, 'createdAt', retentionMs);
    await AiGeneration.insertMany(generationDocs, { ordered: false });
  }

  // -------------------------------------------------------------------------
  // 3. Upsert traces (merge client-sent trace meta with derived rollups)
  // -------------------------------------------------------------------------
  const traceMetaById = new Map<string, any>();
  for (const t of data.aiTraces) traceMetaById.set(t.traceId, t);

  // Union of trace ids seen via explicit trace items and via generations.
  const allTraceIds = new Set<string>([...traceMetaById.keys(), ...traceAcc.keys()]);

  if (allTraceIds.size > 0) {
    const traceOps = Array.from(allTraceIds).map((traceId) => {
      const meta = traceMetaById.get(traceId);
      const acc = traceAcc.get(traceId);
      const anchor = acc?.firstSeen ?? (meta?.timestamp ? new Date(meta.timestamp) : new Date());
      const status = acc?.hasError || meta?.status === 'error' ? 'error' : 'ok';

      const inc: Record<string, number> = {};
      if (acc) {
        inc.totalCostUsd = acc.totalCostUsd;
        inc.totalTokensIn = acc.totalTokensIn;
        inc.totalTokensOut = acc.totalTokensOut;
        inc.totalTokens = acc.totalTokensIn + acc.totalTokensOut;
        inc.generationCount = acc.generationCount;
      }

      const setOnInsert: Record<string, any> = {
        sourceId: source._id,
        traceId,
        name: meta?.name || 'ai.trace',
        timestamp: anchor,
      };
      if (meta?.apmTraceId) setOnInsert.apmTraceId = meta.apmTraceId;
      if (meta?.sessionId) setOnInsert.sessionId = meta.sessionId;
      if (meta?.userId) setOnInsert.userId = meta.userId;

      const set: Record<string, any> = {
        status,
        expiresAt: new Date(anchor.getTime() + retentionMs),
      };
      if (meta?.tags?.length) set.tags = meta.tags;
      if (meta?.metadata) set.metadata = meta.metadata;

      const maxLatency = Math.max(meta?.latencyMs || 0, acc?.latencyMs || 0);

      return {
        updateOne: {
          filter: { sourceId: source._id, traceId },
          update: {
            $setOnInsert: setOnInsert,
            $set: set,
            ...(Object.keys(inc).length ? { $inc: inc } : {}),
            $max: { latencyMs: maxLatency },
          },
          upsert: true,
        },
      };
    });

    if (traceOps.length > 0) {
      await AiTrace.bulkWrite(traceOps, { ordered: false });
    }
  }

  // -------------------------------------------------------------------------
  // 4. Metric buckets (bulk upsert)
  // -------------------------------------------------------------------------
  const metricOps = Array.from(metricsMap.values()).map((m) => {
    const inc: Record<string, any> = {
      calls: m.calls,
      errorCount: m.errorCount,
      tokensIn: m.tokensIn,
      tokensOut: m.tokensOut,
      costUsd: m.costUsd,
      latencySum: m.latencySum,
      ttftSum: m.ttftSum,
      ttftCount: m.ttftCount,
    };

    const addDim = (prefix: string, obj: Record<string, any>) => {
      for (const [k, v] of Object.entries(obj)) {
        const val = v as any;
        inc[`${prefix}.${k}.calls`] = val.calls;
        inc[`${prefix}.${k}.errors`] = val.errors;
        inc[`${prefix}.${k}.tokensIn`] = val.tokensIn;
        inc[`${prefix}.${k}.tokensOut`] = val.tokensOut;
        inc[`${prefix}.${k}.costUsd`] = val.costUsd;
        inc[`${prefix}.${k}.durationSum`] = val.durationSum;
      }
    };
    addDim('models', m.models);
    addDim('providers', m.providers);
    addDim('operations', m.operations);

    return {
      updateOne: {
        filter: { sourceId: source._id, timestamp: m.timestamp },
        update: {
          $inc: inc,
          $max: { latencyMax: m.latencyMax },
          $set: { expiresAt: new Date(m.timestamp.getTime() + retentionMs) },
        },
        upsert: true,
      },
    };
  });

  if (metricOps.length > 0) {
    await AiMetric.bulkWrite(metricOps, { ordered: false });
  }

  // -------------------------------------------------------------------------
  // 5. Scores (quality / eval / feedback from the SDK)
  // -------------------------------------------------------------------------
  if (data.aiScores?.length > 0) {
    const scoreDocs = data.aiScores.map((s: any) => ({
      sourceId: source._id,
      traceId: s.traceId,
      generationId: s.generationId || undefined,
      name: s.name,
      dataType: s.dataType || 'numeric',
      value: typeof s.value === 'number' ? s.value : 0,
      stringValue: s.stringValue,
      comment: s.comment,
      scoredBy: 'sdk',
      authorId: s.authorId,
      timestamp: new Date(s.timestamp),
    }));
    stampExpiry(scoreDocs, 'createdAt', retentionMs);
    await AiScore.insertMany(scoreDocs, { ordered: false });
  }

  // -------------------------------------------------------------------------
  // 6. Errors (folded into the shared Errors pillar, attributed to AiSource)
  // -------------------------------------------------------------------------
  if (data.errors?.length > 0) {
    const errorEvents: any[] = [];
    const errorGroupsMap = new Map<string, any>();

    for (const err of data.errors) {
      const fingerprint = generateErrorFingerprint(
        source._id,
        err.errorClass,
        cleanMessageForFingerprint(err.message)
      );
      const errTimestamp = err.timestamp ? new Date(err.timestamp) : new Date();

      errorEvents.push({
        serviceId: source._id,
        serviceModel: 'AiSource',
        traceId: err.traceId,
        fingerprint,
        stackTrace: err.stackTrace || '',
        context: err.context || {},
        timestamp: errTimestamp,
      });

      if (!errorGroupsMap.has(fingerprint)) {
        errorGroupsMap.set(fingerprint, {
          fingerprint, errorClass: err.errorClass, message: err.message,
          firstSeen: errTimestamp, lastSeen: errTimestamp, count: 0,
        });
      }
      const group = errorGroupsMap.get(fingerprint);
      group.count++;
      if (errTimestamp > group.lastSeen) group.lastSeen = errTimestamp;
      if (errTimestamp < group.firstSeen) group.firstSeen = errTimestamp;
    }

    const groupPromises = Array.from(errorGroupsMap.values()).map(async (g) => {
      const groupDoc = await ErrorGroup.findOneAndUpdate(
        { ownerId: source.ownerId, fingerprint: g.fingerprint },
        {
          $setOnInsert: {
            ownerId: source.ownerId,
            serviceId: source._id,
            serviceModel: 'AiSource',
            fingerprint: g.fingerprint,
            errorClass: g.errorClass,
            message: g.message,
            firstSeen: g.firstSeen,
            status: 'unresolved',
          },
          $max: {
            lastSeen: g.lastSeen,
            expiresAt: new Date(g.lastSeen.getTime() + retentionMs),
          },
          $inc: { totalCount: g.count },
        },
        { upsert: true, new: true }
      );
      return { fingerprint: g.fingerprint, groupId: groupDoc._id };
    });

    const resolvedGroups = await Promise.all(groupPromises);
    const fingerprintToGroupId = new Map(resolvedGroups.map((g) => [g.fingerprint, g.groupId]));

    const finalErrorEvents = errorEvents.map(({ fingerprint, ...rest }) => ({
      ...rest,
      groupId: fingerprintToGroupId.get(fingerprint),
    }));

    stampExpiry(finalErrorEvents, 'timestamp', retentionMs);
    await ErrorEvent.insertMany(finalErrorEvents, { ordered: false });
  }

  // -------------------------------------------------------------------------
  // 7. Logs (attributed to the AI source)
  // -------------------------------------------------------------------------
  if (data.logs?.length > 0) {
    const logsToInsert = data.logs.map((log: any) => buildServiceLogDoc(log, {
      ownerId: source.ownerId,
      serviceId: source._id,
      serviceModel: 'AiSource',
      source: source.name,
    }));

    stampExpiry(logsToInsert, 'timestamp', retentionMs);
    await LogEvent.insertMany(logsToInsert, { ordered: false });
  }
};
