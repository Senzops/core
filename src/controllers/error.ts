import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { ErrorGroup, ErrorEvent } from '../models/Error';
import { ApmService } from '../models/Apm';
import { TaskService } from '../models/Task';

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

const fillTimeGaps = (data: any[], range: string, startDate: Date) => {
  if (!data || data.length === 0) return [];
  const filled = [];
  const now = new Date();

  let current = new Date(startDate);
  if (range === '1h') current.setSeconds(0, 0);
  else if (range === '24h') current.setMinutes(0, 0, 0);
  else current.setHours(0, 0, 0, 0);

  const dataMap = new Map(data.map(item => [item._id, item.count]));

  while (current <= now) {
    let key = '';
    if (range === '1h') key = current.toISOString().slice(0, 16) + ":00.000Z";
    else if (range === '24h') key = current.toISOString().slice(0, 13) + ":00:00.000Z";
    else key = current.toISOString().slice(0, 10);

    filled.push({ time: key, count: dataMap.get(key) || 0 });

    if (range === '1h') current.setMinutes(current.getMinutes() + 1);
    else if (range === '24h') current.setHours(current.getHours() + 1);
    else current.setDate(current.getDate() + 1);
  }
  return filled;
};

// --- DTO Formatter ---
// Transforms the raw DB document into a clean, frontend-ready object
const mapErrorGroupDTO = (g: any) => {
  const service = g.serviceId ? {
    _id: g.serviceId._id,
    name: g.serviceId.name,
    type: g.serviceModel === 'TaskService' ? 'task' : 'apm',
    framework: g.serviceId.framework || 'unknown'
  } : null;

  const { serviceId, serviceModel, ...rest } = g;
  return { ...rest, service };
};

export const getGlobalErrors = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string;
    const status = req.query.status as string || 'unresolved';
    const reqServiceId = req.query.serviceId as string; // Formerly apmId
    const range = req.query.range as string || '24h';

    const startDate = getStartDate(range);

    const query: any = { ownerId: uid, lastSeen: { $gte: startDate } };
    if (status !== 'all') query.status = status;
    if (reqServiceId) query.serviceId = reqServiceId;

    if (search) {
      query.$or = [
        { errorClass: { $regex: search, $options: 'i' } },
        { message: { $regex: search, $options: 'i' } }
      ];
    }

    const [groupsRaw, total] = await Promise.all([
      ErrorGroup.find(query)
        .sort({ lastSeen: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('serviceId', 'name framework status') // Mongoose auto-resolves ApmService vs TaskService!
        .lean(),
      ErrorGroup.countDocuments(query)
    ]);

    const groups = groupsRaw.map(mapErrorGroupDTO);

    // --- AGGREGATE GLOBAL TREND & STATS ---
    let serviceIdsMatch = [];
    if (reqServiceId) {
      serviceIdsMatch = [new mongoose.Types.ObjectId(reqServiceId)];
    } else {
      // If no specific service is selected, aggregate across ALL services the user owns
      const [userApms, userTasks] = await Promise.all([
        ApmService.find({ ownerId: uid }).select('_id').lean(),
        TaskService.find({ ownerId: uid }).select('_id').lean()
      ]);
      serviceIdsMatch = [...userApms.map(a => a._id), ...userTasks.map(t => t._id)];
    }

    const [trendRaw, eventStats, unresolvedCount] = await Promise.all([
      ErrorEvent.aggregate([
        { $match: { serviceId: { $in: serviceIdsMatch }, timestamp: { $gte: startDate } } },
        { $group: { _id: { $dateToString: { format: getTrendFormat(range), date: "$timestamp" } }, count: { $sum: 1 } } },
        { $sort: { "_id": 1 } }
      ]),
      ErrorEvent.aggregate([
        { $match: { serviceId: { $in: serviceIdsMatch }, timestamp: { $gte: startDate } } },
        { $group: { _id: null, count: { $sum: 1 }, uniqueServices: { $addToSet: "$serviceId" } } }
      ]),
      ErrorGroup.countDocuments({ ownerId: uid, status: 'unresolved', lastSeen: { $gte: startDate } })
    ]);

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

    const groupRaw = await ErrorGroup.findOne({ _id: groupId, ownerId: uid })
      .populate('serviceId', 'name framework status')
      .lean();

    if (!groupRaw) return res.status(404).json({ error: 'Error group not found' });
    const group = mapErrorGroupDTO(groupRaw);

    const [events, trendRaw] = await Promise.all([
      ErrorEvent.find({ groupId, timestamp: { $gte: startDate } })
        .sort({ timestamp: -1 })
        .limit(100)
        .lean(),
      ErrorEvent.aggregate([
        { $match: { groupId: new mongoose.Types.ObjectId(groupId), timestamp: { $gte: startDate } } },
        { $group: { _id: { $dateToString: { format: getTrendFormat(range), date: "$timestamp" } }, count: { $sum: 1 } } },
        { $sort: { "_id": 1 } }
      ])
    ]);

    const trend = trendRaw.length > 0 ? fillTimeGaps(trendRaw, range, startDate) : [];

    res.json({ group, events, trend });
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

    const updated = await ErrorGroup.findOneAndUpdate(
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
    // Polymorphic lookup across ANY service that matches this traceId/runId combo
    const events = await ErrorEvent.find({ serviceId: id, traceId }).sort({ timestamp: 1 }).lean();
    res.json({ errors: events });
  } catch (error) {
    next(error);
  }
};