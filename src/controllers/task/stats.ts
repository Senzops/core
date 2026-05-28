import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { TaskService, TaskRun, TaskMetric, TaskSignature } from '../../models/Task';
import { ErrorEvent } from '../../models/Error';
import { resolveTimeRange, fillTimeGaps as fillTimeGapsGeneric, getEffectiveRetention, buildTimeRangeMeta, TimeRangeError, type ResolvedTimeRange } from '../../utils/timeRange';

const TASK_TREND_DEFAULTS = { runs: 0, failures: 0, durationSum: 0, queueDelaySum: 0, durationAvg: 0 };

export const getTaskServiceDashboard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { uid } = (req as any).user;
    const { range, start, end } = req.query;

    const maxRetention = await getEffectiveRetention('task', uid);
    const resolved = resolveTimeRange(
      { range: range as string, start: start as string, end: end as string },
      maxRetention
    );
    const { startDate, endDate, bucketFormat } = resolved;
    const meta = buildTimeRangeMeta(resolved, maxRetention);

    const service = await TaskService.findOne({ _id: id, ownerId: uid }).lean();
    if (!service) return res.status(404).json({ error: "Service not found" });

    const serviceIdObj = new mongoose.Types.ObjectId(id);
    const timeMatch = { $gte: startDate, $lte: endDate };

    // 1. Global Trend (Time Series)
    const trendRaw = await TaskMetric.aggregate([
      { $match: { serviceId: serviceIdObj, timestamp: timeMatch } },
      {
        $group: {
          _id: { $dateToString: { format: bucketFormat, date: "$timestamp" } },
          runs: { $sum: "$runs" },
          failures: { $sum: "$failures" },
          durationSum: { $sum: "$durationSum" },
          queueDelaySum: { $sum: "$queueDelaySum" }
        }
      },
      { $sort: { "_id": 1 } }
    ]);

    const trend = fillTimeGapsGeneric(trendRaw, resolved, TASK_TREND_DEFAULTS);

    // 2. Global Stats & Aggregates
    const statsAgg = await TaskMetric.aggregate([
      { $match: { serviceId: serviceIdObj, timestamp: timeMatch } },
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
      { $match: { serviceId: serviceIdObj, timestamp: timeMatch } },
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

    // 4. Watchdog Health: fetch all signatures for this service to enrich the table
    const signatures = await TaskSignature.find({ serviceId: serviceIdObj })
      .select('taskName healthState consecutiveMisses consecutiveFailures lastHealthTransition scheduleExpression taskType')
      .lean();

    const sigMap = new Map(signatures.map(s => [s.taskName, s]));

    const enrichedTasksTable = tasksTable.map((t: any) => {
      const sig = sigMap.get(t._id);
      return {
        ...t,
        healthState: sig?.healthState || 'healthy',
        consecutiveMisses: sig?.consecutiveMisses || 0,
        consecutiveFailures: sig?.consecutiveFailures || 0,
        lastHealthTransition: sig?.lastHealthTransition || null,
        scheduleExpression: sig?.scheduleExpression || null,
        taskType: sig?.taskType || null,
      };
    });

    const watchdogSummary = {
      total: signatures.length,
      healthy: signatures.filter(s => s.healthState === 'healthy').length,
      missing: signatures.filter(s => s.healthState === 'missing').length,
      stalled: signatures.filter(s => s.healthState === 'stalled').length,
      failing: signatures.filter(s => s.healthState === 'failing').length,
    };

    res.json({ service, timeRange: meta, stats, trend, tasksTable: enrichedTasksTable, watchdogSummary });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};

export const getTaskEntityDetail = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, taskName } = req.params;
    const { uid } = (req as any).user;
    const { range, start, end } = req.query;

    const maxRetention = await getEffectiveRetention('task', uid);
    const resolved = resolveTimeRange(
      { range: range as string, start: start as string, end: end as string },
      maxRetention
    );
    const { startDate, endDate, bucketFormat } = resolved;
    const meta = buildTimeRangeMeta(resolved, maxRetention);

    const service = await TaskService.findOne({ _id: id, ownerId: uid }).lean();
    if (!service) return res.status(404).json({ error: "Service not found" });

    const serviceIdObj = new mongoose.Types.ObjectId(id);
    const decodedTaskName = decodeURIComponent(taskName);
    const timeMatch = { $gte: startDate, $lte: endDate };

    const signature = await TaskSignature.findOne({ serviceId: serviceIdObj, taskName: decodedTaskName })
      .select('taskType scheduleExpression healthState consecutiveMisses consecutiveFailures lastHealthTransition avgDuration lastRunAt lastStatus gracePeriodMs stallMultiplier failureRateThreshold')
      .lean();

    // 1. Task Specific Trend
    const trendRaw = await TaskMetric.aggregate([
      { $match: { serviceId: serviceIdObj, taskName: decodedTaskName, timestamp: timeMatch } },
      {
        $group: {
          _id: { $dateToString: { format: bucketFormat, date: "$timestamp" } },
          runs: { $sum: "$runs" },
          failures: { $sum: "$failures" },
          durationSum: { $sum: "$durationSum" }
        }
      },
      { $sort: { "_id": 1 } }
    ]);

    const trend = fillTimeGapsGeneric(trendRaw, resolved, { runs: 0, failures: 0, durationSum: 0, durationAvg: 0 });

    // 2. Task Specific Stats
    const statsAgg = await TaskMetric.aggregate([
      { $match: { serviceId: serviceIdObj, taskName: decodedTaskName, timestamp: timeMatch } },
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
      timestamp: timeMatch
    })
      .sort({ timestamp: -1 })
      .limit(50)
      .select('-spans') // Exclude spans to save bandwidth
      .lean();

    res.json({
      taskName: decodedTaskName,
      signature,
      timeRange: meta,
      stats: statsAgg[0] || { totalRuns: 0, totalFailures: 0, durationSum: 0, maxAttempts: 1 },
      trend,
      recentRuns
    });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
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