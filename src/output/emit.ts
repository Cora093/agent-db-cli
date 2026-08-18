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
  streamFile?: { path: string; bytes: number };
}

export interface EmitDeps {
  writeSpill?: (ds: string, ndjson: string) => string;
  writeOut?: (filePath: string, content: string) => { bytes: number };
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
  const { ds, result, format, noSpill, outPath, streamFile } = input;
  const { columns, rows, truncated: queryTruncated, truncationReason, resultBytes, ms } = result;
  const rowCount = result.rowCount ?? rows.length;

  if (outPath) {
    const ext = path.extname(outPath).toLowerCase();
    const outFormat = inferOutFormat(outPath, format);
    if (!(ext in OUT_EXT_FORMATS)) {
      deps.warn?.(`未知扩展名 ${ext || '(无)'},按 --format ${outFormat} 写入: ${outPath}`);
    }
    const persistedMeta = buildQueryMeta({
      rowCount,
      deliveredRowCount: rowCount,
      ms,
      queryTruncated,
      mode: 'out',
      outPath,
      truncationReason,
      resultBytes,
    });
    const bytes = streamFile?.bytes ?? (() => {
      if (!deps.writeOut) throw new Error('writeOut dependency is required for non-streamed output');
      return deps.writeOut(outPath, serializeForFile(outFormat, ds, columns, rows, persistedMeta)).bytes;
    })();
    return JSON.stringify(versioned({
      ds,
      columns,
      meta: buildQueryMeta({
        rowCount,
        deliveredRowCount: rowCount,
        ms,
        queryTruncated,
        mode: 'out',
        outPath,
        bytes,
        truncationReason,
        resultBytes,
      }),
    }));
  }

  if (format === 'table') {
    return formatTable(columns, rows, { rowCount, ms, truncated: queryTruncated });
  }
  if (format === 'csv') return formatCsv(columns, rows);
  if (format === 'ndjson') {
    return buildNdjson({
      command: 'query',
      ds,
      columns,
      meta: buildQueryMeta({
        rowCount,
        deliveredRowCount: rows.length,
        ms,
        queryTruncated,
        mode: 'stdout',
        truncationReason,
        resultBytes,
      }),
    }, rows).trimEnd();
  }

  if (streamFile) {
    return JSON.stringify(buildSpillJson(ds, columns, rows, {
      ms,
      truncated: queryTruncated,
      spillPath: streamFile.path,
      bytes: streamFile.bytes,
      truncationReason,
      resultBytes,
      rowCount,
    }));
  }

  if (noSpill) {
    const delivered = rows.slice(0, INLINE_MAX_ROWS);
    return JSON.stringify(buildInlineJson(ds, columns, delivered, ms, queryTruncated, {
      truncationReason,
      resultBytes,
      rowCount,
    }));
  }

  const jsonBytes = resultBytes ?? Buffer.byteLength(JSON.stringify(rows), 'utf8');
  if (withinInlineLimits(rowCount, jsonBytes)) {
    return JSON.stringify(buildInlineJson(ds, columns, rows, ms, queryTruncated, {
      truncationReason,
      resultBytes,
      rowCount,
    }));
  }

  const ndjsonMeta = buildQueryMeta({
    rowCount,
    deliveredRowCount: rowCount,
    ms,
    queryTruncated,
    mode: 'out',
    truncationReason,
    resultBytes,
  });
  const ndjson = buildNdjson({ command: 'query', ds, columns, meta: ndjsonMeta }, rows);
  if (!deps.writeSpill) throw new Error('writeSpill dependency is required for non-streamed output');
  const spillPath = deps.writeSpill(ds, ndjson);
  const bytes = Buffer.byteLength(ndjson, 'utf8');
  return JSON.stringify(buildSpillJson(ds, columns, rows, {
    ms,
    truncated: queryTruncated,
    spillPath,
    bytes,
    truncationReason,
    resultBytes,
    rowCount,
  }));
}

function serializeForFile(
  format: 'csv' | 'ndjson' | 'json' | 'table',
  ds: string,
  columns: string[],
  rows: QueryResult['rows'],
  meta: ReturnType<typeof buildQueryMeta>,
): string {
  switch (format) {
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
