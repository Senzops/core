import crypto from 'crypto';
import { CronExpressionParser } from 'cron-parser';
import { TaskSignature, TaskService } from '../models/Task';
import { ApmErrorGroup, ApmErrorEvent } from '../models/ApmError';
import { logger } from '../utils/logger';

// --- Production Configuration ---
const BATCH_SIZE = 500;
const GRACE_PERIOD_MS = 120_000; // 2 minutes grace period for event loop lag or queue delay
const EARLY_JITTER_MS = 5_000;   // 5 seconds allowance if a cron fires slightly early

// Concurrency Lock: Prevents the worker from starting a new sweep if the previous one is still processing 100k+ records
let isSweeping = false;

/**
 * Sweeps the database looking for Cron Jobs that have missed their execution windows.
 * Optimized with lean cursors and bulk writes for high-throughput environments.
 */
export const runTaskWatchdogSweep = async () => {
  if (isSweeping) {
    logger.warn('[Watchdog] Previous sweep still processing. Skipping this cycle to prevent DB contention.');
    return;
  }

  isSweeping = true;
  logger.info('[Watchdog] Starting Task Signature evaluation sweep...');
  const startTime = Date.now();

  let missingCount = 0;
  let recoveredCount = 0;

  // DB Write Buffers
  let signatureUpdates: any[] = [];
  let newErrorEvents: any[] = [];

  try {
    const now = new Date();

    // 1. Use Lean Cursor for Memory Efficiency on massive datasets
    const cursor = TaskSignature.find({
      taskType: 'cron',
      scheduleExpression: { $exists: true, $ne: null }
    })
      .populate('serviceId', 'name status ownerId')
      .lean()
      .cursor();

    const flushBatches = async () => {
      if (signatureUpdates.length > 0) {
        await TaskSignature.bulkWrite(signatureUpdates);
        signatureUpdates = [];
      }
      if (newErrorEvents.length > 0) {
        await ApmErrorEvent.insertMany(newErrorEvents);
        newErrorEvents = [];
      }
    };

    for await (const sig of cursor) {
      const service = sig.serviceId as any;

      // Skip if service was deleted, lacks expression, or the entire server is offline (prevents alert storms)
      if (!service || !sig.scheduleExpression || service.status !== 'online') {
        continue;
      }

      try {
        // Find the *last* time this was supposed to run strictly prior to `now`
        const interval = CronExpressionParser.parse(
          sig.scheduleExpression,
          { currentDate: now }
        );
        const expectedPreviousRun = interval.prev().toDate();

        // Calculate realistic operational boundaries
        const expectedWithGrace = new Date(expectedPreviousRun.getTime() + GRACE_PERIOD_MS);
        const expectedMinusJitter = new Date(expectedPreviousRun.getTime() - EARLY_JITTER_MS);

        // If we are currently inside the grace period, we cannot confidently call it missing yet.
        if (now < expectedWithGrace) {
          continue;
        }

        // It missed the schedule if it has never run, or its last run was before the expected window
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

            // Generate Deterministic Error Fingerprint
            const fingerprint = crypto
              .createHash('sha256')
              .update(`MissedCronRun:${sig.taskName}:${service._id}`)
              .digest('hex');

            // Upsert Error Group sequentially (optimized to only fire once per anomaly transition)
            const groupDoc = await ApmErrorGroup.findOneAndUpdate(
              { ownerId: service.ownerId, fingerprint },
              {
                $setOnInsert: {
                  ownerId: service.ownerId,
                  serviceType: 'task',
                  taskServiceId: service._id,
                  fingerprint,
                  errorClass: 'MissedCronRun',
                  message: `Cron Job "${sig.taskName}" missed its scheduled execution.`,
                  firstSeen: now,
                  status: 'unresolved'
                },
                $max: { lastSeen: now },
                $inc: { totalCount: 1 }
              },
              { upsert: true, new: true }
            );

            // Queue Event payload for bulk insert
            if (groupDoc) {
              newErrorEvents.push({
                groupId: groupDoc._id,
                serviceType: 'task',
                taskServiceId: service._id,
                traceId: `anomaly_${sig.taskName}_${now.getTime()}`,
                stackTrace: `System Watchdog evaluation failed for ${sig.taskName}\nSchedule: ${sig.scheduleExpression}\nExpected Execution: ${expectedPreviousRun.toISOString()}\nLast Seen: ${sig.lastRunAt ? new Date(sig.lastRunAt).toISOString() : 'Never'}`,
                context: { expectedPreviousRun, lastRunAt: sig.lastRunAt },
                timestamp: now
              });
            }
          }
        } else {
          // It ran successfully within the window
          if (sig.healthState === 'missing') {
            recoveredCount++;
            signatureUpdates.push({
              updateOne: {
                filter: { _id: sig._id },
                update: { $set: { healthState: 'healthy' } }
              }
            });
          }
        }

        // Auto-flush memory buffers if batch size is reached
        if (signatureUpdates.length >= BATCH_SIZE || newErrorEvents.length >= BATCH_SIZE) {
          await flushBatches();
        }

      } catch (parseError) {
        // Gracefully handle invalid cron expressions (prevents full sweep crash)
        if (sig.healthState !== 'failing') {
          signatureUpdates.push({
            updateOne: {
              filter: { _id: sig._id },
              update: { $set: { healthState: 'failing' } }
            }
          });
        }
      }
    }

    // Flush any remaining records
    await flushBatches();

    const elapsed = Date.now() - startTime;
    logger.info(`[Watchdog] Sweep complete in ${elapsed}ms. Detected ${missingCount} anomalies. Recovered ${recoveredCount} jobs.`);

  } catch (error) {
    logger.error('[Watchdog] Fatal sweep error:', error);
  } finally {
    // GUARANTEE the lock is released, even if the DB connection drops
    isSweeping = false;
  }
};