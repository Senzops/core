import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { ApmService } from '../../models/Apm';
import { RuntimeMetric } from '../../models/RuntimeMetric';
import { resolveTimeRange, fillTimeGaps, getEffectiveRetention, TimeRangeError } from '../../utils/timeRange';

// ---------------------------------------------------------------------------
// Runtime Metrics Stats Controller
//
// Returns time-series runtime health data for the APM dashboard:
//   - Event loop lag, utilization
//   - GC frequency and duration
//   - Heap memory usage
//   - CPU usage and process health
// ---------------------------------------------------------------------------

/** Default zero-values for empty runtime metric time-series buckets. */
const RUNTIME_METRIC_DEFAULTS = {
  eventLoopLagMs: 0,
  eventLoopLagP50Ms: 0,
  eventLoopLagP99Ms: 0,
  eventLoopUtilizationPercent: 0,
  gcTotalDurationMs: 0,
  gcTotalCount: 0,
  gcMajorCount: 0,
  gcMinorCount: 0,
  heapUsedBytes: 0,
  heapTotalBytes: 0,
  heapUsedPercent: 0,
  rssBytes: 0,
  activeHandles: 0,
  activeRequests: 0,
  cpuUserUs: 0,
  cpuSystemUs: 0,
  uptimeSeconds: 0,
} as const;

export const getRuntimeStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const ownerId = (req as any).ownerId;
    const { range, start, end } = req.query;

    // Verify ownership
    const service = await ApmService.findOne({ _id: id, ownerId });
    if (!service) return res.status(404).json({ error: 'Service not found' });

    // Resolve time range via centralized utility
    const maxRetention = await getEffectiveRetention('apm', ownerId);
    const resolved = resolveTimeRange(
      { range: range as string | undefined, start: start as string | undefined, end: end as string | undefined },
      maxRetention
    );

    const serviceIdObj = new mongoose.Types.ObjectId(id as string);
    const matchQuery = {
      serviceId: serviceIdObj,
      timestamp: { $gte: resolved.startDate, $lte: resolved.endDate },
    };

    const [timeSeriesRaw, latestSnapshot] = await Promise.all([
      // Time-series aggregation with dynamic bucket format
      RuntimeMetric.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: {
              $dateToString: {
                format: resolved.bucketFormat,
                date: '$timestamp',
              },
            },

            // Event loop: take max lag within bucket
            eventLoopLagMs: { $max: '$eventLoopLagMs' },
            eventLoopLagP50Ms: { $max: '$eventLoopLagP50Ms' },
            eventLoopLagP99Ms: { $max: '$eventLoopLagP99Ms' },
            eventLoopUtilizationPercent: { $avg: '$eventLoopUtilizationPercent' },

            // GC: sum within bucket
            gcTotalDurationMs: { $sum: '$gcTotalDurationMs' },
            gcTotalCount: { $sum: '$gcTotalCount' },
            gcMajorCount: { $sum: '$gcMajorCount' },
            gcMinorCount: { $sum: '$gcMinorCount' },

            // Memory: take max (peak) within bucket
            heapUsedBytes: { $max: '$heapUsedBytes' },
            heapTotalBytes: { $max: '$heapTotalBytes' },
            heapUsedPercent: { $max: '$heapUsedPercent' },
            rssBytes: { $max: '$rssBytes' },

            // Process: take max
            activeHandles: { $max: '$activeHandles' },
            activeRequests: { $max: '$activeRequests' },
            cpuUserUs: { $sum: '$cpuUserUs' },
            cpuSystemUs: { $sum: '$cpuSystemUs' },
            uptimeSeconds: { $max: '$uptimeSeconds' },
          },
        },
        { $sort: { _id: 1 } },
        {
          $project: {
            time: '$_id',
            eventLoopLagMs: 1,
            eventLoopLagP50Ms: 1,
            eventLoopLagP99Ms: 1,
            eventLoopUtilizationPercent: { $round: ['$eventLoopUtilizationPercent', 2] },
            gcTotalDurationMs: 1,
            gcTotalCount: 1,
            gcMajorCount: 1,
            gcMinorCount: 1,
            heapUsedBytes: 1,
            heapTotalBytes: 1,
            heapUsedPercent: { $round: ['$heapUsedPercent', 2] },
            rssBytes: 1,
            activeHandles: 1,
            activeRequests: 1,
            cpuUserUs: 1,
            cpuSystemUs: 1,
            uptimeSeconds: 1,
          },
        },
      ]),

      // Latest snapshot for "current" values
      RuntimeMetric.findOne({ serviceId: serviceIdObj })
        .sort({ timestamp: -1 })
        .lean(),
    ]);

    const timeSeries = fillTimeGaps(timeSeriesRaw, resolved, RUNTIME_METRIC_DEFAULTS);

    // Build current overview from latest snapshot
    const current = latestSnapshot
      ? {
          eventLoopLagMs: latestSnapshot.eventLoopLagMs,
          eventLoopLagP99Ms: latestSnapshot.eventLoopLagP99Ms,
          eventLoopUtilizationPercent: latestSnapshot.eventLoopUtilizationPercent,
          heapUsedBytes: latestSnapshot.heapUsedBytes,
          heapTotalBytes: latestSnapshot.heapTotalBytes,
          heapUsedPercent: latestSnapshot.heapUsedPercent,
          rssBytes: latestSnapshot.rssBytes,
          activeHandles: latestSnapshot.activeHandles,
          uptimeSeconds: latestSnapshot.uptimeSeconds,
        }
      : null;

    res.json({
      current,
      timeSeries,
    });
  } catch (error) {
    if (error instanceof TimeRangeError) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
};
