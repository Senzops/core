import type { IIndexEntry, IndexFlag } from '../models/DbIndexStat';
import type { Advisory } from './dbAdvisor';

// ============================================================================
// Index advisor.
// ----------------------------------------------------------------------------
// Two analyses over the index census, plus one over query shapes:
//
//   Redundancy — an index whose key list is a strict prefix of another's is
//     already served by that other index. B-tree indexes (every engine here)
//     can answer any leading-prefix query, so { a } is redundant beside
//     { a, b }. Uniqueness breaks this: { a } UNIQUE enforces a constraint
//     { a, b } does not, so it is never redundant.
//
//   Unused — zero scans since the server started. Only meaningful once the
//     server has been up long enough for the absence to mean something.
//
//   Missing — derived from query shapes with a poor examined-to-returned ratio.
//     For MongoDB the redacted shape retains field names, so a concrete index
//     can be suggested. For SQL it does not reliably survive normalization, so
//     the namespace is surfaced without pretending to know the columns.
//
// Everything here is advice. Suggested DDL is text to copy, never executed.
// ============================================================================

/** Below this, "unused" says more about uptime than about the index. */
const MIN_UPTIME_FOR_UNUSED_SECONDS = 7 * 24 * 60 * 60;

/** Scans below this over a long uptime are worth flagging but not removing. */
const RARELY_USED_THRESHOLD = 50;

/** Indexes larger than this get called out when they are also unused. */
const OVERSIZED_BYTES = 100 * 1024 * 1024;

/** Examined-per-returned above which a shape is a missing-index candidate. */
const SCAN_RATIO_THRESHOLD = 20;

const isProtected = (index: IIndexEntry) => index.primary || index.unique;

/**
 * True when `candidate`'s keys are a strict leading prefix of `other`'s.
 * Equal key lists are handled separately as duplicates.
 */
const isPrefixOf = (candidate: string[], other: string[]): boolean => {
  if (candidate.length === 0 || candidate.length >= other.length) return false;
  return candidate.every((key, i) => key === other[i]);
};

const sameKeys = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((key, i) => key === b[i]);

/**
 * Annotates each index with the flags it has earned. Returns a new array;
 * the input is not mutated.
 */
export const analyzeIndexes = (
  indexes: IIndexEntry[],
  serverUptimeSeconds: number
): IIndexEntry[] => {
  const uptimeSufficient = serverUptimeSeconds >= MIN_UPTIME_FOR_UNUSED_SECONDS;

  // Redundancy is only meaningful within one collection/table.
  const byNamespace = new Map<string, IIndexEntry[]>();
  for (const index of indexes) {
    const list = byNamespace.get(index.namespace) || [];
    list.push(index);
    byNamespace.set(index.namespace, list);
  }

  return indexes.map((index) => {
    const flags: IndexFlag[] = [];
    let redundantWith: string | undefined;

    const siblings = (byNamespace.get(index.namespace) || []).filter((s) => s.name !== index.name);

    if (!isProtected(index)) {
      const duplicate = siblings.find((s) => sameKeys(index.keys, s.keys));
      if (duplicate) {
        flags.push('duplicate');
        redundantWith = duplicate.name;
      } else {
        const covering = siblings.find((s) => isPrefixOf(index.keys, s.keys));
        if (covering) {
          flags.push('redundant');
          redundantWith = covering.name;
        }
      }
    }

    if (index.scans === 0) {
      // A primary key with no recorded scans is normal — lookups by it are
      // frequently served without touching the usage counter — and it cannot
      // be dropped regardless, so flagging it is noise.
      if (uptimeSufficient && !index.primary) flags.push('unused');
    } else if (uptimeSufficient && index.scans < RARELY_USED_THRESHOLD && !isProtected(index)) {
      flags.push('rarely-used');
    }

    if (index.sizeBytes >= OVERSIZED_BYTES && flags.includes('unused')) {
      flags.push('oversized');
    }

    return { ...index, flags, redundantWith };
  });
};

const bytes = (n: number) => {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
};

const days = (seconds: number) => Math.floor(seconds / 86400);

/** Drop statement for the engine, as copyable text. Never executed by Senzor. */
const dropStatement = (
  engine: 'mongodb' | 'postgresql' | 'mysql',
  index: IIndexEntry
): string => {
  if (engine === 'mongodb') {
    const collection = index.namespace.split('.').slice(1).join('.') || index.namespace;
    return `db.getCollection("${collection}").dropIndex("${index.name}")`;
  }
  if (engine === 'postgresql') return `DROP INDEX CONCURRENTLY ${index.name};`;
  return `ALTER TABLE ${index.namespace} DROP INDEX \`${index.name}\`;`;
};

export interface QueryShapeSummary {
  digestHash: string;
  queryText: string;
  namespace?: string;
  executions: number;
  examinedPerReturned?: number | null;
}

/**
 * Extracts candidate index fields from a redacted MongoDB shape.
 *
 * Redaction removes values but keeps field names, so `{"filter":{"email":"?"}}`
 * still names the field worth indexing. Equality predicates are ordered before
 * range and sort fields, which is the ESR rule MongoDB's own guidance uses.
 * Returns null when the shape cannot be parsed — a wrong suggestion is worse
 * than none.
 */
export const suggestMongoIndex = (queryText: string): string | null => {
  let parsed: any;
  try {
    parsed = JSON.parse(queryText);
  } catch {
    return null;
  }

  const filter = parsed?.filter || parsed?.q;
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return null;

  const equality: string[] = [];
  const range: string[] = [];

  for (const [field, predicate] of Object.entries(filter)) {
    if (field.startsWith('$')) continue; // $and / $or — too ambiguous to guess
    const isRange =
      predicate && typeof predicate === 'object' && !Array.isArray(predicate) &&
      Object.keys(predicate as object).some((op) => ['$gt', '$gte', '$lt', '$lte'].includes(op));
    (isRange ? range : equality).push(field);
  }

  const sortFields = parsed?.sort && typeof parsed.sort === 'object' ? Object.keys(parsed.sort) : [];

  const ordered = [...equality, ...sortFields.filter((f) => !equality.includes(f)), ...range];
  const unique = ordered.filter((f, i) => ordered.indexOf(f) === i).slice(0, 4);
  if (unique.length === 0) return null;

  return `{ ${unique.map((f) => `"${f}": 1`).join(', ')} }`;
};

/**
 * Builds advisories from the index census and the window's query shapes.
 * Ranked by the size or cost they represent, most consequential first.
 */
export const buildIndexAdvisories = (
  engine: 'mongodb' | 'postgresql' | 'mysql' | 'redis',
  indexes: IIndexEntry[],
  serverUptimeSeconds: number,
  shapes: QueryShapeSummary[] = []
): Advisory[] => {
  if (engine === 'redis') return []; // no secondary indexes to reason about

  const advisories: Advisory[] = [];

  const unused = indexes.filter((i) => i.flags.includes('unused'));
  if (unused.length > 0) {
    const wasted = unused.reduce((sum, i) => sum + i.sizeBytes, 0);
    advisories.push({
      id: 'index-unused',
      severity: wasted >= OVERSIZED_BYTES ? 'warning' : 'info',
      title: `${unused.length} unused index${unused.length === 1 ? '' : 'es'}`,
      detail: `${bytes(wasted)} across ${unused.length} index${unused.length === 1 ? '' : 'es'} with no recorded scans in ${days(serverUptimeSeconds)} days of uptime.`,
      remediation:
        `Each one still costs write throughput and disk. Confirm against your own workload before removing — usage counters reset when the server restarts. ` +
        unused.slice(0, 3).map((i) => dropStatement(engine, i)).join('  '),
    });
  }

  const redundant = indexes.filter(
    (i) => i.flags.includes('redundant') || i.flags.includes('duplicate')
  );
  if (redundant.length > 0) {
    const wasted = redundant.reduce((sum, i) => sum + i.sizeBytes, 0);
    advisories.push({
      id: 'index-redundant',
      severity: 'warning',
      title: `${redundant.length} redundant index${redundant.length === 1 ? '' : 'es'}`,
      detail: redundant
        .slice(0, 3)
        .map((i) => `${i.namespace}.${i.name} is already covered by ${i.redundantWith}`)
        .join('; ') + ` (${bytes(wasted)} total).`,
      remediation:
        'A B-tree index answers any leading-prefix query, so the shorter index adds write cost without adding read coverage. ' +
        redundant.slice(0, 3).map((i) => dropStatement(engine, i)).join('  '),
    });
  }

  // Missing-index candidates from the shapes that scan hardest.
  const candidates = shapes
    .filter((s) => (s.examinedPerReturned ?? 0) >= SCAN_RATIO_THRESHOLD && s.executions > 0)
    .sort((a, b) => (b.examinedPerReturned ?? 0) - (a.examinedPerReturned ?? 0))
    .slice(0, 3);

  for (const shape of candidates) {
    const suggestion = engine === 'mongodb' ? suggestMongoIndex(shape.queryText) : null;
    advisories.push({
      id: `index-missing-${shape.digestHash}`,
      severity: (shape.examinedPerReturned ?? 0) >= 100 ? 'warning' : 'info',
      title: `Query scans ${Math.round(shape.examinedPerReturned ?? 0)}× more rows than it returns`,
      detail: `${shape.namespace ? `${shape.namespace} — ` : ''}${shape.executions.toLocaleString('en-US')} executions in this window.`,
      remediation: suggestion
        ? `An index on ${suggestion} would let this shape seek instead of scan. Verify with explain() before creating it — Senzor never modifies your database.`
        : 'Review this shape against the indexes on its table. Run EXPLAIN against your own instance to confirm which columns would help before adding an index.',
    });
  }

  return advisories;
};
