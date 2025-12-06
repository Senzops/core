import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Website } from '../models';
import { WebEvent } from '../models';
import { logger } from '../utils/logger';

export const getWebStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { uid } = (req as any).user;
    const { range } = req.query;

    const cleanId = id.trim();
    const webIdObj = new mongoose.Types.ObjectId(cleanId);

    // 1. Verify Ownership
    const site = await Website.findOne({ _id: cleanId, ownerId: uid });
    if (!site) return res.status(404).json({ error: "Website not found" });

    // 2. Calculate Date Ranges
    const now = new Date();
    const startDate = new Date();

    if (range === '7d') startDate.setDate(now.getDate() - 7);
    else if (range === '30d') startDate.setDate(now.getDate() - 30);
    else startDate.setHours(now.getHours() - 24);

    // Calculate "Live" Window (Last 5 Minutes)
    const fiveMinutesAgo = new Date();
    fiveMinutesAgo.setMinutes(now.getMinutes() - 5);

    // 3. Parallel Aggregations
    const [
      liveCount, // NEW: Real-time active users
      overview,
      pages,
      referrers,
      countries,
      devices,
      browsers,
      graphData
    ] = await Promise.all([

      // A. Live Visitors (Unique IPs/IDs in last 5 mins)
      WebEvent.distinct('visitorId', {
        webId: cleanId,
        createdAt: { $gte: fiveMinutesAgo }
      }),

      // B. Overview
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
        {
          $project: {
            totalViews: 1,
            uniqueVisitors: { $size: "$visitors" },
            avgDuration: { $cond: [{ $eq: ["$totalViews", 0] }, 0, { $divide: ["$totalDuration", "$totalViews"] }] }
          }
        }
      ]),

      // C. Top Pages
      WebEvent.aggregate([
        { $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } },
        { $group: { _id: "$path", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),

      // D. Top Referrers
      WebEvent.aggregate([
        { $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } },
        { $group: { _id: "$referrer", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),

      // E. Countries
      WebEvent.aggregate([
        { $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } },
        { $group: { _id: "$country", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),

      // F. Devices
      WebEvent.aggregate([
        { $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } },
        { $group: { _id: "$device", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 }
      ]),

      // G. Browsers
      WebEvent.aggregate([
        { $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } },
        { $group: { _id: "$browser", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 }
      ]),

      // H. Graph Data
      WebEvent.aggregate([
        { $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%dT%H:%M:%S.%LZ", // Return ISO format for Frontend Parsing
                date: {
                  $toDate: {
                    $subtract: [
                      { $toLong: "$createdAt" },
                      { $mod: [{ $toLong: "$createdAt" }, range === '24h' ? 3600000 : 86400000] } // Group by Hour or Day
                    ]
                  }
                }
              }
            },
            views: { $sum: 1 },
            visitors: { $addToSet: "$visitorId" }
          }
        },
        { $sort: { "_id": 1 } },
        { $project: { time: "$_id", views: 1, visitors: { $size: "$visitors" } } }
      ])
    ]);

    const safeOverview = overview[0] || { totalViews: 0, uniqueVisitors: 0, avgDuration: 0 };

    res.json({
      meta: site,
      liveVisitors: liveCount.length, // Send the count
      overview: safeOverview,
      pages,
      referrers,
      countries,
      devices,
      browsers,
      graph: graphData
    });

  } catch (error) {
    next(error);
  }
};