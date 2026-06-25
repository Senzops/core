import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { RumService, RumTrace } from '../../models/Rum';
import { resolveTimeRange, getEffectiveRetention, buildTimeRangeMeta, TimeRangeError } from '../../utils/timeRange';

const PAGE_SIZE = 12;

// --- Session list — RUM traces grouped into visitor sessions ---
export const getRumSessions = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const ownerId = (req as any).ownerId;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid service id' });

    const service = await RumService.findOne({ _id: id, ownerId }).select('_id').lean();
    if (!service) return res.status(404).json({ error: 'RUM Service not found' });

    const maxRetention = await getEffectiveRetention('rum', ownerId);
    let tr;
    try {
      tr = resolveTimeRange(
        { range: req.query.range as string, start: req.query.start as string, end: req.query.end as string },
        maxRetention
      );
    } catch (e) {
      if (e instanceof TimeRangeError) return res.status(400).json({ error: e.message });
      throw e;
    }
    const meta = buildTimeRangeMeta(tr, maxRetention);

    const page = Math.max(0, parseInt(String(req.query.page), 10) || 0);
    const serviceIdObj = new mongoose.Types.ObjectId(id);

    // Sort by time first so $first / $last capture entry & exit paths correctly.
    // Sessionize once, then page + count in a single pass via $facet so the
    // client can render an exact "Page X of Y" without a second round-trip.
    // Include ALL trace types (span_updates carry the largest `duration`, i.e.
    // the real time on page). The session's real end is max(timestamp+duration),
    // since every trace of one page-load shares the same start `timestamp`.
    // pageViews counts only actual page views; sessions with none are dropped.
    const agg = await RumTrace.aggregate([
      {
        $match: {
          serviceId: serviceIdObj,
          timestamp: { $gte: tr.startDate, $lte: tr.endDate },
        },
      },
      { $sort: { timestamp: 1 } },
      {
        $group: {
          _id: '$sessionId',
          start: { $min: '$timestamp' },
          end: { $max: { $add: ['$timestamp', { $ifNull: ['$duration', 0] }] } },
          pageViews: { $sum: { $cond: [{ $in: ['$traceType', ['initial_load', 'route_change']] }, 1, 0] } },
          errors: { $sum: '$frustration.errorCount' },
          rageClicks: { $sum: '$frustration.rageClicks' },
          deadClicks: { $sum: '$frustration.deadClicks' },
          entryPath: { $first: '$path' },
          exitPath: { $last: '$path' },
          device: { $last: '$device' },
          browser: { $last: '$browser' },
          os: { $last: '$os' },
          country: { $last: '$country' },
          lcpAvg: { $avg: '$vitals.lcp' },
        },
      },
      { $match: { pageViews: { $gt: 0 } } },
      { $addFields: { durationMs: { $subtract: ['$end', '$start'] } } },
      {
        $facet: {
          sessions: [{ $sort: { end: -1 } }, { $skip: page * PAGE_SIZE }, { $limit: PAGE_SIZE }],
          total: [{ $count: 'count' }],
        },
      },
    ], { allowDiskUse: true });

    const sessions = agg[0]?.sessions || [];
    const total = agg[0]?.total?.[0]?.count || 0;

    res.json({
      timeRange: meta,
      page,
      pageSize: PAGE_SIZE,
      total,
      totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      sessions,
    });
  } catch (error) {
    next(error);
  }
};

// --- Session detail — ordered traces within a single session ---
export const getRumSessionDetail = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, sessionId } = req.params;
    const ownerId = (req as any).ownerId;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid service id' });

    const service = await RumService.findOne({ _id: id, ownerId }).select('_id').lean();
    if (!service) return res.status(404).json({ error: 'RUM Service not found' });

    const allTraces = await RumTrace.find({ serviceId: id, sessionId })
      .select('-spans')
      .sort({ timestamp: 1 })
      .limit(1000)
      .lean();

    if (allTraces.length === 0) return res.status(404).json({ error: 'Session not found' });

    // Timing spans ALL traces (span_updates carry the real time-on-page via
    // `duration`); the timeline shows only actual page views, not continuation
    // flushes. Kept identical to the sessions list so the two never drift.
    const start = new Date(allTraces[0].timestamp).getTime();
    const end = allTraces.reduce(
      (mx, t) => Math.max(mx, new Date(t.timestamp).getTime() + (t.duration || 0)),
      start
    );
    const pageViewTraces = allTraces.filter((t) => t.traceType === 'initial_load' || t.traceType === 'route_change');
    const last = allTraces[allTraces.length - 1];

    const summary = {
      sessionId,
      start: allTraces[0].timestamp,
      end: new Date(end),
      durationMs: end - start,
      pageViews: pageViewTraces.length,
      device: last.device,
      browser: last.browser,
      os: last.os,
      country: last.country,
      errors: allTraces.reduce((s, t) => s + (t.frustration?.errorCount || 0), 0),
    };

    res.json({ summary, traces: pageViewTraces });
  } catch (error) {
    next(error);
  }
};
