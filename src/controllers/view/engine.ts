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

const sanitizeMql = (userQuery: any) => {
  const jsonStr = JSON.stringify(userQuery || {});
  if (jsonStr.includes('$where') || jsonStr.includes('$function')) {
    logger.warn(`[AggEngine] Blocked unsafe operators in query`);
    throw new Error('Unsafe operators detected in query');
  }
  return userQuery || {};
};

// ============================================================================
// CORE PIPELINE BUILDER (Optimized MongoDB Pivot)
// ============================================================================
const buildAndExecutePipeline = async (
  uid: string,
  target: string,
  range: string,
  query: any,
  visualization: string,
  config: any
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
    // Cast to any to bypass Mongoose Union Type signature complexities
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

  if (query && typeof query === 'object') {
    Object.assign(safeMatch, sanitizeMql(query));
  }

  const pipeline: any[] = [{ $match: safeMatch }];

  // 3. Accumulator Formatting
  let accumulator: any = { $sum: 1 };
  if (config.aggregate !== 'count' && config.aggregateField) {
    const safeField = config.aggregateField.replace(/^\$/, ''); // Strip leading $
    accumulator = { [`$${config.aggregate}`]: `$${safeField}` };
  }

  // 4. Visualization Routing
  if (visualization === 'billboard') {
    pipeline.push({ $group: { _id: null, value: accumulator } });
    pipeline.push({ $project: { _id: 0, value: 1 } });
  }
  else if (visualization === 'pie' || (visualization === 'table' && config.groupBy)) {
    const groupByField = config.groupBy ? `$${config.groupBy.replace(/^\$/, '')}` : null;
    if (!groupByField) throw new Error('groupBy is required for categorical charts');

    pipeline.push({ $group: { _id: groupByField, value: accumulator } });
    pipeline.push({ $sort: { value: -1 } });
    pipeline.push({ $limit: 25 });
    pipeline.push({ $project: { name: { $ifNull: [{ $toString: "$_id" }, "Unknown"] }, value: 1, _id: 0 } });
  }
  else if (visualization === 'table' && !config.groupBy) {
    // Flat Table (Raw Documents List)
    pipeline.push({ $sort: { [timeField]: -1 } });
    pipeline.push({ $limit: 100 });
  }
  else {
    // Time-Series (Area, Line, Bar)
    let timeFormat = "%Y-%m-%dT%H:00:00.000Z";
    if (range === '1h') timeFormat = "%Y-%m-%dT%H:%M:00.000Z";
    else if (range === '7d' || range === '30d') timeFormat = "%Y-%m-%d";

    if (config.groupBy) {
      const groupByField = `$${config.groupBy.replace(/^\$/, '')}`;
      pipeline.push({
        $group: {
          _id: {
            time: { $dateToString: { format: timeFormat, date: `$${timeField}` } },
            category: groupByField
          },
          value: accumulator
        }
      });
      pipeline.push({
        $group: {
          _id: "$_id.time",
          groups: { $push: { k: { $ifNull: [{ $toString: "$_id.category" }, "Unknown"] }, v: "$value" } }
        }
      });
      pipeline.push({ $sort: { "_id": 1 } });

      // The optimized arrayToObject pivot
      pipeline.push({
        $replaceRoot: {
          newRoot: { $mergeObjects: [{ time: "$_id" }, { $arrayToObject: "$groups" }] }
        }
      });
    } else {
      pipeline.push({
        $group: {
          _id: { $dateToString: { format: timeFormat, date: `$${timeField}` } },
          value: accumulator
        }
      });
      pipeline.push({ $sort: { "_id": 1 } });
      pipeline.push({ $project: { time: "$_id", value: 1, _id: 0 } });
    }
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

    const data = await buildAndExecutePipeline(
      uid, widget.target, range, widget.query, widget.visualization, widget.config
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
    const { target, query, visualization, config, range = '24h' } = req.body;

    if (!target || !visualization || !config) {
      return res.status(400).json({ error: "Missing required builder parameters" });
    }

    const data = await buildAndExecutePipeline(
      uid, target, range, query, visualization, config
    );

    res.json({ data });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to execute live preview' });
  }
};