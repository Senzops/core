// ============================================================================
// Stack-trace symbolication
// ----------------------------------------------------------------------------
// De-minifies a RUM error stack trace using uploaded source maps. Frames are
// parsed from the raw stack text (Chrome & Firefox/Safari formats), grouped by
// the minified file's basename, and resolved to original source positions via
// the `source-map` library. Each source map is loaded and parsed once per call
// and reused across all frames that reference it.
//
// Fail-soft by design: any frame that can't be parsed or has no matching map is
// returned unchanged with `resolved: false`, so a partial map set still helps.
// ============================================================================

import zlib from 'zlib';
import { SourceMapConsumer } from 'source-map';
import { SourceMap } from '../models/SourceMap';
import { logger } from '../utils/logger';

export interface SymbolicatedFrame {
  raw: string;
  function?: string;
  file?: string;        // minified file basename
  line?: number;
  column?: number;
  resolved: boolean;
  source?: string;      // original source path
  origLine?: number;
  origColumn?: number;
  origName?: string;
}

// Chrome:  "    at fn (https://host/assets/main.abc.js:10:2345)"  /  "    at https://host/main.js:10:5"
const CHROME_RE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;
// Firefox/Safari:  "fn@https://host/main.js:10:5"
const FIREFOX_RE = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/;

const basenameOf = (url: string): string => {
  try {
    const noQuery = url.split('?')[0].split('#')[0];
    const parts = noQuery.split('/');
    return parts[parts.length - 1] || noQuery;
  } catch {
    return url;
  }
};

interface ParsedFrame { fn?: string; url: string; line: number; column: number; raw: string; }

const parseFrame = (line: string): ParsedFrame | null => {
  let m = CHROME_RE.exec(line);
  if (m) return { fn: m[1]?.trim() || undefined, url: m[2], line: parseInt(m[3], 10), column: parseInt(m[4], 10), raw: line };
  m = FIREFOX_RE.exec(line);
  if (m && m[2]) return { fn: m[1]?.trim() || undefined, url: m[2], line: parseInt(m[3], 10), column: parseInt(m[4], 10), raw: line };
  return null;
};

/**
 * Symbolicates a raw stack trace for a RUM service.
 * @returns ordered frames; lines that aren't stack frames are skipped.
 */
export async function symbolicateStack(
  serviceId: string,
  stackTrace: string,
  release?: string
): Promise<{ frames: SymbolicatedFrame[]; resolvedCount: number }> {
  if (!stackTrace || typeof stackTrace !== 'string') return { frames: [], resolvedCount: 0 };

  const lines = stackTrace.split('\n');
  const parsed: Array<{ frame: ParsedFrame; idx: number }> = [];
  const neededFiles = new Set<string>();

  lines.forEach((line) => {
    const frame = parseFrame(line);
    if (frame) {
      parsed.push({ frame, idx: parsed.length });
      neededFiles.add(basenameOf(frame.url));
    }
  });

  // Load + parse each referenced source map once. Prefer the exact release;
  // otherwise the most recently uploaded map for that basename.
  const consumers = new Map<string, SourceMapConsumer | null>();
  await Promise.all(
    Array.from(neededFiles).map(async (fileName) => {
      try {
        const query: any = { serviceId, fileName };
        let doc = release
          ? await SourceMap.findOne({ ...query, release }).select('+mapGz').lean()
          : null;
        if (!doc) doc = await SourceMap.findOne(query).select('+mapGz').sort({ createdAt: -1 }).lean();
        if (!doc?.mapGz) { consumers.set(fileName, null); return; }

        const json = JSON.parse(zlib.gunzipSync(doc.mapGz as Buffer).toString('utf8'));
        consumers.set(fileName, new SourceMapConsumer(json));
      } catch (e: any) {
        logger.warn(`[Symbolicate] Failed to load map for ${fileName}: ${e?.message}`);
        consumers.set(fileName, null);
      }
    })
  );

  let resolvedCount = 0;
  const frames: SymbolicatedFrame[] = parsed.map(({ frame }) => {
    const fileName = basenameOf(frame.url);
    const consumer = consumers.get(fileName) || null;
    const base: SymbolicatedFrame = {
      raw: frame.raw.trim(),
      function: frame.fn,
      file: fileName,
      line: frame.line,
      column: frame.column,
      resolved: false,
    };

    if (consumer) {
      try {
        // source-map columns are 0-based; stack-trace columns are 1-based.
        const pos = consumer.originalPositionFor({ line: frame.line, column: Math.max(0, frame.column - 1) });
        if (pos && pos.source && pos.line != null) {
          resolvedCount++;
          return {
            ...base,
            resolved: true,
            source: pos.source,
            origLine: pos.line,
            origColumn: pos.column ?? undefined,
            origName: pos.name ?? frame.fn,
          };
        }
      } catch {
        /* fall through to unresolved */
      }
    }
    return base;
  });

  return { frames, resolvedCount };
}
