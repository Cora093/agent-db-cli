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
    driver: 'mysql',
    connect: async () => ({ driver: 'mysql', close: vi.fn(async () => undefined) }),
    runReadOnly: async (_conn, _sql, opts) => run(opts),
    readOnlyTxnSQL: () => null,
    needsAutocommitOff: () => false,
    statementTimeoutSQL: () => null,
    listTables: async () => [],
    getSchema: async () => { throw new Error('unused'); },
    mapType: () => null,
  };
}

describe('queryCommand streamed output orchestration', () => {
  it('small default JSON removes provisional spill and emits inline', async () => {
    const spill = temp('.ndjson');
    const writer = createRowFileWriter(spill, 'ndjson', 'd', { direct: true });
    const abort = vi.spyOn(writer, 'abort');
    const out = await queryCommand(ds, 'SELECT 1', {
      limit: 500, timeoutMs: 1000, noSpill: false,
    }, 'json', {}, {
      getDialect: () => dialect(async (opts) => {
        opts.onRow?.([1], ['n']);
        return { columns: ['n'], rows: [[1]], rowCount: 1, resultBytes: 3, truncated: false, ms: 2 };
      }),
      createSpillWriter: () => writer,
    });
    expect(JSON.parse(out)).toMatchObject({ rows: [[1]], meta: { spillPath: null, rowCount: 1 } });
    expect(abort).toHaveBeenCalledOnce();
    expect(fs.existsSync(spill)).toBe(false);
  });

  it('successful truncation skips close on a discarded connection', async () => {
    const close = vi.fn(async () => { throw new Error('must not close discarded connection'); });
    const discardedDialect = dialect(async () => ({
      columns: ['n'], rows: [[1]], rowCount: 1, resultBytes: 3,
      truncated: true, truncationReason: 'row-limit', ms: 2,
    }));
    discardedDialect.connect = async () => ({ driver: 'mysql', discarded: true, close });
    const out = await queryCommand(ds, 'SELECT 1', {
      limit: 1, timeoutMs: 1000, noSpill: true,
    }, 'json', {}, { getDialect: () => discardedDialect });
    expect(JSON.parse(out).meta.queryTruncated).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });

  it('table --out preserves legacy formatter through atomic buffered write', async () => {
    const outPath = temp('.txt');
    fs.writeFileSync(outPath, 'existing', 'utf8');
    await queryCommand(ds, 'SELECT 1', {
      limit: 500, timeoutMs: 1000, noSpill: false, out: outPath,
    }, 'table', {}, {
      getDialect: () => dialect(async () => ({
        columns: ['n'], rows: [[1]], resultBytes: 3, truncated: false, ms: 2,
      })),
    });
    const content = fs.readFileSync(outPath, 'utf8');
    expect(content).toBe(
      formatTable(['n'], [[1]], { rowCount: 1, ms: 2, truncated: false }),
    );
  });

  it('byte-truncated CSV --out fails and preserves the destination', async () => {
    const outPath = temp('.csv');
    fs.writeFileSync(outPath, 'existing', 'utf8');
    await expect(queryCommand(ds, 'SELECT 1', {
      limit: 500, timeoutMs: 1000, noSpill: false, out: outPath,
    }, 'csv', {}, {
      getDialect: () => dialect(async (opts) => {
        expect(opts.onRow?.(['12345678901234567890'], ['v'])).toBe(false);
        return {
          columns: ['v'], rows: [], rowCount: 0, resultBytes: 0,
          truncated: true, truncationReason: 'result-bytes', ms: 2,
        };
      }),
      createOutWriter: (file, fallback, id) => createRowFileWriter(
        file,
        fallback === 'csv' ? 'csv' : 'json',
        id,
        { maxBytes: 20, delivery: 'out' },
      ),
    })).rejects.toThrow('CSV 输出超过结果字节预算');
    expect(fs.readFileSync(outPath, 'utf8')).toBe('existing');
  });

  it('query failure preserves existing --out destination', async () => {
    const outPath = temp('.json');
    fs.writeFileSync(outPath, 'existing', 'utf8');
    await expect(queryCommand(ds, 'SELECT 1', {
      limit: 500, timeoutMs: 1000, noSpill: false, out: outPath,
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
