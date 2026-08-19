import type { IDbMetricFields } from '../../../models/Database';

// ============================================================================
// Database adapter contract.
// ----------------------------------------------------------------------------
// Every supported engine implements this interface. The scheduler stays
// engine-agnostic: it leases a due instance, decrypts its URI, and hands off to
// the matching adapter. Adapters own their own client lifecycle, because
// connection semantics differ wildly — a pooled MongoClient, a pg.Pool, a
// persistent Redis socket, and a connection-per-poll MySQL handle cannot share
// one policy without the scheduler learning all four.
//
// Mirrors worker/queue/adapters/types.ts deliberately: one pull-plane pattern
// across the product means one thing to learn.
// ============================================================================

export type DbType = 'mongodb' | 'postgresql' | 'mysql' | 'redis';

/**
 * What a monitored instance actually permits US to read.
 *
 * Enterprise deployments hand out least-privilege monitoring users, managed
 * providers block administrative commands outright, and optional statistics
 * modules are frequently not installed. Every one of those cases previously
 * surfaced as a chart full of zeros, which is indistinguishable from a healthy
 * idle database. Probing turns "we cannot see this" into a distinct, explained
 * state the UI can act on.
 */
export interface CapabilityState {
  available: boolean;
  /** Why it is unavailable, in the operator's terms. */
  reason?: string;
  /** The exact GRANT / extension / setting that would enable it. */
  remediation?: string;
}

export type CapabilityKey =
  | 'serverStats'     // core counters — everything else is decoration without it
  | 'storageStats'    // database-level size breakdown
  | 'collectionStats' // per-collection / per-table census
  | 'queryStats'      // normalized statement digests            (feeds P2)
  | 'slowLog'         // individual slow operations              (feeds P2)
  | 'indexStats'      // per-index usage and size                (feeds P3)
  | 'replication'     // topology and lag                        (feeds P4)
  | 'currentOps';     // in-flight operations                    (feeds P4)

/**
 * An ABSENT key means the capability does not apply to this engine (Redis has
 * no query planner, so `indexStats` is simply not part of its vocabulary). A
 * PRESENT key with `available: false` means it applies but is currently blocked,
 * and therefore has a remediation worth showing the operator. Collapsing the two
 * would put "enable this" prompts next to things that can never be enabled.
 */
export type Capabilities = Partial<Record<CapabilityKey, CapabilityState>>;

export const capable = (): CapabilityState => ({ available: true });

export const incapable = (reason: string, remediation?: string): CapabilityState => ({
  available: false,
  reason,
  remediation,
});

/** Per-collection / per-table census row. Shape matches DbCollectionStat. */
export interface CollectionStat {
  name: string;
  count: number;
  size: number;
  storageSize: number;
  indexSize: number;
}

/**
 * The metric document minus the fields the scheduler owns. Adapters describe
 * what they observed; persistence, retention stamping and identity are not
 * their concern.
 */
export type DbMetricInput = Omit<IDbMetricFields, 'dbId' | 'timestamp' | 'expiresAt'>;

export interface SampleContext {
  dbId: string;
  /** Decrypted connection string. Never logged, never persisted by an adapter. */
  uri: string;
  checkTime: Date;
  /** True when the hourly collection/table census is due this cycle. */
  censusDue: boolean;
  /** True when privileges should be re-probed this cycle. Probing costs extra
   *  round-trips against the monitored instance, so it runs on the census
   *  cadence rather than every poll — privileges change on the order of
   *  deployments, not minutes. */
  probeDue: boolean;
}

export interface DbSample {
  metric: DbMetricInput;
  /** Present only on census cycles; absent means "unchanged, do not overwrite". */
  collections?: CollectionStat[];
  /** Present only on probe cycles; absent means "unchanged, do not overwrite". */
  capabilities?: Capabilities;
  /** Live topology, where the engine exposes one. */
  topology?: TopologySnapshot;
  /** Engine version string, best-effort, for display. */
  version?: string;
}

export interface DbAdapter {
  type: DbType;
  /**
   * Validate connectivity and discover privileges. Throws when the instance is
   * unreachable; a reachable instance with restricted privileges resolves with
   * those restrictions described rather than failing.
   */
  probe(uri: string): Promise<Capabilities>;
  /**
   * One polling cycle. Throws only when the instance is unreachable — a single
   * unreadable statistic degrades that capability and leaves the rest intact.
   */
  sample(ctx: SampleContext): Promise<DbSample>;
  /** Release pooled clients for an instance that was deleted or reconfigured. */
  dispose(dbId: string): void | Promise<void>;
  /**
   * Collect query shapes and slow operations. Optional: an engine that
   * exposes no statement statistics simply omits it, and the scheduler skips
   * the cadence for that instance rather than special-casing engines.
   */
  collectInsights?(ctx: InsightContext): Promise<InsightSample>;
  /**
   * Enumerate indexes with their definitions, sizes and usage counters.
   * Optional for the same reason as collectInsights: Redis has no secondary
   * indexes, so it simply does not implement this.
   */
  collectIndexes?(ctx: InsightContext): Promise<IndexCensus>;
  /**
   * Read what is executing right now. Never persisted — this is a live view,
   * and storing in-flight queries would be storing customer data at rest for
   * no analytical benefit.
   */
  getCurrentOperations?(dbId: string, uri: string): Promise<CurrentOperation[]>;
}

/** Coerces anything numeric-ish to a number, with a caller-chosen fallback. */
export const safeNum = (val: any, fallback = 0): number => {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
};

/** Per-second rate between two cumulative counter readings. */
export const perSecond = (current: number, previous: number, seconds: number): number =>
  seconds > 0 ? Math.max(0, (current - previous) / seconds) : 0;

const BYTES_PER_MB = 1024 * 1024;
export const toMb = (bytes: any): number => safeNum(bytes) / BYTES_PER_MB;

// ---------------------------------------------------------------------------
// Query insights (P2). Collected on their own cadence, not every poll: digest
// tables are far more expensive to read than a counter snapshot, and the value
// of a five-minute resolution on query shapes is indistinguishable from a
// one-minute one.
// ---------------------------------------------------------------------------

export type QueryOperation =
  | 'select' | 'insert' | 'update' | 'delete' | 'aggregate' | 'command' | 'other';

/** One query shape's cost WITHIN the collection interval (a delta, not a total). */
export interface QueryStatSample {
  digestHash: string;
  /** Already normalized and redacted by the adapter. See ../redact.ts. */
  queryText: string;
  namespace?: string;
  operation: QueryOperation;
  executions: number;
  totalTimeMs: number;
  meanTimeMs: number;
  maxTimeMs: number;
  p95TimeMs?: number;
  rowsReturned?: number;
  rowsExamined?: number;
  examinedPerReturned?: number;
  blocksHit?: number;
  blocksRead?: number;
  tempBlocks?: number;
  planSummary?: string;
}

/** One individual operation that exceeded the slow threshold. */
export interface SlowOpSample {
  timestamp: Date;
  durationMs: number;
  operation: QueryOperation;
  namespace?: string;
  queryText: string;
  digestHash?: string;
  planSummary?: string;
  docsExamined?: number;
  docsReturned?: number;
  keysExamined?: number;
  source?: string;
}

export interface InsightSample {
  queryStats: QueryStatSample[];
  slowOps: SlowOpSample[];
}

export interface InsightContext {
  dbId: string;
  uri: string;
  /** Hard cap on shapes persisted per cycle, applied after ranking by cost. */
  maxDigests: number;
  /** Operations faster than this are not individually recorded. */
  slowMsThreshold: number;
}

export const EMPTY_INSIGHTS: InsightSample = { queryStats: [], slowOps: [] };

// ---------------------------------------------------------------------------
// Index census (P3). Collected hourly — index definitions and usage counters
// change on the order of deployments, not minutes.
// ---------------------------------------------------------------------------

export interface IndexSample {
  namespace: string;
  name: string;
  definition: string;
  /** Ordered key names. Prefix-redundancy analysis depends on this order. */
  keys: string[];
  unique: boolean;
  primary: boolean;
  partial: boolean;
  sizeBytes: number;
  /** Cumulative scans since the server started. */
  scans: number;
}

export interface IndexCensus {
  indexes: IndexSample[];
  /** Uptime at read time — "never used" means nothing without it. */
  serverUptimeSeconds: number;
}

export const EMPTY_INDEX_CENSUS: IndexCensus = { indexes: [], serverUptimeSeconds: 0 };

// ---------------------------------------------------------------------------
// Topology (P4). Structure changes rarely but matters urgently when it does
// (a failover, a standby falling away), so it rides the normal poll rather than
// a slow cadence — every engine here already fetches the underlying data for
// replication lag, so the marginal cost is close to zero.
// ---------------------------------------------------------------------------

export interface TopologyMember {
  /** host:port, slot name, or replica identifier — infrastructure, so redacted on public shares. */
  name: string;
  /** PRIMARY / SECONDARY / ARBITER / standby / replica / master. */
  role: string;
  /** Engine-reported state text. */
  state: string;
  healthy: boolean;
  lagMs?: number;
  lagBytes?: number;
  /** True for the node Senzor is connected to. */
  self?: boolean;
}

export interface TopologySnapshot {
  kind: 'standalone' | 'replicaset' | 'primary-replica' | 'cluster';
  members: TopologyMember[];
  /** Set when this instance is itself a replica/standby. */
  isReplica: boolean;
}

/** A live, unstored read of what is executing right now. */
export interface CurrentOperation {
  id: string;
  durationMs: number;
  operation: string;
  namespace?: string;
  /** Redacted before it leaves the adapter. */
  queryText: string;
  state?: string;
  waitingOn?: string;
  source?: string;
}
