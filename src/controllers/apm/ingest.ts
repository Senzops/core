import { Request, Response } from 'express';
import geoip from 'geoip-lite';
import { UAParser } from 'ua-parser-js';
import { ApmService, ApmTrace } from '../../models/Apm';
import { logger } from '../../utils/logger';
import { ApmBatchSchema } from '../../utils/validation';

export const ingestApmBatch = async (req: Request, res: Response) => {
  try {
    // 1. Auth via Header
    const apiKey = req.headers['x-service-api-key'] as string;
    if (!apiKey) return res.status(401).json({ error: 'Missing API Key' });

    const service = await ApmService.findOne({ apiKey });
    if (!service) return res.status(403).json({ error: 'Invalid API Key' });

    // 2. Validate Batch
    const batch = ApmBatchSchema.safeParse(req.body);
    if (!batch.success) {
      return res.status(400).json({ error: 'Invalid payload format', details: batch.error });
    }

    // 3. Update Last Seen
    await ApmService.findByIdAndUpdate(service._id, { lastSeen: new Date() });

    // 4. Enrich & Prepare Documents
    const traceDocs = batch.data.map(item => {
      // Geo Lookup
      let ip = item.ip || '';
      if (ip.includes('::ffff:')) ip = ip.replace('::ffff:', '');
      const geo = ip ? geoip.lookup(ip) : null;

      // UA Parsing
      const uaParser = new UAParser(item.userAgent || '');
      const browser = uaParser.getBrowser().name || 'Unknown';
      const os = uaParser.getOS().name || 'Unknown';
      const device = uaParser.getDevice().type || 'Desktop';

      return {
        serviceId: service._id,
        method: item.method,
        route: item.route,
        path: item.path,
        status: item.status,
        duration: item.duration,
        ip: ip,
        country: geo?.country || 'Unknown',
        city: geo?.city || 'Unknown',
        userAgent: item.userAgent,
        browser,
        os,
        device,
        timestamp: new Date(item.timestamp),
        spans: item.spans || []
      };
    });

    // 5. Bulk Insert
    if (traceDocs.length > 0) {
      await ApmTrace.insertMany(traceDocs);
    }

    return res.status(202).json({ status: 'accepted', count: traceDocs.length });

  } catch (error) {
    logger.error('[APM] Ingest Error', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};