import { describe, it, expect } from 'vitest';
import {
  formatCsv,
  rowsToObjects,
  formatTable,
  buildInlineJson,
  buildSpillJson,
} from '../src/output/format.js';

describe('formatCsv (§9 RFC-4180)', () => {
  it('表头 + 数据,CRLF 分隔', () => {
    const csv = formatCsv(['id', 'name'], [
      ['1', 'ACME'],
      ['2', 'Beta'],
    ]);
    expect(csv).toBe('id,name\r\n1,ACME\r\n2,Beta');
  });

  it('含逗号/引号/换行的字段被引用,引号双写转义', () => {
    const csv = formatCsv(['a'], [['x,y']]);
    expect(csv).toBe('a\r\n"x,y"');
    const csv2 = formatCsv(['a'], [['she said "hi"']]);
    expect(csv2).toBe('a\r\n"she said ""hi"""');
    const csv3 = formatCsv(['a'], [['line1\nline2']]);
    expect(csv3).toBe('a\r\n"line1\nline2"');
  });

  it('null 与空串都渲染为空字段(已知歧义)', () => {
    const csv = formatCsv(['a', 'b'], [[null, '']]);
    expect(csv).toBe('a,b\r\n,');
  });

  it('数字/布尔渲染为其字符串形式', () => {
    const csv = formatCsv(['n', 'b'], [[42, true]]);
    expect(csv).toBe('n,b\r\n42,true');
  });

  it('仅表头(无数据行)', () => {
    expect(formatCsv(['a', 'b'], [])).toBe('a,b');
  });
});

describe('rowsToObjects', () => {
  it('按列名映射成对象,保留 null', () => {
    expect(rowsToObjects(['id', 'name'], [['1', null]])).toEqual([{ id: '1', name: null }]);
  });

  it('重复列名使用稳定后缀且不丢值', () => {
    expect(rowsToObjects(['id', 'id', 'id'], [[1, 2, 3]])).toEqual([
      { id: 1, 'id#2': 2, 'id#3': 3 },
    ]);
  });

  it('原始标签含后缀时仍生成全局唯一 key', () => {
    expect(rowsToObjects(['x', 'x', 'x#2'], [[1, 2, 3]])).toEqual([
      { x: 1, 'x#3': 2, 'x#2': 3 },
    ]);
    expect(rowsToObjects(['x', 'x#2', 'x', 'x#3', 'x'], [[1, 2, 3, 4, 5]])).toEqual([
      { x: 1, 'x#2': 2, 'x#4': 3, 'x#3': 4, 'x#5': 5 },
    ]);
  });
});


describe('formatTable (§9 给人看)', () => {
  it('对齐列 + 分隔线 + 脚注;NULL 显式打印', () => {
    const out = formatTable(['id', 'name'], [
      ['1', 'ACME'],
      ['2', null],
    ], { rowCount: 2, ms: 5, truncated: false });
    expect(out).toBe(['id  name', '--  ----', '1   ACME', '2   NULL', '', '-- 2 rows, 5ms'].join('\n'));
  });

  it('truncated 在脚注标注', () => {
    const out = formatTable(['n'], [['1']], { rowCount: 500, ms: 9, truncated: true });
    expect(out).toContain('-- 500 rows, 9ms (truncated)');
  });

  it('单行用单数 row', () => {
    const out = formatTable(['n'], [['1']], { rowCount: 1, ms: 1, truncated: false });
    expect(out).toContain('-- 1 row, 1ms');
  });

  it('省略 meta 时不输出脚注(用于 list/tables/schema 列表)', () => {
    const out = formatTable(['id', 'driver'], [['prod', 'mysql']]);
    expect(out).toBe(['id    driver', '----  ------', 'prod  mysql'].join('\n'));
  });
});

describe('buildInlineJson (§9a)', () => {
  it('列式 {ds,columns,rows,meta},spillPath=null', () => {
    const obj = buildInlineJson('prod-mysql-ro', ['id', 'status'], [
      ['9007199254740993', 'paid'],
      ['9007199254740994', null],
    ], 12, false);
    expect(obj).toEqual({
      contractVersion: '1.0',
      ds: 'prod-mysql-ro',
      columns: ['id', 'status'],
      rows: [
        ['9007199254740993', 'paid'],
        ['9007199254740994', null],
      ],
      meta: {
        rowCount: 2,
        deliveredRowCount: 2,
        ms: 12,
        queryTruncated: false,
        deliveryOmittedRows: 0,
        mode: 'inline',
        spillPath: null,
        outPath: null,
        bytes: null,
        truncationReason: null,
        resultBytes: null,
      },
    });
  });
});

describe('buildSpillJson (§9b)', () => {
  it('preview 取前 50 行,meta 带 spillPath 与 bytes', () => {
    const rows = Array.from({ length: 120 }, (_, i) => [String(i)]);
    const obj = buildSpillJson('bi-doris-ro', ['n'], rows, {
      ms: 30,
      truncated: true,
      spillPath: '/tmp/agent-db-cli/x.ndjson',
      bytes: 327680,
    });
    expect(obj.ds).toBe('bi-doris-ro');
    expect(obj.columns).toEqual(['n']);
    expect(obj.preview).toHaveLength(50);
    expect(obj.preview[0]).toEqual(['0']);
    expect(obj.contractVersion).toBe('1.0');
    expect(obj.meta).toEqual({
      rowCount: 120,
      deliveredRowCount: 50,
      ms: 30,
      queryTruncated: true,
      deliveryOmittedRows: 70,
      mode: 'preview',
      spillPath: '/tmp/agent-db-cli/x.ndjson',
      outPath: null,
      bytes: 327680,
      truncationReason: null,
      resultBytes: null,
    });
  });
});
