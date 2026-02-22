import cron from 'node-cron';
import { MongoClient } from 'mongodb';
import Redis from 'ioredis';
import { DatabaseService, DbCollectionStat, DbMetric } from '../models/Database';
import { decrypt } from '../utils/crypto';
import { logger } from '../utils/logger';

// --- IN-MEMORY STATE ---
const mongoPool = new Map<string, MongoClient>();
const redisPool = new Map<string, Redis>();

const previousState = new Map<string, any>();

export const startDatabaseWorker = () => {
  logger.info('[Worker] Database Monitoring Engine Started');
  cron.schedule('* * * * *', async () => { await pollDatabases(); });
  cron.schedule('0 * * * *', async () => { await cleanupPool(); });
};

const pollDatabases = async () => {
  const now = new Date();
  const dueDbs = await DatabaseService.find({
    $expr: {
      $lte: [
        { $ifNull: ["$lastCheck", new Date(0)] },
        { $subtract: [now, { $multiply: ["$interval", 60000] }] }
      ]
    }
  });

  if (dueDbs.length === 0) return;
  const promises = dueDbs.map(db => {
    if (db.type === 'mongodb') return processMongoDB(db, now);
    if (db.type === 'redis') return processRedis(db, now);
    return Promise.resolve();
  });
  await Promise.allSettled(promises);
};

// --- REDIS PROCESSOR ---
const parseRedisInfo = (infoString: string) => {
  const lines = infoString.split('\r\n');
  const info: any = {};
  for (const line of lines) {
    if (line && !line.startsWith('#')) {
      const [key, value] = line.split(':');
      if (key && value) info[key.trim()] = value.trim();
    }
  }
  return info;
};

const processRedis = async (dbObj: any, checkTime: Date) => {
  const dbId = dbObj._id.toString();
  let client = redisPool.get(dbId);

  try {
    if (!client || client.status === 'end') {
      const uri = decrypt(dbObj.encryptedUri);
      client = new Redis(uri, { maxRetriesPerRequest: 1, commandTimeout: 5000 });
      redisPool.set(dbId, client);
    }

    // 1. Measure Ping Latency directly
    const pingStart = performance.now();
    await client.ping();
    const pingLatency = performance.now() - pingStart;

    // 2. Fetch O(1) Fast Info
    const infoRaw = await client.info('all');
    const info = parseRedisInfo(infoRaw);

    // 3. Process Deltas
    const currentTs = Date.now();
    const prev = previousState.get(dbId);
    let lastCollectionCheck = prev?.lastCollectionCheck || 0;

    let throughputTotal = 0;
    let network = { bytesIn: 0, bytesOut: 0, numRequests: 0 };
    let redisStats = {
      keyspaceHits: 0, keyspaceMisses: 0, evictedKeys: 0, expiredKeys: 0, hitRate: 0,
      usedMemoryPeak: Number(info.used_memory_peak) / (1024 * 1024),
      fragmentationRatio: Number(info.mem_fragmentation_ratio)
    };

    if (prev) {
      const timeDeltaSec = (currentTs - prev.timestamp) / 1000;
      if (timeDeltaSec > 0) {
        // Throughput
        const opsDelta = Number(info.total_commands_processed) - prev.total_commands_processed;
        throughputTotal = Math.max(0, opsDelta / timeDeltaSec);

        // Network
        network.bytesIn = Math.max(0, (Number(info.total_net_input_bytes) - prev.total_net_input_bytes) / timeDeltaSec);
        network.bytesOut = Math.max(0, (Number(info.total_net_output_bytes) - prev.total_net_output_bytes) / timeDeltaSec);
        network.numRequests = throughputTotal;

        // Redis Events
        redisStats.keyspaceHits = Math.max(0, (Number(info.keyspace_hits) - prev.keyspace_hits) / timeDeltaSec);
        redisStats.keyspaceMisses = Math.max(0, (Number(info.keyspace_misses) - prev.keyspace_misses) / timeDeltaSec);
        redisStats.evictedKeys = Math.max(0, (Number(info.evicted_keys) - prev.evicted_keys) / timeDeltaSec);
        redisStats.expiredKeys = Math.max(0, (Number(info.expired_keys) - prev.expired_keys) / timeDeltaSec);

        // Hit Rate Formula
        const totalAttempts = redisStats.keyspaceHits + redisStats.keyspaceMisses;
        redisStats.hitRate = totalAttempts > 0 ? (redisStats.keyspaceHits / totalAttempts) * 100 : 0;
      }
    }

    previousState.set(dbId, {
      timestamp: currentTs,
      total_commands_processed: Number(info.total_commands_processed),
      total_net_input_bytes: Number(info.total_net_input_bytes),
      total_net_output_bytes: Number(info.total_net_output_bytes),
      keyspace_hits: Number(info.keyspace_hits),
      keyspace_misses: Number(info.keyspace_misses),
      evicted_keys: Number(info.evicted_keys),
      expired_keys: Number(info.expired_keys),
      lastCollectionCheck
    });

    // --- HOURLY KEYSPACE EXTRACTION ---
    // Redis exposes db0, db1, etc. in INFO. We map this to our collections table.
    const ONE_HOUR_MS = 60 * 60 * 1000;
    if (currentTs - lastCollectionCheck > ONE_HOUR_MS) {
      const keyspaces = [];
      for (const key in info) {
        if (key.startsWith('db')) {
          // e.g., db0:keys=1000,expires=10,avg_ttl=10000
          const parts = info[key].split(',');
          const keysCount = parseInt(parts[0].split('=')[1] || '0');
          const expiresCount = parseInt(parts[1].split('=')[1] || '0');
          keyspaces.push({
            name: key, // 'db0'
            count: keysCount,
            size: 0, // Not explicitly provided without heavy scanning
            storageSize: 0,
            indexSize: expiresCount // We map volatile/expiring keys here for the UI
          });
        }
      }
      await DbCollectionStat.findOneAndUpdate(
        { dbId: dbObj._id },
        { lastCheck: new Date(), collections: keyspaces },
        { upsert: true }
      );
      const updatedState = previousState.get(dbId);
      if (updatedState) updatedState.lastCollectionCheck = currentTs;
    }

    // Save DB Metric
    await DbMetric.create({
      dbId: dbObj._id,
      timestamp: checkTime,
      throughput: { read: 0, write: 0, total: throughputTotal },
      latency: { read: { avg: 0, max: 0 }, write: { avg: 0, max: 0 }, ping: pingLatency },
      uptimeSeconds: Number(info.uptime_in_seconds),
      connections: {
        current: Number(info.connected_clients),
        available: Number(info.maxclients) - Number(info.connected_clients),
        totalCreated: Number(info.total_connections_received)
      },
      memory: {
        resident: Number(info.used_memory_rss) / (1024 * 1024),
        virtual: Number(info.used_memory) / (1024 * 1024),
        mapped: 0
      },
      network,
      redis: redisStats
    });

    await DatabaseService.updateOne({ _id: dbObj._id }, { status: 'online', lastCheck: checkTime, errorMessage: '' });

  } catch (error: any) {
    if (client) {
      client.disconnect();
      redisPool.delete(dbId);
    }
    await DatabaseService.updateOne({ _id: dbObj._id }, { status: 'error', lastCheck: checkTime, errorMessage: error.message });
  }
};

// MONGO PROCESSOR 
const processMongoDB = async (dbObj: any, checkTime: Date) => {
  const dbId = dbObj._id.toString();
  let client = mongoPool.get(dbId);

  try {
    // 1. Manage Connection
    if (!client) {
      const uri = decrypt(dbObj.encryptedUri);
      client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 5000,
        maxPoolSize: 1
      });
      await client.connect();
      mongoPool.set(dbId, client);
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
      mongoPool.delete(dbId);
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
  const activeIds = await DatabaseService.find().distinct('_id');
  const activeIdStrings = activeIds.map(id => id.toString());

  for (const [dbId, client] of mongoPool.entries()) {
    if (!activeIdStrings.includes(dbId)) {
      await client.close(true).catch(() => { });
      mongoPool.delete(dbId);
      previousState.delete(dbId);
    }
  }
  for (const [dbId, client] of redisPool.entries()) {
    if (!activeIdStrings.includes(dbId)) {
      client.disconnect();
      redisPool.delete(dbId);
      previousState.delete(dbId);
    }
  }
};