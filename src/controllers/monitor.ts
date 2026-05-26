import { Request, Response, NextFunction } from 'express';
import { Monitor, MonitorRun } from '../models/Monitor';
import { User } from '../models/User';
import { RegisterMonitorSchema, UpdateMonitorSchema } from '../utils/validation';

// --- Register ---
export const registerMonitor = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid, email } = (req as any).user;
    const { name, url, interval } = RegisterMonitorSchema.parse(req.body);

    const newMonitor = await Monitor.create({
      ownerId: uid,
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
    const { uid } = (req as any).user;
    const list = await Monitor.find({ ownerId: uid }).sort({ createdAt: -1 });
    res.json(list);
  } catch (error) {
    next(error);
  }
};

// --- Update ---
export const updateMonitor = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;
    const updates = UpdateMonitorSchema.parse(req.body);

    const updateFields: Record<string, any> = {};
    if (updates.name !== undefined) updateFields.name = updates.name;
    if (updates.url !== undefined) updateFields.url = updates.url;
    if (updates.interval !== undefined) updateFields.interval = updates.interval;

    const updated = await Monitor.findOneAndUpdate(
      { _id: id, ownerId: uid },
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
    const { uid } = (req as any).user;
    const { id } = req.params;

    const result = await Monitor.findOneAndDelete({ _id: id, ownerId: uid });
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
    const { uid } = (req as any).user;
    const { range } = req.query; // '24h', '2d', '5d', '7d'

    // 1. Verify Ownership
    const monitor = await Monitor.findOne({ _id: id, ownerId: uid });
    if (!monitor) return res.status(404).json({ error: "Monitor not found" });

    // 2. Calculate Date Range
    const now = new Date();
    const startDate = new Date();

    switch (range) {
      case '7d':
        startDate.setDate(now.getDate() - 7);
        break;
      case '5d':
        startDate.setDate(now.getDate() - 5);
        break;
      case '2d':
        startDate.setDate(now.getDate() - 2);
        break;
      case '24h':
      default:
        startDate.setHours(now.getHours() - 24);
        break;
    }

    // 3. Fetch Runs in Range
    const runs = await MonitorRun.find({
      monitorId: id,
      createdAt: { $gte: startDate }
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
    next(error);
  }
};