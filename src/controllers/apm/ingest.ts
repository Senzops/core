import { Request, Response } from 'express';
import { UAParser } from 'ua-parser-js';
import { ApmService, ApmTrace, ApmMetric } from '../../models/Apm';
import { ErrorGroup, ErrorEvent, generateErrorFingerprint } from '../../models/Error';
import { LogEvent } from '../../models/Log';
import { logger } from '../../utils/logger';
import { ApmBatchSchema } from '../../utils/validation';
import { normaliseIP, isPrivateOrLoopback } from '../../utils/getClientIp';
import { getGeoData } from '../../utils/getGeoData';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip dynamic tokens from error messages before fingerprinting so that
 * "User 507f1f77 not found" and "User abc123de not found" collapse into the
 * same error group.
 */
const cleanMessageForFingerprint = (message: string): string =>
  message
    .replace(/[0-9a-fA-F]{24}/g, '<id>')      // MongoDB ObjectIds
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      '<uuid>'
    )                                           // UUIDs
    .replace(/\d+/g, '<num>');                  // All remaining numbers

/**
 * Extract and normalise an IP that was captured by the APM SDK on the
 * application server and forwarded here inside the batch payload.
 *
 * Unlike the web-analytics ingest (where we read headers on THIS request),
 * here the IP is a string value inside each trace item — so we just clean
 * and validate it rather than checking proxy headers.
 */
const extractPayloadIp = (rawIp: unknown): string | null => {
  if (!rawIp || typeof rawIp !== 'string') return null;
  return normaliseIP(rawIp);
};

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export const ingestApmBatch = async (req: Request, res: Response) => {
  try {
    const apiKey = req.headers['x-service-api-key'] as string;
    if (!apiKey) return res.status(401).json({ error: 'Missing API Key' });

    const service = await ApmService.findOne({ apiKey });
    if (!service) return res.status(403).json({ error: 'Invalid API Key' });

    const batch = ApmBatchSchema.safeParse(req.body);
    if (!batch.success) {
      return res.status(400).json({
        error: 'Invalid payload format',
        details: batch.error,
      });
    }

    // Acknowledge immediately — processing happens in the background
    res.status(202).json({
      status: 'accepted',
      queuedTraces: batch.data.traces.length,
      queuedErrors: batch.data.errors.length,
      queuedLogs: batch.data.logs.length,
    });

    setImmediate(() => {
      processBatchBackground(batch.data, service).catch((err) =>
        logger.error(`[APM] Background processing failed: ${err.message}`)
      );
    });
  } catch (error) {
    logger.error('[APM] Ingest Error', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
};

// ---------------------------------------------------------------------------
// Background processor
// ---------------------------------------------------------------------------

const processBatchBackground = async (
  data: { traces: any[]; errors: any[]; logs: any[] },
  service: any
) => {
  await ApmService.findByIdAndUpdate(service._id, { lastSeen: new Date() });

  const traceDocs: any[] = [];
  const metricsMap = new Map<string, any>();
  const errorEvents: any[] = [];
  const errorGroupsMap = new Map<string, any>();

  // -------------------------------------------------------------------------
  // 1. Process Traces
  // -------------------------------------------------------------------------
  for (const item of data.traces) {
    // --- IP normalisation ---
    // The IP arrives embedded in the trace payload (captured by the SDK).
    // normaliseIP handles: ::ffff: stripping, IPv6 brackets, port suffixes.
    const ip = extractPayloadIp(item.ip);

    // --- Geo lookup ---
    // We pass req=null here because CDN headers belong to the SDK→ingestor
    // HTTP leg, not to the original end-user request. Skip header fast-path
    // and go straight to the local MaxMind DB.
    // isPrivateOrLoopback guard lives inside getGeoData — private IPs return
    // { country: 'Unknown', city: 'Unknown' } without touching the DB.
    const { country, city } = await getGeoData(ip);

    // --- User-agent parsing ---
    const uaParser = new UAParser(item.userAgent || '');
    const browser = uaParser.getBrowser().name || 'Unknown';
    const os = uaParser.getOS().name || 'Unknown';
    const device = uaParser.getDevice().type || 'Desktop';

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
      ip: ip ?? 'Unknown',   // store cleaned value, never raw
      country,
      city,
      userAgent: item.userAgent,
      browser,
      os,
      device,
      timestamp,
      spans: item.spans || [],
    });

    // Promote trace-attached errors into the errors array
    if (item.error?.name && item.error?.message) {
      data.errors.push({
        errorClass: item.error.name,
        message: item.error.message,
        stackTrace: item.error.stack || '',
        traceId: item.traceId,
        timestamp: item.timestamp,
      });
    }

    // --- Metrics bucket (1-minute resolution) ---
    const bucketTime = new Date(timestamp);
    bucketTime.setSeconds(0, 0);
    const bucketKey = bucketTime.toISOString();

    if (!metricsMap.has(bucketKey)) {
      metricsMap.set(bucketKey, {
        timestamp: bucketTime,
        requests: 0,
        errorCount: 0,
        durationSum: 0,
        durationMax: 0,
        routes: {},
        statusCodes: {},
        countries: {},
        browsers: {},
        os: {},
        devices: {},
      });
    }

    const m = metricsMap.get(bucketKey);
    m.requests++;
    if (item.status >= 400) m.errorCount++;
    m.durationSum += item.duration;
    if (item.duration > m.durationMax) m.durationMax = item.duration;

    const inc = (obj: Record<string, number>, key: string) => {
      const safeKey = key.replace(/\./g, '_').replace(/\$/g, '');
      obj[safeKey] = (obj[safeKey] || 0) + 1;
    };

    inc(m.routes, `${item.method} ${item.route}`);
    inc(m.statusCodes, item.status.toString());
    inc(m.countries, country);
    inc(m.browsers, browser);
    inc(m.os, os);
    inc(m.devices, device);
  }

  // -------------------------------------------------------------------------
  // 2. Process Errors
  // -------------------------------------------------------------------------
  for (const err of data.errors) {
    const fingerprint = generateErrorFingerprint(
      service._id,
      err.errorClass,
      cleanMessageForFingerprint(err.message)
    );
    const errTimestamp = err.timestamp ? new Date(err.timestamp) : new Date();

    errorEvents.push({
      serviceId: service._id,
      serviceModel: 'ApmService',
      traceId: err.traceId,
      fingerprint,
      stackTrace: err.stackTrace || '',
      context: err.context || {},
      timestamp: errTimestamp,
    });

    if (!errorGroupsMap.has(fingerprint)) {
      errorGroupsMap.set(fingerprint, {
        fingerprint,
        errorClass: err.errorClass,
        message: err.message,
        firstSeen: errTimestamp,
        lastSeen: errTimestamp,
        count: 0,
      });
    }

    const group = errorGroupsMap.get(fingerprint);
    group.count++;
    if (errTimestamp > group.lastSeen) group.lastSeen = errTimestamp;
    if (errTimestamp < group.firstSeen) group.firstSeen = errTimestamp;
  }

  // -------------------------------------------------------------------------
  // 3. DB Writes
  // -------------------------------------------------------------------------

  // Traces
  if (traceDocs.length > 0) {
    await ApmTrace.insertMany(traceDocs, { ordered: false });
  }

  // Error groups + events
  if (errorGroupsMap.size > 0) {
    const groupPromises = Array.from(errorGroupsMap.values()).map(async (g) => {
      const groupDoc = await ErrorGroup.findOneAndUpdate(
        { ownerId: service.ownerId, fingerprint: g.fingerprint },
        {
          $setOnInsert: {
            ownerId: service.ownerId,
            serviceId: service._id,
            serviceModel: 'ApmService',
            fingerprint: g.fingerprint,
            errorClass: g.errorClass,
            message: g.message,
            firstSeen: g.firstSeen,
            status: 'unresolved',
          },
          $max: { lastSeen: g.lastSeen },
          $inc: { totalCount: g.count },
        },
        { upsert: true, new: true }
      );
      return { fingerprint: g.fingerprint, groupId: groupDoc._id };
    });

    const resolvedGroups = await Promise.all(groupPromises);
    const fingerprintToGroupId = new Map(
      resolvedGroups.map((g) => [g.fingerprint, g.groupId])
    );

    const finalErrorEvents = errorEvents.map(({ fingerprint, ...rest }) => ({
      ...rest,
      groupId: fingerprintToGroupId.get(fingerprint),
    }));

    await ErrorEvent.insertMany(finalErrorEvents, { ordered: false });
  }

  // APM metrics (bulk upsert)
  const bulkOps = Array.from(metricsMap.values()).map((m) => {
    const incUpdate: Record<string, any> = {
      requests: m.requests,
      errorCount: m.errorCount,
      durationSum: m.durationSum,
    };

    const addMapToInc = (prefix: string, obj: Record<string, number>) => {
      for (const [k, v] of Object.entries(obj)) {
        incUpdate[`${prefix}.${k}`] = v;
      }
    };

    addMapToInc('routes', m.routes);
    addMapToInc('statusCodes', m.statusCodes);
    addMapToInc('countries', m.countries);
    addMapToInc('browsers', m.browsers);
    addMapToInc('os', m.os);
    addMapToInc('devices', m.devices);

    return {
      updateOne: {
        filter: { serviceId: service._id, timestamp: m.timestamp },
        update: { $inc: incUpdate, $max: { durationMax: m.durationMax } },
        upsert: true,
      },
    };
  });

  if (bulkOps.length > 0) {
    await ApmMetric.bulkWrite(bulkOps, { ordered: false });
  }

  // -------------------------------------------------------------------------
  // 4. Process APM Logs
  // -------------------------------------------------------------------------
  if (data.logs?.length > 0) {
    const logsToInsert = data.logs.map((log: any) => ({
      ownerId: service.ownerId,
      serviceId: service._id,
      serviceModel: 'ApmService',
      traceId: log.traceId,
      spanId: log.spanId,
      level: log.level || 'info',
      message: log.message || 'Empty Log',
      attributes: log.attributes || {},
      timestamp: log.timestamp ? new Date(log.timestamp) : new Date(),
    }));

    // ordered: false — one malformed log doc must not abort the whole batch
    await LogEvent.insertMany(logsToInsert, { ordered: false });
  }
};