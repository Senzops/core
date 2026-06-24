import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { ApmService, ApmTrace, ApmMetric } from '../../models/Apm';
import { RumService, RumTrace, RumMetric } from '../../models/Rum';
import { TaskService, TaskRun, TaskMetric, TaskSignature } from '../../models/Task';
import { DatabaseService, DbMetric } from '../../models/Database';
import { QueueSource, QueueMetric, QueueRollup } from '../../models/Queue';
import { Website, WebEvent, WebEventData, WebMetric } from '../../models/Web';
import { Vps, VpsRun } from '../../models/Vps';
import { Monitor, MonitorRun } from '../../models/Monitor';
import { LogEvent } from '../../models/Log';
import { ErrorGroup, ErrorEvent } from '../../models/Error';
import { RuntimeMetric } from '../../models/RuntimeMetric';
import { AiTrace, AiGeneration, AiMetric, AiScore } from '../../models/Ai';
import { Subscription } from '../../models/Subscription';
import { getPlanConfig } from '../../config/pricing';
import { logger } from '../../utils/logger';

// ============================================================================
// TELEMETRY IMPORT
// ============================================================================
// Imports telemetry data from an NDJSON export file.
// - Validates service ownership before inserting any records
// - Remaps service IDs using a user-provided mapping
// - Skips records that would immediately expire (beyond TTL)
// - Deduplicates by traceId/runId where applicable
// - Batch inserts with ordered: false for resilience
// - Tracks and updates ingestion quota on the subscription
// ============================================================================

// Retention is now plan-based and uniform across telemetry types; imported
// records are gated by the owner's plan window (see retentionMs below) rather
// than fixed per-type TTLs. The `task-signatures` type is persistent.

// --- Timestamp field per type ---
const TIMESTAMP_FIELD_MAP: Record<string, string> = {
  'apm-traces': 'timestamp',
  'apm-metrics': 'timestamp',
  'rum-traces': 'timestamp',
  'rum-metrics': 'timestamp',
  'task-runs': 'timestamp',
  'task-metrics': 'timestamp',
  'task-signatures': 'lastRunAt',
  'db-metrics': 'timestamp',
  'queue-metrics': 'timestamp',
  'queue-rollups': 'timestamp',
  'web-events': 'createdAt',
  'web-event-data': 'createdAt',
  'web-metrics': 'timestamp',
  'vps-runs': 'createdAt',
  'monitor-runs': 'createdAt',
  'logs': 'timestamp',
  'error-groups': 'lastSeen',
  'error-events': 'timestamp',
  'runtime-metrics': 'timestamp',
  'ai-traces': 'timestamp',
  'ai-generations': 'timestamp',
  'ai-metrics': 'timestamp',
  'ai-scores': 'timestamp',
};

// --- Service ID field per type ---
const SERVICE_ID_FIELD_MAP: Record<string, string> = {
  'apm-traces': 'serviceId',
  'apm-metrics': 'serviceId',
  'rum-traces': 'serviceId',
  'rum-metrics': 'serviceId',
  'task-runs': 'serviceId',
  'task-metrics': 'serviceId',
  'task-signatures': 'serviceId',
  'db-metrics': 'dbId',
  'queue-metrics': 'sourceId',
  'queue-rollups': 'sourceId',
  'web-events': 'webId',
  'web-event-data': 'webId',
  'web-metrics': 'webId',
  'vps-runs': 'vpsId',
  'monitor-runs': 'monitorId',
  'logs': 'ownerId',
  'error-groups': 'ownerId',
  'error-events': 'groupId',
  'runtime-metrics': 'serviceId',
  'ai-traces': 'sourceId',
  'ai-generations': 'sourceId',
  'ai-metrics': 'sourceId',
  'ai-scores': 'sourceId',
};

// --- Mongoose model per type ---
function getModelForType(type: string): any {
  const MODEL_MAP: Record<string, any> = {
    'apm-traces': ApmTrace,
    'apm-metrics': ApmMetric,
    'rum-traces': RumTrace,
    'rum-metrics': RumMetric,
    'task-runs': TaskRun,
    'task-metrics': TaskMetric,
    'task-signatures': TaskSignature,
    'db-metrics': DbMetric,
    'queue-metrics': QueueMetric,
    'queue-rollups': QueueRollup,
    'web-events': WebEvent,
    'web-event-data': WebEventData,
    'web-metrics': WebMetric,
    'vps-runs': VpsRun,
    'monitor-runs': MonitorRun,
    'logs': LogEvent,
    'error-groups': ErrorGroup,
    'error-events': ErrorEvent,
    'runtime-metrics': RuntimeMetric,
    'ai-traces': AiTrace,
    'ai-generations': AiGeneration,
    'ai-metrics': AiMetric,
    'ai-scores': AiScore,
  };
  return MODEL_MAP[type] || null;
}

// --- Dedup key field (optional) ---
const DEDUP_FIELD_MAP: Record<string, string> = {
  'apm-traces': 'traceId',
  'rum-traces': 'traceId',
  'task-runs': 'runId',
  'ai-generations': 'generationId',
};

const ImportTelemetrySchema = z.object({
  serviceMapping: z.record(z.string(), z.string()).default({}),
  records: z.array(z.object({
    _type: z.string(),
    _serviceId: z.string().optional(),
    _serviceName: z.string().optional(),
  }).passthrough()).min(1, 'At least one record is required.').max(500000, 'Maximum 500,000 records per import.'),
});

/**
 * POST /api/data/import/telemetry
 *
 * Imports telemetry records from a previously exported dataset.
 * Body: { serviceMapping: { oldId: newId }, records: [...ndjsonRecords] }
 */
export const importTelemetry = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    if (!ownerId) {
      return res.status(401).json({ error: 'Unauthorized: Missing workspace context.' });
    }

    // --- Permission check (owner only for telemetry import) ---
    const orgContext = (req as any).orgContext;
    if (orgContext && orgContext.role !== 'owner') {
      return res.status(403).json({
        error: 'Permission denied.',
        details: 'Only organization owners can import telemetry data.',
      });
    }

    // --- Validate payload ---
    const parseResult = ImportTelemetrySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Validation failed.',
        details: parseResult.error.issues.map(i => ({
          path: i.path,
          message: i.message,
        })),
      });
    }

    const { serviceMapping, records } = parseResult.data;

    // --- Verify ownership of all target service IDs ---
    const targetServiceIds = new Set(Object.values(serviceMapping));
    const verifiedServiceIds = new Set<string>();

    // Verify each target ID exists and belongs to this ownerId by checking all service models
    for (const targetId of targetServiceIds) {
      const serviceModels: mongoose.Model<any>[] = [
        ApmService, RumService, TaskService, DatabaseService, QueueSource, Website, Vps, Monitor,
      ];
      let found = false;

      for (const ServiceModel of serviceModels) {
        const exists = await ServiceModel.findOne({ _id: targetId, ownerId }).select('_id').lean();
        if (exists) {
          verifiedServiceIds.add(targetId);
          found = true;
          break;
        }
      }

      if (!found) {
        return res.status(400).json({
          error: 'Invalid service mapping.',
          details: `Target service ID "${targetId}" does not exist or does not belong to your workspace.`,
        });
      }
    }

    // --- Check ingestion quota ---
    const sub = await Subscription.findOne({ ownerId }).lean();
    const plan = getPlanConfig(sub?.planId);
    // Unified plan-based retention window applied to all imported telemetry.
    const retentionMs = plan.retentionDays * 24 * 60 * 60 * 1000;
    const estimatedBytes = Buffer.byteLength(JSON.stringify(records), 'utf8');
    const currentBytes = sub?.currentMonthBytes || 0;

    if (currentBytes + estimatedBytes > plan.maxIngestionBytes) {
      return res.status(402).json({
        error: 'Ingestion quota exceeded.',
        details: `Importing ${(estimatedBytes / 1024 / 1024).toFixed(1)} MB would exceed your ${plan.name} plan quota.`,
        code: 'IMPORT_QUOTA_EXCEEDED',
        currentUsage: currentBytes,
        importSize: estimatedBytes,
        maxAllowed: plan.maxIngestionBytes,
      });
    }

    // --- Process records ---
    const now = Date.now();
    const results = {
      processed: 0,
      imported: 0,
      skipped: 0,
      failed: 0,
      skipReasons: {} as Record<string, number>,
    };

    // Group records by type for batch insertion
    const batches: Record<string, any[]> = {};

    for (const record of records) {
      results.processed++;
      const type = record._type;

      // Skip header/footer metadata lines
      if (type === '__header__' || type === '__footer__') {
        continue;
      }

      const model = getModelForType(type);
      if (!model) {
        results.skipped++;
        results.skipReasons['unknown_type'] = (results.skipReasons['unknown_type'] || 0) + 1;
        continue;
      }

      // --- Check retention expiry ---
      // task-signatures are persistent (not plan-based); everything else is
      // gated by the owner's plan retention window.
      const isPlanBased = type !== 'task-signatures';
      const tsField = TIMESTAMP_FIELD_MAP[type];
      let anchorMs = now;
      if (isPlanBased) {
        const recordTs = (record as any)[tsField];
        if (recordTs) {
          anchorMs = new Date(recordTs as string).getTime();
          if (now - anchorMs > retentionMs) {
            results.skipped++;
            results.skipReasons['expired'] = (results.skipReasons['expired'] || 0) + 1;
            continue;
          }
        }
      }

      // --- Remap service ID ---
      const svcIdField = SERVICE_ID_FIELD_MAP[type];
      const originalSvcId = (record._serviceId || (record as any)[svcIdField]) as string | undefined;

      // Clean up export metadata fields
      const { _type: _, _serviceId: __, _serviceName: ___, ...cleanRecord } = record as any;

      if (type === 'logs' || type === 'error-groups') {
        // These use ownerId directly
        cleanRecord.ownerId = ownerId;
      } else if (type === 'error-events') {
        // Error events reference groupId — skip remapping (handled separately)
        // They're imported only if their parent groups are also imported
        results.skipped++;
        results.skipReasons['error_events_skipped'] = (results.skipReasons['error_events_skipped'] || 0) + 1;
        continue;
      } else {
        // Remap service ID
        if (originalSvcId && serviceMapping[originalSvcId]) {
          cleanRecord[svcIdField] = new mongoose.Types.ObjectId(serviceMapping[originalSvcId]);
        } else if (originalSvcId && verifiedServiceIds.has(originalSvcId)) {
          // Direct ID (already belongs to this workspace)
          cleanRecord[svcIdField] = new mongoose.Types.ObjectId(originalSvcId);
        } else {
          results.skipped++;
          results.skipReasons['unmapped_service'] = (results.skipReasons['unmapped_service'] || 0) + 1;
          continue;
        }
      }

      // Strip MongoDB internal fields
      delete cleanRecord._id;
      delete cleanRecord.__v;
      delete cleanRecord.createdAt;
      delete cleanRecord.updatedAt;

      // Stamp plan-based expiry anchored on the record's original time field.
      if (isPlanBased) {
        cleanRecord.expiresAt = new Date(anchorMs + retentionMs);
      }

      // Accumulate for batch insert
      if (!batches[type]) batches[type] = [];
      batches[type].push(cleanRecord);
    }

    // --- Batch insert per type ---
    const BATCH_SIZE = 500;

    for (const [type, docs] of Object.entries(batches)) {
      const model = getModelForType(type);
      if (!model || docs.length === 0) continue;

      // Deduplication check
      const dedupField = DEDUP_FIELD_MAP[type];
      let docsToInsert = docs;

      if (dedupField) {
        const dedupValues = docs.map(d => d[dedupField]).filter(Boolean);
        if (dedupValues.length > 0) {
          const svcIdField = SERVICE_ID_FIELD_MAP[type];
          // Get the set of service IDs in this batch
          const batchServiceIds = [...new Set(docs.map(d => d[svcIdField]?.toString()).filter(Boolean))];

          const existing = await model.find({
            [svcIdField]: { $in: batchServiceIds },
            [dedupField]: { $in: dedupValues },
          }).select(dedupField).lean();

          const existingSet = new Set(existing.map((e: any) => e[dedupField]));
          const beforeCount = docsToInsert.length;
          docsToInsert = docsToInsert.filter(d => !existingSet.has(d[dedupField]));

          const dupCount = beforeCount - docsToInsert.length;
          if (dupCount > 0) {
            results.skipped += dupCount;
            results.skipReasons[`duplicate_${dedupField}`] = (results.skipReasons[`duplicate_${dedupField}`] || 0) + dupCount;
          }
        }
      }

      // Insert in batches
      for (let i = 0; i < docsToInsert.length; i += BATCH_SIZE) {
        const batch = docsToInsert.slice(i, i + BATCH_SIZE);
        try {
          const result = await model.insertMany(batch, { ordered: false });
          results.imported += result.length;
        } catch (bulkError: any) {
          // ordered: false means some may succeed even if others fail
          if (bulkError.insertedDocs) {
            results.imported += bulkError.insertedDocs.length;
          }
          const failedCount = batch.length - (bulkError.insertedDocs?.length || 0);
          results.failed += failedCount;
          results.skipReasons['insert_error'] = (results.skipReasons['insert_error'] || 0) + failedCount;
          logger.warn(`[DataImport] Batch insert partial failure for ${type}: ${bulkError.message}`);
        }
      }
    }

    // --- Update ingestion quota ---
    if (results.imported > 0 && sub) {
      await Subscription.findByIdAndUpdate(sub._id, {
        $inc: { currentMonthBytes: estimatedBytes },
      });
    }

    logger.info(`[DataImport] Telemetry imported for ${ownerId}`, results);

    res.status(201).json({
      message: 'Telemetry import completed.',
      ...results,
      bytesIngested: estimatedBytes,
    });
  } catch (error) {
    next(error);
  }
};
