import { Request, Response } from 'express';
import crypto from 'crypto';
import geoip from 'geoip-lite';
import { UAParser } from 'ua-parser-js';
import { ApmService, ApmTrace, ApmMetric } from '../../models/Apm';
import { ApmErrorGroup, ApmErrorEvent } from '../../models/ApmError';
import { logger } from '../../utils/logger';
import { ApmBatchSchema } from '../../utils/validation';

// --- Helper: Deterministic Error Fingerprinting ---
const generateFingerprint = (errorClass: string, message: string): string => {
  // Strip dynamic data (UUIDs, MongoIDs, Numbers) so identical errors group together
  const normalizedMessage = message
    .replace(/[0-9a-fA-F]{24}/g, '<id>') // Mongo IDs
    .replace(/\b[0-9a-f]{8}\b-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-\b[0-9a-f]{12}\b/ig, '<uuid>') // UUIDs
    .replace(/\d+/g, '<num>'); // Numbers

  return crypto
    .createHash('sha256')
    .update(`${errorClass}:${normalizedMessage}`)
    .digest('hex');
};

export const ingestApmBatch = async (req: Request, res: Response) => {
  try {
    // 1. Critical Validation (Must be synchronous)
    const apiKey = req.headers['x-service-api-key'] as string;
    if (!apiKey) return res.status(401).json({ error: 'Missing API Key' });

    const service = await ApmService.findOne({ apiKey });
    if (!service) return res.status(403).json({ error: 'Invalid API Key' });

    // 2. Validate Payload (Now supports { traces, errors })
    const batch = ApmBatchSchema.safeParse(req.body);
    if (!batch.success) {
      return res.status(400).json({ error: 'Invalid payload format', details: batch.error });
    }

    // 3. FAST EXIT: Respond to SDK immediately
    res.status(202).json({
      status: 'accepted',
      queuedTraces: batch.data.traces.length,
      queuedErrors: batch.data.errors.length
    });

    // 4. Background Processing (Fire and Forget)
    setImmediate(() => {
      processBatchBackground(batch.data, service)
        .catch(err => logger.error(`[APM] Background processing failed: ${err.message}`));
    });

  } catch (error) {
    logger.error('[APM] Ingest Error', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
};

// --- Background Worker Logic ---
const processBatchBackground = async (data: { traces: any[], errors: any[] }, service: any) => {
  await ApmService.findByIdAndUpdate(service._id, { lastSeen: new Date() });

  const traceDocs = [];
  const metricsMap = new Map<string, any>();
  const errorEvents: any[] = [];
  const errorGroupsMap = new Map<string, any>();

  // --- 1. Process Traces ---
  for (const item of data.traces) {
    let ip = item.ip || '';
    if (ip.includes('::ffff:')) ip = ip.replace('::ffff:', '');
    const geo = ip ? geoip.lookup(ip) : null;

    const uaParser = new UAParser(item.userAgent || '');
    const browser = uaParser.getBrowser().name || 'Unknown';
    const os = uaParser.getOS().name || 'Unknown';
    const device = uaParser.getDevice().type || 'Desktop';
    const country = geo?.country || 'Unknown';
    const city = geo?.city || 'Unknown';
    const timestamp = new Date(item.timestamp);

    traceDocs.push({
      serviceId: service._id,
      traceId: item.traceId,
      parentTraceId: item.parentTraceId,
      parentSpanId: item.parentSpanId,
      method: item.method,
      route: item.route,
      path: item.path,
      status: item.status,
      duration: item.duration,
      ip, country, city, userAgent: item.userAgent, browser, os, device,
      timestamp,
      spans: item.spans || [],
      error: item.error // Legacy fallback
    });

    // Legacy Error Extraction (For older SDKs sending error inline)
    if (item.error && item.error.name && item.error.message) {
      data.errors.push({
        errorClass: item.error.name,
        message: item.error.message,
        stackTrace: item.error.stack || '',
        traceId: item.traceId,
        timestamp: item.timestamp
      });
    }

    const bucketTime = new Date(timestamp);
    bucketTime.setSeconds(0, 0);
    const bucketKey = bucketTime.toISOString();

    if (!metricsMap.has(bucketKey)) {
      metricsMap.set(bucketKey, {
        timestamp: bucketTime, requests: 0, errorCount: 0, durationSum: 0, durationMax: 0,
        routes: {}, statusCodes: {}, countries: {}, browsers: {}, os: {}, devices: {}
      });
    }

    const m = metricsMap.get(bucketKey);
    m.requests++;
    if (item.status >= 400) m.errorCount++;
    m.durationSum += item.duration;
    if (item.duration > m.durationMax) m.durationMax = item.duration;

    const incrementMap = (mapObj: any, key: string) => {
      const safeKey = key.replace(/\./g, '_').replace(/\$/g, '');
      mapObj[safeKey] = (mapObj[safeKey] || 0) + 1;
    };

    incrementMap(m.routes, `${item.method} ${item.route}`);
    incrementMap(m.statusCodes, item.status.toString());
    incrementMap(m.countries, country);
    incrementMap(m.browsers, browser);
    incrementMap(m.os, os);
    incrementMap(m.devices, device);
  }

  // --- 2. Process Errors (AppSignal Style) ---
  for (const err of data.errors) {
    const fingerprint = generateFingerprint(err.errorClass, err.message);
    const errTimestamp = err.timestamp ? new Date(err.timestamp) : new Date();

    errorEvents.push({
      apmId: service._id,
      traceId: err.traceId,
      fingerprint,
      stackTrace: err.stackTrace || '',
      context: err.context || {},
      timestamp: errTimestamp
    });

    if (!errorGroupsMap.has(fingerprint)) {
      errorGroupsMap.set(fingerprint, {
        fingerprint,
        errorClass: err.errorClass,
        message: err.message,
        firstSeen: errTimestamp,
        lastSeen: errTimestamp,
        count: 0
      });
    }
    const group = errorGroupsMap.get(fingerprint);
    group.count++;
    if (errTimestamp > group.lastSeen) group.lastSeen = errTimestamp;
    if (errTimestamp < group.firstSeen) group.firstSeen = errTimestamp;
  }

  // --- 3. DB Writes ---
  if (traceDocs.length > 0) {
    await ApmTrace.insertMany(traceDocs);
  }

  if (errorGroupsMap.size > 0) {
    const groupPromises = Array.from(errorGroupsMap.values()).map(async (g) => {
      const groupDoc = await ApmErrorGroup.findOneAndUpdate(
        { apmId: service._id, fingerprint: g.fingerprint },
        {
          $setOnInsert: {
            ownerId: service.ownerId,
            apmId: service._id,
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

  const bulkOps = Array.from(metricsMap.values()).map(m => {
    const incUpdate: any = { requests: m.requests, errorCount: m.errorCount, durationSum: m.durationSum };
    const addMapToInc = (prefix: string, obj: any) => {
      for (const [k, v] of Object.entries(obj)) incUpdate[`${prefix}.${k}`] = v;
    };
    addMapToInc('routes', m.routes);
    addMapToInc('statusCodes', m.statusCodes);
    addMapToInc('countries', m.countries);
    addMapToInc('browsers', m.browsers);
    addMapToInc('os', m.os);
    addMapToInc('devices', m.devices);

    return {
      updateOne: { filter: { serviceId: service._id, timestamp: m.timestamp }, update: { $inc: incUpdate, $max: { durationMax: m.durationMax } }, upsert: true }
    };
  });

  if (bulkOps.length > 0) {
    await ApmMetric.bulkWrite(bulkOps);
  }
};