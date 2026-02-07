import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { ApmService, ApmTrace } from '../../models/Apm';
import { logger } from '../../utils/logger';

// --- Helper: Zero-Fill Time Series ---
const fillTimeGaps = (data: any[], range: string, startDate: Date) => {
  const filled = [];
  const now = new Date();

  let current = new Date(startDate);
  // Align to boundaries
  if (range === '1h') current.setSeconds(0, 0);
  else if (range === '24h') current.setMinutes(0, 0, 0);
  else current.setHours(0, 0, 0, 0);

  const end = new Date(now);
  if (range === '1h') end.setMinutes(end.getMinutes() + 1);
  else if (range === '24h') end.setHours(end.getHours() + 1);
  else end.setDate(end.getDate() + 1);

  const dataMap = new Map(data.map(item => [item.time, item]));

  while (current < end) {
    let key;
    if (range === '1h') key = current.toISOString().slice(0, 16) + ":00.000Z";
    else if (range === '24h') key = current.toISOString().slice(0, 13) + ":00:00.000Z";
    else key = current.toISOString().slice(0, 10);

    if (dataMap.has(key)) {
      filled.push(dataMap.get(key));
    } else {
      filled.push({
        time: key,
        requests: 0,
        errors: 0,
        avgLatency: 0,
        maxLatency: 0,
        minLatency: 0,
        // Default Status Codes
        codes2xx: 0,
        codes3xx: 0,
        codes4xx: 0,
        codes5xx: 0,
        statusBreakdown: [] // Empty breakdown for zero-fill
      });
    }

    if (range === '1h') current.setMinutes(current.getMinutes() + 1);
    else if (range === '24h') current.setHours(current.getHours() + 1);
    else current.setDate(current.getDate() + 1);
  }
  return filled;
};

export const getApmStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { uid } = (req as any).user;
    const { range, route } = req.query;

    // 1. Verify Ownership
    const service = await ApmService.findOne({ _id: id, ownerId: uid });
    if (!service) return res.status(404).json({ error: "Service not found" });

    // 2. Calculate Date Range
    const now = new Date();
    const startDate = new Date();

    if (range === '7d') startDate.setDate(now.getDate() - 7);
    else if (range === '30d') startDate.setDate(now.getDate() - 30);
    else if (range === '1h') startDate.setHours(now.getHours() - 1);
    else startDate.setHours(now.getHours() - 24);

    const serviceIdObj = new mongoose.Types.ObjectId(id as string);
    const matchQuery: any = { serviceId: serviceIdObj, timestamp: { $gte: startDate } };
    if (route) {
      matchQuery.route = decodeURIComponent(route as string);
    }

    // 3. Parallel Aggregations
    const [
      overview,
      routes,
      referrers,
      channels,
      statusCodes,
      graphDataRaw,
      geo,
      system,
      clients
    ] = await Promise.all([

      // A. Overview
      ApmTrace.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: null,
            totalRequests: { $sum: 1 },
            totalErrors: { $sum: { $cond: [{ $gte: ["$status", 400] }, 1, 0] } },
            totalDuration: { $sum: "$duration" },
            maxLatency: { $max: "$duration" },
            minLatency: { $min: "$duration" }
          }
        },
        {
          $project: {
            totalRequests: 1,
            totalErrors: 1,
            errorRate: { $cond: [{ $eq: ["$totalRequests", 0] }, 0, { $multiply: [{ $divide: ["$totalErrors", "$totalRequests"] }, 100] }] },
            avgLatency: { $cond: [{ $eq: ["$totalRequests", 0] }, 0, { $divide: ["$totalDuration", "$totalRequests"] }] },
            maxLatency: 1,
            minLatency: 1
          }
        }
      ]),

      // B. Top Routes
      !route ? ApmTrace.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: { route: "$route", method: "$method" },
            count: { $sum: 1 },
            avgLatency: { $avg: "$duration" },
            p99Latency: { $max: "$duration" },
            errorCount: { $sum: { $cond: [{ $gte: ["$status", 400] }, 1, 0] } }
          }
        },
        {
          $project: {
            route: "$_id.route",
            method: "$_id.method",
            count: 1,
            avgLatency: 1,
            p99Latency: 1,
            errorRate: { $cond: [{ $eq: ["$count", 0] }, 0, { $multiply: [{ $divide: ["$errorCount", "$count"] }, 100] }] }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 100 }
      ]) : Promise.resolve([]),

      // C. Context Tables
      ApmTrace.aggregate([{ $match: matchQuery }, { $group: { _id: "$referrer", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }]),
      ApmTrace.aggregate([{ $match: matchQuery }, { $group: { _id: "$channel", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }]),
      ApmTrace.aggregate([{ $match: matchQuery }, { $group: { _id: "$status", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),

      // D. Time Series Graph (2-Stage Grouping for Explicit Status Codes)
      ApmTrace.aggregate([
        { $match: matchQuery },
        {
          // Stage 1: Group by Time AND Status
          $group: {
            _id: {
              time: {
                $dateToString: {
                  format: range === '1h' ? "%Y-%m-%dT%H:%M:00.000Z"
                    : (range === '30d' || range === '7d' ? "%Y-%m-%d" : "%Y-%m-%dT%H:00:00.000Z"),
                  date: "$timestamp"
                }
              },
              status: "$status"
            },
            count: { $sum: 1 },
            durationSum: { $sum: "$duration" },
            maxLat: { $max: "$duration" },
            minLat: { $min: "$duration" }
          }
        },
        {
          // Stage 2: Group by Time only
          $group: {
            _id: "$_id.time",
            requests: { $sum: "$count" },
            totalDuration: { $sum: "$durationSum" },
            maxLatency: { $max: "$maxLat" },
            minLatency: { $min: "$minLat" },
            // Collect the detailed breakdown
            statusBreakdown: { $push: { code: "$_id.status", count: "$count" } }
          }
        },
        {
          $project: {
            time: "$_id",
            requests: 1,
            avgLatency: { $cond: [{ $eq: ["$requests", 0] }, 0, { $divide: ["$totalDuration", "$requests"] }] },
            maxLatency: 1,
            minLatency: 1,
            statusBreakdown: 1
          }
        },
        { $sort: { time: 1 } }
      ]),

      // E. Geo/System/Clients
      Promise.all([
        ApmTrace.aggregate([{ $match: matchQuery }, { $group: { _id: "$country", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }]),
        ApmTrace.aggregate([{ $match: matchQuery }, { $group: { _id: "$city", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }])
      ]),
      Promise.all([
        ApmTrace.aggregate([{ $match: matchQuery }, { $group: { _id: "$device", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 5 }]),
        ApmTrace.aggregate([{ $match: matchQuery }, { $group: { _id: "$browser", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 5 }]),
        ApmTrace.aggregate([{ $match: matchQuery }, { $group: { _id: "$os", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 5 }]),
      ]),
      ApmTrace.aggregate([{ $match: matchQuery }, { $group: { _id: "$userAgent", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }])
    ]);

    // Process Graph Data to add legacy 2xx/3xx/etc fields from breakdown
    const processedGraphData = graphDataRaw.map((point: any) => {
      let codes2xx = 0, codes3xx = 0, codes4xx = 0, codes5xx = 0;
      let errors = 0;

      point.statusBreakdown?.forEach((item: any) => {
        const code = item.code;
        const count = item.count;

        if (code >= 200 && code < 300) codes2xx += count;
        else if (code >= 300 && code < 400) codes3xx += count;
        else if (code >= 400 && code < 500) { codes4xx += count; errors += count; }
        else if (code >= 500) { codes5xx += count; errors += count; }
      });

      return {
        ...point,
        codes2xx, codes3xx, codes4xx, codes5xx, errors
      };
    });

    const graph = fillTimeGaps(processedGraphData, range as string || '24h', startDate);
    const safeOverview = overview[0] || { totalRequests: 0, totalErrors: 0, errorRate: 0, avgLatency: 0, maxLatency: 0, minLatency: 0 };

    res.json({
      meta: service,
      overview: safeOverview,
      routes: routes || [],
      referrers,
      channels,
      statusCodes: statusCodes.map((s: any) => ({ status: s._id, count: s.count })),
      graph,
      geo: { countries: geo[0], cities: geo[1] },
      system: { devices: system[0], browsers: system[1], os: system[2] },
      clients
    });

  } catch (error) {
    next(error);
  }
};