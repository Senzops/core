// ============================================================================
// Backfill: Resolve `source` for service-linked logs
// ----------------------------------------------------------------------------
// Service-linked logs (ingested via OTLP) should carry their originating service
// name in `source` so it is both displayed AND queryable (e.g. source:checkout-api).
// Earlier data was stamped with the generic 'external' placeholder; this resolves
// each such log's serviceId → service name and writes it back.
//
// Idempotent: only touches logs that have a serviceId and whose source is missing
// or 'external'. New ingestion already writes the correct source.
//
// Usage:  npm run backfill:logsource
// ============================================================================
import dotenv from 'dotenv';
if (!process.env.MONGO_URI) {
  dotenv.config({ path: 'src/config/.env' });
}

import mongoose from 'mongoose';
import { LogEvent } from '../models/Log';
import { ApmService } from '../models/Apm';
import { RumService } from '../models/Rum';
import { TaskService } from '../models/Task';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/senzor';
const BATCH_SIZE = 1000;

const MODELS: Record<string, mongoose.Model<any>> = {
  ApmService,
  RumService,
  TaskService,
};

const run = async () => {
  await mongoose.connect(MONGO_URI);
  console.log('[backfill:logsource] Connected to MongoDB');

  const filter = {
    serviceId: { $exists: true, $ne: null },
    $or: [{ source: { $exists: false } }, { source: 'external' }],
  };

  const total = await LogEvent.countDocuments(filter as any);
  console.log(`[backfill:logsource] ${total} service-linked log(s) need a resolved source`);
  if (total === 0) {
    await mongoose.connection.close();
    console.log('[backfill:logsource] Nothing to do. Done.');
    return;
  }

  const cursor = LogEvent.find(filter as any)
    .select('_id serviceId serviceModel')
    .lean()
    .cursor({ batchSize: BATCH_SIZE });

  const nameCache = new Map<string, string>(); // serviceId → name
  let ops: any[] = [];
  let processed = 0;
  let resolved = 0;

  const flush = async () => {
    if (ops.length === 0) return;
    await LogEvent.bulkWrite(ops, { ordered: false });
    ops = [];
  };

  for await (const doc of cursor as any) {
    processed++;
    const key = String(doc.serviceId);
    let name = nameCache.get(key);
    if (name === undefined) {
      const Model = MODELS[doc.serviceModel];
      const svc = Model ? await Model.findById(doc.serviceId).select('name').lean() : null;
      const resolvedName: string = ((svc as any)?.name as string) || '';
      nameCache.set(key, resolvedName);
      name = resolvedName;
    }
    if (name) {
      ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { source: name } } } });
      resolved++;
    }
    if (ops.length >= BATCH_SIZE) {
      await flush();
      console.log(`[backfill:logsource] Progress: ${processed}/${total} (resolved ${resolved})`);
    }
  }
  await flush();

  console.log(`[backfill:logsource] Complete. Resolved source on ${resolved}/${processed} log(s).`);
  await mongoose.connection.close();
};

run().catch(async (err) => {
  console.error('[backfill:logsource] Failed:', err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
