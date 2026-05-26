import mongoose, { Schema, Document } from 'mongoose';

// ---------------------------------------------------------------------------
// Runtime Metrics Model
//
// Stores periodic Node.js runtime health snapshots collected by the APM SDK:
//   - Event loop lag and utilization
//   - Garbage collection frequency and duration
//   - Heap memory usage
//   - Process handle/request counts and CPU usage
//
// Designed for time-series dashboard queries with 1-minute bucketing.
// ---------------------------------------------------------------------------

export interface IRuntimeMetric extends Document {
  serviceId: mongoose.Types.ObjectId;
  timestamp: Date; // 1-minute bucket (seconds/ms zeroed)

  // Event Loop
  eventLoopLagMs: number;
  eventLoopLagP50Ms: number;
  eventLoopLagP99Ms: number;
  eventLoopUtilizationPercent: number;

  // Garbage Collection (aggregated within bucket)
  gcTotalDurationMs: number;
  gcTotalCount: number;
  gcMajorCount: number;
  gcMinorCount: number;

  // Memory
  heapUsedBytes: number;
  heapTotalBytes: number;
  heapUsedPercent: number;
  rssBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;

  // Process
  activeHandles: number;
  activeRequests: number;
  cpuUserUs: number;
  cpuSystemUs: number;
  uptimeSeconds: number;

  // Sample count for averaging within bucket
  sampleCount: number;
}

const RuntimeMetricSchema = new Schema<IRuntimeMetric>({
  serviceId: { type: Schema.Types.ObjectId, ref: 'ApmService', required: true },
  timestamp: { type: Date, required: true },

  // Event Loop
  eventLoopLagMs: { type: Number, default: 0 },
  eventLoopLagP50Ms: { type: Number, default: 0 },
  eventLoopLagP99Ms: { type: Number, default: 0 },
  eventLoopUtilizationPercent: { type: Number, default: 0 },

  // GC
  gcTotalDurationMs: { type: Number, default: 0 },
  gcTotalCount: { type: Number, default: 0 },
  gcMajorCount: { type: Number, default: 0 },
  gcMinorCount: { type: Number, default: 0 },

  // Memory
  heapUsedBytes: { type: Number, default: 0 },
  heapTotalBytes: { type: Number, default: 0 },
  heapUsedPercent: { type: Number, default: 0 },
  rssBytes: { type: Number, default: 0 },
  externalBytes: { type: Number, default: 0 },
  arrayBuffersBytes: { type: Number, default: 0 },

  // Process
  activeHandles: { type: Number, default: 0 },
  activeRequests: { type: Number, default: 0 },
  cpuUserUs: { type: Number, default: 0 },
  cpuSystemUs: { type: Number, default: 0 },
  uptimeSeconds: { type: Number, default: 0 },

  // Tracking
  sampleCount: { type: Number, default: 0 },
}, { timestamps: false });

// Query index: service + time range
RuntimeMetricSchema.index({ serviceId: 1, timestamp: -1 });

// 8-day TTL (matches ApmMetric retention)
RuntimeMetricSchema.index({ timestamp: 1 }, { expireAfterSeconds: 691200 });

export const RuntimeMetric = mongoose.model<IRuntimeMetric>('RuntimeMetric', RuntimeMetricSchema);
