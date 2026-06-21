import { Request, Response, NextFunction } from 'express';
import { AiSource, AiTrace, AiGeneration, AiMetric, AiScore } from '../../../models/Ai';
import { AiScoreSubmitSchema } from '../../../utils/validation';
import { computeExpiresAt } from '../../../services/retentionCache';

// ---------------------------------------------------------------------------
// AI Monitoring — read/query controllers
// ---------------------------------------------------------------------------

const RANGE_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const resolveRange = (range?: string): { since: Date; ms: number } => {
  const ms = RANGE_MS[range || '24h'] ?? RANGE_MS['24h'];
  return { since: new Date(Date.now() - ms), ms };
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

// Fold a Map-style dimension breakdown across metric buckets into a flat array.
const foldDimension = (buckets: any[], field: 'models' | 'providers' | 'operations') => {
  const agg = new Map<string, any>();
  for (const b of buckets) {
    const dim = b[field];
    if (!dim) continue;
    // Mongoose Map becomes a plain object on .lean()
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

// --- Overview stats for a source ---
export const getAiStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const source = await ownedSource(req);
    if (!source) return res.status(404).json({ error: 'AI source not found' });

    const { since } = resolveRange(req.query.range as string);

    const buckets = await AiMetric.find({ sourceId: source._id, timestamp: { $gte: since } })
      .sort({ timestamp: 1 })
      .lean();

    // Totals + time series.
    const totals = { calls: 0, errors: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, latencySum: 0 };
    const series = buckets.map((b: any) => {
      totals.calls += b.calls || 0;
      totals.errors += b.errorCount || 0;
      totals.tokensIn += b.tokensIn || 0;
      totals.tokensOut += b.tokensOut || 0;
      totals.costUsd += b.costUsd || 0;
      totals.latencySum += b.latencySum || 0;
      return {
        timestamp: b.timestamp,
        calls: b.calls || 0,
        errors: b.errorCount || 0,
        tokensIn: b.tokensIn || 0,
        tokensOut: b.tokensOut || 0,
        costUsd: b.costUsd || 0,
        avgLatencyMs: b.calls ? (b.latencySum || 0) / b.calls : 0,
      };
    });

    // Latency percentiles from raw generations (buckets can't aggregate these).
    const latencyDocs = await AiGeneration.find(
      { sourceId: source._id, timestamp: { $gte: since } },
      { latencyMs: 1, _id: 0 }
    )
      .sort({ timestamp: -1 })
      .limit(20000)
      .lean();
    const latencies = latencyDocs.map((d: any) => d.latencyMs || 0).sort((a, b) => a - b);

    // Quality scores: average + count per score name over the window.
    const scoreAgg = await AiScore.aggregate([
      { $match: { sourceId: source._id, timestamp: { $gte: since } } },
      {
        $group: {
          _id: '$name',
          avg: { $avg: '$value' },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 as const } },
      { $limit: 20 },
    ]);
    const scores = scoreAgg.map((s: any) => ({
      name: s._id,
      avg: s.avg,
      count: s.count,
    }));

    res.json({
      range: req.query.range || '24h',
      totals: {
        calls: totals.calls,
        errors: totals.errors,
        errorRate: totals.calls ? totals.errors / totals.calls : 0,
        tokensIn: totals.tokensIn,
        tokensOut: totals.tokensOut,
        totalTokens: totals.tokensIn + totals.tokensOut,
        costUsd: totals.costUsd,
        avgLatencyMs: totals.calls ? totals.latencySum / totals.calls : 0,
      },
      latency: {
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
        sampleSize: latencies.length,
      },
      series,
      models: foldDimension(buckets, 'models'),
      providers: foldDimension(buckets, 'providers'),
      operations: foldDimension(buckets, 'operations'),
      scores,
    });
  } catch (error) {
    next(error);
  }
};

// --- Paginated trace list ---
export const getAiTraces = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const source = await ownedSource(req);
    if (!source) return res.status(404).json({ error: 'AI source not found' });

    const { since } = resolveRange(req.query.range as string);
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);

    const filter: any = { sourceId: source._id, timestamp: { $gte: since } };
    if (req.query.status === 'error' || req.query.status === 'ok') filter.status = req.query.status;
    if (req.query.sessionId) filter.sessionId = req.query.sessionId;

    const [traces, total] = await Promise.all([
      AiTrace.find(filter)
        .sort({ timestamp: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AiTrace.countDocuments(filter),
    ]);

    res.json({ traces, total, page, limit, hasMore: page * limit < total });
  } catch (error) {
    next(error);
  }
};

// --- Top consumers (users / sessions) by cost ---
export const getAiConsumers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const source = await ownedSource(req);
    if (!source) return res.status(404).json({ error: 'AI source not found' });

    const { since } = resolveRange(req.query.range as string);
    const baseMatch = { sourceId: source._id, timestamp: { $gte: since } };

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
    next(error);
  }
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
      AiGeneration.find({ sourceId: source._id, traceId })
        .sort({ startTime: 1, timestamp: 1 })
        .lean(),
      AiScore.find({ sourceId: source._id, traceId }).sort({ timestamp: -1 }).lean(),
    ]);

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

    // The score must reference a real trace owned by this source.
    const trace = await AiTrace.exists({ sourceId: source._id, traceId });
    if (!trace) return res.status(404).json({ error: 'Trace not found' });

    const ownerId = (req as any).ownerId;
    const now = new Date();
    const expiresAt = await computeExpiresAt(ownerId, now);

    const score = await AiScore.create({
      sourceId: source._id,
      traceId,
      generationId,
      name,
      dataType,
      value,
      stringValue,
      comment,
      scoredBy: 'user',
      authorId: ownerId,
      timestamp: now,
      expiresAt,
    });

    res.status(201).json({ message: 'Score recorded', score });
  } catch (error) {
    next(error);
  }
};
