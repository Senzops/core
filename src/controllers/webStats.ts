import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Website } from '../models';
import { WebEvent } from '../models';
import { logger } from '../utils/logger';

// --- Helper: Zero-Fill Time Series ---
const fillTimeGaps = (data: any[], range: string, startDate: Date) => {
  const filled = [];
  const now = new Date();

  // Align start to the beginning of the interval
  let current = new Date(startDate);
  if (range === '24h') current.setMinutes(0, 0, 0);
  else current.setHours(0, 0, 0, 0);

  // Align end to the NEXT hour/day to ensure we cover the current partial bucket
  const end = new Date(now);
  if (range === '24h') end.setHours(end.getHours() + 1);
  else end.setDate(end.getDate() + 1);

  const dataMap = new Map(data.map(item => [item.time, item]));

  while (current < end) {
    const key = range === '24h'
      ? current.toISOString().slice(0, 13) + ":00:00.000Z"
      : current.toISOString().slice(0, 10);

    if (dataMap.has(key)) {
      filled.push(dataMap.get(key));
    } else {
      filled.push({ time: key, views: 0, visitors: 0 });
    }

    if (range === '24h') current.setHours(current.getHours() + 1);
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
    else startDate.setHours(now.getHours() - 24);

    const fiveMinutesAgo = new Date();
    fiveMinutesAgo.setMinutes(now.getMinutes() - 5);

    const [
      liveCount,
      overview,
      pages,
      referrers,
      countries,
      cities,
      devices,
      browsers,
      os,
      graphDataRaw,
      busyDaysRaw, 
      busyHoursRaw 
    ] = await Promise.all([

      WebEvent.distinct('visitorId', { webId: cleanId, createdAt: { $gte: fiveMinutesAgo } }),

      WebEvent.aggregate([
        { $match: { webId: webIdObj, createdAt: { $gte: startDate } } },
        {
          $group: {
            _id: null,
            totalViews: { $sum: { $cond: [{ $eq: ["$type", "pageview"] }, 1, 0] } },
            visitors: { $addToSet: "$visitorId" },
            sessions: { $addToSet: "$sessionId" },
            totalDuration: { $sum: "$duration" },
          }
        },
        { $project: { totalViews: 1, uniqueVisitors: { $size: "$visitors" }, avgDuration: { $cond: [{ $eq: ["$totalViews", 0] }, 0, { $divide: ["$totalDuration", "$totalViews"] }] } } }
      ]),

      WebEvent.aggregate([{ $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } }, { $group: { _id: "$path", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }]),
      WebEvent.aggregate([{ $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } }, { $group: { _id: "$referrer", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }]),
      WebEvent.aggregate([{ $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } }, { $group: { _id: "$country", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }]),
      WebEvent.aggregate([{ $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } }, { $group: { _id: "$city", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }]),
      WebEvent.aggregate([{ $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } }, { $group: { _id: "$device", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 5 }]),
      WebEvent.aggregate([{ $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } }, { $group: { _id: "$browser", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 5 }]),
      WebEvent.aggregate([{ $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } }, { $group: { _id: "$os", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 5 }]),

      // Graph
      WebEvent.aggregate([
        { $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: range === '30d' || range === '7d' ? "%Y-%m-%d" : "%Y-%m-%dT%H:00:00.000Z",
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

      // Busy Days (1=Sun, 7=Sat)
      WebEvent.aggregate([
        { $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } },
        { $group: { _id: { $dayOfWeek: "$createdAt" }, count: { $sum: 1 } } },
        { $sort: { "_id": 1 } }
      ]),

      // Busy Hours (0-23)
      WebEvent.aggregate([
        { $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } },
        { $group: { _id: { $hour: "$createdAt" }, count: { $sum: 1 } } },
        { $sort: { "_id": 1 } }
      ]),
    ]);

    const graphData = fillTimeGaps(graphDataRaw, range as string || '24h', startDate);

    // Format Days (1-7 -> Sun-Sat)
    const dayMap = ["", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    // Fill missing days with 0
    const busyDays = Array.from({ length: 7 }, (_, i) => {
      const found = busyDaysRaw.find((d: any) => d._id === (i + 1));
      return { name: dayMap[i + 1], count: found ? found.count : 0 };
    });

    // Format Hours (0-23)
    const busyHours = Array.from({ length: 24 }, (_, i) => {
      const found = busyHoursRaw.find((h: any) => h._id === i);
      return { name: `${i}:00`, count: found ? found.count : 0 };
    });

    const safeOverview = overview[0] || { totalViews: 0, uniqueVisitors: 0, avgDuration: 0 };

    res.json({
      meta: site,
      liveVisitors: liveCount.length,
      overview: safeOverview,
      pages,
      referrers,
      geo: { countries, cities },
      system: { devices, browsers, os },
      graph: graphData,
      traffic: { days: busyDays, hours: busyHours } // New structure
    });

  } catch (error) {
    next(error);
  }
};