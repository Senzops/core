import { Subscription } from '../models/Subscription';
import { getPlanConfig } from '../config/pricing';

// Supported relative range presets
const RELATIVE_RANGES = ['30m', '1h', '3h', '6h', '12h', '24h', '3d', '7d'] as const;
export type RelativeRange = typeof RELATIVE_RANGES[number];

// Collection-level TTL in days (derived from MongoDB expireAfterSeconds indexes)
const COLLECTION_TTL_DAYS: Record<string, number> = {
  apm: 8,
  rum: 8,
  logs: 7,
  task: 30,
  web: 32,
  database: 7,
  firebase: 7,
  server: 1,
  errors: 30,
  monitor: 7,
  views: 8,
};

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
 * Computes the effective max retention for a service type, clamped to the user's plan.
 */
export async function getEffectiveRetention(serviceType: string, ownerId: string): Promise<number> {
  const collectionTtl = COLLECTION_TTL_DAYS[serviceType] ?? 7;
  const sub = await Subscription.findOne({ ownerId }).select('planId').lean();
  const plan = getPlanConfig(sub?.planId);
  return Math.min(collectionTtl, plan.retentionDays);
}

/**
 * Returns max retention days for all service types, clamped to the user's plan.
 */
export async function getAllRetentionLimits(ownerId: string): Promise<Record<string, number>> {
  const sub = await Subscription.findOne({ ownerId }).select('planId').lean();
  const plan = getPlanConfig(sub?.planId);

  const result: Record<string, number> = {};
  for (const [service, ttl] of Object.entries(COLLECTION_TTL_DAYS)) {
    result[service] = Math.min(ttl, plan.retentionDays);
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

export class TimeRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeRangeError';
  }
}

export { COLLECTION_TTL_DAYS, RELATIVE_RANGES };
