import mongoose, { Schema, Document } from 'mongoose';
import { applyPlanBasedTtl } from '../utils/ttl';

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
  createdAt: Date;
  updatedAt: Date;
}

const DatabaseServiceSchema = new Schema<IDatabaseService>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  type: { type: String, enum: ['mongodb', 'postgresql', 'mysql', 'redis'], required: true },
  encryptedUri: { type: String, required: true },
  interval: { type: Number, default: 5 },
  status: { type: String, enum: ['online', 'offline', 'error'], default: 'offline' },
  lastCheck: { type: Date },
  errorMessage: { type: String },
  version: { type: String }
}, { timestamps: true });

// --- 2. Database Metrics (Time Series) ---
export interface IDbMetric extends Document {
  dbId: mongoose.Types.ObjectId;
  timestamp: Date;
  expiresAt?: Date; // Plan-based TTL (anchor: timestamp)
  throughput: { read: number; write: number; total?: number }; // Added total for Redis
  latency: { read: { avg: number; max: number }; write: { avg: number; max: number }; ping?: number }; // Added ping
  // 1. Health & Uptime
  uptimeSeconds: number;
  
  // 2. Connections
  connections: { current: number; available: number; totalCreated: number };
  
  // 3. Memory (MB)
  memory: { resident: number; virtual: number; mapped?: number };
  
  // 4. Network (Bytes)
  network: { bytesIn: number; bytesOut: number; numRequests: number };
  
  // 5. Operations / Throughput (Counters)
  ops: { insert: number; query: number; update: number; delete: number; command: number };
  
  // 6. Query Executor & Scans
  scans: { collectionScans: number; indexScans: number };
  
  // 7. Disk & Storage (MB) - Usually from dbStats
  storage: { dataSize: number; indexSize: number; storageSize: number; objects: number };
  
  // 8. Locking & Contention (Specific to Mongo's global lock or Postgres locks)
  locks?: { activeReaders: number; activeWriters: number; queuedReaders: number; queuedWriters: number };

  // Redis Specific Metrics
  redis?: {
    keyspaceHits: number;
    keyspaceMisses: number;
    hitRate: number;
    evictedKeys: number;
    expiredKeys: number;
    usedMemoryPeak: number;
    fragmentationRatio: number;
    blockedClients: number;
  };

  // SQL Specific Metrics (PostgreSQL & MySQL)
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
    blockedClients: { type: Number, default: 0 }
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
  }
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