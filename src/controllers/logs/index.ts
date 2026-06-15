import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { LogEvent, LogApiKey, LogIngestStat } from '../../models/Log';
import { parseLogQuery } from '../../utils/logParser';
import { normalizeSeverity } from '../../utils/severity';
import { hashApiKey } from '../../utils/hashApiKey';
import { redactLogDoc, isRedactionEnabled } from '../../utils/logRedaction';
import { recordIngestStat } from '../../services/logIngestStats';
import { logger } from '../../utils/logger';
import { resolveTimeRange, getEffectiveRetention, buildTimeRangeMeta, TimeRangeError } from '../../utils/timeRange';
import { logIngestQueue, enqueue, type LogIngestPayload } from '../../lib/queue';
import { getRetentionMs, stampExpiry } from '../../services/retentionCache';

// ============================================================================
// ENTERPRISE INGESTION CACHE
// Validating an API key via MongoDB on every log ingestion request will
// instantly bottleneck the database under load. This TTL cache keeps validated
// keys in blazing-fast Node.js RAM for 5 minutes. Keyed by the key HASH so no
// plaintext secret is ever held in memory.
// ============================================================================
const apiKeyCache = new Map<string, { ownerId: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX = 10000;

// Bounded LRU-on-insert: evict the oldest entry instead of flushing the whole
// cache, so a busy tenant's hot keys survive memory pressure.
const cacheSet = (hash: string, ownerId: string) => {
  if (apiKeyCache.size >= CACHE_MAX) {
    const oldest = apiKeyCache.keys().next().value;
    if (oldest !== undefined) apiKeyCache.delete(oldest);
  }
  apiKeyCache.set(hash, { ownerId, expiresAt: Date.now() + CACHE_TTL_MS });
};

/** Evicts a key from the RAM cache (called on revoke). Multi-instance caches
 *  still self-expire within CACHE_TTL_MS. */
export const evictLogKeyCache = (keyHash: string) => apiKeyCache.delete(keyHash);

const getOwnerIdFromKey = async (apiKey: string): Promise<string | null> => {
  const now = Date.now();
  const hash = hashApiKey(apiKey);

  // Return from RAM if valid
  const cached = apiKeyCache.get(hash);
  if (cached && cached.expiresAt > now) {
    return cached.ownerId;
  }

  // Primary: hashed lookup (active keys only)
  let record: any = await LogApiKey.findOne({ keyHash: hash, revokedAt: null }).lean();

  // Legacy fallback + self-heal: records created before the hashed-key migration
  // still match on plaintext. Backfill their hash inline so subsequent lookups
  // take the fast hashed path (and survive even if the batch migration hasn't run).
  if (!record) {
    const legacy = await LogApiKey.findOne({ key: apiKey, revokedAt: null });
    if (legacy) {
      legacy.keyHash = hash;
      if (!legacy.prefix) legacy.prefix = apiKey.slice(0, 14);
      legacy.save().catch((e) => logger.warn(`[LOGS] Key self-heal failed: ${e.message}`));
      record = legacy.toObject();
    }
  }

  if (!record) return null;

  const ownerId = record.ownerId.toString();
  cacheSet(hash, ownerId);

  // Throttled last-used tracking: only fires on a cache miss (≤ once per key per
  // CACHE_TTL_MS), so it never adds write load to the hot path.
  LogApiKey.updateOne({ _id: record._id }, { $set: { lastUsedAt: new Date() } })
    .catch((e) => logger.warn(`[LOGS] lastUsedAt update failed: ${e.message}`));

  return ownerId;
};

const MAX_KEYS_PER_OWNER = 25;
const newRawKey = () => `sz_log_${crypto.randomBytes(24).toString('hex')}`;
const publicKey = (rec: any) => ({
  id: rec._id,
  name: rec.name,
  prefix: rec.prefix,
  scopes: rec.scopes,
  lastUsedAt: rec.lastUsedAt || null,
  revokedAt: rec.revokedAt || null,
  createdAt: rec.createdAt,
});

// Opaque keyset cursor over (timestamp desc, _id desc).
const encodeCursor = (log: any): string =>
  Buffer.from(JSON.stringify({ t: new Date(log.timestamp).getTime(), id: String(log._id) })).toString('base64url');

const decodeCursor = (raw: string): { t: number; id: string } | null => {
  try {
    const o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof o?.t === 'number' && typeof o?.id === 'string' && mongoose.isValidObjectId(o.id)) return o;
  } catch { /* malformed cursor */ }
  return null;
};

// --- 1. Dashboard: Fetch & Search Logs ---
// Supports two pagination modes (both backward compatible):
//   * Keyset/cursor (preferred): ?cursor=<opaque> — O(1) at any depth, stable.
//   * Legacy page/skip: ?page=N — kept for the existing UI until Phase 4.
export const getDashboardLogs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 100, 1), 500);
    const search = (req.query.search as string) || '';
    const cursorParam = req.query.cursor as string | undefined;
    const { range, start, end } = req.query;

    const maxRetention = await getEffectiveRetention('logs', ownerId);
    const resolved = resolveTimeRange(
      { range: range as string, start: start as string, end: end as string },
      maxRetention
    );
    const { startDate, bucketFormat } = resolved;
    const meta = buildTimeRangeMeta(resolved, maxRetention);

    // Compile the search into a tenant- and time-scoped filter (safe engine).
    const query = parseLogQuery(search, ownerId, startDate);

    // Trend is only needed on the initial load, not on every "load more" page.
    const includeTrend = !cursorParam && page <= 1;
    const trendPromise = includeTrend
      ? LogEvent.aggregate([
          { $match: query },
          { $group: { _id: { $dateToString: { format: bucketFormat, date: '$timestamp' } }, count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ])
      : Promise.resolve(undefined);

    if (cursorParam) {
      // --- Keyset pagination ---
      let findQuery: Record<string, any> = query;
      const cur = decodeCursor(cursorParam);
      if (cur) {
        const keysetCond = {
          $or: [
            { timestamp: { $lt: new Date(cur.t) } },
            { timestamp: new Date(cur.t), _id: { $lt: new mongoose.Types.ObjectId(cur.id) } },
          ],
        };
        // Merge by appending to (or creating) a top-level $and so that a possible
        // $text operator from the search stays at the top level, as MongoDB requires.
        findQuery = Array.isArray(query.$and)
          ? { ...query, $and: [...query.$and, keysetCond] }
          : { ...query, $and: [keysetCond] };
      }

      const docs = await LogEvent.find(findQuery)
        .sort({ timestamp: -1, _id: -1 })
        .limit(limit + 1)
        .populate('serviceId', 'name')
        .lean();

      const hasMore = docs.length > limit;
      const logs = hasMore ? docs.slice(0, limit) : docs;
      const nextCursor = hasMore && logs.length ? encodeCursor(logs[logs.length - 1]) : null;
      const trend = await trendPromise;

      return res.json({ logs, trend, timeRange: meta, hasMore, nextCursor, pagination: { limit } });
    }

    // --- Legacy page/skip pagination ---
    const [logs, total, trend] = await Promise.all([
      LogEvent.find(query)
        .sort({ timestamp: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('serviceId', 'name')
        .lean(),
      LogEvent.countDocuments(query),
      trendPromise,
    ]);

    const pages = Math.ceil(total / limit);
    res.json({
      logs,
      trend,
      timeRange: meta,
      hasMore: page < pages,
      nextCursor: logs.length ? encodeCursor(logs[logs.length - 1]) : null,
      pagination: { total, page, limit, pages },
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

// Legacy single-key endpoint (kept for the pre-Phase-4 modal). Returns a usable
// key for first-time users; for existing users returns the legacy plaintext if
// still present, otherwise the masked prefix.
export const getLogApiKey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    let record: any = await LogApiKey.findOne({ ownerId, revokedAt: null }).sort({ createdAt: 1 });

    if (!record) {
      const rawKey = newRawKey();
      record = await LogApiKey.create({
        ownerId,
        name: 'Default Key',
        keyHash: hashApiKey(rawKey),
        prefix: rawKey.slice(0, 14),
        createdBy: (req as any).user?.uid,
      });
      return res.json({ key: rawKey, prefix: record.prefix, masked: false });
    }

    if (record.key) {
      return res.json({ key: record.key, prefix: record.prefix || record.key.slice(0, 14), masked: false });
    }

    return res.json({ key: `${record.prefix}${'•'.repeat(8)}`, prefix: record.prefix, masked: true });
  } catch (error) {
    next(error);
  }
};

// List all keys for the tenant (never returns the secret).
export const listLogKeys = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const keys = await LogApiKey.find({ ownerId }).sort({ createdAt: -1 }).lean();
    res.json({ keys: keys.map(publicKey) });
  } catch (error) {
    next(error);
  }
};

// Create a new key. Returns the full secret EXACTLY ONCE.
export const createLogKey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const name = (rawName || 'API Key').slice(0, 80);

    const activeCount = await LogApiKey.countDocuments({ ownerId, revokedAt: null });
    if (activeCount >= MAX_KEYS_PER_OWNER) {
      return res.status(400).json({ error: `Maximum of ${MAX_KEYS_PER_OWNER} active keys reached. Revoke an unused key first.` });
    }

    const rawKey = newRawKey();
    const record = await LogApiKey.create({
      ownerId,
      name,
      keyHash: hashApiKey(rawKey),
      prefix: rawKey.slice(0, 14),
      createdBy: (req as any).user?.uid,
    });

    res.status(201).json({ key: rawKey, record: publicKey(record) });
  } catch (error) {
    next(error);
  }
};

// Revoke (soft-delete) a key and evict it from the auth cache.
export const revokeLogKey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const record = await LogApiKey.findOne({ _id: id, ownerId });
    if (!record) return res.status(404).json({ error: 'Key not found' });
    if (record.revokedAt) return res.json({ ok: true, record: publicKey(record) });

    record.revokedAt = new Date();
    await record.save();
    if (record.keyHash) evictLogKeyCache(record.keyHash);

    res.json({ ok: true, record: publicKey(record) });
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
    if (!mongoose.isValidObjectId(id)) return res.status(404).json({ error: 'Log not found' });

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
// Shared helper: builds the tenant- and time-scoped filter from the request.
// ---------------------------------------------------------------------------
const buildScopedQuery = async (req: Request) => {
  const ownerId = (req as any).ownerId;
  const { range, start, end, search } = req.query;
  const maxRetention = await getEffectiveRetention('logs', ownerId);
  const resolved = resolveTimeRange(
    { range: range as string, start: start as string, end: end as string },
    maxRetention
  );
  const query = parseLogQuery((search as string) || '', ownerId, resolved.startDate);
  return { ownerId, query, resolved };
};

// --- 6. Facets: top values per field for the filter sidebar ---
const DEFAULT_FACETS = ['severityText', 'source', 'host', 'environment', 'serviceModel'];
const FACET_FIELD_MAP: Record<string, string> = {
  level: 'severityText', severity: 'severityText', severitytext: 'severityText',
  source: 'source', host: 'host', hostname: 'host',
  env: 'environment', environment: 'environment',
  service: 'serviceModel', servicemodel: 'serviceModel', traceid: 'traceId',
};

const resolveFacetPath = (field: string): string | null => {
  const f = field.toLowerCase();
  if (FACET_FIELD_MAP[f]) return FACET_FIELD_MAP[f];
  if (field.startsWith('attributes.') && /^attributes\.[A-Za-z0-9_.\-]+$/.test(field)) return field;
  if (/^[A-Za-z0-9_\-]+$/.test(field)) return `attributes.${field}`;
  return null;
};

export const getLogFacets = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { query } = await buildScopedQuery(req);

    const requested = typeof req.query.fields === 'string' && req.query.fields.trim()
      ? (req.query.fields as string).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8)
      : DEFAULT_FACETS;

    const fieldPaths = requested
      .map((f) => ({ label: f, path: resolveFacetPath(f) }))
      .filter((x) => x.path) as { label: string; path: string }[];

    const results = await Promise.all(
      fieldPaths.map(async ({ label, path }) => {
        const rows = await LogEvent.aggregate([
          { $match: query },
          { $group: { _id: `$${path}`, count: { $sum: 1 } } },
          { $match: { _id: { $ne: null } } },
          { $sort: { count: -1 } },
          { $limit: 20 },
        ]);
        return [label, rows.map((r) => ({ value: r._id, count: r.count }))] as const;
      })
    );

    res.json({ facets: Object.fromEntries(results) });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};

// --- 7. Context: logs immediately surrounding a given log in time ---
export const getLogContext = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(404).json({ error: 'Log not found' });

    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 50);
    const anchor = await LogEvent.findOne({ _id: id, ownerId }).populate('serviceId', 'name').lean();
    if (!anchor) return res.status(404).json({ error: 'Log not found' });

    const ts = anchor.timestamp;
    const anchorId = new mongoose.Types.ObjectId(id);

    const [olderDesc, newer] = await Promise.all([
      LogEvent.find({
        ownerId,
        $or: [{ timestamp: { $lt: ts } }, { timestamp: ts, _id: { $lt: anchorId } }],
      }).sort({ timestamp: -1, _id: -1 }).limit(limit).populate('serviceId', 'name').lean(),
      LogEvent.find({
        ownerId,
        $or: [{ timestamp: { $gt: ts } }, { timestamp: ts, _id: { $gt: anchorId } }],
      }).sort({ timestamp: 1, _id: 1 }).limit(limit).populate('serviceId', 'name').lean(),
    ]);

    res.json({ before: olderDesc.reverse(), anchor, after: newer });
  } catch (error) {
    next(error);
  }
};

// --- 8. Export: stream the current query as NDJSON or CSV ---
const EXPORT_MAX_ROWS = 100_000;

const csvCell = (v: any): string => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const exportLogs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { query } = await buildScopedQuery(req);
    const format = (req.query.format as string) === 'csv' ? 'csv' : 'ndjson';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

    res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="logs-${stamp}.${format}"`);

    // Backpressure-aware write (waits for drain when the socket buffer is full).
    const write = (chunk: string): Promise<void> =>
      res.write(chunk) ? Promise.resolve() : new Promise((resolve) => res.once('drain', () => resolve()));

    if (format === 'csv') {
      await write('timestamp,level,source,host,environment,traceId,spanId,message,attributes\n');
    }

    const cursor = LogEvent.find(query).sort({ timestamp: -1, _id: -1 }).limit(EXPORT_MAX_ROWS).lean().cursor();
    let count = 0;
    for await (const log of cursor as any) {
      if (format === 'csv') {
        await write([
          csvCell(new Date(log.timestamp).toISOString()),
          csvCell(log.severityText || log.level),
          csvCell(log.source), csvCell(log.host), csvCell(log.environment),
          csvCell(log.traceId), csvCell(log.spanId), csvCell(log.message),
          csvCell(log.attributes),
        ].join(',') + '\n');
      } else {
        await write(JSON.stringify({
          timestamp: log.timestamp, level: log.severityText || log.level,
          severityNumber: log.severityNumber, source: log.source, host: log.host,
          environment: log.environment, traceId: log.traceId, spanId: log.spanId,
          message: log.message, attributes: log.attributes,
        }) + '\n');
      }
      count++;
    }

    res.end();
    logger.info(`[LOGS] Export complete: ${count} rows (${format})`);
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    if (!res.headersSent) return next(error);
    res.end();
  }
};

// --- 9. Ingestion observability: accepted/dropped + per-key activity ---
export const getIngestStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const hours = Math.min(Math.max(parseInt(req.query.hours as string) || 24, 1), 168);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    since.setMinutes(0, 0, 0);

    const [buckets, keys] = await Promise.all([
      LogIngestStat.find({ ownerId, bucket: { $gte: since } }).sort({ bucket: 1 }).lean(),
      LogApiKey.find({ ownerId, revokedAt: null }).select('name prefix lastUsedAt').sort({ lastUsedAt: -1 }).lean(),
    ]);

    const accepted = buckets.reduce((s, b) => s + (b.accepted || 0), 0);
    const dropped = buckets.reduce((s, b) => s + (b.dropped || 0), 0);

    res.json({
      windowHours: hours,
      totals: { accepted, dropped, received: accepted + dropped },
      series: buckets.map((b) => ({ bucket: b.bucket, accepted: b.accepted || 0, dropped: b.dropped || 0 })),
      keys: keys.map((k: any) => ({ id: k._id, name: k.name, prefix: k.prefix, lastUsedAt: k.lastUsedAt || null })),
    });
  } catch (error) {
    next(error);
  }
};

// Allowed serviceModel values, derived from the schema enum (single source of
// truth — won't drift if the enum changes).
const VALID_SERVICE_MODELS: ReadonlySet<string> = new Set(
  (LogEvent.schema.path('serviceModel') as any)?.enumValues ?? ['ApmService', 'RumService', 'TaskService', 'External'],
);

// ---------------------------------------------------------------------------
// Background Log Processor (called by queue worker or in-process fallback)
// ---------------------------------------------------------------------------
export const processLogIngestion = async (payloads: any[], ownerId: string): Promise<void> => {
  const logsToInsert = payloads.map((payload: any) => {
    if (!payload || typeof payload !== 'object') {
      payload = { message: String(payload) };
    }

    const {
      message, level, severity, severityNumber,
      timestamp, traceId, spanId, service,
      source, host, hostname, environment, env,
      ...attributes
    } = payload;

    const safeMessage = typeof message === 'string'
      ? (message.length > 50000 ? message.substring(0, 50000) + '... [TRUNCATED]' : message)
      : JSON.stringify(payload).substring(0, 50000);

    const sev = normalizeSeverity({ level, severity, severityNumber });

    // serviceModel is the refPath discriminator for serviceId. Accept it from the
    // payload's `service` field only when it's a valid enum value; any other value
    // (e.g. "nginx") falls back to 'External' so a stray value can never fail enum
    // validation and silently drop the log — the "error boundary".
    const serviceModel = (typeof service === 'string' && VALID_SERVICE_MODELS.has(service)) ? service : 'External';

    // `source` is the human-meaningful origin of the log (e.g. "nginx", "payment-api").
    // The caller's `source`/`service` field becomes the displayed source.
    const rawSource = (typeof source === 'string' && source.trim()) ? source.trim()
      : (typeof service === 'string' && service.trim()) ? service.trim()
      : 'external';

    return {
      ownerId,
      serviceModel,
      message: safeMessage || 'Empty Log',
      level: sev.level,
      severityText: sev.severityText,
      severityNumber: sev.severityNumber,
      source: rawSource,
      host: typeof host === 'string' ? host : (typeof hostname === 'string' ? hostname : undefined),
      environment: typeof environment === 'string' ? environment : (typeof env === 'string' ? env : undefined),
      traceId: traceId ? String(traceId) : undefined,
      spanId: spanId ? String(spanId) : undefined,
      attributes: attributes || {},
      timestamp: timestamp ? new Date(timestamp) : new Date()
    };
  });

  if (logsToInsert.length === 0) return;

  // Optional PII/secret scrubbing (no-op unless LOG_REDACTION_ENABLED=true).
  if (isRedactionEnabled()) {
    for (const doc of logsToInsert) redactLogDoc(doc, true);
  }

  // Stamp plan-based expiry (anchor: timestamp) before insert.
  stampExpiry(logsToInsert, 'timestamp', await getRetentionMs(ownerId));

  try {
    const result = await LogEvent.insertMany(logsToInsert, { ordered: false });
    const dropped = logsToInsert.length - result.length;
    if (dropped > 0) {
      logger.warn(`[LOGS] Ingest partial: ${result.length}/${logsToInsert.length} inserted, ${dropped} dropped`);
    }
    recordIngestStat(ownerId, result.length, dropped);
  } catch (err: any) {
    // ordered:false continues past per-document failures (e.g. validation).
    // Account for them instead of swallowing silently — genuine infra failures
    // (DB down) are rethrown so the queue can retry.
    if (err.name === 'BulkWriteError' || err.code === 11000 || err.writeErrors) {
      const inserted = err.result?.insertedCount ?? err.insertedDocs?.length ?? 0;
      const dropped = logsToInsert.length - inserted;
      const sample = err.writeErrors?.[0]?.errmsg || err.writeErrors?.[0]?.err?.errmsg || err.message;
      logger.warn(`[LOGS] Ingest BulkWriteError: ${inserted}/${logsToInsert.length} inserted, ${dropped} dropped. Sample: ${sample}`);
      recordIngestStat(ownerId, inserted, dropped);
    } else {
      throw err;
    }
  }
};