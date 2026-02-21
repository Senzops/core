import cron from 'node-cron';
import { MongoClient } from 'mongodb';
import { DatabaseService, DbCollectionStat, DbMetric } from '../models/Database';
import { decrypt } from '../utils/crypto';
import { logger } from '../utils/logger';

// --- IN-MEMORY STATE ---
// We keep connections alive to prevent connection storming.
const connectionPool = new Map<string, MongoClient>();

// We must store the previous state to calculate deltas (ops/sec)
const previousState = new Map<string, {
  timestamp: number;
  opcounters: any;
  opLatencies: any;
  network: any;
  lastCollectionCheck?: number; // In-memory tracker
}>();

export const startDatabaseWorker = () => {
  logger.info('[Worker] Database Monitoring Engine Started');

  // Run every minute
  cron.schedule('* * * * *', async () => {
    await pollDatabases();
  });

  // Cleanup stale connections every hour
  cron.schedule('0 * * * *', async () => {
    await cleanupPool();
  });
};

const pollDatabases = async () => {
  const now = new Date();

  // Find databases that are due for a check based on their interval
  const dueDbs = await DatabaseService.find({
    $expr: {
      $lte: [
        { $ifNull: ["$lastCheck", new Date(0)] },
        { $subtract: [now, { $multiply: ["$interval", 60000] }] }
      ]
    }
  });

  if (dueDbs.length === 0) return;

  const promises = dueDbs.map(db => processMongoDB(db, now));
  await Promise.allSettled(promises);
};

const processMongoDB = async (dbObj: any, checkTime: Date) => {
  const dbId = dbObj._id.toString();
  let client = connectionPool.get(dbId);

  try {
    // 1. Manage Connection
    if (!client) {
      const uri = decrypt(dbObj.encryptedUri);
      client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 5000,
        maxPoolSize: 1
      });
      await client.connect();
      connectionPool.set(dbId, client);
    }

    const admin = client.db('admin');
    const targetDb = client.db();

    // 2. Execute DB Commands
    const [serverStatus, dbStatsList] = await Promise.all([
      admin.command({ serverStatus: 1 }),
      getDatabaseSizes(admin)
    ]);

    // 3. Process Deltas (Throughput & Latency)
    const currentTs = Date.now();
    const prev = previousState.get(dbId);
    let lastCollectionCheck = prev?.lastCollectionCheck || 0;

    // --- HOURLY DECOUPLED COLLECTION STATS ---
    const ONE_HOUR_MS = 60 * 60 * 1000;
    if (currentTs - lastCollectionCheck > ONE_HOUR_MS) {
      try {
        const colls = await targetDb.listCollections({}, { nameOnly: true }).toArray();
        const collsToProcess = colls.slice(0, 3000);

        const results = [];
        const BATCH_SIZE = 50;

        for (let i = 0; i < collsToProcess.length; i += BATCH_SIZE) {
          const batch = collsToProcess.slice(i, i + BATCH_SIZE).map(async (c: any) => {
            try {
              const stats = await targetDb.command({ collStats: c.name, scale: 1048576 });
              return {
                name: c.name,
                count: stats.count || 0,
                size: stats.size || 0,
                storageSize: stats.storageSize || 0,
                indexSize: stats.totalIndexSize || 0
              };
            } catch (e) { return null; }
          });
          const batchResults = await Promise.all(batch);
          results.push(...batchResults.filter(Boolean));
        }

        const topCollections = results
          .sort((a: any, b: any) => b.storageSize - a.storageSize)
          .slice(0, 100);

        // Upsert into our Decoupled Collection
        await DbCollectionStat.findOneAndUpdate(
          { dbId: dbObj._id },
          { lastCheck: new Date(), collections: topCollections },
          { upsert: true }
        );

        lastCollectionCheck = currentTs; // Update tracker
      } catch (err: any) {
        logger.warn(`[DB Engine] Failed to fetch collection stats for ${dbId}: ${err.message}`);
      }
    }
    // ------------------------------------------

    let throughput = { read: 0, write: 0 };
    let latency = { read: { avg: 0, max: 0 }, write: { avg: 0, max: 0 } };
    let network = { bytesIn: 0, bytesOut: 0, numRequests: 0 };

    if (prev) {
      const timeDeltaSec = (currentTs - prev.timestamp) / 1000;

      if (timeDeltaSec > 0) {
        // --- Throughput Calculation (Ops/Sec) ---
        const reads = (serverStatus.opcounters.query - prev.opcounters.query) + (serverStatus.opcounters.getmore - (prev.opcounters.getmore || 0));
        const writes = (serverStatus.opcounters.insert - prev.opcounters.insert) +
          (serverStatus.opcounters.update - prev.opcounters.update) +
          (serverStatus.opcounters.delete - prev.opcounters.delete);

        throughput.read = Math.max(0, reads / timeDeltaSec);
        throughput.write = Math.max(0, writes / timeDeltaSec);

        // --- Latency Calculation (ms) ---
        // serverStatus.opLatencies stores total latency in microseconds
        const calcLatency = (type: 'reads' | 'writes') => {
          if (!serverStatus.opLatencies?.[type] || !prev.opLatencies?.[type]) return 0;
          const deltaOps = serverStatus.opLatencies[type].ops - prev.opLatencies[type].ops;
          const deltaMicros = serverStatus.opLatencies[type].latency - prev.opLatencies[type].latency;
          return deltaOps > 0 ? (deltaMicros / deltaOps) / 1000 : 0; // Convert to ms
        };

        const avgReadMs = calcLatency('reads');
        const avgWriteMs = calcLatency('writes');

        latency.read = { avg: avgReadMs, max: avgReadMs }; // Mongo doesn't expose max per interval easily, fallback to avg
        latency.write = { avg: avgWriteMs, max: avgWriteMs };

        // --- Network Rate ---
        network.bytesIn = Math.max(0, (serverStatus.network.bytesIn - prev.network.bytesIn) / timeDeltaSec);
        network.bytesOut = Math.max(0, (serverStatus.network.bytesOut - prev.network.bytesOut) / timeDeltaSec);
        network.numRequests = Math.max(0, (serverStatus.network.numRequests - prev.network.numRequests) / timeDeltaSec);
      }
    }

    // 4. Update Previous State for next tick
    previousState.set(dbId, {
      timestamp: currentTs,
      opcounters: serverStatus.opcounters,
      opLatencies: serverStatus.opLatencies || {},
      network: serverStatus.network,
      lastCollectionCheck // Save tracker state
    });

    // 5. Save Metric Document
    await DbMetric.create({
      dbId: dbObj._id,
      timestamp: checkTime,
      throughput,
      latency,
      uptimeSeconds: serverStatus.uptime,
      connections: {
        current: serverStatus.connections.current,
        available: serverStatus.connections.available,
        totalCreated: serverStatus.connections.totalCreated
      },
      memory: {
        resident: serverStatus.mem.resident,
        virtual: serverStatus.mem.virtual,
        mapped: serverStatus.mem.mapped || 0
      },
      network,
      ops: {
        insert: serverStatus.opcounters.insert,
        query: serverStatus.opcounters.query,
        update: serverStatus.opcounters.update,
        delete: serverStatus.opcounters.delete,
        command: serverStatus.opcounters.command
      },
      scans: {
        collectionScans: serverStatus.metrics?.queryExecutor?.scanned || 0,
        indexScans: serverStatus.metrics?.queryExecutor?.scannedObjects || 0
      },
      storage: dbStatsList,
      locks: {
        activeReaders: serverStatus.globalLock?.activeClients?.readers || 0,
        activeWriters: serverStatus.globalLock?.activeClients?.writers || 0,
        queuedReaders: serverStatus.globalLock?.currentQueue?.readers || 0,
        queuedWriters: serverStatus.globalLock?.currentQueue?.writers || 0
      }
    });

    // 6. Update Registry Status
    await DatabaseService.updateOne(
      { _id: dbObj._id },
      { status: 'online', lastCheck: checkTime, errorMessage: '' }
    );

  } catch (error: any) {
    logger.warn(`[DB Engine] Failed to poll DB ${dbId}: ${error.message}`);
    // If it fails, close and remove from pool to force reconnect next time
    if (client) {
      await client.close(true).catch(() => { });
      connectionPool.delete(dbId);
    }

    await DatabaseService.updateOne(
      { _id: dbObj._id },
      { status: 'error', lastCheck: checkTime, errorMessage: error.message }
    );
  }
};

// Helper to sum up total storage across all logical databases inside the cluster
const getDatabaseSizes = async (adminDb: any) => {
  let dataSize = 0, indexSize = 0, storageSize = 0, objects = 0;
  try {
    const listDbs = await adminDb.command({ listDatabases: 1 });
    // Note: To be totally accurate, we'd have to loop and run `dbStats` on each DB.
    // For a lightweight agent, we aggregate the summary provided by listDatabases 
    // which gives sizeOnDisk. 
    dataSize = listDbs.totalSize / (1024 * 1024); // Convert to MB
    storageSize = listDbs.totalSize / (1024 * 1024);
  } catch (e) {
    // Graceful fallback if permission denied
  }
  return { dataSize, indexSize, storageSize, objects };
};

const cleanupPool = async () => {
  // Find all IDs in pool that no longer exist in DB (deleted by user)
  const activeIds = await DatabaseService.find().distinct('_id');
  const activeIdStrings = activeIds.map(id => id.toString());

  for (const [dbId, client] of connectionPool.entries()) {
    if (!activeIdStrings.includes(dbId)) {
      logger.info(`[DB Engine] Cleaning up orphaned connection: ${dbId}`);
      await client.close(true).catch(() => { });
      connectionPool.delete(dbId);
      previousState.delete(dbId);
    }
  }
};