import type { DatasourceConfig, Datasources } from '../config/types.js';
import type { SqlValue } from '../types.js';
import type { OutputFormat } from '../output/plan.js';
import { AppError } from '../errors.js';
import { formatCsv, formatTable } from '../output/format.js';
import { buildNdjson, versioned } from '../output/contract.js';

/** list/tables/schema 的统一视图:json 用结构对象,table/csv 用列+行。 */
export interface ViewSection {
  name: string;
  columns: string[];
  rows: SqlValue[][];
}

export interface View {
  command?: string;
  ds?: string;
  json: unknown;
  columns: string[];
  rows: SqlValue[][];
  sections?: ViewSection[];
}

export function renderView(view: View, format: OutputFormat): string {
  if (format === 'json') return JSON.stringify(versioned(view.json as object));
  const flat = flattenSections(view);
  if (format === 'ndjson') {
    return buildNdjson({
      command: view.command ?? 'view',
      ...(view.ds === undefined ? {} : { ds: view.ds }),
      columns: flat.columns,
      meta: { rowCount: flat.rows.length, deliveredRowCount: flat.rows.length },
    }, flat.rows).trimEnd();
  }
  if (format === 'csv') return formatCsv(flat.columns, flat.rows);
  const sections = view.sections ?? [{ name: '', columns: view.columns, rows: view.rows }];
  return sections
    .map((section) => {
      const body = formatTable(section.columns, section.rows);
      return section.name ? `[${section.name}]\n${body}` : body;
    })
    .join('\n\n');
}

function flattenSections(view: View): { columns: string[]; rows: SqlValue[][] } {
  if (!view.sections) return { columns: view.columns, rows: view.rows };
  const width = Math.max(0, ...view.sections.map((section) => section.columns.length));
  const columns = ['section', ...Array.from({ length: width }, (_, i) => `field${i + 1}`)];
  const rows = view.sections.flatMap((section) => [
    [section.name, ...section.columns, ...Array(width - section.columns.length).fill(null)],
    ...section.rows.map((row) => [section.name, ...row, ...Array(width - row.length).fill(null)]),
  ]);
  return { columns, rows };
}

/** 选数据源(§8):未命中报错并列出所有合法 id,便于 Agent 自纠。 */
export function pickDatasource(datasources: Datasources, id: string): DatasourceConfig {
  const ds = datasources[id];
  if (!ds) {
    const ids = Object.keys(datasources);
    throw new AppError('DATASOURCE_NOT_FOUND', `未知 --ds '${id}'`, {
      hint: `可用: ${ids.join(', ')}`,
    });
  }
  return ds;
}

/** 解析表参数(§8):schema.table 点号糖优先,否则用 --schema。 */
export function parseTableArg(
  table: string,
  schemaFlag?: string,
): { schema?: string; table: string } {
  const dot = table.indexOf('.');
  if (dot > 0) {
    return { schema: table.slice(0, dot), table: table.slice(dot + 1) };
  }
  return { schema: schemaFlag, table };
}

export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 500;
export const DEFAULT_TIMEOUT_S = 30;
export const MAX_TIMEOUT_S = 300;

/** 解析并夹紧 limit / timeout(§7/§8)。返回毫秒超时 + 需提示用户的 notes。 */
export function resolveQueryLimits(
  opts: { limit?: number; timeout?: number },
  dsTimeoutS: number | undefined,
): { limit: number; timeoutMs: number; notes: string[] } {
  const notes: string[] = [];

  let limit = opts.limit ?? DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) {
    notes.push(`--limit ${limit} 超过硬顶,已夹到 ${MAX_LIMIT}`);
    limit = MAX_LIMIT;
  }
  if (limit < 1) limit = 1;

  let timeoutS = opts.timeout ?? dsTimeoutS ?? DEFAULT_TIMEOUT_S;
  if (timeoutS > MAX_TIMEOUT_S) {
    notes.push(`--timeout ${timeoutS}s 超过硬顶,已夹到 ${MAX_TIMEOUT_S}s`);
    timeoutS = MAX_TIMEOUT_S;
  }
  if (timeoutS < 1) timeoutS = 1;

  return { limit, timeoutMs: timeoutS * 1000, notes };
}

export interface SqlInputDeps {
  readFile: (path: string) => string;
  readStdin: () => string;
}

/** 解析 SQL 输入(§8 三通道):位置参数 / -f 文件 / -f - stdin。多源或无源报错。 */
export function resolveSqlInput(
  positional: string | undefined,
  file: string | undefined,
  deps: SqlInputDeps,
): string {
  const count = (positional !== undefined ? 1 : 0) + (file !== undefined ? 1 : 0);
  if (count === 0) {
    throw new AppError('BAD_USAGE', '未提供 SQL', {
      hint: '位置参数 "SELECT ..." 或 -f file.sql(或 -f - 读 stdin)',
    });
  }
  if (count > 1) {
    throw new AppError('BAD_USAGE', '同时给了多个 SQL 输入源', {
      hint: '只用位置参数或 -f 之一',
    });
  }
  if (positional !== undefined) return positional;
  if (file === '-') return deps.readStdin();
  return deps.readFile(file as string);
}
