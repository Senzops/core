import crypto from 'crypto';

// ============================================================================
// Query text redaction.
// ----------------------------------------------------------------------------
// Query STRUCTURE is what makes an insight useful; query VALUES are the
// customer's data. PostgreSQL (pg_stat_statements) and MySQL (digest_text)
// hand us pre-normalized text with literals already replaced. MongoDB's
// profiler and Redis's SLOWLOG do not — they carry the actual values, which
// routinely means email addresses, tokens, and identifiers.
//
// Everything on the collection path passes through here before persistence, so
// there is no route by which a raw literal reaches the database. Structure is
// preserved throughout: field names, operators, and shape survive; values do
// not.
// ============================================================================

/** Maximum stored length. Long shapes are truncated with a visible marker. */
const MAX_TEXT_LENGTH = 4000;

const PLACEHOLDER = '?';

export const truncate = (text: string, max = MAX_TEXT_LENGTH): string =>
  text.length <= max ? text : `${text.slice(0, max)} … [truncated]`;

/**
 * Stable identity for a query shape. Used where the engine supplies no digest
 * of its own (MongoDB profiler entries, Redis commands), so the same shape
 * aggregates across intervals instead of fragmenting into one row per sighting.
 */
export const digestOf = (text: string): string =>
  crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);

/**
 * Collapses literals in already-normalized engine text.
 *
 * pg_stat_statements emits `$1`-style parameters and MySQL emits `?`, but both
 * still pass through IN-lists and numeric constants in places the normalizer
 * misses. This is a second pass, not the primary defence.
 */
export const normalizeSqlText = (sql: string): string =>
  truncate(
    sql
      .replace(/\s+/g, ' ')
      // Collapse long IN (...) lists to a single marker so `IN ($1,$2,...$400)`
      // does not fragment one shape into hundreds of distinct digests.
      .replace(/\bIN\s*\(\s*(?:[$?]\d*|\d+|'[^']*')\s*(?:,\s*(?:[$?]\d*|\d+|'[^']*')\s*)*\)/gi, 'IN (...)')
      .replace(/'[^']*'/g, PLACEHOLDER)
      .replace(/\b\d+\.\d+\b/g, PLACEHOLDER)
      .trim()
  );

/** Keys the MongoDB profiler uses for the command body, in priority order. */
const COMMAND_KEYS = ['command', 'originatingCommand', 'query'];

/**
 * Rebuilds a Mongo command with every leaf value replaced by a placeholder.
 *
 * Keys — whether operators like `$match` or field names like `email` — are the
 * shape and are kept. Every leaf is a value and is not: recursion reaches all
 * of them, so no key needs special handling. Arrays collapse to a single
 * element so a 500-item `$in` does not become a 500-item shape.
 */
const redactMongoValue = (value: any, depth = 0): any => {
  if (depth > 12) return PLACEHOLDER;
  if (value === null || value === undefined) return PLACEHOLDER;

  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const first = redactMongoValue(value[0], depth + 1);
    return value.length === 1 ? [first] : [first, `…+${value.length - 1}`];
  }

  if (typeof value === 'object') {
    // BSON scalars (ObjectId, Decimal128, Long, Date) are values, not structure.
    if (value._bsontype || value instanceof Date) return PLACEHOLDER;

    const out: Record<string, any> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = redactMongoValue(child, depth + 1);
    }
    return out;
  }

  return PLACEHOLDER;
};

export const redactMongoCommand = (entry: any): string => {
  const body = COMMAND_KEYS.map((k) => entry?.[k]).find(Boolean) || entry;
  try {
    return truncate(JSON.stringify(redactMongoValue(body)));
  } catch {
    return '[unserializable command]';
  }
};

/**
 * Redis commands: keep the verb, and reduce the key to its namespace prefix.
 *
 * `GET user:a1b2c3:email` becomes `GET user:*`. The prefix is what identifies
 * the access pattern; the identifier after it is the data. Remaining arguments
 * are dropped entirely — SET payloads and AUTH credentials both live there.
 */
export const redactRedisCommand = (args: string[]): string => {
  if (args.length === 0) return '[empty]';
  const verb = String(args[0]).toUpperCase();
  if (args.length === 1) return verb;

  const key = String(args[1]);
  const separator = key.indexOf(':');
  const shape = separator > 0 ? `${key.slice(0, separator)}:*` : '*';

  const extra = args.length > 2 ? ` …+${args.length - 2} args` : '';
  return truncate(`${verb} ${shape}${extra}`);
};

/** Maps engine-reported verbs onto the shared operation vocabulary. */
export const classifyOperation = (
  raw: string | undefined
): 'select' | 'insert' | 'update' | 'delete' | 'aggregate' | 'command' | 'other' => {
  const value = (raw || '').toLowerCase();
  if (!value) return 'other';
  if (value.includes('aggregate')) return 'aggregate';
  if (value.includes('select') || value.includes('find') || value.includes('get') || value.includes('query')) return 'select';
  if (value.includes('insert') || value.includes('set') || value.includes('create')) return 'insert';
  if (value.includes('update') || value.includes('upsert') || value.includes('incr')) return 'update';
  if (value.includes('delete') || value.includes('remove') || value.includes('del')) return 'delete';
  if (value.includes('command')) return 'command';
  return 'other';
};
