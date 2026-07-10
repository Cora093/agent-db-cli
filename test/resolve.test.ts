import { describe, it, expect } from 'vitest';
import { resolveDatasource } from '../src/config/resolve.js';
import type { DatasourceConfig } from '../src/config/types.js';
import { AppError } from '../src/errors.js';

const base: DatasourceConfig = {
  id: 'prod-mysql-ro',
  driver: 'mysql',
  host: 'h',
  port: 3306,
  database: 'orders',
  user: 'app_readonly',
};

describe('resolveDatasource (§5/§6/§7)', () => {
  it('字面量密码解析,基本字段透传', () => {
    const r = resolveDatasource({ ...base, password: 'pw', label: 'L' }, {});
    expect(r.password).toBe('pw');
    expect(r.id).toBe('prod-mysql-ro');
    expect(r.driver).toBe('mysql');
    expect(r.host).toBe('h');
    expect(r.port).toBe(3306);
    expect(r.database).toBe('orders');
    expect(r.label).toBe('L');
  });

  it('env: 密码从环境解析', () => {
    const r = resolveDatasource({ ...base, password: 'env:PW' }, { PW: 'secret' });
    expect(r.password).toBe('secret');
  });

  it('env: 缺失变量抛 CONFIG', () => {
    expect(() => resolveDatasource({ ...base, password: 'env:NOPE' }, {})).toThrow(AppError);
  });

  it('mysql 族强制 multipleStatements:false', () => {
    const r = resolveDatasource({ ...base, options: { connectTimeout: 5000 } }, {});
    expect(r.safeOptions.multipleStatements).toBe(false);
    expect(r.safeOptions.connectTimeout).toBe(5000);
  });

  it('非白名单连接选项被拒', () => {
    expect(() =>
      resolveDatasource({ ...base, options: { allowLocalInfile: true } }, {}),
    ).toThrow(/allowLocalInfile/);
  });

  it('doris 等 mysql 协议族沿用 mysql 选项策略', () => {
    const r = resolveDatasource(
      { ...base, driver: 'doris', port: 9030, options: { connectTimeout: 1000 } },
      {},
    );
    expect(r.safeOptions.multipleStatements).toBe(false);
  });

  it('postgres 选项策略独立(不强制 multipleStatements)', () => {
    const r = resolveDatasource(
      { ...base, driver: 'postgres', port: 5432, options: { application_name: 'agent-db' } },
      {},
    );
    expect(r.safeOptions.application_name).toBe('agent-db');
    expect('multipleStatements' in r.safeOptions).toBe(false);
  });
});
