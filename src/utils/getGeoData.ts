/**
 * getGeoData.ts
 *
 * Resolves country and city from a client IP address using geoip-lite.
 *
 * Why geoip-lite:
 *   - Synchronous, zero async overhead — safe to call in high-throughput ingest paths
 *   - Bundles the MaxMind GeoLite2 database in-process (no external service, no download)
 *   - Battle-tested, no runtime failure modes
 *
 * The original bugs this replaces were entirely in IP extraction, not in this library:
 *   - geoip-lite returns null for ::ffff:x.x.x.x (IPv4-mapped IPv6) → pass clean IPv4
 *   - geoip-lite returns null for private/loopback IPs → guard before lookup
 *   - geoip-lite city data is IPv4-only → normaliseIP() in getClientIp ensures clean IPv4
 *
 * Keeping the database fresh (run this in your deploy pipeline):
 *   MAXMIND_LICENSE_KEY=<your_free_key> npm run -w geoip-lite updatedb
 *   A free MaxMind licence key is available at: https://www.maxmind.com/en/geolite2/signup
 */

import geoip from 'geoip-lite';
import { isPrivateOrLoopback } from './getClientIp';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeoData {
  country: string; // ISO 3166-1 alpha-2 (e.g. "SG") or "Unknown"
  city: string;    // English city name (e.g. "Singapore") or "Unknown"
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve geo data for a normalised IPv4 address.
 *
 * @param ip - Clean IPv4 string from normaliseIP() / getClientIp().
 *             Must NOT be ::ffff: prefixed, bracketed, or contain a port.
 *             Pass null if IP extraction failed — returns fallback immediately.
 */
export const getGeoData = (ip: string | null): GeoData => {
  if (!ip || isPrivateOrLoopback(ip)) {
    return { country: 'Unknown', city: 'Unknown' };
  }

  const geo = geoip.lookup(ip);

  return {
    country: geo?.country || 'Unknown',
    city: geo?.city || 'Unknown',
  };
};