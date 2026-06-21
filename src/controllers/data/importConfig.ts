import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { z } from 'zod';
import { ApmService } from '../../models/Apm';
import { RumService } from '../../models/Rum';
import { TaskService } from '../../models/Task';
import { DatabaseService } from '../../models/Database';
import { Website } from '../../models/Web';
import { Vps } from '../../models/Vps';
import { Monitor } from '../../models/Monitor';
import { AlertDestination, AlertPolicy, AlertCondition, AlertSilence } from '../../models/Alert';
import { SavedView, ViewWidget } from '../../models/View';
import { LogApiKey } from '../../models/Log';
import { McpApiKey } from '../../models/Mcp';
import { Subscription } from '../../models/Subscription';
import { getPlanConfig } from '../../config/pricing';
import { logger } from '../../utils/logger';
import { EXPORT_VERSION } from './exportConfig';

// ============================================================================
// CONFIG IMPORT
// ============================================================================
// Imports configuration from a previously exported JSON file.
// - Validates schema integrity and version compatibility
// - Checks service quotas before creating anything
// - Creates entities in dependency order with fresh IDs and API keys
// - Remaps all cross-references using the _exportId mapping
// - Supports conflict strategy: skip (default), overwrite, duplicate
// ============================================================================

// --- Zod Schemas for Import Validation ---

const ExportIdSchema = z.string().regex(/^[a-z]+_\d+$/, 'Invalid export ID format');

const ApmServiceSchema = z.object({
  _exportId: ExportIdSchema,
  name: z.string().min(1).max(50),
  framework: z.string().max(100).optional().default('unknown'),
});

const RumServiceSchema = z.object({
  _exportId: ExportIdSchema,
  name: z.string().min(1).max(50),
  domains: z.array(z.string().max(253)).min(1).max(10),
  samplingRate: z.number().min(0).max(1).optional().default(1.0),
});

const TaskServiceSchema = z.object({
  _exportId: ExportIdSchema,
  name: z.string().min(1).max(50),
});

const DatabaseServiceSchema = z.object({
  _exportId: ExportIdSchema,
  name: z.string().min(1).max(50),
  type: z.enum(['mongodb', 'postgresql', 'mysql', 'redis']),
  interval: z.number().min(1).max(60).optional().default(5),
});

const WebsiteSchema = z.object({
  _exportId: ExportIdSchema,
  name: z.string().min(1).max(50),
  domain: z.string().min(3).max(253),
});

const ServerSchema = z.object({
  _exportId: ExportIdSchema,
  name: z.string().min(1).max(50),
  metadata: z.object({
    os: z.string().optional(),
    hostname: z.string().optional(),
  }).optional(),
  activeIntegrations: z.object({
    nginx: z.boolean().optional(),
    traefik: z.boolean().optional(),
    terminal: z.boolean().optional(),
  }).optional(),
});

const MonitorSchema = z.object({
  _exportId: ExportIdSchema,
  name: z.string().min(1).max(50),
  url: z.string().url(),
  interval: z.number(),
  method: z.enum(['GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'OPTIONS']).optional().default('GET'),
  headers: z.record(z.string()).optional().default({}),
  body: z.string().max(4096).optional().default(''),
  expectedStatus: z.number().int().min(0).max(599).optional().default(0),
});

const AlertDestinationSchema = z.object({
  _exportId: ExportIdSchema,
  name: z.string().min(1).max(100),
  type: z.enum(['email', 'slack', 'discord', 'webhook']),
  config: z.record(z.any()).default({}),
});

const AlertPolicySchema = z.object({
  _exportId: ExportIdSchema,
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional().default(''),
  destinations: z.array(z.string()).default([]),
});

const AlertConditionSchema = z.object({
  _exportId: ExportIdSchema,
  policyId: z.string(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional().default(''),
  target: z.enum(['apm', 'rum', 'logs', 'task', 'vps', 'database', 'uptime', 'errors', 'runtime', 'web', 'firebase', 'queue', 'ai']),
  query: z.any().default({}),
  threshold: z.object({
    operator: z.enum(['gt', 'lt', 'eq', 'gte', 'lte', 'neq']),
    value: z.number(),
    windowMins: z.number().min(1).max(1440).default(5),
  }),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).default('high'),
  frequency: z.enum(['once', 'always']).default('once'),
  labels: z.array(z.string().max(50)).max(20).default([]),
  isActive: z.boolean().default(true),
});

const AlertSilenceSchema = z.object({
  _exportId: ExportIdSchema,
  name: z.string().min(1).max(100),
  reason: z.string().min(1).max(500),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  scope: z.object({
    policyIds: z.array(z.string()).optional().default([]),
    conditionIds: z.array(z.string()).optional().default([]),
    targets: z.array(z.string()).optional().default([]),
    labels: z.array(z.string()).optional().default([]),
  }).default({}),
});

const ViewSchema = z.object({
  _exportId: ExportIdSchema,
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional().default(''),
  layout: z.array(z.object({
    i: z.string(),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  })).default([]),
});

const ViewWidgetSchema = z.object({
  _exportId: ExportIdSchema.optional(),
  viewId: z.string(),
  name: z.string().min(1).max(100),
  target: z.enum(['apm', 'rum', 'logs', 'task', 'vps', 'database', 'uptime', 'errors', 'runtime', 'web', 'firebase', 'queue', 'ai']),
  query: z.any().default({}),
  visualization: z.enum(['area', 'line', 'bar', 'pie', 'billboard', 'table', 'gauge', 'radar', 'map', 'json']),
  config: z.object({
    aggregate: z.enum(['count', 'avg', 'sum', 'max', 'min']).default('count'),
    aggregateField: z.string().optional(),
    groupBy: z.string().optional(),
  }).default({ aggregate: 'count' }),
});

const McpKeySchema = z.object({
  _exportId: ExportIdSchema,
  name: z.string().min(1).max(100),
});

const ConfigImportPayloadSchema = z.object({
  version: z.string(),
  platform: z.literal('senzops'),
  exportedAt: z.string().datetime(),
  scope: z.enum(['user', 'organization']),
  checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  data: z.object({
    apmServices: z.array(ApmServiceSchema).default([]),
    rumServices: z.array(RumServiceSchema).default([]),
    taskServices: z.array(TaskServiceSchema).default([]),
    databaseServices: z.array(DatabaseServiceSchema).default([]),
    websites: z.array(WebsiteSchema).default([]),
    servers: z.array(ServerSchema).default([]),
    monitors: z.array(MonitorSchema).default([]),
    alertDestinations: z.array(AlertDestinationSchema).default([]),
    alertPolicies: z.array(AlertPolicySchema).default([]),
    alertConditions: z.array(AlertConditionSchema).default([]),
    alertSilences: z.array(AlertSilenceSchema).default([]),
    views: z.array(ViewSchema).default([]),
    viewWidgets: z.array(ViewWidgetSchema).default([]),
    mcpKeys: z.array(McpKeySchema).default([]),
    hasLogApiKey: z.boolean().default(false),
  }),
});

type ConflictStrategy = 'skip' | 'overwrite' | 'duplicate';

// --- Helper: generate API keys per service type ---
const generateApiKey = (prefix: string): string => {
  return `${prefix}_${crypto.randomBytes(24).toString('hex')}`;
};

// --- Helper: verify checksum integrity ---
const verifyChecksum = (data: any, expectedChecksum: string): boolean => {
  const dataString = JSON.stringify(data);
  const computed = `sha256:${crypto.createHash('sha256').update(dataString).digest('hex')}`;
  return computed === expectedChecksum;
};

// --- Quota check helper ---
interface QuotaResult {
  allowed: boolean;
  exceeded: string[];
  currentCounts: Record<string, number>;
  requestedCounts: Record<string, number>;
  maxPerType: number;
}

async function checkServiceQuotas(ownerId: string, importData: any): Promise<QuotaResult> {
  const sub = await Subscription.findOne({ ownerId }).select('planId').lean();
  const plan = getPlanConfig(sub?.planId);

  const MODEL_MAP: Record<string, typeof mongoose.Model> = {
    apmServices: ApmService,
    rumServices: RumService,
    taskServices: TaskService,
    databaseServices: DatabaseService,
    websites: Website,
    servers: Vps,
    monitors: Monitor,
    alertDestinations: AlertDestination,
    alertPolicies: AlertPolicy,
    alertConditions: AlertCondition,
    views: SavedView,
    mcpKeys: McpApiKey,
  };

  const currentCounts: Record<string, number> = {};
  const requestedCounts: Record<string, number> = {};
  const exceeded: string[] = [];

  for (const [key, Model] of Object.entries(MODEL_MAP)) {
    const importCount = (importData[key] || []).length;
    if (importCount === 0) continue;

    requestedCounts[key] = importCount;
    const currentCount = await Model.countDocuments({ ownerId });
    currentCounts[key] = currentCount;

    if (currentCount + importCount > plan.maxServicesPerType) {
      exceeded.push(key);
    }
  }

  return {
    allowed: exceeded.length === 0,
    exceeded,
    currentCounts,
    requestedCounts,
    maxPerType: plan.maxServicesPerType,
  };
}

/**
 * POST /api/data/import/config/preview
 *
 * Dry-run of config import. Validates the file, checks quotas,
 * reports what would be created/skipped without making changes.
 */
export const previewConfigImport = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    if (!ownerId) {
      return res.status(401).json({ error: 'Unauthorized: Missing workspace context.' });
    }

    const orgContext = (req as any).orgContext;
    if (orgContext && !['owner', 'admin'].includes(orgContext.role)) {
      return res.status(403).json({
        error: 'Permission denied.',
        details: 'Only organization owners and admins can import configuration.',
      });
    }

    // --- Integrity check BEFORE Zod parsing ---
    // Zod transforms add defaults which would change JSON.stringify output.
    // Checksum must be verified against the raw body data.
    const rawBody = req.body;
    if (!rawBody?.data || !rawBody?.checksum) {
      return res.status(400).json({
        error: 'Validation failed.',
        details: 'Missing required fields: data, checksum.',
      });
    }

    if (!verifyChecksum(rawBody.data, rawBody.checksum)) {
      return res.status(400).json({
        error: 'Integrity check failed.',
        details: 'The file checksum does not match. The file may have been modified or corrupted.',
      });
    }

    // --- Validate payload (Zod parsing applies defaults) ---
    const parseResult = ConfigImportPayloadSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Validation failed.',
        details: parseResult.error.issues.map(i => ({
          path: i.path,
          message: i.message,
        })),
      });
    }

    const payload = parseResult.data;

    // --- Version check ---
    if (payload.version !== EXPORT_VERSION) {
      return res.status(400).json({
        error: 'Version mismatch.',
        details: `Expected version ${EXPORT_VERSION}, got ${payload.version}. The import file may be from an incompatible version.`,
      });
    }

    // --- Quota check ---
    const quotaResult = await checkServiceQuotas(ownerId, payload.data);

    // --- Check for name conflicts ---
    const conflictStrategy = (req.query.strategy as ConflictStrategy) || 'skip';
    const conflicts: Record<string, string[]> = {};

    const checkConflicts = async (key: string, Model: any, items: any[]) => {
      if (items.length === 0) return;
      const names = items.map(i => i.name);
      const existing = await Model.find({
        ownerId,
        name: { $in: names },
      }).select('name').lean();

      if (existing.length > 0) {
        conflicts[key] = existing.map((e: any) => e.name);
      }
    };

    await Promise.all([
      checkConflicts('apmServices', ApmService, payload.data.apmServices),
      checkConflicts('rumServices', RumService, payload.data.rumServices),
      checkConflicts('taskServices', TaskService, payload.data.taskServices),
      checkConflicts('databaseServices', DatabaseService, payload.data.databaseServices),
      checkConflicts('websites', Website, payload.data.websites),
      checkConflicts('servers', Vps, payload.data.servers),
      checkConflicts('monitors', Monitor, payload.data.monitors),
      checkConflicts('alertDestinations', AlertDestination, payload.data.alertDestinations),
      checkConflicts('alertPolicies', AlertPolicy, payload.data.alertPolicies),
      checkConflicts('views', SavedView, payload.data.views),
    ]);

    // --- Build preview summary ---
    const entityCounts: Record<string, number> = {};
    for (const [key, items] of Object.entries(payload.data)) {
      if (Array.isArray(items)) {
        entityCounts[key] = items.length;
      }
    }

    res.json({
      valid: true,
      version: payload.version,
      exportedAt: payload.exportedAt,
      scope: payload.scope,
      strategy: conflictStrategy,
      entityCounts,
      conflicts: Object.keys(conflicts).length > 0 ? conflicts : null,
      quota: {
        allowed: quotaResult.allowed,
        exceeded: quotaResult.exceeded,
        currentCounts: quotaResult.currentCounts,
        requestedCounts: quotaResult.requestedCounts,
        maxPerType: quotaResult.maxPerType,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/data/import/config
 *
 * Executes config import. Creates all entities with fresh IDs and API keys.
 * Query param ?strategy=skip|overwrite|duplicate controls conflict handling.
 */
export const importConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const userId = (req as any).user?.uid;
    if (!ownerId) {
      return res.status(401).json({ error: 'Unauthorized: Missing workspace context.' });
    }

    const orgContext = (req as any).orgContext;
    if (orgContext && !['owner', 'admin'].includes(orgContext.role)) {
      return res.status(403).json({
        error: 'Permission denied.',
        details: 'Only organization owners and admins can import configuration.',
      });
    }

    // --- Integrity check BEFORE Zod parsing ---
    const rawBody = req.body;
    if (!rawBody?.data || !rawBody?.checksum) {
      return res.status(400).json({
        error: 'Validation failed.',
        details: 'Missing required fields: data, checksum.',
      });
    }

    if (!verifyChecksum(rawBody.data, rawBody.checksum)) {
      return res.status(400).json({
        error: 'Integrity check failed.',
        details: 'The file checksum does not match. The file may have been modified or corrupted.',
      });
    }

    // --- Validate payload (Zod parsing applies defaults) ---
    const parseResult = ConfigImportPayloadSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Validation failed.',
        details: parseResult.error.issues.map(i => ({
          path: i.path,
          message: i.message,
        })),
      });
    }

    const payload = parseResult.data;

    // --- Version check ---
    if (payload.version !== EXPORT_VERSION) {
      return res.status(400).json({
        error: 'Version mismatch.',
        details: `Expected version ${EXPORT_VERSION}, got ${payload.version}.`,
      });
    }

    // --- Quota check ---
    const quotaResult = await checkServiceQuotas(ownerId, payload.data);
    if (!quotaResult.allowed) {
      return res.status(402).json({
        error: 'Service quota exceeded.',
        details: `Importing would exceed your plan limit of ${quotaResult.maxPerType} services per type.`,
        exceeded: quotaResult.exceeded,
        code: 'IMPORT_QUOTA_EXCEEDED',
      });
    }

    const strategy = (req.query.strategy as ConflictStrategy) || 'skip';
    const data = payload.data;

    // --- Import ID mapping: _exportId -> new MongoDB ObjectId ---
    const idMapping: Record<string, string> = {};

    // Tracks results
    const imported: Record<string, number> = {};
    const skipped: Record<string, Array<{ name: string; reason: string }>> = {};
    const apiKeys: Record<string, { name: string; type: string; apiKey: string }> = {};

    // --- Helper: handle conflict resolution ---
    const resolveConflict = async (
      Model: any,
      name: string,
      entityKey: string,
    ): Promise<'create' | 'skip' | 'overwrite'> => {
      const existing = await Model.findOne({ ownerId, name }).lean();
      if (!existing) return 'create';

      switch (strategy) {
        case 'skip':
          if (!skipped[entityKey]) skipped[entityKey] = [];
          skipped[entityKey].push({ name, reason: 'duplicate_name' });
          return 'skip';
        case 'overwrite':
          return 'overwrite';
        case 'duplicate':
          return 'create'; // Will be created with suffix
        default:
          return 'skip';
      }
    };

    // --- Helper: get unique name for duplicate strategy ---
    const getUniqueName = async (Model: any, baseName: string): Promise<string> => {
      if (strategy !== 'duplicate') return baseName;
      const existing = await Model.findOne({ ownerId, name: baseName }).lean();
      if (!existing) return baseName;

      // Find a unique suffix by incrementing a counter
      for (let i = 1; i <= 100; i++) {
        const candidate = i === 1 ? `${baseName} (imported)` : `${baseName} (imported ${i})`;
        const exists = await Model.findOne({ ownerId, name: candidate }).lean();
        if (!exists) return candidate;
      }
      // Fallback: append timestamp
      return `${baseName} (imported ${Date.now()})`;
    };

    // ================================================================
    // PHASE 1: Services (no cross-references)
    // ================================================================

    // --- APM Services ---
    for (const svc of data.apmServices) {
      const action = await resolveConflict(ApmService, svc.name, 'apmServices');
      if (action === 'skip') continue;

      const finalName = await getUniqueName(ApmService, svc.name);
      const newApiKey = generateApiKey('sz_apm');

      if (action === 'overwrite') {
        const existing = await ApmService.findOneAndUpdate(
          { ownerId, name: svc.name },
          { framework: svc.framework },
          { new: true },
        );
        if (existing) {
          idMapping[svc._exportId] = existing._id.toString();
          imported.apmServices = (imported.apmServices || 0) + 1;
          // Don't return key for overwrite (existing key is preserved)
          continue;
        }
      }

      const created = await ApmService.create({
        ownerId,
        name: finalName,
        apiKey: newApiKey,
        framework: svc.framework,
      });

      idMapping[svc._exportId] = created._id.toString();
      imported.apmServices = (imported.apmServices || 0) + 1;
      apiKeys[svc._exportId] = { name: finalName, type: 'apm', apiKey: newApiKey };
    }

    // --- RUM Services ---
    for (const svc of data.rumServices) {
      const action = await resolveConflict(RumService, svc.name, 'rumServices');
      if (action === 'skip') continue;

      const finalName = await getUniqueName(RumService, svc.name);
      const newApiKey = generateApiKey('sz_rum');

      if (action === 'overwrite') {
        const existing = await RumService.findOneAndUpdate(
          { ownerId, name: svc.name },
          { domains: svc.domains, samplingRate: svc.samplingRate },
          { new: true },
        );
        if (existing) {
          idMapping[svc._exportId] = existing._id.toString();
          imported.rumServices = (imported.rumServices || 0) + 1;
          continue;
        }
      }

      const created = await RumService.create({
        ownerId,
        name: finalName,
        domains: svc.domains,
        apiKey: newApiKey,
        samplingRate: svc.samplingRate,
      });

      idMapping[svc._exportId] = created._id.toString();
      imported.rumServices = (imported.rumServices || 0) + 1;
      apiKeys[svc._exportId] = { name: finalName, type: 'rum', apiKey: newApiKey };
    }

    // --- Task Services ---
    for (const svc of data.taskServices) {
      const action = await resolveConflict(TaskService, svc.name, 'taskServices');
      if (action === 'skip') continue;

      const finalName = await getUniqueName(TaskService, svc.name);
      const newApiKey = generateApiKey('sz_task');

      if (action === 'overwrite') {
        const existing = await TaskService.findOneAndUpdate(
          { ownerId, name: svc.name },
          {},
          { new: true },
        );
        if (existing) {
          idMapping[svc._exportId] = existing._id.toString();
          imported.taskServices = (imported.taskServices || 0) + 1;
          continue;
        }
      }

      const created = await TaskService.create({
        ownerId,
        name: finalName,
        apiKey: newApiKey,
      });

      idMapping[svc._exportId] = created._id.toString();
      imported.taskServices = (imported.taskServices || 0) + 1;
      apiKeys[svc._exportId] = { name: finalName, type: 'task', apiKey: newApiKey };
    }

    // --- Database Services (no URI — require user to configure after import) ---
    for (const svc of data.databaseServices) {
      const action = await resolveConflict(DatabaseService, svc.name, 'databaseServices');
      if (action === 'skip') continue;

      const finalName = await getUniqueName(DatabaseService, svc.name);

      if (action === 'overwrite') {
        const existing = await DatabaseService.findOneAndUpdate(
          { ownerId, name: svc.name },
          { type: svc.type, interval: svc.interval },
          { new: true },
        );
        if (existing) {
          idMapping[svc._exportId] = existing._id.toString();
          imported.databaseServices = (imported.databaseServices || 0) + 1;
          continue;
        }
      }

      // Create with a placeholder URI — user must update after import
      const created = await DatabaseService.create({
        ownerId,
        name: finalName,
        type: svc.type,
        encryptedUri: '__PLACEHOLDER_REQUIRES_CONFIGURATION__',
        interval: svc.interval,
        status: 'offline',
      });

      idMapping[svc._exportId] = created._id.toString();
      imported.databaseServices = (imported.databaseServices || 0) + 1;
    }

    // --- Websites ---
    for (const svc of data.websites) {
      const action = await resolveConflict(Website, svc.name, 'websites');
      if (action === 'skip') continue;

      const finalName = await getUniqueName(Website, svc.name);

      if (action === 'overwrite') {
        const existing = await Website.findOneAndUpdate(
          { ownerId, name: svc.name },
          { domain: svc.domain },
          { new: true },
        );
        if (existing) {
          idMapping[svc._exportId] = existing._id.toString();
          imported.websites = (imported.websites || 0) + 1;
          continue;
        }
      }

      const created = await Website.create({
        ownerId,
        name: finalName,
        domain: svc.domain,
      });

      idMapping[svc._exportId] = created._id.toString();
      imported.websites = (imported.websites || 0) + 1;
    }

    // --- Servers (VPS) ---
    for (const svc of data.servers) {
      const action = await resolveConflict(Vps, svc.name, 'servers');
      if (action === 'skip') continue;

      const finalName = await getUniqueName(Vps, svc.name);
      const newApiKey = generateApiKey('sz_vps');

      if (action === 'overwrite') {
        const existing = await Vps.findOneAndUpdate(
          { ownerId, name: svc.name },
          { metadata: svc.metadata, activeIntegrations: svc.activeIntegrations },
          { new: true },
        );
        if (existing) {
          idMapping[svc._exportId] = existing._id.toString();
          imported.servers = (imported.servers || 0) + 1;
          continue;
        }
      }

      const created = await Vps.create({
        ownerId,
        name: finalName,
        apiKey: newApiKey,
        metadata: svc.metadata,
        activeIntegrations: svc.activeIntegrations,
      });

      idMapping[svc._exportId] = created._id.toString();
      imported.servers = (imported.servers || 0) + 1;
      apiKeys[svc._exportId] = { name: finalName, type: 'vps', apiKey: newApiKey };
    }

    // --- Monitors ---
    for (const mon of data.monitors) {
      const action = await resolveConflict(Monitor, mon.name, 'monitors');
      if (action === 'skip') continue;

      const finalName = await getUniqueName(Monitor, mon.name);

      if (action === 'overwrite') {
        const existing = await Monitor.findOneAndUpdate(
          { ownerId, name: mon.name },
          {
            url: mon.url,
            interval: mon.interval,
            method: mon.method,
            headers: mon.headers,
            body: mon.body,
            expectedStatus: mon.expectedStatus,
          },
          { new: true },
        );
        if (existing) {
          idMapping[mon._exportId] = existing._id.toString();
          imported.monitors = (imported.monitors || 0) + 1;
          continue;
        }
      }

      const created = await Monitor.create({
        ownerId,
        name: finalName,
        url: mon.url,
        interval: mon.interval,
        method: mon.method,
        headers: mon.headers,
        body: mon.body,
        expectedStatus: mon.expectedStatus,
        status: 'pending',
        nextCheck: new Date(),
      });

      idMapping[mon._exportId] = created._id.toString();
      imported.monitors = (imported.monitors || 0) + 1;
    }

    // --- MCP Keys ---
    for (const key of data.mcpKeys) {
      const action = await resolveConflict(McpApiKey, key.name, 'mcpKeys');
      if (action === 'skip') continue;

      const finalName = await getUniqueName(McpApiKey, key.name);
      const newApiKey = generateApiKey('sz_mcp');

      if (action === 'overwrite') {
        const existing = await McpApiKey.findOneAndUpdate(
          { ownerId, name: key.name, status: 'active' },
          {},
          { new: true },
        );
        if (existing) {
          idMapping[key._exportId] = existing._id.toString();
          imported.mcpKeys = (imported.mcpKeys || 0) + 1;
          continue;
        }
      }

      const created = await McpApiKey.create({
        ownerId,
        name: finalName,
        key: newApiKey,
        status: 'active',
      });

      idMapping[key._exportId] = created._id.toString();
      imported.mcpKeys = (imported.mcpKeys || 0) + 1;
      apiKeys[key._exportId] = { name: finalName, type: 'mcp', apiKey: newApiKey };
    }

    // ================================================================
    // PHASE 2: Alert Destinations (no cross-references to phase 1)
    // ================================================================
    for (const dest of data.alertDestinations) {
      const action = await resolveConflict(AlertDestination, dest.name, 'alertDestinations');
      if (action === 'skip') continue;

      const finalName = await getUniqueName(AlertDestination, dest.name);

      if (action === 'overwrite') {
        const existing = await AlertDestination.findOneAndUpdate(
          { ownerId, name: dest.name },
          { type: dest.type, config: dest.config },
          { new: true },
        );
        if (existing) {
          idMapping[dest._exportId] = existing._id.toString();
          imported.alertDestinations = (imported.alertDestinations || 0) + 1;
          continue;
        }
      }

      const created = await AlertDestination.create({
        ownerId,
        name: finalName,
        type: dest.type,
        config: dest.config,
      });

      idMapping[dest._exportId] = created._id.toString();
      imported.alertDestinations = (imported.alertDestinations || 0) + 1;
    }

    // ================================================================
    // PHASE 3: Alert Policies (reference destinations)
    // ================================================================
    for (const pol of data.alertPolicies) {
      const action = await resolveConflict(AlertPolicy, pol.name, 'alertPolicies');
      if (action === 'skip') continue;

      const finalName = await getUniqueName(AlertPolicy, pol.name);

      // Remap destination references
      const remappedDestinations = pol.destinations
        .map(destExportId => idMapping[destExportId])
        .filter(Boolean)
        .map(id => new mongoose.Types.ObjectId(id));

      if (action === 'overwrite') {
        const existing = await AlertPolicy.findOneAndUpdate(
          { ownerId, name: pol.name },
          { description: pol.description, destinations: remappedDestinations },
          { new: true },
        );
        if (existing) {
          idMapping[pol._exportId] = existing._id.toString();
          imported.alertPolicies = (imported.alertPolicies || 0) + 1;
          continue;
        }
      }

      const created = await AlertPolicy.create({
        ownerId,
        name: finalName,
        description: pol.description,
        destinations: remappedDestinations,
      });

      idMapping[pol._exportId] = created._id.toString();
      imported.alertPolicies = (imported.alertPolicies || 0) + 1;
    }

    // ================================================================
    // PHASE 4: Alert Conditions (reference policies)
    // ================================================================
    for (const cond of data.alertConditions) {
      const policyMongoId = idMapping[cond.policyId];
      if (!policyMongoId) {
        if (!skipped.alertConditions) skipped.alertConditions = [];
        skipped.alertConditions.push({
          name: cond.name,
          reason: 'missing_policy_reference',
        });
        continue;
      }

      const action = await resolveConflict(AlertCondition, cond.name, 'alertConditions');
      if (action === 'skip') continue;

      const finalName = await getUniqueName(AlertCondition, cond.name);

      if (action === 'overwrite') {
        const existing = await AlertCondition.findOneAndUpdate(
          { ownerId, name: cond.name },
          {
            policyId: new mongoose.Types.ObjectId(policyMongoId),
            description: cond.description,
            target: cond.target,
            query: cond.query,
            threshold: cond.threshold,
            severity: cond.severity,
            frequency: cond.frequency,
            labels: cond.labels,
            isActive: cond.isActive,
          },
          { new: true },
        );
        if (existing) {
          idMapping[cond._exportId] = existing._id.toString();
          imported.alertConditions = (imported.alertConditions || 0) + 1;
          continue;
        }
      }

      const created = await AlertCondition.create({
        ownerId,
        name: finalName,
        policyId: new mongoose.Types.ObjectId(policyMongoId),
        description: cond.description,
        target: cond.target,
        query: cond.query,
        threshold: cond.threshold,
        severity: cond.severity,
        frequency: cond.frequency,
        labels: cond.labels,
        isActive: cond.isActive,
      });

      idMapping[cond._exportId] = created._id.toString();
      imported.alertConditions = (imported.alertConditions || 0) + 1;
    }

    // ================================================================
    // PHASE 5: Alert Silences (reference policies and conditions)
    // ================================================================
    for (const sil of data.alertSilences) {
      const action = await resolveConflict(AlertSilence, sil.name, 'alertSilences');
      if (action === 'skip') continue;

      const finalName = await getUniqueName(AlertSilence, sil.name);

      const remappedScope = {
        policyIds: (sil.scope.policyIds || [])
          .map(id => idMapping[id])
          .filter(Boolean)
          .map(id => new mongoose.Types.ObjectId(id)),
        conditionIds: (sil.scope.conditionIds || [])
          .map(id => idMapping[id])
          .filter(Boolean)
          .map(id => new mongoose.Types.ObjectId(id)),
        targets: sil.scope.targets || [],
        labels: sil.scope.labels || [],
      };

      if (action === 'overwrite') {
        const existing = await AlertSilence.findOneAndUpdate(
          { ownerId, name: sil.name },
          {
            reason: sil.reason,
            startsAt: new Date(sil.startsAt),
            endsAt: new Date(sil.endsAt),
            scope: remappedScope,
          },
          { new: true },
        );
        if (existing) {
          idMapping[sil._exportId] = existing._id.toString();
          imported.alertSilences = (imported.alertSilences || 0) + 1;
          continue;
        }
      }

      const created = await AlertSilence.create({
        ownerId,
        name: finalName,
        reason: sil.reason,
        startsAt: new Date(sil.startsAt),
        endsAt: new Date(sil.endsAt),
        scope: remappedScope,
        createdBy: userId || ownerId,
      });

      idMapping[sil._exportId] = created._id.toString();
      imported.alertSilences = (imported.alertSilences || 0) + 1;
    }

    // ================================================================
    // PHASE 6: Views (no cross-references)
    // ================================================================
    for (const view of data.views) {
      const action = await resolveConflict(SavedView, view.name, 'views');
      if (action === 'skip') continue;

      const finalName = await getUniqueName(SavedView, view.name);

      if (action === 'overwrite') {
        const existing = await SavedView.findOneAndUpdate(
          { ownerId, name: view.name },
          { description: view.description, layout: view.layout },
          { new: true },
        );
        if (existing) {
          idMapping[view._exportId] = existing._id.toString();
          imported.views = (imported.views || 0) + 1;
          continue;
        }
      }

      const created = await SavedView.create({
        ownerId,
        name: finalName,
        description: view.description,
        layout: view.layout,
      });

      idMapping[view._exportId] = created._id.toString();
      imported.views = (imported.views || 0) + 1;
    }

    // ================================================================
    // PHASE 7: View Widgets (reference views)
    // ================================================================
    for (const widget of data.viewWidgets) {
      const viewMongoId = idMapping[widget.viewId];
      if (!viewMongoId) {
        if (!skipped.viewWidgets) skipped.viewWidgets = [];
        skipped.viewWidgets.push({
          name: widget.name,
          reason: 'missing_view_reference',
        });
        continue;
      }

      const created = await ViewWidget.create({
        ownerId,
        viewId: new mongoose.Types.ObjectId(viewMongoId),
        name: widget.name,
        target: widget.target,
        query: widget.query,
        visualization: widget.visualization,
        config: widget.config,
      });

      if (widget._exportId) {
        idMapping[widget._exportId] = created._id.toString();
      }
      imported.viewWidgets = (imported.viewWidgets || 0) + 1;
    }

    // ================================================================
    // PHASE 8: Log API Key (if flagged and not existing)
    // ================================================================
    if (data.hasLogApiKey) {
      const existingKey = await LogApiKey.findOne({ ownerId }).lean();
      if (!existingKey) {
        const newLogKey = generateApiKey('sz_log');
        await LogApiKey.create({ ownerId, key: newLogKey });
        imported.logApiKey = 1;
        apiKeys['logApiKey'] = { name: 'Log Ingestion Key', type: 'log', apiKey: newLogKey };
      } else {
        if (!skipped.logApiKey) skipped.logApiKey = [];
        skipped.logApiKey.push({ name: 'Log Ingestion Key', reason: 'already_exists' });
      }
    }

    // --- Update view layouts to reference new widget IDs ---
    // The layout uses widget ID strings (the `i` field). We need to remap them.
    for (const view of data.views) {
      const viewMongoId = idMapping[view._exportId];
      if (!viewMongoId) continue;

      const updatedLayout = (view.layout || []).map(item => {
        // The layout `i` field should match widget _exportIds
        const newWidgetId = idMapping[item.i];
        return { ...item, i: newWidgetId || item.i };
      });

      await SavedView.findByIdAndUpdate(viewMongoId, { layout: updatedLayout });
    }

    logger.info(`[DataImport] Config imported for ${ownerId}`, { imported, skipped: Object.keys(skipped) });

    res.status(201).json({
      message: 'Configuration imported successfully.',
      imported,
      skipped: Object.keys(skipped).length > 0 ? skipped : null,
      apiKeys,
      idMapping,
      warnings: data.databaseServices.length > 0
        ? ['Database services were imported without connection URIs. Please configure them manually.']
        : [],
    });
  } catch (error) {
    next(error);
  }
};
