import cron from 'node-cron';
import os from 'os';
import {
  AlertCondition, AlertIncident, AlertPolicy, AlertSilence,
  getNextIncidentNumber, ITimelineEvent
} from '../models/Alert';
import { SystemLock } from '../models/Task';

import { ApmTrace, ApmService } from '../models/Apm';
import { RumTrace, RumService } from '../models/Rum';
import { LogEvent } from '../models/Log';
import { TaskRun, TaskService } from '../models/Task';
import { VpsRun, Vps } from '../models/Vps';
import { DbMetric, DatabaseService } from '../models/Database';
import { FirebaseMetric, FirebaseService } from '../models/Firebase';
import { MonitorRun, Monitor } from '../models/Monitor';
import { ErrorGroup } from '../models/Error';
import { RuntimeMetric } from '../models/RuntimeMetric';
import { WebEvent, Website } from '../models/Web';
import { dispatchAlert } from '../services/alertTransport';
import { enqueueIncidentAnalysis } from '../lib/aiQueue';
import { logger } from '../utils/logger';

const WORKER_ID = `alert-watchdog-${os.hostname()}-${process.pid}`;
const LOCK_NAME = 'alert-watchdog-sweep';
const LOCK_TTL_MS = 55 * 1000;

const BLOCKED_OPERATORS = ['$where', '$function', '$accumulator', '$expr', '$out', '$merge'];

// --- Security: Safe MQL Sanitizer ---
const sanitizeMql = (userQuery: any) => {
  const jsonStr = JSON.stringify(userQuery || {});

  for (const op of BLOCKED_OPERATORS) {
    if (jsonStr.includes(op)) {
      logger.warn(`[Alerts] Blocked malicious MQL operator ${op}: ${jsonStr.slice(0, 200)}`);
      return Array.isArray(userQuery) ? [] : {};
    }
  }

  return userQuery || {};
};

// --- Collection & Parent Router ---
const getTargetModel = (target: string) => {
  switch (target) {
    case 'apm': return { model: ApmTrace, parentModel: ApmService, foreignKey: 'serviceId', timeField: 'timestamp' };
    case 'rum': return { model: RumTrace, parentModel: RumService, foreignKey: 'serviceId', timeField: 'timestamp' };
    case 'logs': return { model: LogEvent, parentModel: null, foreignKey: 'ownerId', timeField: 'timestamp' };
    case 'task': return { model: TaskRun, parentModel: TaskService, foreignKey: 'serviceId', timeField: 'timestamp' };
    case 'vps': return { model: VpsRun, parentModel: Vps, foreignKey: 'vpsId', timeField: 'createdAt' };
    case 'database': return { model: DbMetric, parentModel: DatabaseService, foreignKey: 'dbId', timeField: 'timestamp' };
    case 'uptime': return { model: MonitorRun, parentModel: Monitor, foreignKey: 'monitorId', timeField: 'createdAt' };
    case 'errors': return { model: ErrorGroup, parentModel: null, foreignKey: 'ownerId', timeField: 'lastSeen' };
    case 'runtime': return { model: RuntimeMetric, parentModel: ApmService, foreignKey: 'serviceId', timeField: 'timestamp' };
    case 'web': return { model: WebEvent, parentModel: Website, foreignKey: 'webId', timeField: 'createdAt' };
    case 'firebase': return { model: FirebaseMetric, parentModel: FirebaseService, foreignKey: 'serviceId', timeField: 'timestamp' };
    default: return null;
  }
};

// --- Threshold Evaluation ---
const evaluateThreshold = (count: number, operator: string, value: number): boolean => {
  switch (operator) {
    case 'gt': return count > value;
    case 'lt': return count < value;
    case 'eq': return count === value;
    case 'gte': return count >= value;
    case 'lte': return count <= value;
    case 'neq': return count !== value;
    default: return false;
  }
};

// --- Build Aggregation Pipeline ---
const buildPipeline = async (ownerId: string, target: string, query: any, windowMins: number) => {
  const now = new Date();
  const targetDef = getTargetModel(target);
  if (!targetDef) return null;

  const { model: CollectionModel, parentModel, foreignKey, timeField } = targetDef;
  const windowStart = new Date(now.getTime() - (windowMins * 60 * 1000));

  let tenantIsolationMatch: any = {};
  if (parentModel) {
    const ownedParents = await (parentModel as any).find({ ownerId }).select('_id').lean();
    const ownedIds = ownedParents.map((p: any) => p._id);
    tenantIsolationMatch = { [foreignKey]: { $in: ownedIds } };
  } else {
    tenantIsolationMatch = { [foreignKey]: ownerId };
  }

  const pipeline: any[] = [
    { $match: { ...tenantIsolationMatch, [timeField]: { $gte: windowStart } } }
  ];

  if (parentModel) {
    pipeline.push({
      $lookup: {
        from: parentModel.collection.name,
        localField: foreignKey,
        foreignField: '_id',
        as: 'service'
      }
    });
    pipeline.push({ $unwind: { path: '$service', preserveNullAndEmptyArrays: true } });
  }

  const sanitizedQuery = sanitizeMql(query);
  if (Array.isArray(sanitizedQuery)) {
    if (sanitizedQuery.length > 0) pipeline.push(...sanitizedQuery);
  } else if (sanitizedQuery && Object.keys(sanitizedQuery).length > 0) {
    pipeline.push({ $match: sanitizedQuery });
  }

  pipeline.push({ $count: 'total' });

  return { CollectionModel, pipeline };
};

// --- Check Active Silence Windows ---
const isConditionSilenced = async (condition: any, activeSilences: any[]): Promise<boolean> => {
  if (condition.muteUntil && condition.muteUntil > new Date()) return true;

  for (const silence of activeSilences) {
    const scope = silence.scope || {};

    if (scope.conditionIds?.length > 0 &&
      scope.conditionIds.some((id: any) => id.toString() === condition._id.toString())) {
      return true;
    }

    if (scope.policyIds?.length > 0 &&
      scope.policyIds.some((id: any) => id.toString() === condition.policyId.toString())) {
      return true;
    }

    if (scope.targets?.length > 0 && scope.targets.includes(condition.target)) {
      return true;
    }

    if (scope.labels?.length > 0 &&
      condition.labels?.some((label: string) => scope.labels.includes(label))) {
      return true;
    }

    // Empty scope = global silence
    const hasScope = (scope.conditionIds?.length > 0) ||
      (scope.policyIds?.length > 0) ||
      (scope.targets?.length > 0) ||
      (scope.labels?.length > 0);

    if (!hasScope) return true;
  }

  return false;
};

// --- Notification Dispatcher ---
const triggerNotifications = async (incident: any, condition: any): Promise<boolean> => {
  try {
    const policy = await AlertPolicy.findById(condition.policyId).populate('destinations').lean();
    if (!policy || !policy.destinations || policy.destinations.length === 0) return false;

    const results = await Promise.allSettled(
      policy.destinations.map((dest: any) => dispatchAlert(dest, incident, condition, policy))
    );

    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      logger.warn(`[Alerts] ${failures.length}/${results.length} notification(s) failed for incident ${incident._id}`);
    }

    return failures.length < results.length;
  } catch (err: any) {
    logger.error(`[Alerts] Notification dispatch failed for condition ${condition._id}: ${err.message}`);
    return false;
  }
};

// --- Public: Dry-Run Evaluation (for Test Condition API) ---
export const evaluateConditionDryRun = async (
  ownerId: string,
  target: string,
  query: any,
  threshold: { operator: string; value: number; windowMins: number }
) => {
  const result = await buildPipeline(ownerId, target, query, threshold.windowMins);
  if (!result) return { error: 'Invalid target', count: 0, breached: false };

  const { CollectionModel, pipeline } = result;

  try {
    const aggResult = await CollectionModel.aggregate(pipeline);
    const count = aggResult.length > 0 ? aggResult[0].total : 0;
    const breached = evaluateThreshold(count, threshold.operator, threshold.value);

    return {
      count,
      breached,
      threshold: `${threshold.operator} ${threshold.value}`,
      windowMins: threshold.windowMins,
      evaluatedAt: new Date().toISOString()
    };
  } catch (err: any) {
    return {
      error: `Aggregation failed: ${err.message}`,
      count: 0,
      breached: false
    };
  }
};

// --- Core Evaluation Loop ---
export const runAlertWatchdogSweep = async () => {
  const now = new Date();

  // Distributed Lock
  try {
    await SystemLock.findOneAndUpdate(
      { lockName: LOCK_NAME },
      { $set: { lockedAt: now, lockedBy: WORKER_ID, expiresAt: new Date(now.getTime() + LOCK_TTL_MS) } },
      { upsert: true, new: true, rawResult: true }
    );
  } catch (lockError: any) {
    if (lockError.code === 11000) return;
    throw lockError;
  }

  const startTime = Date.now();
  let evaluated = 0;
  let fired = 0;
  let resolved = 0;
  let silenced = 0;

  try {
    const [activeConditions, activeSilences] = await Promise.all([
      AlertCondition.find({ isActive: true }).lean(),
      AlertSilence.find({ startsAt: { $lte: now }, endsAt: { $gt: now } }).lean()
    ]);

    for (const condition of activeConditions) {
      try {
        evaluated++;

        // Check silence windows and per-condition mutes
        if (await isConditionSilenced(condition, activeSilences)) {
          silenced++;
          continue;
        }

        const result = await buildPipeline(condition.ownerId, condition.target, condition.query, condition.threshold.windowMins);
        if (!result) continue;

        const { CollectionModel, pipeline } = result;
        const aggResult = await CollectionModel.aggregate(pipeline);
        const count = aggResult.length > 0 ? aggResult[0].total : 0;

        const isBreached = evaluateThreshold(count, condition.threshold.operator, condition.threshold.value);

        const openIncident = await AlertIncident.findOne({ conditionId: condition._id, status: { $in: ['open', 'acknowledged'] } });

        if (isBreached) {
          if (!openIncident) {
            // STATE: NORMAL -> FIRED
            const incidentNumber = await getNextIncidentNumber(condition.ownerId);

            const operatorSymbol = ({ gt: '>', lt: '<', eq: '==', gte: '>=', lte: '<=', neq: '!=' } as any)[condition.threshold.operator] || condition.threshold.operator;
            const title = `${condition.name} — ${count} ${operatorSymbol} ${condition.threshold.value} in ${condition.threshold.windowMins}m`;

            const timelineEntry: ITimelineEvent = {
              type: 'fired',
              message: `Alert fired: count ${count} breached threshold (${operatorSymbol} ${condition.threshold.value}) over ${condition.threshold.windowMins}m window`,
              timestamp: now
            };

            const newIncident = await AlertIncident.create({
              ownerId: condition.ownerId,
              policyId: condition.policyId,
              conditionId: condition._id,
              incidentNumber,
              title,
              severity: condition.severity || 'high',
              status: 'open',
              triggerValue: count,
              labels: condition.labels || [],
              timeline: [timelineEntry],
              lastNotifiedAt: now,
              openedAt: now
            });

            fired++;

            const sent = await triggerNotifications(newIncident, condition);
            if (sent) {
              newIncident.timeline.push({
                type: 'notification_sent',
                message: 'Notifications dispatched to policy destinations',
                timestamp: new Date()
              });
            } else {
              newIncident.timeline.push({
                type: 'notification_failed',
                message: 'One or more notification channels failed',
                timestamp: new Date()
              });
            }
            await newIncident.save();

            // Enqueue AI analysis (async, non-blocking, best-effort)
            enqueueIncidentAnalysis({
              incidentId: newIncident._id.toString(),
              ownerId: condition.ownerId,
              conditionName: condition.name,
              conditionDescription: condition.description || '',
              target: condition.target,
              triggerValue: count,
              threshold: condition.threshold,
              severity: condition.severity || 'high',
              labels: condition.labels || [],
              title,
              policyId: condition.policyId.toString(),
              query: condition.query || undefined,
            }).catch(() => { /* non-fatal, already logged inside */ });

          } else {
            // STATE: STILL BREACHED
            openIncident.triggerValue = count;

            if (condition.frequency === 'always') {
              openIncident.lastNotifiedAt = now;
              await triggerNotifications(openIncident, condition);
              openIncident.timeline.push({
                type: 'notification_sent',
                message: `Re-notification sent (frequency=always), current value: ${count}`,
                timestamp: now
              });
            }

            await openIncident.save();
          }
        } else {
          if (openIncident) {
            // STATE: BREACHED -> RESOLVED
            openIncident.status = 'resolved';
            openIncident.resolvedAt = now;
            openIncident.triggerValue = count;
            openIncident.timeline.push({
              type: 'resolved',
              message: `Auto-resolved: count ${count} no longer breaches threshold`,
              timestamp: now
            });

            resolved++;
            const sent = await triggerNotifications(openIncident, condition);
            if (sent) {
              openIncident.timeline.push({
                type: 'notification_sent',
                message: 'Resolution notifications dispatched',
                timestamp: new Date()
              });
            }
            await openIncident.save();
          }
        }

      } catch (conditionError: any) {
        logger.error(`[Alerts] Failed to evaluate condition ${condition._id}: ${conditionError.message}`);
      }
    }

    const elapsed = Date.now() - startTime;
    if (evaluated > 0) {
      logger.info(`[Alerts] Sweep complete in ${elapsed}ms. Evaluated: ${evaluated}, Fired: ${fired}, Resolved: ${resolved}, Silenced: ${silenced}`);
    }

  } catch (err: any) {
    logger.error(`[Alerts] Fatal Sweep Error: ${err.message}`);
  } finally {
    await SystemLock.findOneAndDelete({ lockName: LOCK_NAME, lockedBy: WORKER_ID }).catch(() => { });
  }
};

export const startAlertWatchdog = () => {
  logger.info('[Worker] Alert Evaluation Engine Scheduled');
  cron.schedule('* * * * *', async () => {
    try {
      await runAlertWatchdogSweep();
    } catch (error) {
      logger.error('[Worker] Alert Engine unhandled exception:', error);
    }
  }, {
    name: 'senzor-alert-evaluator',
    timezone: 'UTC'
  });
};
