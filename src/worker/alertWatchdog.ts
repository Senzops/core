import cron from 'node-cron';
import os from 'os';
import { AlertCondition, AlertIncident, AlertPolicy, AlertDestination } from '../models/Alert';
import { SystemLock } from '../models/Task';

// Import all telemetry models AND their parent service models
import { ApmTrace, ApmService } from '../models/Apm';
import { RumTrace, RumService } from '../models/Rum';
import { LogEvent } from '../models/Log';
import { TaskRun, TaskService } from '../models/Task';
import { VpsRun, Vps } from '../models/Vps';
import { DbMetric, DatabaseService } from '../models/Database';
import { MonitorRun, Monitor } from '../models/Monitor';
import { dispatchAlert } from '../services/alertTransport';
import { logger } from '../utils/logger';

const WORKER_ID = `alert-watchdog-${os.hostname()}-${process.pid}`;
const LOCK_NAME = 'alert-watchdog-sweep';
const LOCK_TTL_MS = 55 * 1000; // 55 seconds (Ensures lock releases before next minute tick)

// --- 1. Security: Safe MQL Sanitizer ---
const sanitizeMql = (userQuery: any) => {
  const jsonStr = JSON.stringify(userQuery || {});

  if (
    jsonStr.includes('$where') ||
    jsonStr.includes('$function') ||
    jsonStr.includes('$accumulator') ||
    jsonStr.includes('$expr') ||
    jsonStr.includes('$out') ||    // Prevent pipeline write injections
    jsonStr.includes('$merge')
  ) {
    logger.warn(`[Alerts] Blocked malicious MQL execution attempt: ${jsonStr}`);
    return Array.isArray(userQuery) ? [] : {};
  }

  return userQuery || {};
};

// --- 2. Collection & Parent Router ---
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

// --- 3. Notification Dispatcher ---
const triggerNotifications = async (incident: any, condition: any) => {
  try {
    const policy = await AlertPolicy.findById(condition.policyId).populate('destinations').lean();
    if (!policy || !policy.destinations || policy.destinations.length === 0) return;

    const dispatchPromises = policy.destinations.map((dest: any) =>
      dispatchAlert(dest, incident, condition, policy)
    );

    await Promise.allSettled(dispatchPromises);
  } catch (err: any) {
    logger.error(`[Alerts] Notification dispatch failed for condition ${condition._id}: ${err.message}`);
  }
};

// --- 4. The Core Evaluation Loop ---
export const runAlertWatchdogSweep = async () => {
  const now = new Date();

  // Cluster-Safe Distributed Lock
  try {
    await SystemLock.findOneAndUpdate(
      { lockName: LOCK_NAME },
      { $set: { lockedAt: now, lockedBy: WORKER_ID, expiresAt: new Date(now.getTime() + LOCK_TTL_MS) } },
      { upsert: true, new: true, rawResult: true }
    );
  } catch (lockError: any) {
    if (lockError.code === 11000) return; // Another worker holds the lock. Silently bypass.
    throw lockError;
  }

  const startTime = Date.now();
  let evaluated = 0;
  let fired = 0;
  let resolved = 0;

  try {
    const activeConditions = await AlertCondition.find({ isActive: true }).lean();

    for (const condition of activeConditions) {
      try {
        evaluated++;
        const targetDef = getTargetModel(condition.target);
        if (!targetDef) continue;

        const { model: CollectionModel, parentModel, foreignKey, timeField } = targetDef;
        const windowStart = new Date(now.getTime() - (condition.threshold.windowMins * 60 * 1000));

        // --- Robust Tenant Isolation ---
        let tenantIsolationMatch: any = {};

        if (parentModel) {
          const ownedParents = await (parentModel as any).find({ ownerId: condition.ownerId }).select('_id').lean();
          const ownedIds = ownedParents.map((p: any) => p._id);
          tenantIsolationMatch = { [foreignKey]: { $in: ownedIds } };
        } else {
          tenantIsolationMatch = { [foreignKey]: condition.ownerId };
        }

        const safeMatch = {
          ...tenantIsolationMatch,
          [timeField]: { $gte: windowStart }
        };

        // --- ENTERPRISE FIX: Pipeline Builder for Alerts ---
        const pipeline: any[] = [{ $match: safeMatch }];

        // Join Parent Service Data
        if (parentModel) {
          pipeline.push({
            $lookup: {
              from: parentModel.collection.name,
              localField: foreignKey,
              foreignField: '_id',
              as: 'service'
            }
          });
          pipeline.push({
            $unwind: {
              path: '$service',
              preserveNullAndEmptyArrays: true
            }
          });
        }

        // Apply User Query/Pipeline
        const sanitizedQuery = sanitizeMql(condition.query);
        if (Array.isArray(sanitizedQuery)) {
          if (sanitizedQuery.length > 0) pipeline.push(...sanitizedQuery);
        } else {
          if (sanitizedQuery && Object.keys(sanitizedQuery).length > 0) {
            pipeline.push({ $match: sanitizedQuery });
          }
        }

        // Execute natively accelerated Count
        pipeline.push({ $count: 'total' });
        const aggResult = await CollectionModel.aggregate(pipeline);
        const count = aggResult.length > 0 ? aggResult[0].total : 0;

        // Evaluate Threshold
        let isBreached = false;
        if (condition.threshold.operator === 'gt') isBreached = count > condition.threshold.value;
        else if (condition.threshold.operator === 'lt') isBreached = count < condition.threshold.value;
        else if (condition.threshold.operator === 'eq') isBreached = count === condition.threshold.value;

        // State Machine Check
        const openIncident = await AlertIncident.findOne({ conditionId: condition._id, status: 'open' });

        if (isBreached) {
          if (!openIncident) {
            // STATE: NORMAL ➔ FIRED
            const newIncident = await AlertIncident.create({
              ownerId: condition.ownerId,
              policyId: condition.policyId,
              conditionId: condition._id,
              status: 'open',
              triggerValue: count,
              openedAt: now
            });
            fired++;
            await triggerNotifications(newIncident, condition);
          } else {
            // STATE: FIRED ➔ STILL FIRED
            openIncident.triggerValue = count;
            await openIncident.save();

            // Suppress noise unless frequency is 'always'
            if (condition.frequency === 'always') {
              await triggerNotifications(openIncident, condition);
            }
          }
        } else {
          if (openIncident) {
            // STATE: FIRED ➔ RESOLVED
            openIncident.status = 'resolved';
            openIncident.resolvedAt = now;
            openIncident.triggerValue = count;
            await openIncident.save();

            resolved++;
            await triggerNotifications(openIncident, condition);
          }
        }

      } catch (conditionError: any) {
        logger.error(`[Alerts] Failed to evaluate condition ${condition._id}: ${conditionError.message}`);
      }
    }

    const elapsed = Date.now() - startTime;
    if (evaluated > 0) {
      logger.info(`[Alerts] Sweep complete in ${elapsed}ms. Evaluated: ${evaluated}, Fired: ${fired}, Resolved: ${resolved}`);
    }

  } catch (err: any) {
    logger.error(`[Alerts] Fatal Sweep Error: ${err.message}`);
  } finally {
    // Release the lock
    await SystemLock.findOneAndDelete({ lockName: LOCK_NAME, lockedBy: WORKER_ID }).catch(() => { });
  }
};

export const startAlertWatchdog = () => {
  logger.info('[Worker] Alert Evaluation Engine Scheduled');
  // Tick every 1 minute
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