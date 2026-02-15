import mongoose, { Schema, Document } from 'mongoose';

export interface IApmMetric extends Document {
  serviceId: mongoose.Types.ObjectId;
  timestamp: Date; // Minute bucket (e.g. 10:00, 10:01)

  // Golden Signals
  requests: number;
  errorCount: number; // RENAMED: 'errors' conflicts with Mongoose Document property
  durationSum: number;
  durationMax: number;

  // Dimensions (Maps)
  // We use Maps to store counts: { "GET /api": 50, "POST /login": 10 }
  routes: Map<string, number>;
  statusCodes: Map<string, number>;

  // Context
  countries: Map<string, number>;
  browsers: Map<string, number>;
  os: Map<string, number>;
  devices: Map<string, number>;
}

const ApmMetricSchema = new Schema<IApmMetric>({
  serviceId: { type: Schema.Types.ObjectId, ref: 'ApmService', required: true },
  timestamp: { type: Date, required: true },

  requests: { type: Number, default: 0 },
  errorCount: { type: Number, default: 0 }, // RENAMED
  durationSum: { type: Number, default: 0 },
  durationMax: { type: Number, default: 0 },

  routes: { type: Map, of: Number, default: {} },
  statusCodes: { type: Map, of: Number, default: {} },

  countries: { type: Map, of: Number, default: {} },
  browsers: { type: Map, of: Number, default: {} },
  os: { type: Map, of: Number, default: {} },
  devices: { type: Map, of: Number, default: {} },
});

// Compound Index for fast range queries
ApmMetricSchema.index({ serviceId: 1, timestamp: 1 });

// TTL: Keep aggregated stats for 90 days
ApmMetricSchema.index({ timestamp: 1 }, { expireAfterSeconds: 7776000 });

export const ApmMetric = mongoose.model<IApmMetric>('ApmMetric', ApmMetricSchema);