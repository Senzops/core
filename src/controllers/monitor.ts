import { Request, Response, NextFunction } from 'express';
import { Monitor, MonitorRun } from '../models/Monitor';
import { User } from '../models/User';
import { RegisterMonitorSchema, UpdateMonitorSchema } from '../utils/validation';
import { resolveTimeRange, getEffectiveRetention, TimeRangeError } from '../utils/timeRange';

// --- Register ---
export const registerMonitor = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { email } = (req as any).user;
    const { name, url, interval } = RegisterMonitorSchema.parse(req.body);

    const newMonitor = await Monitor.create({
      ownerId,
      name,
      url,
      interval,
      // nextCheck defaults to now, so worker picks it up immediately
    });

    res.status(201).json(newMonitor);
  } catch (error) {
    next(error);
  }
};

// --- List ---
export const listMonitors = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const list = await Monitor.find({ ownerId }).sort({ createdAt: -1 });
    res.json(list);
  } catch (error) {
    next(error);
  }
};

// --- Update ---
export const updateMonitor = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const updates = UpdateMonitorSchema.parse(req.body);

    const updateFields: Record<string, any> = {};
    if (updates.name !== undefined) updateFields.name = updates.name;
    if (updates.url !== undefined) updateFields.url = updates.url;
    if (updates.interval !== undefined) updateFields.interval = updates.interval;

    const updated = await Monitor.findOneAndUpdate(
      { _id: id, ownerId },
      updateFields,
      { new: true, runValidators: true }
    );
    if (!updated) return res.status(404).json({ error: 'Monitor not found' });

    res.json({ message: 'Monitor Updated', monitor: updated });
  } catch (error) {
    next(error);
  }
};

// --- Delete ---
export const deleteMonitor = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const result = await Monitor.findOneAndDelete({ _id: id, ownerId });
    if (!result) return res.status(404).json({ error: 'Monitor not found' });

    await MonitorRun.deleteMany({ monitorId: id });

    res.json({ message: 'Monitor deleted' });
  } catch (error) {
    next(error);
  }
};

// --- Get Stats (Detailed) ---
export const getMonitorStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const ownerId = (req as any).ownerId;
    const { range, start, end } = req.query;

    // 1. Verify Ownership
    const monitor = await Monitor.findOne({ _id: id, ownerId });
    if (!monitor) return res.status(404).json({ error: "Monitor not found" });

    // 2. Resolve time range via centralized utility
    const maxRetention = await getEffectiveRetention('monitor', ownerId);
    const resolved = resolveTimeRange(
      { range: range as string | undefined, start: start as string | undefined, end: end as string | undefined },
      maxRetention
    );

    // 3. Fetch Runs in Range
    const runs = await MonitorRun.find({
      monitorId: id,
      createdAt: { $gte: resolved.startDate, $lte: resolved.endDate },
    }).sort({ createdAt: -1 }); // Newest first

    // 4. Calculate Aggregates
    const total = runs.length;
    const upCount = runs.filter(r => r.status === 'up').length;

    // Uptime Percentage
    const uptimePercentage = total === 0 ? 100 : ((upCount / total) * 100);

    // Average Latency
    const avgLatency = total === 0 ? 0 : runs.reduce((acc, curr) => acc + curr.latency, 0) / total;

    // Latest Check Data
    const latestRun = runs.length > 0 ? runs[0] : null;

    res.json({
      monitor,
      stats: {
        uptime: uptimePercentage,
        avgLatency,
        totalChecks: total,
        // Specific Latest Check Data
        lastLatency: latestRun?.latency || 0,
        lastStatus: latestRun?.status || 'pending',
        lastCheckTime: latestRun?.createdAt || monitor.lastCheck,
        lastStatusCode: latestRun?.statusCode || 0
      },
      // Return all runs for the graph (Timeline)
      history: runs
    });

  } catch (error) {
    if (error instanceof TimeRangeError) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
};