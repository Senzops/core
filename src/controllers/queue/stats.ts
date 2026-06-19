import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { QueueSource, QueueMetric, QueueRollup, QueueSnapshot } from '../../models/Queue';
import { resolveTimeRange, getEffectiveRetention, buildTimeRangeMeta, TimeRangeError } from '../../utils/timeRange';

// Beyond this span we serve hourly rollups instead of raw 1-min samples, so
// long-range queries stay fast and cheap regardless of poll cardinality.
const RAW_TIER_MAX_MS = 24 * 60 * 60 * 1000;

export const getQueueStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const ownerId = (req as any).ownerId;
    const { range, start, end, queue } = req.query;

    // apiKey is never needed by the stats consumer; exclude it everywhere.
    const source: any = await QueueSource.findOne({ _id: id, ownerId })
      .select('-encryptedConfig -leasedBy -leaseExpiresAt -apiKey')
      .lean();
    if (!source) return res.status(404).json({ error: 'Queue source not found' });

    // On the PUBLIC share path, also strip non-secret-but-sensitive config so a
    // share link never exposes broker hostnames, AWS access-key-ids, usernames,
    // or the management deep-link.
    if ((req as any).share) {
      delete source.connectionMeta;
      delete source.managementUrl;
    }

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

    // Pick the queue to chart: explicit ?queue=, else the deepest backlog.
    const requested = typeof queue === 'string' && queue.length > 0 ? queue : undefined;
    const selectedQueue = requested
      || [...queues].sort((a, b) => (b.pending + b.dlqDepth) - (a.pending + a.dlqDepth))[0]?.queueName;

    let history: any[] = [];
    let latest: any = {};

    if (selectedQueue) {
      const spanMs = endDate.getTime() - startDate.getTime();
      const useRollup = spanMs > RAW_TIER_MAX_MS;

      const matchQuery = {
        sourceId: new mongoose.Types.ObjectId(id),
        queueName: selectedQueue,
        timestamp: { $gte: startDate, $lte: endDate }
      };

      const groupStage = useRollup
        ? {
            _id: { $dateToString: { format: bucketFormat, date: '$timestamp' } },
            pending: { $avg: '$pendingAvg' },
            pendingMax: { $max: '$pendingMax' },
            active: { $avg: '$activeAvg' },
            delayed: { $avg: '$delayedAvg' },
            dlqDepth: { $avg: '$dlqDepthAvg' },
            dlqDepthMax: { $max: '$dlqDepthMax' },
            oldestWaitingAgeMs: { $max: '$oldestWaitingAgeMaxMs' },
            consumerCount: { $avg: '$consumerCountAvg' },
            netRate: { $avg: '$netRateAvg' }
          }
        : {
            _id: { $dateToString: { format: bucketFormat, date: '$timestamp' } },
            pending: { $avg: '$pending' },
            pendingMax: { $max: '$pending' },
            active: { $avg: '$depth.active' },
            delayed: { $avg: '$depth.delayed' },
            dlqDepth: { $avg: '$dlqDepth' },
            dlqDepthMax: { $max: '$dlqDepth' },
            oldestWaitingAgeMs: { $max: '$oldestWaitingAgeMs' },
            consumerCount: { $avg: '$consumerCount' },
            netRate: { $avg: '$netRate' }
          };

      const Model: any = useRollup ? QueueRollup : QueueMetric;

      [history, latest] = await Promise.all([
        Model.aggregate([
          { $match: matchQuery },
          { $group: groupStage },
          { $sort: { _id: 1 } },
          {
            $project: {
              _id: 0,
              time: '$_id',
              pending: 1, pendingMax: 1, active: 1, delayed: 1,
              dlqDepth: 1, dlqDepthMax: 1, oldestWaitingAgeMs: 1,
              consumerCount: 1, netRate: 1
            }
          }
        ]),
        QueueMetric.findOne({ sourceId: id, queueName: selectedQueue }).sort({ timestamp: -1 }).lean()
      ]);
    }

    res.json({
      source,
      timeRange: meta,
      resolution: (endDate.getTime() - startDate.getTime()) > RAW_TIER_MAX_MS ? 'hourly' : 'raw',
      totals,
      queues,
      selectedQueue: selectedQueue || null,
      latest: latest || {},
      history
    });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};
