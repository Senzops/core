import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ApmService, ApmTrace, ApmMetric } from '../../models/Apm';
import { RumService, RumTrace, RumMetric } from '../../models/Rum';
import { TaskService, TaskRun, TaskMetric, TaskSignature } from '../../models/Task';
import { DatabaseService, DbMetric } from '../../models/Database';
import { QueueSource, QueueMetric, QueueRollup } from '../../models/Queue';
import { Website, WebEvent, WebMetric } from '../../models/Web';
import { Vps, VpsRun } from '../../models/Vps';
import { Monitor, MonitorRun } from '../../models/Monitor';
import { LogEvent } from '../../models/Log';
import { ErrorGroup, ErrorEvent } from '../../models/Error';
import { RuntimeMetric } from '../../models/RuntimeMetric';
import { Subscription } from '../../models/Subscription';
import { getPlanConfig } from '../../config/pricing';
import { logger } from '../../utils/logger';

// ============================================================================
// TELEMETRY EXPORT
// ============================================================================
// Streams telemetry data as Newline-Delimited JSON (NDJSON).
// Each line is a self-contained JSON object with a _type discriminator.
// Supports selective export by data type, time range, and service filter.
// Uses MongoDB cursors for memory-efficient streaming of large datasets.
// ============================================================================

const VALID_TELEMETRY_TYPES = [
  'apm-traces', 'apm-metrics',
  'rum-traces', 'rum-metrics',
  'task-runs', 'task-metrics', 'task-signatures',
  'db-metrics',
  'queue-metrics', 'queue-rollups',
  'web-events', 'web-metrics',
  'vps-runs',
  'monitor-runs',
  'logs',
  'error-groups', 'error-events',
  'runtime-metrics',
] as const;

type TelemetryType = typeof VALID_TELEMETRY_TYPES[number];

const ExportTelemetrySchema = z.object({
  types: z.array(z.enum(VALID_TELEMETRY_TYPES)).min(1, 'At least one telemetry type is required.'),
  timeRange: z.object({
    start: z.string().datetime(),
    end: z.string().datetime(),
  }),
  serviceIds: z.array(z.string()).optional(),
});

// --- Mapping: service type -> { Model, serviceIdField, parentModel, parentField } ---
interface TelemetryCollectionConfig {
  model: any;
  serviceIdField: string;          // Field name that references the parent service
  timestampField: string;          // Field used for time-range filtering
  parentServiceModel?: any;        // The service registry model (to resolve ownerId -> serviceIds)
  ownerIdDirect?: boolean;         // True if the collection uses ownerId directly (e.g., logs)
}

function buildCollectionConfigs(): Record<TelemetryType, TelemetryCollectionConfig> {
  return {
    'apm-traces': {
      model: ApmTrace,
      serviceIdField: 'serviceId',
      timestampField: 'timestamp',
      parentServiceModel: ApmService,
    },
    'apm-metrics': {
      model: ApmMetric,
      serviceIdField: 'serviceId',
      timestampField: 'timestamp',
      parentServiceModel: ApmService,
    },
    'rum-traces': {
      model: RumTrace,
      serviceIdField: 'serviceId',
      timestampField: 'timestamp',
      parentServiceModel: RumService,
    },
    'rum-metrics': {
      model: RumMetric,
      serviceIdField: 'serviceId',
      timestampField: 'timestamp',
      parentServiceModel: RumService,
    },
    'task-runs': {
      model: TaskRun,
      serviceIdField: 'serviceId',
      timestampField: 'timestamp',
      parentServiceModel: TaskService,
    },
    'task-metrics': {
      model: TaskMetric,
      serviceIdField: 'serviceId',
      timestampField: 'timestamp',
      parentServiceModel: TaskService,
    },
    'task-signatures': {
      model: TaskSignature,
      serviceIdField: 'serviceId',
      timestampField: 'lastRunAt',
      parentServiceModel: TaskService,
    },
    'db-metrics': {
      model: DbMetric,
      serviceIdField: 'dbId',
      timestampField: 'timestamp',
      parentServiceModel: DatabaseService,
    },
    'queue-metrics': {
      model: QueueMetric,
      serviceIdField: 'sourceId',
      timestampField: 'timestamp',
      parentServiceModel: QueueSource,
    },
    'queue-rollups': {
      model: QueueRollup,
      serviceIdField: 'sourceId',
      timestampField: 'timestamp',
      parentServiceModel: QueueSource,
    },
    'web-events': {
      model: WebEvent,
      serviceIdField: 'webId',
      timestampField: 'createdAt',
      parentServiceModel: Website,
    },
    'web-metrics': {
      model: WebMetric,
      serviceIdField: 'webId',
      timestampField: 'timestamp',
      parentServiceModel: Website,
    },
    'vps-runs': {
      model: VpsRun,
      serviceIdField: 'vpsId',
      timestampField: 'createdAt',
      parentServiceModel: Vps,
    },
    'monitor-runs': {
      model: MonitorRun,
      serviceIdField: 'monitorId',
      timestampField: 'createdAt',
      parentServiceModel: Monitor,
    },
    'logs': {
      model: LogEvent,
      serviceIdField: 'ownerId',
      timestampField: 'timestamp',
      ownerIdDirect: true,
    },
    'error-groups': {
      model: ErrorGroup,
      serviceIdField: 'ownerId',
      timestampField: 'lastSeen',
      ownerIdDirect: true,
    },
    'error-events': {
      model: ErrorEvent,
      serviceIdField: 'groupId',
      timestampField: 'timestamp',
      // Special: needs to resolve through ErrorGroup -> ownerId
    },
    'runtime-metrics': {
      model: RuntimeMetric,
      serviceIdField: 'serviceId',
      timestampField: 'timestamp',
      parentServiceModel: ApmService,
    },
  };
}

/**
 * POST /api/data/export/telemetry
 *
 * Streams telemetry data as NDJSON. Each line contains:
 *   { "_type": "apm-traces", "_serviceName": "api-gateway", ...fields }
 *
 * Supports gzip via standard Accept-Encoding negotiation.
 */
export const exportTelemetry = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    if (!ownerId) {
      return res.status(401).json({ error: 'Unauthorized: Missing workspace context.' });
    }

    // --- Permission check ---
    const orgContext = (req as any).orgContext;
    if (orgContext && !['owner', 'admin'].includes(orgContext.role)) {
      return res.status(403).json({
        error: 'Permission denied.',
        details: 'Only organization owners and admins can export telemetry data.',
      });
    }

    // --- Validate request body ---
    const parseResult = ExportTelemetrySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Validation failed.',
        details: parseResult.error.issues.map(i => ({
          path: i.path,
          message: i.message,
        })),
      });
    }

    const { types, timeRange, serviceIds } = parseResult.data;
    const startDate = new Date(timeRange.start);
    const endDate = new Date(timeRange.end);

    // --- Validate time range against retention ---
    const sub = await Subscription.findOne({ ownerId }).select('planId').lean();
    const plan = getPlanConfig(sub?.planId);
    const maxRetentionMs = plan.retentionDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    if (now - startDate.getTime() > maxRetentionMs) {
      return res.status(400).json({
        error: 'Time range exceeds retention period.',
        details: `Your ${plan.name} plan has ${plan.retentionDays}-day retention. Requested start date is outside this window.`,
      });
    }

    if (endDate <= startDate) {
      return res.status(400).json({
        error: 'Invalid time range.',
        details: 'End date must be after start date.',
      });
    }

    const configs = buildCollectionConfigs();

    // --- Pre-resolve all service IDs per type ---
    // Build a map: parentModelName -> [serviceIds] for the workspace
    const serviceIdCache: Record<string, string[]> = {};
    const serviceNameCache: Record<string, string> = {}; // serviceId -> serviceName

    const resolveServiceIds = async (parentModel: any): Promise<string[]> => {
      const cacheKey = parentModel.modelName;
      if (serviceIdCache[cacheKey]) return serviceIdCache[cacheKey];

      let query: any = { ownerId };
      if (serviceIds && serviceIds.length > 0) {
        query._id = { $in: serviceIds };
      }

      const services = await parentModel.find(query).select('_id name').lean();
      const ids = services.map((s: any) => s._id.toString());

      // Cache names for enrichment
      services.forEach((s: any) => {
        serviceNameCache[s._id.toString()] = s.name;
      });

      serviceIdCache[cacheKey] = ids;
      return ids;
    };

    // --- Set up NDJSON streaming response ---
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `senzops-telemetry-${timestamp}.ndjson`;

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Transfer-Encoding', 'chunked');

    // Write header line with metadata
    const headerLine = JSON.stringify({
      _type: '__header__',
      version: '1.0',
      platform: 'senzops',
      exportedAt: new Date().toISOString(),
      scope: orgContext ? 'organization' : 'user',
      types,
      timeRange,
    });
    res.write(headerLine + '\n');

    let totalRecords = 0;

    // --- Stream each requested type sequentially ---
    for (const type of types) {
      const config = configs[type];
      if (!config) continue;

      let query: any = {};

      if (config.ownerIdDirect) {
        // Collections that filter directly by ownerId
        query.ownerId = ownerId;
        query[config.timestampField] = { $gte: startDate, $lte: endDate };
      } else if (type === 'error-events') {
        // Special: error events need to go through error groups
        const groupIds = await ErrorGroup.find({
          ownerId,
          lastSeen: { $gte: startDate, $lte: endDate },
        }).select('_id').lean();

        if (groupIds.length === 0) continue;

        query.groupId = { $in: groupIds.map(g => g._id) };
        query[config.timestampField] = { $gte: startDate, $lte: endDate };
      } else if (config.parentServiceModel) {
        // Collections that filter by serviceId
        const parentIds = await resolveServiceIds(config.parentServiceModel);
        if (parentIds.length === 0) continue;

        query[config.serviceIdField] = { $in: parentIds.map(id => id) };
        if (config.timestampField) {
          query[config.timestampField] = { $gte: startDate, $lte: endDate };
        }
      } else {
        continue;
      }

      // Stream with a cursor for memory efficiency
      const cursor = config.model.find(query).sort({ [config.timestampField]: 1 }).lean().cursor({ batchSize: 500 });

      for await (const doc of cursor) {
        // Enrich with type and service name
        const record: any = {
          _type: type,
        };

        // Add service name if the doc has a service reference
        if (!config.ownerIdDirect && config.serviceIdField) {
          const svcId = doc[config.serviceIdField]?.toString();
          if (svcId && serviceNameCache[svcId]) {
            record._serviceName = serviceNameCache[svcId];
          }
          record._serviceId = svcId;
        }

        // Strip internal fields, keep data fields
        const { _id, __v, ownerId: _, ...fields } = doc;
        Object.assign(record, fields);

        // Convert Map types to plain objects for JSON serialization
        for (const [key, value] of Object.entries(record)) {
          if (value instanceof Map) {
            record[key] = Object.fromEntries(value);
          }
        }

        res.write(JSON.stringify(record) + '\n');
        totalRecords++;

        // Prevent backpressure: yield if buffer is full
        if (res.writableLength > 16 * 1024 * 1024) {
          await new Promise<void>(resolve => {
            if (!res.write('')) {
              res.once('drain', resolve);
            } else {
              resolve();
            }
          });
        }
      }
    }

    // Write footer with summary
    const footerLine = JSON.stringify({
      _type: '__footer__',
      totalRecords,
      completedAt: new Date().toISOString(),
    });
    res.write(footerLine + '\n');

    logger.info(`[DataExport] Telemetry exported for ${ownerId}: ${totalRecords} records across ${types.join(', ')}`);

    res.end();
  } catch (error: any) {
    // If headers already sent, we can't send a JSON error
    if (res.headersSent) {
      logger.error(`[DataExport] Streaming error for telemetry export: ${error.message}`);
      res.end();
    } else {
      next(error);
    }
  }
};
