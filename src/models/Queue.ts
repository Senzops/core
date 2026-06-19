import mongoose, { Schema, Document } from 'mongoose';
import { applyPlanBasedTtl } from '../utils/ttl';

// ============================================================================
// Queue Monitoring (agentless, pull-plane)
// ----------------------------------------------------------------------------
// A first-class, standalone service type — independent of APM and Task. A user
// registers a broker connection (P1: BullMQ on Redis); a distributed poller
// samples queue state on an interval and writes time-series metrics. Execution
// data from @senzops/apm-node (when present) is optional enrichment only,
// correlated by (system, queueName) — never a dependency.
//
// Storage is two-tier: high-resolution `QueueMetric` samples with a short
// plan-based TTL, downsampled into hourly `QueueRollup` for long-range queries.
// `QueueSnapshot` holds the latest per-queue breakdown for fast list rendering.
// ============================================================================

export type QueueSystem = 'bullmq';
export const QUEUE_SYSTEMS: QueueSystem[] = ['bullmq'];

// --- 1. Queue Source (Configuration + Distributed Scheduler State) ---
export interface IQueueSource extends Document {
  ownerId: string;
  name: string;
  system: QueueSystem;
  encryptedUri: string;
  /** BullMQ key prefix on the Redis instance (default 'bull'). */
  prefix: string;
  /** Optional allowlist of queue names. Empty = auto-discover all queues. */
  queueFilter: string[];
  /** Poll cadence in minutes. */
  interval: number;
  status: 'online' | 'offline' | 'error';
  lastCheck?: Date;
  errorMessage?: string;
  version?: string;
  /** Number of queues observed on the last successful poll (for the UI). */
  discoveredQueues: number;

  // Distributed, lease-based scheduling. The poller claims a source by setting
  // `leasedBy`/`leaseExpiresAt` atomically, so polling shards across worker
  // replicas and never double-polls. Rates are derived from the last persisted
  // QueueMetric (not in-memory state), so this stays correct across restarts.
  nextPollAt: Date;
  leasedBy?: string;
  leaseExpiresAt?: Date;
  consecutiveFailures: number;
  backoffUntil?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const QueueSourceSchema = new Schema<IQueueSource>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  system: { type: String, enum: QUEUE_SYSTEMS, required: true },
  encryptedUri: { type: String, required: true },
  prefix: { type: String, default: 'bull' },
  queueFilter: { type: [String], default: [] },
  interval: { type: Number, default: 1, min: 1, max: 60 },
  status: { type: String, enum: ['online', 'offline', 'error'], default: 'offline' },
  lastCheck: { type: Date },
  errorMessage: { type: String },
  version: { type: String },
  discoveredQueues: { type: Number, default: 0 },

  nextPollAt: { type: Date, default: Date.now },
  leasedBy: { type: String },
  leaseExpiresAt: { type: Date },
  consecutiveFailures: { type: Number, default: 0 },
  backoffUntil: { type: Date }
}, { timestamps: true });

// Drives the poller's atomic claim query (due + unleased/expired-lease).
QueueSourceSchema.index({ nextPollAt: 1, leaseExpiresAt: 1 });

// --- Per-queue depth breakdown (shared shape) ---
export interface IQueueDepth {
  waiting: number;
  active: number;
  delayed: number;
  prioritized: number;
  waitingChildren: number;
  paused: number;
}

const QueueDepthSchema = {
  waiting: { type: Number, default: 0 },
  active: { type: Number, default: 0 },
  delayed: { type: Number, default: 0 },
  prioritized: { type: Number, default: 0 },
  waitingChildren: { type: Number, default: 0 },
  paused: { type: Number, default: 0 }
};

// --- 2. Queue Metric (High-Resolution Time Series, one doc per queue per poll) ---
export interface IQueueMetric extends Document {
  sourceId: mongoose.Types.ObjectId;
  queueName: string;
  timestamp: Date;
  expiresAt?: Date; // Plan-based TTL (anchor: timestamp)

  depth: IQueueDepth;
  /** Backlog awaiting processing: waiting + delayed + prioritized + waitingChildren. */
  pending: number;
  /** Dead-letter backlog — BullMQ jobs that exhausted their retries. */
  dlqDepth: number;
  oldestWaitingAgeMs: number;
  oldestDelayedAgeMs: number;
  consumerCount: number;
  isPaused: boolean;

  // Derived from the previous sample (stateless across restarts/replicas).
  // netRate < 0 means the backlog is draining. etaToEmptyMs is -1 when the
  // queue is empty or not draining (no meaningful projection).
  netRate: number;          // pending change, jobs/sec (signed)
  completedRate: number;    // best-effort throughput, jobs/sec
  failedRate: number;       // best-effort failure throughput, jobs/sec
  etaToEmptyMs: number;
}

const QueueMetricSchema = new Schema<IQueueMetric>({
  sourceId: { type: Schema.Types.ObjectId, ref: 'QueueSource', required: true, index: true },
  queueName: { type: String, required: true },
  timestamp: { type: Date, required: true },

  depth: QueueDepthSchema,
  pending: { type: Number, default: 0 },
  dlqDepth: { type: Number, default: 0 },
  oldestWaitingAgeMs: { type: Number, default: 0 },
  oldestDelayedAgeMs: { type: Number, default: 0 },
  consumerCount: { type: Number, default: 0 },
  isPaused: { type: Boolean, default: false },

  netRate: { type: Number, default: 0 },
  completedRate: { type: Number, default: 0 },
  failedRate: { type: Number, default: 0 },
  etaToEmptyMs: { type: Number, default: -1 }
});

// Primary access pattern: a queue's history within a time window.
QueueMetricSchema.index({ sourceId: 1, queueName: 1, timestamp: -1 });
// Plan-based retention (per-document expiresAt + hard-cap backstop on timestamp)
applyPlanBasedTtl(QueueMetricSchema, 'timestamp');

// --- 3. Queue Rollup (Hourly Downsample, long-range queries) ---
export interface IQueueRollup extends Document {
  sourceId: mongoose.Types.ObjectId;
  queueName: string;
  timestamp: Date; // Hour bucket
  expiresAt?: Date; // Plan-based TTL (anchor: timestamp)

  pendingAvg: number;
  pendingMax: number;
  activeAvg: number;
  delayedAvg: number;
  dlqDepthAvg: number;
  dlqDepthMax: number;
  oldestWaitingAgeMaxMs: number;
  consumerCountAvg: number;
  consumerCountMin: number;
  netRateAvg: number;
  completedRateAvg: number;
  failedRateAvg: number;
  samples: number; // raw samples aggregated into this bucket
}

const QueueRollupSchema = new Schema<IQueueRollup>({
  sourceId: { type: Schema.Types.ObjectId, ref: 'QueueSource', required: true },
  queueName: { type: String, required: true },
  timestamp: { type: Date, required: true },

  pendingAvg: { type: Number, default: 0 },
  pendingMax: { type: Number, default: 0 },
  activeAvg: { type: Number, default: 0 },
  delayedAvg: { type: Number, default: 0 },
  dlqDepthAvg: { type: Number, default: 0 },
  dlqDepthMax: { type: Number, default: 0 },
  oldestWaitingAgeMaxMs: { type: Number, default: 0 },
  consumerCountAvg: { type: Number, default: 0 },
  consumerCountMin: { type: Number, default: 0 },
  netRateAvg: { type: Number, default: 0 },
  completedRateAvg: { type: Number, default: 0 },
  failedRateAvg: { type: Number, default: 0 },
  samples: { type: Number, default: 0 }
});

QueueRollupSchema.index({ sourceId: 1, queueName: 1, timestamp: -1 }, { unique: true });
// Plan-based retention (per-document expiresAt + hard-cap backstop on timestamp)
applyPlanBasedTtl(QueueRollupSchema, 'timestamp');

// --- 4. Queue Snapshot (One doc per source, upserted — fast list rendering) ---
export interface IQueueSnapshotEntry {
  queueName: string;
  pending: number;
  active: number;
  dlqDepth: number;
  consumerCount: number;
  isPaused: boolean;
  oldestWaitingAgeMs: number;
  netRate: number;
}

export interface IQueueSnapshot extends Document {
  sourceId: mongoose.Types.ObjectId;
  lastCheck: Date;
  queues: IQueueSnapshotEntry[];
}

const QueueSnapshotSchema = new Schema<IQueueSnapshot>({
  sourceId: { type: Schema.Types.ObjectId, ref: 'QueueSource', required: true, unique: true },
  lastCheck: { type: Date, required: true },
  queues: [{
    queueName: String,
    pending: Number,
    active: Number,
    dlqDepth: Number,
    consumerCount: Number,
    isPaused: Boolean,
    oldestWaitingAgeMs: Number,
    netRate: Number
  }]
});

export const QueueSource = mongoose.model<IQueueSource>('QueueSource', QueueSourceSchema);
export const QueueMetric = mongoose.model<IQueueMetric>('QueueMetric', QueueMetricSchema);
export const QueueRollup = mongoose.model<IQueueRollup>('QueueRollup', QueueRollupSchema);
export const QueueSnapshot = mongoose.model<IQueueSnapshot>('QueueSnapshot', QueueSnapshotSchema);
