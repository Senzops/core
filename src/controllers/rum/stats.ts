import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { RumService, RumMetric, RumTrace } from '../../models/Rum';
import { ApmTrace, ApmService } from '../../models/Apm';
import { resolveTimeRange, fillTimeGaps, getEffectiveRetention, buildTimeRangeMeta, TimeRangeError } from '../../utils/timeRange';

const RUM_TREND_DEFAULTS = {
  pageViews: 0, sessions: 0,
  lcpAvg: 0, inpAvg: 0, clsAvg: 0,
  rageClicks: 0, deadClicks: 0, errors: 0,
};

const safeAvg = (sum: number, count: number) => (count > 0 ? sum / count : 0);

export const getRumDashboard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { uid } = (req as any).user;
    const { range, start, end } = req.query;
    const pathFilter = req.query.path as string;

    const maxRetention = await getEffectiveRetention('rum', uid);
    const resolved = resolveTimeRange(
      { range: range as string, start: start as string, end: end as string },
      maxRetention
    );
    const { startDate, endDate, bucketFormat } = resolved;
    const meta = buildTimeRangeMeta(resolved, maxRetention);

    const service = await RumService.findOne({ _id: id, ownerId: uid }).lean();
    if (!service) return res.status(404).json({ error: "RUM Service not found" });

    const serviceIdObj = new mongoose.Types.ObjectId(id);

    let trendRaw = [];
    let rawStats: any = {};

    if (pathFilter) {
      // Exclude span_update traces — they are continuation flushes, not new page views
      const matchQuery = { serviceId: serviceIdObj, path: pathFilter, timestamp: { $gte: startDate, $lte: endDate }, traceType: { $in: ['initial_load', 'route_change'] } };

      trendRaw = await RumTrace.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: { $dateToString: { format: bucketFormat, date: "$timestamp" } },
            pageViews: { $sum: 1 },
            sessions: { $addToSet: "$sessionId" },
            lcpSum: { $sum: "$vitals.lcp" }, lcpCount: { $sum: { $cond: [{ $ifNull: ["$vitals.lcp", false] }, 1, 0] } },
            inpSum: { $sum: "$vitals.inp" }, inpCount: { $sum: { $cond: [{ $ifNull: ["$vitals.inp", false] }, 1, 0] } },
            clsSum: { $sum: "$vitals.cls" }, clsCount: { $sum: { $cond: [{ $ifNull: ["$vitals.cls", false] }, 1, 0] } },
            rageClicks: { $sum: "$frustration.rageClicks" },
            deadClicks: { $sum: "$frustration.deadClicks" },
            errors: { $sum: "$frustration.errorCount" }
          }
        },
        { $sort: { "_id": 1 } },
        {
          $project: {
            _id: 1, pageViews: 1, sessions: { $size: "$sessions" }, rageClicks: 1, deadClicks: 1, errors: 1,
            lcpAvg: { $cond: [{ $gt: ["$lcpCount", 0] }, { $divide: ["$lcpSum", "$lcpCount"] }, 0] },
            inpAvg: { $cond: [{ $gt: ["$inpCount", 0] }, { $divide: ["$inpSum", "$inpCount"] }, 0] },
            clsAvg: { $cond: [{ $gt: ["$clsCount", 0] }, { $divide: ["$clsSum", "$clsCount"] }, 0] }
          }
        }
      ]);

      const statsAgg = await RumTrace.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: null,
            pageViews: { $sum: 1 },
            sessions: { $addToSet: "$sessionId" },
            lcpSum: { $sum: "$vitals.lcp" }, lcpCount: { $sum: { $cond: [{ $ifNull: ["$vitals.lcp", false] }, 1, 0] } },
            inpSum: { $sum: "$vitals.inp" }, inpCount: { $sum: { $cond: [{ $ifNull: ["$vitals.inp", false] }, 1, 0] } },
            clsSum: { $sum: "$vitals.cls" }, clsCount: { $sum: { $cond: [{ $ifNull: ["$vitals.cls", false] }, 1, 0] } },
            rageClicks: { $sum: "$frustration.rageClicks" },
            deadClicks: { $sum: "$frustration.deadClicks" },
            errors: { $sum: "$frustration.errorCount" }
          }
        }
      ]);
      rawStats = statsAgg[0] || {};
      rawStats.sessions = rawStats.sessions ? rawStats.sessions.length : 0;

    } else {
      trendRaw = await RumMetric.aggregate([
        { $match: { serviceId: serviceIdObj, timestamp: { $gte: startDate, $lte: endDate } } },
        {
          $group: {
            _id: { $dateToString: { format: bucketFormat, date: "$timestamp" } },
            pageViews: { $sum: "$pageViews" }, sessions: { $sum: "$sessions" },
            lcpSum: { $sum: "$vitalsSum.lcp" }, lcpCount: { $sum: "$vitalsCount.lcp" },
            inpSum: { $sum: "$vitalsSum.inp" }, inpCount: { $sum: "$vitalsCount.inp" },
            clsSum: { $sum: "$vitalsSum.cls" }, clsCount: { $sum: "$vitalsCount.cls" },
            rageClicks: { $sum: "$frustrationTotal.rageClicks" }, deadClicks: { $sum: "$frustrationTotal.deadClicks" }, errors: { $sum: "$frustrationTotal.errors" }
          }
        },
        { $sort: { "_id": 1 } },
        {
          $project: {
            _id: 1, pageViews: 1, sessions: 1, rageClicks: 1, deadClicks: 1, errors: 1,
            lcpAvg: { $cond: [{ $gt: ["$lcpCount", 0] }, { $divide: ["$lcpSum", "$lcpCount"] }, 0] },
            inpAvg: { $cond: [{ $gt: ["$inpCount", 0] }, { $divide: ["$inpSum", "$inpCount"] }, 0] },
            clsAvg: { $cond: [{ $gt: ["$clsCount", 0] }, { $divide: ["$clsSum", "$clsCount"] }, 0] }
          }
        }
      ]);

      const statsAgg = await RumMetric.aggregate([
        { $match: { serviceId: serviceIdObj, timestamp: { $gte: startDate, $lte: endDate } } },
        {
          $group: {
            _id: null,
            pageViews: { $sum: "$pageViews" }, sessions: { $sum: "$sessions" },
            lcpSum: { $sum: "$vitalsSum.lcp" }, lcpCount: { $sum: "$vitalsCount.lcp" },
            inpSum: { $sum: "$vitalsSum.inp" }, inpCount: { $sum: "$vitalsCount.inp" },
            clsSum: { $sum: "$vitalsSum.cls" }, clsCount: { $sum: "$vitalsCount.cls" },
            rageClicks: { $sum: "$frustrationTotal.rageClicks" }, deadClicks: { $sum: "$frustrationTotal.deadClicks" }, errors: { $sum: "$frustrationTotal.errors" }
          }
        }
      ]);
      rawStats = statsAgg[0] || {};
    }

    const trend = fillTimeGaps(trendRaw, resolved, RUM_TREND_DEFAULTS);

    const stats = {
      pageViews: rawStats.pageViews || 0,
      sessions: rawStats.sessions || 0,
      lcpAvg: safeAvg(rawStats.lcpSum, rawStats.lcpCount),
      inpAvg: safeAvg(rawStats.inpSum, rawStats.inpCount),
      clsAvg: safeAvg(rawStats.clsSum, rawStats.clsCount),
      frustrations: {
        rageClicks: rawStats.rageClicks || 0,
        deadClicks: rawStats.deadClicks || 0,
        errors: rawStats.errors || 0
      }
    };

    const traceMatchQuery: any = { serviceId: serviceIdObj, timestamp: { $gte: startDate, $lte: endDate } };
    if (pathFilter) traceMatchQuery.path = pathFilter;

    const recentTraces = await RumTrace.find(traceMatchQuery)
      .select('-spans')
      .sort({ timestamp: -1 })
      .limit(2000)
      .lean();

    res.json({ service, timeRange: meta, stats, trend, recentTraces });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};

export const getRumTraceDetail = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, traceId } = req.params;
    const { uid } = (req as any).user; // We need UID to securely fetch user's APM services

    const trace = await RumTrace.findOne({ serviceId: id, traceId }).lean();
    if (!trace) return res.status(404).json({ error: "RUM Trace not found" });

    // Normalize absolute OTLP timestamps to relative milliseconds dynamically
    const normalizeSpans = (spans: any[], rootTime: Date) => {
      const rootMs = new Date(rootTime).getTime();
      return spans.map((s: any) => {
        if (s.startTime > 1000000000) {
           return { ...s, startTime: Math.max(0, s.startTime - rootMs) };
        }
        return s;
      });
    };
    trace.spans = normalizeSpans(trace.spans || [], trace.timestamp);

    // 1. Find Related APM Services (Owned by the same user)
    // This ensures we only link downstream backend traces that belong to this tenant
    const userServices = await ApmService.find({ ownerId: uid }).select('_id name').lean();
    const serviceIds = userServices.map(s => s._id);

    // Create a dictionary for instant O(1) mapping of Service ID -> Service Name
    const serviceMap = userServices.reduce((acc: any, curr) => {
      acc[curr._id.toString()] = curr.name;
      return acc;
    }, {});

    // 2. Find Downstream Children
    // Querying by the shared W3C traceId across all the user's APM services
    // CRITICAL FIX: explicitly returning `parentSpanId` so TraceWaterfall can connect the dots!
    const childTracesRaw = await ApmTrace.find({
      traceId: trace.traceId,
      serviceId: { $in: serviceIds }
    })
      .select('serviceId traceId parentSpanId status duration method route path timestamp hasErrors')
      .lean();

    // 3. Format Response for Frontend
    const childrenTraces = childTracesRaw.map(c => ({
      ...c,
      serviceName: serviceMap[c.serviceId.toString()] || 'Unknown Service'
    }));

    res.json({ trace, childrenTraces });
  } catch (error) {
    next(error);
  }
};