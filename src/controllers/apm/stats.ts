import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { ApmService, ApmTrace } from "../../models/Apm";

// --- Helper: Zero-Fill Time Series ---
const fillTimeGaps = (data: any[], range: string, startDate: Date) => {
  const filled = [];
  const now = new Date();

  let current = new Date(startDate);
  // Align to boundaries
  if (range === "1h") current.setSeconds(0, 0);
  else if (range === "24h") current.setMinutes(0, 0, 0);
  else current.setHours(0, 0, 0, 0);

  const end = new Date(now);
  if (range === "1h") end.setMinutes(end.getMinutes() + 1);
  else if (range === "24h") end.setHours(end.getHours() + 1);
  else end.setDate(end.getDate() + 1);

  const dataMap = new Map(data.map((item) => [item.time, item]));

  while (current < end) {
    let key;
    if (range === "1h") key = current.toISOString().slice(0, 16) + ":00.000Z";
    else if (range === "24h")
      key = current.toISOString().slice(0, 13) + ":00:00.000Z";
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
        codes2xx: 0,
        codes3xx: 0,
        codes4xx: 0,
        codes5xx: 0,
        statusBreakdown: [],
      });
    }

    if (range === "1h") current.setMinutes(current.getMinutes() + 1);
    else if (range === "24h") current.setHours(current.getHours() + 1);
    else current.setDate(current.getDate() + 1);
  }
  return filled;
};

export const getApmStats = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const { uid } = (req as any).user;
    const { range, route } = req.query;

    // 1. Verify Ownership (Cached/Fast lookup)
    const service = await ApmService.findOne({ _id: id, ownerId: uid }).select(
      "name framework lastSeen",
    );
    if (!service) return res.status(404).json({ error: "Service not found" });

    // 2. Date Calculation
    const now = new Date();
    const startDate = new Date();
    if (range === "7d") startDate.setDate(now.getDate() - 7);
    else if (range === "30d") startDate.setDate(now.getDate() - 30);
    else if (range === "1h") startDate.setHours(now.getHours() - 1);
    else startDate.setHours(now.getHours() - 24);

    const serviceIdObj = new mongoose.Types.ObjectId(id as string);
    const fiveMinutesAgo = new Date();
    fiveMinutesAgo.setMinutes(now.getMinutes() - 5);

    // Build Match Query
    // MongoDB will use the Compound Index { serviceId: 1, route: 1, timestamp: -1 } or { serviceId: 1, timestamp: -1 }
    const matchQuery: any = {
      serviceId: serviceIdObj,
      timestamp: { $gte: startDate },
    };
    if (route) {
      matchQuery.route = decodeURIComponent(route as string);
    }

    // 3. Execution Phase
    // We split into 3 queries: Live, Facet (Metadata), Graph (TimeSeries)

    const [liveCount, facetResults, graphDataRaw] = await Promise.all([
      // A. Live Visitors (Fast Count)
      // Note: distinct() can be slow on millions. If it is, replace with an approximate count or separate Redis counter.
      ApmTrace.distinct("ip", {
        serviceId: serviceIdObj,
        timestamp: { $gte: fiveMinutesAgo },
      }),

      // B. Massive Aggregation Pipeline ($facet)
      // This runs ONE pass over the filtered documents and buckets them.
      ApmTrace.aggregate([
        { $match: matchQuery },
        // Optimize: Project only what's needed for aggregation to reduce memory
        {
          $project: {
            duration: 1,
            status: 1,
            method: 1,
            route: 1,
            referrer: 1,
            channel: 1,
            country: 1,
            city: 1,
            device: 1,
            browser: 1,
            os: 1,
            userAgent: 1,
          },
        },
        {
          $facet: {
            // 1. Overview
            overview: [
              {
                $group: {
                  _id: null,
                  totalRequests: { $sum: 1 },
                  totalErrors: {
                    $sum: { $cond: [{ $gte: ["$status", 400] }, 1, 0] },
                  },
                  totalDuration: { $sum: "$duration" },
                  maxLatency: { $max: "$duration" },
                },
              },
              {
                $project: {
                  totalRequests: 1,
                  totalErrors: 1,
                  errorRate: {
                    $cond: [
                      { $eq: ["$totalRequests", 0] },
                      0,
                      {
                        $multiply: [
                          { $divide: ["$totalErrors", "$totalRequests"] },
                          100,
                        ],
                      },
                    ],
                  },
                  avgLatency: {
                    $cond: [
                      { $eq: ["$totalRequests", 0] },
                      0,
                      { $divide: ["$totalDuration", "$totalRequests"] },
                    ],
                  },
                  maxLatency: 1,
                },
              },
            ],
            // 2. Routes
            routes: [
              {
                $group: {
                  _id: { route: "$route", method: "$method" },
                  count: { $sum: 1 },
                  avgLatency: { $avg: "$duration" },
                  errorCount: {
                    $sum: { $cond: [{ $gte: ["$status", 400] }, 1, 0] },
                  },
                },
              },
              { $sort: { count: -1 } },
              { $limit: 100 }, // Get top 100
              {
                $project: {
                  route: "$_id.route",
                  method: "$_id.method",
                  count: 1,
                  avgLatency: 1,
                  errorRate: {
                    $cond: [
                      { $eq: ["$count", 0] },
                      0,
                      {
                        $multiply: [
                          { $divide: ["$errorCount", "$count"] },
                          100,
                        ],
                      },
                    ],
                  },
                },
              },
            ],
            // 3. Status Codes
            statusCodes: [
              { $group: { _id: "$status", count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ],
            // 4. Metadata Lists
            referrers: [
              { $group: { _id: "$referrer", count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 10 },
            ],
            channels: [
              { $group: { _id: "$channel", count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 10 },
            ],
            countries: [
              { $group: { _id: "$country", count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 10 },
            ],
            cities: [
              { $group: { _id: "$city", count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 10 },
            ],
            devices: [
              { $group: { _id: "$device", count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 5 },
            ],
            browsers: [
              { $group: { _id: "$browser", count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 5 },
            ],
            os: [
              { $group: { _id: "$os", count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 5 },
            ],
            clients: [
              { $group: { _id: "$userAgent", count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 10 },
            ],
          },
        },
      ]),

      // C. Graph (Separate to avoid BSON limits on large arrays)
      ApmTrace.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: {
              time: {
                $dateToString: {
                  format:
                    range === "1h"
                      ? "%Y-%m-%dT%H:%M:00.000Z"
                      : range === "30d" || range === "7d"
                        ? "%Y-%m-%d"
                        : "%Y-%m-%dT%H:00:00.000Z",
                  date: "$timestamp",
                },
              },
              status: "$status",
            },
            count: { $sum: 1 },
            durationSum: { $sum: "$duration" },
            maxLat: { $max: "$duration" },
            minLat: { $min: "$duration" },
          },
        },
        {
          $group: {
            _id: "$_id.time",
            requests: { $sum: "$count" },
            totalDuration: { $sum: "$durationSum" },
            maxLatency: { $max: "$maxLat" },
            minLatency: { $min: "$minLat" },
            statusBreakdown: {
              $push: { code: "$_id.status", count: "$count" },
            },
          },
        },
        {
          $project: {
            time: "$_id",
            requests: 1,
            avgLatency: {
              $cond: [
                { $eq: ["$requests", 0] },
                0,
                { $divide: ["$totalDuration", "$requests"] },
              ],
            },
            maxLatency: 1,
            minLatency: 1,
            statusBreakdown: 1,
          },
        },
        { $sort: { time: 1 } },
      ]),
    ]);

    // Processing Results
    const facet = facetResults[0];
    const safeOverview = facet.overview[0] || {
      totalRequests: 0,
      totalErrors: 0,
      errorRate: 0,
      avgLatency: 0,
      maxLatency: 0,
    };

    const processedGraphData = graphDataRaw.map((point: any) => {
      let codes2xx = 0,
        codes3xx = 0,
        codes4xx = 0,
        codes5xx = 0;
      let errors = 0;

      point.statusBreakdown?.forEach((item: any) => {
        const code = item.code;
        const count = item.count;
        if (code >= 200 && code < 300) codes2xx += count;
        else if (code >= 300 && code < 400) codes3xx += count;
        else if (code >= 400 && code < 500) {
          codes4xx += count;
          errors += count;
        } else if (code >= 500) {
          codes5xx += count;
          errors += count;
        }
      });

      return { ...point, codes2xx, codes3xx, codes4xx, codes5xx, errors };
    });

    const graph = fillTimeGaps(
      processedGraphData,
      (range as string) || "24h",
      startDate,
    );

    res.json({
      meta: service,
      liveVisitors: liveCount.length,
      overview: safeOverview,
      routes: facet.routes,
      referrers: facet.referrers,
      channels: facet.channels,
      statusCodes: facet.statusCodes.map((s: any) => ({
        status: s._id,
        count: s.count,
      })),
      geo: { countries: facet.countries, cities: facet.cities },
      system: {
        devices: facet.devices,
        browsers: facet.browsers,
        os: facet.os,
      },
      clients: facet.clients,
      graph,
    });
  } catch (error) {
    next(error);
  }
};
