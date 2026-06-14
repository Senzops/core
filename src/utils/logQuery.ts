// ============================================================================
// Safe Log Query Engine
// ----------------------------------------------------------------------------
// Compiles a user-facing search string into a MongoDB filter. Replaces the old
// parseLogQuery, which fed raw user input straight into `new RegExp(...)` —
// a ReDoS and full-collection-scan liability.
//
// Pipeline:  tokenize  ->  parse (recursive descent AST)  ->  compile (MQL)
//
// Guarantees:
//   * Every regex is ESCAPED (literal) and bounded — no catastrophic backtracking.
//   * Wildcards (`*`) are anchored and capped.
//   * Hard limits on input length, token count and recursion depth.
//   * Pure free-text queries use the `message` text index ($text) for speed;
//     anything mixed with fields/operators falls back to safe substring regex.
//
// Supported syntax:
//   foo bar                  free text (AND of words, uses text index)
//   "exact phrase"           quoted free text
//   level:error              field equality (severity normalized)
//   status:>=500             range operators  >  >=  <  <=
//   status:!=200             not-equal
//   path:/api/*              wildcard (anchored)
//   userId:*                 field exists
//   status:(500 OR 502)      set membership ($in)
//   a AND b   a OR b   NOT a   -a   (a OR b)   boolean logic & grouping
// ============================================================================

import { normalizeSeverity, severityTextFromNumber, SEVERITY_ORDER, SeverityText } from './severity';

// --- Limits (defense in depth) ---
const MAX_INPUT = 4000;
const MAX_TOKENS = 256;
const MAX_DEPTH = 32;
const MAX_STARS = 5;
const MAX_IN = 100;

export class LogQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogQueryError';
  }
}

export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type CompareOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';

// ----------------------------------------------------------------------------
// 1. Tokenizer
// ----------------------------------------------------------------------------
type Token =
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'and' }
  | { t: 'or' }
  | { t: 'not' }
  | { t: 'comma' }
  | { t: 'term'; field?: string; op: CompareOp; value: string; wildcard: boolean; quoted: boolean };

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const isDelim = (c: string) => isSpace(c) || c === '(' || c === ')' || c === ',';
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_.\-]*$/;

interface RawTerm { text: string; colonAt: number; valueQuoted: boolean; anyQuote: boolean; next: number; }

function readTerm(input: string, i: number): RawTerm {
  let text = '';
  let colonAt = -1;
  let valueQuoted = false;
  let anyQuote = false;
  const n = input.length;

  while (i < n) {
    const c = input[i];
    if (c === '"' || c === "'") {
      anyQuote = true;
      const quote = c;
      i++;
      while (i < n && input[i] !== quote) { text += input[i]; i++; }
      i++; // consume closing quote
      if (colonAt >= 0) valueQuoted = true;
      continue;
    }
    if (isDelim(c)) break;
    if (c === ':' && colonAt < 0) colonAt = text.length;
    text += c;
    i++;
  }
  return { text, colonAt, valueQuoted, anyQuote, next: i };
}

function parseOpPrefix(rest: string): { op: CompareOp; value: string } {
  if (rest.startsWith('>=')) return { op: 'gte', value: rest.slice(2) };
  if (rest.startsWith('<=')) return { op: 'lte', value: rest.slice(2) };
  if (rest.startsWith('!=')) return { op: 'ne', value: rest.slice(2) };
  if (rest.startsWith('>')) return { op: 'gt', value: rest.slice(1) };
  if (rest.startsWith('<')) return { op: 'lt', value: rest.slice(1) };
  return { op: 'eq', value: rest };
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    if (tokens.length > MAX_TOKENS) throw new LogQueryError('Query too complex');
    const c = input[i];
    if (isSpace(c)) { i++; continue; }
    if (c === '(') { tokens.push({ t: 'lparen' }); i++; continue; }
    if (c === ')') { tokens.push({ t: 'rparen' }); i++; continue; }
    if (c === ',') { tokens.push({ t: 'comma' }); i++; continue; }

    // Leading '-' negation only at a term boundary, before a word/field/group.
    if (c === '-' && i + 1 < n && (/[A-Za-z_(]/.test(input[i + 1]))) {
      tokens.push({ t: 'not' });
      i++;
      continue;
    }

    const raw = readTerm(input, i);
    i = raw.next;
    if (raw.text === '' && !raw.anyQuote) continue;

    // Bare keyword (only when unquoted and not a field expression)
    if (!raw.anyQuote && raw.colonAt < 0) {
      const up = raw.text.toUpperCase();
      if (up === 'AND') { tokens.push({ t: 'and' }); continue; }
      if (up === 'OR') { tokens.push({ t: 'or' }); continue; }
      if (up === 'NOT') { tokens.push({ t: 'not' }); continue; }
    }

    if (raw.colonAt >= 0) {
      const field = raw.text.slice(0, raw.colonAt);
      const rest = raw.text.slice(raw.colonAt + 1);
      if (FIELD_RE.test(field)) {
        const { op, value } = raw.valueQuoted ? { op: 'eq' as CompareOp, value: rest } : parseOpPrefix(rest);
        tokens.push({
          t: 'term',
          field,
          op,
          value,
          wildcard: !raw.valueQuoted && value.includes('*'),
          quoted: raw.valueQuoted,
        });
        continue;
      }
      // Colon present but not a valid field (e.g. a time "12:30") → free text.
    }

    tokens.push({
      t: 'term',
      op: 'eq',
      value: raw.text,
      wildcard: !raw.anyQuote && raw.text.includes('*'),
      quoted: raw.anyQuote,
    });
  }

  return tokens;
}

// ----------------------------------------------------------------------------
// 2. Parser (recursive descent) → AST
// ----------------------------------------------------------------------------
type Node =
  | { type: 'and'; children: Node[] }
  | { type: 'or'; children: Node[] }
  | { type: 'not'; child: Node }
  | { type: 'compare'; field: string; op: CompareOp; value: string; wildcard: boolean; quoted: boolean }
  | { type: 'in'; field: string; values: string[] }
  | { type: 'text'; value: string };

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token | undefined { return this.tokens[this.pos++]; }

  parse(): Node | null {
    if (this.tokens.length === 0) return null;
    const node = this.parseOr(0);
    if (this.pos < this.tokens.length) {
      throw new LogQueryError('Unexpected token in query (check parentheses)');
    }
    return node;
  }

  private parseOr(depth: number): Node {
    this.guard(depth);
    let left = this.parseAnd(depth + 1);
    while (this.peek()?.t === 'or') {
      this.next();
      const right = this.parseAnd(depth + 1);
      left = { type: 'or', children: [left, right] };
    }
    return left;
  }

  private parseAnd(depth: number): Node {
    this.guard(depth);
    let left = this.parseNot(depth + 1);
    while (true) {
      const tk = this.peek();
      if (!tk || tk.t === 'or' || tk.t === 'rparen') break;
      if (tk.t === 'and') this.next(); // explicit AND (implicit otherwise)
      const right = this.parseNot(depth + 1);
      left = { type: 'and', children: [left, right] };
    }
    return left;
  }

  private parseNot(depth: number): Node {
    this.guard(depth);
    if (this.peek()?.t === 'not') {
      this.next();
      return { type: 'not', child: this.parseNot(depth + 1) };
    }
    return this.parsePrimary(depth + 1);
  }

  private parsePrimary(depth: number): Node {
    this.guard(depth);
    const tk = this.next();
    if (!tk) throw new LogQueryError('Unexpected end of query');

    if (tk.t === 'lparen') {
      const node = this.parseOr(depth + 1);
      const close = this.next();
      if (!close || close.t !== 'rparen') throw new LogQueryError('Unbalanced parentheses');
      return node;
    }

    if (tk.t === 'term') {
      // field:(a OR b)  → set membership
      if (tk.field && tk.value === '' && this.peek()?.t === 'lparen') {
        this.next(); // consume '('
        const values = this.parseValueGroup();
        return { type: 'in', field: tk.field, values };
      }
      if (tk.field) {
        return { type: 'compare', field: tk.field, op: tk.op, value: tk.value, wildcard: tk.wildcard, quoted: tk.quoted };
      }
      return { type: 'text', value: tk.value };
    }

    throw new LogQueryError('Unexpected token in query');
  }

  // Collects bare values inside `field:( ... )`, separated by OR / comma / space.
  private parseValueGroup(): string[] {
    const values: string[] = [];
    while (true) {
      const tk = this.peek();
      if (!tk) throw new LogQueryError('Unbalanced parentheses in value group');
      if (tk.t === 'rparen') { this.next(); break; }
      if (tk.t === 'or' || tk.t === 'comma' || tk.t === 'and') { this.next(); continue; }
      if (tk.t === 'term' && !tk.field) {
        values.push(tk.value);
        this.next();
        if (values.length > MAX_IN) throw new LogQueryError('Too many values in set');
        continue;
      }
      throw new LogQueryError('Invalid value in set membership');
    }
    return values;
  }

  private guard(depth: number) {
    if (depth > MAX_DEPTH) throw new LogQueryError('Query nesting too deep');
  }
}

// ----------------------------------------------------------------------------
// 3. Compiler → MongoDB filter
// ----------------------------------------------------------------------------
const TOP_STRING_FIELDS: Record<string, { path: string; lower?: boolean }> = {
  trace: { path: 'traceId' }, traceid: { path: 'traceId' },
  span: { path: 'spanId' }, spanid: { path: 'spanId' },
  source: { path: 'source', lower: true },
  host: { path: 'host' }, hostname: { path: 'host' },
  env: { path: 'environment' }, environment: { path: 'environment' },
  service: { path: 'serviceModel' }, servicemodel: { path: 'serviceModel' },
};

type Resolved =
  | { kind: 'severity' }
  | { kind: 'number'; path: string }
  | { kind: 'message' }
  | { kind: 'string'; path: string; lower?: boolean }
  | { kind: 'attr'; path: string };

function resolveField(field: string): Resolved {
  const f = field.toLowerCase();
  if (f === 'level' || f === 'severity' || f === 'severitytext') return { kind: 'severity' };
  if (f === 'severitynumber') return { kind: 'number', path: 'severityNumber' };
  if (f === 'message' || f === 'msg' || f === 'body') return { kind: 'message' };
  if (TOP_STRING_FIELDS[f]) return { kind: 'string', ...TOP_STRING_FIELDS[f] };
  return { kind: 'attr', path: `attributes.${field}` };
}

function castValue(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value !== '' && !isNaN(Number(value))) return Number(value);
  return value;
}

function wildcardRegex(value: string): { $regex: string; $options: string } {
  const stars = (value.match(/\*/g) || []).length;
  if (stars > MAX_STARS) throw new LogQueryError('Too many wildcards');
  const pattern = value.split('*').map(escapeRegex).join('.*');
  return { $regex: `^${pattern}$`, $options: 'i' };
}

function substringRegex(value: string): { $regex: string; $options: string } {
  return { $regex: escapeRegex(value), $options: 'i' };
}

const RANGE_OPS: Record<string, string> = { gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte' };

function severityToNumber(value: string): number {
  if (!isNaN(Number(value))) return Number(value);
  const t = normalizeSeverity({ level: value }).severityNumber;
  return t;
}

function compileCompare(node: { field: string; op: CompareOp; value: string; wildcard: boolean; quoted: boolean }): Record<string, any> {
  const resolved = resolveField(node.field);
  const { op, value, wildcard } = node;

  // Field-exists shorthand: field:*
  if (value === '*' && resolved.kind !== 'severity') {
    const path = resolved.kind === 'message' ? 'message' : (resolved as any).path;
    return { [path]: { $exists: true } };
  }

  switch (resolved.kind) {
    case 'severity': {
      if (op === 'eq') return { severityText: normalizeSeverity({ level: value }).severityText };
      if (op === 'ne') return { severityText: { $ne: normalizeSeverity({ level: value }).severityText } };
      return { severityNumber: { [RANGE_OPS[op]]: severityToNumber(value) } };
    }
    case 'number': {
      const num = Number(value);
      if (isNaN(num)) throw new LogQueryError(`Expected a number for ${node.field}`);
      if (op === 'eq') return { [resolved.path]: num };
      if (op === 'ne') return { [resolved.path]: { $ne: num } };
      return { [resolved.path]: { [RANGE_OPS[op]]: num } };
    }
    case 'message': {
      const rx = wildcard ? wildcardRegex(value) : substringRegex(value);
      if (op === 'ne') return { message: { $not: new RegExp(rx.$regex, rx.$options) } };
      return { message: rx };
    }
    case 'string': {
      const v = resolved.lower ? value.toLowerCase() : value;
      if (wildcard) return { [resolved.path]: wildcardRegex(value) };
      if (op === 'ne') return { [resolved.path]: { $ne: v } };
      if (op === 'eq') return { [resolved.path]: v };
      return { [resolved.path]: { [RANGE_OPS[op]]: v } };
    }
    case 'attr': {
      if (wildcard) return { [resolved.path]: wildcardRegex(value) };
      const cast = castValue(value);
      if (op === 'eq') return { [resolved.path]: cast };
      if (op === 'ne') return { [resolved.path]: { $ne: cast } };
      const num = Number(value);
      if (isNaN(num)) throw new LogQueryError(`Expected a number for ${node.field} comparison`);
      return { [resolved.path]: { [RANGE_OPS[op]]: num } };
    }
  }
}

function compileIn(node: { field: string; values: string[] }): Record<string, any> {
  const resolved = resolveField(node.field);
  if (resolved.kind === 'severity') {
    return { severityText: { $in: node.values.map((v) => normalizeSeverity({ level: v }).severityText) } };
  }
  if (resolved.kind === 'message') {
    return { $or: node.values.map((v) => ({ message: substringRegex(v) })) };
  }
  const path = (resolved as any).path;
  const lower = (resolved as any).lower;
  const values = resolved.kind === 'attr'
    ? node.values.map(castValue)
    : node.values.map((v) => (lower ? v.toLowerCase() : v));
  return { [path]: { $in: values } };
}

function compileNode(node: Node): Record<string, any> {
  switch (node.type) {
    case 'and': {
      const parts = node.children.map(compileNode);
      return parts.length === 1 ? parts[0] : { $and: parts };
    }
    case 'or': {
      const parts = node.children.map(compileNode);
      return parts.length === 1 ? parts[0] : { $or: parts };
    }
    case 'not':
      return { $nor: [compileNode(node.child)] };
    case 'compare':
      return compileCompare(node);
    case 'in':
      return compileIn(node);
    case 'text':
      return { message: substringRegex(node.value) };
  }
}

// Detects a pure conjunction of free-text words so we can use the (indexed)
// $text search instead of substring regex. Returns the words, or null.
function collectPureText(node: Node): string[] | null {
  if (node.type === 'text') return node.value ? [node.value] : [];
  if (node.type === 'and') {
    const acc: string[] = [];
    for (const c of node.children) {
      const w = collectPureText(c);
      if (w === null) return null;
      acc.push(...w);
    }
    return acc;
  }
  return null;
}

/**
 * Compiles a user search string into a MongoDB filter fragment (no ownerId/time).
 * Throws LogQueryError on malformed input.
 */
export function compileLogSearch(search: string): Record<string, any> {
  if (!search || !search.trim()) return {};
  if (search.length > MAX_INPUT) throw new LogQueryError('Query too long');

  const tokens = tokenize(search);
  if (tokens.length === 0) return {};

  const ast = new Parser(tokens).parse();
  if (!ast) return {};

  // Fast path: pure free-text → indexed $text search.
  const pureWords = collectPureText(ast);
  if (pureWords && pureWords.length > 0) {
    return { $text: { $search: pureWords.map((w) => `"${w.replace(/"/g, '')}"`).join(' ') } };
  }

  return compileNode(ast);
}

export { SEVERITY_ORDER, severityTextFromNumber };
export type { SeverityText };
