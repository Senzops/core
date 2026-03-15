import mongoose from 'mongoose';
import { CronExpressionParser } from 'cron-parser';
import os from 'os';
import { TaskSignature, TaskService, SystemLock } from '../models/Task';
import { ErrorGroup, ErrorEvent, generateErrorFingerprint } from '../models/Error';
import { logger } from '../utils/logger';

const BATCH_SIZE = 500;
const GRACE_PERIOD_MS = 120_000;
const EARLY_JITTER_MS = 5_000;
const WORKER_ID = `${os.hostname()}-${process.pid}`;
const LOCK_NAME = 'task-watchdog-sweep';
const LOCK_TTL_MS = 4 * 60 * 1000;

export const runTaskWatchdogSweep = async () => {
  const now = new Date();

  try {
    await SystemLock.findOneAndUpdate(
      { lockName: LOCK_NAME },
      { $set: { lockedAt: now, lockedBy: WORKER_ID, expiresAt: new Date(now.getTime() + LOCK_TTL_MS) } },
      { upsert: true, new: true, rawResult: true }
    );
  } catch (lockError: any) {
    if (lockError.code === 11000) {
      logger.debug('[Watchdog] Another pod currently holds the sweep lock. Bypassing.');
      return;
    }
    throw lockError;
  }

  logger.info(`[Watchdog] Sweep started by ${WORKER_ID}...`);
  const startTime = Date.now();

  let missingCount = 0;
  let recoveredCount = 0;

  let signatureUpdates: any[] = [];
  let anomaliesBatch: any[] = [];

  try {
    const services = await TaskService.find({ status: 'online' }).select('_id ownerId name').lean();
    const activeServiceMap = new Map(services.map(s => [s._id.toString(), s]));

    if (activeServiceMap.size === 0) {
      logger.info('[Watchdog] No active services found. Sweep complete.');
      return;
    }

    const cursor = TaskSignature.find({
      taskType: 'cron',
      scheduleExpression: { $exists: true, $ne: null }
    })
      .select('_id taskName serviceId scheduleExpression lastRunAt healthState')
      .lean()
      .cursor();

    const flushBatches = async () => {
      if (signatureUpdates.length > 0) {
        await TaskSignature.bulkWrite(signatureUpdates, { ordered: false });
        signatureUpdates = [];
      }

      if (anomaliesBatch.length > 0) {
        const fingerprints = anomaliesBatch.map(a => a.fingerprint);
        const existingGroups = await ErrorGroup.find({ fingerprint: { $in: fingerprints } }).select('_id fingerprint').lean();
        const existingGroupMap = new Map(existingGroups.map(g => [g.fingerprint, g._id]));

        const groupBulkOps: any[] = [];
        const eventDocs: any[] = [];

        for (const anomaly of anomaliesBatch) {
          let groupId = existingGroupMap.get(anomaly.fingerprint);

          if (groupId) {
            groupBulkOps.push({
              updateOne: {
                filter: { _id: groupId },
                update: { $max: { lastSeen: anomaly.timestamp }, $inc: { totalCount: 1 } }
              }
            });
          } else {
            groupId = new mongoose.Types.ObjectId();
            existingGroupMap.set(anomaly.fingerprint, groupId);

            groupBulkOps.push({
              insertOne: {
                document: {
                  _id: groupId,
                  ownerId: anomaly.service.ownerId,
                  serviceId: anomaly.service._id,
                  serviceModel: 'TaskService',
                  fingerprint: anomaly.fingerprint,
                  errorClass: 'MissedCronRun',
                  message: `Cron Job "${anomaly.sig.taskName}" missed its scheduled execution.`,
                  firstSeen: anomaly.timestamp,
                  lastSeen: anomaly.timestamp,
                  totalCount: 1,
                  status: 'unresolved'
                }
              }
            });
          }

          eventDocs.push({
            groupId: groupId,
            serviceId: anomaly.service._id,
            serviceModel: 'TaskService',
            traceId: `anomaly_${anomaly.sig.taskName}_${anomaly.timestamp.getTime()}`,
            stackTrace: `System Watchdog evaluation failed for ${anomaly.sig.taskName}\nSchedule: ${anomaly.sig.scheduleExpression}\nExpected Execution: ${anomaly.expectedPreviousRun.toISOString()}\nLast Seen: ${anomaly.sig.lastRunAt ? new Date(anomaly.sig.lastRunAt).toISOString() : 'Never'}`,
            context: { expectedPreviousRun: anomaly.expectedPreviousRun, lastRunAt: anomaly.sig.lastRunAt },
            timestamp: anomaly.timestamp
          });
        }

        if (groupBulkOps.length > 0) await ErrorGroup.bulkWrite(groupBulkOps, { ordered: false });
        if (eventDocs.length > 0) await ErrorEvent.insertMany(eventDocs, { ordered: false });

        anomaliesBatch = [];
      }
    };

    for await (const sig of cursor) {
      const serviceIdStr = sig.serviceId.toString();
      const service = activeServiceMap.get(serviceIdStr);

      if (!service || !sig.scheduleExpression) continue;

      try {
        const interval = CronExpressionParser.parse(
          sig.scheduleExpression,
          { currentDate: now }
        );
        const expectedPreviousRun = interval.prev().toDate();
        const expectedWithGrace = new Date(expectedPreviousRun.getTime() + GRACE_PERIOD_MS);
        const expectedMinusJitter = new Date(expectedPreviousRun.getTime() - EARLY_JITTER_MS);

        if (now < expectedWithGrace) continue;

        const hasMissed = !sig.lastRunAt || new Date(sig.lastRunAt) < expectedMinusJitter;

        if (hasMissed) {
          if (sig.healthState !== 'missing') {
            missingCount++;

            signatureUpdates.push({
              updateOne: {
                filter: { _id: sig._id },
                update: { $set: { healthState: 'missing' } }
              }
            });

            // Polymorphic Fingerprint
            const message = `Cron Job "${sig.taskName}" missed its scheduled execution.`;
            const fingerprint = generateErrorFingerprint(service._id, 'MissedCronRun', message);

            anomaliesBatch.push({
              sig, service, fingerprint, expectedPreviousRun, timestamp: now
            });
          }
        } else if (sig.healthState === 'missing') {
          recoveredCount++;
          signatureUpdates.push({
            updateOne: {
              filter: { _id: sig._id },
              update: { $set: { healthState: 'healthy' } }
            }
          });
        }

        if (signatureUpdates.length >= BATCH_SIZE || anomaliesBatch.length >= BATCH_SIZE) {
          await flushBatches();
        }

      } catch (parseError) {
        if (sig.healthState !== 'failing') {
          signatureUpdates.push({
            updateOne: { filter: { _id: sig._id }, update: { $set: { healthState: 'failing' } } }
          });
        }
      }
    }

    await flushBatches();

    const elapsed = Date.now() - startTime;
    logger.info(`[Watchdog] Sweep complete in ${elapsed}ms. Detected ${missingCount} anomalies. Recovered ${recoveredCount} jobs.`);

  } catch (error) {
    logger.error('[Watchdog] Fatal sweep error:', error);
  } finally {
    await SystemLock.findOneAndDelete({ lockName: LOCK_NAME, lockedBy: WORKER_ID }).catch(() => { });
  }
};