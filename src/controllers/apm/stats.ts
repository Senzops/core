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
  if (range === '1h') current.setSeconds(0, 0); // Minute precision
  else if (range === '24h') current.setMinutes(0, 0, 0); // Hour precision
  else current.setHours(0, 0, 0, 0); // Day precision

  const end = new Date(now);
  if (range === '1h') end.setMinutes(end.getMinutes() + 1);
  else if (range === '24h') end.setHours(end.getHours() + 1);
  else end.setDate(end.getDate() + 1);

  const dataMap = new Map(data.map(item => [item.time, item]));

  while (current < end) {
    let key;
    if (range === '1h') key = current.toISOString().slice(0, 16) + ":00.000Z"; // YYYY-MM-DDTHH:mm
    else if (range === '24h') key = current.toISOString().slice(0, 13) + ":00:00.000Z"; // YYYY-MM-DDTHH
    else key = current.toISOString().slice(0, 10); // YYYY-MM-DD

    if (dataMap.has(key)) {
      filled.push(dataMap.get(key));
    } else {
      filled.push({
        time: key,
        requests: 0,
        errors: 0,
        avgLatency: 0,
        maxLatency: 0,
        minLatency: 0
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
    const { range, route } = req.query; // Added route filter

    // 1. Verify Ownership
    const service = await ApmService.findOne({ _id: id, ownerId: uid });
    if (!service) return res.status(404).json({ error: "Service not found" });

    // 2. Calculate Date Range
    const now = new Date();
    const startDate = new Date();

    if (range === '7d') startDate.setDate(now.getDate() - 7);
    else if (range === '30d') startDate.setDate(now.getDate() - 30);
    else if (range === '1h') startDate.setHours(now.getHours() - 1);
    else startDate.setHours(now.getHours() - 24); // Default 24h

    const serviceIdObj = new mongoose.Types.ObjectId(id as string);

    // Build Match Query
    const matchQuery: any = { serviceId: serviceIdObj, timestamp: { $gte: startDate } };
    if (route) {
      // Decode in case it's passed as URL param
      matchQuery.route = decodeURIComponent(route as string);
    }

    // 3. Parallel Aggregations
    const [
      overview,
      routes,
      statusCodes,
      graphDataRaw,
      geo,     // NEW
      system,  // NEW
      clients  // NEW
    ] = await Promise.all([

      // A. Overview (Golden Signals)
      ApmTrace.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: null,
            totalRequests: { $sum: 1 },
            totalErrors: { $sum: { $cond: [{ $gte: ["$status", 400] }, 1, 0] } },
            totalDuration: { $sum: "$duration" },
            maxLatency: { $max: "$duration" },
            // Approximation for "Low" latency (best case)
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

      // B. Top Routes (Endpoints)
      // Only fetch this if we are NOT in route drill-down mode (otherwise it's redundant)
      !route ? ApmTrace.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: { route: "$route", method: "$method" },
            count: { $sum: 1 },
            avgLatency: { $avg: "$duration" },
            p99Latency: { $max: "$duration" }, // Using Max as proxy for P99 in simple mongo
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
        { $limit: 50 } // Increased limit
      ]) : Promise.resolve([]),

      // C. Status Codes
      ApmTrace.aggregate([
        { $match: matchQuery },
        { $group: { _id: "$status", count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),

      // D. Time Series Graph (Requests & Latency Distribution)
      ApmTrace.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: {
              $dateToString: {
                format: range === '1h' ? "%Y-%m-%dT%H:%M:00.000Z"
                  : (range === '30d' || range === '7d' ? "%Y-%m-%d" : "%Y-%m-%dT%H:00:00.000Z"),
                date: "$timestamp"
              }
            },
            requests: { $sum: 1 },
            errors: { $sum: { $cond: [{ $gte: ["$status", 400] }, 1, 0] } },
            avgLatency: { $avg: "$duration" },
            maxLatency: { $max: "$duration" },
            minLatency: { $min: "$duration" }
          }
        },
        { $sort: { "_id": 1 } },
        { $project: { time: "$_id", requests: 1, errors: 1, avgLatency: 1, maxLatency: 1, minLatency: 1 } }
      ]),

      // E. Geo Distribution (Web Analytics parity)
      Promise.all([
        ApmTrace.aggregate([{ $match: matchQuery }, { $group: { _id: "$country", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }]),
        ApmTrace.aggregate([{ $match: matchQuery }, { $group: { _id: "$city", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }])
      ]),

      // F. System Distribution
      Promise.all([
        ApmTrace.aggregate([{ $match: matchQuery }, { $group: { _id: "$device", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 5 }]),
        ApmTrace.aggregate([{ $match: matchQuery }, { $group: { _id: "$browser", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 5 }]),
        ApmTrace.aggregate([{ $match: matchQuery }, { $group: { _id: "$os", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 5 }]),
      ]),

      // G. Top Clients (Sources/UserAgents)
      ApmTrace.aggregate([
        { $match: matchQuery },
        { $group: { _id: "$userAgent", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ])

    ]);

    const graph = fillTimeGaps(graphDataRaw, range as string || '24h', startDate);
    const safeOverview = overview[0] || { totalRequests: 0, totalErrors: 0, errorRate: 0, avgLatency: 0, maxLatency: 0, minLatency: 0 };

    res.json({
      meta: service,
      overview: safeOverview,
      routes: routes || [],
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