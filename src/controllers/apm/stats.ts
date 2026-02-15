import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { ApmService, ApmTrace, ApmMetric } from '../../models/Apm';

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
        codes2xx: 0, codes3xx: 0, codes4xx: 0, codes5xx: 0, statusBreakdown: []
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

    // --- CASE A: ROUTE DRILL-DOWN (Use Raw Traces for accuracy on specific filters) ---
    if (route) {
      matchQuery.route = decodeURIComponent(route as string);

      const [
        overview,
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

        // C. Status Codes
        ApmTrace.aggregate([
          { $match: matchQuery },
          { $group: { _id: "$status", count: { $sum: 1 } } },
          { $sort: { count: -1 } }
        ]),

        // D. Time Series Graph
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
              minLatency: { $min: "$duration" },

              // Detailed Status Breakdown for Stacked Bar
              codes2xx: { $sum: { $cond: [{ $and: [{ $gte: ["$status", 200] }, { $lt: ["$status", 300] }] }, 1, 0] } },
              codes3xx: { $sum: { $cond: [{ $and: [{ $gte: ["$status", 300] }, { $lt: ["$status", 400] }] }, 1, 0] } },
              codes4xx: { $sum: { $cond: [{ $and: [{ $gte: ["$status", 400] }, { $lt: ["$status", 500] }] }, 1, 0] } },
              codes5xx: { $sum: { $cond: [{ $gte: ["$status", 500] }, 1, 0] } },

              // Collect explicit codes for "Detailed" view
              statusBreakdown: { $push: "$status" }
            }
          },
          { $sort: { "_id": 1 } },
          {
            $project: {
              time: "$_id",
              requests: 1,
              errors: 1,
              avgLatency: 1,
              maxLatency: 1,
              minLatency: 1,
              codes2xx: 1, codes3xx: 1, codes4xx: 1, codes5xx: 1,
              // Compress status breakdown array to counts: [200, 200, 404] -> [{code:200, count:2}, {code:404, count:1}]
              // Doing this in nodejs post-process for simpler mongo query, passing raw array might be heavy but safe for drill-down volume
              // Actually, for drill down, let's just push unique values in next stage if needed or keep it simple.
              // Reverting to aggregation stage for efficiency:
              // We'll skip complex array compression here and do simple counts in Stage 1
            }
          }
        ]),

        // E. Context
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

      // Post-Process for Graph Breakdown (since we didn't unwind in Aggregation for speed)
      // For Drill-down, we might miss the specific code breakdown per hour unless we add it. 
      // For now, let's rely on the global statusCodes aggregation for the detailed table, 
      // and the 2xx/3xx buckets for the graph.

      const graph = fillTimeGaps(graphDataRaw, range as string || '24h', startDate);
      const safeOverview = overview[0] || { totalRequests: 0, totalErrors: 0, errorRate: 0, avgLatency: 0, maxLatency: 0, minLatency: 0 };

      return res.json({
        meta: service,
        overview: safeOverview,
        routes: [], // No top routes needed for single route view
        statusCodes: statusCodes.map((s: any) => ({ status: s._id, count: s.count })),
        graph,
        geo: { countries: geo[0], cities: geo[1] },
        system: { devices: system[0], browsers: system[1], os: system[2] },
        clients
      });
    }

    // --- CASE B: MAIN DASHBOARD (Use Optimized ApmMetric) ---

    const [
      overviewResult,
      statusResult,
      geoResult,
      systemResult,
      routesResult,
      graphResult
    ] = await Promise.all([
      // A. Overview
      ApmMetric.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: null,
            requests: { $sum: "$requests" },
            errors: { $sum: "$errorCount" },
            durationSum: { $sum: "$durationSum" },
            maxLatency: { $max: "$durationMax" }
          }
        }
      ]),

      // B. Status Codes
      ApmMetric.aggregate([
        { $match: matchQuery },
        { $project: { statusCodes: { $objectToArray: "$statusCodes" } } },
        { $unwind: "$statusCodes" },
        { $group: { _id: "$statusCodes.k", count: { $sum: "$statusCodes.v" } } },
        { $sort: { count: -1 } }
      ]),

      // C. Geo 
      ApmMetric.aggregate([
        { $match: matchQuery },
        {
          $facet: {
            countries: [
              { $project: { d: { $objectToArray: "$countries" } } }, { $unwind: "$d" },
              { $group: { _id: "$d.k", count: { $sum: "$d.v" } } }, { $sort: { count: -1 } }, { $limit: 10 }
            ],
            cities: []
          }
        }
      ]),

      // D. System
      ApmMetric.aggregate([
        { $match: matchQuery },
        {
          $facet: {
            os: [{ $project: { d: { $objectToArray: "$os" } } }, { $unwind: "$d" }, { $group: { _id: "$d.k", count: { $sum: "$d.v" } } }, { $sort: { count: -1 } }, { $limit: 5 }],
            browsers: [{ $project: { d: { $objectToArray: "$browsers" } } }, { $unwind: "$d" }, { $group: { _id: "$d.k", count: { $sum: "$d.v" } } }, { $sort: { count: -1 } }, { $limit: 5 }],
            devices: [{ $project: { d: { $objectToArray: "$devices" } } }, { $unwind: "$d" }, { $group: { _id: "$d.k", count: { $sum: "$d.v" } } }, { $sort: { count: -1 } }, { $limit: 5 }],
          }
        }
      ]),

      // E. Top Routes
      ApmMetric.aggregate([
        { $match: matchQuery },
        { $project: { routes: { $objectToArray: "$routes" } } },
        { $unwind: "$routes" },
        { $group: { _id: "$routes.k", count: { $sum: "$routes.v" } } },
        { $sort: { count: -1 } },
        { $limit: 50 },
      ]),

      // F. Graph (Time Series)
      ApmMetric.aggregate([
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
            requests: { $sum: "$requests" },
            errors: { $sum: "$errorCount" },
            durationSum: { $sum: "$durationSum" },
            maxLatency: { $max: "$durationMax" },
            statusBreakdown: { $push: "$statusCodes" } // Array of maps
          }
        },
        { $sort: { "_id": 1 } },
        {
          $project: {
            time: "$_id",
            requests: 1,
            errors: 1,
            avgLatency: { $cond: [{ $eq: ["$requests", 0] }, 0, { $divide: ["$durationSum", "$requests"] }] },
            maxLatency: 1,
            statusBreakdown: 1
          }
        }
      ])
    ]);

    // Format Overview
    const ov = overviewResult[0] || { requests: 0, errors: 0, durationSum: 0, maxLatency: 0 };
    const safeOverview = {
      totalRequests: ov.requests,
      totalErrors: ov.errors,
      maxLatency: ov.maxLatency,
      minLatency: 0,
      avgLatency: ov.requests > 0 ? ov.durationSum / ov.requests : 0,
      errorRate: ov.requests > 0 ? (ov.errors / ov.requests) * 100 : 0
    };

    // Process Graph Data to flatten Maps into 2xx/3xx/etc counts
    const processedGraphData = graphResult.map((point: any) => {
      let codes2xx = 0, codes3xx = 0, codes4xx = 0, codes5xx = 0;
      let detailedBreakdown: any[] = [];
      const codeMap = new Map<number, number>();

      // statusBreakdown is array of Maps (one per minute in the bucket if grouped)
      // or just one Map if 1:1.
      point.statusBreakdown?.forEach((mapObj: any) => {
        // mapObj is { "200": 5, "404": 1 }
        for (const [codeStr, count] of Object.entries(mapObj)) {
          const code = parseInt(codeStr);
          const val = count as number;

          if (code >= 200 && code < 300) codes2xx += val;
          else if (code >= 300 && code < 400) codes3xx += val;
          else if (code >= 400 && code < 500) codes4xx += val;
          else if (code >= 500) codes5xx += val;

          codeMap.set(code, (codeMap.get(code) || 0) + val);
        }
      });

      // Reformat for frontend { code: 200, count: 5 }
      Array.from(codeMap.entries()).forEach(([code, count]) => {
        detailedBreakdown.push({ code, count });
      });

      return {
        ...point,
        codes2xx, codes3xx, codes4xx, codes5xx,
        statusBreakdown: detailedBreakdown
      };
    });

    const graph = fillTimeGaps(processedGraphData, range as string || '24h', startDate);

    // Format Routes
    const formattedRoutes = routesResult.map((r: any) => {
      const [method, ...rest] = r._id.split(' ');
      return {
        method: method || 'UNKNOWN',
        route: rest.join(' ') || r._id,
        count: r.count,
        errorRate: 0, // Metric shortcut doesn't track per-route errors yet
        avgLatency: 0 // Metric shortcut doesn't track per-route latency yet
      };
    });

    res.json({
      meta: service,
      overview: safeOverview,
      routes: formattedRoutes,
      statusCodes: statusResult.map((s: any) => ({ status: s._id, count: s.count })),
      graph,
      geo: { countries: geoResult[0]?.countries || [], cities: [] },
      system: { devices: systemResult[0]?.devices || [], browsers: systemResult[0]?.browsers || [], os: systemResult[0]?.os || [] },
      clients: [], // Raw query needed for clients, skipped for speed in main view
      referrers: [],
      channels: []
    });

  } catch (error) {
    next(error);
  }
};