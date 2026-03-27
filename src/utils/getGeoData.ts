/**
 * getGeoData.ts
 *
 * Two-tier geo lookup strategy:
 *
 *   Tier 1 (fast-path) — CDN-provided headers
 *     When the request passes through Cloudflare, Vercel Edge, or a
 *     correctly-configured Nginx proxy, geo data arrives pre-resolved
 *     in HTTP headers (CF-IPCountry, CF-IPCity, etc.).  Zero DB I/O.
 *
 *   Tier 2 (local DB) — MaxMind GeoLite2-City
 *     Uses the `maxmind` reader + `@ip-location-db/geolite2-city-mmdb`,
 *     which ships the .mmdb file directly in the npm package and publishes
 *     a new version every Tuesday & Friday (run `npm update` in your deploy
 *     pipeline to stay current — no MaxMind account or license key needed).
 *     A module-level singleton keeps the DB open across requests.
 *
 * Installation:
 *   npm install maxmind @ip-location-db/geolite2-city-mmdb
 *   npm uninstall geoip-lite
 *
 * Nginx Cloudflare proxy pass snippet (optional, enables Tier 1):
 *   proxy_set_header CF-Connecting-IP $remote_addr;
 *   proxy_set_header CF-IPCountry     $http_cf_ipcountry;
 *   proxy_set_header CF-IPCity        $http_cf_ipcity;
 */

import { Request } from "express";
import maxmind, { CityResponse, Reader } from "maxmind";
import { isPrivateOrLoopback } from "./getClientIp";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeoData {
  country: string;  // ISO 3166-1 alpha-2 (e.g. "US") or "Unknown"
  city: string;     // English city name or "Unknown"
}

// ---------------------------------------------------------------------------
// Singleton MaxMind reader
// ---------------------------------------------------------------------------

let _reader: Reader<CityResponse> | null = null;
let _readerLoading: Promise<Reader<CityResponse>> | null = null;

/**
 * Returns (and lazily initialises) the MaxMind DB reader singleton.
 * Safe to call concurrently — the loading promise is shared.
 */
const getReader = async (): Promise<Reader<CityResponse>> => {
  if (_reader) return _reader;

  if (!_readerLoading) {
    _readerLoading = (async () => {
      try {
        // @ip-location-db/geolite2-city-mmdb ships the .mmdb file directly
        // inside the npm package — no account, no license key, no background
        // processes.  The package is republished every Tue & Fri with a fresh
        // database, so keeping it current is just `npm update` in your CI/CD.
        const dbPath = require.resolve(
          "@ip-location-db/geolite2-city-mmdb/GeoLite2-City.mmdb"
        );
        _reader = await maxmind.open<CityResponse>(dbPath);
        logger.info(`MaxMind GeoLite2-City database loaded from: ${dbPath}`);
        return _reader;
      } catch (err) {
        _readerLoading = null; // allow retry on next call
        throw err;
      }
    })();
  }

  return _readerLoading;
};

// Pre-warm the reader at module load time (non-blocking).
getReader().catch((err) =>
  logger.warn("MaxMind DB pre-warm failed — will retry on first request", err)
);

// ---------------------------------------------------------------------------
// Tier 1: CDN / proxy header fast-path
// ---------------------------------------------------------------------------

/**
 * Try to resolve geo data from headers injected by Cloudflare or a
 * correctly-configured Nginx proxy.  Returns null if headers are absent.
 *
 * Supported headers (case-insensitive):
 *   CF-IPCountry  (Cloudflare — ISO country code)
 *   CF-IPCity     (Cloudflare — city name, requires nginx re-injection)
 *   X-Vercel-IP-Country / X-Vercel-IP-City  (Vercel Edge)
 */
const getGeoFromHeaders = (req: Request): GeoData | null => {
  const h = req.headers;

  // Cloudflare
  const cfCountry = (h["cf-ipcountry"] as string)?.trim();
  const cfCity = (h["cf-ipcity"] as string)?.trim();

  // Vercel Edge
  const vercelCountry = (h["x-vercel-ip-country"] as string)?.trim();
  const vercelCity = (h["x-vercel-ip-city"] as string)?.trim();

  const country = cfCountry || vercelCountry;
  const city = cfCity || vercelCity;

  // Cloudflare sends "XX" for unknown country — treat as missing
  if (country && country !== "XX" && country !== "T1") {
    return {
      country,
      city: city && city !== "" ? city : "Unknown",
    };
  }

  return null;
};

// ---------------------------------------------------------------------------
// Tier 2: Local MaxMind DB lookup
// ---------------------------------------------------------------------------

const getGeoFromDB = async (ip: string): Promise<GeoData> => {
  const fallback: GeoData = { country: "Unknown", city: "Unknown" };

  if (isPrivateOrLoopback(ip)) {
    // Private IPs will never have a geo entry — skip the lookup entirely
    logger.debug(`Skipping geo lookup for private/loopback IP: ${ip}`);
    return fallback;
  }

  try {
    const reader = await getReader();
    const result = reader.get(ip);

    if (!result) return fallback;

    const country =
      result.country?.iso_code ??
      result.registered_country?.iso_code ??
      "Unknown";

    const city = result.city?.names?.en ?? "Unknown";

    return { country, city };
  } catch (err) {
    logger.error(`MaxMind geo lookup failed for IP ${ip}`, err);
    return fallback;
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve geo data for a given IP, using CDN headers as a fast-path when
 * available and falling back to a local MaxMind DB lookup.
 *
 * @param req  - Express request (used for CDN header fast-path)
 * @param ip   - Already-extracted client IP string
 */
export const getGeoData = async (
  req: Request | null,
  ip: string | null
): Promise<GeoData> => {
  // Tier 1: headers (free, instant) — only available when we have a live request
  const fromHeaders = req ? getGeoFromHeaders(req) : null;
  if (fromHeaders) return fromHeaders;

  // Tier 2: local DB
  if (!ip) return { country: "Unknown", city: "Unknown" };
  return getGeoFromDB(ip);
};