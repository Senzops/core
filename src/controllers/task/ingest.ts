import { Request, Response } from 'express';
import crypto from 'crypto';
import { TaskService, TaskRun, TaskMetric } from '../../models/Task';
import { ApmErrorGroup, ApmErrorEvent } from '../../models/ApmError'; 
import { logger } from '../../utils/logger';
import { TaskBatchSchema } from '../../utils/validation';

// Helper: Deterministic Error Fingerprinting
const generateFingerprint = (errorClass: string, message: string): string => {
  const normalizedMessage = message
      .replace(/[0-9a-fA-F]{24}/g, '<id>') 
      .replace(/\b[0-9a-f]{8}\b-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-\b[0-9a-f]{12}\b/ig, '<uuid>') 
      .replace(/\d+/g, '<num>'); 

  return crypto.createHash('sha256').update(`${errorClass}:${normalizedMessage}`).digest('hex');
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

    // Fast Exit
    res.status(202).json({ status: 'accepted', queuedRuns: batch.data.runs.length });

    // Background Processing
    setImmediate(() => {
      processTaskBatchBackground(batch.data, service)
        .catch(err => logger.error(`[Task] Background processing failed: ${err.message}`));
    });

  } catch (error) {
    logger.error('[Task] Ingest Error', error);
    if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error' });
  }
};

const processTaskBatchBackground = async (data: { runs: any[], errors: any[] }, service: any) => {
  await TaskService.findByIdAndUpdate(service._id, { lastSeen: new Date(), status: 'online' });

  const runDocs = [];
  const metricsMap = new Map<string, any>();
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
      spans: item.spans,
      timestamp
    });

    // Metric Aggregation (Memory Map keyed by taskName + timeBucket)
    const bucketTime = new Date(timestamp);
    bucketTime.setSeconds(0, 0); // Floor to minute
    const bucketKey = `${item.taskName}_${bucketTime.toISOString()}`;

    if (!metricsMap.has(bucketKey)) {
      metricsMap.set(bucketKey, {
        taskName: item.taskName,
        timestamp: bucketTime, 
        runs: 0, failures: 0, durationSum: 0, durationMax: 0, queueDelaySum: 0, attemptsSum: 0
      });
    }

    const m = metricsMap.get(bucketKey);
    m.runs++;
    if (item.status === 'failed') m.failures++;
    m.durationSum += item.duration;
    if (item.duration > m.durationMax) m.durationMax = item.duration;
    m.queueDelaySum += (item.queueDelay || 0);
    m.attemptsSum += (item.attempts || 1);
  }

  // --- 2. Process Task Errors (Bridging to Global APM Errors) ---
  for (const err of data.errors) {
    const fingerprint = generateFingerprint(err.errorClass, err.message);
    const errTimestamp = err.timestamp ? new Date(err.timestamp) : new Date();

    errorEvents.push({
      serviceType: 'task',
      taskServiceId: service._id,
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

  // --- 3. DB Writes ---
  if (runDocs.length > 0) await TaskRun.insertMany(runDocs);

  if (errorGroupsMap.size > 0) {
    const groupPromises = Array.from(errorGroupsMap.values()).map(async (g) => {
      // Upsert polymorphic error group
      const groupDoc = await ApmErrorGroup.findOneAndUpdate(
        { ownerId: service.ownerId, fingerprint: g.fingerprint },
        {
          $setOnInsert: {
            ownerId: service.ownerId,
            serviceType: 'task',
            taskServiceId: service._id,
            fingerprint: g.fingerprint,
            errorClass: g.errorClass,
            message: g.message,
            firstSeen: g.firstSeen,
            status: 'unresolved'
          },
          $max: { lastSeen: g.lastSeen },
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

    await ApmErrorEvent.insertMany(finalErrorEvents);
  }

  const bulkOps = Array.from(metricsMap.values()).map(m => ({
    updateOne: { 
      filter: { serviceId: service._id, taskName: m.taskName, timestamp: m.timestamp }, 
      update: { 
        $inc: { 
          runs: m.runs, failures: m.failures, durationSum: m.durationSum, 
          queueDelaySum: m.queueDelaySum, attemptsSum: m.attemptsSum 
        }, 
        $max: { durationMax: m.durationMax } 
      }, 
      upsert: true 
    }
  }));

  if (bulkOps.length > 0) await TaskMetric.bulkWrite(bulkOps);
};