// ============================================================================
// Migration: Hashed MCP API Keys
// ----------------------------------------------------------------------------
// Migrates the legacy plaintext-key McpApiKey collection to the hashed model:
//   1. Drops the old unique index (key_1) — new keys store no plaintext, so a
//      non-sparse unique index on `key` would collide on the second null.
//   2. Backfills keyHash / prefix from the legacy plaintext `key`, then clears
//      the plaintext so no recoverable secret remains at rest.
//   3. Rebuilds the schema's indexes (keyHash unique-sparse, ownerId).
//
// Existing customer keys keep working throughout — the auth middleware hashes
// incoming keys and matches keyHash, with a legacy plaintext fallback that also
// self-heals any record this batch missed. Idempotent: safe to re-run.
//
// Usage:  npm run backfill:mcpkeys   (run as part of deploy)
// ============================================================================
import dotenv from 'dotenv';
if (!process.env.MONGO_URI) {
  dotenv.config({ path: 'src/config/.env' });
}

import mongoose from 'mongoose';
import { McpApiKey } from '../models/Mcp';
import { hashApiKey } from '../utils/hashApiKey';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/senzor';

const run = async () => {
  await mongoose.connect(MONGO_URI, { autoIndex: false });
  console.log('[backfill:mcpkeys] Connected to MongoDB');

  const coll = McpApiKey.collection;

  // 1. Drop the legacy unique index on the plaintext `key`.
  const existing = await coll.indexes();
  if (existing.some((ix) => ix.name === 'key_1')) {
    await coll.dropIndex('key_1').then(
      () => console.log('[backfill:mcpkeys] Dropped legacy index key_1'),
      (e) => console.log(`[backfill:mcpkeys] Skip dropping key_1: ${e.message}`),
    );
  }

  // 2. Backfill hashed fields from any record still holding a plaintext key,
  //    then clear the plaintext.
  const cursor = McpApiKey.find({ key: { $exists: true, $ne: null } }).select('+key');
  let migrated = 0;
  for await (const doc of cursor as any) {
    if (!doc.key) continue;
    if (!doc.keyHash) doc.keyHash = hashApiKey(doc.key);
    if (!doc.prefix) doc.prefix = doc.key.slice(0, 14);
    doc.key = undefined;
    await doc.save();
    migrated++;
  }
  console.log(`[backfill:mcpkeys] Migrated ${migrated} key(s)`);

  // 3. Rebuild indexes to match the current schema (keyHash unique-sparse + ownerId).
  const synced = await McpApiKey.syncIndexes();
  console.log('[backfill:mcpkeys] Indexes synced:', synced);

  console.log('[backfill:mcpkeys] Complete.');
  await mongoose.connection.close();
};

run().catch(async (err) => {
  console.error('[backfill:mcpkeys] Failed:', err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
