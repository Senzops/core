import { Request, Response } from 'express';
import geoip from 'geoip-lite';
import { UAParser } from 'ua-parser-js';
import { RumService, RumTrace, RumMetric } from '../../models/Rum';
import { ErrorGroup, ErrorEvent, generateErrorFingerprint } from '../../models/Error';
import { logger } from '../../utils/logger';
import { RumBatchSchema } from '../../utils/validation';

const cleanMessageForFingerprint = (message: string): string => {
  return message
    .replace(/[0-9a-fA-F]{24}/g, '<id>')
    .replace(/\b[0-9a-f]{8}\b-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-\b[0-9a-f]{12}\b/ig, '<uuid>')
    .replace(/\d+/g, '<num>');
};

export const ingestRumBatch = async (req: Request, res: Response) => {
  try {
    const apiKey = (req.headers['x-service-api-key'] || req.query.apiKey) as string;
    if (!apiKey) return res.status(401).json({ error: 'Missing API Key' });

    const service = await RumService.findOne({ apiKey });
    if (!service) return res.status(403).json({ error: 'Invalid API Key' });

    const origin = req.headers.origin || req.headers.referer || '';
    if (origin && service.domain !== '*' && service.domain !== 'localhost') {
      try {
        const originHost = new URL(origin).hostname;
        if (!originHost.includes(service.domain)) {
          logger.warn(`[RUM] Blocked rogue telemetry from unauthorized origin: ${originHost} (Expected: ${service.domain})`);
          return res.status(403).json({ error: 'Unauthorized Origin' });
        }
      } catch (e) { }
    }

    const batch = RumBatchSchema.safeParse(req.body);
    if (!batch.success) {
      return res.status(400).json({ error: 'Invalid payload format', details: batch.error });
    }

    res.status(202).json({
      status: 'accepted',
      queuedTraces: batch.data.traces.length,
      queuedErrors: batch.data.errors.length
    });

    setImmediate(() => {
      processRumBatchBackground(batch.data, service, req.ip || req.socket.remoteAddress || '')
        .catch(err => logger.error(`[RUM] Background processing failed: ${err.message}`));
    });

  } catch (error) {
    logger.error('[RUM] Ingest Error', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
};

const processRumBatchBackground = async (data: { traces: any[], errors: any[] }, service: any, requestIp: string) => {
  await RumService.findByIdAndUpdate(service._id, { lastSeen: new Date() });

  const traceDocs = [];
  const metricsMap = new Map<string, any>();
  const errorEvents: any[] = [];
  const errorGroupsMap = new Map<string, any>();

  let ip = requestIp;
  if (ip.includes('::ffff:')) ip = ip.replace('::ffff:', '');
  const geo = ip ? geoip.lookup(ip) : null;
  const country = geo?.country || 'Unknown';
  const city = geo?.city || 'Unknown';

  // --- 1. Process Traces (Page Views / Route Changes) ---
  for (const item of data.traces) {
    const uaParser = new UAParser(item.userAgent || '');
    const browser = uaParser.getBrowser().name || 'Unknown';
    const os = uaParser.getOS().name || 'Unknown';
    const device = uaParser.getDevice().type || (uaParser.getOS().name === 'iOS' || uaParser.getOS().name === 'Android' ? 'Mobile' : 'Desktop');

    const timestamp = new Date(item.timestamp);

    traceDocs.push({
      serviceId: service._id,
      traceId: item.traceId,
      sessionId: item.sessionId,
      traceType: item.traceType,
      url: item.url, path: item.path, referrer: item.referrer,
      vitals: item.vitals,
      timings: item.timings,             // NEW: Navigation Timings
      frustration: item.frustration,     // NEW: Rage & Dead clicks
      connectionType: item.connectionType, // NEW: Network Context
      deviceMemory: item.deviceMemory,     // NEW: Hardware Context
      ip, country, city, userAgent: item.userAgent, browser, os, device,
      spans: item.spans, duration: item.duration, timestamp
    });

    const bucketTime = new Date(timestamp);
    bucketTime.setSeconds(0, 0);
    const bucketKey = bucketTime.toISOString();

    if (!metricsMap.has(bucketKey)) {
      metricsMap.set(bucketKey, {
        timestamp: bucketTime,
        pageViews: 0,
        sessionIds: new Set<string>(),
        vitalsSum: { lcp: 0, inp: 0, cls: 0, fcp: 0 },
        vitalsCount: { lcp: 0, inp: 0, cls: 0, fcp: 0 },
        timingsSum: { dns: 0, tcp: 0, ssl: 0, ttfb: 0, domComplete: 0 },
        timingsCount: { dns: 0, tcp: 0, ssl: 0, ttfb: 0, domComplete: 0 },
        frustrationTotal: { rageClicks: 0, deadClicks: 0, errors: 0 },
        paths: {}, countries: {}, browsers: {}, os: {}, devices: {}
      });
    }

    const m = metricsMap.get(bucketKey);
    m.pageViews++;
    if (item.sessionId) m.sessionIds.add(item.sessionId);

    // Aggregate Vitals
    const v = item.vitals || {};
    if (v.lcp !== undefined) { m.vitalsSum.lcp += v.lcp; m.vitalsCount.lcp++; }
    if (v.inp !== undefined) { m.vitalsSum.inp += v.inp; m.vitalsCount.inp++; }
    if (v.cls !== undefined) { m.vitalsSum.cls += v.cls; m.vitalsCount.cls++; }
    if (v.fcp !== undefined) { m.vitalsSum.fcp += v.fcp; m.vitalsCount.fcp++; }

    // Aggregate Timings (NEW)
    const t = item.timings || {};
    if (t.dns !== undefined) { m.timingsSum.dns += t.dns; m.timingsCount.dns++; }
    if (t.tcp !== undefined) { m.timingsSum.tcp += t.tcp; m.timingsCount.tcp++; }
    if (t.ssl !== undefined) { m.timingsSum.ssl += t.ssl; m.timingsCount.ssl++; }
    if (t.ttfb !== undefined) { m.timingsSum.ttfb += t.ttfb; m.timingsCount.ttfb++; }
    if (t.domComplete !== undefined) { m.timingsSum.domComplete += t.domComplete; m.timingsCount.domComplete++; }

    // Aggregate Frustration (NEW)
    const f = item.frustration || {};
    m.frustrationTotal.rageClicks += (f.rageClicks || 0);
    m.frustrationTotal.deadClicks += (f.deadClicks || 0);
    m.frustrationTotal.errors += (f.errorCount || 0);

    const incrementMap = (mapObj: any, key: string) => {
      const safeKey = key.replace(/\./g, '_').replace(/\$/g, '');
      mapObj[safeKey] = (mapObj[safeKey] || 0) + 1;
    };

    incrementMap(m.paths, item.path);
    incrementMap(m.countries, country);
    incrementMap(m.browsers, browser);
    incrementMap(m.os, os);
    incrementMap(m.devices, device);
  }

  // --- 2. Process Frontend Errors (Universal Error Engine) ---
  for (const err of data.errors) {
    const fingerprint = generateErrorFingerprint(service._id, err.errorClass, cleanMessageForFingerprint(err.message));
    const errTimestamp = err.timestamp ? new Date(err.timestamp) : new Date();

    const enrichedContext = {
      ...err.context,
      browser: err.context?.browser || 'Unknown',
      os: err.context?.os || 'Unknown',
      url: err.context?.url || 'Unknown',
      country
    };

    errorEvents.push({
      serviceId: service._id,
      serviceModel: 'RumService',
      traceId: err.traceId,
      fingerprint,
      stackTrace: err.stackTrace || '',
      context: enrichedContext,
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

  // --- 3. Database Bulk Execution ---
  if (traceDocs.length > 0) await RumTrace.insertMany(traceDocs);

  if (errorGroupsMap.size > 0) {
    const groupPromises = Array.from(errorGroupsMap.values()).map(async (g) => {
      const groupDoc = await ErrorGroup.findOneAndUpdate(
        { ownerId: service.ownerId, fingerprint: g.fingerprint },
        {
          $setOnInsert: {
            ownerId: service.ownerId,
            serviceId: service._id,
            serviceModel: 'RumService',
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

    await ErrorEvent.insertMany(finalErrorEvents);
  }

  const bulkOps = Array.from(metricsMap.values()).map(m => {
    const incUpdate: any = {
      pageViews: m.pageViews,
      sessions: m.sessionIds.size,
      'frustrationTotal.rageClicks': m.frustrationTotal.rageClicks,
      'frustrationTotal.deadClicks': m.frustrationTotal.deadClicks,
      'frustrationTotal.errors': m.frustrationTotal.errors,
    };

    ['lcp', 'inp', 'cls', 'fcp'].forEach(vital => {
      incUpdate[`vitalsSum.${vital}`] = m.vitalsSum[vital];
      incUpdate[`vitalsCount.${vital}`] = m.vitalsCount[vital];
    });

    ['dns', 'tcp', 'ssl', 'ttfb', 'domComplete'].forEach(timing => {
      incUpdate[`timingsSum.${timing}`] = m.timingsSum[timing];
      incUpdate[`timingsCount.${timing}`] = m.timingsCount[timing];
    });

    const addMapToInc = (prefix: string, obj: any) => {
      for (const [k, v] of Object.entries(obj)) incUpdate[`${prefix}.${k}`] = v;
    };
    addMapToInc('paths', m.paths);
    addMapToInc('countries', m.countries);
    addMapToInc('browsers', m.browsers);
    addMapToInc('os', m.os);
    addMapToInc('devices', m.devices);

    return {
      updateOne: {
        filter: { serviceId: service._id, timestamp: m.timestamp },
        update: { $inc: incUpdate },
        upsert: true
      }
    };
  });

  if (bulkOps.length > 0) await RumMetric.bulkWrite(bulkOps);
};