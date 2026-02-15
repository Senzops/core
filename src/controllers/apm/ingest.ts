import { Request, Response } from 'express';
import geoip from 'geoip-lite';
import { UAParser } from 'ua-parser-js';
import { ApmService, ApmTrace } from '../../models/Apm';
import { logger } from '../../utils/logger';
import { ApmBatchSchema } from '../../utils/validation';
import { ApmMetric } from '../../models/ApmMetric';

export const ingestApmBatch = async (req: Request, res: Response) => {
  try {
    const apiKey = req.headers['x-service-api-key'] as string;
    if (!apiKey) return res.status(401).json({ error: 'Missing API Key' });

    const service = await ApmService.findOne({ apiKey });
    if (!service) return res.status(403).json({ error: 'Invalid API Key' });

    const batch = ApmBatchSchema.safeParse(req.body);
    if (!batch.success) {
      return res.status(400).json({ error: 'Invalid payload format', details: batch.error });
    }

    await ApmService.findByIdAndUpdate(service._id, { lastSeen: new Date() });

    const traceDocs = [];
    const metricsMap = new Map<string, any>();

    // 1. Process Batch
    for (const item of batch.data) {
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

      // --- B. Aggregate Metrics (In-Memory) ---
      const bucketTime = new Date(timestamp);
      bucketTime.setSeconds(0, 0);
      const bucketKey = bucketTime.toISOString();

      if (!metricsMap.has(bucketKey)) {
        metricsMap.set(bucketKey, {
          timestamp: bucketTime,
          requests: 0,
          errorCount: 0, // UPDATED
          durationSum: 0,
          durationMax: 0,
          routes: {}, statusCodes: {}, countries: {}, browsers: {}, os: {}, devices: {}
        });
      }

      const m = metricsMap.get(bucketKey);
      m.requests++;
      if (item.status >= 400) m.errorCount++; // UPDATED
      m.durationSum += item.duration;
      if (item.duration > m.durationMax) m.durationMax = item.duration;

      const routeKey = `${item.method} ${item.route}`;
      m.routes[routeKey] = (m.routes[routeKey] || 0) + 1;

      const statusKey = item.status.toString();
      m.statusCodes[statusKey] = (m.statusCodes[statusKey] || 0) + 1;

      m.countries[country] = (m.countries[country] || 0) + 1;
      m.browsers[browser] = (m.browsers[browser] || 0) + 1;
      m.os[os] = (m.os[os] || 0) + 1;
      m.devices[device] = (m.devices[device] || 0) + 1;
    }

    // 2. Write Raw Traces
    if (traceDocs.length > 0) {
      await ApmTrace.insertMany(traceDocs);
    }

    // 3. Write Metrics
    const bulkOps = Array.from(metricsMap.values()).map(m => {
      const incUpdate: any = {
        requests: m.requests,
        errorCount: m.errorCount, // UPDATED
        durationSum: m.durationSum,
      };

      const addMapToInc = (prefix: string, obj: any) => {
        for (const [k, v] of Object.entries(obj)) {
          const safeKey = k.replace(/\./g, '_').replace(/\$/g, '');
          incUpdate[`${prefix}.${safeKey}`] = v;
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

    return res.status(202).json({ status: 'accepted', count: traceDocs.length });

  } catch (error) {
    logger.error('[APM] Ingest Error', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};