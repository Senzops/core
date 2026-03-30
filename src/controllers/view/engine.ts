import { Request, Response, NextFunction } from 'express';
import { ViewWidget } from '../../models/View';

// Import all telemetry models for the Aggregation Engine
import { ApmTrace } from '../../models/Apm';
import { RumTrace } from '../../models/Rum';
import { LogEvent } from '../../models/Log';
import { TaskRun } from '../../models/Task';
import { VpsRun } from '../../models/Vps';
import { DbMetric } from '../../models/Database';
import { MonitorRun } from '../../models/Monitor';

// ============================================================================
//  SAFE AGGREGATION ENGINE
// ============================================================================
export const executeWidgetQuery = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;
    const range = req.query.range as string || '24h';

    // 1. Fetch Widget & Verify Ownership
    const widget = await ViewWidget.findOne({ _id: id, ownerId: uid }).lean();
    if (!widget) return res.status(404).json({ error: "Widget not found" });

    // 2. Determine Time Range
    const now = new Date();
    const startDate = new Date();
    switch (range) {
      case '1h': startDate.setHours(now.getHours() - 1); break;
      case '7d': startDate.setDate(now.getDate() - 7); break;
      case '30d': startDate.setDate(now.getDate() - 30); break;
      case '24h':
      default: startDate.setHours(now.getHours() - 24); break;
    }

    // 3. Map Target to Collection
    let TargetModel;
    let timeField = 'timestamp';
    switch (widget.target) {
      case 'apm': TargetModel = ApmTrace; break;
      case 'rum': TargetModel = RumTrace; break;
      case 'logs': TargetModel = LogEvent; break;
      case 'task': TargetModel = TaskRun; break;
      case 'vps': TargetModel = VpsRun; timeField = 'createdAt'; break;
      case 'database': TargetModel = DbMetric; break;
      case 'uptime': TargetModel = MonitorRun; timeField = 'createdAt'; break;
      default: return res.status(400).json({ error: 'Unknown target' });
    }

    // 4. Build Safe Base Match Query
    const safeMatch: any = {
      ownerId: uid, // STRICT TENANT ISOLATION
      [timeField]: { $gte: startDate }
    };

    // Inject User's Custom MQL Safely
    if (widget.query && typeof widget.query === 'object') {
      const queryStr = JSON.stringify(widget.query);
      // Block malicious NoSQL injection vectors that execute arbitrary code
      if (queryStr.includes('$where') || queryStr.includes('$function')) {
        return res.status(400).json({ error: 'Unsafe operators detected in query' });
      }
      Object.assign(safeMatch, widget.query);
    }

    // 5. Build Aggregation Pipeline
    const pipeline: any[] = [{ $match: safeMatch }];

    const { visualization, config } = widget;

    // Resolve Time Formatting for Grouping
    let timeFormat = "%Y-%m-%dT%H:00:00.000Z";
    if (range === '1h') timeFormat = "%Y-%m-%dT%H:%M:00.000Z";
    else if (range === '7d' || range === '30d') timeFormat = "%Y-%m-%d";

    // Resolve Math Accumulator
    let accumulator: any = { $sum: 1 }; // Default to COUNT
    if (config.aggregate !== 'count' && config.aggregateField) {
      const safeField = config.aggregateField.replace(/^\$/, ''); // Prevent users prefixing with $
      accumulator = { [`$${config.aggregate}`]: `$${safeField}` };
    }

    // --- PIPELINE BUILDER ---
    if (visualization === 'billboard') {
      // Returns a single total/average value
      pipeline.push({
        $group: { _id: null, value: accumulator }
      });
      pipeline.push({ $project: { _id: 0, value: 1 } });
    }
    else if (visualization === 'pie' || visualization === 'table') {
      // Returns categorical lists (e.g. Total Errors grouped by ServiceName)
      const groupByField = config.groupBy ? `$${config.groupBy.replace(/^\$/, '')}` : null;
      if (!groupByField) return res.status(400).json({ error: 'groupBy is required for categorical charts' });

      pipeline.push({
        $group: { _id: groupByField, value: accumulator }
      });
      pipeline.push({ $sort: { value: -1 } });
      pipeline.push({ $limit: 25 });
      pipeline.push({
        $project: { name: { $ifNull: [{ $toString: "$_id" }, "Unknown"] }, value: 1, _id: 0 }
      });
    }
    else {
      // Returns Time-Series arrays (for Line, Area, Bar charts)
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

        // Reformat from { k, v } array back into Recharts-friendly JSON keys
        pipeline.push({
          $replaceRoot: {
            newRoot: { $mergeObjects: [{ time: "$_id" }, { $arrayToObject: "$groups" }] }
          }
        });
      } else {
        // Standard Time Series (No Split)
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

    // 6. Execution
    const data = await TargetModel.aggregate(pipeline);

    res.json({ data });
  } catch (error) {
    next(error);
  }
};