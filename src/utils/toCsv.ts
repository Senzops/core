// ============================================================================
// toCsv — minimal, safe CSV serializer for tabular API responses.
// ----------------------------------------------------------------------------
// RFC-4180 quoting: fields containing a comma, quote, or newline are wrapped in
// double quotes with embedded quotes doubled. A leading `'` is prepended to
// values that begin with =, +, -, or @ to neutralise spreadsheet formula
// injection when the CSV is opened in Excel/Sheets.
// ============================================================================

const escapeCell = (value: any): string => {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : String(value);

  // CSV formula-injection guard.
  if (/^[=+\-@]/.test(s)) s = `'${s}`;

  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
};

/**
 * Serializes rows to CSV using the given ordered columns.
 * @param rows    array of plain objects
 * @param columns ordered list of keys (also used as the header row)
 */
export const toCsv = (rows: Record<string, any>[], columns: string[]): string => {
  const header = columns.map(escapeCell).join(',');
  const lines = rows.map((row) => columns.map((c) => escapeCell(row[c])).join(','));
  return [header, ...lines].join('\r\n');
};
