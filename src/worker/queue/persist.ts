import { QueueMetric, QueueSnapshot, IQueueSnapshotEntry } from '../../models/Queue';
import { getRetentionMs, stampExpiry } from '../../services/retentionCache';
import { QueueSample } from './adapters';

// ============================================================================
// Shared sample-persistence layer.
// ----------------------------------------------------------------------------
// Both the agentless poller and the collector-push ingest endpoint converge
// here: given a source and a set of QueueSamples, write the time-series metrics
// and snapshot, deriving rates statelessly from the previously persisted
// snapshot. Keeping this in one place means push and pull produce identical
// data — the same QueueMetric shape, the same rate math.
// ============================================================================

/**
 * Net backlog rate (signed jobs/sec), drain ETA, and throughput — all derived
 * statelessly from the previous persisted snapshot. Throughput precedence: a
 * broker-provided direct rate wins; otherwise it's derived from the delta of a
 * cumulative processed counter. Neither present ⇒ 0.
 */
export const computeRates = (
  sample: QueueSample,
  prev: IQueueSnapshotEntry | undefined,
  elapsedSec: number
): { netRate: number; etaToEmptyMs: number; completedRate: number; failedRate: number } => {
  let netRate = 0;
  let etaToEmptyMs = -1;
  if (prev && elapsedSec > 0) {
    netRate = (sample.pending - prev.pending) / elapsedSec;
    etaToEmptyMs = netRate < 0 && sample.pending > 0
      ? Math.round((sample.pending / -netRate) * 1000)
      : -1;
  }

  let completedRate = sample.completedRate ?? 0;
  const failedRate = sample.failedRate ?? 0;

  if (sample.completedRate === undefined && elapsedSec > 0) {
    if (sample.processedTotal !== undefined && prev?.processedTotal !== undefined) {
      // Direct cumulative processed counter (e.g. Kafka committed offsets).
      completedRate = Math.max(0, (sample.processedTotal - prev.processedTotal) / elapsedSec);
    } else if (
      sample.incomingTotal !== undefined &&
      prev?.incomingTotal !== undefined &&
      sample.incomingTotal >= prev.incomingTotal // guard against counter resets
    ) {
      // Only a cumulative *produced* counter is available (BullMQ id counter):
      // over the interval, processed = produced − backlog growth.
      const incomingRate = (sample.incomingTotal - prev.incomingTotal) / elapsedSec;
      completedRate = Math.max(0, incomingRate - netRate);
    }
  }

  return { netRate, etaToEmptyMs, completedRate, failedRate };
};

/** Write QueueMetric docs + refresh the QueueSnapshot for a source's samples. */
export const persistQueueSamples = async (source: any, samples: QueueSample[]): Promise<void> => {
  const now = new Date();

  const prevSnapshot = await QueueSnapshot.findOne({ sourceId: source._id }).lean();
  const prevByQueue = new Map<string, IQueueSnapshotEntry>(
    (prevSnapshot?.queues || []).map(q => [q.queueName, q])
  );
  const prevTimeMs = prevSnapshot?.lastCheck ? new Date(prevSnapshot.lastCheck).getTime() : 0;
  const elapsedSec = prevTimeMs > 0 ? Math.max(1, (now.getTime() - prevTimeMs) / 1000) : 0;

  const retentionMs = await getRetentionMs(source.ownerId);

  const metricDocs: any[] = [];
  const snapshotEntries: IQueueSnapshotEntry[] = [];

  for (const sample of samples) {
    const prev = prevByQueue.get(sample.queueName);
    const { netRate, etaToEmptyMs, completedRate, failedRate } = computeRates(sample, prev, elapsedSec);

    metricDocs.push({
      sourceId: source._id,
      queueName: sample.queueName,
      timestamp: now,
      depth: sample.depth,
      pending: sample.pending,
      dlqDepth: sample.dlqDepth,
      oldestWaitingAgeMs: sample.oldestWaitingAgeMs,
      oldestDelayedAgeMs: sample.oldestDelayedAgeMs,
      consumerCount: sample.consumerCount,
      isPaused: sample.isPaused,
      netRate,
      completedRate,
      failedRate,
      etaToEmptyMs
    });

    snapshotEntries.push({
      queueName: sample.queueName,
      pending: sample.pending,
      active: sample.depth.active,
      dlqDepth: sample.dlqDepth,
      consumerCount: sample.consumerCount,
      isPaused: sample.isPaused,
      oldestWaitingAgeMs: sample.oldestWaitingAgeMs,
      netRate,
      processedTotal: sample.processedTotal,
      incomingTotal: sample.incomingTotal
    });
  }

  if (metricDocs.length > 0) {
    stampExpiry(metricDocs, 'timestamp', retentionMs);
    await QueueMetric.insertMany(metricDocs, { ordered: false });
  }

  await QueueSnapshot.updateOne(
    { sourceId: source._id },
    { $set: { lastCheck: now, queues: snapshotEntries } },
    { upsert: true }
  );
};
