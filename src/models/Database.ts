import mongoose, { Schema, Document } from 'mongoose';
import { applyPlanBasedTtl } from '../utils/ttl';

// ============================================================================
// Database monitoring models.
// ----------------------------------------------------------------------------
// Three collections with distinct lifecycles:
//   DatabaseService  — the registered instance: config, status, capabilities
//   DbMetric         — the time series, plan-retained
//   DbCollectionStat — the hourly collection/table census, one doc per instance
//
// Descriptive facts that change rarely (eviction policy, replica role, engine)
// live on the service document, not in the time series. Stamping a string like
// "allkeys-lru" onto a sample every minute stores the same value thousands of
// times to answer a question that was never time-varying.
// ============================================================================

/** What a monitored instance permits us to read. See worker/database/adapters/types.ts. */
export interface ICapabilityState {
  available: boolean;
  reason?: string;
  remediation?: string;
}

/** Live replication topology, refreshed on every poll. */
export interface ITopologyMember {
  name: string;
  role: string;
  state: string;
  healthy: boolean;
  lagMs?: number;
  lagBytes?: number;
  self?: boolean;
}

export interface ITopology {
  kind: 'standalone' | 'replicaset' | 'primary-replica' | 'cluster';
  isReplica: boolean;
  members: ITopologyMember[];
}

/** Slow-moving configuration observed on the instance. */
export interface IInstanceFacts {
  role?: string;
  clusterEnabled?: boolean;
  maxConnections?: number;
  maxMemoryMb?: number;
  maxMemoryPolicy?: string;
  aofEnabled?: boolean;
  readOnly?: boolean;
  storageEngine?: string;
}

// --- 1. Database Service (Configuration) ---
export interface IDatabaseService extends Document {
  ownerId: string;
  name: string;
  type: 'mongodb' | 'postgresql' | 'mysql' | 'redis';
  encryptedUri: string;
  interval: number;
  status: 'online' | 'offline' | 'error';
  lastCheck?: Date;
  errorMessage?: string;
  version?: string;
  capabilities?: Record<string, ICapabilityState>;
  capabilitiesCheckedAt?: Date;
  instance?: IInstanceFacts;
  topology?: ITopology;
  topologyCheckedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CapabilityStateSchema = new Schema<ICapabilityState>({
  available: { type: Boolean, required: true },
  reason: { type: String },
  remediation: { type: String },
}, { _id: false });

const DatabaseServiceSchema = new Schema<IDatabaseService>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  type: { type: String, enum: ['mongodb', 'postgresql', 'mysql', 'redis'], required: true },
  encryptedUri: { type: String, required: true },
  interval: { type: Number, default: 5 },
  status: { type: String, enum: ['online', 'offline', 'error'], default: 'offline' },
  lastCheck: { type: Date },
  errorMessage: { type: String },
  version: { type: String },
  // Keyed by CapabilityKey. Map rather than a fixed shape so adding a probe in
  // a later phase needs no migration of existing service documents.
  capabilities: { type: Map, of: CapabilityStateSchema },
  capabilitiesCheckedAt: { type: Date },
  instance: {
    role: { type: String },
    clusterEnabled: { type: Boolean },
    maxConnections: { type: Number },
    maxMemoryMb: { type: Number },
    maxMemoryPolicy: { type: String },
    aofEnabled: { type: Boolean },
    readOnly: { type: Boolean },
    storageEngine: { type: String },
  },
  topology: {
    kind: { type: String },
    isReplica: { type: Boolean },
    members: [{
      name: String, role: String, state: String,
      healthy: Boolean, lagMs: Number, lagBytes: Number, self: Boolean,
      _id: false,
    }],
  },
  topologyCheckedAt: { type: Date },
}, { timestamps: true });

// --- 2. Database Metrics (Time Series) ---
// Split from the Document interface so adapters can describe a sample as plain
// data without inheriting Mongoose's instance surface.
export interface IDbMetricFields {
  dbId: mongoose.Types.ObjectId;
  timestamp: Date;
  expiresAt?: Date; // Plan-based TTL (anchor: timestamp)
  throughput: { read: number; write: number; total?: number };
  latency: { read: { avg: number; max: number }; write: { avg: number; max: number }; ping?: number };
  uptimeSeconds: number;
  connections: { current: number; available: number; totalCreated: number };
  /** Megabytes. */
  memory: { resident: number; virtual: number; mapped?: number };
  /** Bytes per second, except numRequests which is requests per second. */
  network: { bytesIn: number; bytesOut: number; numRequests: number };
  ops: { insert: number; query: number; update: number; delete: number; command: number };
  /**
   * Per-second rates. Previously these carried raw cumulative counters, which
   * made every chart a monotonically rising line that said nothing about the
   * current period.
   */
  scans: { collectionScans: number; indexScans: number };
  /** Megabytes. */
  storage: { dataSize: number; indexSize: number; storageSize: number; objects: number };
  locks?: { activeReaders: number; activeWriters: number; queuedReaders: number; queuedWriters: number };

  redis?: {
    keyspaceHits: number;
    keyspaceMisses: number;
    hitRate: number;
    evictedKeys: number;
    expiredKeys: number;
    usedMemoryPeak: number;
    fragmentationRatio: number;
    blockedClients: number;
    // --- enrichment ---
    memDatasetMb?: number;
    memOverheadMb?: number;
    memClientsMb?: number;
    /** Percent of maxmemory consumed; -1 when maxmemory is unset (no bound). */
    memoryUsedPercent?: number;
    rdbChangesSinceSave?: number;
    rdbLastBgsaveOk?: number;
    aofLastWriteOk?: number;
    connectedReplicas?: number;
    masterLinkUp?: number;
    masterReplOffsetLagBytes?: number;
    pubsubChannels?: number;
    commandsFailedRate?: number;
    commandsRejectedRate?: number;
  };

  sql?: {
    activeQueries: number;
    blockedQueries: number;
    deadlocks: number;
    cacheHitRate: number;
    tempBytesWritten: number;
    replicationLagMs: number;
    tableScans: number;
    indexScans: number;
    rowsReturned: number;
    rowsModified: number;
    transactionsCommitted: number;
    transactionsRolledBack: number;
    waitEvents: number;
    slowQueries: number;
  };

  /** MongoDB-only detail. */
  mongo?: {
    cacheUsedMb?: number;
    cacheDirtyMb?: number;
    cacheMaxMb?: number;
    /** Percent of the WiredTiger cache in use — the eviction-pressure signal. */
    cacheUsedPercent?: number;
    cacheEvictionsRate?: number;
    /** Remaining concurrent read/write slots. Zero means requests are queueing. */
    ticketsAvailableRead?: number;
    ticketsAvailableWrite?: number;
    cursorsOpen?: number;
    cursorsTimedOutRate?: number;
    assertsRate?: number;
    keysExaminedRate?: number;
    docsExaminedRate?: number;
    docsReturnedRate?: number;
    /** Documents examined per document returned. The index-health headline. */
    scanRatio?: number;
    scanAndOrderRate?: number;
    /** Seconds of history the oplog holds — the replica recovery budget. */
    oplogWindowSeconds?: number;
    replicationLagMs?: number;
  };

  /** PostgreSQL-only detail. */
  pg?: {
    checkpointsTimedRate?: number;
    checkpointsRequestedRate?: number;
    buffersCheckpointRate?: number;
    buffersCleanRate?: number;
    buffersBackendRate?: number;
    walBytesRate?: number;
    tempFilesRate?: number;
    deadTuples?: number;
    liveTuples?: number;
    /** Percent of the 2-billion transaction-ID budget consumed. */
    xidAgePercent?: number;
    idleInTransaction?: number;
    longestTransactionSeconds?: number;
    oldestAutovacuumAgeSeconds?: number;
    autovacuumWorkersActive?: number;
    replicationSlotLagBytes?: number;
  };

  /** MySQL / InnoDB-only detail. */
  mysql?: {
    /** Undo records awaiting purge. Growth means purge is falling behind. */
    historyListLength?: number;
    rowLockWaitsRate?: number;
    rowLockTimeAvgMs?: number;
    tmpDiskTablesRate?: number;
    threadCacheHitRate?: number;
    abortedConnectsRate?: number;
    tableCacheHitRate?: number;
    innodbLogWaitsRate?: number;
    openTables?: number;
  };
}

export interface IDbMetric extends IDbMetricFields, Document {
  dbId: mongoose.Types.ObjectId;
}

const DbMetricSchema = new Schema<IDbMetric>({
  dbId: { type: Schema.Types.ObjectId, ref: 'DatabaseService', required: true },
  timestamp: { type: Date, required: true },
  throughput: {
    read: { type: Number, default: 0 },
    write: { type: Number, default: 0 },
    total: { type: Number, default: 0 }
  },
  latency: {
    read: { avg: { type: Number, default: 0 }, max: { type: Number, default: 0 } },
    write: { avg: { type: Number, default: 0 }, max: { type: Number, default: 0 } },
    ping: { type: Number, default: 0 }
  },
  uptimeSeconds: { type: Number, default: 0 },
  connections: { current: { type: Number, default: 0 }, available: { type: Number, default: 0 }, totalCreated: { type: Number, default: 0 } },
  memory: { resident: { type: Number, default: 0 }, virtual: { type: Number, default: 0 }, mapped: { type: Number, default: 0 } },
  network: { bytesIn: { type: Number, default: 0 }, bytesOut: { type: Number, default: 0 }, numRequests: { type: Number, default: 0 } },
  ops: { insert: { type: Number, default: 0 }, query: { type: Number, default: 0 }, update: { type: Number, default: 0 }, delete: { type: Number, default: 0 }, command: { type: Number, default: 0 } },
  scans: { collectionScans: { type: Number, default: 0 }, indexScans: { type: Number, default: 0 } },
  storage: { dataSize: { type: Number, default: 0 }, indexSize: { type: Number, default: 0 }, storageSize: { type: Number, default: 0 }, objects: { type: Number, default: 0 } },
  locks: { activeReaders: { type: Number, default: 0 }, activeWriters: { type: Number, default: 0 }, queuedReaders: { type: Number, default: 0 }, queuedWriters: { type: Number, default: 0 } },

  // Redis Specifics
  redis: {
    keyspaceHits: { type: Number, default: 0 },
    keyspaceMisses: { type: Number, default: 0 },
    hitRate: { type: Number, default: 0 },
    evictedKeys: { type: Number, default: 0 },
    expiredKeys: { type: Number, default: 0 },
    usedMemoryPeak: { type: Number, default: 0 },
    fragmentationRatio: { type: Number, default: 0 },
    blockedClients: { type: Number, default: 0 },
    memDatasetMb: { type: Number },
    memOverheadMb: { type: Number },
    memClientsMb: { type: Number },
    memoryUsedPercent: { type: Number },
    rdbChangesSinceSave: { type: Number },
    rdbLastBgsaveOk: { type: Number },
    aofLastWriteOk: { type: Number },
    connectedReplicas: { type: Number },
    masterLinkUp: { type: Number },
    masterReplOffsetLagBytes: { type: Number },
    pubsubChannels: { type: Number },
    commandsFailedRate: { type: Number },
    commandsRejectedRate: { type: Number },
  },

  // SQL Specifics (PostgreSQL & MySQL)
  sql: {
    activeQueries: { type: Number, default: 0 },
    blockedQueries: { type: Number, default: 0 },
    deadlocks: { type: Number, default: 0 },
    cacheHitRate: { type: Number, default: 0 },
    tempBytesWritten: { type: Number, default: 0 },
    replicationLagMs: { type: Number, default: -1 },
    tableScans: { type: Number, default: 0 },
    indexScans: { type: Number, default: 0 },
    rowsReturned: { type: Number, default: 0 },
    rowsModified: { type: Number, default: 0 },
    transactionsCommitted: { type: Number, default: 0 },
    transactionsRolledBack: { type: Number, default: 0 },
    waitEvents: { type: Number, default: 0 },
    slowQueries: { type: Number, default: 0 }
  },

  // Engine-specific enrichment. All optional: an instance that does not expose
  // a statistic simply omits it, which the UI renders as "not available"
  // rather than as zero.
  mongo: {
    cacheUsedMb: { type: Number },
    cacheDirtyMb: { type: Number },
    cacheMaxMb: { type: Number },
    cacheUsedPercent: { type: Number },
    cacheEvictionsRate: { type: Number },
    ticketsAvailableRead: { type: Number },
    ticketsAvailableWrite: { type: Number },
    cursorsOpen: { type: Number },
    cursorsTimedOutRate: { type: Number },
    assertsRate: { type: Number },
    keysExaminedRate: { type: Number },
    docsExaminedRate: { type: Number },
    docsReturnedRate: { type: Number },
    scanRatio: { type: Number },
    scanAndOrderRate: { type: Number },
    oplogWindowSeconds: { type: Number },
    replicationLagMs: { type: Number },
  },

  pg: {
    checkpointsTimedRate: { type: Number },
    checkpointsRequestedRate: { type: Number },
    buffersCheckpointRate: { type: Number },
    buffersCleanRate: { type: Number },
    buffersBackendRate: { type: Number },
    walBytesRate: { type: Number },
    tempFilesRate: { type: Number },
    deadTuples: { type: Number },
    liveTuples: { type: Number },
    xidAgePercent: { type: Number },
    idleInTransaction: { type: Number },
    longestTransactionSeconds: { type: Number },
    oldestAutovacuumAgeSeconds: { type: Number },
    autovacuumWorkersActive: { type: Number },
    replicationSlotLagBytes: { type: Number },
  },

  mysql: {
    historyListLength: { type: Number },
    rowLockWaitsRate: { type: Number },
    rowLockTimeAvgMs: { type: Number },
    tmpDiskTablesRate: { type: Number },
    threadCacheHitRate: { type: Number },
    abortedConnectsRate: { type: Number },
    tableCacheHitRate: { type: Number },
    innodbLogWaitsRate: { type: Number },
    openTables: { type: Number },
  },
});

DbMetricSchema.index({ dbId: 1, timestamp: 1 });
// Plan-based retention (per-document expiresAt + hard-cap backstop on timestamp)
applyPlanBasedTtl(DbMetricSchema, 'timestamp');

// --- 3. Decoupled Collection Stats (1 doc per DB, Upserted) ---
export interface IDbCollectionStat extends Document {
  dbId: mongoose.Types.ObjectId;
  lastCheck: Date;
  collections: {
    name: string;
    count: number;
    size: number;
    storageSize: number;
    indexSize: number;
  }[];
}

const DbCollectionStatSchema = new Schema<IDbCollectionStat>({
  dbId: { type: Schema.Types.ObjectId, ref: 'DatabaseService', required: true, unique: true },
  lastCheck: { type: Date, required: true },
  collections: [{
    name: String,
    count: Number,
    size: Number,
    storageSize: Number,
    indexSize: Number
  }]
});

export const DatabaseService = mongoose.model<IDatabaseService>('DatabaseService', DatabaseServiceSchema);
export const DbMetric = mongoose.model<IDbMetric>('DbMetric', DbMetricSchema);
export const DbCollectionStat = mongoose.model<IDbCollectionStat>('DbCollectionStat', DbCollectionStatSchema);
