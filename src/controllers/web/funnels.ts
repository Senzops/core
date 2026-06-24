import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Website } from '../../models/Web';
import { Funnel, IFunnelStep } from '../../models/Funnel';
import { CreateFunnelSchema, UpdateFunnelSchema, FunnelAnalyzeQuerySchema } from '../../utils/validation';
import { resolveTimeRange, getEffectiveRetention, buildTimeRangeMeta, TimeRangeError } from '../../utils/timeRange';
import { analyzeFunnelSteps } from './funnelEngine';
import { cacheGet, cacheSet } from '../../lib/cache';
import { logger } from '../../utils/logger';

// Soft cap on saved funnels per website — guards against unbounded growth.
const MAX_FUNNELS_PER_SITE = 25;

// Resolve and authorize the website for the request owner.
const resolveSite = async (req: Request) => {
  const ownerId = (req as any).ownerId;
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id.trim())) return { error: 'Invalid website id' as const };
  const site = await Website.findOne({ _id: id.trim(), ownerId }).select('_id ownerId').lean();
  if (!site) return { error: 'Website not found' as const };
  return { ownerId, webId: id.trim(), site };
};

// --- Create ---
export const createFunnel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resolved = await resolveSite(req);
    if ('error' in resolved) {
      return res.status(resolved.error === 'Website not found' ? 404 : 400).json({ error: resolved.error });
    }

    const parsed = CreateFunnelSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid funnel', details: parsed.error.flatten().fieldErrors });
    }

    const count = await Funnel.countDocuments({ ownerId: resolved.ownerId, webId: resolved.webId });
    if (count >= MAX_FUNNELS_PER_SITE) {
      return res.status(402).json({ error: `Funnel limit reached (${MAX_FUNNELS_PER_SITE} per website).`, code: 'FUNNEL_LIMIT_EXCEEDED' });
    }

    const funnel = await Funnel.create({
      ownerId: resolved.ownerId,
      webId: resolved.webId,
      name: parsed.data.name,
      steps: parsed.data.steps,
    });

    res.status(201).json({ message: 'Funnel created', funnel });
  } catch (error) {
    next(error);
  }
};

// --- List (definitions only) ---
export const listFunnels = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resolved = await resolveSite(req);
    if ('error' in resolved) {
      return res.status(resolved.error === 'Website not found' ? 404 : 400).json({ error: resolved.error });
    }

    const funnels = await Funnel.find({ ownerId: resolved.ownerId, webId: resolved.webId })
      .sort({ createdAt: -1 })
      .lean();

    res.json(funnels);
  } catch (error) {
    next(error);
  }
};

// --- Update ---
export const updateFunnel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resolved = await resolveSite(req);
    if ('error' in resolved) {
      return res.status(resolved.error === 'Website not found' ? 404 : 400).json({ error: resolved.error });
    }

    const { funnelId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(funnelId)) return res.status(400).json({ error: 'Invalid funnel id' });

    const parsed = UpdateFunnelSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid funnel', details: parsed.error.flatten().fieldErrors });
    }

    const updated = await Funnel.findOneAndUpdate(
      { _id: funnelId, ownerId: resolved.ownerId, webId: resolved.webId },
      parsed.data,
      { new: true, runValidators: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: 'Funnel not found' });

    res.json({ message: 'Funnel updated', funnel: updated });
  } catch (error) {
    next(error);
  }
};

// --- Delete ---
export const deleteFunnel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resolved = await resolveSite(req);
    if ('error' in resolved) {
      return res.status(resolved.error === 'Website not found' ? 404 : 400).json({ error: resolved.error });
    }

    const { funnelId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(funnelId)) return res.status(400).json({ error: 'Invalid funnel id' });

    const deleted = await Funnel.findOneAndDelete({ _id: funnelId, ownerId: resolved.ownerId, webId: resolved.webId });
    if (!deleted) return res.status(404).json({ error: 'Funnel not found' });

    res.json({ message: 'Funnel deleted' });
  } catch (error) {
    next(error);
  }
};

// --- Analyze (compute conversion, cached) ---
export const analyzeFunnel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resolved = await resolveSite(req);
    if ('error' in resolved) {
      return res.status(resolved.error === 'Website not found' ? 404 : 400).json({ error: resolved.error });
    }

    const { funnelId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(funnelId)) return res.status(400).json({ error: 'Invalid funnel id' });

    const parsedQuery = FunnelAnalyzeQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json({ error: 'Invalid query', details: parsedQuery.error.flatten().fieldErrors });
    }
    const { range, start, end } = parsedQuery.data;

    const funnel = await Funnel.findOne({ _id: funnelId, ownerId: resolved.ownerId, webId: resolved.webId }).lean();
    if (!funnel) return res.status(404).json({ error: 'Funnel not found' });

    const maxRetention = await getEffectiveRetention('web', resolved.ownerId);
    const timeRange = resolveTimeRange({ range, start, end }, maxRetention);
    const meta = buildTimeRangeMeta(timeRange, maxRetention);

    const funnelMeta = { _id: funnel._id, name: funnel.name, steps: funnel.steps };

    // Cache key embeds the funnel's updatedAt so edits self-invalidate. Sliding
    // ranges bucket to the minute; explicit windows key on their bounds. Reads
    // and writes are fail-open (a Redis outage simply recomputes).
    const rangeKey = range
      ? `r:${range}:${Math.floor(Date.now() / 60000)}`
      : `c:${start}:${end}`;
    const cacheKey = `funnel:${funnelId}:${new Date(funnel.updatedAt).getTime()}:${rangeKey}`;

    const cached = await cacheGet(cacheKey);
    if (cached) {
      try {
        return res.json({ funnel: funnelMeta, timeRange: meta, cached: true, ...JSON.parse(cached) });
      } catch {
        /* fall through to recompute on malformed cache value */
      }
    }

    const computed = await analyzeFunnelSteps({
      webId: new mongoose.Types.ObjectId(resolved.webId),
      steps: funnel.steps as IFunnelStep[],
      startDate: timeRange.startDate,
      endDate: timeRange.endDate,
    });

    cacheSet(cacheKey, JSON.stringify(computed), 60).catch((e) =>
      logger.warn(`[Funnel] cache set failed: ${e?.message}`)
    );

    res.json({ funnel: funnelMeta, timeRange: meta, cached: false, ...computed });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};
