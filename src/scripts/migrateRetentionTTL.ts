// ============================================================================
// Migration: Plan-based Retention TTL
// ----------------------------------------------------------------------------
// Transitions every telemetry collection from fixed per-collection TTLs to the
// unified, per-document plan-based model:
//
//   1. Converts each collection's native anchor TTL index to the HARD_CAP
//      backstop window (via collMod, in place — no drop, no rebuild) so the old
//      short TTLs immediately stop deleting data that higher plans now own.
//   2. Creates the primary `{ expiresAt: 1 }` TTL index (expireAfterSeconds: 0).
//   3. Backfills `expiresAt` on existing documents by reconciling every owner
//      (expiresAt = anchor + plan retention) — reusing the exact same logic the
//      runtime reconciler uses, so historical and live data agree.
//
// Existing data keeps working throughout: until a document has an `expiresAt`,
// the hard-cap backstop bounds it; once backfilled, its plan window applies.
//
// Idempotent and safe to re-run. Connects with autoIndex disabled for
// deterministic index control. Run this immediately on deploy of the
// plan-based-TTL release, BEFORE serving traffic, so the server's autoIndex
// sees a DB that already matches the schema (no index-option conflicts).
//
// Usage:
//   npm run migrate:retention            # apply
//   npm run migrate:retention -- --dry   # report only, no writes
// ============================================================================
import dotenv from 'dotenv';
if (!process.env.MONGO_URI) {
  dotenv.config({ path: 'src/config/.env' });
}

import mongoose from 'mongoose';

import { Subscription } from '../models/Subscription';
import { ApmService } from '../models/Apm';
import { RumService } from '../models/Rum';
import { TaskService } from '../models/Task';
import { DatabaseService } from '../models/Database';
import { FirebaseService } from '../models/Firebase';
import { Website } from '../models/Web';
import { Vps } from '../models/Vps';
import { Monitor, MonitorIncident } from '../models/Monitor';
import { LogEvent } from '../models/Log';
import { McpUsage } from '../models/Mcp';
import { ErrorGroup } from '../models/Error';

import { RETENTION_COLLECTIONS } from '../services/retentionRegistry';
import { reconcileOwnerRetention } from '../services/retentionReconciler';
import { HARD_CAP_SECONDS } from '../config/retention';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/senzor';
const DRY_RUN = process.argv.includes('--dry');

const log = (msg: string) => console.log(`[migrate:retention] ${msg}`);

/**
 * Sets the anchor index's TTL to the hard-cap window in place. Creates the
 * index if it does not yet exist (fresh/empty collections).
 */
async function setHardCapAnchorTtl(collName: string, anchorField: string): Promise<void> {
  const db = mongoose.connection.db!;
  try {
    await db.command({
      collMod: collName,
      index: { keyPattern: { [anchorField]: 1 }, expireAfterSeconds: HARD_CAP_SECONDS },
    });
    log(`  collMod ${collName}.${anchorField} → expireAfterSeconds=${HARD_CAP_SECONDS}`);
  } catch (err: any) {
    // IndexNotFound (27) — the anchor TTL index doesn't exist yet.
    // NamespaceNotFound (26) — the collection itself doesn't exist (fresh DB).
    // In both cases createIndex creates what's needed (and the collection).
    const recoverable =
      err?.code === 27 ||
      err?.code === 26 ||
      /not found|no expireAfterSeconds|index does not exist|ns does not exist/i.test(err?.message || '');
    if (recoverable) {
      await db.collection(collName).createIndex({ [anchorField]: 1 }, { expireAfterSeconds: HARD_CAP_SECONDS });
      log(`  created ${collName}.${anchorField} TTL (expireAfterSeconds=${HARD_CAP_SECONDS})`);
    } else {
      throw err;
    }
  }
}

/** Collects every owner id that could have telemetry to backfill. */
async function collectOwnerIds(): Promise<string[]> {
  const sources: Promise<any[]>[] = [
    Subscription.distinct('ownerId'),
    ApmService.distinct('ownerId'),
    RumService.distinct('ownerId'),
    TaskService.distinct('ownerId'),
    DatabaseService.distinct('ownerId'),
    FirebaseService.distinct('ownerId'),
    Website.distinct('ownerId'),
    Vps.distinct('ownerId'),
    Monitor.distinct('ownerId'),
    LogEvent.distinct('ownerId'),
    McpUsage.distinct('ownerId'),
    ErrorGroup.distinct('ownerId'),
    MonitorIncident.distinct('ownerId'),
  ];
  const results = await Promise.all(sources);
  const set = new Set<string>();
  for (const arr of results) for (const id of arr) if (id) set.add(String(id));
  return [...set];
}

const run = async () => {
  await mongoose.connect(MONGO_URI, { autoIndex: false });
  log(`Connected to MongoDB${DRY_RUN ? ' (DRY RUN — no writes)' : ''}`);

  // --- 1 + 2. Index management per collection ---
  log(`Updating indexes for ${RETENTION_COLLECTIONS.length} collections...`);
  for (const coll of RETENTION_COLLECTIONS) {
    const collName = coll.model.collection.collectionName;
    if (DRY_RUN) {
      log(`  [dry] would set hard-cap TTL on ${collName}.${coll.anchorField} and ensure { expiresAt: 1 } TTL`);
      continue;
    }
    await setHardCapAnchorTtl(collName, coll.anchorField);
    await coll.model.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    log(`  ensured ${collName}.expiresAt TTL (expireAfterSeconds=0)`);
  }

  // --- 3. Backfill expiresAt by reconciling every owner ---
  const ownerIds = await collectOwnerIds();
  log(`Backfilling expiresAt for ${ownerIds.length} owner(s)...`);

  let done = 0;
  for (const ownerId of ownerIds) {
    if (DRY_RUN) {
      done++;
      continue;
    }
    await reconcileOwnerRetention(ownerId);
    done++;
    if (done % 100 === 0) log(`  reconciled ${done}/${ownerIds.length} owners`);
  }
  log(`Backfill complete: ${done} owner(s) processed.`);

  log('Migration complete.');
  await mongoose.connection.close();
};

run().catch(async (err) => {
  console.error('[migrate:retention] Failed:', err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
