import { Request, Response, NextFunction } from 'express';
import { ViewWidget } from '../../models/View';

// Import all telemetry models AND their parent service models
import { ApmTrace, ApmService } from '../../models/Apm';
import { RumTrace, RumService } from '../../models/Rum';
import { LogEvent } from '../../models/Log';
import { TaskRun, TaskService } from '../../models/Task';
import { VpsRun, Vps } from '../../models/Vps';
import { DbMetric, DatabaseService } from '../../models/Database';
import { MonitorRun, Monitor } from '../../models/Monitor';
import { logger } from '../../utils/logger';

// --- Helpers ---
const getTargetModel = (target: string) => {
  switch (target) {
    case 'apm': return { model: ApmTrace, parentModel: ApmService, foreignKey: 'serviceId', timeField: 'timestamp' };
    case 'rum': return { model: RumTrace, parentModel: RumService, foreignKey: 'serviceId', timeField: 'timestamp' };
    case 'logs': return { model: LogEvent, parentModel: null, foreignKey: 'ownerId', timeField: 'timestamp' };
    case 'task': return { model: TaskRun, parentModel: TaskService, foreignKey: 'serviceId', timeField: 'timestamp' };
    case 'vps': return { model: VpsRun, parentModel: Vps, foreignKey: 'vpsId', timeField: 'createdAt' };
    case 'database': return { model: DbMetric, parentModel: DatabaseService, foreignKey: 'dbId', timeField: 'timestamp' };
    case 'uptime': return { model: MonitorRun, parentModel: Monitor, foreignKey: 'monitorId', timeField: 'createdAt' };
    default: return null;
  }
};

// ENTERPRISE SECURITY: Block malicious pipeline write operators
const sanitizeMql = (userQuery: any) => {
  const jsonStr = JSON.stringify(userQuery || {});
  if (
    jsonStr.includes('$where') ||
    jsonStr.includes('$function') ||
    jsonStr.includes('$out') ||     // Block pipeline writes to collections
    jsonStr.includes('$merge')      // Block pipeline merges to collections
  ) {
    logger.warn(`[AggEngine] Blocked unsafe operators in query`);
    throw new Error('Unsafe operators detected in query');
  }
  return userQuery || {};
};

// ============================================================================
// CORE PIPELINE BUILDER (Optimized for Native Pipelines & Service Joins)
// ============================================================================
const buildAndExecutePipeline = async (
  uid: string,
  target: string,
  range: string,
  query: any
) => {
  const targetDef = getTargetModel(target);
  if (!targetDef) throw new Error('Unknown target telemetry');
  const { model: TargetModel, parentModel, foreignKey, timeField } = targetDef;

  // 1. Time Boundary Calculation
  const now = new Date();
  const startDate = new Date();
  switch (range) {
    case '1h': startDate.setHours(now.getHours() - 1); break;
    case '7d': startDate.setDate(now.getDate() - 7); break;
    case '30d': startDate.setDate(now.getDate() - 30); break;
    case '24h':
    default: startDate.setHours(now.getHours() - 24); break;
  }

  // 2. Safe Match Stage & Tenant Isolation
  let tenantIsolationMatch: any = {};

  if (parentModel) {
    // If the telemetry relies on a parent service (APM, VPS, Tasks), 
    // fetch all service IDs owned by this user to verify access.
    const ownedParents = await (parentModel as any).find({ ownerId: uid }).select('_id').lean();
    const ownedIds = ownedParents.map((p: any) => p._id);
    tenantIsolationMatch = { [foreignKey]: { $in: ownedIds } };
  } else {
    // If the telemetry has native ownerId (Logs), query it directly.
    tenantIsolationMatch = { [foreignKey]: uid };
  }

  const safeMatch: any = {
    ...tenantIsolationMatch,
    [timeField]: { $gte: startDate }
  };

  // 3. Pipeline Construction Base
  const pipeline: any[] = [{ $match: safeMatch }];

  // 4. ENTERPRISE FIX: Dynamic Service Collection Join
  // If the target has a parent model, we dynamically map the foreign key to the parent collection
  // and unwind it into a `service` object. This makes `service.name` natively queryable in the MQL.
  if (parentModel) {
    pipeline.push({
      $lookup: {
        from: parentModel.collection.name,
        localField: foreignKey,
        foreignField: '_id',
        as: 'service'
      }
    });
    // Unwind converts the joined array into a single object, allowing direct dot-notation
    pipeline.push({
      $unwind: {
        path: '$service',
        preserveNullAndEmptyArrays: true // Prevents dropping events if the service was deleted
      }
    });
  }

  // 5. User Pipeline/Query Execution
  const sanitizedQuery = sanitizeMql(query);

  if (Array.isArray(sanitizedQuery)) {
    // PIPELINE MODE: User supplied a custom aggregation pipeline array `[...]`
    if (sanitizedQuery.length > 0) {
      pipeline.push(...sanitizedQuery);
    }
  } else {
    // SIMPLE QUERY MODE: Fallback for standard query objects `{...}`
    if (sanitizedQuery && Object.keys(sanitizedQuery).length > 0) {
      pipeline.push({ $match: sanitizedQuery });
    }
    // Apply standard sorts and bounds to prevent massive payloads for non-aggregated flat queries
    pipeline.push({ $sort: { [timeField]: -1 } });
    pipeline.push({ $limit: 100 });
  }

  return await TargetModel.aggregate(pipeline);
};

// ============================================================================
// ENDPOINT 1: FETCH SAVED WIDGET DATA (For the Dashboard Canvas)
// ============================================================================
export const getWidgetData = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;
    const range = req.query.range as string || '24h';

    const widget = await ViewWidget.findOne({ _id: id, ownerId: uid }).lean();
    if (!widget) return res.status(404).json({ error: "Widget not found" });

    // Execute the unified pipeline execution engine
    const data = await buildAndExecutePipeline(
      uid, widget.target, range, widget.query
    );

    res.json({ data });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to fetch widget data' });
  }
};

// ============================================================================
// ENDPOINT 2: LIVE PREVIEW EXECUTION (For the Widget Builder UI)
// ============================================================================
export const executeLivePreview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { target, query, range = '24h' } = req.body;

    if (!target) {
      return res.status(400).json({ error: "Missing required builder parameters" });
    }

    const data = await buildAndExecutePipeline(
      uid, target, range, query
    );

    res.json({ data });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to execute live preview' });
  }
};