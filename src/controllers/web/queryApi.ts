import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { WebEvent, WebMetric } from '../../models/Web';
import { computeWebOverview } from './webStatsFiltered';
import { resolveTimeRange, getEffectiveRetention, buildTimeRangeMeta, TimeRangeError } from '../../utils/timeRange';
import { toCsv } from '../../utils/toCsv';

// Public breakdown dimension -> WebMetric map field.
const DIMENSION_FIELD: Record<string, string> = {
  path: 'paths',
  referrer: 'referrers',
  channel: 'channels',
  country: 'countries',
  region: 'regions',
  city: 'cities',
  browser: 'browsers',
  os: 'os',
  device: 'devices',
  language: 'languages',
  screen: 'screens',
  event: 'events',
  utm_source: 'utmSources',
  utm_medium: 'utmMediums',
  utm_campaign: 'utmCampaigns',
};

interface ApiContext { webId: string; ownerId: string; }

// Resolves the query window from the request, scoped to the key's owner.
const resolveWindow = async (req: Request, ctx: ApiContext) => {
  const { range, start, end } = req.query as Record<string, string>;
  const maxRetention = await getEffectiveRetention('web', ctx.ownerId);
  const tr = resolveTimeRange({ range, start, end }, maxRetention);
  return { ...tr, meta: buildTimeRangeMeta(tr, maxRetention), webIdObj: new mongoose.Types.ObjectId(ctx.webId) };
};

const wantsCsv = (req: Request) => String(req.query.format || '').toLowerCase() === 'csv';

const sendCsv = (res: Response, filename: string, rows: Record<string, any>[], columns: string[]) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  res.send(toCsv(rows, columns));
};

// GET /api/v1/web/overview
export const apiOverview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = (req as any).webApiContext as ApiContext;
    const { startDate, endDate, meta, webIdObj } = await resolveWindow(req, ctx);
    const overview = await computeWebOverview(webIdObj, startDate, endDate);
    res.json({ timeRange: meta, overview });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};

// GET /api/v1/web/timeseries
export const apiTimeseries = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = (req as any).webApiContext as ApiContext;
    const { startDate, endDate, bucketFormat, meta, webIdObj } = await resolveWindow(req, ctx);

    const series = await WebEvent.aggregate([
      { $match: { webId: webIdObj, type: 'pageview', createdAt: { $gte: startDate, $lte: endDate } } },
      {
        $group: {
          _id: { $dateToString: { format: bucketFormat, date: '$createdAt' } },
          views: { $sum: 1 },
          visitors: { $addToSet: '$visitorId' },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, time: '$_id', views: 1, visitors: { $size: '$visitors' } } },
    ]);

    if (wantsCsv(req)) return sendCsv(res, 'timeseries', series, ['time', 'views', 'visitors']);
    res.json({ timeRange: meta, series });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};

// GET /api/v1/web/breakdown?dimension=...
export const apiBreakdown = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = (req as any).webApiContext as ApiContext;
    const dimension = String(req.query.dimension || '');
    const field = DIMENSION_FIELD[dimension];
    if (!field) {
      return res.status(400).json({ error: 'Invalid or missing dimension.', validDimensions: Object.keys(DIMENSION_FIELD) });
    }
    const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 50, 1), 500);

    const { startDate, endDate, meta, webIdObj } = await resolveWindow(req, ctx);

    const rows = await WebMetric.aggregate([
      { $match: { webId: webIdObj, timestamp: { $gte: startDate, $lte: endDate } } },
      { $project: { d: { $objectToArray: `$${field}` } } },
      { $unwind: '$d' },
      { $group: { _id: '$d.k', count: { $sum: '$d.v' } } },
      { $sort: { count: -1 } },
      { $limit: limit },
      { $project: { _id: 0, name: '$_id', count: 1 } },
    ]);

    if (wantsCsv(req)) return sendCsv(res, `breakdown-${dimension}`, rows, ['name', 'count']);
    res.json({ timeRange: meta, dimension, results: rows });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};

// GET /api/v1/web/events
export const apiEvents = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = (req as any).webApiContext as ApiContext;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 100, 1), 500);
    const { startDate, endDate, meta, webIdObj } = await resolveWindow(req, ctx);

    const rows = await WebMetric.aggregate([
      { $match: { webId: webIdObj, timestamp: { $gte: startDate, $lte: endDate } } },
      { $project: { d: { $objectToArray: '$events' } } },
      { $unwind: '$d' },
      { $group: { _id: '$d.k', count: { $sum: '$d.v' } } },
      { $sort: { count: -1 } },
      { $limit: limit },
      { $project: { _id: 0, name: '$_id', count: 1 } },
    ]);

    if (wantsCsv(req)) return sendCsv(res, 'events', rows, ['name', 'count']);
    res.json({ timeRange: meta, events: rows });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};
