// ============================================================================
// Migration: Hashed Multi-Key Log Ingestion Keys
// ----------------------------------------------------------------------------
// Migrates the legacy single-plaintext-key LogApiKey collection to the hashed,
// multi-key, revocable model:
//   1. Drops the old unique indexes (ownerId_1, key_1) that block multi-key.
//   2. Backfills keyHash / prefix / name / scopes / revokedAt on existing records
//      (the legacy plaintext `key` is RETAINED so the pre-Phase-4 modal still
//      works; a later cleanup migration removes it).
//   3. Rebuilds the schema's indexes (keyHash unique-sparse, ownerId, ...).
//
// Existing customer keys keep working throughout — incoming keys are hashed and
// matched against keyHash, and the runtime also self-heals any record the batch
// missed. Connects with autoIndex disabled for deterministic index control.
//
// Usage:  npm run backfill:logkeys
// ============================================================================
import dotenv from 'dotenv';
if (!process.env.MONGO_URI) {
  dotenv.config({ path: 'src/config/.env' });
}

import mongoose from 'mongoose';
import { LogApiKey } from '../models/Log';
import { hashApiKey } from '../utils/hashApiKey';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/senzor';

const run = async () => {
  await mongoose.connect(MONGO_URI, { autoIndex: false });
  console.log('[backfill:logkeys] Connected to MongoDB');

  const coll = LogApiKey.collection;

  // 1. Drop legacy unique indexes that prevent multiple keys per owner.
  const existing = await coll.indexes();
  for (const name of ['ownerId_1', 'key_1']) {
    if (existing.some((ix) => ix.name === name)) {
      await coll.dropIndex(name).then(
        () => console.log(`[backfill:logkeys] Dropped legacy index ${name}`),
        (e) => console.log(`[backfill:logkeys] Skip dropping ${name}: ${e.message}`),
      );
    }
  }

  // 2. Backfill hashed fields on records missing keyHash.
  const cursor = LogApiKey.find({ keyHash: { $exists: false } });
  let migrated = 0;
  let skipped = 0;
  for await (const doc of cursor as any) {
    if (!doc.key) { skipped++; continue; } // can't derive a hash without the plaintext
    doc.keyHash = hashApiKey(doc.key);
    if (!doc.prefix) doc.prefix = doc.key.slice(0, 14);
    if (!doc.name) doc.name = 'Default Key';
    if (!doc.scopes || doc.scopes.length === 0) doc.scopes = ['ingest'];
    if (doc.revokedAt === undefined) doc.revokedAt = null;
    await doc.save();
    migrated++;
  }
  console.log(`[backfill:logkeys] Backfilled ${migrated} key(s)${skipped ? `, skipped ${skipped} without plaintext` : ''}`);

  // 3. Rebuild indexes to match the current schema (creates keyHash unique-sparse
  //    + non-unique ownerId, removes anything stale).
  const synced = await LogApiKey.syncIndexes();
  console.log('[backfill:logkeys] Indexes synced:', synced);

  console.log('[backfill:logkeys] Complete.');
  await mongoose.connection.close();
};

run().catch(async (err) => {
  console.error('[backfill:logkeys] Failed:', err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
