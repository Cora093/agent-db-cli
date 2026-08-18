import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryCommand } from '../src/commands/query.js';
import { createRowFileWriter } from '../src/output/stream-file.js';
import { formatTable } from '../src/output/format.js';
import type { Dialect, QueryResult, RunOptions } from '../src/dialects/types.js';

const files: string[] = [];
afterEach(() => { for (const file of files.splice(0)) fs.rmSync(file, { force: true }); });
function temp(ext: string) { const f = path.join(os.tmpdir(), 'agent-db-query-' + process.pid + '-' + Math.random() + ext); files.push(f); return f; }
const ds = { id: 'd', driver: 'mysql' as const, host: 'h', user: 'u', password: 'p' };

function dialect(run: (opts: RunOptions) => Promise<QueryResult>): Dialect {
  return {
    connect: async () => ({ close: vi.fn(async () => undefined) }),
    runReadOnly: async (_conn, _sql, opts) => run(opts),
    listNamespaces: async () => ({ status: 'full', data: [] }),
    listTables: async () => [],
    getSchema: async () => { throw new Error('unused'); },
  } satisfies Dialect;
}

describe('queryCommand streamed output orchestration', () => {
  it('small default JSON removes the provisional spill and emits inline', async () => {
    const spill = temp('.ndjson');
    const writer = createRowFileWriter(spill, 'ndjson', 'd');
    files.push(writer.tempPath);
    const abort = vi.spyOn(writer, 'abort');
    const out = await queryCommand(ds, 'SELECT 1', { limit: 500, timeoutMs: 1000 }, 'json', {}, {
      getDialect: () => dialect(async (opts) => {
        opts.onRow?.([1], ['n']);
        return { columns: ['n'], rows: [[1]], rowCount: 1, resultBytes: 3, truncated: false, ms: 2 };
      }),
      createSpillWriter: () => writer,
    });
    expect(JSON.parse(out)).toMatchObject({ rows: [[1]], meta: { spillPath: null, rowCount: 1 } });
    expect(abort).toHaveBeenCalledOnce();
    expect(fs.existsSync(spill)).toBe(false);
    expect(fs.existsSync(writer.tempPath)).toBe(false);
  });

  it('large default JSON publishes complete framed NDJSON while retaining only its preview', async () => {
    const spill = temp('.ndjson');
    const writer = createRowFileWriter(spill, 'ndjson', 'd', { delivery: 'spill' });
    files.push(writer.tempPath);
    const out = await queryCommand(ds, 'SELECT n', { limit: 500, timeoutMs: 1000 }, 'json', {}, {
      getDialect: () => dialect(async (opts) => {
        for (let i = 0; i < 60; i++) expect(opts.onRow?.([i], ['n'])).toBe(true);
        return {
          columns: ['n'], rows: Array.from({ length: 50 }, (_, i) => [i]), rowCount: 60,
          resultBytes: 200_000, truncated: false, ms: 3,
        };
      }),
      createSpillWriter: () => writer,
    });
    const summary = JSON.parse(out);
    expect(summary.preview).toHaveLength(50);
    expect(summary.meta.spillPath).toBe(spill);
    const records = fs.readFileSync(spill, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(records).toHaveLength(62);
    expect(records[0]).toMatchObject({ type: 'header', columns: ['n'] });
    expect(records[60]).toMatchObject({ type: 'row', row: { n: 59 } });
    expect(records[61]).toMatchObject({ type: 'trailer', meta: { rowCount: 60, spillPath: spill } });
  });

  it('small truncated JSON stays inline, retains truncation metadata, and removes its temp file', async () => {
    const close = vi.fn(async () => { throw new Error('must not close discarded connection'); });
    const discardedDialect = dialect(async () => ({
      columns: ['n'], rows: [[1]], rowCount: 1, resultBytes: 3,
      truncated: true, truncationReason: 'row-limit', ms: 2,
    }));
    discardedDialect.connect = async () => ({ discarded: true, close });
    const spill = temp('.ndjson');
    const writer = createRowFileWriter(spill, 'ndjson', 'd', { delivery: 'spill' });
    files.push(writer.tempPath);
    const out = await queryCommand(ds, 'SELECT 1', { limit: 1, timeoutMs: 1000 }, 'json', {}, {
      getDialect: () => discardedDialect,
      createSpillWriter: () => writer,
    });
    expect(JSON.parse(out)).toMatchObject({
      rows: [[1]],
      meta: { queryTruncated: true, truncationReason: 'row-limit', spillPath: null },
    });
    expect(fs.existsSync(spill)).toBe(false);
    expect(fs.existsSync(writer.tempPath)).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it('table output preserves bounded formatting through atomic buffered write', async () => {
    const outPath = temp('.txt');
    fs.writeFileSync(outPath, 'existing', 'utf8');
    await queryCommand(ds, 'SELECT 1', { limit: 500, timeoutMs: 1000, out: outPath }, 'table', {}, {
      getDialect: () => dialect(async () => ({
        columns: ['n'], rows: [[1]], resultBytes: 3, truncated: false, ms: 2,
      })),
    });
    expect(fs.readFileSync(outPath, 'utf8')).toBe(
      formatTable(['n'], [[1]], { rowCount: 1, ms: 2, truncated: false }),
    );
  });

  it('byte-truncated CSV output fails and preserves the destination', async () => {
    const outPath = temp('.csv');
    fs.writeFileSync(outPath, 'existing', 'utf8');
    await expect(queryCommand(ds, 'SELECT 1', {
      limit: 500, timeoutMs: 1000, out: outPath,
    }, 'csv', {}, {
      getDialect: () => dialect(async (opts) => {
        expect(opts.onRow?.(['12345678901234567890'], ['v'])).toBe(false);
        return {
          columns: ['v'], rows: [], rowCount: 0, resultBytes: 0,
          truncated: true, truncationReason: 'result-bytes', ms: 2,
        };
      }),
      createOutWriter: (plan, id) => createRowFileWriter(
        plan.path, 'csv', id, { maxBytes: 20, delivery: 'out' },
      ),
    })).rejects.toThrow('CSV 输出超过结果字节预算');
    expect(fs.readFileSync(outPath, 'utf8')).toBe('existing');
  });

  it('warning failure preserves an existing output destination and removes its temp file', async () => {
    const outPath = temp('.unknown');
    fs.writeFileSync(outPath, 'existing', 'utf8');
    await expect(queryCommand(ds, 'SELECT 1', {
      limit: 500, timeoutMs: 1000, out: outPath,
      warn: () => { throw new Error('warning failed'); },
    }, 'json', {}, {
      getDialect: () => dialect(async (opts) => {
        opts.onRow?.([1], ['n']);
        return { columns: ['n'], rows: [[1]], rowCount: 1, resultBytes: 3, truncated: false, ms: 2 };
      }),
    })).rejects.toThrow('warning failed');
    expect(fs.readFileSync(outPath, 'utf8')).toBe('existing');
    expect(fs.readdirSync(path.dirname(outPath)).filter((name) => name.startsWith(path.basename(outPath) + '.tmp-'))).toEqual([]);
  });

  it('query failure preserves an existing output destination', async () => {
    const outPath = temp('.json');
    fs.writeFileSync(outPath, 'existing', 'utf8');
    await expect(queryCommand(ds, 'SELECT 1', {
      limit: 500, timeoutMs: 1000, out: outPath,
    }, 'json', {}, {
      getDialect: () => dialect(async (opts) => {
        opts.onRow?.([1], ['n']);
        throw new Error('query failed');
      }),
    })).rejects.toThrow('query failed');
    expect(fs.readFileSync(outPath, 'utf8')).toBe('existing');
    expect(fs.readdirSync(path.dirname(outPath)).filter((name) => name.startsWith(path.basename(outPath) + '.tmp-'))).toEqual([]);
  });
});
