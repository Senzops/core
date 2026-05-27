import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { DatabaseService, DbMetric, DbCollectionStat } from '../../models/Database';
import { resolveTimeRange, getEffectiveRetention, buildTimeRangeMeta, TimeRangeError } from '../../utils/timeRange';

export const getDatabaseStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { uid } = (req as any).user;
    const { range, start, end } = req.query;

    const db = await DatabaseService.findOne({ _id: id, ownerId: uid }).select('-encryptedUri');
    if (!db) return res.status(404).json({ error: "Database not found" });

    const maxRetention = await getEffectiveRetention('database', uid);
    const resolved = resolveTimeRange(
      { range: range as string, start: start as string, end: end as string },
      maxRetention
    );
    const { startDate, endDate, bucketFormat } = resolved;
    const meta = buildTimeRangeMeta(resolved, maxRetention);

    const matchQuery = { dbId: new mongoose.Types.ObjectId(id), timestamp: { $gte: startDate, $lte: endDate } };

    // Fetch the time-series history, latest metrics, AND the decoupled collection stats
    const [latestMetric, historyRaw, collectionStats] = await Promise.all([
      DbMetric.findOne({ dbId: id }).sort({ timestamp: -1 }).lean(),

      DbMetric.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: {
              $dateToString: {
                format: bucketFormat,
                date: "$timestamp"
              }
            },
            // Throughput
            throughputRead: { $avg: "$throughput.read" },
            throughputWrite: { $avg: "$throughput.write" },
            throughputTotal: { $avg: "$throughput.total" },
            // Latency
            latencyReadAvg: { $avg: "$latency.read.avg" },
            latencyReadMax: { $max: "$latency.read.max" },
            latencyWriteAvg: { $avg: "$latency.write.avg" },
            latencyWriteMax: { $max: "$latency.write.max" },
            latencyPing: { $avg: "$latency.ping" }, // REDIS Ping
            // Memory
            memResident: { $avg: "$memory.resident" },
            memVirtual: { $avg: "$memory.virtual" },
            memMapped: { $avg: "$memory.mapped" },
            // Scans
            scansCollection: { $avg: "$scans.collectionScans" },
            scansIndex: { $avg: "$scans.indexScans" },
            // Storage
            storageData: { $avg: "$storage.dataSize" },
            storageIndex: { $avg: "$storage.indexSize" },
            storageTotal: { $avg: "$storage.storageSize" },
            // Locks
            locksAR: { $max: "$locks.activeReaders" },
            locksAW: { $max: "$locks.activeWriters" },
            locksQR: { $max: "$locks.queuedReaders" },
            locksQW: { $max: "$locks.queuedWriters" },
            // Network & Connections
            connections: { $max: "$connections.current" },
            netIn: { $avg: "$network.bytesIn" },
            netOut: { $avg: "$network.bytesOut" },
            netRequests: { $avg: "$network.numRequests" },

            // REDIS Specifics
            redisHits: { $avg: "$redis.keyspaceHits" },
            redisMisses: { $avg: "$redis.keyspaceMisses" },
            redisHitRate: { $avg: "$redis.hitRate" },
            redisEvicted: { $avg: "$redis.evictedKeys" },
            redisExpired: { $avg: "$redis.expiredKeys" },
            redisMemPeak: { $max: "$redis.usedMemoryPeak" },
            redisFragRatio: { $avg: "$redis.fragmentationRatio" }
          }
        },
        { $sort: { "_id": 1 } },
        {
          $project: {
            time: "$_id",
            throughputRead: 1, throughputWrite: 1, throughputTotal: 1,
            latencyReadAvg: 1, latencyReadMax: 1, latencyWriteAvg: 1, latencyWriteMax: 1, latencyPing: 1,
            memResident: 1, memVirtual: 1, memMapped: 1,
            scansCollection: 1, scansIndex: 1,
            storageData: 1, storageIndex: 1, storageTotal: 1,
            locksAR: 1, locksAW: 1, locksQR: 1, locksQW: 1,
            connections: 1, netIn: 1, netOut: 1, netRequests: 1,
            redisHits: 1, redisMisses: 1, redisHitRate: 1, redisEvicted: 1, redisExpired: 1, redisMemPeak: 1, redisFragRatio: 1
          }
        }
      ]),

      DbCollectionStat.findOne({ dbId: id }).lean()
    ]);

    res.json({
      database: db,
      timeRange: meta,
      latest: latestMetric || {},
      history: historyRaw,
      collections: collectionStats?.collections || []
    });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};