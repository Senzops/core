import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Website, WebEvent, WebMetric } from '../../models/Web';
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
      filled.push({ time: key, views: 0, visitors: 0 });
    }

    if (range === '1h') current.setMinutes(current.getMinutes() + 1);
    else if (range === '24h') current.setHours(current.getHours() + 1);
    else current.setDate(current.getDate() + 1);
  }
  return filled;
};

export const getWebStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { uid } = (req as any).user;
    const { range } = req.query;

    const cleanId = id.trim();
    const webIdObj = new mongoose.Types.ObjectId(cleanId);

    const site = await Website.findOne({ _id: cleanId, ownerId: uid });
    if (!site) return res.status(404).json({ error: "Website not found" });

    const now = new Date();
    const startDate = new Date();

    if (range === '7d') startDate.setDate(now.getDate() - 7);
    else if (range === '30d') startDate.setDate(now.getDate() - 30);
    else if (range === '1h') startDate.setHours(now.getHours() - 1);
    else startDate.setHours(now.getHours() - 24);

    const fiveMinutesAgo = new Date();
    fiveMinutesAgo.setMinutes(now.getMinutes() - 5);

    const matchQuery = { webId: webIdObj, timestamp: { $gte: startDate } };
    const rawMatchQuery = { webId: webIdObj, createdAt: { $gte: startDate } };

    const [
      // 1. Live & Uniques (Must use Raw for accuracy)
      liveCount,
      uniqueVisitors,

      // 2. Session Stats (Bounce Rate needs Raw session tracking)
      sessionStats,

      // 3. Dimensions (Optimized: Use WebMetric Aggregates)
      pagesResult,
      referrersResult,
      channelsResult,
      geoResult,
      systemResult,

      // 4. Raw Fallbacks (Data not in Metric or need distincts)
      pageTitles,
      graphDataRaw,

      // 5. Traffic Heatmap (Optimized: Use Metric)
      heatmapResult
    ] = await Promise.all([

      // A. Live
      WebEvent.distinct('visitorId', { webId: cleanId, createdAt: { $gte: fiveMinutesAgo } }),

      // B. Uniques
      WebEvent.distinct('visitorId', rawMatchQuery),

      // C. Session Stats
      WebEvent.aggregate([
        { $match: rawMatchQuery },
        {
          $group: {
            _id: "$sessionId",
            pageViews: { $sum: { $cond: [{ $eq: ["$type", "pageview"] }, 1, 0] } },
            duration: { $sum: "$duration" }
          }
        },
        {
          $group: {
            _id: null,
            totalSessions: { $sum: 1 },
            bounces: { $sum: { $cond: [{ $eq: ["$pageViews", 1] }, 1, 0] } },
            totalDuration: { $sum: "$duration" },
            totalPageViews: { $sum: "$pageViews" }
          }
        },
        {
          $project: {
            totalSessions: 1,
            bounceRate: { $cond: [{ $eq: ["$totalSessions", 0] }, 0, { $multiply: [{ $divide: ["$bounces", "$totalSessions"] }, 100] }] },
            avgDuration: { $cond: [{ $eq: ["$totalSessions", 0] }, 0, { $divide: ["$totalDuration", "$totalSessions"] }] },
            totalPageViews: 1
          }
        }
      ]),

      // D. Dimensions via WebMetric (Fast)
      WebMetric.aggregate([{ $match: matchQuery }, { $project: { d: { $objectToArray: "$paths" } } }, { $unwind: "$d" }, { $group: { _id: "$d.k", count: { $sum: "$d.v" } } }, { $sort: { count: -1 } }, { $limit: 10 }]),
      WebMetric.aggregate([{ $match: matchQuery }, { $project: { d: { $objectToArray: "$referrers" } } }, { $unwind: "$d" }, { $group: { _id: "$d.k", count: { $sum: "$d.v" } } }, { $sort: { count: -1 } }, { $limit: 10 }]),
      WebMetric.aggregate([{ $match: matchQuery }, { $project: { d: { $objectToArray: "$channels" } } }, { $unwind: "$d" }, { $group: { _id: "$d.k", count: { $sum: "$d.v" } } }, { $sort: { count: -1 } }, { $limit: 10 }]),

      WebMetric.aggregate([{ $match: matchQuery }, {
        $facet: {
          countries: [{ $project: { d: { $objectToArray: "$countries" } } }, { $unwind: "$d" }, { $group: { _id: "$d.k", count: { $sum: "$d.v" } } }, { $sort: { count: -1 } }, { $limit: 10 }],
          cities: [{ $project: { d: { $objectToArray: "$cities" } } }, { $unwind: "$d" }, { $group: { _id: "$d.k", count: { $sum: "$d.v" } } }, { $sort: { count: -1 } }, { $limit: 10 }]
        }
      }]),

      WebMetric.aggregate([{ $match: matchQuery }, {
        $facet: {
          os: [{ $project: { d: { $objectToArray: "$os" } } }, { $unwind: "$d" }, { $group: { _id: "$d.k", count: { $sum: "$d.v" } } }, { $sort: { count: -1 } }, { $limit: 5 }],
          browsers: [{ $project: { d: { $objectToArray: "$browsers" } } }, { $unwind: "$d" }, { $group: { _id: "$d.k", count: { $sum: "$d.v" } } }, { $sort: { count: -1 } }, { $limit: 5 }],
          devices: [{ $project: { d: { $objectToArray: "$devices" } } }, { $unwind: "$d" }, { $group: { _id: "$d.k", count: { $sum: "$d.v" } } }, { $sort: { count: -1 } }, { $limit: 5 }]
        }
      }]),

      // E. Page Titles (Raw - Not in Metric)
      WebEvent.aggregate([
        { $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate }, title: { $exists: true, $ne: null } } },
        { $group: { _id: "$title", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),

      // F. Graph (Raw required for Unique Visitor count per bucket)
      WebEvent.aggregate([
        { $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: range === '1h' ? "%Y-%m-%dT%H:%M:00.000Z"
                  : (range === '30d' || range === '7d' ? "%Y-%m-%d" : "%Y-%m-%dT%H:00:00.000Z"),
                date: "$createdAt"
              }
            },
            views: { $sum: 1 },
            visitors: { $addToSet: "$visitorId" }
          }
        },
        { $sort: { "_id": 1 } },
        { $project: { time: "$_id", views: 1, visitors: { $size: "$visitors" } } }
      ]),

      // G. Traffic Heatmap (Optimized via Metric)
      WebMetric.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: { day: { $dayOfWeek: "$timestamp" }, hour: { $hour: "$timestamp" } },
            count: { $sum: "$views" }
          }
        },
        { $sort: { "_id.day": 1, "_id.hour": 1 } }
      ]),
    ]);

    const graphData = fillTimeGaps(graphDataRaw, range as string || '24h', startDate);

    // Format Heatmap/Traffic
    const dayMap = ["", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    // Busy Days
    const busyDaysMap = new Map();
    heatmapResult.forEach((h: any) => {
      const d = h._id.day;
      busyDaysMap.set(d, (busyDaysMap.get(d) || 0) + h.count);
    });
    const busyDays = Array.from({ length: 7 }, (_, i) => ({
      name: dayMap[i + 1],
      count: busyDaysMap.get(i + 1) || 0
    }));

    // Busy Hours
    const busyHoursMap = new Map();
    heatmapResult.forEach((h: any) => {
      const hr = h._id.hour;
      busyHoursMap.set(hr, (busyHoursMap.get(hr) || 0) + h.count);
    });
    const busyHours = Array.from({ length: 24 }, (_, i) => ({
      name: `${i}:00`,
      count: busyHoursMap.get(i) || 0
    }));

    const stats = sessionStats[0] || { totalPageViews: 0, bounceRate: 0, avgDuration: 0 };

    res.json({
      meta: site,
      liveVisitors: liveCount.length,
      overview: {
        totalViews: stats.totalPageViews,
        uniqueVisitors: uniqueVisitors.length,
        avgDuration: stats.avgDuration,
        bounceRate: stats.bounceRate
      },
      pages: { path: pagesResult, title: pageTitles },
      sources: { referrers: referrersResult, channels: channelsResult },
      geo: { countries: geoResult[0]?.countries || [], cities: geoResult[0]?.cities || [] },
      system: { devices: systemResult[0]?.devices || [], browsers: systemResult[0]?.browsers || [], os: systemResult[0]?.os || [] },
      graph: graphData,
      traffic: { days: busyDays, hours: busyHours }
    });

  } catch (error) {
    next(error);
  }
};