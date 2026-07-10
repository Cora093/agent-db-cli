import { describe, it, expect, vi } from 'vitest';
import { emitResult, inferOutFormat } from '../src/output/emit.js';
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

const noWrites = {
  writeSpill: vi.fn(() => '/tmp/agent-db-cli/x.ndjson'),
  writeOut: vi.fn(() => ({ bytes: 0 })),
};

describe('inferOutFormat (§9b 按扩展名推断)', () => {
  it('.csv/.ndjson/.json 各自对应', () => {
    expect(inferOutFormat('a.csv', 'json')).toBe('csv');
    expect(inferOutFormat('a.ndjson', 'json')).toBe('ndjson');
    expect(inferOutFormat('a.json', 'csv')).toBe('json');
  });
  it('认不出回退 --format', () => {
    expect(inferOutFormat('a.dat', 'csv')).toBe('csv');
    expect(inferOutFormat('a.dat', 'json')).toBe('json');
  });
});

describe('emitResult — JSON 默认(agent-first)', () => {
  it('小结果内联,spillPath=null,不写盘', () => {
    const deps = { writeSpill: vi.fn(() => 'X'), writeOut: vi.fn(() => ({ bytes: 0 })) };
    const out = emitResult({ ds: 'd', result: result(3), format: 'json', noSpill: false }, deps);
    const obj = JSON.parse(out);
    expect(obj.rows).toHaveLength(3);
    expect(obj.meta.spillPath).toBeNull();
    expect(deps.writeSpill).not.toHaveBeenCalled();
  });

  it('大结果(>50 行)落盘 + preview 50 + spillPath', () => {
    const deps = {
      writeSpill: vi.fn(() => '/tmp/agent-db-cli/big.ndjson'),
      writeOut: vi.fn(() => ({ bytes: 0 })),
    };
    const out = emitResult({ ds: 'd', result: result(120), format: 'json', noSpill: false }, deps);
    const obj = JSON.parse(out);
    expect(deps.writeSpill).toHaveBeenCalledOnce();
    expect(obj.preview).toHaveLength(50);
    expect(obj.rows).toBeUndefined();
    expect(obj.meta.spillPath).toBe('/tmp/agent-db-cli/big.ndjson');
    expect(obj.meta.rowCount).toBe(120);
  });

  it('--no-spill 大结果内联截断到 50 + truncated,不写盘', () => {
    const deps = { writeSpill: vi.fn(() => 'X'), writeOut: vi.fn(() => ({ bytes: 0 })) };
    const out = emitResult({ ds: 'd', result: result(120), format: 'json', noSpill: true }, deps);
    const obj = JSON.parse(out);
    expect(deps.writeSpill).not.toHaveBeenCalled();
    expect(obj.rows).toHaveLength(50);
    expect(obj.meta.truncated).toBe(true);
    expect(obj.meta.spillPath).toBeNull();
  });
});

describe('emitResult — 显式 table/csv(给人/Excel)', () => {
  it('table 直出对齐表,不落盘', () => {
    const out = emitResult(
      { ds: 'd', result: result(60), format: 'table', noSpill: false },
      noWrites,
    );
    expect(out).toContain('-- 60 rows, 7ms');
    expect(noWrites.writeSpill).not.toHaveBeenCalled();
  });

  it('csv 直出全部行', () => {
    const out = emitResult(
      { ds: 'd', result: result(3), format: 'csv', noSpill: false },
      noWrites,
    );
    expect(out.split('\r\n')).toEqual(['n', '0', '1', '2']);
  });
});

describe('emitResult — --out 写文件', () => {
  it('按扩展名 csv 写盘,stdout 给摘要含 outPath', () => {
    const deps = {
      writeSpill: vi.fn(() => 'X'),
      writeOut: vi.fn(() => ({ bytes: 1234 })),
    };
    const out = emitResult(
      { ds: 'd', result: result(10), format: 'json', noSpill: false, outPath: '/o/data.csv' },
      deps,
    );
    expect(deps.writeOut).toHaveBeenCalledOnce();
    const [p, content] = deps.writeOut.mock.calls[0];
    expect(p).toBe('/o/data.csv');
    expect(content.startsWith('n\r\n')).toBe(true);
    const obj = JSON.parse(out);
    expect(obj.meta.outPath).toBe('/o/data.csv');
    expect(obj.meta.bytes).toBe(1234);
    expect(obj.meta.rowCount).toBe(10);
  });

  it('table 导出透传真实 meta:截断如实标 (truncated),不谎报完整(M2)', () => {
    const deps = {
      writeSpill: vi.fn(() => 'X'),
      writeOut: vi.fn(() => ({ bytes: 1 })),
      warn: vi.fn(),
    };
    emitResult(
      {
        ds: 'd',
        result: result(10, { truncated: true, ms: 42 }),
        format: 'table',
        noSpill: false,
        outPath: '/o/data.txt',
      },
      deps,
    );
    const [, content] = deps.writeOut.mock.calls[0];
    expect(content).toContain('-- 10 rows, 42ms (truncated)');
  });

  it('json 导出带 meta { rowCount, truncated }(M2)', () => {
    const deps = {
      writeSpill: vi.fn(() => 'X'),
      writeOut: vi.fn(() => ({ bytes: 1 })),
    };
    emitResult(
      {
        ds: 'd',
        result: result(3, { truncated: true }),
        format: 'json',
        noSpill: false,
        outPath: '/o/data.json',
      },
      deps,
    );
    const [, content] = deps.writeOut.mock.calls[0];
    const obj = JSON.parse(content);
    expect(obj.meta).toEqual({ rowCount: 3, truncated: true });
    expect(obj.rows).toHaveLength(3);
  });

  it('未知扩展名(.xlsx)→ stderr 提示真实写入格式,不静默(M2)', () => {
    const warn = vi.fn();
    const deps = {
      writeSpill: vi.fn(() => 'X'),
      writeOut: vi.fn(() => ({ bytes: 1 })),
      warn,
    };
    emitResult(
      { ds: 'd', result: result(2), format: 'json', noSpill: false, outPath: '/o/data.xlsx' },
      deps,
    );
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('.xlsx');
    expect(warn.mock.calls[0][0]).toContain('json');
  });

  it('已知扩展名不提示', () => {
    const warn = vi.fn();
    const deps = {
      writeSpill: vi.fn(() => 'X'),
      writeOut: vi.fn(() => ({ bytes: 1 })),
      warn,
    };
    emitResult(
      { ds: 'd', result: result(2), format: 'json', noSpill: false, outPath: '/o/data.csv' },
      deps,
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
