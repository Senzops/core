import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Website, WebEvent, WebEventData, WebMetric } from '../../models/Web';
import {
  resolveTimeRange,
  fillTimeGaps,
  getEffectiveRetention,
  buildTimeRangeMeta,
  TimeRangeError,
} from '../../utils/timeRange';
import { WebEventsQuerySchema } from '../../utils/validation';

const EVENT_TREND_DEFAULTS = { count: 0 };

/**
 * Custom Events explorer.
 *
 *   GET /web/:id/events            -> top event names + counts (from WebMetric)
 *   GET /web/:id/events?event=foo  -> + per-property value breakdown (WebEventData)
 *                                       + the event's count trend over the window
 *
 * The top-events list always uses the pre-aggregated WebMetric.events map (fast).
 * The property breakdown reads the typed WebEventData collection only when a
 * specific event is selected, so the firehose is never scanned unfiltered.
 */
export const getWebEvents = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const ownerId = (req as any).ownerId;

    const parsedQuery = WebEventsQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json({ error: 'Invalid query', details: parsedQuery.error.flatten().fieldErrors });
    }
    const { range, start, end, event } = parsedQuery.data;

    const cleanId = id.trim();
    if (!mongoose.Types.ObjectId.isValid(cleanId)) {
      return res.status(400).json({ error: 'Invalid website id' });
    }
    const webIdObj = new mongoose.Types.ObjectId(cleanId);

    const site = await Website.findOne({ _id: cleanId, ownerId });
    if (!site) return res.status(404).json({ error: 'Website not found' });

    const maxRetention = await getEffectiveRetention('web', ownerId);
    const resolved = resolveTimeRange({ range, start, end }, maxRetention);
    const { startDate, endDate, bucketFormat } = resolved;
    const timeMeta = buildTimeRangeMeta(resolved, maxRetention);

    const metricMatch = { webId: webIdObj, timestamp: { $gte: startDate, $lte: endDate } };

    // Top events — always returned, from the pre-aggregated metric maps.
    const topEvents = await WebMetric.aggregate([
      { $match: metricMatch },
      { $project: { d: { $objectToArray: '$events' } } },
      { $unwind: '$d' },
      { $group: { _id: '$d.k', count: { $sum: '$d.v' } } },
      { $sort: { count: -1 } },
      { $limit: 100 },
    ]);

    // No specific event selected — return the list only.
    if (!event) {
      return res.json({ timeRange: timeMeta, events: topEvents, selected: null, properties: [], trend: [] });
    }

    const rawEventMatch = { webId: webIdObj, type: 'event' as const, eventName: event, createdAt: { $gte: startDate, $lte: endDate } };

    const [propertiesRaw, trendRaw, uniqueVisitors] = await Promise.all([
      // Per-property value breakdown from typed WebEventData.
      WebEventData.aggregate([
        { $match: { webId: webIdObj, eventName: event, createdAt: { $gte: startDate, $lte: endDate } } },
        {
          $addFields: {
            value: {
              $switch: {
                branches: [
                  { case: { $eq: ['$dataType', 'number'] }, then: { $toString: '$numberValue' } },
                  { case: { $eq: ['$dataType', 'boolean'] }, then: { $toString: '$boolValue' } },
                  { case: { $eq: ['$dataType', 'date'] }, then: { $toString: '$dateValue' } },
                ],
                default: '$stringValue',
              },
            },
          },
        },
        { $group: { _id: { key: '$key', value: '$value' }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        {
          $group: {
            _id: '$_id.key',
            values: { $push: { value: '$_id.value', count: '$count' } },
            total: { $sum: '$count' },
          },
        },
        { $sort: { total: -1 } },
        { $project: { _id: 0, key: '$_id', total: 1, values: { $slice: ['$values', 50] } } },
      ]),

      // Event count trend over the window (raw, for accuracy across buckets).
      WebEvent.aggregate([
        { $match: rawEventMatch },
        { $group: { _id: { $dateToString: { format: bucketFormat, date: '$createdAt' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
        { $project: { time: '$_id', count: 1, _id: 0 } },
      ]),

      // Distinct visitors who triggered this event.
      WebEvent.distinct('visitorId', rawEventMatch),
    ]);

    const trend = fillTimeGaps(trendRaw, resolved, EVENT_TREND_DEFAULTS, 'time');
    const total = trendRaw.reduce((sum: number, b: any) => sum + (b.count || 0), 0);

    res.json({
      timeRange: timeMeta,
      events: topEvents,
      selected: event,
      summary: { total, uniqueVisitors: uniqueVisitors.length },
      properties: propertiesRaw,
      trend,
    });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};
