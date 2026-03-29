import cron from 'node-cron';
import os from 'os';
import { AlertCondition, AlertIncident, AlertPolicy, AlertDestination } from '../models/Alert';
import { SystemLock } from '../models/Task';
import { ApmTrace } from '../models/Apm';
import { RumTrace } from '../models/Rum';
import { LogEvent } from '../models/Log';
import { TaskRun } from '../models/Task';
import { VpsRun } from '../models/Vps';
import { DbMetric } from '../models/Database';
import { MonitorRun } from '../models/Monitor';
import { dispatchAlert } from '../services/alertTransport';
import { logger } from '../utils/logger';

const WORKER_ID = `alert-watchdog-${os.hostname()}-${process.pid}`;
const LOCK_NAME = 'alert-watchdog-sweep';
const LOCK_TTL_MS = 55 * 1000; // 55 seconds (Ensures lock releases before next minute tick)

// --- 1. Security: Safe MQL Sanitizer ---
const sanitizeMql = (userQuery: any) => {
  const jsonStr = JSON.stringify(userQuery || {});

  // Aggressively block MongoDB execution/script injection operators
  if (
    jsonStr.includes('$where') ||
    jsonStr.includes('$function') ||
    jsonStr.includes('$accumulator') ||
    jsonStr.includes('$expr')
  ) {
    logger.warn(`[Alerts] Blocked malicious MQL execution attempt: ${jsonStr}`);
    return {}; // Revert to empty query if malicious
  }

  return userQuery || {};
};

// --- 2. Collection Router ---
const getCollectionForTarget = (target: string) => {
  switch (target) {
    case 'apm': return ApmTrace;
    case 'rum': return RumTrace;
    case 'logs': return LogEvent;
    case 'task': return TaskRun;
    case 'vps': return VpsRun;
    case 'database': return DbMetric;
    case 'uptime': return MonitorRun;
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
    if (lockError.code === 11000) {
      // Another worker holds the lock. Silently bypass.
      return;
    }
    throw lockError;
  }

  const startTime = Date.now();
  let evaluated = 0;
  let fired = 0;
  let resolved = 0;

  try {
    // Fetch all Active Conditions
    const activeConditions = await AlertCondition.find({ isActive: true }).lean();

    for (const condition of activeConditions) {
      try {
        evaluated++;
        const CollectionModel = getCollectionForTarget(condition.target);
        if (!CollectionModel) continue;

        // Determine correct time field based on model
        const timeField = ['vps', 'uptime'].includes(condition.target) ? 'createdAt' : 'timestamp';

        // Calculate Time Window Lookback
        const windowStart = new Date(now.getTime() - (condition.threshold.windowMins * 60 * 1000));

        // Construct the strictly isolated MQL Sandbox
        const safeQuery = {
          $and: [
            { ownerId: condition.ownerId }, // Absolutely enforce tenant isolation
            { [timeField]: { $gte: windowStart } }, // Enforce time window
            sanitizeMql(condition.query) // Inject user query securely
          ]
        };

        // Execute count
        const count = await CollectionModel.countDocuments(safeQuery);

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