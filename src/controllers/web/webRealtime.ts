import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Website, WebEvent } from '../../models/Web';

/**
 * Realtime snapshot for a website — the live "right now" view.
 *
 * Intentionally lightweight and uncached: it reads only the last 30 minutes of
 * raw events (a small, index-bounded slice) so it can be polled at a high
 * cadence by the dashboard without touching the heavier stats path.
 */
export const getWebRealtime = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const ownerId = (req as any).ownerId;

    const cleanId = id.trim();
    if (!mongoose.Types.ObjectId.isValid(cleanId)) {
      return res.status(400).json({ error: 'Invalid website id' });
    }
    const webIdObj = new mongoose.Types.ObjectId(cleanId);

    const site = await Website.findOne({ _id: cleanId, ownerId }).select('_id').lean();
    if (!site) return res.status(404).json({ error: 'Website not found' });

    const now = Date.now();
    const win5 = new Date(now - 5 * 60 * 1000);
    const win30 = new Date(now - 30 * 60 * 1000);

    const [activeVisitors, pulseRaw, topPages, topReferrers, recentEvents] = await Promise.all([
      // Active visitors = distinct visitors in the last 5 minutes.
      WebEvent.distinct('visitorId', { webId: webIdObj, createdAt: { $gte: win5 } }),

      // Per-minute pageview pulse over the last 30 minutes.
      WebEvent.aggregate([
        { $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: win30 } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%dT%H:%M:00Z', date: '$createdAt' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),

      // Pages being viewed right now (last 5 minutes).
      WebEvent.aggregate([
        { $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: win5 } } },
        { $group: { _id: '$path', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]),

      // Where current visitors came from (last 5 minutes).
      WebEvent.aggregate([
        { $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: win5 } } },
        { $group: { _id: '$referrer', count: { $sum: 1 } } },
        { $match: { _id: { $ne: null } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]),

      // Live custom-event feed (last 30 minutes, newest first).
      WebEvent.find({ webId: webIdObj, type: 'event', createdAt: { $gte: win30 } })
        .sort({ createdAt: -1 })
        .limit(20)
        .select('eventName path country createdAt')
        .lean(),
    ]);

    // Fill the pulse to exactly 30 one-minute buckets so the sparkline is stable.
    const counts = new Map<string, number>();
    for (const b of pulseRaw) counts.set(b._id, b.count);
    const pulse: Array<{ time: string; count: number }> = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now - i * 60 * 1000);
      d.setSeconds(0, 0);
      const key = `${d.toISOString().slice(0, 16)}:00Z`;
      pulse.push({ time: d.toISOString(), count: counts.get(key) || 0 });
    }

    res.json({
      activeVisitors: activeVisitors.length,
      pulse,
      topPages,
      topReferrers,
      recentEvents,
      serverTime: new Date(now).toISOString(),
    });
  } catch (error) {
    next(error);
  }
};
