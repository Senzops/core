import mongoose, { Schema, Document } from 'mongoose';

export interface IMcpApiKey extends Document {
  ownerId: string;
  name: string;
  key: string;
  status: 'active' | 'revoked';
  lastUsedAt?: Date;
  createdAt: Date;
}

const McpApiKeySchema = new Schema<IMcpApiKey>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  key: { type: String, required: true, unique: true, index: true },
  status: { type: String, enum: ['active', 'revoked'], default: 'active' },
  lastUsedAt: { type: Date }
}, { timestamps: true });

export const McpApiKey = mongoose.model<IMcpApiKey>('McpApiKey', McpApiKeySchema);

export interface IMcpUsage extends Document {
  ownerId: string;
  timestamp: Date;
  totalQueries: number;
  toolCalls: Map<string, number>;
}

const McpUsageSchema = new Schema<IMcpUsage>({
  ownerId: { type: String, required: true, index: true },
  timestamp: { type: Date, required: true },
  totalQueries: { type: Number, default: 0 },
  toolCalls: { type: Map, of: Number, default: {} }
});

// TTL of 7 days (604800 seconds) for usage metrics to match frontend views
McpUsageSchema.index({ timestamp: 1 }, { expireAfterSeconds: 604800 });
McpUsageSchema.index({ ownerId: 1, timestamp: 1 }, { unique: true });

export const McpUsage = mongoose.model<IMcpUsage>('McpUsage', McpUsageSchema);