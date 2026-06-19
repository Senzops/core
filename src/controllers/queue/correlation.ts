import { Request, Response, NextFunction } from 'express';
import { QueueSource, QueueSnapshot } from '../../models/Queue';
import { TaskService, TaskRun } from '../../models/Task';
import { resolveTimeRange, getEffectiveRetention, TimeRangeError } from '../../utils/timeRange';

// ============================================================================
// Push ↔ pull convergence.
// ----------------------------------------------------------------------------
// The pull plane (QueueMetric, from broker polling) tells you a queue's backlog;
// the push plane (TaskRun, from @senzops/apm-node instrumented consumers) tells
// you *why* — processing time, failures, dead-letters, and the trace behind each
// job. They're joined by (ownerId, queueName): a BullMQ consumer reports
// `metadata.queueName` on every run, which equals the broker-side queue name.
//
// This is enrichment only — it never gates the queue product. When no
// instrumented consumer exists for a queue, the panels simply stay empty.
// Execution data belongs to a *different* service, so it is exposed on the
// authenticated dashboard only, never through a public queue share link.
// ============================================================================

/**
 * Recent instrumented executions + a rollup for a single queue, correlated from
 * the owner's Task telemetry. Powers the "what's draining this queue" panel.
 */
export const getQueueExecutions = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const ownerId = (req as any).ownerId;
    const { queue, range, start, end } = req.query;

    const source = await QueueSource.findOne({ _id: id, ownerId }).select('_id').lean();
    if (!source) return res.status(404).json({ error: 'Queue source not found' });

    if (!queue || typeof queue !== 'string') {
      return res.json({ summary: null, recent: [], correlated: false });
    }

    const maxRetention = await getEffectiveRetention('queue', ownerId);
    const { startDate, endDate } = resolveTimeRange(
      { range: range as string, start: start as string, end: end as string },
      maxRetention
    );

    // Resolve the owner's instrumented task services (the push-plane producers).
    const taskServices = await TaskService.find({ ownerId }).select('_id name').lean();
    if (taskServices.length === 0) {
      return res.json({ summary: null, recent: [], correlated: false });
    }
    const svcIds = taskServices.map(s => s._id);
    const svcNameById = new Map(taskServices.map(s => [s._id.toString(), s.name]));

    const match = {
      serviceId: { $in: svcIds },
      'metadata.queueName': queue,
      timestamp: { $gte: startDate, $lte: endDate }
    };

    const [summaryAgg, recent] = await Promise.all([
      TaskRun.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            runs: { $sum: 1 },
            failures: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
            deadLetters: { $sum: { $cond: ['$isDeadLetter', 1, 0] } },
            avgDuration: { $avg: '$duration' },
            maxDuration: { $max: '$duration' },
            avgQueueDelay: { $avg: '$queueDelay' }
          }
        }
      ]),
      TaskRun.find(match)
        .sort({ timestamp: -1 })
        .limit(20)
        .select('runId serviceId taskName status duration queueDelay attempts isDeadLetter timestamp triggerTraceId')
        .lean()
    ]);

    const s = summaryAgg[0];
    const summary = s
      ? {
          runs: s.runs,
          failures: s.failures,
          deadLetters: s.deadLetters,
          failureRate: s.runs ? s.failures / s.runs : 0,
          avgDurationMs: s.avgDuration || 0,
          maxDurationMs: s.maxDuration || 0,
          avgQueueDelayMs: s.avgQueueDelay || 0
        }
      : null;

    const recentMapped = recent.map(r => ({
      runId: r.runId,
      serviceId: r.serviceId,
      serviceName: svcNameById.get(r.serviceId.toString()) || 'Unknown',
      taskName: r.taskName,
      status: r.status,
      duration: r.duration,
      queueDelay: r.queueDelay,
      attempts: r.attempts,
      isDeadLetter: r.isDeadLetter,
      timestamp: r.timestamp,
      triggerTraceId: r.triggerTraceId
    }));

    res.json({ summary, recent: recentMapped, correlated: summary !== null });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};

/**
 * Queues seen in the owner's instrumented workers (last 7d) that are NOT yet
 * covered by any registered queue source — i.e. "you're running these, want to
 * monitor them?" auto-discovery suggestions.
 */
export const getDiscoveredQueues = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;

    const taskServices = await TaskService.find({ ownerId }).select('_id').lean();
    if (taskServices.length === 0) return res.json({ discovered: [] });
    const svcIds = taskServices.map(s => s._id);

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const seen = await TaskRun.aggregate([
      {
        $match: {
          serviceId: { $in: svcIds },
          taskType: 'queue',
          timestamp: { $gte: since },
          'metadata.queueName': { $exists: true, $ne: null }
        }
      },
      { $group: { _id: '$metadata.queueName', runs: { $sum: 1 }, lastSeen: { $max: '$timestamp' } } },
      { $sort: { runs: -1 } },
      { $limit: 100 }
    ]);

    // Exclude queues already covered by a registered source's latest snapshot.
    const sources = await QueueSource.find({ ownerId }).select('_id').lean();
    const monitored = new Set<string>();
    if (sources.length > 0) {
      const snapshots = await QueueSnapshot.find({ sourceId: { $in: sources.map(s => s._id) } })
        .select('queues.queueName')
        .lean();
      for (const snap of snapshots) {
        for (const q of snap.queues || []) monitored.add(q.queueName);
      }
    }

    const discovered = seen
      .filter(n => n._id && !monitored.has(n._id))
      .map(n => ({ queueName: n._id, runs: n.runs, lastSeen: n.lastSeen }));

    res.json({ discovered });
  } catch (error) {
    next(error);
  }
};
