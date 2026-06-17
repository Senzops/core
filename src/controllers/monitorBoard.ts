import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { MonitorBoard } from '../models/MonitorBoard';
import { Monitor, MonitorRun, MonitorIncident } from '../models/Monitor';
import { DashboardShare } from '../models/DashboardShare';
import { resolveTimeRange, getEffectiveRetention, TimeRangeError } from '../utils/timeRange';

const MAX_BOARDS_PER_WORKSPACE = 50;
const MAX_ITEMS_PER_BOARD = 60;
const STRIPE_BUCKETS = 60; // Availability stripe segments across the selected range.

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

/**
 * Batched summary for every monitor on a board. The availability stripe FOLLOWS
 * the selected time range: the range is divided into `STRIPE_BUCKETS` equal
 * segments and each segment is rolled up to its worst observed status (so the
 * stripe is consistent with the range-scoped uptime/latency stats above it).
 *
 * Cost stays bounded — a single grouped aggregation (≤ monitors × buckets rows,
 * no per-document fan-out), the registry docs, and one open-incident lookup —
 * regardless of how wide the range or how dense the checks.
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

    // The owner (NOT a public viewer) may request an explicit monitor set via
    // `?monitors=id1,id2` — this powers live previews of cards added in the
    // board's edit mode before the layout is saved. Tenant isolation is still
    // enforced by the ownerId-scoped Monitor.find below, so the override can
    // only ever surface the caller's own monitors. Public shares ignore it and
    // always render exactly the saved board.
    const overrideRaw = !isPublic && typeof req.query.monitors === 'string' ? req.query.monitors : '';
    const overrideIds = overrideRaw
      ? overrideRaw.split(',').map((s) => s.trim()).filter((i) => mongoose.isValidObjectId(i))
      : null;

    // Preserve ordering; drop any malformed ids.
    const orderedIds = (overrideIds && overrideIds.length
      ? overrideIds
      : (board.layout || []).map((n) => n.i)
    ).filter((i) => mongoose.isValidObjectId(i));

    if (orderedIds.length === 0) {
      return res.json({ monitors: [], bucketMs: 0, rangeStart: null, rangeEnd: null });
    }

    const objectIds = orderedIds.map((i) => new mongoose.Types.ObjectId(i));

    const maxRetention = await getEffectiveRetention('monitor', ownerId);
    const resolved = resolveTimeRange(
      { range: range as string | undefined, start: start as string | undefined, end: end as string | undefined },
      maxRetention
    );

    const startMs = resolved.startDate.getTime();
    const endMs = resolved.endDate.getTime();
    const bucketMs = Math.max(1000, Math.floor((endMs - startMs) / STRIPE_BUCKETS));

    const [monitors, bucketAgg, openIncidents] = await Promise.all([
      // Registry docs (current status, ssl/domain, interval, name, url).
      Monitor.find({ _id: { $in: objectIds }, ownerId }).lean(),

      // One pass: per monitor, per time bucket, roll up status counts + latency.
      MonitorRun.aggregate([
        { $match: { monitorId: { $in: objectIds }, createdAt: { $gte: resolved.startDate, $lte: resolved.endDate } } },
        {
          $group: {
            _id: {
              m: '$monitorId',
              b: {
                $min: [
                  STRIPE_BUCKETS - 1,
                  { $floor: { $divide: [{ $subtract: ['$createdAt', resolved.startDate] }, bucketMs] } },
                ],
              },
            },
            total: { $sum: 1 },
            upCount: { $sum: { $cond: [{ $eq: ['$status', 'up'] }, 1, 0] } },
            downCount: { $sum: { $cond: [{ $eq: ['$status', 'down'] }, 1, 0] } },
            timeoutCount: { $sum: { $cond: [{ $eq: ['$status', 'timeout'] }, 1, 0] } },
            latencySum: { $sum: '$latency' },
          },
        },
      ]),

      // Currently-open incidents across the board (one query).
      MonitorIncident.find({ monitorId: { $in: objectIds }, resolvedAt: null }).lean(),
    ]);

    const monitorMap = new Map(monitors.map((m: any) => [String(m._id), m]));

    // Group bucket rows by monitor.
    const bucketsByMonitor = new Map<string, any[]>();
    for (const row of bucketAgg) {
      const key = String(row._id.m);
      if (!bucketsByMonitor.has(key)) bucketsByMonitor.set(key, []);
      bucketsByMonitor.get(key)!.push(row);
    }

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
        const rows = bucketsByMonitor.get(mid) || [];

        // Fixed-length stripe, oldest → newest. null = no data in that window.
        const stripe: Array<null | { status: string; latency: number; count: number; t: number }> =
          Array(STRIPE_BUCKETS).fill(null);

        let total = 0;
        let upCount = 0;
        let latencySum = 0;

        for (const r of rows) {
          const idx = Math.max(0, Math.min(STRIPE_BUCKETS - 1, r._id.b));
          const status = r.downCount > 0 ? 'down' : r.timeoutCount > 0 ? 'timeout' : 'up';
          stripe[idx] = {
            status,
            latency: r.total ? Math.round(r.latencySum / r.total) : 0,
            count: r.total,
            t: startMs + idx * bucketMs,
          };
          total += r.total;
          upCount += r.upCount;
          latencySum += r.latencySum;
        }

        const uptime = total === 0 ? 100 : (upCount / total) * 100;
        const avgLatency = total === 0 ? 0 : latencySum / total;
        const open = incidentMap.get(mid) || null;

        return {
          monitorId: mid,
          name: m.name,
          // Omitted on public shares (customer-facing status page).
          url: isPublic ? undefined : m.url,
          interval: m.interval,
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
            totalChecks: total,
          },
          openIncident: open ? { startedAt: open.startedAt, cause: open.cause, statusCode: open.statusCode } : null,
          stripe,
        };
      });

    res.json({
      monitors: result,
      bucketMs,
      rangeStart: resolved.startDate,
      rangeEnd: resolved.endDate,
    });
  } catch (error) {
    if (error instanceof TimeRangeError) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
};
