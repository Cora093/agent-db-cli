import type { SqlValue } from '../types.js';

export interface TableMeta {
  rowCount: number;
  ms: number;
  truncated: boolean;
}

/**
 * 给人看的对齐表(§9)。NULL 显式打印为 'NULL';尾部 '-- N rows, Mms' 脚注。
 * 简单按字符长度对齐(CJK 全角可能略有偏差;表对 Agent 是纯损耗,人偶尔取用)。
 */
export function formatTable(columns: string[], rows: SqlValue[][], meta?: TableMeta): string {
  const cells = rows.map((r) => r.map(tableCell));
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...cells.map((row) => (row[i] ?? '').length), 0),
  );

  const fmtRow = (vals: string[]) =>
    vals.map((v, i) => v.padEnd(widths[i])).join('  ').replace(/\s+$/, '');

  const lines: string[] = [];
  lines.push(fmtRow(columns));
  lines.push(fmtRow(widths.map((w) => '-'.repeat(w))));
  for (const row of cells) lines.push(fmtRow(row));

  if (meta) {
    lines.push('');
    const noun = meta.rowCount === 1 ? 'row' : 'rows';
    lines.push(`-- ${meta.rowCount} ${noun}, ${meta.ms}ms${meta.truncated ? ' (truncated)' : ''}`);
  }
  return lines.join('\n');
}

function tableCell(v: SqlValue): string {
  if (v === null) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v); // JSON/数组列:表格里降级为 JSON 文本
  return String(v);
}

export interface InlineJson {
  ds: string;
  columns: string[];
  rows: SqlValue[][];
  meta: { rowCount: number; ms: number; truncated: boolean; spillPath: null };
}

/** 内联成功输出对象(§9a)。结果小于阈值时使用。 */
export function buildInlineJson(
  ds: string,
  columns: string[],
  rows: SqlValue[][],
  ms: number,
  truncated: boolean,
): InlineJson {
  return {
    ds,
    columns,
    rows,
    meta: { rowCount: rows.length, ms, truncated, spillPath: null },
  };
}

export interface SpillJson {
  ds: string;
  columns: string[];
  preview: SqlValue[][];
  meta: {
    rowCount: number;
    ms: number;
    truncated: boolean;
    spillPath: string;
    bytes: number;
  };
}

const PREVIEW_ROWS = 50;

/** 落盘成功输出对象(§9b)。preview 取前 50 行,全量在 spillPath 文件。 */
export function buildSpillJson(
  ds: string,
  columns: string[],
  rows: SqlValue[][],
  meta: { ms: number; truncated: boolean; spillPath: string; bytes: number },
): SpillJson {
  return {
    ds,
    columns,
    preview: rows.slice(0, PREVIEW_ROWS),
    meta: {
      rowCount: rows.length,
      ms: meta.ms,
      truncated: meta.truncated,
      spillPath: meta.spillPath,
      bytes: meta.bytes,
    },
  };
}

/** RFC-4180 CSV(§9)。NULL 与空串都成空字段(已知歧义,故 CSV 仅显式取用)。 */
export function formatCsv(columns: string[], rows: SqlValue[][]): string {
  const lines: string[] = [columns.map(csvField).join(',')];
  for (const row of rows) {
    lines.push(row.map(csvCell).join(','));
  }
  return lines.join('\r\n');
}

/** 行数组按列名映射成对象(重复列名后者覆盖,极罕见)。 */
export function rowsToObjects(columns: string[], rows: SqlValue[][]): Record<string, SqlValue>[] {
  return rows.map((row) => {
    const obj: Record<string, SqlValue> = {};
    for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i] ?? null;
    return obj;
  });
}

/**
 * NDJSON(§9):一行一个 row 对象,行末换行。
 * null 自描述、类型/精度保真、行对行便于 Read(offset/limit)/Grep 切片。
 */
export function toNdjson(columns: string[], rows: SqlValue[][]): string {
  let out = '';
  for (const obj of rowsToObjects(columns, rows)) {
    out += JSON.stringify(obj) + '\n';
  }
  return out;
}

function csvCell(v: SqlValue): string {
  if (v === null) return '';
  if (typeof v === 'string') return csvField(v);
  if (typeof v === 'object') return csvField(JSON.stringify(v)); // JSON/数组列:CSV 里降级为 JSON 文本
  return csvField(String(v));
}

function csvField(s: string): string {
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
