import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { ApmService, ApmTrace } from '../../models/Apm';
import { logger } from '../../utils/logger';

// --- Helper: Zero-Fill Time Series ---
const fillTimeGaps = (data: any[], range: string, startDate: Date) => {
  const filled = [];
  const now = new Date();

  let current = new Date(startDate);
  if (range === '24h' || range === '1h') current.setMinutes(0, 0, 0);
  else current.setHours(0, 0, 0, 0);

  const end = new Date(now);
  // Buffer to ensure we cover current time
  if (range === '24h' || range === '1h') end.setHours(end.getHours() + 1);
  else end.setDate(end.getDate() + 1);

  const dataMap = new Map(data.map(item => [item.time, item]));

  while (current < end) {
    const key = (range === '24h' || range === '1h')
      ? current.toISOString().slice(0, 13) + ":00:00.000Z"
      : current.toISOString().slice(0, 10);

    if (dataMap.has(key)) {
      filled.push(dataMap.get(key));
    } else {
      filled.push({ time: key, requests: 0, errors: 0, avgLatency: 0 });
    }

    if (range === '24h' || range === '1h') current.setHours(current.getHours() + 1);
    else current.setDate(current.getDate() + 1);
  }
  return filled;
};

export const getApmStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { uid } = (req as any).user;
    const { range } = req.query;

    // 1. Verify Ownership
    const service = await ApmService.findOne({ _id: id, ownerId: uid });
    if (!service) return res.status(404).json({ error: "Service not found" });

    // 2. Calculate Date Range
    const now = new Date();
    const startDate = new Date();

    if (range === '7d') startDate.setDate(now.getDate() - 7);
    else if (range === '30d') startDate.setDate(now.getDate() - 30);
    else startDate.setHours(now.getHours() - 24); // Default 24h

    const serviceIdObj = new mongoose.Types.ObjectId(id as string);

    // 3. Parallel Aggregations
    const [
      overview,
      routes,
      statusCodes,
      graphDataRaw,
      clients
    ] = await Promise.all([

      // A. Overview (Total Req, Error Rate, Avg Latency)
      ApmTrace.aggregate([
        { $match: { serviceId: serviceIdObj, timestamp: { $gte: startDate } } },
        {
          $group: {
            _id: null,
            totalRequests: { $sum: 1 },
            totalErrors: { $sum: { $cond: [{ $gte: ["$status", 400] }, 1, 0] } },
            totalDuration: { $sum: "$duration" },
            // Max Latency (Approximate P99 alternative for standard Mongo)
            maxLatency: { $max: "$duration" }
          }
        },
        {
          $project: {
            totalRequests: 1,
            totalErrors: 1,
            errorRate: { $cond: [{ $eq: ["$totalRequests", 0] }, 0, { $multiply: [{ $divide: ["$totalErrors", "$totalRequests"] }, 100] }] },
            avgLatency: { $cond: [{ $eq: ["$totalRequests", 0] }, 0, { $divide: ["$totalDuration", "$totalRequests"] }] },
            maxLatency: 1
          }
        }
      ]),

      // B. Top Routes (Group by Method + Route)
      ApmTrace.aggregate([
        { $match: { serviceId: serviceIdObj, timestamp: { $gte: startDate } } },
        {
          $group: {
            _id: { route: "$route", method: "$method" },
            count: { $sum: 1 },
            avgLatency: { $avg: "$duration" },
            errorCount: { $sum: { $cond: [{ $gte: ["$status", 400] }, 1, 0] } }
          }
        },
        {
          $project: {
            route: "$_id.route",
            method: "$_id.method",
            count: 1,
            avgLatency: 1,
            errorRate: { $cond: [{ $eq: ["$count", 0] }, 0, { $multiply: [{ $divide: ["$errorCount", "$count"] }, 100] }] }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 20 }
      ]),

      // C. Status Codes Distribution
      ApmTrace.aggregate([
        { $match: { serviceId: serviceIdObj, timestamp: { $gte: startDate } } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),

      // D. Time Series Graph (Requests & Latency)
      ApmTrace.aggregate([
        { $match: { serviceId: serviceIdObj, timestamp: { $gte: startDate } } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: range === '30d' || range === '7d' ? "%Y-%m-%d" : "%Y-%m-%dT%H:00:00.000Z",
                date: "$timestamp"
              }
            },
            requests: { $sum: 1 },
            errors: { $sum: { $cond: [{ $gte: ["$status", 400] }, 1, 0] } },
            avgLatency: { $avg: "$duration" }
          }
        },
        { $sort: { "_id": 1 } },
        { $project: { time: "$_id", requests: 1, errors: 1, avgLatency: 1 } }
      ]),

      // E. Clients (User Agent Analysis)
      ApmTrace.aggregate([
        { $match: { serviceId: serviceIdObj, timestamp: { $gte: startDate } } },
        { $group: { _id: "$client", count: { $sum: 1 } } }, // SDK should send 'client' or we use 'browser' field
        { $sort: { count: -1 } },
        { $limit: 5 }
      ])
    ]);

    const graph = fillTimeGaps(graphDataRaw, range as string || '24h', startDate);
    const safeOverview = overview[0] || { totalRequests: 0, totalErrors: 0, errorRate: 0, avgLatency: 0, maxLatency: 0 };

    res.json({
      meta: service,
      overview: safeOverview,
      routes,
      statusCodes: statusCodes.map((s: any) => ({ status: s._id, count: s.count })),
      graph,
      clients // Context metrics
    });

  } catch (error) {
    next(error);
  }
};