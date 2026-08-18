import { describe, it, expect } from 'vitest';
import {
  pickDatasource,
  renderView,
  parseTableArg,
  resolveSqlInput,
  resolveQueryLimits,
} from '../src/commands/common.js';
import type { Config } from '../src/config/types.js';
import { AppError } from '../src/errors.js';

const config: Config = {
  path: '/cfg.yaml',
  datasources: {
    'prod-mysql-ro': { id: 'prod-mysql-ro', driver: 'mysql', host: 'h', user: 'u' },
    'bi-doris-ro': { id: 'bi-doris-ro', driver: 'doris', host: 'h2', user: 'u2' },
  },
};

describe('pickDatasource (§8 --ds 显式)', () => {
  it('命中返回配置', () => {
    expect(pickDatasource(config, 'prod-mysql-ro').driver).toBe('mysql');
  });
  it('未命中 → DATASOURCE_NOT_FOUND,hint 列出所有合法 id', () => {
    try {
      pickDatasource(config, 'prd');
      throw new Error('应当抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).category).toBe('DATASOURCE_NOT_FOUND');
      expect((e as AppError).hint).toContain('prod-mysql-ro');
      expect((e as AppError).hint).toContain('bi-doris-ro');
    }
  });
});

describe('renderView (§9 三格式)', () => {
  const view = {
    json: { datasources: [{ id: 'a' }] },
    columns: ['id', 'driver'],
    rows: [['a', 'mysql'] as const].map((r) => [...r]),
  };
  it('json → JSON.stringify(view.json)', () => {
    expect(JSON.parse(renderView(view, 'json'))).toEqual({ datasources: [{ id: 'a' }] });
  });
  it('csv → 表格 csv', () => {
    expect(renderView(view, 'csv')).toBe('id,driver\r\na,mysql');
  });
  it('table → 对齐表(无脚注)', () => {
    expect(renderView(view, 'table')).toBe(['id  driver', '--  ------', 'a   mysql'].join('\n'));
  });
});

describe('parseTableArg (§8 schema.table 糖)', () => {
  it('裸表名 + --schema', () => {
    expect(parseTableArg('orders', 'sales')).toEqual({ schema: 'sales', table: 'orders' });
  });
  it('点号糖优先', () => {
    expect(parseTableArg('sales.orders', undefined)).toEqual({ schema: 'sales', table: 'orders' });
  });
  it('无 schema', () => {
    expect(parseTableArg('orders', undefined)).toEqual({ schema: undefined, table: 'orders' });
  });
});

describe('resolveSqlInput (§8 三通道)', () => {
  const deps = { readFile: (p: string) => `-- from ${p}`, readStdin: () => 'STDIN SQL' };
  it('位置参数', () => {
    expect(resolveSqlInput('SELECT 1', undefined, deps)).toBe('SELECT 1');
  });
  it('-f 文件按 UTF-8 读', () => {
    expect(resolveSqlInput(undefined, 'q.sql', deps)).toBe('-- from q.sql');
  });
  it('-f - 读 stdin', () => {
    expect(resolveSqlInput(undefined, '-', deps)).toBe('STDIN SQL');
  });
  it('多输入源 → BAD_USAGE', () => {
    expect(() => resolveSqlInput('SELECT 1', 'q.sql', deps)).toThrow(AppError);
  });
  it('无输入 → BAD_USAGE', () => {
    expect(() => resolveSqlInput(undefined, undefined, deps)).toThrow(AppError);
  });
});

describe('resolveQueryLimits (§7/§8 夹紧)', () => {
  it('默认 limit=500, timeout=30s', () => {
    const r = resolveQueryLimits({}, undefined);
    expect(r.limit).toBe(500);
    expect(r.timeoutMs).toBe(30000);
    expect(r.notes).toEqual([]);
  });

  it('limit 在 1..500 内保留', () => {
    expect(resolveQueryLimits({ limit: 50 }, undefined).limit).toBe(50);
  });

  it('limit >500 夹到 500 + 提示', () => {
    const r = resolveQueryLimits({ limit: 1000 }, undefined);
    expect(r.limit).toBe(500);
    expect(r.notes.join(' ')).toContain('500');
  });

  it('limit <1 夹到 1', () => {
    expect(resolveQueryLimits({ limit: 0 }, undefined).limit).toBe(1);
  });

  it('timeout 来自 --timeout(秒)', () => {
    expect(resolveQueryLimits({ timeout: 60 }, undefined).timeoutMs).toBe(60000);
  });

  it('timeout 缺省回退 datasource 配置', () => {
    expect(resolveQueryLimits({}, 45).timeoutMs).toBe(45000);
  });

  it('timeout 超硬顶(300s)夹紧 + 提示', () => {
    const r = resolveQueryLimits({ timeout: 9999 }, undefined);
    expect(r.timeoutMs).toBe(300000);
    expect(r.notes.join(' ')).toContain('300');
  });
});

describe('renderView metadata sections', () => {
  const view = { json: { ok: true }, columns: [], rows: [], sections: [
    { name: 'primaryKey', columns: ['column'], rows: [['id']] },
    { name: 'constraints', columns: ['name', 'type'], rows: [['users_pk', 'PRIMARY KEY']] },
  ] };
  it('table includes every labeled section', () => {
    const text = renderView(view, 'table');
    expect(text).toContain('[primaryKey]');
    expect(text).toContain('[constraints]');
    expect(text).toContain('users_pk');
  });
  it('csv has one consistent section-aware schema', () => {
    const text = renderView(view, 'csv');
    const records = text.split('\r\n').map((line) => line.split(','));
    expect(records[0]).toEqual(['section', 'field1', 'field2']);
    expect(new Set(records.map((record) => record.length))).toEqual(new Set([3]));
    expect(records).toContainEqual(['primaryKey', 'column', '']);
    expect(records).toContainEqual(['constraints', 'users_pk', 'PRIMARY KEY']);
  });
});
