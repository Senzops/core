import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { TaskService, TaskRun, TaskMetric, TaskSignature } from '../../models/Task';
import { ErrorEvent } from '../../models/Error';

// --- Time Range Utilities ---
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

const fillTimeGaps = (data: any[], range: string, startDate: Date, fields: string[] = ['runs', 'failures']) => {
  if (!data || data.length === 0) return [];
  const filled = [];
  const now = new Date();
  let current = new Date(startDate);

  if (range === '1h') current.setSeconds(0, 0);
  else if (range === '24h') current.setMinutes(0, 0, 0);
  else current.setHours(0, 0, 0, 0);

  const dataMap = new Map(data.map(item => [item._id, item]));

  while (current <= now) {
    let key = '';
    if (range === '1h') key = current.toISOString().slice(0, 16) + ":00.000Z";
    else if (range === '24h') key = current.toISOString().slice(0, 13) + ":00:00.000Z";
    else key = current.toISOString().slice(0, 10);

    const existing = dataMap.get(key) || {};
    const entry: any = { time: key };
    fields.forEach(f => entry[f] = existing[f] || 0);
    if (existing.durationSum) entry.durationAvg = existing.durationSum / (existing.runs || 1);
    else entry.durationAvg = 0;

    filled.push(entry);

    if (range === '1h') current.setMinutes(current.getMinutes() + 1);
    else if (range === '24h') current.setHours(current.getHours() + 1);
    else current.setDate(current.getDate() + 1);
  }

  return filled;
};

export const getTaskServiceDashboard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { uid } = (req as any).user;
    const range = req.query.range as string || '24h';
    const startDate = getStartDate(range);

    const service = await TaskService.findOne({ _id: id, ownerId: uid }).lean();
    if (!service) return res.status(404).json({ error: "Service not found" });

    const serviceIdObj = new mongoose.Types.ObjectId(id);

    // 1. Global Trend (Time Series)
    const trendRaw = await TaskMetric.aggregate([
      { $match: { serviceId: serviceIdObj, timestamp: { $gte: startDate } } },
      {
        $group: {
          _id: { $dateToString: { format: getTrendFormat(range), date: "$timestamp" } },
          runs: { $sum: "$runs" },
          failures: { $sum: "$failures" },
          durationSum: { $sum: "$durationSum" },
          queueDelaySum: { $sum: "$queueDelaySum" }
        }
      },
      { $sort: { "_id": 1 } }
    ]);

    const trend = trendRaw.length > 0 ? fillTimeGaps(trendRaw, range, startDate, ['runs', 'failures', 'queueDelaySum']) : [];

    // 2. Global Stats & Aggregates
    const statsAgg = await TaskMetric.aggregate([
      { $match: { serviceId: serviceIdObj, timestamp: { $gte: startDate } } },
      {
        $group: {
          _id: null,
          totalRuns: { $sum: "$runs" },
          totalFailures: { $sum: "$failures" },
          uniqueTasks: { $addToSet: "$taskName" },
          queueDelaySum: { $sum: "$queueDelaySum" }
        }
      }
    ]);

    const stats = statsAgg[0] || { totalRuns: 0, totalFailures: 0, uniqueTasks: [], queueDelaySum: 0 };

    // 3. Task Table (List of unique tasks and their stats)
    const tasksTable = await TaskMetric.aggregate([
      { $match: { serviceId: serviceIdObj, timestamp: { $gte: startDate } } },
      {
        $group: {
          _id: "$taskName",
          totalRuns: { $sum: "$runs" },
          failures: { $sum: "$failures" },
          durationSum: { $sum: "$durationSum" },
          lastRun: { $max: "$timestamp" }
        }
      },
      { $sort: { totalRuns: -1 } }
    ]);

    res.json({ service, stats, trend, tasksTable });
  } catch (error) {
    next(error);
  }
};

export const getTaskEntityDetail = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, taskName } = req.params;
    const { uid } = (req as any).user;
    const range = req.query.range as string || '24h';
    const startDate = getStartDate(range);

    const service = await TaskService.findOne({ _id: id, ownerId: uid }).lean();
    if (!service) return res.status(404).json({ error: "Service not found" });

    const serviceIdObj = new mongoose.Types.ObjectId(id);
    const decodedTaskName = decodeURIComponent(taskName);

    // NEW: Fetch Watchdog Signature
    const signature = await TaskSignature.findOne({ serviceId: serviceIdObj, taskName: decodedTaskName }).lean();

    // 1. Task Specific Trend
    const trendRaw = await TaskMetric.aggregate([
      { $match: { serviceId: serviceIdObj, taskName: decodedTaskName, timestamp: { $gte: startDate } } },
      {
        $group: {
          _id: { $dateToString: { format: getTrendFormat(range), date: "$timestamp" } },
          runs: { $sum: "$runs" },
          failures: { $sum: "$failures" },
          durationSum: { $sum: "$durationSum" }
        }
      },
      { $sort: { "_id": 1 } }
    ]);

    const trend = trendRaw.length > 0 ? fillTimeGaps(trendRaw, range, startDate, ['runs', 'failures']) : [];

    // 2. Task Specific Stats
    const statsAgg = await TaskMetric.aggregate([
      { $match: { serviceId: serviceIdObj, taskName: decodedTaskName, timestamp: { $gte: startDate } } },
      {
        $group: {
          _id: null,
          totalRuns: { $sum: "$runs" },
          totalFailures: { $sum: "$failures" },
          durationSum: { $sum: "$durationSum" },
          maxAttempts: { $max: "$attemptsSum" }
        }
      }
    ]);

    // 3. Recent Executions (Raw Runs)
    const recentRuns = await TaskRun.find({
      serviceId: serviceIdObj,
      taskName: decodedTaskName,
      timestamp: { $gte: startDate }
    })
      .sort({ timestamp: -1 })
      .limit(50)
      .select('-spans') // Exclude spans to save bandwidth
      .lean();

    res.json({
      taskName: decodedTaskName,
      signature, // NEW: Exporting to frontend
      stats: statsAgg[0] || { totalRuns: 0, totalFailures: 0, durationSum: 0, maxAttempts: 1 },
      trend,
      recentRuns
    });
  } catch (error) {
    next(error);
  }
};

export const getTaskRunDetail = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, runId } = req.params; // id = serviceId

    const query: any = { serviceId: id };
    if (mongoose.Types.ObjectId.isValid(runId)) {
      query.$or = [{ _id: runId }, { runId: runId }];
    } else {
      query.runId = runId;
    }

    const run = await TaskRun.findOne(query).lean();
    if (!run) return res.status(404).json({ error: "Task Run not found" });

    // Normalize absolute OTLP timestamps to relative milliseconds dynamically
    const normalizeSpans = (spans: any[], rootTime: Date) => {
      const rootMs = new Date(rootTime).getTime();
      return spans.map((s: any) => {
        if (s.startTime > 1000000000) {
          return { ...s, startTime: Math.max(0, s.startTime - rootMs) };
        }
        return s;
      });
    };
    run.spans = normalizeSpans(run.spans || [], run.timestamp);

    // NEW: Generic Error Lookup
    const errors = await ErrorEvent.find({ serviceId: id, traceId: run.runId }).lean();

    res.json({ run, errors });
  } catch (error) {
    next(error);
  }
};