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

    const cleanId = id.trim(); // Critical: Remove hidden newlines

    // FIX: Convert String ID to ObjectId for Aggregation
    // Aggregation pipelines do not auto-cast strings to ObjectIds unlike .find()
    const webIdObj = new mongoose.Types.ObjectId(cleanId);

    // 1. Verify Ownership (findOne auto-casts, so cleanId works here)
    const site = await Website.findOne({ _id: cleanId, ownerId: uid });
    if (!site) return res.status(404).json({ error: "Website not found" });

    // 2. Calculate Date Range
    const now = new Date();
    const startDate = new Date();

    if (range === '7d') startDate.setDate(now.getDate() - 7);
    else if (range === '30d') startDate.setDate(now.getDate() - 30);
    else startDate.setHours(now.getHours() - 24);

    // --- DEBUGGING BLOCK START ---
    // Log the parameters being used for the match
    logger.info(`[Stats Debug] ID: "${cleanId}"`);
    logger.info(`[Stats Debug] Range: ${range || '24h (default)'}`);
    logger.info(`[Stats Debug] StartDate: ${startDate.toISOString()}`);

    // Check if ANY data exists for this ID regardless of time
    const totalDocs = await WebEvent.countDocuments({ webId: cleanId });
    logger.info(`[Stats Debug] Total docs for WebID (All Time): ${totalDocs}`);

    // Check if data exists in the requested Time Window (The critical check)
    const recentDocs = await WebEvent.countDocuments({
      webId: cleanId,
      createdAt: { $gte: startDate }
    });
    logger.info(`[Stats Debug] Docs in Time Window: ${recentDocs}`);
    // --- DEBUGGING BLOCK END ---

    // 3. Parallel Aggregations
    // FIX: Used 'webIdObj' instead of 'cleanId' in all $match stages
    const [
      overview,
      pages,
      referrers,
      countries,
      devices,
      browsers,
      graphData
    ] = await Promise.all([

      // A. Overview
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

      // B. Top Pages
      WebEvent.aggregate([
        { $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } },
        { $group: { _id: "$path", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),

      // C. Top Referrers
      WebEvent.aggregate([
        { $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } },
        { $group: { _id: "$referrer", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),

      // D. Countries
      WebEvent.aggregate([
        { $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } },
        { $group: { _id: "$country", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),

      // E. Devices
      WebEvent.aggregate([
        { $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } },
        { $group: { _id: "$device", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 }
      ]),

      // F. Browsers
      WebEvent.aggregate([
        { $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } },
        { $group: { _id: "$browser", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 }
      ]),

      // G. Graph Data (Time Series)
      WebEvent.aggregate([
        { $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate } } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: range === '30d' || range === '7d' ? "%Y-%m-%d" : "%Y-%m-%d %H:00",
                date: "$createdAt"
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

    // Safety: If overview is empty, it means no events matched
    const safeOverview = overview[0] || { totalViews: 0, uniqueVisitors: 0, avgDuration: 0 };

    // Debug the aggregated overview result
    logger.info(`[Stats Debug] Aggregation Result (Overview): ${JSON.stringify(safeOverview)}`);

    res.json({
      meta: site,
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