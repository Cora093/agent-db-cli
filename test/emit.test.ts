import { describe, expect, it, vi } from 'vitest';
import { emitResult } from '../src/output/emit.js';
import { resolveOutPlan } from '../src/output/plan.js';
import type { QueryResult } from '../src/dialects/types.js';

function result(rows: number, opts: Partial<QueryResult> = {}): QueryResult {
  return {
    columns: ['n'],
    rows: Array.from({ length: rows }, (_, i) => [String(i)]),
    truncated: false,
    ms: 7,
    ...opts,
  };
}

describe('emitResult default JSON delivery', () => {
  it('inlines a small columnar result without file dependencies', () => {
    const out = JSON.parse(emitResult({ ds: 'd', result: result(3), format: 'json' }));
    expect(out.rows).toHaveLength(3);
    expect(out.meta).toMatchObject({ spillPath: null, mode: 'inline', rowCount: 3 });
  });

  it('renders a streamed large result as a 50-row preview with a recoverable artifact', () => {
    const out = JSON.parse(emitResult({
      ds: 'd',
      result: result(50, { rowCount: 120, resultBytes: 200_000 }),
      format: 'json',
      streamFile: { path: '/tmp/agent-db-cli/big.ndjson', bytes: 12_345 },
    }));
    expect(out.preview).toHaveLength(50);
    expect(out.rows).toBeUndefined();
    expect(out.meta).toMatchObject({
      spillPath: '/tmp/agent-db-cli/big.ndjson',
      bytes: 12_345,
      rowCount: 120,
      deliveredRowCount: 50,
    });
  });

  it('rejects a large JSON result without its streamed artifact', () => {
    expect(() => emitResult({ ds: 'd', result: result(51), format: 'json' }))
      .toThrow('requires a streamed spill artifact');
  });

  it('preserves collection truncation metadata', () => {
    const out = JSON.parse(emitResult({
      ds: 'd',
      result: result(1, { truncated: true, truncationReason: 'result-bytes', resultBytes: 42 }),
      format: 'json',
    }));
    expect(out.meta).toMatchObject({
      queryTruncated: true,
      truncationReason: 'result-bytes',
      resultBytes: 42,
    });
  });
});

describe('emitResult explicit stdout formats', () => {
  it('renders aligned table output', () => {
    expect(emitResult({ ds: 'd', result: result(60), format: 'table' }))
      .toContain('-- 60 rows, 7ms');
  });

  it('renders all CSV rows', () => {
    expect(emitResult({ ds: 'd', result: result(3), format: 'csv' }).split('\r\n'))
      .toEqual(['n', '0', '1', '2']);
  });
});

describe('emitResult planned file output', () => {
  it('uses the resolved plan and reports the streamed bytes', () => {
    const plan = resolveOutPlan('/o/data.csv', 'json');
    const writeOut = vi.fn();
    const out = JSON.parse(emitResult({
      ds: 'd', result: result(10), format: 'json', outPlan: plan,
      streamFile: { path: plan.path, bytes: 1234 },
    }, { writeOut }));
    expect(writeOut).not.toHaveBeenCalled();
    expect(out.meta).toMatchObject({ outPath: '/o/data.csv', bytes: 1234, rowCount: 10 });
  });

  it('keeps table output bounded and atomically delegated through writeOut', () => {
    const writeOut = vi.fn(() => ({ bytes: 100 }));
    emitResult({
      ds: 'd',
      result: result(10, { truncated: true, ms: 42 }),
      format: 'table',
      outPlan: resolveOutPlan('/o/data.txt', 'table'),
    }, { writeOut });
    const [, content] = writeOut.mock.calls[0];
    expect(content).toContain('-- 10 rows, 42ms (truncated)');
  });

  it('warns once for an unknown extension with the fallback format', () => {
    const warn = vi.fn();
    emitResult({
      ds: 'd', result: result(2), format: 'json',
      outPlan: resolveOutPlan('/o/data.xlsx', 'json'),
    }, { warn, writeOut: () => ({ bytes: 1 }) });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('.xlsx'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('json'));
  });

  it('does not warn for a recognized extension', () => {
    const warn = vi.fn();
    emitResult({
      ds: 'd', result: result(2), format: 'json',
      outPlan: resolveOutPlan('/o/data.csv', 'json'),
      streamFile: { path: '/o/data.csv', bytes: 1 },
    }, { warn });
    expect(warn).not.toHaveBeenCalled();
  });
});
