import { Request, Response } from 'express';
import { TaskService, TaskRun, TaskMetric, TaskSignature } from '../../models/Task';
import { ErrorGroup, ErrorEvent, generateErrorFingerprint } from '../../models/Error';
import { LogEvent } from '../../models/Log';
import { buildServiceLogDoc } from '../../utils/buildLogDoc';
import { logger } from '../../utils/logger';
import { TaskBatchSchema } from '../../utils/validation';
import { taskIngestQueue, enqueue, type TaskIngestPayload } from '../../lib/queue';
import { getRetentionMs, stampExpiry } from '../../services/retentionCache';

// Helper: Clean Dynamic Data before Fingerprinting
const cleanMessageForFingerprint = (message: string): string => {
  return message
    .replace(/[0-9a-fA-F]{24}/g, '<id>')
    .replace(/\b[0-9a-f]{8}\b-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-\b[0-9a-f]{12}\b/ig, '<uuid>')
    .replace(/\d+/g, '<num>');
};

export const ingestTaskBatch = async (req: Request, res: Response) => {
  try {
    const apiKey = req.headers['x-service-api-key'] as string;
    if (!apiKey) return res.status(401).json({ error: 'Missing API Key' });

    const service = await TaskService.findOne({ apiKey });
    if (!service) return res.status(403).json({ error: 'Invalid API Key' });

    const batch = TaskBatchSchema.safeParse(req.body);
    if (!batch.success) {
      return res.status(400).json({ error: 'Invalid payload format', details: batch.error });
    }

    res.status(202).json({
      status: 'accepted',
      queuedRuns: batch.data.runs.length,
      queuedLogs: batch.data.logs.length
    });

    await enqueue<TaskIngestPayload>(
      taskIngestQueue,
      { batchData: batch.data, serviceId: service._id.toString() },
      () => { processTaskBatchBackground(batch.data, service).catch(err => logger.error(`[Task] Background processing failed: ${err.message}`)); },
    );

  } catch (error) {
    logger.error('[Task] Ingest Error', error);
    if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error' });
  }
};

export const processTaskBatchBackground = async (data: { runs: any[], errors: any[], logs: any[] }, service: any) => {
  await TaskService.findByIdAndUpdate(service._id, { lastSeen: new Date(), status: 'online' });

  // Resolve the owner's plan-based retention window once for this batch.
  const retentionMs = await getRetentionMs(service.ownerId);

  const runDocs = [];
  const metricsMap = new Map<string, any>();
  const signaturesMap = new Map<string, any>();
  const errorEvents: any[] = [];
  const errorGroupsMap = new Map<string, any>();

  // --- 1. Process Task Runs ---
  for (const item of data.runs) {
    const timestamp = new Date(item.timestamp);

    runDocs.push({
      serviceId: service._id,
      runId: item.runId,
      taskName: item.taskName,
      taskType: item.taskType,
      status: item.status,
      duration: item.duration,
      queueDelay: item.queueDelay,
      attempts: item.attempts,
      triggerTraceId: item.triggerTraceId,
      metadata: item.metadata,
      resourceMetrics: item.resourceMetrics,
      isDeadLetter: item.isDeadLetter,
      spans: item.spans,
      timestamp
    });

    const scheduleExpression = item.metadata?.expression;

    if (!signaturesMap.has(item.taskName)) {
      signaturesMap.set(item.taskName, {
        taskName: item.taskName,
        taskType: item.taskType,
        scheduleExpression,
        lastRunAt: timestamp,
        lastStatus: item.status,
        durationTotal: 0,
        runCount: 0
      });
    }
    const sig = signaturesMap.get(item.taskName);
    if (timestamp > sig.lastRunAt) {
      sig.lastRunAt = timestamp;
      sig.lastStatus = item.status;
      if (scheduleExpression) sig.scheduleExpression = scheduleExpression;
    }
    sig.durationTotal += item.duration;
    sig.runCount++;

    const bucketTime = new Date(timestamp);
    bucketTime.setSeconds(0, 0);
    const bucketKey = `${item.taskName}_${bucketTime.toISOString()}`;

    if (!metricsMap.has(bucketKey)) {
      metricsMap.set(bucketKey, {
        taskName: item.taskName,
        timestamp: bucketTime,
        runs: 0, failures: 0, durationSum: 0, durationMax: 0, durationMin: Infinity, queueDelaySum: 0, attemptsSum: 0
      });
    }

    const m = metricsMap.get(bucketKey);
    m.runs++;
    if (item.status === 'failed') m.failures++;
    m.durationSum += item.duration;
    if (item.duration > m.durationMax) m.durationMax = item.duration;
    if (item.duration < m.durationMin) m.durationMin = item.duration;
    m.queueDelaySum += (item.queueDelay || 0);
    m.attemptsSum += (item.attempts || 1);
  }

  // --- 2. Process Task Errors ---
  for (const err of data.errors) {
    const fingerprint = generateErrorFingerprint(service._id, err.errorClass, cleanMessageForFingerprint(err.message));
    const errTimestamp = err.timestamp ? new Date(err.timestamp) : new Date();

    errorEvents.push({
      serviceId: service._id,
      serviceModel: 'TaskService',
      traceId: err.runId, // Aligning runId to traceId for the error UI
      fingerprint,
      stackTrace: err.stackTrace || '',
      context: err.context || {},
      timestamp: errTimestamp
    });

    if (!errorGroupsMap.has(fingerprint)) {
      errorGroupsMap.set(fingerprint, {
        fingerprint, errorClass: err.errorClass, message: err.message,
        firstSeen: errTimestamp, lastSeen: errTimestamp, count: 0
      });
    }
    const group = errorGroupsMap.get(fingerprint);
    group.count++;
    if (errTimestamp > group.lastSeen) group.lastSeen = errTimestamp;
    if (errTimestamp < group.firstSeen) group.firstSeen = errTimestamp;
  }

  // --- 3. Process Auto-Instrumented Task Logs ---
  if (data.logs && data.logs.length > 0) {
    const logsToInsert = data.logs.map((log: any) => buildServiceLogDoc(
      { ...log, traceId: log.runId || log.traceId }, // Run ID maps to traceId in Log schema
      {
        ownerId: service.ownerId,
        serviceId: service._id,
        serviceModel: 'TaskService',
        source: service.name,
      },
    ));

    if (logsToInsert.length > 0) {
      stampExpiry(logsToInsert, 'timestamp', retentionMs);
      await LogEvent.insertMany(logsToInsert, { ordered: false });
    }
  }

  // --- 4. DB Writes ---
  // anchor: timestamp (the run's event time)
  if (runDocs.length > 0) {
    stampExpiry(runDocs, 'timestamp', retentionMs);
    await TaskRun.insertMany(runDocs);
  }

  if (signaturesMap.size > 0) {
    const signatureOps = Array.from(signaturesMap.values()).map(sig => {
      const batchAvgDuration = sig.durationTotal / sig.runCount;

      return {
        updateOne: {
          filter: { serviceId: service._id, taskName: sig.taskName },
          update: [
            {
              $set: {
                taskType: sig.taskType,
                lastRunAt: { $max: ["$lastRunAt", sig.lastRunAt] },
                lastStatus: sig.lastStatus,
                ...(sig.scheduleExpression && { scheduleExpression: sig.scheduleExpression })
              }
            },
            {
              $set: {
                avgDuration: {
                  $add: [
                    { $multiply: [batchAvgDuration, 0.1] },
                    { $multiply: [{ $ifNull: ["$avgDuration", batchAvgDuration] }, 0.9] }
                  ]
                }
              }
            }
          ],
          upsert: true
        }
      };
    });
    await TaskSignature.bulkWrite(signatureOps);
  }

  if (errorGroupsMap.size > 0) {
    const groupPromises = Array.from(errorGroupsMap.values()).map(async (g) => {
      const groupDoc = await ErrorGroup.findOneAndUpdate(
        { ownerId: service.ownerId, fingerprint: g.fingerprint },
        {
          $setOnInsert: {
            ownerId: service.ownerId,
            serviceId: service._id,
            serviceModel: 'TaskService',
            fingerprint: g.fingerprint,
            errorClass: g.errorClass,
            message: g.message,
            firstSeen: g.firstSeen,
            status: 'unresolved'
          },
          $max: {
            lastSeen: g.lastSeen,
            expiresAt: new Date(g.lastSeen.getTime() + retentionMs),
          },
          $inc: { totalCount: g.count }
        },
        { upsert: true, new: true }
      );
      return { fingerprint: g.fingerprint, groupId: groupDoc._id };
    });

    const resolvedGroups = await Promise.all(groupPromises);
    const fingerprintToGroupId = new Map(resolvedGroups.map(g => [g.fingerprint, g.groupId]));

    const finalErrorEvents = errorEvents.map(e => {
      const { fingerprint, ...rest } = e;
      return { ...rest, groupId: fingerprintToGroupId.get(fingerprint) };
    });

    // anchor: timestamp (the error's event time)
    stampExpiry(finalErrorEvents, 'timestamp', retentionMs);
    await ErrorEvent.insertMany(finalErrorEvents);
  }

  const bulkOps = Array.from(metricsMap.values()).map(m => ({
    updateOne: {
      filter: { serviceId: service._id, taskName: m.taskName, timestamp: m.timestamp },
      update: {
        $inc: {
          runs: m.runs, failures: m.failures, durationSum: m.durationSum,
          queueDelaySum: m.queueDelaySum, attemptsSum: m.attemptsSum
        },
        $max: { durationMax: m.durationMax },
        $min: { durationMin: m.durationMin },
        $set: { expiresAt: new Date(m.timestamp.getTime() + retentionMs) }
      },
      upsert: true
    }
  }));

  if (bulkOps.length > 0) await TaskMetric.bulkWrite(bulkOps);
};