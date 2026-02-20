import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { DatabaseService, DbMetric } from '../../models/Database';

// --- Helper: Robust Zero-Fill Time Series ---
const fillTimeGaps = (data: any[], range: string, startDate: Date) => {
  const filled = [];
  const now = new Date();

  let current = new Date(startDate);
  if (range === '1h') current.setSeconds(0, 0);
  else if (range === '24h') current.setMinutes(0, 0, 0);
  else current.setHours(0, 0, 0, 0);

  const end = new Date(now);
  if (range === '1h') end.setMinutes(end.getMinutes() + 1);
  else if (range === '24h') end.setHours(end.getHours() + 1);
  else end.setDate(end.getDate() + 1);

  const dataMap = new Map(data.map(item => [item.time, item]));

  while (current < end) {
    let key;
    if (range === '1h') key = current.toISOString().slice(0, 16) + ":00.000Z";
    else if (range === '24h') key = current.toISOString().slice(0, 13) + ":00:00.000Z";
    else key = current.toISOString().slice(0, 10);

    if (dataMap.has(key)) {
      filled.push(dataMap.get(key));
    } else {
      // PRO FIX: We use `null` instead of `0`. 
      // This tells Recharts "No Data" so it can connect lines cleanly instead of nose-diving to 0.
      filled.push({
        time: key,
        throughputRead: null, throughputWrite: null,
        latencyReadAvg: null, latencyReadMax: null,
        latencyWriteAvg: null, latencyWriteMax: null,
        memResident: null, memVirtual: null, memMapped: null,
        scansCollection: null, scansIndex: null,
        storageData: null, storageIndex: null, storageTotal: null,
        locksAR: null, locksAW: null, locksQR: null, locksQW: null,
        connections: null, netIn: null, netOut: null, netRequests: null
      });
    }

    if (range === '1h') current.setMinutes(current.getMinutes() + 1);
    else if (range === '24h') current.setHours(current.getHours() + 1);
    else current.setDate(current.getDate() + 1);
  }
  return filled;
};

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

    const [latestMetric, historyRaw] = await Promise.all([
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
            // Latency
            latencyReadAvg: { $avg: "$latency.read.avg" },
            latencyReadMax: { $max: "$latency.read.max" },
            latencyWriteAvg: { $avg: "$latency.write.avg" },
            latencyWriteMax: { $max: "$latency.write.max" },
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
            netRequests: { $avg: "$network.numRequests" }
          }
        },
        { $sort: { "_id": 1 } },
        {
          $project: {
            time: "$_id",
            throughputRead: 1, throughputWrite: 1,
            latencyReadAvg: 1, latencyReadMax: 1, latencyWriteAvg: 1, latencyWriteMax: 1,
            memResident: 1, memVirtual: 1, memMapped: 1,
            scansCollection: 1, scansIndex: 1,
            storageData: 1, storageIndex: 1, storageTotal: 1,
            locksAR: 1, locksAW: 1, locksQR: 1, locksQW: 1,
            connections: 1, netIn: 1, netOut: 1, netRequests: 1
          }
        }
      ])
    ]);

    const history = fillTimeGaps(historyRaw, range as string || '24h', startDate);

    res.json({ database: db, latest: latestMetric || {}, history });
  } catch (error) {
    next(error);
  }
};