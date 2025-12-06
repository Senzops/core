import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Website } from '../models';
import { WebEvent } from '../models';

export const getWebStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { uid } = (req as any).user;
    const { range } = req.query; // '24h', '7d', '30d'

    // 1. Verify Ownership
    const site = await Website.findOne({ _id: id, ownerId: uid });
    if (!site) return res.status(404).json({ error: "Website not found" });

    // 2. Calculate Date Range
    const now = new Date();
    const startDate = new Date();
    if (range === '7d') startDate.setDate(now.getDate() - 7);
    else if (range === '30d') startDate.setDate(now.getDate() - 30);
    else startDate.setHours(now.getHours() - 24); // Default 24h

    // 3. Parallel Aggregations
    // We run multiple aggregation pipelines in parallel for performance
    const [
      overview,
      pages,
      referrers,
      countries,
      devices,
      browsers,
      graphData
    ] = await Promise.all([

      // A. Overview (Total Views, Unique Visitors, Bounce Rate, Avg Duration)
      WebEvent.aggregate([
        { $match: { webId: id, createdAt: { $gte: startDate } } },
        {
          $group: {
            _id: null,
            totalViews: { $sum: { $cond: [{ $eq: ["$type", "pageview"] }, 1, 0] } },
            // Collect Visitor IDs to count uniques
            visitors: { $addToSet: "$visitorId" },
            // For Bounce Rate: Group by Session
            sessions: { $addToSet: "$sessionId" },
            totalDuration: { $sum: "$duration" },
            pingCount: { $sum: { $cond: [{ $eq: ["$type", "ping"] }, 1, 0] } }
          }
        },
        {
          $project: {
            totalViews: 1,
            uniqueVisitors: { $size: "$visitors" },
            // Simple Bounce approximation: Sessions with low duration/interaction
            // (Real bounce rate requires grouped session analysis, simplified here for speed)
            avgDuration: { $cond: [{ $eq: ["$totalViews", 0] }, 0, { $divide: ["$totalDuration", "$totalViews"] }] }
          }
        }
      ]),

      // B. Top Pages
      WebEvent.aggregate([
        { $match: { webId: id, type: 'pageview', createdAt: { $gte: startDate } } },
        { $group: { _id: "$path", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),

      // C. Top Referrers
      WebEvent.aggregate([
        { $match: { webId: id, type: 'pageview', createdAt: { $gte: startDate } } },
        { $group: { _id: "$referrer", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),

      // D. Countries
      WebEvent.aggregate([
        { $match: { webId: id, type: 'pageview', createdAt: { $gte: startDate } } },
        { $group: { _id: "$country", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),

      // E. Devices (OS/Platform)
      WebEvent.aggregate([
        { $match: { webId: id, type: 'pageview', createdAt: { $gte: startDate } } },
        { $group: { _id: "$os", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 }
      ]),

      // F. Browsers
      WebEvent.aggregate([
        { $match: { webId: id, type: 'pageview', createdAt: { $gte: startDate } } },
        { $group: { _id: "$browser", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 }
      ]),

      // G. Time Series Graph (Views per Hour/Day)
      WebEvent.aggregate([
        { $match: { webId: id, type: 'pageview', createdAt: { $gte: startDate } } },
        {
          $group: {
            _id: {
              // Group by Hour if 24h, else by Day
              $dateToString: { format: range === '24h' ? "%Y-%m-%d %H:00" : "%Y-%m-%d", date: "$createdAt" }
            },
            views: { $sum: 1 },
            visitors: { $addToSet: "$visitorId" }
          }
        },
        { $sort: { "_id": 1 } },
        { $project: { time: "$_id", views: 1, visitors: { $size: "$visitors" } } }
      ])
    ]);

    res.json({
      meta: site,
      overview: overview[0] || { totalViews: 0, uniqueVisitors: 0, avgDuration: 0 },
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