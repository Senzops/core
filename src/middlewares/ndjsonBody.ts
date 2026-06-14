import express, { Request, Response, NextFunction } from 'express';

// ============================================================================
// NDJSON Body Support (for log ingestion)
// ----------------------------------------------------------------------------
// Log forwarders (Vector, Fluent Bit, Filebeat, ...) commonly stream newline-
// delimited JSON. The global express.json() parser ignores these content types
// and leaves req.body empty, so we add a dedicated text parser + line splitter
// scoped to the log ingestion route.
//
// gzip/deflate request bodies are handled transparently by body-parser's built-in
// inflate (enabled by default), so compressed JSON and compressed NDJSON both
// work without extra code.
// ============================================================================

const NDJSON_TYPES = ['application/x-ndjson', 'application/ndjson', 'application/jsonlines'];
const MAX_NDJSON_LINES = 5000;

// Reads NDJSON bodies as text. For application/json requests this is a no-op
// (type mismatch → body-parser skips, leaving the already-parsed JSON intact).
const ndjsonText = express.text({ type: NDJSON_TYPES, limit: '4mb' });

// Converts a parsed NDJSON string body into an array of objects, mirroring the
// shape the ingestion controller already expects (Array<payload>).
const ndjsonToArray = (req: Request, _res: Response, next: NextFunction) => {
  if (typeof req.body === 'string' && req.body.length > 0) {
    const out: any[] = [];
    const lines = req.body.split('\n');
    for (let i = 0; i < lines.length && out.length < MAX_NDJSON_LINES; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // Skip malformed lines rather than rejecting the whole batch.
      }
    }
    req.body = out;
  }
  next();
};

/** Middleware chain enabling NDJSON ingestion on a route. */
export const ndjsonBody = [ndjsonText, ndjsonToArray];
