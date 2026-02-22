import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { DatabaseService, DbMetric, DbCollectionStat } from '../../models/Database';

export const getDatabaseStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { uid } = (req as any).user;
    const { range } = req.query;

    const db = await DatabaseService.findOne({ _id: id, ownerId: uid }).select('-encryptedUri');
    if (!db) return res.status(404).json({ error: "Database not found" });

    const now = new Date();
    const startDate = new Date();

    switch (range) {
      case '7d': startDate.setDate(now.getDate() - 7); break;
      case '5d': startDate.setDate(now.getDate() - 5); break;
      case '2d': startDate.setDate(now.getDate() - 2); break;
      case '1h': startDate.setHours(now.getHours() - 1); break;
      case '24h':
      default: startDate.setHours(now.getHours() - 24); break;
    }

    const matchQuery = { dbId: new mongoose.Types.ObjectId(id), timestamp: { $gte: startDate } };

    // Fetch the time-series history, latest metrics, AND the decoupled collection stats
    const [latestMetric, historyRaw, collectionStats] = await Promise.all([
      DbMetric.findOne({ dbId: id }).sort({ timestamp: -1 }).lean(),

      DbMetric.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: {
              $dateToString: {
                format: range === '1h' ? "%Y-%m-%dT%H:%M:00.000Z"
                  : (range === '7d' || range === '5d' || range === '2d' ? "%Y-%m-%d" : "%Y-%m-%dT%H:00:00.000Z"),
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
      latest: latestMetric || {},
      history: historyRaw,
      collections: collectionStats?.collections || []
    });
  } catch (error) {
    next(error);
  }
};