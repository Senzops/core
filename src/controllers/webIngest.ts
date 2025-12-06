import { Request, Response } from 'express';
import geoip from 'geoip-lite';
import { UAParser } from 'ua-parser-js';
import { WebEvent } from '../models';
import { logger } from '../utils/logger';

export const ingestWebMetrics = async (req: Request, res: Response) => {
  try {
    const { webId, visitorId, sessionId, type, url, path, referrer, width, duration } = req.body;

    // 1. Get IP for GeoLookup
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    if (Array.isArray(ip)) ip = ip[0];

    // 2. Geo Lookup
    const geo = geoip.lookup(ip as string);
    const country = geo?.country || 'Unknown';
    const city = geo?.city || 'Unknown';

    // 3. UA Parsing
    const uaString = req.headers['user-agent'] || '';
    const parser = new UAParser(uaString);
    const browser = parser.getBrowser().name || 'Unknown';
    const os = parser.getOS().name || 'Unknown';

    // Determine Device Type based on Screen Width + UA
    let device = parser.getDevice().type || 'desktop';
    if (device === 'desktop' && width < 768) device = 'mobile'; // Fallback logic

    // 4. Handle "Ping" (Duration Updates) vs "Pageview"
    if (type === 'ping') {
      // For pings, we want to update the duration of the LAST pageview for this session/path
      // Optimistic "Fire and Forget" update
      await WebEvent.findOneAndUpdate(
        { sessionId, path, type: 'pageview' },
        { $inc: { duration: duration || 0 } },
        { sort: { createdAt: -1 } } // Update the most recent one
      );
      return res.status(200).send('ok');
    }

    // 5. Store Pageview
    await WebEvent.create({
      webId,
      visitorId,
      sessionId,
      type,
      url,
      path,
      referrer: referrer || 'Direct',
      duration: 0, // Initial duration
      browser,
      os,
      device,
      country,
      city
    });

    return res.status(200).send('ok');

  } catch (error) {
    logger.error('Web Ingest Error', error);
    // Always return 200 to agent to prevent console errors on client
    return res.status(200).send('error');
  }
};