import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { DatabaseService, DbMetric, DbCollectionStat } from '../../models/Database';
import { resolveTimeRange, getEffectiveRetention, buildTimeRangeMeta, TimeRangeError } from '../../utils/timeRange';
import { buildHealthReport } from '../../services/dbAdvisor';

// ----------------------------------------------------------------------------
// Time-series projection.
//
// Declared as a table rather than three parallel hand-written stage bodies. The
// previous version repeated every field name in $group and again in $project,
// which is where a new metric silently goes missing: add it to one list, forget
// the other, and the chart renders empty with nothing to explain it.
//
// `max` is used for gauges (a peak within the bucket is the interesting value)
// and `avg` for rates; `sum` for counted events that should total across the
// bucket rather than be averaged down.
// ----------------------------------------------------------------------------
type Agg = 'avg' | 'max' | 'sum';

const SERIES: Record<string, [Agg, string]> = {
  // Throughput
  throughputRead: ['avg', '$throughput.read'],
  throughputWrite: ['avg', '$throughput.write'],
  throughputTotal: ['avg', '$throughput.total'],
  // Latency
  latencyReadAvg: ['avg', '$latency.read.avg'],
  latencyReadMax: ['max', '$latency.read.max'],
  latencyWriteAvg: ['avg', '$latency.write.avg'],
  latencyWriteMax: ['max', '$latency.write.max'],
  latencyPing: ['avg', '$latency.ping'],
  // Memory
  memResident: ['avg', '$memory.resident'],
  memVirtual: ['avg', '$memory.virtual'],
  memMapped: ['avg', '$memory.mapped'],
  // Scans
  scansCollection: ['avg', '$scans.collectionScans'],
  scansIndex: ['avg', '$scans.indexScans'],
  // Storage
  storageData: ['avg', '$storage.dataSize'],
  storageIndex: ['avg', '$storage.indexSize'],
  storageTotal: ['avg', '$storage.storageSize'],
  storageObjects: ['max', '$storage.objects'],
  // Locks
  locksAR: ['max', '$locks.activeReaders'],
  locksAW: ['max', '$locks.activeWriters'],
  locksQR: ['max', '$locks.queuedReaders'],
  locksQW: ['max', '$locks.queuedWriters'],
  // Network & connections
  connections: ['max', '$connections.current'],
  connectionsAvailable: ['max', '$connections.available'],
  netIn: ['avg', '$network.bytesIn'],
  netOut: ['avg', '$network.bytesOut'],
  netRequests: ['avg', '$network.numRequests'],

  // --- Redis ---
  redisHits: ['avg', '$redis.keyspaceHits'],
  redisMisses: ['avg', '$redis.keyspaceMisses'],
  redisHitRate: ['avg', '$redis.hitRate'],
  redisEvicted: ['avg', '$redis.evictedKeys'],
  redisExpired: ['avg', '$redis.expiredKeys'],
  redisMemPeak: ['max', '$redis.usedMemoryPeak'],
  redisFragRatio: ['avg', '$redis.fragmentationRatio'],
  redisBlockedClients: ['max', '$redis.blockedClients'],
  redisMemDataset: ['avg', '$redis.memDatasetMb'],
  redisMemOverhead: ['avg', '$redis.memOverheadMb'],
  redisMemClients: ['avg', '$redis.memClientsMb'],
  redisMemoryUsedPercent: ['max', '$redis.memoryUsedPercent'],
  redisConnectedReplicas: ['max', '$redis.connectedReplicas'],
  redisMasterLagBytes: ['max', '$redis.masterReplOffsetLagBytes'],
  redisPubsubChannels: ['max', '$redis.pubsubChannels'],
  redisCommandsFailed: ['avg', '$redis.commandsFailedRate'],
  redisCommandsRejected: ['avg', '$redis.commandsRejectedRate'],
  redisChangesSinceSave: ['max', '$redis.rdbChangesSinceSave'],

  // --- Shared SQL ---
  sqlActiveQueries: ['avg', '$sql.activeQueries'],
  sqlBlockedQueries: ['avg', '$sql.blockedQueries'],
  sqlDeadlocks: ['sum', '$sql.deadlocks'],
  sqlCacheHitRate: ['avg', '$sql.cacheHitRate'],
  sqlTempBytes: ['avg', '$sql.tempBytesWritten'],
  sqlReplicationLag: ['avg', '$sql.replicationLagMs'],
  sqlTableScans: ['avg', '$sql.tableScans'],
  sqlIndexScans: ['avg', '$sql.indexScans'],
  sqlRowsReturned: ['avg', '$sql.rowsReturned'],
  sqlRowsModified: ['avg', '$sql.rowsModified'],
  sqlTxCommitted: ['avg', '$sql.transactionsCommitted'],
  sqlTxRolledBack: ['avg', '$sql.transactionsRolledBack'],
  sqlWaitEvents: ['avg', '$sql.waitEvents'],
  sqlSlowQueries: ['sum', '$sql.slowQueries'],

  // --- MongoDB ---
  mongoCacheUsed: ['avg', '$mongo.cacheUsedMb'],
  mongoCacheDirty: ['avg', '$mongo.cacheDirtyMb'],
  mongoCacheMax: ['max', '$mongo.cacheMaxMb'],
  mongoCacheUsedPercent: ['max', '$mongo.cacheUsedPercent'],
  mongoCacheEvictions: ['avg', '$mongo.cacheEvictionsRate'],
  mongoTicketsRead: ['max', '$mongo.ticketsAvailableRead'],
  mongoTicketsWrite: ['max', '$mongo.ticketsAvailableWrite'],
  mongoCursorsOpen: ['max', '$mongo.cursorsOpen'],
  mongoCursorsTimedOut: ['avg', '$mongo.cursorsTimedOutRate'],
  mongoAsserts: ['avg', '$mongo.assertsRate'],
  mongoKeysExamined: ['avg', '$mongo.keysExaminedRate'],
  mongoDocsExamined: ['avg', '$mongo.docsExaminedRate'],
  mongoDocsReturned: ['avg', '$mongo.docsReturnedRate'],
  mongoScanRatio: ['max', '$mongo.scanRatio'],
  mongoScanAndOrder: ['avg', '$mongo.scanAndOrderRate'],
  mongoOplogWindow: ['max', '$mongo.oplogWindowSeconds'],
  mongoReplicationLag: ['max', '$mongo.replicationLagMs'],

  // --- PostgreSQL ---
  pgCheckpointsTimed: ['avg', '$pg.checkpointsTimedRate'],
  pgCheckpointsRequested: ['avg', '$pg.checkpointsRequestedRate'],
  pgBuffersCheckpoint: ['avg', '$pg.buffersCheckpointRate'],
  pgBuffersClean: ['avg', '$pg.buffersCleanRate'],
  pgBuffersBackend: ['avg', '$pg.buffersBackendRate'],
  pgWalBytes: ['avg', '$pg.walBytesRate'],
  pgTempFiles: ['avg', '$pg.tempFilesRate'],
  pgDeadTuples: ['max', '$pg.deadTuples'],
  pgLiveTuples: ['max', '$pg.liveTuples'],
  pgXidAgePercent: ['max', '$pg.xidAgePercent'],
  pgIdleInTransaction: ['max', '$pg.idleInTransaction'],
  pgLongestTransaction: ['max', '$pg.longestTransactionSeconds'],
  pgOldestAutovacuum: ['max', '$pg.oldestAutovacuumAgeSeconds'],
  pgAutovacuumWorkers: ['max', '$pg.autovacuumWorkersActive'],
  pgSlotLagBytes: ['max', '$pg.replicationSlotLagBytes'],

  // --- MySQL ---
  mysqlHistoryList: ['max', '$mysql.historyListLength'],
  mysqlRowLockWaits: ['avg', '$mysql.rowLockWaitsRate'],
  mysqlRowLockTimeAvg: ['avg', '$mysql.rowLockTimeAvgMs'],
  mysqlTmpDiskTables: ['avg', '$mysql.tmpDiskTablesRate'],
  mysqlThreadCacheHitRate: ['avg', '$mysql.threadCacheHitRate'],
  mysqlAbortedConnects: ['avg', '$mysql.abortedConnectsRate'],
  mysqlTableCacheHitRate: ['avg', '$mysql.tableCacheHitRate'],
  mysqlLogWaits: ['avg', '$mysql.innodbLogWaitsRate'],
  mysqlOpenTables: ['max', '$mysql.openTables'],
};

const buildGroupStage = (bucketFormat: string) => {
  const group: Record<string, any> = {
    _id: { $dateToString: { format: bucketFormat, date: '$timestamp' } },
  };
  for (const [key, [op, field]] of Object.entries(SERIES)) {
    group[key] = { [`$${op}`]: field };
  }
  return group;
};

const buildProjectStage = () => {
  const project: Record<string, any> = { _id: 0, time: '$_id' };
  for (const key of Object.keys(SERIES)) project[key] = 1;
  return project;
};

/**
 * Topology member names are host:port of the customer's own infrastructure.
 * A shared status page should show that a replica is lagging without also
 * publishing where that replica lives, so names are replaced with positional
 * labels while roles, states and lag — the parts that carry the meaning —
 * survive intact.
 */
const redactTopology = (topology: any) => {
  if (!topology?.members?.length) return topology;
  return {
    ...topology,
    members: topology.members.map((m: any, i: number) => ({
      ...m,
      name: m.self ? 'this node' : `${m.role || 'member'} ${i + 1}`,
    })),
  };
};

/**
 * `capabilities` is schema'd as a Mongoose Map so new probes need no migration.
 * JSON.stringify renders a Map as `{}`, so it has to be converted explicitly —
 * serialising the document directly would silently ship an empty object.
 */
const capabilitiesToObject = (value: unknown): Record<string, any> => {
  if (value instanceof Map) return Object.fromEntries(value);
  return (value as Record<string, any>) || {};
};

export const getDatabaseStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const ownerId = (req as any).ownerId;
    const { range, start, end } = req.query;

    const db = await DatabaseService.findOne({ _id: id, ownerId }).select('-encryptedUri');
    if (!db) return res.status(404).json({ error: "Database not found" });

    const maxRetention = await getEffectiveRetention('database', ownerId);
    const resolved = resolveTimeRange(
      { range: range as string, start: start as string, end: end as string },
      maxRetention
    );
    const { startDate, endDate, bucketFormat } = resolved;
    const meta = buildTimeRangeMeta(resolved, maxRetention);

    const matchQuery = { dbId: new mongoose.Types.ObjectId(id), timestamp: { $gte: startDate, $lte: endDate } };

    const [latestMetric, historyRaw, collectionStats] = await Promise.all([
      DbMetric.findOne({ dbId: id }).sort({ timestamp: -1 }).lean(),

      DbMetric.aggregate([
        { $match: matchQuery },
        { $group: buildGroupStage(bucketFormat) },
        { $sort: { _id: 1 } },
        { $project: buildProjectStage() },
      ]),

      DbCollectionStat.findOne({ dbId: id }).lean(),
    ]);

    const health = buildHealthReport({
      type: db.type,
      status: db.status,
      errorMessage: db.errorMessage,
      latest: (latestMetric || {}) as any,
    });

    // resolveShareContext rewrites ownerId to the share owner, so the share
    // document is the only reliable signal that this is a public viewer.
    const isPublicShare = !!(req as any).share;

    res.json({
      database: isPublicShare && (db as any).topology
        ? { ...(db as any).toObject?.() ?? db, topology: redactTopology((db as any).topology) }
        : db,
      timeRange: meta,
      latest: latestMetric || {},
      history: historyRaw,
      collections: collectionStats?.collections || [],
      collectionsCheckedAt: collectionStats?.lastCheck || null,
      // What this instance's credentials actually permit. Drives the "why is
      // this panel empty" explanations instead of rendering silent zeros.
      capabilities: capabilitiesToObject(db.capabilities),
      capabilitiesCheckedAt: db.capabilitiesCheckedAt || null,
      instance: db.instance || {},
      health,
    });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};
