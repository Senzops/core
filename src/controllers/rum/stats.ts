import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { RumService, RumMetric, RumTrace } from '../../models/Rum';
import { ErrorEvent } from '../../models/Error';

const getStartDate = (range: string) => {
  const date = new Date();
  switch (range) {
    case '1h': date.setHours(date.getHours() - 1); break;
    case '7d': date.setDate(date.getDate() - 7); break;
    case '30d': date.setDate(date.getDate() - 30); break;
    case '24h':
    default: date.setHours(date.getHours() - 24); break;
  }
  return date;
};

const getTrendFormat = (range: string) => {
  if (range === '1h') return "%Y-%m-%dT%H:%M:00.000Z";
  if (range === '7d' || range === '30d') return "%Y-%m-%d";
  return "%Y-%m-%dT%H:00:00.000Z";
};

const fillTimeGaps = (data: any[], range: string, startDate: Date) => {
  if (!data || data.length === 0) return [];
  const filled = [];
  const now = new Date();

  let current = new Date(startDate);
  if (range === '1h') current.setSeconds(0, 0);
  else if (range === '24h') current.setMinutes(0, 0, 0);
  else current.setHours(0, 0, 0, 0);

  const dataMap = new Map(data.map(item => [item._id, item]));

  while (current <= now) {
    let key = '';
    if (range === '1h') key = current.toISOString().slice(0, 16) + ":00.000Z";
    else if (range === '24h') key = current.toISOString().slice(0, 13) + ":00:00.000Z";
    else key = current.toISOString().slice(0, 10);

    const existing = dataMap.get(key);
    filled.push(existing || {
      time: key, pageViews: 0, sessions: 0,
      lcpAvg: 0, inpAvg: 0, clsAvg: 0,
      rageClicks: 0, deadClicks: 0, errors: 0
    });

    if (range === '1h') current.setMinutes(current.getMinutes() + 1);
    else if (range === '24h') current.setHours(current.getHours() + 1);
    else current.setDate(current.getDate() + 1);
  }
  return filled;
};

// Calculate safe averages to prevent divide-by-zero or NaN
const safeAvg = (sum: number, count: number) => (count > 0 ? sum / count : 0);

export const getRumDashboard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { uid } = (req as any).user;
    const range = req.query.range as string || '24h';
    const startDate = getStartDate(range);

    const service = await RumService.findOne({ _id: id, ownerId: uid }).lean();
    if (!service) return res.status(404).json({ error: "RUM Service not found" });

    const serviceIdObj = new mongoose.Types.ObjectId(id);

    // 1. Time-Series Trend Aggregation
    const trendRaw = await RumMetric.aggregate([
      { $match: { serviceId: serviceIdObj, timestamp: { $gte: startDate } } },
      {
        $group: {
          _id: { $dateToString: { format: getTrendFormat(range), date: "$timestamp" } },
          pageViews: { $sum: "$pageViews" },
          sessions: { $sum: "$sessions" },
          lcpSum: { $sum: "$vitalsSum.lcp" }, lcpCount: { $sum: "$vitalsCount.lcp" },
          inpSum: { $sum: "$vitalsSum.inp" }, inpCount: { $sum: "$vitalsCount.inp" },
          clsSum: { $sum: "$vitalsSum.cls" }, clsCount: { $sum: "$vitalsCount.cls" },
          rageClicks: { $sum: "$frustrationTotal.rageClicks" },
          deadClicks: { $sum: "$frustrationTotal.deadClicks" },
          errors: { $sum: "$frustrationTotal.errors" }
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

    const trend = trendRaw.length > 0 ? fillTimeGaps(trendRaw, range, startDate) : [];

    // 2. Global Summary Stats
    const statsAgg = await RumMetric.aggregate([
      { $match: { serviceId: serviceIdObj, timestamp: { $gte: startDate } } },
      {
        $group: {
          _id: null,
          pageViews: { $sum: "$pageViews" },
          sessions: { $sum: "$sessions" },
          lcpSum: { $sum: "$vitalsSum.lcp" }, lcpCount: { $sum: "$vitalsCount.lcp" },
          inpSum: { $sum: "$vitalsSum.inp" }, inpCount: { $sum: "$vitalsCount.inp" },
          clsSum: { $sum: "$vitalsSum.cls" }, clsCount: { $sum: "$vitalsCount.cls" },
          rageClicks: { $sum: "$frustrationTotal.rageClicks" },
          deadClicks: { $sum: "$frustrationTotal.deadClicks" },
          errors: { $sum: "$frustrationTotal.errors" }
        }
      }
    ]);

    const rawStats = statsAgg[0] || {};
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

    // 3. Recent Raw Traces (Page Loads) for the Table
    const recentTraces = await RumTrace.find({ serviceId: serviceIdObj, timestamp: { $gte: startDate } })
      .select('-spans') // Omit heavy spans for overview table
      .sort({ timestamp: -1 })
      .limit(50)
      .lean();

    res.json({ service, stats, trend, recentTraces });
  } catch (error) {
    next(error);
  }
};

export const getRumTraceDetail = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, traceId } = req.params;

    // Fetch the frontend browser trace
    const trace = await RumTrace.findOne({ serviceId: id, traceId }).lean();
    if (!trace) return res.status(404).json({ error: "RUM Trace not found" });

    // Fetch related JS exceptions
    const errors = await ErrorEvent.find({ serviceId: id, traceId }).lean();

    // The frontend will separately call your existing APM trace endpoint 
    // to search for backend traces using this exact same `traceId`!
    res.json({ trace, errors });
  } catch (error) {
    next(error);
  }
};