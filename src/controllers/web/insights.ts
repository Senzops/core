import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Website, WebEvent } from '../../models/Web';
import { resolveTimeRange, getEffectiveRetention, buildTimeRangeMeta, TimeRangeError } from '../../utils/timeRange';
import { cacheGet, cacheSet } from '../../lib/cache';
import { logger } from '../../utils/logger';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MAX_OFFSET = 11;       // retention columns (offset 0..11)
const MAX_COHORTS = 12;      // retention rows
const MAX_PATHS = 15;        // top journeys
const PATH_MAX_STEPS = 6;    // steps captured per session path

const resolveSite = async (req: Request) => {
  const ownerId = (req as any).ownerId;
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id.trim())) return { error: 'Invalid website id' as const };
  const site = await Website.findOne({ _id: id.trim(), ownerId }).select('_id ownerId').lean();
  if (!site) return { error: 'Website not found' as const };
  return { ownerId, webId: id.trim() };
};

// Deterministic cache fragment for a time window (minute-bucketed for sliding ranges).
const rangeCacheKey = (q: Record<string, any>) =>
  q.range ? `r:${q.range}:${Math.floor(Date.now() / 60000)}` : `c:${q.start}:${q.end}`;

// ===========================================================================
// Cohort retention — % of each cohort that returns in subsequent periods.
// ===========================================================================
export const getWebRetention = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resolved = await resolveSite(req);
    if ('error' in resolved) {
      return res.status(resolved.error === 'Website not found' ? 404 : 400).json({ error: resolved.error });
    }

    const { range, start, end } = req.query as Record<string, string>;
    const maxRetention = await getEffectiveRetention('web', resolved.ownerId);

    let tr;
    try {
      tr = resolveTimeRange({ range, start, end }, maxRetention);
    } catch (e) {
      if (e instanceof TimeRangeError) return res.status(400).json({ error: e.message });
      throw e;
    }
    const meta = buildTimeRangeMeta(tr, maxRetention);
    const { startDate, endDate } = tr;

    // Daily cohorts for short windows, weekly for longer ones.
    const span = endDate.getTime() - startDate.getTime();
    const unit: 'day' | 'week' = span <= 14 * DAY_MS ? 'day' : 'week';
    const unitMs = unit === 'day' ? DAY_MS : WEEK_MS;

    const webIdObj = new mongoose.Types.ObjectId(resolved.webId);
    const cacheKey = `webret:${resolved.webId}:${unit}:${rangeCacheKey(req.query as any)}`;

    const cached = await cacheGet(cacheKey);
    if (cached) {
      try { return res.json({ timeRange: meta, cached: true, ...JSON.parse(cached) }); } catch { /* recompute */ }
    }

    const agg = await WebEvent.aggregate([
      { $match: { webId: webIdObj, createdAt: { $gte: startDate, $lte: endDate } } },
      {
        $group: {
          _id: '$visitorId',
          firstSeen: { $min: '$createdAt' },
          activePeriods: { $addToSet: { $dateTrunc: { date: '$createdAt', unit } } },
        },
      },
      { $addFields: { cohort: { $dateTrunc: { date: '$firstSeen', unit } } } },
      {
        $facet: {
          sizes: [{ $group: { _id: '$cohort', size: { $sum: 1 } } }],
          cells: [
            { $unwind: '$activePeriods' },
            { $addFields: { offset: { $dateDiff: { startDate: '$cohort', endDate: '$activePeriods', unit } } } },
            { $match: { offset: { $gte: 0 } } },
            { $group: { _id: { cohort: '$cohort', offset: '$offset' }, visitors: { $sum: 1 } } },
          ],
        },
      },
    ], { allowDiskUse: true });

    const sizes: Array<{ _id: Date; size: number }> = agg[0]?.sizes || [];
    const cells: Array<{ _id: { cohort: Date; offset: number }; visitors: number }> = agg[0]?.cells || [];

    const sizeMap = new Map<string, number>();
    for (const s of sizes) sizeMap.set(new Date(s._id).toISOString(), s.size);

    const cellMap = new Map<string, number>();
    for (const c of cells) cellMap.set(`${new Date(c._id.cohort).toISOString()}|${c._id.offset}`, c.visitors);

    // Most recent cohorts first, capped.
    const cohortKeys = Array.from(sizeMap.keys()).sort().slice(-MAX_COHORTS).reverse();

    const cohorts = cohortKeys.map((ci) => {
      const size = sizeMap.get(ci) || 0;
      const validOffset = Math.min(MAX_OFFSET, Math.floor((endDate.getTime() - new Date(ci).getTime()) / unitMs));
      const cellsRow = [];
      for (let o = 0; o <= validOffset; o++) {
        const v = cellMap.get(`${ci}|${o}`) || 0;
        cellsRow.push({ offset: o, visitors: v, percent: size > 0 ? (v / size) * 100 : 0 });
      }
      return { cohort: ci, size, cells: cellsRow };
    });

    const payload = { unit, maxOffset: MAX_OFFSET, cohorts };
    cacheSet(cacheKey, JSON.stringify(payload), 120).catch((e) => logger.warn(`[Retention] cache set failed: ${e?.message}`));

    res.json({ timeRange: meta, cached: false, ...payload });
  } catch (error) {
    next(error);
  }
};

// ===========================================================================
// User journeys — most common ordered page sequences per session.
// ===========================================================================
export const getWebPaths = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resolved = await resolveSite(req);
    if ('error' in resolved) {
      return res.status(resolved.error === 'Website not found' ? 404 : 400).json({ error: resolved.error });
    }

    const { range, start, end } = req.query as Record<string, string>;
    const maxRetention = await getEffectiveRetention('web', resolved.ownerId);

    let tr;
    try {
      tr = resolveTimeRange({ range, start, end }, maxRetention);
    } catch (e) {
      if (e instanceof TimeRangeError) return res.status(400).json({ error: e.message });
      throw e;
    }
    const meta = buildTimeRangeMeta(tr, maxRetention);
    const { startDate, endDate } = tr;

    const webIdObj = new mongoose.Types.ObjectId(resolved.webId);
    const cacheKey = `webpath:${resolved.webId}:${rangeCacheKey(req.query as any)}`;

    const cached = await cacheGet(cacheKey);
    if (cached) {
      try { return res.json({ timeRange: meta, cached: true, ...JSON.parse(cached) }); } catch { /* recompute */ }
    }

    const agg = await WebEvent.aggregate([
      { $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate, $lte: endDate } } },
      { $sort: { sessionId: 1, createdAt: 1 } },
      { $group: { _id: '$sessionId', path: { $push: '$path' } } },
      // Collapse consecutive duplicates (refreshes), then cap the sequence length.
      {
        $addFields: {
          path: {
            $slice: [
              {
                $reduce: {
                  input: '$path',
                  initialValue: [],
                  in: {
                    $cond: [
                      { $eq: [{ $last: '$$value' }, '$$this'] },
                      '$$value',
                      { $concatArrays: ['$$value', ['$$this']] },
                    ],
                  },
                },
              },
              PATH_MAX_STEPS,
            ],
          },
        },
      },
      { $match: { 'path.0': { $exists: true } } },
      { $group: { _id: '$path', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: MAX_PATHS },
    ], { allowDiskUse: true });

    const total = agg.reduce((s, p) => s + (p.count || 0), 0);
    const paths = agg.map((p) => ({ path: p._id, count: p.count, percent: total > 0 ? (p.count / total) * 100 : 0 }));

    const payload = { paths, totalSessions: total };
    cacheSet(cacheKey, JSON.stringify(payload), 120).catch((e) => logger.warn(`[Paths] cache set failed: ${e?.message}`));

    res.json({ timeRange: meta, cached: false, ...payload });
  } catch (error) {
    next(error);
  }
};
