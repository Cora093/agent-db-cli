import { describe, it, expect } from 'vitest';
import { listCommand } from '../src/commands/list.js';
import type { Config } from '../src/config/types.js';

const config: Config = {
  path: '/cfg.yaml',
  datasources: {
    'prod-mysql-ro': {
      id: 'prod-mysql-ro',
      label: '订单生产库',
      driver: 'mysql',
      host: 'h1',
      database: 'orders',
      user: 'u',
    },
    'dm-core-ro': { id: 'dm-core-ro', driver: 'dm', host: 'h2', user: 'u2' },
  },
};

describe('listCommand (§8)', () => {
  it('json:结构化 datasources,label/database 缺省为 null', () => {
    const obj = JSON.parse(listCommand(config, 'json'));
    expect(obj.datasources).toEqual([
      { id: 'prod-mysql-ro', label: '订单生产库', driver: 'mysql', host: 'h1', database: 'orders' },
      { id: 'dm-core-ro', label: null, driver: 'dm', host: 'h2', database: null },
    ]);
  });

  it('table:label 缺省回退显示 id', () => {
    const out = listCommand(config, 'table');
    expect(out).toContain('dm-core-ro');
    // dm 行的 label 列回退为 id
    const dmLine = out.split('\n').find((l) => l.startsWith('dm-core-ro'))!;
    expect(dmLine).toContain('dm-core-ro');
    expect(dmLine).toContain('dm');
  });

  it('csv:含表头', () => {
    const out = listCommand(config, 'csv');
    expect(out.split('\r\n')[0]).toBe('id,label,driver,host,database');
  });
});
