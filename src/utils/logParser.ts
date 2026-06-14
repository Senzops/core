import { compileLogSearch, escapeRegex } from './logQuery';

// ============================================================================
// parseLogQuery — backward-compatible entrypoint
// ----------------------------------------------------------------------------
// Thin wrapper over the safe log query engine (src/utils/logQuery.ts). Kept with
// the original signature so existing callers (dashboard, MCP tools, AI analysis)
// continue to work unchanged. Always returns a tenant- and time-scoped filter.
//
// On a malformed query it degrades gracefully to a safe literal substring match
// on `message`, so programmatic callers (AI/MCP) never error out.
// ============================================================================
export const parseLogQuery = (searchString: string, ownerId: string, startDate: Date) => {
  const base: Record<string, any> = { ownerId, timestamp: { $gte: startDate } };
  if (!searchString || !searchString.trim()) return base;

  try {
    const filter = compileLogSearch(searchString);
    if (filter && Object.keys(filter).length > 0) {
      return { ...base, ...filter };
    }
    return base;
  } catch {
    return { ...base, message: { $regex: escapeRegex(searchString.trim()), $options: 'i' } };
  }
};
