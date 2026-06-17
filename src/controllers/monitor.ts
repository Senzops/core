import { Request, Response, NextFunction } from 'express';
import { Monitor, MonitorRun, MonitorIncident } from '../models/Monitor';
import { MonitorBoard } from '../models/MonitorBoard';
import { DashboardShare } from '../models/DashboardShare';
import { Subscription } from '../models/Subscription';
import { getPlanConfig } from '../config/pricing';
import { RegisterMonitorSchema, UpdateMonitorSchema, PREMIUM_INTERVALS } from '../utils/validation';
import { resolveTimeRange, getEffectiveRetention, TimeRangeError } from '../utils/timeRange';

const PREMIUM_INTERVAL_PLANS = ['business', 'enterprise'];

const validateIntervalForPlan = async (interval: number, ownerId: string): Promise<string | null> => {
  if (!(PREMIUM_INTERVALS as readonly number[]).includes(interval)) return null;

  const sub = await Subscription.findOne({ ownerId }).select('planId').lean();
  const plan = getPlanConfig(sub?.planId);

  if (!PREMIUM_INTERVAL_PLANS.includes(plan.id)) {
    return `${interval}-minute check intervals require a Business or Enterprise plan. Your current plan is ${plan.name}.`;
  }
  return null;
};

// --- Register ---
export const registerMonitor = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const parsed = RegisterMonitorSchema.parse(req.body);

    const planError = await validateIntervalForPlan(parsed.interval, ownerId);
    if (planError) {
      return res.status(402).json({
        error: planError,
        code: 'PLAN_INTERVAL_RESTRICTED',
      });
    }

    const newMonitor = await Monitor.create({
      ownerId,
      name: parsed.name,
      url: parsed.url,
      interval: parsed.interval,
      method: parsed.method,
      headers: parsed.headers,
      body: parsed.body,
      expectedStatus: parsed.expectedStatus,
    });

    res.status(201).json(newMonitor);
  } catch (error) {
    next(error);
  }
};

const redactHeaders = (headers: Record<string, string> | undefined): Record<string, string> => {
  if (!headers || typeof headers !== 'object') return {};
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const isSecret = /auth|token|key|secret|bearer|credential|password/i.test(key) || /auth|token|key|secret|bearer|credential|password/i.test(value);
    redacted[key] = isSecret ? '••••••••' : value;
  }
  return redacted;
};

// --- List ---
export const listMonitors = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const list = await Monitor.find({ ownerId }).sort({ createdAt: -1 }).lean();
    const sanitized = list.map((m: any) => ({ ...m, headers: redactHeaders(m.headers) }));
    res.json(sanitized);
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

    if (updates.interval !== undefined) {
      const planError = await validateIntervalForPlan(updates.interval, ownerId);
      if (planError) {
        return res.status(402).json({
          error: planError,
          code: 'PLAN_INTERVAL_RESTRICTED',
        });
      }
    }

    const updateFields: Record<string, any> = {};
    if (updates.name !== undefined) updateFields.name = updates.name;
    if (updates.url !== undefined) updateFields.url = updates.url;
    if (updates.interval !== undefined) updateFields.interval = updates.interval;
    if (updates.method !== undefined) updateFields.method = updates.method;
    if (updates.headers !== undefined) updateFields.headers = updates.headers;
    if (updates.body !== undefined) updateFields.body = updates.body;
    if (updates.expectedStatus !== undefined) updateFields.expectedStatus = updates.expectedStatus;

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

    await Promise.all([
      MonitorRun.deleteMany({ monitorId: id }),
      MonitorIncident.deleteMany({ monitorId: id }),
      DashboardShare.deleteMany({ scopeType: 'uptime', scopeId: id, ownerId }),
      // Remove this monitor's card from any Status Board it appears on.
      MonitorBoard.updateMany({ ownerId, 'layout.i': id }, { $pull: { layout: { i: id } } }),
    ]);

    res.json({ message: 'Monitor deleted' });
  } catch (error) {
    next(error);
  }
};

// --- Percentile calculator ---
const getPercentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
};

// --- Get Stats (Detailed) ---
export const getMonitorStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const ownerId = (req as any).ownerId;
    const { range, start, end } = req.query;

    const monitor = await Monitor.findOne({ _id: id, ownerId });
    if (!monitor) return res.status(404).json({ error: "Monitor not found" });

    const maxRetention = await getEffectiveRetention('monitor', ownerId);
    const resolved = resolveTimeRange(
      { range: range as string | undefined, start: start as string | undefined, end: end as string | undefined },
      maxRetention
    );

    const [runs, incidents] = await Promise.all([
      MonitorRun.find({
        monitorId: id,
        createdAt: { $gte: resolved.startDate, $lte: resolved.endDate },
      }).sort({ createdAt: -1 }),

      MonitorIncident.find({
        monitorId: id,
        startedAt: { $gte: resolved.startDate },
      }).sort({ startedAt: -1 }).limit(50),
    ]);

    const total = runs.length;
    const upCount = runs.filter(r => r.status === 'up').length;
    const uptimePercentage = total === 0 ? 100 : ((upCount / total) * 100);
    const avgLatency = total === 0 ? 0 : runs.reduce((acc, curr) => acc + curr.latency, 0) / total;

    const latencies = runs.map(r => r.latency).sort((a, b) => a - b);
    const p50 = getPercentile(latencies, 50);
    const p95 = getPercentile(latencies, 95);
    const p99 = getPercentile(latencies, 99);

    const latestRun = runs.length > 0 ? runs[0] : null;

    const monitorObj = monitor.toObject();
    monitorObj.headers = redactHeaders(monitorObj.headers);

    res.json({
      monitor: monitorObj,
      stats: {
        uptime: uptimePercentage,
        avgLatency,
        totalChecks: total,
        p50,
        p95,
        p99,
        lastLatency: latestRun?.latency || 0,
        lastStatus: latestRun?.status || 'pending',
        lastCheckTime: latestRun?.createdAt || monitor.lastCheck,
        lastStatusCode: latestRun?.statusCode || 0
      },
      history: runs,
      incidents,
    });

  } catch (error) {
    if (error instanceof TimeRangeError) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
};
