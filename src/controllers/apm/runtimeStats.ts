import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { ApmService } from '../../models/Apm';
import { RuntimeMetric } from '../../models/RuntimeMetric';

// ---------------------------------------------------------------------------
// Runtime Metrics Stats Controller
//
// Returns time-series runtime health data for the APM dashboard:
//   - Event loop lag, utilization
//   - GC frequency and duration
//   - Heap memory usage
//   - CPU usage and process health
// ---------------------------------------------------------------------------

/** Zero-fill runtime metrics time series with empty data points. */
const fillRuntimeTimeGaps = (data: any[], range: string, startDate: Date) => {
  const filled = [];
  const now = new Date();
  const current = new Date(startDate);

  // Align to boundaries
  if (range === '1h') {
    current.setSeconds(0, 0);
    current.setMinutes(current.getMinutes() + 1);
  } else if (range === '24h') {
    current.setMinutes(0, 0, 0);
  } else {
    current.setHours(0, 0, 0, 0);
  }

  const end = new Date(now);
  const dataMap = new Map(data.map(item => [item.time, item]));

  const emptyPoint = {
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
  };

  while (current < end) {
    let key: string;
    if (range === '1h') key = current.toISOString().slice(0, 16) + ':00.000Z';
    else if (range === '24h') key = current.toISOString().slice(0, 13) + ':00:00.000Z';
    else key = current.toISOString().slice(0, 10);

    if (dataMap.has(key)) {
      filled.push(dataMap.get(key));
    } else {
      filled.push({ time: key, ...emptyPoint });
    }

    if (range === '1h') current.setMinutes(current.getMinutes() + 1);
    else if (range === '24h') current.setHours(current.getHours() + 1);
    else current.setDate(current.getDate() + 1);
  }

  return filled;
};

export const getRuntimeStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { uid } = (req as any).user;
    const { range } = req.query;

    // Verify ownership
    const service = await ApmService.findOne({ _id: id, ownerId: uid });
    if (!service) return res.status(404).json({ error: 'Service not found' });

    // Calculate date range
    const now = new Date();
    const startDate = new Date();

    if (range === '7d') startDate.setDate(now.getDate() - 7);
    else if (range === '30d') startDate.setDate(now.getDate() - 30);
    else if (range === '1h') startDate.setHours(now.getHours() - 1);
    else startDate.setHours(now.getHours() - 24);

    const serviceIdObj = new mongoose.Types.ObjectId(id as string);
    const matchQuery = { serviceId: serviceIdObj, timestamp: { $gte: startDate } };

    const [timeSeriesRaw, latestSnapshot] = await Promise.all([
      // Time-series aggregation
      RuntimeMetric.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: {
              $dateToString: {
                format: range === '1h' ? '%Y-%m-%dT%H:%M:00.000Z'
                  : (range === '30d' || range === '7d' ? '%Y-%m-%d' : '%Y-%m-%dT%H:00:00.000Z'),
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

    const timeSeries = fillRuntimeTimeGaps(
      timeSeriesRaw,
      (range as string) || '24h',
      startDate
    );

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
    next(error);
  }
};
