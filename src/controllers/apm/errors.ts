import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { ApmErrorGroup, ApmErrorEvent } from '../../models/ApmError';
import { ApmService } from '../../models/Apm';

const getStartDate = (range: string) => {
  const date = new Date();
  switch (range) {
    case '1h': date.setHours(date.getHours() - 1); break;
    case '7d': date.setDate(date.getDate() - 7); break;
    case '30d': date.setDate(date.getDate() - 30); break;
    case '24h':
    default: date.setHours(date.getHours() - 24); break;
  }
  return date;
};

const getTrendFormat = (range: string) => {
  if (range === '1h') return "%Y-%m-%dT%H:%M:00.000Z";
  if (range === '7d' || range === '30d') return "%Y-%m-%d";
  return "%Y-%m-%dT%H:00:00.000Z"; // Default 24h is hourly
};

// --- Helper: Zero-Fill Time Series for Trend Graphs ---
const fillTimeGaps = (data: any[], range: string, startDate: Date) => {
  if (!data || data.length === 0) return [];

  const filled = [];
  const now = new Date();

  let current = new Date(startDate);
  // Align start boundary based on the resolution
  if (range === '1h') current.setSeconds(0, 0);
  else if (range === '24h') current.setMinutes(0, 0, 0);
  else current.setHours(0, 0, 0, 0);

  const dataMap = new Map(data.map(item => [item._id, item.count]));

  while (current <= now) {
    let key = '';
    if (range === '1h') key = current.toISOString().slice(0, 16) + ":00.000Z";
    else if (range === '24h') key = current.toISOString().slice(0, 13) + ":00:00.000Z";
    else key = current.toISOString().slice(0, 10);

    filled.push({
      time: key,
      count: dataMap.get(key) || 0
    });

    if (range === '1h') current.setMinutes(current.getMinutes() + 1);
    else if (range === '24h') current.setHours(current.getHours() + 1);
    else current.setDate(current.getDate() + 1);
  }

  return filled;
};

export const getGlobalErrors = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string;
    const status = req.query.status as string || 'unresolved';
    const apmId = req.query.apmId as string;
    const range = req.query.range as string || '24h';

    const startDate = getStartDate(range);

    const query: any = { ownerId: uid, lastSeen: { $gte: startDate } };
    if (status !== 'all') query.status = status;
    if (apmId) query.apmId = apmId;

    if (search) {
      query.$or = [
        { errorClass: { $regex: search, $options: 'i' } },
        { message: { $regex: search, $options: 'i' } }
      ];
    }

    const [groups, total] = await Promise.all([
      ApmErrorGroup.find(query)
        .sort({ lastSeen: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('apmId', 'name framework')
        .lean(),
      ApmErrorGroup.countDocuments(query)
    ]);

    // --- AGGREGATE GLOBAL TREND & STATS ---
    let apmIdsMatch = [];
    if (apmId) {
      apmIdsMatch = [new mongoose.Types.ObjectId(apmId)];
    } else {
      const userApms = await ApmService.find({ ownerId: uid }).select('_id').lean();
      apmIdsMatch = userApms.map(a => a._id);
    }

    const [trendRaw, eventStats, unresolvedCount] = await Promise.all([
      ApmErrorEvent.aggregate([
        { $match: { apmId: { $in: apmIdsMatch }, timestamp: { $gte: startDate } } },
        { $group: { _id: { $dateToString: { format: getTrendFormat(range), date: "$timestamp" } }, count: { $sum: 1 } } },
        { $sort: { "_id": 1 } }
      ]),
      ApmErrorEvent.aggregate([
        { $match: { apmId: { $in: apmIdsMatch }, timestamp: { $gte: startDate } } },
        { $group: { _id: null, count: { $sum: 1 }, uniqueServices: { $addToSet: "$apmId" } } }
      ]),
      ApmErrorGroup.countDocuments({ ownerId: uid, status: 'unresolved', lastSeen: { $gte: startDate } })
    ]);

    // Apply zero-filling only if data exists
    const trend = trendRaw.length > 0 ? fillTimeGaps(trendRaw, range, startDate) : [];

    res.json({
      errors: groups,
      trend,
      stats: {
        totalErrors: eventStats[0]?.count || 0,
        affectedServices: eventStats[0]?.uniqueServices?.length || 0,
        unresolvedCount
      },
      pagination: { total, page, limit, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    next(error);
  }
};

export const getErrorGroupDetails = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { groupId } = req.params;
    const range = req.query.range as string || '24h';

    const startDate = getStartDate(range);

    const group = await ApmErrorGroup.findOne({ _id: groupId, ownerId: uid })
      .populate('apmId', 'name framework')
      .lean();

    if (!group) return res.status(404).json({ error: 'Error group not found' });

    const [events, trendRaw] = await Promise.all([
      ApmErrorEvent.find({ groupId, timestamp: { $gte: startDate } })
        .sort({ timestamp: -1 })
        .limit(100)
        .lean(),
      ApmErrorEvent.aggregate([
        { $match: { groupId: new mongoose.Types.ObjectId(groupId), timestamp: { $gte: startDate } } },
        { $group: { _id: { $dateToString: { format: getTrendFormat(range), date: "$timestamp" } }, count: { $sum: 1 } } },
        { $sort: { "_id": 1 } }
      ])
    ]);

    // Apply zero-filling only if data exists
    const trend = trendRaw.length > 0 ? fillTimeGaps(trendRaw, range, startDate) : [];

    res.json({
      group,
      events,
      trend
    });
  } catch (error) {
    next(error);
  }
};

export const updateErrorStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { groupId } = req.params;
    const { status } = req.body;

    if (!['unresolved', 'resolved', 'ignored'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const updated = await ApmErrorGroup.findOneAndUpdate(
      { _id: groupId, ownerId: uid },
      { $set: { status } },
      { new: true }
    );

    if (!updated) return res.status(404).json({ error: 'Error group not found' });
    res.json({ message: 'Status updated', group: updated });
  } catch (error) {
    next(error);
  }
};

export const getTraceErrors = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, traceId } = req.params;
    const events = await ApmErrorEvent.find({ apmId: id, traceId }).sort({ timestamp: 1 }).lean();
    res.json({ errors: events });
  } catch (error) {
    next(error);
  }
};