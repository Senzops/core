import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { DatabaseService } from '../../models/Database';
import { DbQueryStat, DbSlowOp } from '../../models/DbQueryInsight';
import { resolveTimeRange, getEffectiveRetention, buildTimeRangeMeta, TimeRangeError } from '../../utils/timeRange';
import { DbIndexStat } from '../../models/DbIndexStat';
import { buildIndexAdvisories, type QueryShapeSummary } from '../../services/dbIndexAdvisor';
import { getAdapter, isSupportedDbType, disposeAllAdapters } from '../../worker/database/adapters';
import { decrypt } from '../../utils/crypto';

// ============================================================================
// Query insights API.
// ----------------------------------------------------------------------------
// Two reads over the same window:
//   /insights       — query shapes ranked by cost, plus the slow operation feed
//   /insights/:hash — one shape's trend and its recent individual executions
//
// Query text is withheld from public share links. The shapes stored here are
// already redacted of values, but a shape still describes the schema and access
// patterns of a customer's database, and a status page shared with the public
// is not the place for it.
// ============================================================================

const MAX_ROWS = 100;
const SLOW_OP_ROWS = 100;

const SORTABLE = {
  totalTime: 'totalTimeMs',
  meanTime: 'meanTimeMs',
  maxTime: 'maxTimeMs',
  executions: 'executions',
  examined: 'examinedPerReturned',
} as const;

type SortKey = keyof typeof SORTABLE;

const resolveSort = (raw: unknown): string =>
  SORTABLE[(raw as SortKey)] ?? SORTABLE.totalTime;

/**
 * True when the request arrived through a public share token.
 * `resolveShareContext` sets `req.share` and rewrites `req.ownerId` to the
 * share's owner, so ownerId alone cannot distinguish the two callers — the
 * presence of the share document is the only reliable signal.
 */
const isPublicShare = (req: Request): boolean => !!(req as any).share;

const REDACTED_TEXT = '[hidden on shared dashboards]';

export const getDatabaseInsights = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const ownerId = (req as any).ownerId;
    const { range, start, end, sort, search } = req.query;

    const db = await DatabaseService.findOne({ _id: id, ownerId }).select('type name').lean();
    if (!db) return res.status(404).json({ error: 'Database not found' });

    const maxRetention = await getEffectiveRetention('database', ownerId);
    const resolved = resolveTimeRange(
      { range: range as string, start: start as string, end: end as string },
      maxRetention
    );
    const { startDate, endDate } = resolved;
    const meta = buildTimeRangeMeta(resolved, maxRetention);

    const dbObjectId = new mongoose.Types.ObjectId(id);
    const window = { dbId: dbObjectId, timestamp: { $gte: startDate, $lte: endDate } };
    const sortField = resolveSort(sort);

    // Rows hold per-interval deltas, so a window's cost is their sum. Weighted
    // means are computed from the summed totals rather than averaging the
    // per-interval means, which would give a light interval the same weight as
    // a heavy one.
    const pipeline: any[] = [
      { $match: window },
      ...(typeof search === 'string' && search.trim()
        ? [{ $match: { queryText: { $regex: escapeRegex(search.trim()), $options: 'i' } } }]
        : []),
      {
        $group: {
          _id: '$digestHash',
          queryText: { $last: '$queryText' },
          namespace: { $last: '$namespace' },
          operation: { $last: '$operation' },
          planSummary: { $last: '$planSummary' },
          executions: { $sum: '$executions' },
          totalTimeMs: { $sum: '$totalTimeMs' },
          maxTimeMs: { $max: '$maxTimeMs' },
          rowsReturned: { $sum: '$rowsReturned' },
          rowsExamined: { $sum: '$rowsExamined' },
          blocksHit: { $sum: '$blocksHit' },
          blocksRead: { $sum: '$blocksRead' },
          tempBlocks: { $sum: '$tempBlocks' },
          lastSeen: { $max: '$timestamp' },
        },
      },
      {
        $addFields: {
          digestHash: '$_id',
          meanTimeMs: {
            $cond: [{ $gt: ['$executions', 0] }, { $divide: ['$totalTimeMs', '$executions'] }, 0],
          },
          examinedPerReturned: {
            $cond: [
              { $gt: ['$rowsReturned', 0] },
              { $divide: ['$rowsExamined', '$rowsReturned'] },
              null,
            ],
          },
        },
      },
      { $project: { _id: 0 } },
      { $sort: { [sortField]: -1 } },
      { $limit: MAX_ROWS },
    ];

    const [shapes, slowOps, totals] = await Promise.all([
      DbQueryStat.aggregate(pipeline),
      DbSlowOp.find({ dbId: dbObjectId, timestamp: { $gte: startDate, $lte: endDate } })
        .sort({ durationMs: -1 })
        .limit(SLOW_OP_ROWS)
        .lean(),
      DbQueryStat.aggregate([
        { $match: window },
        {
          $group: {
            _id: null,
            executions: { $sum: '$executions' },
            totalTimeMs: { $sum: '$totalTimeMs' },
            shapes: { $addToSet: '$digestHash' },
          },
        },
        { $project: { _id: 0, executions: 1, totalTimeMs: 1, shapeCount: { $size: '$shapes' } } },
      ]),
    ]);

    const hideText = isPublicShare(req);

    res.json({
      timeRange: meta,
      summary: totals[0] || { executions: 0, totalTimeMs: 0, shapeCount: 0 },
      shapes: hideText ? shapes.map((s) => ({ ...s, queryText: REDACTED_TEXT })) : shapes,
      slowOps: hideText ? slowOps.map((s) => ({ ...s, queryText: REDACTED_TEXT })) : slowOps,
      textRedacted: hideText,
    });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};

export const getDatabaseQueryShape = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, digestHash } = req.params;
    const ownerId = (req as any).ownerId;
    const { range, start, end } = req.query;

    const db = await DatabaseService.findOne({ _id: id, ownerId }).select('type').lean();
    if (!db) return res.status(404).json({ error: 'Database not found' });

    const maxRetention = await getEffectiveRetention('database', ownerId);
    const resolved = resolveTimeRange(
      { range: range as string, start: start as string, end: end as string },
      maxRetention
    );
    const { startDate, endDate, bucketFormat } = resolved;

    const dbObjectId = new mongoose.Types.ObjectId(id);
    const match = { dbId: dbObjectId, digestHash, timestamp: { $gte: startDate, $lte: endDate } };

    const [trend, latest, executions] = await Promise.all([
      DbQueryStat.aggregate([
        { $match: match },
        {
          $group: {
            _id: { $dateToString: { format: bucketFormat, date: '$timestamp' } },
            executions: { $sum: '$executions' },
            totalTimeMs: { $sum: '$totalTimeMs' },
            maxTimeMs: { $max: '$maxTimeMs' },
            rowsExamined: { $sum: '$rowsExamined' },
            rowsReturned: { $sum: '$rowsReturned' },
          },
        },
        {
          $addFields: {
            meanTimeMs: {
              $cond: [{ $gt: ['$executions', 0] }, { $divide: ['$totalTimeMs', '$executions'] }, 0],
            },
          },
        },
        { $sort: { _id: 1 } },
        { $project: { _id: 0, time: '$_id', executions: 1, totalTimeMs: 1, maxTimeMs: 1, meanTimeMs: 1, rowsExamined: 1, rowsReturned: 1 } },
      ]),
      DbQueryStat.findOne(match).sort({ timestamp: -1 }).lean(),
      DbSlowOp.find({ dbId: dbObjectId, digestHash, timestamp: { $gte: startDate, $lte: endDate } })
        .sort({ durationMs: -1 })
        .limit(25)
        .lean(),
    ]);

    if (!latest && trend.length === 0) {
      return res.status(404).json({ error: 'No data for this query shape in the selected range.' });
    }

    const hideText = isPublicShare(req);

    res.json({
      shape: latest
        ? { ...latest, queryText: hideText ? REDACTED_TEXT : latest.queryText }
        : null,
      trend,
      executions: hideText
        ? executions.map((e) => ({ ...e, queryText: REDACTED_TEXT }))
        : executions,
      textRedacted: hideText,
    });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};

/** User-supplied search text reaches a $regex, so metacharacters are escaped. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 200);
}

// ---------------------------------------------------------------------------
// GET /database/:id/indexes
//
// Composes two things the operator cannot usefully separate: what indexes
// exist and how they are used, and which query shapes are scanning hardest.
// The second is what turns "you have an unused index" into "and here is the
// index you are missing instead".
//
// Definitions and column names describe schema, so they are withheld from
// public share viewers on the same reasoning as query text.
// ---------------------------------------------------------------------------
export const getDatabaseIndexes = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const ownerId = (req as any).ownerId;
    const { range, start, end } = req.query;

    const db = await DatabaseService.findOne({ _id: id, ownerId }).select('type capabilities').lean();
    if (!db) return res.status(404).json({ error: 'Database not found' });

    const census = await DbIndexStat.findOne({ dbId: id }).lean();

    // Missing-index candidates come from the same window the user is viewing,
    // so the advice matches the charts beside it.
    let shapes: QueryShapeSummary[] = [];
    try {
      const maxRetention = await getEffectiveRetention('database', ownerId);
      const resolved = resolveTimeRange(
        { range: range as string, start: start as string, end: end as string },
        maxRetention
      );
      shapes = await DbQueryStat.aggregate([
        {
          $match: {
            dbId: new mongoose.Types.ObjectId(id),
            timestamp: { $gte: resolved.startDate, $lte: resolved.endDate },
          },
        },
        {
          $group: {
            _id: '$digestHash',
            queryText: { $last: '$queryText' },
            namespace: { $last: '$namespace' },
            executions: { $sum: '$executions' },
            rowsExamined: { $sum: '$rowsExamined' },
            rowsReturned: { $sum: '$rowsReturned' },
          },
        },
        {
          $addFields: {
            digestHash: '$_id',
            examinedPerReturned: {
              $cond: [{ $gt: ['$rowsReturned', 0] }, { $divide: ['$rowsExamined', '$rowsReturned'] }, null],
            },
          },
        },
        { $sort: { examinedPerReturned: -1 } },
        { $limit: 25 },
        { $project: { _id: 0 } },
      ]);
    } catch {
      // A bad range must not take the index view down with it.
      shapes = [];
    }

    const indexes = (census?.indexes || []) as any[];
    const advisories = buildIndexAdvisories(
      db.type as any,
      indexes,
      census?.serverUptimeSeconds || 0,
      shapes
    );

    const hideDefinitions = isPublicShare(req);

    res.json({
      collectedAt: census?.collectedAt || null,
      serverUptimeSeconds: census?.serverUptimeSeconds || 0,
      totalIndexes: census?.totalIndexes || 0,
      totalSizeBytes: census?.totalSizeBytes || 0,
      unusedSizeBytes: census?.unusedSizeBytes || 0,
      indexes: hideDefinitions
        ? indexes.map((i) => ({ ...i, definition: REDACTED_TEXT, keys: [] }))
        : indexes,
      advisories: hideDefinitions ? [] : advisories,
      textRedacted: hideDefinitions,
    });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};

// ---------------------------------------------------------------------------
// GET /database/:id/operations
//
// A live read, never stored. In-flight statements are the most sensitive thing
// this product can see — they are literally the customer's data in motion — so
// they are normalized by the adapter, returned once, and kept nowhere.
//
// Deliberately not exposed to public shares at all: unlike a query shape, a
// live operation feed reveals what is happening right now on the instance.
// ---------------------------------------------------------------------------
// Adapters pool their clients, which is what makes a 5-second live poll cheap.
// But this runs in the API process, and the pool cleanup that reclaims them
// lives in the WORKER — so without this sweep the API would hold an open
// connection to every customer database anyone ever opened this panel on,
// for as long as the process lived.
const LIVE_OPS_IDLE_MS = 5 * 60 * 1000;
const liveOpsLastUsed = new Map<string, number>();

const releaseIdleLiveOpsClients = async () => {
  const now = Date.now();
  for (const [dbId, lastUsed] of liveOpsLastUsed) {
    if (now - lastUsed < LIVE_OPS_IDLE_MS) continue;
    liveOpsLastUsed.delete(dbId);
    await disposeAllAdapters(dbId).catch(() => {});
  }
};

// unref so an idle sweep never holds the process open on shutdown.
setInterval(releaseIdleLiveOpsClients, LIVE_OPS_IDLE_MS).unref();

export const getDatabaseOperations = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const ownerId = (req as any).ownerId;

    const db = await DatabaseService.findOne({ _id: id, ownerId });
    if (!db) return res.status(404).json({ error: 'Database not found' });

    if (!isSupportedDbType(db.type)) {
      return res.status(400).json({ error: `Adapter for ${db.type} is not available.` });
    }

    const adapter = getAdapter(db.type);
    if (!adapter.getCurrentOperations) {
      return res.json({ operations: [], supported: false });
    }

    const caps: any = db.capabilities;
    const currentOpsCap = caps instanceof Map ? caps.get('currentOps') : caps?.currentOps;
    if (currentOpsCap && !currentOpsCap.available) {
      return res.status(200).json({
        operations: [],
        supported: true,
        blocked: true,
        reason: currentOpsCap.reason,
        remediation: currentOpsCap.remediation,
      });
    }

    try {
      liveOpsLastUsed.set(id, Date.now());
      const operations = await adapter.getCurrentOperations(id, decrypt(db.encryptedUri));
      res.json({ operations, supported: true, collectedAt: new Date().toISOString() });
    } catch (err: any) {
      // A live read failing is not a server error — the instance may simply be
      // unreachable this second. Report it as an empty, explained result.
      res.json({ operations: [], supported: true, error: err?.message || 'Could not read live operations.' });
    }
  } catch (error) {
    next(error);
  }
};
