import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { QueueSource, QueueMetric, QueueRollup, QueueSnapshot } from '../../models/Queue';
import { resolveTimeRange, getEffectiveRetention, buildTimeRangeMeta, TimeRangeError } from '../../utils/timeRange';

// Beyond this span we serve hourly rollups instead of raw 1-min samples, so
// long-range queries stay fast and cheap regardless of poll cardinality.
const RAW_TIER_MAX_MS = 24 * 60 * 60 * 1000;

const stripSharePrivate = (req: Request, source: any) => {
  // On the PUBLIC share path, never expose broker hostnames, access-key-ids,
  // usernames, or the management deep-link.
  if ((req as any).share && source) {
    delete source.connectionMeta;
    delete source.managementUrl;
  }
  return source;
};

// ─── Source overview: one stat set + OVERALL (across-all-queues) time-series ──
export const getQueueStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const ownerId = (req as any).ownerId;
    const { range, start, end } = req.query;

    const source: any = await QueueSource.findOne({ _id: id, ownerId })
      .select('-encryptedConfig -leasedBy -leaseExpiresAt -apiKey')
      .lean();
    if (!source) return res.status(404).json({ error: 'Queue source not found' });
    stripSharePrivate(req, source);

    const maxRetention = await getEffectiveRetention('queue', ownerId);
    const resolved = resolveTimeRange(
      { range: range as string, start: start as string, end: end as string },
      maxRetention
    );
    const { startDate, endDate, bucketFormat } = resolved;
    const meta = buildTimeRangeMeta(resolved, maxRetention);

    // Current per-queue state (and source-level totals) from the latest snapshot.
    const snapshot = await QueueSnapshot.findOne({ sourceId: id }).lean();
    const queues = snapshot?.queues || [];
    const totals = queues.reduce(
      (acc, q) => {
        acc.pending += q.pending || 0;
        acc.active += q.active || 0;
        acc.dlqDepth += q.dlqDepth || 0;
        acc.consumers += q.consumerCount || 0;
        return acc;
      },
      { pending: 0, active: 0, dlqDepth: 0, consumers: 0, queueCount: queues.length }
    );

    // Overall time-series: sum each metric across all queues within a bucket.
    const spanMs = endDate.getTime() - startDate.getTime();
    const useRollup = spanMs > RAW_TIER_MAX_MS;
    const Model: any = useRollup ? QueueRollup : QueueMetric;
    const f = (rollupField: string, rawField: string) => (useRollup ? `$${rollupField}` : `$${rawField}`);

    const history = await Model.aggregate([
      { $match: { sourceId: new mongoose.Types.ObjectId(id), timestamp: { $gte: startDate, $lte: endDate } } },
      {
        $group: {
          _id: { $dateToString: { format: bucketFormat, date: '$timestamp' } },
          pending: { $sum: f('pendingAvg', 'pending') },
          dlqDepth: { $sum: f('dlqDepthAvg', 'dlqDepth') },
          active: { $sum: f('activeAvg', 'depth.active') },
          consumerCount: { $sum: f('consumerCountAvg', 'consumerCount') },
          completedRate: { $sum: f('completedRateAvg', 'completedRate') },
          failedRate: { $sum: f('failedRateAvg', 'failedRate') }
        }
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, time: '$_id', pending: 1, dlqDepth: 1, active: 1, consumerCount: 1, completedRate: 1, failedRate: 1 } }
    ]);

    res.json({
      source,
      timeRange: meta,
      resolution: useRollup ? 'hourly' : 'raw',
      totals,
      queues,
      history
    });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};

// ─── Per-queue entity detail: one queue's current state + time-series ─────────
export const getQueueEntityDetail = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, queueName: rawName } = req.params;
    const ownerId = (req as any).ownerId;
    const { range, start, end } = req.query;
    const queueName = decodeURIComponent(rawName);

    const source: any = await QueueSource.findOne({ _id: id, ownerId })
      .select('-encryptedConfig -leasedBy -leaseExpiresAt -apiKey')
      .lean();
    if (!source) return res.status(404).json({ error: 'Queue source not found' });
    stripSharePrivate(req, source);

    const maxRetention = await getEffectiveRetention('queue', ownerId);
    const resolved = resolveTimeRange(
      { range: range as string, start: start as string, end: end as string },
      maxRetention
    );
    const { startDate, endDate, bucketFormat } = resolved;
    const meta = buildTimeRangeMeta(resolved, maxRetention);

    const spanMs = endDate.getTime() - startDate.getTime();
    const useRollup = spanMs > RAW_TIER_MAX_MS;
    const Model: any = useRollup ? QueueRollup : QueueMetric;

    const matchQuery = {
      sourceId: new mongoose.Types.ObjectId(id),
      queueName,
      timestamp: { $gte: startDate, $lte: endDate }
    };

    const groupStage = useRollup
      ? {
          _id: { $dateToString: { format: bucketFormat, date: '$timestamp' } },
          pending: { $avg: '$pendingAvg' },
          active: { $avg: '$activeAvg' },
          delayed: { $avg: '$delayedAvg' },
          dlqDepth: { $avg: '$dlqDepthAvg' },
          oldestWaitingAgeMs: { $max: '$oldestWaitingAgeMaxMs' },
          consumerCount: { $avg: '$consumerCountAvg' },
          netRate: { $avg: '$netRateAvg' },
          completedRate: { $avg: '$completedRateAvg' },
          failedRate: { $avg: '$failedRateAvg' }
        }
      : {
          _id: { $dateToString: { format: bucketFormat, date: '$timestamp' } },
          pending: { $avg: '$pending' },
          active: { $avg: '$depth.active' },
          delayed: { $avg: '$depth.delayed' },
          dlqDepth: { $avg: '$dlqDepth' },
          oldestWaitingAgeMs: { $max: '$oldestWaitingAgeMs' },
          consumerCount: { $avg: '$consumerCount' },
          netRate: { $avg: '$netRate' },
          completedRate: { $avg: '$completedRate' },
          failedRate: { $avg: '$failedRate' }
        };

    const [history, latest] = await Promise.all([
      Model.aggregate([
        { $match: matchQuery },
        { $group: groupStage },
        { $sort: { _id: 1 } },
        {
          $project: {
            _id: 0, time: '$_id',
            pending: 1, active: 1, delayed: 1, dlqDepth: 1,
            oldestWaitingAgeMs: 1, consumerCount: 1, netRate: 1, completedRate: 1, failedRate: 1
          }
        }
      ]),
      QueueMetric.findOne({ sourceId: id, queueName }).sort({ timestamp: -1 }).lean()
    ]);

    if (!latest && history.length === 0) {
      return res.status(404).json({ error: 'Queue not found for this source' });
    }

    res.json({
      source: { _id: source._id, name: source.name, system: source.system, mode: source.mode, managementUrl: source.managementUrl },
      queueName,
      timeRange: meta,
      resolution: useRollup ? 'hourly' : 'raw',
      latest: latest || {},
      history
    });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};
