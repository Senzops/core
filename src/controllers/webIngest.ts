import { Request, Response } from 'express';
import geoip from 'geoip-lite';
import { UAParser } from 'ua-parser-js';
import { WebEvent } from '../models';
import { logger } from '../utils/logger';

// Helper to determine traffic channel
const getChannel = (referrer: string) => {
  if (!referrer || referrer === 'Direct') return 'Direct';
  const r = referrer.toLowerCase();

  if (r.includes('google') || r.includes('bing') || r.includes('yahoo') || r.includes('duckduckgo') || r.includes('baidu')) return 'Search';
  if (r.includes('facebook') || r.includes('twitter') || r.includes('t.co') || r.includes('instagram') || r.includes('linkedin') || r.includes('reddit') || r.includes('pinterest') || r.includes('tiktok')) return 'Social';

  return 'Referral';
}

export const ingestWebMetrics = async (req: Request, res: Response) => {
  try {
    const { webId, visitorId, sessionId, type, url, path, title, referrer, width, duration } = req.body;

    // 1. Geo
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    if (Array.isArray(ip)) ip = ip[0];
    if (typeof ip === 'string' && ip.includes('::ffff:')) ip = ip.replace('::ffff:', '');

    const geo = geoip.lookup(ip as string);
    const country = geo?.country || 'Unknown';
    const city = geo?.city || 'Unknown';

    // 2. UA
    const uaString = req.headers['user-agent'] || '';
    const parser = new UAParser(uaString);
    const browser = parser.getBrowser().name || 'Unknown';
    const os = parser.getOS().name || 'Unknown';
    let device = parser.getDevice().type || 'desktop';
    if (device === 'desktop' && width < 768) device = 'mobile';

    // 3. Channel Logic
    const channel = getChannel(referrer);

    if (type === 'ping') {
      await WebEvent.findOneAndUpdate(
        { sessionId, path, type: 'pageview' },
        { $inc: { duration: duration || 0 } },
        { sort: { createdAt: -1 } }
      );
      return res.status(200).send('ok');
    }

    await WebEvent.create({
      webId,
      visitorId,
      sessionId,
      type,
      url,
      path,
      title: title || 'Unknown',
      referrer: referrer || 'Direct',
      channel,
      duration: 0,
      browser,
      os,
      device,
      country,
      city
    });

    return res.status(200).send('ok');

  } catch (error) {
    logger.error('Senzor Web Ingest Error', error);
    return res.status(200).send('error');
  }
};