import { Subscription } from '../models/Subscription';
import { getPlanConfig } from '../config/pricing';

// Supported relative range presets. Capped at 7d — longer windows (up to the
// plan's full retention) are selected via an absolute start/end ("custom")
// range, which resolveTimeRange clamps to the tenant's retention.
const RELATIVE_RANGES = ['30m', '1h', '3h', '6h', '12h', '24h', '3d', '7d'] as const;
export type RelativeRange = typeof RELATIVE_RANGES[number];

// Service types surfaced to the dashboard. Retention is now unified and
// plan-based (identical across all of these); this list only fixes the key set
// returned by getAllRetentionLimits.
const SERVICE_TYPES = [
  'apm', 'rum', 'logs', 'task', 'web', 'database', 'firebase', 'server', 'errors', 'monitor', 'views',
] as const;

export interface ResolvedTimeRange {
  startDate: Date;
  endDate: Date;
  bucketFormat: string;
  bucketIncrementMs: number;
  granularityLabel: string;
}

export interface TimeRangeMeta {
  effectiveStart: string;
  effectiveEnd: string;
  maxRetentionDays: number;
  granularity: string;
}

const RELATIVE_RANGE_MS: Record<RelativeRange, number> = {
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '3h': 3 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

function isRelativeRange(value: string): value is RelativeRange {
  return RELATIVE_RANGES.includes(value as RelativeRange);
}

function computeBucketConfig(spanMs: number): { format: string; incrementMs: number; label: string } {
  const ONE_MINUTE = 60 * 1000;
  const ONE_HOUR = 60 * ONE_MINUTE;
  const ONE_DAY = 24 * ONE_HOUR;

  if (spanMs <= 2 * ONE_HOUR) {
    return { format: '%Y-%m-%dT%H:%M:00.000Z', incrementMs: ONE_MINUTE, label: '1m' };
  }
  if (spanMs <= 48 * ONE_HOUR) {
    return { format: '%Y-%m-%dT%H:00:00.000Z', incrementMs: ONE_HOUR, label: '1h' };
  }
  return { format: '%Y-%m-%d', incrementMs: ONE_DAY, label: '1d' };
}

/**
 * Resolves query parameters into a concrete time range with bucket configuration.
 * Supports both relative ranges (?range=24h) and absolute ranges (?start=...&end=...).
 * Clamps startDate to the effective retention limit for the given service type.
 */
export function resolveTimeRange(
  params: { range?: string; start?: string; end?: string },
  maxRetentionDays: number
): ResolvedTimeRange {
  const now = new Date();
  let startDate: Date;
  let endDate: Date = now;

  if (params.start && params.end) {
    startDate = new Date(params.start);
    endDate = new Date(params.end);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      throw new TimeRangeError('Invalid ISO 8601 date format for start or end');
    }
    if (startDate >= endDate) {
      throw new TimeRangeError('start must be before end');
    }
    if (endDate > now) {
      endDate = now;
    }
  } else {
    const range = params.range || '24h';
    if (!isRelativeRange(range)) {
      throw new TimeRangeError(`Invalid range. Supported: ${RELATIVE_RANGES.join(', ')}`);
    }
    startDate = new Date(now.getTime() - RELATIVE_RANGE_MS[range]);
  }

  // Clamp to retention limit
  const retentionFloor = new Date(now.getTime() - maxRetentionDays * 24 * 60 * 60 * 1000);
  if (startDate < retentionFloor) {
    startDate = retentionFloor;
  }

  const spanMs = endDate.getTime() - startDate.getTime();
  const { format, incrementMs, label } = computeBucketConfig(spanMs);

  // Align startDate DOWN to bucket boundary so the first bucket has complete data.
  // Without this, startDate falls mid-bucket (e.g. 14:05:45 for a 1m bucket),
  // MongoDB excludes data before that instant, but fillTimeGaps generates a bucket
  // key for the full boundary (14:05:00) — resulting in an empty first bucket.
  if (label === '1m') {
    startDate = new Date(startDate);
    startDate.setSeconds(0, 0);
  } else if (label === '1h') {
    startDate = new Date(startDate);
    startDate.setMinutes(0, 0, 0);
  } else {
    startDate = new Date(startDate);
    startDate.setHours(0, 0, 0, 0);
  }

  return { startDate, endDate, bucketFormat: format, bucketIncrementMs: incrementMs, granularityLabel: label };
}

/**
 * Builds the response metadata block for a resolved time range.
 */
export function buildTimeRangeMeta(resolved: ResolvedTimeRange, maxRetentionDays: number): TimeRangeMeta {
  return {
    effectiveStart: resolved.startDate.toISOString(),
    effectiveEnd: resolved.endDate.toISOString(),
    maxRetentionDays,
    granularity: resolved.granularityLabel,
  };
}

/**
 * Effective max retention for a service type. Retention is unified and
 * plan-based across all collections, so this is simply the plan's window.
 * `serviceType` is retained for call-site compatibility and future per-type
 * overrides.
 */
export async function getEffectiveRetention(_serviceType: string, ownerId: string): Promise<number> {
  const sub = await Subscription.findOne({ ownerId }).select('planId').lean();
  return getPlanConfig(sub?.planId).retentionDays;
}

/**
 * Returns max retention days for all service types. With unified plan-based
 * retention every service shares the same window (the plan's retentionDays).
 */
export async function getAllRetentionLimits(ownerId: string): Promise<Record<string, number>> {
  const sub = await Subscription.findOne({ ownerId }).select('planId').lean();
  const retentionDays = getPlanConfig(sub?.planId).retentionDays;

  const result: Record<string, number> = {};
  for (const service of SERVICE_TYPES) {
    result[service] = retentionDays;
  }
  return result;
}

/**
 * Zero-fills time series gaps based on the resolved bucket configuration.
 * Generic: works with any field set via the `defaults` parameter.
 */
export function fillTimeGaps<T extends Record<string, any>>(
  data: T[],
  resolved: ResolvedTimeRange,
  defaults: Omit<T, 'time'>,
  idField: keyof T = '_id' as keyof T
): (T & { time: string })[] {
  const filled: (T & { time: string })[] = [];
  const { startDate, endDate, bucketIncrementMs, granularityLabel } = resolved;

  // Align start to bucket boundary
  const current = new Date(startDate);
  if (granularityLabel === '1m') {
    current.setSeconds(0, 0);
  } else if (granularityLabel === '1h') {
    current.setMinutes(0, 0, 0);
  } else {
    current.setHours(0, 0, 0, 0);
  }

  const dataMap = new Map<string, T>();
  for (const item of data) {
    const key = (item[idField] ?? item.time) as string;
    dataMap.set(key, item);
  }

  while (current <= endDate) {
    let key: string;
    if (granularityLabel === '1m') {
      key = current.toISOString().slice(0, 16) + ':00.000Z';
    } else if (granularityLabel === '1h') {
      key = current.toISOString().slice(0, 13) + ':00:00.000Z';
    } else {
      key = current.toISOString().slice(0, 10);
    }

    const existing = dataMap.get(key);
    if (existing) {
      filled.push({ ...existing, time: key });
    } else {
      filled.push({ time: key, ...defaults } as T & { time: string });
    }

    current.setTime(current.getTime() + bucketIncrementMs);
  }

  return filled;
}

/**
 * Aligns a date DOWN to the bucket boundary for the given granularity, in UTC.
 * UTC is used so these boundaries match MongoDB's `$dateTrunc`/`$dateToString`
 * (which operate in UTC by default) regardless of the server's local timezone.
 */
function alignToBucket(date: Date, granularityLabel: string): Date {
  const d = new Date(date);
  if (granularityLabel === '1m') d.setUTCSeconds(0, 0);
  else if (granularityLabel === '1h') d.setUTCMinutes(0, 0, 0);
  else d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Fills a time series that carries an online/offline status, used for
 * agent-style telemetry (e.g. VPS) where the heartbeat itself is the liveness
 * signal. Bucket-aware: steps at the resolved granularity (1m / 1h / 1d) so it
 * works for both the fine-grained real-time view and downsampled long ranges,
 * marks present buckets online (carry `isOnline` from the data, defaulting to
 * "online unless a synthetic heartbeat-miss"), and emits offline placeholder
 * points for empty *fully-elapsed* buckets.
 *
 * In-progress bucket handling: agents report a few seconds into each interval,
 * so the bucket that currently contains `now` is frequently empty simply because
 * its data hasn't arrived yet. Emitting it as "down" would be a false negative
 * (briefly flashing the server offline every interval). We therefore never
 * synthesize a down placeholder for the in-progress bucket — it is shown only
 * once real data exists for it. Fully-elapsed buckets keep normal gap→down
 * semantics (a genuine missing sample); real outages are also captured as
 * synthetic heartbeat-miss records by the staleness sweep.
 *
 * `emptyMetrics` is the zero-valued metrics shape to stamp on gap/offline
 * points, keeping this helper decoupled from any specific telemetry schema.
 */
export function fillTimeGapsWithStatus(
  data: any[],
  resolved: ResolvedTimeRange,
  emptyMetrics: Record<string, any>
): any[] {
  const { startDate, endDate, bucketIncrementMs, granularityLabel } = resolved;
  const filled: any[] = [];

  // Index existing points by bucket-aligned timestamp.
  const dataMap = new Map<number, any>();
  for (const item of data) {
    const key = alignToBucket(new Date(item.createdAt), granularityLabel).getTime();
    dataMap.set(key, item);
  }

  // Start of the bucket that currently contains "now" — its window has not yet
  // fully elapsed, so an absent sample is "not yet reported", not "down".
  const inProgressBucket = alignToBucket(new Date(), granularityLabel).getTime();

  const current = alignToBucket(startDate, granularityLabel);
  const end = endDate.getTime();

  while (current.getTime() <= end) {
    const key = current.getTime();
    const item = dataMap.get(key);

    if (item) {
      // Pre-aggregated points carry their own isOnline; raw samples are online
      // unless they are synthetic heartbeat-miss records.
      const isOnline = item.isOnline ?? item.metrics?._heartbeat !== 'miss';
      filled.push({ ...item, isOnline, createdAt: new Date(key).toISOString() });
    } else if (key < inProgressBucket) {
      // Fully-elapsed bucket with no sample → genuine gap (offline).
      filled.push({
        _id: 'gap-' + key,
        createdAt: new Date(key).toISOString(),
        isOnline: false,
        metrics: { ...emptyMetrics },
      });
    }
    // else: in-progress bucket awaiting data — skip (no false-negative).

    current.setTime(current.getTime() + bucketIncrementMs);
  }

  return filled;
}

export class TimeRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeRangeError';
  }
}

export { SERVICE_TYPES, RELATIVE_RANGES };
