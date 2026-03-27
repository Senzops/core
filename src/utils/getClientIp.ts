/**
 * getClientIp.ts
 *
 * Robust, proxy-aware client IP extraction.
 *
 * Priority order (mirrors Umami + industry best practice):
 *   1. ENV-configured custom header  (CLIENT_IP_HEADER)
 *   2. CF-Connecting-IP              (Cloudflare — single trusted IP)
 *   3. True-Client-IP                (Cloudflare Enterprise / Akamai)
 *   4. X-Real-IP                     (Nginx realip module)
 *   5. Forwarded                     (RFC 7239 — "for=" field)
 *   6. X-Forwarded-For               (De-facto standard — leftmost public IP)
 *   7. req.socket.remoteAddress      (Direct connection fallback)
 *
 * Security note: headers 2-6 can be spoofed by clients when your server is
 * directly internet-facing. If that is a concern, restrict extraction to the
 * header your trusted reverse-proxy injects (CLIENT_IP_HEADER or X-Real-IP).
 */

import { Request } from "express";
import { isIP } from "net";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip IPv4-mapped IPv6 prefix (::ffff:1.2.3.4 → 1.2.3.4) */
const stripIPv6Mapped = (ip: string): string =>
  ip.startsWith("::ffff:") ? ip.slice(7) : ip;

/** Strip optional port from an IPv4 address (1.2.3.4:5678 → 1.2.3.4). */
const stripIPv4Port = (ip: string): string => {
  const lastColon = ip.lastIndexOf(":");
  if (lastColon === -1) return ip;
  const maybeIP = ip.slice(0, lastColon);
  return isIP(maybeIP) === 4 ? maybeIP : ip;
};

/** Strip brackets + optional port from an IPv6 address ([::1]:5678 → ::1). */
const stripIPv6Brackets = (ip: string): string => {
  const match = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  return match ? match[1] : ip;
};

/** Normalise raw IP string into a clean, routable address (or null). */
export const normaliseIP = (raw: string | undefined | null): string | null => {
  if (!raw) return null;
  let ip = raw.trim();
  if (!ip) return null;

  ip = stripIPv6Brackets(ip);
  ip = stripIPv4Port(ip);
  ip = stripIPv6Mapped(ip);

  return isIP(ip) !== 0 ? ip : null;
};

/**
 * Returns true for IPs that will never produce a geo result:
 * loopback, link-local, private ranges, and unspecified addresses.
 */
export const isPrivateOrLoopback = (ip: string): boolean => {
  // IPv4 private / loopback / link-local
  if (
    ip === "127.0.0.1" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("169.254.") || // link-local
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) // 172.16–31
  )
    return true;

  // IPv6 loopback / unspecified / link-local / unique-local
  if (
    ip === "::1" ||
    ip === "::" ||
    ip.toLowerCase().startsWith("fe80:") || // link-local
    ip.toLowerCase().startsWith("fc") || // unique-local
    ip.toLowerCase().startsWith("fd") // unique-local
  )
    return true;

  return false;
};

// ---------------------------------------------------------------------------
// RFC 7239 "Forwarded" header parser
//   e.g.  Forwarded: for=192.0.2.60;proto=http, for="[2001:db8::cafe]"
// ---------------------------------------------------------------------------
const parseForwardedHeader = (header: string): string | null => {
  const parts = header.split(",");
  for (const part of parts) {
    const forMatch = part.match(/for=["[]?([^\]",;>\s]+)/i);
    if (forMatch) {
      const ip = normaliseIP(forMatch[1]);
      if (ip && !isPrivateOrLoopback(ip)) return ip;
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// X-Forwarded-For parser — pick the leftmost *public* IP
//   e.g.  X-Forwarded-For: client, proxy1, proxy2
// ---------------------------------------------------------------------------
const parseXForwardedFor = (header: string): string | null => {
  const ips = header.split(",").map((s) => s.trim());
  for (const raw of ips) {
    const ip = normaliseIP(raw);
    if (ip && !isPrivateOrLoopback(ip)) return ip;
  }
  // If every hop is private (intranet-only setup) fall back to first valid IP
  for (const raw of ips) {
    const ip = normaliseIP(raw);
    if (ip) return ip;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Extract the best-available client IP from an Express request.
 *
 * Returns `null` if no valid IP can be determined.
 */
export const getClientIp = (req: Request): string | null => {
  const h = req.headers;

  // 1. Operator-configured override (set CLIENT_IP_HEADER=CF-Connecting-IP etc.)
  const customHeader = process.env.CLIENT_IP_HEADER?.toLowerCase();
  if (customHeader) {
    const val = h[customHeader];
    const ip = normaliseIP(Array.isArray(val) ? val[0] : val);
    if (ip) return ip;
  }

  // 2. Cloudflare single-IP header (most reliable when behind CF)
  {
    const ip = normaliseIP(h["cf-connecting-ip"] as string);
    if (ip) return ip;
  }

  // 3. Cloudflare Enterprise / Akamai
  {
    const ip = normaliseIP(h["true-client-ip"] as string);
    if (ip) return ip;
  }

  // 4. Nginx realip module (single, already-trusted IP)
  {
    const ip = normaliseIP(h["x-real-ip"] as string);
    if (ip) return ip;
  }

  // 5. RFC 7239 Forwarded header
  {
    const fwd = h["forwarded"] as string;
    if (fwd) {
      const ip = parseForwardedHeader(fwd);
      if (ip) return ip;
    }
  }

  // 6. De-facto standard XFF
  {
    const xff = h["x-forwarded-for"] as string;
    if (xff) {
      const ip = parseXForwardedFor(xff);
      if (ip) return ip;
    }
  }

  // 7. Direct TCP connection (local dev / no proxy)
  {
    const raw = req.socket?.remoteAddress;
    const ip = normaliseIP(raw);
    if (ip) return ip;
  }

  return null;
};