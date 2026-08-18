import path from 'node:path';
import type { OutputFormat } from '../types.js';
import type { QueryResult } from '../dialects/types.js';
import { buildInlineJson, buildSpillJson, formatCsv, formatTable } from './format.js';
import { withinInlineLimits, INLINE_MAX_ROWS } from './spill.js';
import type { AppError } from '../errors.js';
import { buildNdjson, buildQueryMeta, versioned } from './contract.js';

export function renderError(err: AppError, format: OutputFormat): string {
  if (format === 'table') return `ERROR [${err.category}] ${err.message}`;
  return JSON.stringify(versioned({ error: err.toJSON() }));
}

export interface EmitInput {
  ds: string;
  result: QueryResult;
  format: OutputFormat;
  noSpill: boolean;
  outPath?: string;
}

export interface EmitDeps {
  writeSpill: (ds: string, ndjson: string) => string;
  writeOut: (filePath: string, content: string) => { bytes: number };
  warn?: (msg: string) => void;
}

const OUT_EXT_FORMATS: Record<string, 'csv' | 'ndjson' | 'json'> = {
  '.csv': 'csv',
  '.ndjson': 'ndjson',
  '.json': 'json',
};

export function inferOutFormat(
  filePath: string,
  fallback: OutputFormat,
): 'csv' | 'ndjson' | 'json' | 'table' {
  return OUT_EXT_FORMATS[path.extname(filePath).toLowerCase()] ?? fallback;
}

export function emitResult(input: EmitInput, deps: EmitDeps): string {
  const { ds, result, format, noSpill, outPath } = input;
  const { columns, rows, truncated: queryTruncated, ms } = result;

  if (outPath) {
    const ext = path.extname(outPath).toLowerCase();
    const outFmt = inferOutFormat(outPath, format);
    if (!(ext in OUT_EXT_FORMATS)) {
      deps.warn?.(`未知扩展名 ${ext || '(无)'},按 --format ${outFmt} 写入: ${outPath}`);
    }
    const persistedMeta = buildQueryMeta({
      rowCount: rows.length,
      deliveredRowCount: rows.length,
      ms,
      queryTruncated,
      mode: 'out',
      outPath,
    });
    const content = serializeForFile(outFmt, ds, columns, rows, persistedMeta);
    const { bytes } = deps.writeOut(outPath, content);
    return JSON.stringify(versioned({
      ds,
      columns,
      meta: buildQueryMeta({
        rowCount: rows.length,
        deliveredRowCount: rows.length,
        ms,
        queryTruncated,
        mode: 'out',
        outPath,
        bytes,
      }),
    }));
  }

  if (format === 'table') {
    return formatTable(columns, rows, { rowCount: rows.length, ms, truncated: queryTruncated });
  }
  if (format === 'csv') return formatCsv(columns, rows);
  if (format === 'ndjson') {
    return buildNdjson({
      command: 'query',
      ds,
      columns,
      meta: buildQueryMeta({
        rowCount: rows.length,
        deliveredRowCount: rows.length,
        ms,
        queryTruncated,
        mode: 'stdout',
      }),
    }, rows).trimEnd();
  }

  const jsonBytes = Buffer.byteLength(JSON.stringify(rows), 'utf8');
  if (noSpill) {
    const delivered = rows.slice(0, INLINE_MAX_ROWS);
    return JSON.stringify(versioned({
      ds,
      columns,
      rows: delivered,
      meta: buildQueryMeta({
        rowCount: rows.length,
        deliveredRowCount: delivered.length,
        ms,
        queryTruncated,
        mode: 'inline',
      }),
    }));
  }

  if (withinInlineLimits(rows.length, jsonBytes)) {
    return JSON.stringify(buildInlineJson(ds, columns, rows, ms, queryTruncated));
  }

  const spillMetaWithoutPath = buildQueryMeta({
    rowCount: rows.length,
    deliveredRowCount: rows.length,
    ms,
    queryTruncated,
    mode: 'out',
  });
  const ndjson = buildNdjson({ command: 'query', ds, columns, meta: spillMetaWithoutPath }, rows);
  const spillPath = deps.writeSpill(ds, ndjson);
  const bytes = Buffer.byteLength(ndjson, 'utf8');
  return JSON.stringify(buildSpillJson(ds, columns, rows, { ms, truncated: queryTruncated, spillPath, bytes }));
}

function serializeForFile(
  fmt: 'csv' | 'ndjson' | 'json' | 'table',
  ds: string,
  columns: string[],
  rows: QueryResult['rows'],
  meta: ReturnType<typeof buildQueryMeta>,
): string {
  switch (fmt) {
    case 'csv':
      return formatCsv(columns, rows);
    case 'ndjson':
      return buildNdjson({ command: 'query', ds, columns, meta }, rows);
    case 'table':
      return formatTable(columns, rows, {
        rowCount: meta.rowCount,
        ms: meta.ms,
        truncated: meta.queryTruncated,
      });
    case 'json':
      return JSON.stringify(versioned({ ds, columns, rows, meta }), null, 2);
  }
}
