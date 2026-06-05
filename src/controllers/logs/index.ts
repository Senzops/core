import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { LogEvent, LogApiKey } from '../../models/Log';
import { parseLogQuery } from '../../utils/logParser';
import { logger } from '../../utils/logger';
import { resolveTimeRange, getEffectiveRetention, buildTimeRangeMeta, TimeRangeError } from '../../utils/timeRange';
import { logIngestQueue, enqueue, type LogIngestPayload } from '../../lib/queue';

// ============================================================================
// ENTERPRISE INGESTION CACHE
// Validating an API key via MongoDB on every log ingestion request will 
// instantly bottleneck the database under load. This TTL cache keeps validated
// keys in blazing-fast Node.js RAM for 5 minutes.
// ============================================================================
const apiKeyCache = new Map<string, { ownerId: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const getOwnerIdFromKey = async (apiKey: string): Promise<string | null> => {
  const now = Date.now();
  const cached = apiKeyCache.get(apiKey);

  // Return from RAM if valid
  if (cached && cached.expiresAt > now) {
    return cached.ownerId;
  }

  // Memory leak protection for the Map
  if (apiKeyCache.size > 10000) apiKeyCache.clear();

  // Fallback to DB and cache the result
  const keyRecord = await LogApiKey.findOne({ key: apiKey }).lean();
  if (!keyRecord) return null;

  const ownerId = keyRecord.ownerId.toString();
  apiKeyCache.set(apiKey, { ownerId, expiresAt: now + CACHE_TTL_MS });

  return ownerId;
};

// --- 1. Dashboard: Fetch & Search Logs ---
export const getDashboardLogs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 100;
    const search = req.query.search as string || '';
    const { range, start, end } = req.query;

    const maxRetention = await getEffectiveRetention('logs', ownerId);
    const resolved = resolveTimeRange(
      { range: range as string, start: start as string, end: end as string },
      maxRetention
    );
    const { startDate, bucketFormat } = resolved;
    const meta = buildTimeRangeMeta(resolved, maxRetention);

    // Parse the New Relic style query
    const query = parseLogQuery(search, ownerId, startDate);

    // Fetch Logs + Total Count
    const [logs, total] = await Promise.all([
      LogEvent.find(query)
        .sort({ timestamp: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('serviceId', 'name')
        .lean(),
      LogEvent.countDocuments(query)
    ]);

    const dateFormat = bucketFormat;

    const trend = await LogEvent.aggregate([
      { $match: query },
      { $group: { _id: { $dateToString: { format: dateFormat, date: "$timestamp" } }, count: { $sum: 1 } } },
      { $sort: { "_id": 1 } }
    ]);

    res.json({
      logs,
      trend,
      timeRange: meta,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};

// --- 2. Trace Detail: Fetch Logs for specific Trace ---
export const getTraceLogs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { traceId } = req.params;

    const logs = await LogEvent.find({ ownerId, traceId })
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
    const ownerId = (req as any).ownerId;
    let apiKeyRecord = await LogApiKey.findOne({ ownerId });
    
    if (!apiKeyRecord) {
      const key = `sz_log_${crypto.randomBytes(24).toString('hex')}`;
      apiKeyRecord = await LogApiKey.create({ ownerId, key });
    }

    res.json({ key: apiKeyRecord.key });
  } catch (error) {
    next(error);
  }
};

// ============================================================================
// 4. GLOBAL INGESTION ENDPOINT (External Log Forwarders)
// Highly optimized for massive write throughput
// ============================================================================
export const ingestGlobalLogs = async (req: Request, res: Response) => {
  try {
    const apiKey = req.headers['x-log-api-key'] || req.query.apiKey;
    if (!apiKey || typeof apiKey !== 'string') {
      return res.status(401).json({ error: 'Missing or invalid API Key' });
    }

    // 1. Authenticate via RAM Cache
    const ownerId = await getOwnerIdFromKey(apiKey);
    if (!ownerId) {
      return res.status(403).json({ error: 'Invalid API Key' });
    }

    // 2. Normalize Payload to Array
    const payloads = Array.isArray(req.body) ? req.body : [req.body];
    if (payloads.length === 0) {
      return res.status(400).json({ error: 'Empty payload' });
    }

    // 3. Batch Limiting (Protect against mega-arrays freezing Node's Event Loop)
    const BATCH_LIMIT = 2000;
    const processablePayloads = payloads.slice(0, BATCH_LIMIT);

    // 4. Fire and Forget Response
    // Send 202 Accepted immediately without waiting for index verifications and data sanitization
    res.status(202).json({ 
      status: 'accepted', 
      queuedLogs: processablePayloads.length,
      dropped: payloads.length - processablePayloads.length
    });

    // 5. Background Processing (via Queue)
    await enqueue<LogIngestPayload>(
      logIngestQueue,
      { payloads: processablePayloads, ownerId },
      () => { processLogIngestion(processablePayloads, ownerId).catch(err => logger.error('[LOGS] Background Global Ingest Error:', err)); },
    );

  } catch (error: any) {
    logger.error('[LOGS] Global Ingest Error', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
};

// --- 5. Fetch Single Log by ID (For Permalinks & Hard Refreshes) ---
export const getLogById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const log = await LogEvent.findOne({ _id: id, ownerId })
      .populate('serviceId', 'name')
      .lean();

    if (!log) return res.status(404).json({ error: 'Log not found' });
    res.json({ log });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Background Log Processor (called by queue worker or in-process fallback)
// ---------------------------------------------------------------------------
export const processLogIngestion = async (payloads: any[], ownerId: string): Promise<void> => {
  const logsToInsert = payloads.map((payload: any) => {
    if (!payload || typeof payload !== 'object') {
      payload = { message: String(payload) };
    }

    const { message, level, timestamp, traceId, spanId, service, ...attributes } = payload;

    const safeMessage = typeof message === 'string'
      ? (message.length > 50000 ? message.substring(0, 50000) + '... [TRUNCATED]' : message)
      : JSON.stringify(payload).substring(0, 50000);

    return {
      ownerId,
      serviceModel: service || 'External',
      message: safeMessage || 'Empty Log',
      level: (level || 'info').toLowerCase(),
      traceId: traceId ? String(traceId) : undefined,
      spanId: spanId ? String(spanId) : undefined,
      attributes: attributes || {},
      timestamp: timestamp ? new Date(timestamp) : new Date()
    };
  });

  if (logsToInsert.length > 0) {
    try {
      await LogEvent.insertMany(logsToInsert, { ordered: false });
    } catch (err: any) {
      if (err.name !== 'BulkWriteError') throw err;
    }
  }
};