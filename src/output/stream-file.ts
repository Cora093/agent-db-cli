import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { SqlValue } from '../types.js';
import type { OutPlan, StreamFileFormat } from './plan.js';
import type { TruncationReason } from '../dialects/types.js';
import { MAX_FIELD_BYTES, MAX_RESULT_BYTES } from '../dialects/sql-util.js';
import { MAX_LIMIT } from '../commands/common.js';
import { AppError } from '../errors.js';
import { spillDir, spillFileName } from './spill.js';
import { serializeCsvRow } from './format.js';
import {
  OUTPUT_CONTRACT_VERSION,
  buildQueryMeta,
  rowToObject,
  uniqueColumnKeys,
  versioned,
} from './contract.js';

export const MAX_SERIALIZED_FILE_BYTES = MAX_RESULT_BYTES;

// NDJSON repeats object keys in every row. Initialization caps their encoded framing at the
// single-field budget, so this covers 500 rows plus values, header copies, and completion metadata.
export const MAX_NDJSON_KEYS_BYTES = MAX_FIELD_BYTES;
export const MAX_SPILL_FILE_BYTES =
  MAX_RESULT_BYTES + MAX_LIMIT * MAX_NDJSON_KEYS_BYTES + MAX_NDJSON_KEYS_BYTES * 2 + 4096;

export interface StreamCompletionMeta {
  rowCount: number;
  ms: number;
  truncated: boolean;
  truncationReason?: TruncationReason;
  resultBytes: number;
}

export interface RowFileWriter {
  readonly filePath: string;
  readonly tempPath: string;
  readonly format: StreamFileFormat;
  write(row: SqlValue[], columns: string[]): boolean;
  finish(meta: StreamCompletionMeta, columns?: string[]): { bytes: number };
  commit(): void;
  abort(): void;
}

export function createSpillWriter(ds: string): RowFileWriter {
  const dir = spillDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, spillFileName(ds));
  return createRowFileWriter(filePath, 'ndjson', ds, {
    delivery: 'spill',
    maxBytes: MAX_SPILL_FILE_BYTES,
  });
}

export function writeFileAtomically(filePath: string, content: string): { bytes: number } {
  const tempPath = siblingTempPath(filePath);
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    atomicReplace(tempPath, filePath);
    return { bytes: Buffer.byteLength(content, 'utf8') };
  } catch (err) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

export function createOutWriter(plan: OutPlan, ds: string): RowFileWriter {
  if (!plan.streamable) throw new Error('table output uses bounded buffering');
  return createRowFileWriter(plan.path, plan.format as StreamFileFormat, ds, { delivery: 'out' });
}

export function createRowFileWriter(
  filePath: string,
  format: StreamFileFormat,
  ds: string,
  opts: {
    delivery?: 'out' | 'spill';
    maxBytes?: number;
  } = {},
): RowFileWriter {
  const maxBytes = opts.maxBytes ?? MAX_SERIALIZED_FILE_BYTES;
  const delivery = opts.delivery ?? 'out';
  const tempPath = siblingTempPath(filePath);
  const fd = fs.openSync(tempPath, 'wx');
  let bytes = 0;
  let first = true;
  let closed = false;
  let initialized = false;
  let columns: string[] = [];
  let keys: string[] = [];
  const append = (text: string) => { bytes += fs.writeSync(fd, text, undefined, 'utf8'); };
  const canAppend = (text: string, reserve = 0) =>
    bytes + Buffer.byteLength(text, 'utf8') + reserve <= maxBytes;
  const initialize = (nextColumns: string[]) => {
    if (initialized) return;
    columns = [...nextColumns];
    keys = uniqueColumnKeys(columns);
    if (format === 'ndjson') {
      const keyFramingBytes = Buffer.byteLength(JSON.stringify(keys), 'utf8');
      if (keyFramingBytes > MAX_NDJSON_KEYS_BYTES) {
        throw new Error('NDJSON 列名超过 artifact framing 预算');
      }
    }
    const header = format === 'ndjson'
      ? JSON.stringify(versioned({
          type: 'header' as const,
          command: 'query',
          ds,
          columns,
          keys,
          meta: { state: 'streaming' as const },
        })) + '\n'
      : format === 'csv'
        ? serializeCsvRow(columns) + '\r\n'
        : '{"contractVersion":' + JSON.stringify(OUTPUT_CONTRACT_VERSION)
          + ',"ds":' + JSON.stringify(ds)
          + ',"columns":' + JSON.stringify(columns) + ',"rows":[';
    if (!canAppend(header, completionReserve(format))) throw new Error('输出 envelope 超过结果字节预算');
    append(header);
    initialized = true;
  };

  return {
    filePath,
    tempPath,
    format,
    write(row, nextColumns) {
      if (closed) return false;
      initialize(nextColumns);
      const serialized = format === 'ndjson'
        ? JSON.stringify(versioned({ type: 'row' as const, row: rowToObject(keys, row) })) + '\n'
        : format === 'csv'
          ? serializeCsvRow(row) + '\r\n'
          : (first ? '' : ',') + JSON.stringify(row);
      if (!canAppend(serialized, completionReserve(format))) return false;
      append(serialized);
      first = false;
      return true;
    },
    finish(meta, finalColumns) {
      if (!closed) {
        if (format === 'csv' && delivery === 'out' && meta.truncationReason === 'result-bytes') {
          throw new AppError('INTERNAL', 'CSV 输出超过结果字节预算,未替换目标文件', {
            hint: '缩窄选择列、截取大字段,或改用带完成 metadata 的 JSON/NDJSON',
          });
        }
        if (!initialized) initialize(finalColumns ?? []);
        const completion = completionText(format, meta, bytes, filePath, delivery);
        if (!canAppend(completion)) throw new Error('输出 completion metadata 超过结果字节预算');
        append(completion);
        fs.closeSync(fd);
        closed = true;
      }
      return { bytes };
    },
    commit() {
      if (!closed) throw new Error('writer must finish before commit');
      if (tempPath !== filePath) atomicReplace(tempPath, filePath);
    },
    abort() {
      if (!closed) {
        fs.closeSync(fd);
        closed = true;
      }
      try { fs.rmSync(tempPath, { force: true }); } catch { /* best effort */ }
    },
  };
}

function completionText(
  format: StreamFileFormat,
  meta: StreamCompletionMeta,
  currentBytes: number,
  filePath: string,
  delivery: 'out' | 'spill',
): string {
  if (format === 'csv') return '';
  let finalBytes = currentBytes;
  let text = '';
  for (let i = 0; i < 4; i++) {
    const queryMeta = buildQueryMeta({
      rowCount: meta.rowCount,
      deliveredRowCount: meta.rowCount,
      ms: meta.ms,
      queryTruncated: meta.truncated,
      mode: 'out',
      ...(delivery === 'spill' ? { spillPath: filePath } : { outPath: filePath }),
      bytes: finalBytes,
      truncationReason: meta.truncationReason,
      resultBytes: meta.resultBytes,
    });
    text = format === 'ndjson'
      ? JSON.stringify(versioned({ type: 'trailer' as const, meta: queryMeta })) + '\n'
      : '],"meta":' + JSON.stringify(queryMeta) + '}';
    finalBytes = currentBytes + Buffer.byteLength(text, 'utf8');
  }
  return text;
}

function completionReserve(format: StreamFileFormat): number {
  return format === 'csv' ? 0 : 768;
}

function atomicReplace(tempPath: string, filePath: string): void {
  try {
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    if (process.platform !== 'win32' || !fs.existsSync(filePath)) throw err;
    const backup = siblingTempPath(filePath + '.bak');
    fs.renameSync(filePath, backup);
    try {
      fs.renameSync(tempPath, filePath);
      fs.rmSync(backup, { force: true });
    } catch (replaceErr) {
      fs.renameSync(backup, filePath);
      throw replaceErr;
    }
  }
}

function siblingTempPath(filePath: string): string {
  return filePath + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
}
