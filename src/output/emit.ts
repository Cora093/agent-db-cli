import path from 'node:path';
import type { OutputFormat } from '../types.js';
import type { QueryResult } from '../dialects/types.js';
import {
  buildInlineJson,
  buildSpillJson,
  formatCsv,
  formatTable,
  toNdjson,
} from './format.js';
import { withinInlineLimits, INLINE_MAX_ROWS } from './spill.js';
import type { AppError } from '../errors.js';

/**
 * 渲染错误(§9c)。错误只走 stderr。
 *   - json / csv → JSON error 对象 { error: { category, message, hint? } }
 *   - table      → 文本行 ERROR [类别] message
 */
export function renderError(err: AppError, format: OutputFormat): string {
  if (format === 'table') {
    return `ERROR [${err.category}] ${err.message}`;
  }
  return JSON.stringify({ error: err.toJSON() });
}

export interface EmitInput {
  ds: string;
  result: QueryResult;
  format: OutputFormat;
  noSpill: boolean;
  outPath?: string;
}

export interface EmitDeps {
  /** 写 NDJSON 到落盘目录,返回完整路径 */
  writeSpill: (ds: string, ndjson: string) => string;
  /** 写用户指定 --out 文件,返回字节数 */
  writeOut: (filePath: string, content: string) => { bytes: number };
  /** 非致命提示(只走 stderr,不污染数据通道);缺省静默 */
  warn?: (msg: string) => void;
}

const OUT_EXT_FORMATS: Record<string, 'csv' | 'ndjson' | 'json'> = {
  '.csv': 'csv',
  '.ndjson': 'ndjson',
  '.json': 'json',
};

/** --out 文件格式:扩展名优先,认不出回退 --format(§9b)。 */
export function inferOutFormat(
  filePath: string,
  fallback: OutputFormat,
): 'csv' | 'ndjson' | 'json' | 'table' {
  return OUT_EXT_FORMATS[path.extname(filePath).toLowerCase()] ?? fallback;
}

/**
 * 编排成功输出(§9):
 *   - --out:按扩展名/--format 写文件(持久、不 GC),stdout 给摘要。
 *   - --format table/csv:显式人用/Excel,直出全部行(已被 500 硬顶约束)。
 *   - --format json(默认 agent-first):小则内联;大则落盘 NDJSON + preview;
 *     --no-spill 则内联截断到内联阈值。
 *
 * 返回应写到 stdout 的文本。IO 经 deps 注入,便于测试。
 */
export function emitResult(input: EmitInput, deps: EmitDeps): string {
  const { ds, result, format, noSpill, outPath } = input;
  const { columns, rows, truncated, ms } = result;

  // —— --out:写文件 + 摘要 ——
  if (outPath) {
    const ext = path.extname(outPath).toLowerCase();
    const outFmt = inferOutFormat(outPath, format);
    if (!(ext in OUT_EXT_FORMATS)) {
      // M2:.xlsx 之类认不出的扩展名不再静默回退,stderr 提示真实写入格式
      deps.warn?.(`未知扩展名 ${ext || '(无)'},按 --format ${outFmt} 写入: ${outPath}`);
    }
    const content = serializeForFile(outFmt, ds, columns, rows, { rowCount: rows.length, ms, truncated });
    const { bytes } = deps.writeOut(outPath, content);
    return JSON.stringify({
      ds,
      columns,
      meta: { rowCount: rows.length, ms, truncated, outPath, bytes },
    });
  }

  // —— 显式 table / csv:直出(500 硬顶已约束行数) ——
  if (format === 'table') {
    return formatTable(columns, rows, { rowCount: rows.length, ms, truncated });
  }
  if (format === 'csv') {
    return formatCsv(columns, rows);
  }

  // —— 默认 json ——
  const jsonBytes = Buffer.byteLength(JSON.stringify(rows), 'utf8');

  if (noSpill) {
    // 绝不写文件:内联并截断到内联阈值
    const capped = rows.slice(0, INLINE_MAX_ROWS);
    const wasTruncated = truncated || capped.length < rows.length;
    return JSON.stringify(buildInlineJson(ds, columns, capped, ms, wasTruncated));
  }

  if (withinInlineLimits(rows.length, jsonBytes)) {
    return JSON.stringify(buildInlineJson(ds, columns, rows, ms, truncated));
  }

  // 落盘 NDJSON + preview
  const ndjson = toNdjson(columns, rows);
  const spillPath = deps.writeSpill(ds, ndjson);
  const bytes = Buffer.byteLength(ndjson, 'utf8');
  return JSON.stringify(buildSpillJson(ds, columns, rows, { ms, truncated, spillPath, bytes }));
}

function serializeForFile(
  fmt: 'csv' | 'ndjson' | 'json' | 'table',
  ds: string,
  columns: string[],
  rows: QueryResult['rows'],
  meta: { rowCount: number; ms: number; truncated: boolean },
): string {
  switch (fmt) {
    case 'csv':
      return formatCsv(columns, rows);
    case 'ndjson':
      return toNdjson(columns, rows);
    case 'table':
      // M2:透传真实 meta,截断的导出在页脚如实标 (truncated),不再谎报完整
      return formatTable(columns, rows, meta);
    case 'json':
      return JSON.stringify(
        { ds, columns, rows, meta: { rowCount: meta.rowCount, truncated: meta.truncated } },
        null,
        2,
      );
  }
}
