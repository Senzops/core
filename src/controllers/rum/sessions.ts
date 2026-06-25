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
    const agg = await RumTrace.aggregate([
      {
        $match: {
          serviceId: serviceIdObj,
          timestamp: { $gte: tr.startDate, $lte: tr.endDate },
          traceType: { $in: ['initial_load', 'route_change'] },
        },
      },
      { $sort: { timestamp: 1 } },
      {
        $group: {
          _id: '$sessionId',
          start: { $min: '$timestamp' },
          end: { $max: '$timestamp' },
          pageViews: { $sum: 1 },
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

    const traces = await RumTrace.find({ serviceId: id, sessionId })
      .select('-spans')
      .sort({ timestamp: 1 })
      .limit(500)
      .lean();

    if (traces.length === 0) return res.status(404).json({ error: 'Session not found' });

    const first = traces[0];
    const last = traces[traces.length - 1];
    const summary = {
      sessionId,
      start: first.timestamp,
      end: last.timestamp,
      durationMs: new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime(),
      pageViews: traces.length,
      device: last.device,
      browser: last.browser,
      os: last.os,
      country: last.country,
      errors: traces.reduce((s, t) => s + (t.frustration?.errorCount || 0), 0),
    };

    res.json({ summary, traces });
  } catch (error) {
    next(error);
  }
};
