import { Request, Response } from 'express';
import geoip from 'geoip-lite';
import { UAParser } from 'ua-parser-js';
import { ApmService, ApmTrace, ApmMetric } from '../../models/Apm';
import { logger } from '../../utils/logger';
import { ApmBatchSchema } from '../../utils/validation';

export const ingestApmBatch = async (req: Request, res: Response) => {
  try {
    // 1. Critical Validation (Must be synchronous)
    const apiKey = req.headers['x-service-api-key'] as string;
    if (!apiKey) return res.status(401).json({ error: 'Missing API Key' });

    // Cache this lookup in production (Redis/Memory) if possible
    const service = await ApmService.findOne({ apiKey });
    if (!service) return res.status(403).json({ error: 'Invalid API Key' });

    // 2. Validate Payload
    const batch = ApmBatchSchema.safeParse(req.body);
    if (!batch.success) {
      return res.status(400).json({ error: 'Invalid payload format', details: batch.error });
    }

    // 3. FAST EXIT: Respond to SDK immediately
    // This ensures the user's server isn't waiting for our DB writes
    res.status(202).json({ status: 'accepted', queued: batch.data.length });

    // 4. Background Processing (Fire and Forget)
    // We use setImmediate to push this to the end of the event loop
    setImmediate(() => {
      processBatchBackground(batch.data, service)
        .catch(err => logger.error(`[APM] Background processing failed: ${err.message}`));
    });

  } catch (error) {
    logger.error('[APM] Ingest Error', error);
    // Only send error if headers haven't been sent yet
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
};

// --- Background Worker Logic ---
const processBatchBackground = async (data: any[], service: any) => {
  // Update Last Seen
  await ApmService.findByIdAndUpdate(service._id, { lastSeen: new Date() });

  const traceDocs = [];
  const metricsMap = new Map<string, any>();

  for (const item of data) {
    // Enrichment
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

    // Raw Trace
    traceDocs.push({
      serviceId: service._id,
      traceId: item.traceId, // SDK generated
      parentTraceId: item.parentTraceId, // Map parent
      parentSpanId: item.parentSpanId,   // Map parent
      method: item.method,
      route: item.route,
      path: item.path,
      status: item.status,
      duration: item.duration,
      ip, country, city, userAgent: item.userAgent, browser, os, device,
      timestamp,
      spans: item.spans || [],
      error: item.error
    });

    // Metric Aggregation (Memory)
    const bucketTime = new Date(timestamp);
    bucketTime.setSeconds(0, 0); // Floor to minute
    const bucketKey = bucketTime.toISOString();

    if (!metricsMap.has(bucketKey)) {
      metricsMap.set(bucketKey, {
        timestamp: bucketTime,
        requests: 0,
        errorCount: 0,
        durationSum: 0,
        durationMax: 0,
        routes: {}, statusCodes: {}, countries: {}, browsers: {}, os: {}, devices: {}
      });
    }

    const m = metricsMap.get(bucketKey);
    m.requests++;
    if (item.status >= 400) m.errorCount++;
    m.durationSum += item.duration;
    if (item.duration > m.durationMax) m.durationMax = item.duration;

    // Increments
    const incrementMap = (mapObj: any, key: string) => {
      // Sanitize key for Mongo (no $ or .)
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

  // DB Write: Raw Traces
  if (traceDocs.length > 0) {
    await ApmTrace.insertMany(traceDocs);
  }

  // DB Write: Metrics (Upserts)
  const bulkOps = Array.from(metricsMap.values()).map(m => {
    const incUpdate: any = {
      requests: m.requests,
      errorCount: m.errorCount,
      durationSum: m.durationSum,
    };

    const addMapToInc = (prefix: string, obj: any) => {
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
        update: {
          $inc: incUpdate,
          $max: { durationMax: m.durationMax }
        },
        upsert: true
      }
    };
  });

  if (bulkOps.length > 0) {
    await ApmMetric.bulkWrite(bulkOps);
  }
};