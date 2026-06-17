import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { MonitorBoard } from '../models/MonitorBoard';
import { Monitor, MonitorRun, MonitorIncident } from '../models/Monitor';
import { DashboardShare } from '../models/DashboardShare';
import { resolveTimeRange, getEffectiveRetention, TimeRangeError } from '../utils/timeRange';

const MAX_BOARDS_PER_WORKSPACE = 50;
const MAX_ITEMS_PER_BOARD = 60;
const STRIPE_LENGTH = 60; // "Last 60 checks" stripe, independent of selected range.

// react-grid-layout node ({ i, x, y, w, h }) where `i` is a Monitor _id.
const LayoutItemSchema = z.object({
  i: z.string().min(1),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(24),
});

const CreateBoardSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
});

const UpdateBoardSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    layout: z.array(LayoutItemSchema).max(MAX_ITEMS_PER_BOARD).optional(),
  })
  .refine((d) => d.name !== undefined || d.description !== undefined || d.layout !== undefined, {
    message: 'No updatable fields provided.',
  });

// ----------------------------------------------------------------------------
// Management (authenticated)
// ----------------------------------------------------------------------------

export const listBoards = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const boards = await MonitorBoard.find({ ownerId }).sort({ createdAt: -1 }).lean();
    const summary = boards.map((b) => ({
      _id: b._id,
      name: b.name,
      description: b.description || '',
      monitorCount: Array.isArray(b.layout) ? b.layout.length : 0,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    }));
    res.json({ boards: summary });
  } catch (error) {
    next(error);
  }
};

export const createBoard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const parsed = CreateBoardSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request.', details: parsed.error.flatten() });
    }

    const count = await MonitorBoard.countDocuments({ ownerId });
    if (count >= MAX_BOARDS_PER_WORKSPACE) {
      return res.status(409).json({
        error: `You have reached the maximum of ${MAX_BOARDS_PER_WORKSPACE} status boards. Delete one to create another.`,
        code: 'BOARD_LIMIT_REACHED',
      });
    }

    const board = await MonitorBoard.create({
      ownerId,
      name: parsed.data.name,
      description: parsed.data.description,
      layout: [],
    });
    res.status(201).json({ board });
  } catch (error) {
    next(error);
  }
};

export const getBoardById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(404).json({ error: 'Board not found' });

    const board = await MonitorBoard.findOne({ _id: id, ownerId }).lean();
    if (!board) return res.status(404).json({ error: 'Board not found' });

    res.json({ board });
  } catch (error) {
    next(error);
  }
};

export const updateBoard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const parsed = UpdateBoardSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request.', details: parsed.error.flatten() });
    }

    const update: Record<string, any> = {};
    if (parsed.data.name !== undefined) update.name = parsed.data.name;
    if (parsed.data.description !== undefined) update.description = parsed.data.description ?? '';
    if (parsed.data.layout !== undefined) update.layout = parsed.data.layout;

    const board = await MonitorBoard.findOneAndUpdate(
      { _id: id, ownerId },
      update,
      { new: true, runValidators: true }
    ).lean();
    if (!board) return res.status(404).json({ error: 'Board not found' });

    res.json({ board });
  } catch (error) {
    next(error);
  }
};

export const deleteBoard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const board = await MonitorBoard.findOneAndDelete({ _id: id, ownerId });
    if (!board) return res.status(404).json({ error: 'Board not found' });

    // CASCADE: tear down any public share links pointing at this board.
    await DashboardShare.deleteMany({ scopeType: 'monitorboard', scopeId: id, ownerId });

    res.json({ success: true, message: 'Board deleted.' });
  } catch (error) {
    next(error);
  }
};

// ----------------------------------------------------------------------------
// Summary (authenticated + re-used on the public share path)
// ----------------------------------------------------------------------------

const getPercentile = (sortedAsc: number[], p: number): number => {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, idx)];
};

/**
 * Batched, lightweight summary for every monitor on a board. One range
 * aggregation for uptime/latency, capped per-monitor stripe queries (last 60
 * checks, indexed by monitorId), and a single open-incident lookup — so the
 * whole board costs a small, bounded number of queries regardless of range.
 *
 * Re-used unchanged on the public share path: when `req.share` is present the
 * monitor's target URL is omitted so a customer-facing status page never leaks
 * internal endpoints.
 */
export const getBoardSummary = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const { range, start, end } = req.query;
    const isPublic = !!(req as any).share;

    if (!mongoose.isValidObjectId(id)) return res.status(404).json({ error: 'Board not found' });

    const board = await MonitorBoard.findOne({ _id: id, ownerId }).lean();
    if (!board) return res.status(404).json({ error: 'Board not found' });

    // Preserve board ordering; drop any malformed ids.
    const orderedIds = (board.layout || [])
      .map((n) => n.i)
      .filter((i) => mongoose.isValidObjectId(i));

    if (orderedIds.length === 0) {
      return res.json({ monitors: [] });
    }

    const objectIds = orderedIds.map((i) => new mongoose.Types.ObjectId(i));

    const maxRetention = await getEffectiveRetention('monitor', ownerId);
    const resolved = resolveTimeRange(
      { range: range as string | undefined, start: start as string | undefined, end: end as string | undefined },
      maxRetention
    );

    const [monitors, statsAgg, stripes, openIncidents] = await Promise.all([
      // Registry docs (current status, ssl/domain, interval, name, url).
      Monitor.find({ _id: { $in: objectIds }, ownerId }).lean(),

      // Range stats: uptime% + avg latency per monitor (no document fan-out).
      MonitorRun.aggregate([
        { $match: { monitorId: { $in: objectIds }, createdAt: { $gte: resolved.startDate, $lte: resolved.endDate } } },
        {
          $group: {
            _id: '$monitorId',
            total: { $sum: 1 },
            upCount: { $sum: { $cond: [{ $eq: ['$status', 'up'] }, 1, 0] } },
            latencySum: { $sum: '$latency' },
          },
        },
      ]),

      // Last-60 check stripe per monitor (bounded, monitorId-indexed).
      Promise.all(
        objectIds.map((mid) =>
          MonitorRun.find({ monitorId: mid })
            .sort({ createdAt: -1 })
            .limit(STRIPE_LENGTH)
            .select('status latency statusCode createdAt')
            .lean()
        )
      ),

      // Currently-open incidents across the board (one query).
      MonitorIncident.find({ monitorId: { $in: objectIds }, resolvedAt: null }).lean(),
    ]);

    const monitorMap = new Map(monitors.map((m: any) => [String(m._id), m]));
    const statsMap = new Map(statsAgg.map((s: any) => [String(s._id), s]));
    const stripeMap = new Map<string, any[]>();
    objectIds.forEach((mid, idx) => stripeMap.set(String(mid), stripes[idx]));
    const incidentMap = new Map<string, any>();
    for (const inc of openIncidents) {
      const key = String(inc.monitorId);
      const existing = incidentMap.get(key);
      // Keep the earliest open incident (the active outage start).
      if (!existing || new Date(inc.startedAt) < new Date(existing.startedAt)) {
        incidentMap.set(key, inc);
      }
    }

    const result = orderedIds
      .filter((mid) => monitorMap.has(mid))
      .map((mid) => {
        const m: any = monitorMap.get(mid);
        const s: any = statsMap.get(mid);
        const stripe = (stripeMap.get(mid) || []).map((r) => ({
          status: r.status,
          latency: r.latency,
          statusCode: r.statusCode,
          createdAt: r.createdAt,
        }));
        const open = incidentMap.get(mid) || null;

        const total = s?.total || 0;
        const uptime = total === 0 ? 100 : (s.upCount / total) * 100;
        const avgLatency = total === 0 ? 0 : s.latencySum / total;
        // p95 from the bounded recent stripe sample (keeps the summary query cost
        // flat — exact full-range percentiles live on the per-monitor detail page).
        const recentLatencies = stripe.map((r) => r.latency).sort((a: number, b: number) => a - b);
        const p95 = getPercentile(recentLatencies, 95);

        const latest = stripe[0] || null;

        return {
          monitorId: mid,
          name: m.name,
          // Omitted on public shares (customer-facing status page).
          url: isPublic ? undefined : m.url,
          interval: m.interval,
          method: m.method,
          status: m.status,
          lastDownAt: m.lastDownAt || null,
          createdAt: m.createdAt,
          lastCheck: m.lastCheck || null,
          ssl: {
            valid: m.ssl?.valid ?? false,
            daysRemaining: m.ssl?.daysRemaining ?? -1,
            validTo: m.ssl?.validTo ?? null,
            lastCheckedAt: m.ssl?.lastCheckedAt ?? null,
            error: m.ssl?.error ?? null,
          },
          domain: {
            daysRemaining: m.domain?.daysRemaining ?? -1,
            expiresAt: m.domain?.expiresAt ?? null,
            lastCheckedAt: m.domain?.lastCheckedAt ?? null,
            error: m.domain?.error ?? null,
          },
          stats: {
            uptime,
            avgLatency,
            p95,
            totalChecks: total,
            lastLatency: latest?.latency ?? 0,
            lastStatus: latest?.status ?? m.status ?? 'pending',
            lastStatusCode: latest?.statusCode ?? 0,
          },
          openIncident: open ? { startedAt: open.startedAt, cause: open.cause, statusCode: open.statusCode } : null,
          // Chronological for the stripe (oldest → newest is applied client-side).
          stripe,
        };
      });

    res.json({ monitors: result });
  } catch (error) {
    if (error instanceof TimeRangeError) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
};
