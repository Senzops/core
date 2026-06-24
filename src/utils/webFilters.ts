// ============================================================================
// Web Analytics segmentation filters
// ----------------------------------------------------------------------------
// The dashboard lets a user drill into any dimension (click a country, browser,
// page, campaign…) and re-scope every panel by it. Filters arrive as discrete,
// allowlisted `f_<dim>` query params so they are cacheable and shareable. Only
// the dimensions declared here are honoured — arbitrary fields can never reach
// the Mongo match. Each maps to its field on the WebEvent document.
// ============================================================================

/** dim (query key, without the `f_` prefix) -> WebEvent document field path. */
export const WEB_FILTER_FIELDS: Record<string, string> = {
  country: 'country',
  region: 'region',
  city: 'city',
  browser: 'browser',
  os: 'os',
  device: 'device',
  channel: 'channel',
  referrer: 'referrer',
  path: 'path',
  language: 'language',
  screen: 'screen',
  utm_source: 'utm.source',
  utm_medium: 'utm.medium',
  utm_campaign: 'utm.campaign',
};

const MAX_FILTER_VALUE = 512;

export interface ParsedWebFilters {
  /** dim -> value, echoed back to the client so the UI can render chips. */
  applied: Record<string, string>;
  /** Mongo match fragment over WebEvent, spread into the base query. */
  match: Record<string, any>;
}

/**
 * Parses allowlisted `f_<dim>` filter params from a request query. Unknown keys,
 * empty values, and non-string values are ignored. Values are length-capped.
 */
export function parseWebFilters(query: Record<string, any>): ParsedWebFilters {
  const applied: Record<string, string> = {};
  const match: Record<string, any> = {};

  for (const [dim, field] of Object.entries(WEB_FILTER_FIELDS)) {
    const raw = query[`f_${dim}`];
    if (typeof raw === 'string' && raw.length > 0) {
      const value = raw.slice(0, MAX_FILTER_VALUE);
      applied[dim] = value;
      match[field] = value;
    }
  }

  return { applied, match };
}
