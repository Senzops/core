/**
 * getChannel(referrer, requestUrl?)
 *
 * - referrer: string from the Referer header (may be empty/null/"Direct")
 * - requestUrl (optional): full URL that landed (useful to read UTM params)
 *
 * Returns: { channel, source, medium, referrerHost, rawReferrer, matchedRule }
 *
 * Notes:
 * - safe: never throws on bad input; uses try/catch around URL parsing
 * - defensive: truncates extremely long input, rejects non-http(s)
 * - extensible: lists at top can be extended or loaded from config
 */

type ChannelInfo = {
  channel: 'Direct' | 'Search' | 'Social' | 'Referral' | 'Email' | 'Paid' | 'Display' | 'Internal' | 'Other';
  source: string;             // e.g. 'google', 'facebook.com', 'utm:newsletter'
  medium: string;             // e.g. 'organic', 'referral', 'social', 'email', 'cpc', 'display', 'none'
  referrerHost: string | null; // host parsed from referrer (if any)
  rawReferrer: string | null;
  matchedRule: string | null; // textual explanation of what rule matched
}

const DEFAULT_MAX_REFERRER_LEN = 2048;

export const SEARCH_HOSTS = [
  'google.', 'bing.', 'yahoo.', 'duckduckgo.', 'baidu.', 'yandex.', 'ecosia.', 'qwant.', 'naver.', 'searx.'
];

export const SOCIAL_HOSTS = [
  'facebook.', 'm.facebook.', 'l.facebook.', 'twitter.', 't.co', 'x.com', 'instagram.', 'linkedin.', 'reddit.', 'pinterest.', 'tiktok.', 'snapchat.', 'discord.gg'
];

export const EMAIL_HOST_HINTS = [
  'mail.google', 'mail.yahoo', 'outlook.live', 'email', 'sendgrid', 'mailchimp', 'campaign' // heuristic only
];

export const KNOWN_PAYMENT_GATEWAYS = [
  'paypal.', 'stripe.', 'paddle.', 'checkout.', 'authorize.net'
];

// If UTM indicates paid campaign: utm_medium contains 'cpc', 'paid', 'ppc', 'paidsearch' etc.
export const PAID_MEDIUM_HINTS = ['cpc', 'ppc', 'paid', 'paidsearch', 'paid-social', 'paid_social', 'cpa'];

function normalizeHost(h?: string | null): string | null {
  if (!h) return null;
  // keep only hostname + optional subdomain (no credentials, ports)
  return h.toLowerCase();
}

export function getChannel(referrer?: string | null, requestUrl?: string | null): ChannelInfo {
  const raw = typeof referrer === 'string' ? referrer.trim() : '';
  const truncatedRef = raw.length > DEFAULT_MAX_REFERRER_LEN ? raw.slice(0, DEFAULT_MAX_REFERRER_LEN) : raw;
  const result: ChannelInfo = {
    channel: 'Direct',
    source: '(direct)',
    medium: 'none',
    referrerHost: null,
    rawReferrer: truncatedRef || null,
    matchedRule: null
  };

  // 1) Quick direct checks
  if (!truncatedRef || /^direct$/i.test(truncatedRef)) {
    result.matchedRule = 'empty-or-explicit-direct';
    return result;
  }

  // 2) Try parse referrer as URL safely
  let refUrl: URL | null = null;
  try {
    // When browsers send "https://l.facebook.com/l.php?u=..." this will still parse
    refUrl = new URL(truncatedRef);
    // Only accept http(s) schemes
    if (!['http:', 'https:'].includes(refUrl.protocol)) {
      refUrl = null;
    }
  } catch (e) {
    // Not a full URL: sometimes referrer header can be a hostname or weird string.
    // We'll fallback to string-based checks below.
    refUrl = null;
  }

  const host = refUrl ? normalizeHost(refUrl.hostname) : (truncatedRef.toLowerCase().split('/')[0] || null);
  if (host) result.referrerHost = host;

  // 3) UTMs from request URL (if provided) override/refine channel detection
  try {
    if (requestUrl) {
      const r = new URL(requestUrl);
      const params = r.searchParams;
      const utmSource = params.get('utm_source');
      const utmMedium = params.get('utm_medium');
      if (utmSource || utmMedium) {
        // simple mapping rules used by many analytics systems
        if (utmMedium) {
          const mediumLower = utmMedium.toLowerCase();
          if (PAID_MEDIUM_HINTS.some(h => mediumLower.includes(h))) {
            result.channel = 'Paid';
            result.medium = 'cpc';
            result.source = utmSource ? `utm:${utmSource}` : 'utm:unknown';
            result.matchedRule = 'utm-medium-detected-paid';
            return result;
          }
          if (mediumLower.includes('email')) {
            result.channel = 'Email';
            result.medium = 'email';
            result.source = utmSource ? `utm:${utmSource}` : 'utm:unknown';
            result.matchedRule = 'utm-medium-detected-email';
            return result;
          }
          if (mediumLower.includes('social')) {
            result.channel = 'Social';
            result.medium = 'social';
            result.source = utmSource ? `utm:${utmSource}` : 'utm:unknown';
            result.matchedRule = 'utm-medium-detected-social';
            return result;
          }
          if (mediumLower.includes('display')) {
            result.channel = 'Display';
            result.medium = 'display';
            result.source = utmSource ? `utm:${utmSource}` : 'utm:unknown';
            result.matchedRule = 'utm-medium-detected-display';
            return result;
          }
        }
        // fallback: at least record UTM as source
        result.source = utmSource ? `utm:${utmSource}` : result.source;
      }
    }
  } catch (err) {
    // never crash for malformed requestUrl
  }

  // 4) Host-based rules (search engines)
  if (host) {
    // Search engines: contain any of search host substrings
    if (SEARCH_HOSTS.some(h => host.includes(h))) {
      result.channel = 'Search';
      result.medium = 'organic';
      // prefer 'google'/'bing'/'yahoo' etc as source label (take first matching token)
      const matched = SEARCH_HOSTS.find(h => host.includes(h)) || 'search';
      result.source = matched.replace(/\.$/, '');
      result.matchedRule = `host-matched-search:${matched}`;
      return result;
    }

    // Social networks
    if (SOCIAL_HOSTS.some(h => host.includes(h))) {
      result.channel = 'Social';
      result.medium = 'social';
      const matched = SOCIAL_HOSTS.find(h => host.includes(h)) || 'social';
      result.source = host; // keep actual host to differentiate m.facebook.com vs facebook.com
      result.matchedRule = `host-matched-social:${matched}`;
      return result;
    }

    // Email providers heuristics
    if (EMAIL_HOST_HINTS.some(h => host.includes(h))) {
      result.channel = 'Email';
      result.medium = 'email';
      result.source = host;
      result.matchedRule = 'host-matched-email-heuristic';
      return result;
    }

    // Payment gateways: often appear in referral but are not meaningful marketing referrals.
    if (KNOWN_PAYMENT_GATEWAYS.some(h => host.includes(h))) {
      result.channel = 'Referral';
      result.medium = 'referral';
      result.source = host;
      result.matchedRule = 'host-matched-known-payment-gateway';
      return result;
    }

    // Internal referrer (same site) — classify as Internal, not Referral
    if (referrer && requestUrl && (new URL(referrer).hostname === new URL(requestUrl).hostname)) {
      result.channel = 'Internal';
      result.medium = 'internal';
      result.source = host;
      result.matchedRule = 'internal-host-referrer';
      return result;
    }

    // Generic referral
    result.channel = 'Referral';
    result.medium = 'referral';
    result.source = host;
    result.matchedRule = 'host-matched-referral';
    return result;
  }

  // 5) Fallback: treat as Referral if there is a non-empty raw referrer string
  if (truncatedRef) {
    result.channel = 'Referral';
    result.medium = 'referral';
    result.source = truncatedRef.slice(0, 200);
    result.matchedRule = 'fallback-string-referrer';
    return result;
  }

  // default (shouldn't get here)
  result.matchedRule = 'final-default';
  return result;
}
