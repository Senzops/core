import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Website, WebEvent, WebMetric } from '../../models/Web';
import { logger } from '../../utils/logger';
import { resolveTimeRange, fillTimeGaps, getEffectiveRetention, buildTimeRangeMeta, TimeRangeError } from '../../utils/timeRange';

const WEB_GRAPH_DEFAULTS = { views: 0, visitors: 0 };

export const getWebStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { uid } = (req as any).user;
    const { range, start, end } = req.query;

    const cleanId = id.trim();
    const webIdObj = new mongoose.Types.ObjectId(cleanId);

    const site = await Website.findOne({ _id: cleanId, ownerId: uid });
    if (!site) return res.status(404).json({ error: "Website not found" });

    const maxRetention = await getEffectiveRetention('web', uid);
    const resolved = resolveTimeRange(
      { range: range as string, start: start as string, end: end as string },
      maxRetention
    );
    const { startDate, endDate, bucketFormat } = resolved;
    const timeMeta = buildTimeRangeMeta(resolved, maxRetention);

    const now = new Date();
    const fiveMinutesAgo = new Date();
    fiveMinutesAgo.setMinutes(now.getMinutes() - 5);

    const matchQuery = { webId: webIdObj, timestamp: { $gte: startDate, $lte: endDate } };
    const rawMatchQuery = { webId: webIdObj, createdAt: { $gte: startDate, $lte: endDate } };

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
                format: bucketFormat,
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

    const graphData = fillTimeGaps(graphDataRaw, resolved, WEB_GRAPH_DEFAULTS, 'time');

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
      timeRange: timeMeta,
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
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};