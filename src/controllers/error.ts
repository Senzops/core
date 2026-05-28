import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { ErrorGroup, ErrorEvent } from '../models/Error';
import { ApmService } from '../models/Apm';
import { TaskService } from '../models/Task';
import { RumService } from '../models/Rum';
import { resolveTimeRange, fillTimeGaps, getEffectiveRetention, buildTimeRangeMeta, TimeRangeError } from '../utils/timeRange';

const ERROR_TREND_DEFAULTS = { count: 0 };

// --- DTO Formatter ---
// Transforms the raw DB document into a clean, frontend-ready object
const mapErrorGroupDTO = (g: any) => {
  const service = g.serviceId ? {
    _id: g.serviceId._id,
    name: g.serviceId.name,
    type: g.serviceModel === 'TaskService' ? 'task' : g.serviceModel === 'RumService' ? 'rum' : 'apm', // NEW: Added RUM type
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
    const reqServiceId = req.query.serviceId as string;
    const { range, start, end } = req.query;

    const maxRetention = await getEffectiveRetention('errors', uid);
    const resolved = resolveTimeRange(
      { range: range as string, start: start as string, end: end as string },
      maxRetention
    );
    const { startDate, endDate, bucketFormat } = resolved;
    const meta = buildTimeRangeMeta(resolved, maxRetention);

    const query: any = { ownerId: uid, lastSeen: { $gte: startDate, $lte: endDate } };
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
        .populate('serviceId', 'name framework status') // Mongoose auto-resolves ApmService vs TaskService vs RumService
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
      const [userApms, userTasks, userRums] = await Promise.all([
        ApmService.find({ ownerId: uid }).select('_id').lean(),
        TaskService.find({ ownerId: uid }).select('_id').lean(),
        RumService.find({ ownerId: uid }).select('_id').lean() // NEW: Fetch RUM services
      ]);
      serviceIdsMatch = [
        ...userApms.map(a => a._id),
        ...userTasks.map(t => t._id),
        ...userRums.map(r => r._id) // NEW: Merge RUM IDs
      ];
    }

    const [trendRaw, eventStats, unresolvedCount] = await Promise.all([
      ErrorEvent.aggregate([
        { $match: { serviceId: { $in: serviceIdsMatch }, timestamp: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: { $dateToString: { format: bucketFormat, date: "$timestamp" } }, count: { $sum: 1 } } },
        { $sort: { "_id": 1 } }
      ]),
      ErrorEvent.aggregate([
        { $match: { serviceId: { $in: serviceIdsMatch }, timestamp: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: null, count: { $sum: 1 }, uniqueServices: { $addToSet: "$serviceId" } } }
      ]),
      ErrorGroup.countDocuments({ ownerId: uid, status: 'unresolved', lastSeen: { $gte: startDate, $lte: endDate } })
    ]);

    const trend = fillTimeGaps(trendRaw, resolved, ERROR_TREND_DEFAULTS);

    res.json({
      errors: groups,
      trend,
      timeRange: meta,
      stats: {
        totalErrors: eventStats[0]?.count || 0,
        affectedServices: eventStats[0]?.uniqueServices?.length || 0,
        unresolvedCount
      },
      pagination: { total, page, limit, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};

export const getErrorGroupDetails = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { groupId } = req.params;
    const { range, start, end } = req.query;

    const maxRetention = await getEffectiveRetention('errors', uid);
    const resolved = resolveTimeRange(
      { range: range as string, start: start as string, end: end as string },
      maxRetention
    );
    const { startDate, endDate, bucketFormat } = resolved;
    const detailMeta = buildTimeRangeMeta(resolved, maxRetention);

    const groupRaw = await ErrorGroup.findOne({ _id: groupId, ownerId: uid })
      .populate('serviceId', 'name framework status domain') // Fetches domain if it's a RUM service
      .lean();

    if (!groupRaw) return res.status(404).json({ error: 'Error group not found' });
    const group = mapErrorGroupDTO(groupRaw);

    const [events, trendRaw] = await Promise.all([
      ErrorEvent.find({ groupId, timestamp: { $gte: startDate, $lte: endDate } })
        .sort({ timestamp: -1 })
        .limit(100)
        .lean(),
      ErrorEvent.aggregate([
        { $match: { groupId: new mongoose.Types.ObjectId(groupId), timestamp: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: { $dateToString: { format: bucketFormat, date: "$timestamp" } }, count: { $sum: 1 } } },
        { $sort: { "_id": 1 } }
      ])
    ]);

    const trend = fillTimeGaps(trendRaw, resolved, ERROR_TREND_DEFAULTS);

    res.json({ group, events, trend, timeRange: detailMeta });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
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