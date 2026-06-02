import cron from 'node-cron';
import { MongoClient } from 'mongodb';
import Redis from 'ioredis';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { DatabaseService, DbCollectionStat, DbMetric } from '../models/Database';
import { decrypt } from '../utils/crypto';
import { logger } from '../utils/logger';

// --- IN-MEMORY STATE ---
const mongoPool = new Map<string, MongoClient>();
const redisPool = new Map<string, Redis>();
const pgPool = new Map<string, pg.Pool>();

const previousState = new Map<string, any>();

export const startDatabaseWorker = () => {
  logger.info('[Worker] Database Monitoring Engine Started');
  cron.schedule('* * * * *', async () => { await pollDatabases(); }, {name:"database-monitoring-schedule"});
  cron.schedule('0 * * * *', async () => { await cleanupPool(); }, {name:"database-cleanup-connection-pool"});
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
    if (db.type === 'postgresql') return processPostgreSQL(db, now);
    if (db.type === 'mysql') return processMySQL(db, now);
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

const safeNum = (val: any, fallback = 0) => {
  const n = Number(val);
  return isNaN(n) ? fallback : n;
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

    // 2. Fetch O(1) Fast Info & Configuration Safely
    // We catch the config command because managed providers (AWS/Heroku) often block it
    const [infoRaw, configRes] = await Promise.all([
      client.info('all'),
      client.config('GET', 'maxclients').catch(() => null) 
    ]);
    
    const info = parseRedisInfo(infoRaw);

    // --- ROBUST MAX CLIENTS RESOLUTION ---
    let maxClients = safeNum(info.maxclients, 0); 
    if (!maxClients && configRes) {
      // Handle ioredis array return format: ['maxclients', '10000']
      if (Array.isArray(configRes) && configRes.length >= 2) {
        maxClients = safeNum(configRes[1]); 
      } 
      // Handle ioredis object return format: { maxclients: '10000' }
      else if (typeof configRes === 'object' && (configRes as any)?.maxclients) {
        maxClients = safeNum((configRes as any)?.maxclients); 
      }
    }
    // Universal Redis Fallback if completely blocked/missing
    if (maxClients === 0) maxClients = 10000; 
    // -------------------------------------

    // 3. Process Deltas
    const currentTs = Date.now();
    const prev = previousState.get(dbId);
    let lastCollectionCheck = prev?.lastCollectionCheck || 0;

    let throughputTotal = 0;
    let network = { bytesIn: 0, bytesOut: 0, numRequests: 0 };
    let redisStats = {
      keyspaceHits: 0, keyspaceMisses: 0, evictedKeys: 0, expiredKeys: 0, hitRate: 0,
      usedMemoryPeak: safeNum(info.used_memory_peak) / (1024*1024),
      fragmentationRatio: safeNum(info.mem_fragmentation_ratio),
      blockedClients: safeNum(info.blocked_clients)
    };

    if (prev) {
      const timeDeltaSec = (currentTs - prev.timestamp) / 1000;
      if (timeDeltaSec > 0) {
        // Throughput
        const opsDelta = safeNum(info.total_commands_processed) - prev.total_commands_processed;
        throughputTotal = Math.max(0, opsDelta / timeDeltaSec);

        // Network
        network.bytesIn = Math.max(0, (safeNum(info.total_net_input_bytes) - prev.total_net_input_bytes) / timeDeltaSec);
        network.bytesOut = Math.max(0, (safeNum(info.total_net_output_bytes) - prev.total_net_output_bytes) / timeDeltaSec);
        network.numRequests = throughputTotal;

        // Redis Events
        redisStats.keyspaceHits = Math.max(0, (safeNum(info.keyspace_hits) - prev.keyspace_hits) / timeDeltaSec);
        redisStats.keyspaceMisses = Math.max(0, (safeNum(info.keyspace_misses) - prev.keyspace_misses) / timeDeltaSec);
        redisStats.evictedKeys = Math.max(0, (safeNum(info.evicted_keys) - prev.evicted_keys) / timeDeltaSec);
        redisStats.expiredKeys = Math.max(0, (safeNum(info.expired_keys) - prev.expired_keys) / timeDeltaSec);

        // Hit Rate Formula
        const totalAttempts = redisStats.keyspaceHits + redisStats.keyspaceMisses;
        redisStats.hitRate = totalAttempts > 0 ? (redisStats.keyspaceHits / totalAttempts) * 100 : 0;
      }
    }

    previousState.set(dbId, {
      timestamp: currentTs,
      total_commands_processed: safeNum(info.total_commands_processed),
      total_net_input_bytes: safeNum(info.total_net_input_bytes),
      total_net_output_bytes: safeNum(info.total_net_output_bytes),
      keyspace_hits: safeNum(info.keyspace_hits),
      keyspace_misses: safeNum(info.keyspace_misses),
      evicted_keys: safeNum(info.evicted_keys),
      expired_keys: safeNum(info.expired_keys),
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
           const keysCount = parseInt(parts[0]?.split('=')[1] || '0');
           const expiresCount = parseInt(parts[1]?.split('=')[1] || '0');
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
      if(updatedState) updatedState.lastCollectionCheck = currentTs;
    }

    // Save DB Metric
    const currentClients = safeNum(info.connected_clients);

    await DbMetric.create({
      dbId: dbObj._id,
      timestamp: checkTime,
      throughput: { read: 0, write: 0, total: throughputTotal },
      latency: { read: { avg: 0, max: 0 }, write: { avg: 0, max: 0 }, ping: pingLatency },
      uptimeSeconds: safeNum(info.uptime_in_seconds),
      connections: { 
         current: currentClients, 
         available: maxClients > 0 ? Math.max(0, maxClients - currentClients) : 0, 
         totalCreated: safeNum(info.total_connections_received) 
      },
      memory: { 
         resident: safeNum(info.used_memory_rss) / (1024*1024), 
         virtual: safeNum(info.used_memory) / (1024*1024), 
         mapped: 0 
      },
      network,
      redis: redisStats
    });

    const versionStr = info.redis_version || '';
    await DatabaseService.updateOne({ _id: dbObj._id }, { status: 'online', lastCheck: checkTime, errorMessage: '', ...(versionStr && { version: versionStr }) });

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
    const mongoVersion = serverStatus.version || '';
    await DatabaseService.updateOne(
      { _id: dbObj._id },
      { status: 'online', lastCheck: checkTime, errorMessage: '', ...(mongoVersion && { version: mongoVersion }) }
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

// --- POSTGRESQL PROCESSOR ---
const processPostgreSQL = async (dbObj: any, checkTime: Date) => {
  const dbId = dbObj._id.toString();
  let pool = pgPool.get(dbId);

  try {
    if (!pool) {
      const uri = decrypt(dbObj.encryptedUri);
      pool = new pg.Pool({
        connectionString: uri,
        max: 2,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000
      });
      pgPool.set(dbId, pool);
    }

    // 1. Measure ping latency
    const pingStart = performance.now();
    await pool.query('SELECT 1');
    const pingLatency = performance.now() - pingStart;

    // 2. Gather metrics in parallel
    const [
      dbStatsRes,
      activityRes,
      settingsRes,
      dbSizeRes,
      replRes,
      locksRes
    ] = await Promise.all([
      pool.query(`SELECT * FROM pg_stat_database WHERE datname = current_database()`),
      pool.query(`SELECT
        count(*) FILTER (WHERE state = 'active') AS active,
        count(*) FILTER (WHERE wait_event_type IS NOT NULL AND state = 'active') AS blocked,
        count(*) AS total
        FROM pg_stat_activity WHERE backend_type = 'client backend'`),
      pool.query(`SELECT name, setting FROM pg_settings WHERE name IN ('max_connections', 'shared_buffers', 'work_mem')`),
      pool.query(`SELECT pg_database_size(current_database()) AS db_size,
        (SELECT COALESCE(SUM(pg_indexes_size(c.oid)), 0) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')) AS total_index_size`),
      pool.query(`SELECT
        CASE WHEN pg_is_in_recovery() THEN
          COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000, -1)
        ELSE -1 END AS lag_ms`),
      pool.query(`SELECT
        count(*) FILTER (WHERE granted) AS granted,
        count(*) FILTER (WHERE NOT granted) AS waiting
        FROM pg_locks`)
    ]);

    const dbStats = dbStatsRes.rows[0] || {};
    const activity = activityRes.rows[0] || {};
    const settingsMap: Record<string, string> = {};
    for (const row of settingsRes.rows) settingsMap[row.name] = row.setting;
    const maxConn = safeNum(settingsMap['max_connections'], 100);
    const dbSizeBytes = safeNum(dbSizeRes.rows[0]?.db_size);
    const totalIndexSizeBytes = safeNum(dbSizeRes.rows[0]?.total_index_size);
    const replLagMs = safeNum(replRes.rows[0]?.lag_ms, -1);
    const lockStats = locksRes.rows[0] || {};

    // 3. Process deltas
    const currentTs = Date.now();
    const prev = previousState.get(dbId);
    let lastCollectionCheck = prev?.lastCollectionCheck || 0;

    let throughput = { read: 0, write: 0 };
    let network = { bytesIn: 0, bytesOut: 0, numRequests: 0 };
    let sqlRates = {
      tableScans: 0, indexScans: 0,
      rowsReturned: 0, rowsModified: 0,
      deadlocks: 0,
      txCommitted: 0, txRolledBack: 0,
      slowQueries: 0,
      tempBytesWritten: 0
    };

    const tupReturned = safeNum(dbStats.tup_returned);
    const tupFetched = safeNum(dbStats.tup_fetched);
    const tupInserted = safeNum(dbStats.tup_inserted);
    const tupUpdated = safeNum(dbStats.tup_updated);
    const tupDeleted = safeNum(dbStats.tup_deleted);
    const xactCommit = safeNum(dbStats.xact_commit);
    const xactRollback = safeNum(dbStats.xact_rollback);
    const deadlocks = safeNum(dbStats.deadlocks);
    const tempBytes = safeNum(dbStats.temp_bytes);
    const blksRead = safeNum(dbStats.blks_read);
    const blksHit = safeNum(dbStats.blks_hit);

    if (prev) {
      const timeDeltaSec = (currentTs - prev.timestamp) / 1000;
      if (timeDeltaSec > 0) {
        const reads = tupFetched - prev.tupFetched;
        const writes = (tupInserted - prev.tupInserted) + (tupUpdated - prev.tupUpdated) + (tupDeleted - prev.tupDeleted);
        throughput.read = Math.max(0, reads / timeDeltaSec);
        throughput.write = Math.max(0, writes / timeDeltaSec);

        sqlRates.txCommitted = Math.max(0, (xactCommit - prev.xactCommit) / timeDeltaSec);
        sqlRates.txRolledBack = Math.max(0, (xactRollback - prev.xactRollback) / timeDeltaSec);
        sqlRates.deadlocks = Math.max(0, deadlocks - prev.deadlocks);
        sqlRates.rowsReturned = Math.max(0, (tupReturned - prev.tupReturned) / timeDeltaSec);
        sqlRates.rowsModified = Math.max(0, writes / timeDeltaSec);
        sqlRates.tempBytesWritten = Math.max(0, (tempBytes - prev.tempBytes) / (1024 * 1024));

        network.bytesIn = 0;
        network.bytesOut = 0;
        network.numRequests = throughput.read + throughput.write;
      }
    }

    // Cache hit rate
    const totalBlocks = blksHit + blksRead;
    const cacheHitRate = totalBlocks > 0 ? (blksHit / totalBlocks) * 100 : 0;

    previousState.set(dbId, {
      timestamp: currentTs,
      tupReturned, tupFetched, tupInserted, tupUpdated, tupDeleted,
      xactCommit, xactRollback, deadlocks, tempBytes,
      blksRead, blksHit,
      lastCollectionCheck
    });

    // 4. Hourly table stats
    const ONE_HOUR_MS = 60 * 60 * 1000;
    if (currentTs - lastCollectionCheck > ONE_HOUR_MS) {
      try {
        const tableRes = await pool.query(`
          SELECT
            schemaname || '.' || relname AS name,
            n_live_tup AS count,
            pg_total_relation_size(relid) AS total_size,
            pg_relation_size(relid) AS data_size,
            pg_indexes_size(relid) AS index_size
          FROM pg_stat_user_tables
          ORDER BY pg_total_relation_size(relid) DESC
          LIMIT 100
        `);

        const collections = tableRes.rows.map((r: any) => ({
          name: r.name,
          count: safeNum(r.count),
          size: safeNum(r.data_size) / (1024 * 1024),
          storageSize: safeNum(r.total_size) / (1024 * 1024),
          indexSize: safeNum(r.index_size) / (1024 * 1024)
        }));

        await DbCollectionStat.findOneAndUpdate(
          { dbId: dbObj._id },
          { lastCheck: new Date(), collections },
          { upsert: true }
        );
        const updatedState = previousState.get(dbId);
        if (updatedState) updatedState.lastCollectionCheck = currentTs;
      } catch (err: any) {
        logger.warn(`[DB Engine] Failed to fetch table stats for PG ${dbId}: ${err.message}`);
      }
    }

    // 5. Fetch index scan vs seq scan stats
    let tableScansRate = 0;
    let indexScansRate = 0;
    try {
      const scanRes = await pool.query(`
        SELECT COALESCE(sum(seq_scan), 0) AS seq_scans, COALESCE(sum(idx_scan), 0) AS idx_scans
        FROM pg_stat_user_tables
      `);
      const row = scanRes.rows[0];
      if (prev?.seqScans !== undefined) {
        const timeDeltaSec = (currentTs - prev.timestamp) / 1000;
        if (timeDeltaSec > 0) {
          tableScansRate = Math.max(0, (safeNum(row.seq_scans) - prev.seqScans) / timeDeltaSec);
          indexScansRate = Math.max(0, (safeNum(row.idx_scans) - prev.idxScans) / timeDeltaSec);
        }
      }
      const prevState = previousState.get(dbId);
      if (prevState) {
        prevState.seqScans = safeNum(row.seq_scans);
        prevState.idxScans = safeNum(row.idx_scans);
      }
    } catch {}

    // 6. Uptime & version
    const [uptimeRes, versionRes] = await Promise.all([
      pool.query(`SELECT EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time())) AS uptime`),
      pool.query(`SHOW server_version`).catch(() => ({ rows: [] }))
    ]);
    const uptimeSeconds = safeNum(uptimeRes.rows[0]?.uptime);
    const pgVersion = versionRes.rows[0]?.server_version || '';

    // 7. Slow queries (active queries running > 1 second)
    let slowQueriesCount = 0;
    try {
      const slowRes = await pool.query(`SELECT count(*) AS cnt FROM pg_stat_activity WHERE state = 'active' AND backend_type = 'client backend' AND now() - query_start > interval '1 second'`);
      slowQueriesCount = safeNum(slowRes.rows[0]?.cnt);
    } catch {}

    // 8. Memory estimation (shared_buffers in 8KB pages)
    const sharedBufferPages = safeNum(settingsMap['shared_buffers']);
    const sharedBuffersMB = (sharedBufferPages * 8192) / (1024 * 1024);

    // 9. Save metric
    const currentConns = safeNum(activity.total);
    await DbMetric.create({
      dbId: dbObj._id,
      timestamp: checkTime,
      throughput,
      latency: { read: { avg: 0, max: 0 }, write: { avg: 0, max: 0 }, ping: pingLatency },
      uptimeSeconds,
      connections: {
        current: currentConns,
        available: Math.max(0, maxConn - currentConns),
        totalCreated: 0
      },
      memory: {
        resident: sharedBuffersMB,
        virtual: sharedBuffersMB + (safeNum(settingsMap['work_mem']) * currentConns / 1024),
        mapped: 0
      },
      network,
      storage: {
        dataSize: dbSizeBytes / (1024 * 1024),
        indexSize: totalIndexSizeBytes / (1024 * 1024),
        storageSize: dbSizeBytes / (1024 * 1024),
        objects: 0
      },
      locks: {
        activeReaders: safeNum(lockStats.granted),
        activeWriters: 0,
        queuedReaders: 0,
        queuedWriters: safeNum(lockStats.waiting)
      },
      sql: {
        activeQueries: safeNum(activity.active),
        blockedQueries: safeNum(activity.blocked),
        deadlocks: sqlRates.deadlocks,
        cacheHitRate,
        tempBytesWritten: sqlRates.tempBytesWritten,
        replicationLagMs: replLagMs,
        tableScans: tableScansRate,
        indexScans: indexScansRate,
        rowsReturned: sqlRates.rowsReturned,
        rowsModified: sqlRates.rowsModified,
        transactionsCommitted: sqlRates.txCommitted,
        transactionsRolledBack: sqlRates.txRolledBack,
        waitEvents: safeNum(activity.blocked),
        slowQueries: slowQueriesCount
      }
    });

    await DatabaseService.updateOne({ _id: dbObj._id }, { status: 'online', lastCheck: checkTime, errorMessage: '', ...(pgVersion && { version: pgVersion }) });

  } catch (error: any) {
    logger.warn(`[DB Engine] Failed to poll PostgreSQL ${dbId}: ${error.message}`);
    if (pool) {
      await pool.end().catch(() => {});
      pgPool.delete(dbId);
    }
    await DatabaseService.updateOne({ _id: dbObj._id }, { status: 'error', lastCheck: checkTime, errorMessage: error.message });
  }
};

// --- MYSQL PROCESSOR (Connection-per-poll: avoids mysql2 pool promise wrapper bug) ---
const processMySQL = async (dbObj: any, checkTime: Date) => {
  const dbId = dbObj._id.toString();
  const uri = decrypt(dbObj.encryptedUri);
  let conn: Awaited<ReturnType<typeof mysql.createConnection>> | null = null;

  try {
    conn = await mysql.createConnection({ uri, connectTimeout: 5000 });

    // 1. Measure ping latency
    const pingStart = performance.now();
    await conn.query('SELECT 1');
    const pingLatency = performance.now() - pingStart;

    // 2. Gather metrics
    const [statusRows] = await conn.query('SHOW GLOBAL STATUS');
    const [variablesRows] = await conn.query('SHOW GLOBAL VARIABLES');

    const status: Record<string, string> = {};
    for (const row of statusRows as any[]) status[row.Variable_name] = row.Value;

    const variables: Record<string, string> = {};
    for (const row of variablesRows as any[]) variables[row.Variable_name] = row.Value;

    const maxConn = safeNum(variables['max_connections'], 151);
    const currentConns = safeNum(status['Threads_connected']);

    // InnoDB buffer pool
    const bpReadRequests = safeNum(status['Innodb_buffer_pool_read_requests']);
    const bpReads = safeNum(status['Innodb_buffer_pool_reads']);
    const cacheHitRate = bpReadRequests > 0 ? ((bpReadRequests - bpReads) / bpReadRequests) * 100 : 0;

    const bpPagesFree = safeNum(status['Innodb_buffer_pool_pages_free']);
    const bpPagesTotal = safeNum(status['Innodb_buffer_pool_pages_total']);
    const bpPageSize = safeNum(variables['innodb_page_size'], 16384);
    const bpUsedMB = ((bpPagesTotal - bpPagesFree) * bpPageSize) / (1024 * 1024);
    const bpTotalMB = (bpPagesTotal * bpPageSize) / (1024 * 1024);

    // Counters for delta tracking
    const comSelect = safeNum(status['Com_select']);
    const comInsert = safeNum(status['Com_insert']);
    const comUpdate = safeNum(status['Com_update']);
    const comDelete = safeNum(status['Com_delete']);
    const bytesReceived = safeNum(status['Bytes_received']);
    const bytesSent = safeNum(status['Bytes_sent']);
    const questions = safeNum(status['Questions']);
    const xactCommit = safeNum(status['Com_commit']);
    const xactRollback = safeNum(status['Com_rollback']);
    const deadlocks = safeNum(status['Innodb_deadlocks']);
    const selectScan = safeNum(status['Select_scan']);
    const selectRange = safeNum(status['Select_range']);
    const slowQueries = safeNum(status['Slow_queries']);
    const tmpDiskTables = safeNum(status['Created_tmp_disk_tables']);
    const rowsRead = safeNum(status['Innodb_rows_read']);
    const rowsInserted = safeNum(status['Innodb_rows_inserted']);
    const rowsUpdated = safeNum(status['Innodb_rows_updated']);
    const rowsDeleted = safeNum(status['Innodb_rows_deleted']);

    // 3. Process deltas
    const currentTs = Date.now();
    const prev = previousState.get(dbId);
    let lastCollectionCheck = prev?.lastCollectionCheck || 0;

    let throughput = { read: 0, write: 0 };
    let network = { bytesIn: 0, bytesOut: 0, numRequests: 0 };
    let sqlRates = {
      tableScans: 0, indexScans: 0,
      rowsReturned: 0, rowsModified: 0,
      deadlocks: 0,
      txCommitted: 0, txRolledBack: 0,
      slowQueries: 0,
      tmpDiskTablesCreated: 0
    };

    if (prev) {
      const timeDeltaSec = (currentTs - prev.timestamp) / 1000;
      if (timeDeltaSec > 0) {
        throughput.read = Math.max(0, (comSelect - prev.comSelect) / timeDeltaSec);
        throughput.write = Math.max(0, ((comInsert - prev.comInsert) + (comUpdate - prev.comUpdate) + (comDelete - prev.comDelete)) / timeDeltaSec);

        network.bytesIn = Math.max(0, (bytesReceived - prev.bytesReceived) / timeDeltaSec);
        network.bytesOut = Math.max(0, (bytesSent - prev.bytesSent) / timeDeltaSec);
        network.numRequests = Math.max(0, (questions - prev.questions) / timeDeltaSec);

        sqlRates.txCommitted = Math.max(0, (xactCommit - prev.xactCommit) / timeDeltaSec);
        sqlRates.txRolledBack = Math.max(0, (xactRollback - prev.xactRollback) / timeDeltaSec);
        sqlRates.deadlocks = Math.max(0, deadlocks - prev.deadlocks);
        sqlRates.tableScans = Math.max(0, (selectScan - prev.selectScan) / timeDeltaSec);
        sqlRates.indexScans = Math.max(0, (selectRange - prev.selectRange) / timeDeltaSec);
        sqlRates.slowQueries = Math.max(0, slowQueries - prev.slowQueries);
        sqlRates.rowsReturned = Math.max(0, (rowsRead - prev.rowsRead) / timeDeltaSec);
        sqlRates.rowsModified = Math.max(0, ((rowsInserted - prev.rowsInserted) + (rowsUpdated - prev.rowsUpdated) + (rowsDeleted - prev.rowsDeleted)) / timeDeltaSec);
        sqlRates.tmpDiskTablesCreated = Math.max(0, tmpDiskTables - prev.tmpDiskTables);
      }
    }

    previousState.set(dbId, {
      timestamp: currentTs,
      comSelect, comInsert, comUpdate, comDelete,
      bytesReceived, bytesSent, questions,
      xactCommit, xactRollback, deadlocks,
      selectScan, selectRange, slowQueries,
      rowsRead, rowsInserted, rowsUpdated, rowsDeleted,
      tmpDiskTables,
      lastCollectionCheck
    });

    // 4. Hourly table stats
    const ONE_HOUR_MS = 60 * 60 * 1000;
    if (currentTs - lastCollectionCheck > ONE_HOUR_MS) {
      try {
        const [tableRows] = await conn.query(`
          SELECT
            CONCAT(TABLE_SCHEMA, '.', TABLE_NAME) AS name,
            TABLE_ROWS AS \`count\`,
            DATA_LENGTH AS data_size,
            INDEX_LENGTH AS index_size,
            (DATA_LENGTH + INDEX_LENGTH) AS total_size
          FROM information_schema.TABLES
          WHERE TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
            AND TABLE_TYPE = 'BASE TABLE'
          ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC
          LIMIT 100
        `);

        const collections = (tableRows as any[]).map((r: any) => ({
          name: r.name,
          count: safeNum(r.count),
          size: safeNum(r.data_size) / (1024 * 1024),
          storageSize: safeNum(r.total_size) / (1024 * 1024),
          indexSize: safeNum(r.index_size) / (1024 * 1024)
        }));

        await DbCollectionStat.findOneAndUpdate(
          { dbId: dbObj._id },
          { lastCheck: new Date(), collections },
          { upsert: true }
        );
        const updatedState = previousState.get(dbId);
        if (updatedState) updatedState.lastCollectionCheck = currentTs;
      } catch (err: any) {
        logger.warn(`[DB Engine] Failed to fetch table stats for MySQL ${dbId}: ${err.message}`);
      }
    }

    // 5. Uptime & storage
    const uptimeSeconds = safeNum(status['Uptime']);

    // Replication lag
    let replicationLagMs = -1;
    try {
      const [replRows] = await conn.query('SHOW REPLICA STATUS');
      const replRow = (replRows as any[])[0];
      if (replRow) {
        replicationLagMs = safeNum(replRow.Seconds_Behind_Source, -1) * 1000;
        if (replicationLagMs < 0) replicationLagMs = safeNum(replRow.Seconds_Behind_Master, -1) * 1000;
      }
    } catch {}

    // DB size + index size in a single query
    let dbSizeBytes = 0;
    let totalIndexSizeBytes = 0;
    try {
      const [sizeRows] = await conn.query(`
        SELECT
          COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS total,
          COALESCE(SUM(INDEX_LENGTH), 0) AS total_idx
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
      `);
      dbSizeBytes = safeNum((sizeRows as any[])[0]?.total);
      totalIndexSizeBytes = safeNum((sizeRows as any[])[0]?.total_idx);
    } catch {}

    // Active / blocked queries
    const activeQueries = safeNum(status['Threads_running']);
    const blockedQueries = safeNum(status['Innodb_row_lock_current_waits']);

    // MySQL version
    const mysqlVersion = variables['version'] || '';

    // 6. Save metric
    await DbMetric.create({
      dbId: dbObj._id,
      timestamp: checkTime,
      throughput,
      latency: { read: { avg: 0, max: 0 }, write: { avg: 0, max: 0 }, ping: pingLatency },
      uptimeSeconds,
      connections: {
        current: currentConns,
        available: Math.max(0, maxConn - currentConns),
        totalCreated: safeNum(status['Connections'])
      },
      memory: {
        resident: bpUsedMB,
        virtual: bpTotalMB,
        mapped: 0
      },
      network,
      storage: {
        dataSize: dbSizeBytes / (1024 * 1024),
        indexSize: totalIndexSizeBytes / (1024 * 1024),
        storageSize: dbSizeBytes / (1024 * 1024),
        objects: 0
      },
      locks: {
        activeReaders: safeNum(status['Innodb_row_lock_current_waits']),
        activeWriters: 0,
        queuedReaders: 0,
        queuedWriters: safeNum(status['Table_locks_waited'])
      },
      sql: {
        activeQueries,
        blockedQueries,
        deadlocks: sqlRates.deadlocks,
        cacheHitRate,
        tempBytesWritten: sqlRates.tmpDiskTablesCreated,
        replicationLagMs,
        tableScans: sqlRates.tableScans,
        indexScans: sqlRates.indexScans,
        rowsReturned: sqlRates.rowsReturned,
        rowsModified: sqlRates.rowsModified,
        transactionsCommitted: sqlRates.txCommitted,
        transactionsRolledBack: sqlRates.txRolledBack,
        waitEvents: blockedQueries,
        slowQueries: sqlRates.slowQueries
      }
    });

    await DatabaseService.updateOne({ _id: dbObj._id }, { status: 'online', lastCheck: checkTime, errorMessage: '', ...(mysqlVersion && { version: mysqlVersion }) });

  } catch (error: any) {
    logger.warn(`[DB Engine] Failed to poll MySQL ${dbId}: ${error.message}`);
    await DatabaseService.updateOne({ _id: dbObj._id }, { status: 'error', lastCheck: checkTime, errorMessage: error.message });
  } finally {
    if (conn) await conn.end().catch(() => {});
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
  for (const [dbId, pool] of pgPool.entries()) {
    if (!activeIdStrings.includes(dbId)) {
      await pool.end().catch(() => {});
      pgPool.delete(dbId);
      previousState.delete(dbId);
    }
  }
};