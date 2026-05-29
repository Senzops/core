import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { ApmService, ApmTrace, ApmMetric } from '../../models/Apm';
import { resolveTimeRange, fillTimeGaps, getEffectiveRetention, buildTimeRangeMeta, TimeRangeError } from '../../utils/timeRange';

const GRAPH_DEFAULTS = {
  requests: 0, errors: 0, avgLatency: 0, maxLatency: 0, minLatency: 0,
  codes2xx: 0, codes3xx: 0, codes4xx: 0, codes5xx: 0, statusBreakdown: [] as any[],
};

export const getApmStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const ownerId = (req as any).ownerId;
    const { range, route, start, end } = req.query;

    // 1. Verify Ownership
    const service = await ApmService.findOne({ _id: id, ownerId });
    if (!service) return res.status(404).json({ error: "Service not found" });

    // 2. Resolve Time Range
    const maxRetention = await getEffectiveRetention('apm', ownerId);
    const resolved = resolveTimeRange(
      { range: range as string, start: start as string, end: end as string },
      maxRetention
    );
    const { startDate, endDate, bucketFormat } = resolved;
    const meta = buildTimeRangeMeta(resolved, maxRetention);

    const serviceIdObj = new mongoose.Types.ObjectId(id as string);
    const matchQuery: any = { serviceId: serviceIdObj, timestamp: { $gte: startDate, $lte: endDate } };

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
                  format: bucketFormat,
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

      const graph = fillTimeGaps(graphDataRaw, resolved, GRAPH_DEFAULTS, 'time');
      const safeOverview = overview[0] || { totalRequests: 0, totalErrors: 0, errorRate: 0, avgLatency: 0, maxLatency: 0, minLatency: 0 };

      return res.json({
        meta: service,
        timeRange: meta,
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
        { $group: { 
            _id: "$routes.k", 
            count: { 
              $sum: { $cond: [{ $isNumber: "$routes.v" }, "$routes.v", "$routes.v.count"] } 
            },
            errors: {
              $sum: { $cond: [{ $isNumber: "$routes.v" }, 0, "$routes.v.errors"] }
            },
            durationSum: {
              $sum: { $cond: [{ $isNumber: "$routes.v" }, 0, "$routes.v.duration"] }
            }
        } },
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
                format: bucketFormat,
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

      point.statusBreakdown?.forEach((mapObj: any) => {
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

    const graph = fillTimeGaps(processedGraphData, resolved, GRAPH_DEFAULTS, 'time');

    // Format Routes
    const formattedRoutes = routesResult.map((r: any) => {
      const [method, ...rest] = r._id.split(' ');
      return {
        method: method || 'UNKNOWN',
        route: rest.join(' ') || r._id,
        count: r.count,
        errorRate: r.count > 0 ? (r.errors / r.count) * 100 : 0,
        avgLatency: r.count > 0 ? r.durationSum / r.count : 0
      };
    });

    res.json({
      meta: service,
      timeRange: meta,
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
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};