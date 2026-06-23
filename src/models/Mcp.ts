import mongoose, { Schema, Document } from 'mongoose';
import { applyPlanBasedTtl } from '../utils/ttl';

export interface IMcpApiKey extends Document {
  ownerId: string;
  name: string;
  /**
   * SHA-256 hash of the raw key. The plaintext key is shown to the user exactly
   * once at creation and is never recoverable (GitHub PAT / Stripe model).
   */
  keyHash: string;
  /** First 14 chars of the raw key (e.g. "sz_mcp_ab12cd"), safe to display. */
  prefix: string;
  /**
   * Legacy plaintext key. RETAINED only so keys created before the hashed-key
   * migration keep authenticating; `npm run backfill:mcpkeys` backfills keyHash
   * from this value and clears it. New keys never populate this field.
   */
  key?: string;
  status: 'active' | 'revoked';
  lastUsedAt?: Date;
  createdAt: Date;
}

const McpApiKeySchema = new Schema<IMcpApiKey>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  keyHash: { type: String, unique: true, sparse: true, index: true },
  prefix: { type: String },
  // Legacy plaintext key — not selected by default; never set on new keys.
  key: { type: String, select: false },
  status: { type: String, enum: ['active', 'revoked'], default: 'active' },
  lastUsedAt: { type: Date }
}, { timestamps: true });

export const McpApiKey = mongoose.model<IMcpApiKey>('McpApiKey', McpApiKeySchema);

export interface IMcpUsage extends Document {
  ownerId: string;
  timestamp: Date;
  totalQueries: number;
  toolCalls: Map<string, number>;
  expiresAt?: Date; // Plan-based TTL (anchor: timestamp)
}

const McpUsageSchema = new Schema<IMcpUsage>({
  ownerId: { type: String, required: true, index: true },
  timestamp: { type: Date, required: true },
  totalQueries: { type: Number, default: 0 },
  toolCalls: { type: Map, of: Number, default: {} }
});

// Plan-based retention (per-document expiresAt + hard-cap backstop on timestamp)
applyPlanBasedTtl(McpUsageSchema, 'timestamp');
McpUsageSchema.index({ ownerId: 1, timestamp: 1 }, { unique: true });

export const McpUsage = mongoose.model<IMcpUsage>('McpUsage', McpUsageSchema);