/**
 * getGeoData.ts
 *
 * Two-tier geo lookup:
 *
 *   Tier 1 (fast-path) — CDN headers
 *     Cloudflare / Vercel inject ISO country codes and city names directly.
 *     Zero DB I/O. Used only when a live request object is available.
 *
 *   Tier 2 (local DB) — MaxMind GeoLite2-City via @maxmind/geoip2-node
 *     Uses ReaderInstance (the resolved instance type from Reader.open()),
 *     which correctly exposes .city() and all other database methods.
 *
 * Usage:
 *   Web ingest (req object available): getGeoData(req, clientIp)
 *   APM batch  (no req object):        getGeoData(null, payloadIp)
 */

import { Request } from 'express';
import { getGeoReader } from './GeoDbManager';
import { isPrivateOrLoopback } from './getClientIp';
import { logger } from './logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeoData {
  country: string; // ISO 3166-1 alpha-2 (e.g. "SG") or "Unknown"
  city: string;    // English city name (e.g. "Singapore") or "Unknown"
}

const FALLBACK: GeoData = { country: 'Unknown', city: 'Unknown' };

// ---------------------------------------------------------------------------
// Tier 1: CDN / proxy header fast-path
// ---------------------------------------------------------------------------

/**
 * Attempt to resolve geo data from Cloudflare or Vercel Edge headers.
 * Returns null if headers are absent or carry known placeholder values.
 */
const getGeoFromHeaders = (req: Request): GeoData | null => {
  const h = req.headers;

  const cfCountry = (h['cf-ipcountry'] as string | undefined)?.trim();
  const cfCity = (h['cf-ipcity'] as string | undefined)?.trim();
  const vercelCountry = (h['x-vercel-ip-country'] as string | undefined)?.trim();
  const vercelCity = (h['x-vercel-ip-city'] as string | undefined)?.trim();

  const country = cfCountry || vercelCountry;
  const city = cfCity || vercelCity;

  // "XX" = Cloudflare unknown, "T1" = Tor exit node — both unusable
  if (!country || country === 'XX' || country === 'T1') return null;

  return { country, city: city || 'Unknown' };
};

// ---------------------------------------------------------------------------
// Tier 2: Local MaxMind DB lookup
// ---------------------------------------------------------------------------

const getGeoFromDB = async (ip: string): Promise<GeoData> => {
  if (isPrivateOrLoopback(ip)) return FALLBACK;

  try {
    // getGeoReader() returns ReaderInstance — the awaited result of Reader.open().
    // This is the instance type, which correctly exposes .city(), .country(), etc.
    // (Storing/passing the Reader class itself as a type gives you the constructor,
    // which only has static members — that is what caused the TS error.)
    const reader = await getGeoReader();

    // .city() is synchronous on the reader instance. It throws AddressNotFoundError
    // when the IP has no record in the database — caught below.
    const response = reader.city(ip);

    const country =
      response.country?.isoCode ??
      response.registeredCountry?.isoCode ??
      'Unknown';

    // GeoLite2-City has city-level data for ~60-70% of IPs.
    // undefined here is normal and not an error condition.
    const city = response.city?.names?.en ?? 'Unknown';

    return { country, city };
  } catch (err: any) {
    // AddressNotFoundError is normal — the IP simply isn't in the database.
    // Everything else is a genuine infrastructure error worth logging.
    if (err?.name !== 'AddressNotFoundError') {
      logger.error(`[GeoDb] Lookup error for IP ${ip}: ${err?.message}`, err);
    }
    return FALLBACK;
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve geo data for a given IP.
 *
 * @param req  Express request (for CDN header fast-path), or null for APM batch path.
 * @param ip   Normalised IP string from getClientIp() / normaliseIP(). May be null.
 */
export const getGeoData = async (
  req: Request | null,
  ip: string | null
): Promise<GeoData> => {
  if (req) {
    const fromHeaders = getGeoFromHeaders(req);
    if (fromHeaders) return fromHeaders;
  }

  if (!ip) return FALLBACK;
  return getGeoFromDB(ip);
};