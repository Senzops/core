import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { LogEvent, LogApiKey } from '../../models/Log';
import { parseLogQuery } from '../../utils/logParser';
import { logger } from '../../utils/logger';

const getStartDate = (range: string) => {
  const date = new Date();
  switch (range) {
    case '1h': date.setHours(date.getHours() - 1); break;
    case '7d': date.setDate(date.getDate() - 7); break;
    case '30d': date.setDate(date.getDate() - 30); break;
    case '24h':
    default: date.setHours(date.getHours() - 24); break;
  }
  return date;
};

// --- 1. Dashboard: Fetch & Search Logs ---
export const getDashboardLogs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 100; // Professional standard: 100 logs/page
    const search = req.query.search as string || '';
    const range = req.query.range as string || '24h';

    const startDate = getStartDate(range);
    
    // Parse the New Relic style query
    const query = parseLogQuery(search, uid, startDate);

    // Fetch Logs + Total Count
    const [logs, total] = await Promise.all([
      LogEvent.find(query)
        .sort({ timestamp: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('serviceId', 'name') // Resolves the service name if linked
        .lean(),
      LogEvent.countDocuments(query)
    ]);

    // Trend Aggregation for the Area Chart
    let dateFormat = "%Y-%m-%dT%H:00:00.000Z";
    if (range === '1h') dateFormat = "%Y-%m-%dT%H:%M:00.000Z";
    if (range === '7d' || range === '30d') dateFormat = "%Y-%m-%d";

    const trend = await LogEvent.aggregate([
      { $match: query },
      { $group: { _id: { $dateToString: { format: dateFormat, date: "$timestamp" } }, count: { $sum: 1 } } },
      { $sort: { "_id": 1 } }
    ]);

    res.json({
      logs,
      trend,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    next(error);
  }
};

// --- 2. Trace Detail: Fetch Logs for specific Trace ---
export const getTraceLogs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { traceId } = req.params;

    const logs = await LogEvent.find({ ownerId: uid, traceId })
      .sort({ timestamp: 1 }) // Chronological order for traces makes more sense
      .lean();

    res.json({ logs });
  } catch (error) {
    next(error);
  }
};

// --- 3. API Key Management ---
export const getLogApiKey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    let apiKeyRecord = await LogApiKey.findOne({ ownerId: uid });
    
    if (!apiKeyRecord) {
      const key = `sz_log_${crypto.randomBytes(24).toString('hex')}`;
      apiKeyRecord = await LogApiKey.create({ ownerId: uid, key });
    }

    res.json({ key: apiKeyRecord.key });
  } catch (error) {
    next(error);
  }
};

// --- 4. Global Ingestion Endpoint (External Log Forwarders) ---
export const ingestGlobalLogs = async (req: Request, res: Response) => {
  try {
    const apiKey = req.headers['x-log-api-key'] || req.query.apiKey;
    if (!apiKey) return res.status(401).json({ error: 'Missing API Key' });

    const keyRecord = await LogApiKey.findOne({ key: apiKey as string }).lean();
    if (!keyRecord) return res.status(403).json({ error: 'Invalid API Key' });

    // Support both single object and array of logs
    const payloads = Array.isArray(req.body) ? req.body : [req.body];
    
    const logsToInsert = payloads.map((payload: any) => {
      // Destructure standard fields, everything else goes to attributes
      const { message, level, timestamp, traceId, spanId, ...attributes } = payload;
      return {
        ownerId: keyRecord.ownerId,
        serviceModel: 'External',
        message: message || JSON.stringify(payload) || 'Empty Log',
        level: level || 'info',
        traceId,
        spanId,
        attributes: attributes || {},
        timestamp: timestamp ? new Date(timestamp) : new Date()
      };
    });

    if (logsToInsert.length > 0) {
      await LogEvent.insertMany(logsToInsert);
    }

    res.status(202).json({ status: 'accepted', ingested: logsToInsert.length });
  } catch (error) {
    logger.error('[LOGS] Global Ingest Error', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// --- 5. Fetch Single Log by ID (For Permalinks & Hard Refreshes) ---
export const getLogById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;

    const log = await LogEvent.findOne({ _id: id, ownerId: uid })
      .populate('serviceId', 'name')
      .lean();

    if (!log) return res.status(404).json({ error: 'Log not found' });
    res.json({ log });
  } catch (error) {
    next(error);
  }
};