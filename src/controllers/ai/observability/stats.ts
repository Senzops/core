import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { AiSource, AiTrace, AiGeneration, AiMetric, AiScore } from '../../../models/Ai';
import { AiScoreSubmitSchema } from '../../../utils/validation';
import { computeExpiresAt } from '../../../services/retentionCache';
import {
  resolveTimeRange, fillTimeGaps, getEffectiveRetention, buildTimeRangeMeta, TimeRangeError,
} from '../../../utils/timeRange';

// ---------------------------------------------------------------------------
// AI Monitoring — read/query controllers
//
// Mirrors the APM stats engine: the main dashboard reads pre-aggregated
// `AiMetric` buckets (fast); a model/provider/operation drill-down reads raw
// `AiGeneration` documents for exact, filterable accuracy. Both bucket the time
// series by the resolved `bucketFormat` and gap-fill so charts never break.
// ---------------------------------------------------------------------------

const GRAPH_DEFAULTS = {
  calls: 0, errors: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, avgLatencyMs: 0,
};

/** Resolve a source the caller owns, or null. */
const ownedSource = async (req: Request) => {
  const ownerId = (req as any).ownerId;
  const { id } = req.params;
  return AiSource.findOne({ _id: id, ownerId }).lean();
};

const percentile = (sorted: number[], p: number): number => {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
};

/** Build the raw-generation match for an optional model/provider/operation filter. */
const buildGenFilter = (q: any): Record<string, any> => {
  const f: Record<string, any> = {};
  if (q.model) f.$or = [{ responseModel: q.model }, { requestModel: q.model }];
  if (q.provider) f.provider = q.provider;
  if (q.operation) f.operation = q.operation;
  return f;
};

const hasDimensionFilter = (q: any): boolean => !!(q.model || q.provider || q.operation);

// Fold a Map-style dimension breakdown across metric buckets into a flat array.
const foldDimension = (buckets: any[], field: 'models' | 'providers' | 'operations') => {
  const agg = new Map<string, any>();
  for (const b of buckets) {
    const dim = b[field];
    if (!dim) continue;
    for (const [key, raw] of Object.entries(dim)) {
      const v = raw as any;
      const cur = agg.get(key) ?? { key, calls: 0, errors: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, durationSum: 0 };
      cur.calls += v.calls || 0;
      cur.errors += v.errors || 0;
      cur.tokensIn += v.tokensIn || 0;
      cur.tokensOut += v.tokensOut || 0;
      cur.costUsd += v.costUsd || 0;
      cur.durationSum += v.durationSum || 0;
      agg.set(key, cur);
    }
  }
  return Array.from(agg.values())
    .map((d) => ({ ...d, avgLatencyMs: d.calls ? d.durationSum / d.calls : 0 }))
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
};

// Raw-generation dimension breakdown (used in the filtered drill-down view).
const rawDimension = async (match: any, keyExpr: any) => {
  const rows = await AiGeneration.aggregate([
    { $match: match },
    {
      $group: {
        _id: keyExpr,
        calls: { $sum: 1 },
        errors: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
        tokensIn: { $sum: '$tokensIn' },
        tokensOut: { $sum: '$tokensOut' },
        costUsd: { $sum: '$costUsd' },
        durationSum: { $sum: '$latencyMs' },
      },
    },
    { $sort: { costUsd: -1 as const } },
    { $limit: 50 },
  ]);
  return rows
    .filter((r: any) => r._id != null && r._id !== '')
    .map((r: any) => ({
      key: r._id, calls: r.calls, errors: r.errors, tokensIn: r.tokensIn, tokensOut: r.tokensOut,
      costUsd: r.costUsd, durationSum: r.durationSum, avgLatencyMs: r.calls ? r.durationSum / r.calls : 0,
    }));
};

// --- Overview stats for a source (optionally filtered by model/provider/operation) ---
export const getAiStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const source = await ownedSource(req);
    if (!source) return res.status(404).json({ error: 'AI source not found' });

    const ownerId = (req as any).ownerId;
    const { range, start, end } = req.query as any;

    const maxRetention = await getEffectiveRetention('ai', ownerId);
    const resolved = resolveTimeRange({ range, start, end }, maxRetention);
    const { startDate, endDate, bucketFormat } = resolved;
    const timeRange = buildTimeRangeMeta(resolved, maxRetention);

    const sourceId = source._id as mongoose.Types.ObjectId;
    const filtered = hasDimensionFilter(req.query);

    let overview: any;
    let graph: any[];
    let models: any[];
    let providers: any[];
    let operations: any[];

    if (filtered) {
      // --- CASE A: drill-down — raw AiGeneration with the dimension filter ---
      const match = { sourceId, timestamp: { $gte: startDate, $lte: endDate }, ...buildGenFilter(req.query) };

      const [ovRows, graphRows, modelRows, providerRows, operationRows] = await Promise.all([
        AiGeneration.aggregate([
          { $match: match },
          {
            $group: {
              _id: null,
              calls: { $sum: 1 },
              errors: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
              costUsd: { $sum: '$costUsd' },
              tokensIn: { $sum: '$tokensIn' },
              tokensOut: { $sum: '$tokensOut' },
              durationSum: { $sum: '$latencyMs' },
              maxLatency: { $max: '$latencyMs' },
            },
          },
        ]),
        AiGeneration.aggregate([
          { $match: match },
          {
            $group: {
              _id: { $dateToString: { format: bucketFormat, date: '$timestamp' } },
              calls: { $sum: 1 },
              errors: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
              costUsd: { $sum: '$costUsd' },
              tokensIn: { $sum: '$tokensIn' },
              tokensOut: { $sum: '$tokensOut' },
              durationSum: { $sum: '$latencyMs' },
            },
          },
          { $sort: { _id: 1 } },
          {
            $project: {
              time: '$_id', calls: 1, errors: 1, costUsd: 1, tokensIn: 1, tokensOut: 1,
              avgLatencyMs: { $cond: [{ $eq: ['$calls', 0] }, 0, { $divide: ['$durationSum', '$calls'] }] },
            },
          },
        ]),
        rawDimension(match, { $ifNull: ['$responseModel', '$requestModel'] }),
        rawDimension(match, '$provider'),
        rawDimension(match, '$operation'),
      ]);

      overview = ovRows[0] || { calls: 0, errors: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, durationSum: 0, maxLatency: 0 };
      graph = fillTimeGaps(graphRows, resolved, GRAPH_DEFAULTS, 'time');
      models = modelRows; providers = providerRows; operations = operationRows;
    } else {
      // --- CASE B: main dashboard — pre-aggregated AiMetric buckets ---
      const match = { sourceId, timestamp: { $gte: startDate, $lte: endDate } };
      const buckets = await AiMetric.find(match).sort({ timestamp: 1 }).lean();

      const ov = { calls: 0, errors: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, durationSum: 0, maxLatency: 0 };
      for (const b of buckets as any[]) {
        ov.calls += b.calls || 0;
        ov.errors += b.errorCount || 0;
        ov.costUsd += b.costUsd || 0;
        ov.tokensIn += b.tokensIn || 0;
        ov.tokensOut += b.tokensOut || 0;
        ov.durationSum += b.latencySum || 0;
        if ((b.latencyMax || 0) > ov.maxLatency) ov.maxLatency = b.latencyMax || 0;
      }
      overview = ov;

      const graphRows = await AiMetric.aggregate([
        { $match: match },
        {
          $group: {
            _id: { $dateToString: { format: bucketFormat, date: '$timestamp' } },
            calls: { $sum: '$calls' },
            errors: { $sum: '$errorCount' },
            costUsd: { $sum: '$costUsd' },
            tokensIn: { $sum: '$tokensIn' },
            tokensOut: { $sum: '$tokensOut' },
            durationSum: { $sum: '$latencySum' },
          },
        },
        { $sort: { _id: 1 } },
        {
          $project: {
            time: '$_id', calls: 1, errors: 1, costUsd: 1, tokensIn: 1, tokensOut: 1,
            avgLatencyMs: { $cond: [{ $eq: ['$calls', 0] }, 0, { $divide: ['$durationSum', '$calls'] }] },
          },
        },
      ]);
      graph = fillTimeGaps(graphRows, resolved, GRAPH_DEFAULTS, 'time');
      // Models are read from raw generations (not the metric buckets): bucket
      // dimension Map keys are dot-sanitized (e.g. `gemini-2.5-flash` →
      // `gemini-2_5-flash`) because Mongo Map keys can't contain dots, which
      // would make the displayed key fail to match the drill-down filter on
      // responseModel/requestModel. Provider/operation names never contain
      // dots, so their fast in-memory fold from buckets stays exact.
      models = await rawDimension(match, { $ifNull: ['$responseModel', '$requestModel'] });
      providers = foldDimension(buckets, 'providers');
      operations = foldDimension(buckets, 'operations');
    }

    // Latency percentiles from raw generations (bounded sample), filter-aware.
    const latencyMatch: any = { sourceId, timestamp: { $gte: startDate, $lte: endDate } };
    if (filtered) Object.assign(latencyMatch, buildGenFilter(req.query));
    const latencyDocs = await AiGeneration.find(latencyMatch, { latencyMs: 1, _id: 0 })
      .sort({ timestamp: -1 }).limit(20000).lean();
    const latencies = latencyDocs.map((d: any) => d.latencyMs || 0).sort((a, b) => a - b);

    // Quality scores (source-level; not dimension-filtered).
    const scoreAgg = await AiScore.aggregate([
      { $match: { sourceId, timestamp: { $gte: startDate, $lte: endDate } } },
      { $group: { _id: '$name', avg: { $avg: '$value' }, count: { $sum: 1 } } },
      { $sort: { count: -1 as const } },
      { $limit: 20 },
    ]);

    const totalTokens = (overview.tokensIn || 0) + (overview.tokensOut || 0);

    res.json({
      meta: source,
      timeRange,
      overview: {
        totalCalls: overview.calls || 0,
        totalErrors: overview.errors || 0,
        errorRate: overview.calls ? (overview.errors / overview.calls) * 100 : 0,
        avgLatency: overview.calls ? overview.durationSum / overview.calls : 0,
        maxLatency: overview.maxLatency || 0,
        totalCostUsd: overview.costUsd || 0,
        tokensIn: overview.tokensIn || 0,
        tokensOut: overview.tokensOut || 0,
        totalTokens,
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
      },
      graph,
      models,
      providers,
      operations,
      scores: scoreAgg.map((s: any) => ({ name: s._id, avg: s.avg, count: s.count })),
    });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};

// --- Recent traces (main view: workflow-level activity) ---
export const getAiTraces = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const source = await ownedSource(req);
    if (!source) return res.status(404).json({ error: 'AI source not found' });

    const ownerId = (req as any).ownerId;
    const maxRetention = await getEffectiveRetention('ai', ownerId);
    const resolved = resolveTimeRange(req.query as any, maxRetention);
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);

    const filter: any = { sourceId: source._id, timestamp: { $gte: resolved.startDate, $lte: resolved.endDate } };
    if (req.query.status === 'error' || req.query.status === 'ok') filter.status = req.query.status;
    if (req.query.sessionId) filter.sessionId = req.query.sessionId;
    if (req.query.userId) filter.userId = req.query.userId;

    const [traces, total] = await Promise.all([
      AiTrace.find(filter).sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      AiTrace.countDocuments(filter),
    ]);

    res.json({ traces, total, page, limit, hasMore: page * limit < total });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};

// --- Recent generations (filtered drill-down: per model/provider/operation) ---
export const getAiGenerations = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const source = await ownedSource(req);
    if (!source) return res.status(404).json({ error: 'AI source not found' });

    const ownerId = (req as any).ownerId;
    const maxRetention = await getEffectiveRetention('ai', ownerId);
    const resolved = resolveTimeRange(req.query as any, maxRetention);
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    const filter: any = {
      sourceId: source._id,
      timestamp: { $gte: resolved.startDate, $lte: resolved.endDate },
      ...buildGenFilter(req.query),
    };
    if (req.query.status === 'error' || req.query.status === 'ok') filter.status = req.query.status;

    const generations = await AiGeneration.find(filter, {
      traceId: 1, generationId: 1, provider: 1, operation: 1, requestModel: 1, responseModel: 1,
      tokensIn: 1, tokensOut: 1, totalTokens: 1, costUsd: 1, latencyMs: 1, status: 1,
      finishReason: 1, streaming: 1, timestamp: 1,
    }).sort({ timestamp: -1 }).limit(limit).lean();

    res.json({ generations });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};

// --- Top consumers (users / sessions) by cost ---
export const getAiConsumers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const source = await ownedSource(req);
    if (!source) return res.status(404).json({ error: 'AI source not found' });

    const ownerId = (req as any).ownerId;
    const maxRetention = await getEffectiveRetention('ai', ownerId);
    const resolved = resolveTimeRange(req.query as any, maxRetention);
    const baseMatch = { sourceId: source._id, timestamp: { $gte: resolved.startDate, $lte: resolved.endDate } };

    const pipeline = (field: 'userId' | 'sessionId') => [
      { $match: { ...baseMatch, [field]: { $nin: [null, ''] } } },
      {
        $group: {
          _id: `$${field}`,
          costUsd: { $sum: '$totalCostUsd' },
          calls: { $sum: '$generationCount' },
          tokens: { $sum: '$totalTokens' },
          traces: { $sum: 1 },
          errors: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
        },
      },
      { $sort: { costUsd: -1 as const } },
      { $limit: 20 },
    ];

    const [users, sessions] = await Promise.all([
      AiTrace.aggregate(pipeline('userId')),
      AiTrace.aggregate(pipeline('sessionId')),
    ]);

    const shape = (rows: any[]) => rows.map((r) => ({ key: r._id, ...r, _id: undefined }));
    res.json({ users: shape(users), sessions: shape(sessions) });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};

// --- Tool & MCP reliability (read-only debugging aggregate) ---
// Aggregates structural tool/mcp observations by name/server over the window so
// teams can monitor "which tool / MCP server fails or is slow". Purely
// observational — no execution, no mutation.
export const getAiReliability = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const source = await ownedSource(req);
    if (!source) return res.status(404).json({ error: 'AI source not found' });

    const ownerId = (req as any).ownerId;
    const maxRetention = await getEffectiveRetention('ai', ownerId);
    const resolved = resolveTimeRange(req.query as any, maxRetention);
    const baseMatch = { sourceId: source._id, timestamp: { $gte: resolved.startDate, $lte: resolved.endDate } };

    const pipeline = (type: 'tool' | 'mcp', keyExpr: any) => [
      { $match: { ...baseMatch, type } },
      {
        $group: {
          _id: keyExpr,
          calls: { $sum: 1 },
          errors: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
          durationSum: { $sum: '$latencyMs' },
          maxLatencyMs: { $max: '$latencyMs' },
        },
      },
      { $sort: { errors: -1 as const, calls: -1 as const } },
      { $limit: 50 },
    ];

    const [tools, mcp] = await Promise.all([
      AiGeneration.aggregate(pipeline('tool', { $ifNull: ['$tool.name', '$name'] })),
      AiGeneration.aggregate(pipeline('mcp', { $ifNull: ['$mcp.server', '$name'] })),
    ]);

    const shape = (rows: any[]) =>
      rows
        .filter((r) => r._id != null && r._id !== '')
        .map((r) => ({
          key: r._id,
          calls: r.calls,
          errors: r.errors,
          errorRate: r.calls ? r.errors / r.calls : 0,
          avgLatencyMs: r.calls ? r.durationSum / r.calls : 0,
          maxLatencyMs: r.maxLatencyMs || 0,
        }));

    res.json({ tools: shape(tools), mcp: shape(mcp) });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};

// Compute per-observation subtree rollups (cost + tokens) over the trace tree
// so structural spans (agent/tool/mcp) can display the rolled-up cost of all
// their descendant model calls. Cycle-guarded; mutates each doc in place.
const attachSubtreeRollups = (generations: any[]): void => {
  if (!generations?.length) return;

  const childrenOf = new Map<string, any[]>();
  for (const g of generations) {
    const p = g.parentGenerationId;
    if (!p) continue;
    const arr = childrenOf.get(p);
    if (arr) arr.push(g);
    else childrenOf.set(p, [g]);
  }

  const visiting = new Set<string>();
  const memo = new Map<string, { cost: number; tokens: number }>();

  const rollup = (g: any): { cost: number; tokens: number } => {
    const id = g.generationId;
    const cached = memo.get(id);
    if (cached) return cached;
    if (visiting.has(id)) return { cost: g.costUsd || 0, tokens: g.totalTokens || 0 }; // cycle guard
    visiting.add(id);

    let cost = g.costUsd || 0;
    let tokens = g.totalTokens || 0;
    for (const child of childrenOf.get(id) || []) {
      const r = rollup(child);
      cost += r.cost;
      tokens += r.tokens;
    }

    visiting.delete(id);
    const result = { cost, tokens };
    memo.set(id, result);
    g.subtreeCostUsd = cost;
    g.subtreeTokens = tokens;
    return result;
  };

  for (const g of generations) rollup(g);
};

// --- Trace detail with its generation waterfall ---
export const getAiTraceDetail = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const source = await ownedSource(req);
    if (!source) return res.status(404).json({ error: 'AI source not found' });

    const { traceId } = req.params;
    const trace = await AiTrace.findOne({ sourceId: source._id, traceId }).lean();
    if (!trace) return res.status(404).json({ error: 'Trace not found' });

    const [generations, scores] = await Promise.all([
      AiGeneration.find({ sourceId: source._id, traceId }).sort({ startTime: 1, timestamp: 1 }).lean(),
      AiScore.find({ sourceId: source._id, traceId }).sort({ timestamp: -1 }).lean(),
    ]);

    attachSubtreeRollups(generations);

    res.json({ trace, generations, scores });
  } catch (error) {
    next(error);
  }
};

// --- Submit a score (dashboard user feedback / external eval) ---
export const submitAiScore = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const source = await ownedSource(req);
    if (!source) return res.status(404).json({ error: 'AI source not found' });

    const parsed = AiScoreSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid score payload', details: parsed.error });
    }
    const { traceId, generationId, name, dataType, value, stringValue, comment } = parsed.data;

    const trace = await AiTrace.exists({ sourceId: source._id, traceId });
    if (!trace) return res.status(404).json({ error: 'Trace not found' });

    const ownerId = (req as any).ownerId;
    const now = new Date();
    const expiresAt = await computeExpiresAt(ownerId, now);

    const score = await AiScore.create({
      sourceId: source._id, traceId, generationId, name, dataType, value, stringValue, comment,
      scoredBy: 'user', authorId: ownerId, timestamp: now, expiresAt,
    });

    res.status(201).json({ message: 'Score recorded', score });
  } catch (error) {
    next(error);
  }
};
