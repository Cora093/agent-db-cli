import type { QueryResult } from '../dialects/types.js';
import type { AppError } from '../errors.js';
import type { OutPlan, OutputFormat } from './plan.js';
import { buildInlineJson, buildSpillJson, formatCsv, formatTable } from './format.js';
import { withinInlineLimits } from './spill.js';
import { buildNdjson, buildQueryMeta, versioned } from './contract.js';

export function renderError(err: AppError, format: OutputFormat): string {
  if (format === 'table') return `ERROR [${err.category}] ${err.message}`;
  return JSON.stringify(versioned({ error: err.toJSON() }));
}

export interface EmitInput {
  ds: string;
  result: QueryResult;
  format: OutputFormat;
  outPlan?: OutPlan;
  streamFile?: { path: string; bytes: number };
}

export interface EmitDeps {
  writeOut?: (filePath: string, content: string) => { bytes: number };
  warn?: (msg: string) => void;
}

export function emitResult(input: EmitInput, deps: EmitDeps = {}): string {
  const { ds, result, format, outPlan, streamFile } = input;
  const { columns, rows, truncated: queryTruncated, truncationReason, resultBytes, ms } = result;
  const rowCount = result.rowCount ?? rows.length;

  if (outPlan) {
    if (!outPlan.recognizedExtension) {
      deps.warn?.(`未知扩展名 ${outPlan.extension || '(无)'},按 --format ${outPlan.format} 写入: ${outPlan.path}`);
    }
    const persistedMeta = buildQueryMeta({
      rowCount,
      deliveredRowCount: rowCount,
      ms,
      queryTruncated,
      mode: 'out',
      outPath: outPlan.path,
      truncationReason,
      resultBytes,
    });
    const bytes = streamFile?.bytes ?? (() => {
      if (!deps.writeOut) throw new Error('writeOut dependency is required for buffered output');
      return deps.writeOut(
        outPlan.path,
        serializeForFile(outPlan.format, ds, columns, rows, persistedMeta),
      ).bytes;
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
        outPath: outPlan.path,
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

  const jsonBytes = resultBytes ?? Buffer.byteLength(JSON.stringify(rows), 'utf8');
  if (!withinInlineLimits(rowCount, jsonBytes)) {
    throw new Error('large JSON result requires a streamed spill artifact');
  }
  return JSON.stringify(buildInlineJson(ds, columns, rows, ms, queryTruncated, {
    truncationReason,
    resultBytes,
    rowCount,
  }));
}

function serializeForFile(
  format: OutputFormat,
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
