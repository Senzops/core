// ============================================================================
// Backfill: Canonical Log Severity
// ----------------------------------------------------------------------------
// Populates the Phase 1 severity fields (severityText, severityNumber) and a
// default `source` on pre-existing LogEvent documents that were written before
// the schema was enriched.
//
// Safe to run repeatedly:
//   - Only touches documents missing `severityText` (idempotent).
//   - Batched bulkWrite, streamed cursor (constant memory at any collection size).
//   - Read-then-write; never deletes. New writes already dual-write these fields,
//     so this only sweeps history.
//
// Usage:  npm run backfill:logs
// ============================================================================
import dotenv from 'dotenv';
if (!process.env.MONGO_URI) {
  dotenv.config({ path: 'src/config/.env' });
}

import mongoose from 'mongoose';
import { LogEvent } from '../models/Log';
import { normalizeSeverity } from '../utils/severity';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/senzor';
const BATCH_SIZE = 1000;

const run = async () => {
  await mongoose.connect(MONGO_URI);
  console.log('[backfill:logs] Connected to MongoDB');

  const filter = { severityText: { $exists: false } };
  const total = await LogEvent.countDocuments(filter);
  console.log(`[backfill:logs] ${total} document(s) need backfilling`);

  if (total === 0) {
    await mongoose.connection.close();
    console.log('[backfill:logs] Nothing to do. Done.');
    return;
  }

  const cursor = LogEvent.find(filter)
    .select('_id level source serviceId')
    .lean()
    .cursor({ batchSize: BATCH_SIZE });

  let ops: any[] = [];
  let processed = 0;

  const flush = async () => {
    if (ops.length === 0) return;
    await LogEvent.bulkWrite(ops, { ordered: false });
    processed += ops.length;
    ops = [];
    console.log(`[backfill:logs] Progress: ${processed}/${total}`);
  };

  for await (const doc of cursor as any) {
    const sev = normalizeSeverity({ level: doc.level });
    const set: Record<string, any> = {
      severityText: sev.severityText,
      severityNumber: sev.severityNumber,
    };
    // Only stamp 'external' on logs with no linked service. Service-linked logs
    // (serviceId set) derive their displayed origin from the service name, so we
    // must not overwrite that with 'external'.
    if (!doc.source && !doc.serviceId) set.source = 'external';

    ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: set } } });
    if (ops.length >= BATCH_SIZE) await flush();
  }
  await flush();

  console.log(`[backfill:logs] Complete. ${processed} document(s) updated.`);
  await mongoose.connection.close();
};

run().catch(async (err) => {
  console.error('[backfill:logs] Failed:', err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
