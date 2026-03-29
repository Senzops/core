/**
 * GeoDbManager.ts
 *
 * Manages the lifecycle of the local GeoLite2-City.mmdb file:
 *   - Downloads on first run if the file is absent or stale
 *   - Performs atomic writes (temp file → rename) to avoid serving a half-written DB
 *   - Refreshes the database on a configurable schedule (default: every 5 days)
 *   - Exposes a typed singleton reader from `@maxmind/geoip2-node`
 *
 * Key TypeScript detail:
 *   `Reader` (the named export) is the class constructor.
 *   `Reader.open()` returns `Promise<ReaderInstance>` where ReaderInstance has
 *   the actual instance methods (.city(), .country(), etc.).
 *   We derive the correct stored type via:
 *     type ReaderInstance = Awaited<ReturnType<typeof Reader.open>>
 *   This avoids the "Property 'city' does not exist on type 'Reader'" error that
 *   occurs when the constructor type is used as the storage annotation.
 *
 * Environment variables:
 *   GEO_DB_PATH         Override the mmdb file path
 *                       (default: <cwd>/data/GeoLite2-City.mmdb)
 *   GEO_DB_MAX_AGE_DAYS Max age before auto-refresh (default: 5)
 */

import fs from 'fs';
import https from 'https';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { Reader } from '@maxmind/geoip2-node';
import { logger } from './logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The resolved instance type of the MaxMind Reader.
 * Must be derived this way — typing storage as `Reader` gives you the
 * constructor type (static members only), not the instance type.
 */
export type ReaderInstance = Awaited<ReturnType<typeof Reader.open>>;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_URL =
  'https://cdn.jsdelivr.net/gh/wp-statistics/GeoLite2-City@master/GeoLite2-City.mmdb.gz';

const DB_PATH =
  process.env.GEO_DB_PATH ??
  path.join(process.cwd(), 'data', 'GeoLite2-City.mmdb');

const MAX_AGE_MS =
  Number(process.env.GEO_DB_MAX_AGE_DAYS ?? 5) * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let _reader: ReaderInstance | null = null;
let _initialising: Promise<ReaderInstance> | null = null;
let _refreshTimer: NodeJS.Timeout | null = null;

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

const ensureDir = (filePath: string): void => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const fileAgeMs = (filePath: string): number => {
  try {
    return Date.now() - fs.statSync(filePath).mtimeMs;
  } catch {
    return Infinity; // File doesn't exist — treat as infinitely old
  }
};

// ---------------------------------------------------------------------------
// Download with atomic write (temp file → rename)
// ---------------------------------------------------------------------------

const downloadDatabase = async (): Promise<void> => {
  ensureDir(DB_PATH);

  const tmpPath = `${DB_PATH}.tmp`;
  logger.info(`[GeoDb] Downloading GeoLite2-City database from ${DB_URL}`);

  await new Promise<void>((resolve, reject) => {
    https
      .get(DB_URL, (res) => {
        if (res.statusCode !== 200) {
          res.resume(); // drain the socket
          return reject(
            new Error(`[GeoDb] HTTP ${res.statusCode} downloading GeoLite2-City database`)
          );
        }

        const writeStream = fs.createWriteStream(tmpPath);
        const gunzip = zlib.createGunzip();

        pipeline(res, gunzip, writeStream)
          .then(resolve)
          .catch((err) => {
            fs.unlink(tmpPath, () => { }); // clean up partial file
            reject(err);
          });
      })
      .on('error', (err) => {
        fs.unlink(tmpPath, () => { });
        reject(new Error(`[GeoDb] Network error: ${err.message}`));
      });
  });

  // Atomic swap — the live path is never in a partially-written state
  fs.renameSync(tmpPath, DB_PATH);
  logger.info(`[GeoDb] Database saved to ${DB_PATH}`);
};

// ---------------------------------------------------------------------------
// Reader initialisation
// ---------------------------------------------------------------------------

const openReader = async (): Promise<ReaderInstance> => {
  const age = fileAgeMs(DB_PATH);

  if (age > MAX_AGE_MS) {
    const reason =
      age === Infinity ? 'not found' : `${Math.round(age / 86_400_000)}d old`;
    logger.info(`[GeoDb] Database ${reason} — downloading fresh copy`);
    await downloadDatabase();
  } else {
    logger.info(
      `[GeoDb] Loading existing database (age: ${Math.round(age / 3_600_000)}h)`
    );
  }

  // Reader.open() returns Promise<ReaderInstance> — the instance has .city(), .country(), etc.
  const reader = await Reader.open(DB_PATH);
  logger.info('[GeoDb] GeoLite2-City reader ready');
  return reader;
};

// ---------------------------------------------------------------------------
// Background refresh scheduler
// ---------------------------------------------------------------------------

const scheduleRefresh = (): void => {
  if (_refreshTimer) return;

  _refreshTimer = setTimeout(async () => {
    _refreshTimer = null;
    logger.info('[GeoDb] Scheduled database refresh starting');
    try {
      await downloadDatabase();
      _reader = await Reader.open(DB_PATH);
      logger.info('[GeoDb] Database refreshed in-place without restart');
    } catch (err) {
      logger.error(
        '[GeoDb] Scheduled refresh failed — continuing with existing reader',
        err
      );
    } finally {
      scheduleRefresh(); // Re-arm for the next cycle
    }
  }, MAX_AGE_MS + 30_000);

  _refreshTimer.unref(); // Don't block the event loop from exiting
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the singleton MaxMind ReaderInstance, initialising it on first call.
 * Subsequent calls return immediately from cache.
 * The returned instance has all database-specific methods: .city(), .country(), etc.
 */
export const getGeoReader = async (): Promise<ReaderInstance> => {
  if (_reader) return _reader;

  if (!_initialising) {
    _initialising = openReader()
      .then((reader) => {
        _reader = reader;
        scheduleRefresh();
        return reader;
      })
      .catch((err) => {
        _initialising = null; // Allow retry on next call
        throw err;
      });
  }

  return _initialising;
};

/**
 * Call once at application startup to pre-warm the reader.
 * Non-blocking — errors are logged, not thrown.
 */
export const initGeoDb = (): void => {
  getGeoReader().catch((err) =>
    logger.warn('[GeoDb] Pre-warm failed — will retry on first geo lookup', err)
  );
};