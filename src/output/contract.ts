import type { SqlValue } from '../types.js';

/** Public JSON/NDJSON contract version. Additive fields keep the same major version. */
export const OUTPUT_CONTRACT_VERSION = '1.0';

export type DeliveryMode = 'inline' | 'preview' | 'stdout' | 'out';

export interface QueryMeta {
  /** Rows returned by the database after the query limit. */
  rowCount: number;
  /** Rows present in this delivery channel. */
  deliveredRowCount: number;
  ms: number;
  /** True only when the database/query limit omitted rows. */
  queryTruncated: boolean;
  /** Rows omitted only from this delivery (for example --no-spill preview capping). */
  deliveryOmittedRows: number;
  mode: DeliveryMode;
  spillPath: string | null;
  outPath: string | null;
  /** UTF-8 bytes of the referenced spill/out file; null when no file is referenced. */
  bytes: number | null;
}

export interface QueryMetaInput {
  rowCount: number;
  deliveredRowCount: number;
  ms: number;
  queryTruncated: boolean;
  mode: DeliveryMode;
  spillPath?: string | null;
  outPath?: string | null;
  bytes?: number | null;
}

export function versioned<T extends object>(value: T): T & { contractVersion: string } {
  return { contractVersion: OUTPUT_CONTRACT_VERSION, ...value };
}

export function buildQueryMeta(input: QueryMetaInput): QueryMeta {
  return {
    rowCount: input.rowCount,
    deliveredRowCount: input.deliveredRowCount,
    ms: input.ms,
    queryTruncated: input.queryTruncated,
    deliveryOmittedRows: input.rowCount - input.deliveredRowCount,
    mode: input.mode,
    spillPath: input.spillPath ?? null,
    outPath: input.outPath ?? null,
    bytes: input.bytes ?? null,
  };
}

/** Object formats use stable unique keys; columns retains the original database labels. */
export function uniqueColumnKeys(columns: string[]): string[] {
  const reserved = new Set(columns);
  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();

  return columns.map((column) => {
    if (!used.has(column)) {
      used.add(column);
      return column;
    }

    let suffix = nextSuffix.get(column) ?? 2;
    let candidate = column + '#' + suffix;
    while (reserved.has(candidate) || used.has(candidate)) {
      suffix += 1;
      candidate = column + '#' + suffix;
    }
    nextSuffix.set(column, suffix + 1);
    used.add(candidate);
    return candidate;
  });
}

export function rowToObject(keys: string[], row: SqlValue[]): Record<string, SqlValue> {
  return Object.fromEntries(keys.map((key, index) => [key, row[index] ?? null]));
}

export interface NdjsonHeaderInput {
  command: string;
  ds?: string;
  columns: string[];
  meta: QueryMeta | { rowCount: number; deliveredRowCount: number };
}

/** One NDJSON contract for every command: one header, then zero or more versioned rows. */
export function buildNdjson(input: NdjsonHeaderInput, rows: SqlValue[][]): string {
  const keys = uniqueColumnKeys(input.columns);
  const header = versioned({
    type: 'header' as const,
    command: input.command,
    ...(input.ds === undefined ? {} : { ds: input.ds }),
    columns: input.columns,
    keys,
    meta: input.meta,
  });
  const records = rows.map((row) => versioned({
    type: 'row' as const,
    row: rowToObject(keys, row),
  }));
  return [header, ...records].map((record) => JSON.stringify(record)).join('\n') + '\n';
}
