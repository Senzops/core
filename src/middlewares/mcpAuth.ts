import { Request, Response, NextFunction } from 'express';
import { McpApiKey } from '../models/Mcp';
import { hashApiKey } from '../utils/hashApiKey';
import { logger } from '../utils/logger';

// ============================================================================
// MCP API-Key Authentication
// ----------------------------------------------------------------------------
// Keys are stored hashed (SHA-256) — never in plaintext. Auth resolves the
// owner by hash, with a legacy plaintext fallback (+ inline self-heal) so keys
// created before the hashed-key migration keep working. A 5-minute RAM cache,
// keyed by the key HASH, keeps the hot path off the database. Same model as the
// log-ingestion keys (see controllers/logs/index.ts).
// ============================================================================
const keyCache = new Map<string, { ownerId: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX = 10000;

const cacheSet = (hash: string, ownerId: string) => {
  if (keyCache.size >= CACHE_MAX) {
    const oldest = keyCache.keys().next().value;
    if (oldest !== undefined) keyCache.delete(oldest);
  }
  keyCache.set(hash, { ownerId, expiresAt: Date.now() + CACHE_TTL_MS });
};

/** Evicts a key from the RAM cache (called on revoke). Other instances still
 *  self-expire within CACHE_TTL_MS. */
export const invalidateMcpKeyCache = (keyHash: string) => keyCache.delete(keyHash);

const resolveOwnerId = async (apiKey: string): Promise<string | null> => {
  const now = Date.now();
  const hash = hashApiKey(apiKey);

  const cached = keyCache.get(hash);
  if (cached && cached.expiresAt > now) return cached.ownerId;

  // Primary: hashed lookup (active keys only).
  let record: any = await McpApiKey.findOne({ keyHash: hash, status: 'active' }).lean();

  // Legacy fallback + self-heal: keys created before the hashed-key migration
  // still match on plaintext. Backfill the hash inline so the next lookup takes
  // the fast hashed path even if the batch migration hasn't run yet.
  if (!record) {
    const legacy = await McpApiKey.findOne({ key: apiKey, status: 'active' }).select('+key');
    if (legacy) {
      legacy.keyHash = hash;
      if (!legacy.prefix) legacy.prefix = apiKey.slice(0, 14);
      legacy.key = undefined;
      legacy.save().catch((e) => logger.warn(`[MCP] Key self-heal failed: ${e.message}`));
      record = legacy.toObject();
    }
  }

  if (!record) return null;

  const ownerId = record.ownerId.toString();
  cacheSet(hash, ownerId);

  // Throttled last-used tracking: fires only on a cache miss (≤ once per key per
  // CACHE_TTL_MS), so it never adds write load to the hot path.
  McpApiKey.updateOne({ _id: record._id }, { $set: { lastUsedAt: new Date() } })
    .catch((e) => logger.warn(`[MCP] lastUsedAt update failed: ${e.message}`));

  return ownerId;
};

export const authenticateMcp = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    let apiKey = req.headers['x-mcp-api-key'] as string;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      apiKey = authHeader.substring(7);
    }

    if (!apiKey) {
      return res.status(401).json({ error: 'Missing MCP API Key' });
    }

    const ownerId = await resolveOwnerId(apiKey);
    if (!ownerId) {
      return res.status(403).json({ error: 'Invalid or revoked MCP API Key' });
    }

    // Attach owner context for both legacy (user.uid) and workspace-aware (ownerId) patterns
    (req as any).user = { uid: ownerId };
    (req as any).ownerId = ownerId;

    next();
  } catch (error) {
    logger.error('[MCP Auth Error]', error);
    res.status(500).json({ error: 'Internal server error during MCP authentication' });
  }
};
