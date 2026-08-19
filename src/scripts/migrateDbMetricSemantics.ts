// ============================================================================
// Migration: MongoDB metric semantics
// ----------------------------------------------------------------------------
// The database depth release changed what two groups of fields MEAN for MongoDB
// instances. Historical documents still hold the old values, and because both
// are plotted on the same axis as the new ones, a chart spanning the deploy
// would render the legacy period at a wildly different scale — flattening the
// corrected data to an invisible line for as long as the owner's retention
// window keeps the old rows (up to 90 days on Enterprise).
//
//   scans.collectionScans / scans.indexScans
//     Was: raw cumulative counters straight off serverStatus.metrics
//          .queryExecutor (values in the billions, only ever rising, and
//          mislabelled — `collectionScans` actually held index keys examined).
//     Now: per-second rates for the interval.
//
//   storage.dataSize / storage.storageSize / storage.indexSize
//     Was: listDatabases.totalSize for the WHOLE CLUSTER reported as both
//          dataSize and storageSize, with indexSize hardcoded to 0.
//     Now: real dbStats figures for the database the connection string targets.
//
// Rather than delete the rows — every other metric in them is still valid —
// this unsets just the affected fields. Aggregations then skip them and the
// legacy window renders as a gap, which is honest, instead of a spike that
// isn't true.
//
// Scoped to MongoDB instances only: PostgreSQL, MySQL and Redis never wrote
// these fields with the old semantics.
//
// Idempotent — re-running finds nothing left to unset.
//
// REPORTING IS THE DEFAULT AND WRITING IS OPT-IN, deliberately.
// `npm run <script> -- --flag` does not reliably forward the flag on every
// platform — on Windows/PowerShell npm drops it silently, so a command that
// reads as a dry run executes for real. With the polarity inverted, a lost
// flag means "did nothing" instead of "rewrote history".
//
// Usage:
//   npm run migrate:dbmetrics          # report only, no writes (default)
//   npm run migrate:dbmetrics:apply    # perform the migration
//
// The apply variant carries the flag inside the package.json script string
// rather than through `--`, so nothing has to survive npm argument passing.
// MIGRATE_APPLY=1 works as an equivalent for CI.
// ============================================================================
import dotenv from 'dotenv';
if (!process.env.MONGO_URI) {
  dotenv.config({ path: 'src/config/.env' });
}

import mongoose from 'mongoose';
import { DatabaseService, DbMetric } from '../models/Database';

const APPLY = process.argv.includes('--apply') || process.env.MIGRATE_APPLY === '1';
const DRY_RUN = !APPLY;

const LEGACY_FIELDS = {
  'scans.collectionScans': '',
  'scans.indexScans': '',
  'storage.dataSize': '',
  'storage.indexSize': '',
  'storage.storageSize': '',
} as const;

const run = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('[migrate:dbmetrics] MONGO_URI is not set.');
    process.exit(1);
  }

  await mongoose.connect(uri, { autoIndex: false });
  console.log(
    DRY_RUN
      ? '[migrate:dbmetrics] connected — REPORT ONLY, no writes. Re-run with npm run migrate:dbmetrics:apply to perform the migration.'
      : '[migrate:dbmetrics] connected — APPLYING migration (writes enabled).'
  );

  // Everything already stored is legacy: the corrected collectors only start
  // writing once the new worker is running, which is after this script.
  const cutoff = new Date();

  const mongoIds = await DatabaseService.find({ type: 'mongodb' }).distinct('_id');
  if (mongoIds.length === 0) {
    console.log('[migrate:dbmetrics] no MongoDB instances registered — nothing to do.');
    await mongoose.disconnect();
    return;
  }
  console.log(`[migrate:dbmetrics] ${mongoIds.length} MongoDB instance(s) in scope`);

  // Only documents that still carry at least one of the affected fields, so a
  // re-run matches nothing and reports zero.
  const filter = {
    dbId: { $in: mongoIds },
    timestamp: { $lt: cutoff },
    $or: Object.keys(LEGACY_FIELDS).map((field) => ({ [field]: { $exists: true } })),
  };

  const affected = await DbMetric.countDocuments(filter);
  console.log(`[migrate:dbmetrics] ${affected} metric document(s) carry legacy values`);

  if (affected === 0) {
    console.log('[migrate:dbmetrics] already migrated.');
    await mongoose.disconnect();
    return;
  }

  if (DRY_RUN) {
    console.log('[migrate:dbmetrics] would unset:', Object.keys(LEGACY_FIELDS).join(', '));
    console.log('[migrate:dbmetrics] no changes written. Run: npm run migrate:dbmetrics:apply');
    await mongoose.disconnect();
    return;
  }

  const result = await DbMetric.updateMany(filter, { $unset: LEGACY_FIELDS });
  console.log(`[migrate:dbmetrics] cleared legacy values on ${result.modifiedCount} document(s)`);

  await mongoose.disconnect();
  console.log('[migrate:dbmetrics] done.');
};

run().catch(async (err) => {
  console.error('[migrate:dbmetrics] failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
