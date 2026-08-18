import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_NDJSON_KEYS_BYTES,
  MAX_SPILL_FILE_BYTES,
  createRowFileWriter,
  createSpillWriter,
} from '../src/output/stream-file.js';
import { MAX_FIELD_BYTES, MAX_RESULT_BYTES } from '../src/dialects/sql-util.js';
import { MAX_LIMIT } from '../src/commands/common.js';

const files: string[] = [];
afterEach(() => { for (const f of files.splice(0)) fs.rmSync(f, { force: true }); });
function temp(ext: string) { const f = path.join(os.tmpdir(), 'agent-db-stream-' + process.pid + '-' + Math.random() + ext); files.push(f); return f; }
const meta = { rowCount: 1, ms: 7, truncated: false, resultBytes: 3 };

describe('transactional incremental output writer', () => {
  it('writes versioned NDJSON rows and truthful trailer', () => {
    const file = temp('.ndjson');
    const w = createRowFileWriter(file, 'ndjson', 'd');
    expect(w.write([1, 2], ['x', 'x'])).toBe(true);
    w.finish(meta);
    w.commit();
    const records = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(records[0]).toEqual({
      contractVersion: '1.0',
      type: 'header',
      command: 'query',
      ds: 'd',
      columns: ['x', 'x'],
      keys: ['x', 'x#2'],
      meta: { state: 'streaming' },
    });
    expect(records[1]).toEqual({
      contractVersion: '1.0',
      type: 'row',
      row: { x: 1, 'x#2': 2 },
    });
    expect(records[2]).toMatchObject({
      contractVersion: '1.0',
      type: 'trailer',
      meta: { rowCount: 1, ms: 7, queryTruncated: false, outPath: file, resultBytes: 3 },
    });
    expect(records[2].meta.bytes).toBe(fs.statSync(file).size);
  });

  it('derives a finite spill artifact bound from the shared query budgets', () => {
    expect(MAX_NDJSON_KEYS_BYTES).toBe(MAX_FIELD_BYTES);
    expect(MAX_SPILL_FILE_BYTES).toBe(
      MAX_RESULT_BYTES + MAX_LIMIT * MAX_FIELD_BYTES + MAX_FIELD_BYTES * 2 + 4096,
    );
    expect(Number.isSafeInteger(MAX_SPILL_FILE_BYTES)).toBe(true);
  });

  it('rejects oversized NDJSON key framing without publishing', () => {
    const file = temp('.ndjson');
    const w = createRowFileWriter(file, 'ndjson', 'd', { delivery: 'spill' });
    expect(() => w.write([1], ['x'.repeat(MAX_NDJSON_KEYS_BYTES + 1)]))
      .toThrow('NDJSON 列名超过 artifact framing 预算');
    expect(fs.existsSync(file)).toBe(false);
    w.abort();
    expect(fs.existsSync(w.tempPath)).toBe(false);
  });

  it('rejects framing beyond the artifact bound without publishing', () => {
    const file = temp('.ndjson');
    const w = createRowFileWriter(file, 'ndjson', 'd', { delivery: 'spill', maxBytes: 1400 });
    expect(w.write(['x'.repeat(400)], ['value'])).toBe(true);
    expect(w.write(['y'.repeat(400)], ['value'])).toBe(false);
    w.finish({ ...meta, resultBytes: 402 }, ['value']);
    expect(fs.existsSync(file)).toBe(false);
    w.abort();
    expect(fs.existsSync(w.tempPath)).toBe(false);
  });

  it('publishes spill files only after completion and commit', () => {
    const w = createSpillWriter('atomic-test');
    files.push(w.filePath, w.tempPath);
    expect(w.tempPath).not.toBe(w.filePath);
    expect(fs.existsSync(w.tempPath)).toBe(true);
    expect(fs.existsSync(w.filePath)).toBe(false);
    w.write([1], ['id']);
    w.finish(meta, ['id']);
    expect(fs.existsSync(w.filePath)).toBe(false);
    w.commit();
    expect(fs.existsSync(w.tempPath)).toBe(false);
    expect(fs.existsSync(w.filePath)).toBe(true);
  });

  it('atomically replaces an existing destination only after commit', () => {
    const file = temp('.json');
    fs.writeFileSync(file, 'existing', 'utf8');
    const w = createRowFileWriter(file, 'json', 'prod');
    w.write([1], ['id']);
    w.finish(meta);
    expect(fs.readFileSync(file, 'utf8')).toBe('existing');
    w.commit();
    const content = fs.readFileSync(file, 'utf8');
    expect(JSON.parse(content)).toMatchObject({
      contractVersion: '1.0',
      ds: 'prod',
      columns: ['id'],
      rows: [[1]],
      meta: { rowCount: 1, ms: 7, bytes: Buffer.byteLength(content, 'utf8') },
    });
  });

  it('abort preserves an existing destination and removes sibling temp', () => {
    const file = temp('.ndjson');
    fs.writeFileSync(file, 'existing', 'utf8');
    const w = createRowFileWriter(file, 'ndjson', 'd');
    w.write([1], ['id']);
    expect(fs.existsSync(w.tempPath)).toBe(true);
    w.abort();
    expect(fs.readFileSync(file, 'utf8')).toBe('existing');
    expect(fs.existsSync(w.tempPath)).toBe(false);
  });

  it.each(['json', 'ndjson', 'csv'] as const)('preserves columns for empty %s results', (format) => {
    const file = temp('.' + format);
    const w = createRowFileWriter(file, format, 'd');
    w.finish({ ...meta, rowCount: 0, resultBytes: 0 }, ['id', 'name']);
    w.commit();
    const content = fs.readFileSync(file, 'utf8');
    if (format === 'json') {
      expect(JSON.parse(content)).toMatchObject({ columns: ['id', 'name'], rows: [] });
    } else if (format === 'ndjson') {
      expect(JSON.parse(content.split('\n')[0])).toMatchObject({
        type: 'header', columns: ['id', 'name'], keys: ['id', 'name'],
      });
    } else {
      expect(content).toBe('id,name\r\n');
    }
  });

  it('serialized byte cap rejects a complete row before any partial write', () => {
    const file = temp('.csv');
    const w = createRowFileWriter(file, 'csv', 'd', { maxBytes: 20 });
    expect(fs.readFileSync(w.tempPath, 'utf8')).toBe('');
    expect(w.write(['12345678901234567890'], ['v'])).toBe(false);
    expect(fs.readFileSync(w.tempPath, 'utf8')).toBe('v\r\n');
    expect(() => w.finish({
      ...meta,
      rowCount: 0,
      truncated: true,
      truncationReason: 'result-bytes',
    })).toThrow('CSV 输出超过结果字节预算');
    w.abort();
  });

  it('CSV uses shared RFC-4180 serializer', () => {
    const file = temp('.csv');
    const w = createRowFileWriter(file, 'csv', 'd');
    w.write(['a,b', 'x"y', null], ['one', 'two', 'three']);
    w.finish(meta);
    w.commit();
    expect(fs.readFileSync(file, 'utf8')).toBe('one,two,three\r\n"a,b","x""y",\r\n');
  });
});
