import type { SqlValue } from '../types.js';
import type { TruncationReason } from '../dialects/types.js';
import { buildQueryMeta, rowToObject, uniqueColumnKeys, versioned, type QueryMeta } from './contract.js';

export interface TableMeta {
  rowCount: number;
  ms: number;
  truncated: boolean;
}

/** Human-readable aligned table. NULL is explicit and the footer reports result metadata. */
export function formatTable(columns: string[], rows: SqlValue[][], meta?: TableMeta): string {
  const cells = rows.map((row) => row.map(tableCell));
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...cells.map((row) => (row[index] ?? '').length), 0),
  );
  const formatRow = (values: string[]) =>
    values.map((value, index) => value.padEnd(widths[index])).join('  ').replace(/\s+$/, '');
  const lines = [formatRow(columns), formatRow(widths.map((width) => '-'.repeat(width)))];
  for (const row of cells) lines.push(formatRow(row));
  if (meta) {
    lines.push('');
    const noun = meta.rowCount === 1 ? 'row' : 'rows';
    lines.push(`-- ${meta.rowCount} ${noun}, ${meta.ms}ms${meta.truncated ? ' (truncated)' : ''}`);
  }
  return lines.join('\n');
}

function tableCell(value: SqlValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export interface InlineJson {
  contractVersion: string;
  ds: string;
  columns: string[];
  rows: SqlValue[][];
  meta: QueryMeta;
}

export function buildInlineJson(
  ds: string,
  columns: string[],
  rows: SqlValue[][],
  ms: number,
  queryTruncated: boolean,
  budget: { truncationReason?: TruncationReason; resultBytes?: number; rowCount?: number } = {},
): InlineJson {
  const rowCount = budget.rowCount ?? rows.length;
  return versioned({
    ds,
    columns,
    rows,
    meta: buildQueryMeta({
      rowCount,
      deliveredRowCount: rows.length,
      ms,
      queryTruncated,
      mode: 'inline',
      truncationReason: budget.truncationReason,
      resultBytes: budget.resultBytes,
    }),
  });
}

export interface SpillJson {
  contractVersion: string;
  ds: string;
  columns: string[];
  preview: SqlValue[][];
  meta: QueryMeta;
}

const PREVIEW_ROWS = 50;

export function buildSpillJson(
  ds: string,
  columns: string[],
  rows: SqlValue[][],
  meta: {
    ms: number;
    truncated: boolean;
    spillPath: string;
    bytes: number;
    truncationReason?: TruncationReason;
    resultBytes?: number;
    rowCount?: number;
  },
): SpillJson {
  const preview = rows.slice(0, PREVIEW_ROWS);
  return versioned({
    ds,
    columns,
    preview,
    meta: buildQueryMeta({
      rowCount: meta.rowCount ?? rows.length,
      deliveredRowCount: preview.length,
      ms: meta.ms,
      queryTruncated: meta.truncated,
      mode: 'preview',
      spillPath: meta.spillPath,
      bytes: meta.bytes,
      truncationReason: meta.truncationReason,
      resultBytes: meta.resultBytes,
    }),
  });
}

/** RFC-4180 CSV. NULL and empty string are intentionally both empty fields. */
export function formatCsv(columns: string[], rows: SqlValue[][]): string {
  const lines = [serializeCsvRow(columns)];
  for (const row of rows) lines.push(serializeCsvRow(row));
  return lines.join('\r\n');
}

export function serializeCsvRow(values: readonly (SqlValue | string)[]): string {
  return values.map(csvCell).join(',');
}

/** Map positional rows to collision-safe object keys while retaining original labels separately. */
export function rowsToObjects(columns: string[], rows: SqlValue[][]): Record<string, SqlValue>[] {
  const keys = uniqueColumnKeys(columns);
  return rows.map((row) => rowToObject(keys, row));
}

function csvCell(value: SqlValue | string): string {
  if (value === null) return '';
  if (typeof value === 'string') return csvField(value);
  if (typeof value === 'object') return csvField(JSON.stringify(value));
  return csvField(String(value));
}

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return '"' + value.replace(/"/g, '""') + '"';
  return value;
}
