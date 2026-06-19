import type { QueueSystem } from '../../../models/Queue';

// ============================================================================
// Broker adapter contract.
// ----------------------------------------------------------------------------
// Every supported queue system implements this interface. The poller stays
// broker-agnostic: it leases a source, decrypts its connection config, and
// hands off to the matching adapter. Adapters own their own client lifecycle
// (pooling/teardown) so connection semantics that differ wildly between brokers
// — a persistent Redis socket vs. a stateless HTTP call vs. a Kafka admin
// client — never leak into the scheduler.
// ============================================================================

/** A single point-in-time observation of one queue / topic / consumer-group. */
export interface QueueSample {
  queueName: string;
  depth: {
    waiting: number;
    active: number;
    delayed: number;
    prioritized: number;
    waitingChildren: number;
    paused: number;
  };
  /** Universal backlog metric: work awaiting processing (or consumer lag). */
  pending: number;
  /** Dead-letter backlog where the broker exposes one. */
  dlqDepth: number;
  completed: number;
  oldestWaitingAgeMs: number;
  oldestDelayedAgeMs: number;
  consumerCount: number;
  isPaused: boolean;
  // Throughput (jobs/sec). Adapters provide EITHER a direct rate the broker
  // exposes (completedRate/failedRate), OR a cumulative *processed* counter
  // (processedTotal), OR a cumulative *produced/incoming* counter
  // (incomingTotal). The poller derives rates from whichever is present:
  //   completedRate          → used directly
  //   processedTotal delta   → completedRate
  //   incomingTotal delta    → completedRate ≈ incomingRate − backlogGrowth
  // Leave all undefined when the broker offers no reliable throughput signal.
  completedRate?: number;
  failedRate?: number;
  processedTotal?: number;
  incomingTotal?: number;
}

export interface SampleResult {
  samples: QueueSample[];
  /** How many queues the adapter saw (pre-cap), for the UI + truncation notice. */
  discovered: number;
  truncated: boolean;
  /** Broker version string, best-effort, for display. */
  version?: string;
}

export interface TestResult {
  version?: string;
  discoveredQueues: number;
  truncated: boolean;
  /** Adapter-resolved connection value to persist (e.g. the auto-detected
   *  BullMQ prefix when the configured one matched nothing). */
  effectivePrefix?: string;
}

export interface SampleOpts {
  /** Allowlist of queue/topic/group names. Empty = auto-discover. */
  queueFilter: string[];
  /** Hard cap on entities sampled per source per cycle. */
  maxQueues: number;
}

export interface QueueAdapter {
  system: QueueSystem;
  /** Validate connectivity at registration / config change. Throws on failure. */
  testConnection(config: any): Promise<TestResult>;
  /** Sample current state. Must not throw for a single bad queue — skip it. */
  sample(sourceId: string, config: any, opts: SampleOpts): Promise<SampleResult>;
  /** Release any pooled client for a source that was deleted or reconfigured. */
  dispose(sourceId: string): void | Promise<void>;
}

export const DEFAULT_MAX_QUEUES = 250;

/** Build a zeroed depth object; adapters fill in the dimensions that apply. */
export const emptyDepth = () => ({
  waiting: 0,
  active: 0,
  delayed: 0,
  prioritized: 0,
  waitingChildren: 0,
  paused: 0
});
