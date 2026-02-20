import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { DatabaseService, DbMetric } from '../../models/Database';

// --- Helper: Zero-Fill Time Series ---
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
      filled.push({
        time: key,
        throughputRead: 0, throughputWrite: 0,
        latencyRead: 0, latencyWrite: 0,
        memoryUsed: 0, connections: 0,
        netIn: 0, netOut: 0
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

    // 1. Verify Ownership (DO NOT return encryptedUri)
    const db = await DatabaseService.findOne({ _id: id, ownerId: uid }).select('-encryptedUri');
    if (!db) return res.status(404).json({ error: "Database not found" });

    // 2. Calculate Range
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

    // 3. Fetch Data Concurrently
    const [latestMetric, historyRaw] = await Promise.all([
      // Get the absolute latest precise ping for top cards
      DbMetric.findOne({ dbId: id }).sort({ timestamp: -1 }).lean(),

      // Aggregate Time Series for Graphs
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
            throughputRead: { $avg: "$throughput.read" },
            throughputWrite: { $avg: "$throughput.write" },
            latencyRead: { $avg: "$latency.read.avg" },
            latencyWrite: { $avg: "$latency.write.avg" },
            memoryUsed: { $avg: "$memory.resident" },
            connections: { $max: "$connections.current" },
            netIn: { $avg: "$network.bytesIn" },
            netOut: { $avg: "$network.bytesOut" }
          }
        },
        { $sort: { "_id": 1 } },
        {
          $project: {
            time: "$_id",
            throughputRead: 1, throughputWrite: 1,
            latencyRead: 1, latencyWrite: 1,
            memoryUsed: 1, connections: 1,
            netIn: 1, netOut: 1
          }
        }
      ])
    ]);

    const history = fillTimeGaps(historyRaw, range as string || '24h', startDate);

    res.json({
      database: db,
      latest: latestMetric || {},
      history: history
    });

  } catch (error) {
    next(error);
  }
};