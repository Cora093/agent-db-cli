import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { AppError } from '../src/errors.js';

const PATH = '/cfg/datasources.yaml';

const VALID = `
datasources:
  prod-mysql-ro:
    label: 订单生产库(只读)
    driver: mysql
    host: prod-mysql-readonly.internal
    port: 3306
    database: orders
    user: app_readonly
    password: "xxxxxx"
    options: { connectTimeout: 5000 }
  analytics-pg-ro:
    driver: postgres
    host: pg-replica.internal
    port: 5432
    database: appdb
    schema: sales
    user: ro_user
    password: env:PG_PWD
  dm-core-ro:
    driver: dm
    host: dm-core.internal
    port: 5236
    user: READONLY_USER
    schema: FINANCE
`;

describe('parseConfig (§5 配置解析与校验)', () => {
  it('解析合法配置并把 map key 注入为 id', () => {
    const cfg = parseConfig(VALID, PATH);
    expect(cfg.path).toBe(PATH);
    expect(Object.keys(cfg.datasources)).toEqual([
      'prod-mysql-ro',
      'analytics-pg-ro',
      'dm-core-ro',
    ]);
    expect(cfg.datasources['prod-mysql-ro'].id).toBe('prod-mysql-ro');
    expect(cfg.datasources['prod-mysql-ro'].driver).toBe('mysql');
    expect(cfg.datasources['analytics-pg-ro'].schema).toBe('sales');
    expect(cfg.datasources['analytics-pg-ro'].password).toBe('env:PG_PWD');
  });

  it('DM 数据源可省略 database', () => {
    const cfg = parseConfig(VALID, PATH);
    expect(cfg.datasources['dm-core-ro'].database).toBeUndefined();
    expect(cfg.datasources['dm-core-ro'].schema).toBe('FINANCE');
  });

  it('YAML 语法错 → CONFIG', () => {
    expect(() => parseConfig('datasources: : :\n  - [', PATH)).toThrow(AppError);
  });

  it('YAML 语法错的报错不回显源码行(密码不泄漏)', () => {
    // 出错行紧邻含密码的行:yaml 的 pretty message 会带源码帧,这里必须已被脱敏
    const bad = `
datasources:
  x:
    driver: mysql
    host: h
    user: u
    password: "Sup3rS3cret!"
   port: [broken
`;
    try {
      parseConfig(bad, PATH);
      throw new Error('应当抛错');
    } catch (e) {
      const err = e as AppError;
      expect(err.category).toBe('CONFIG');
      expect(err.message).not.toContain('Sup3rS3cret');
      expect(err.message).toContain('YAML 解析失败');
      expect(err.message).toMatch(/行 \d+/); // 行列定位保留
    }
  });

  it('缺 datasources 顶层键 → CONFIG', () => {
    try {
      parseConfig('other: 1', PATH);
      throw new Error('应当抛错');
    } catch (e) {
      expect((e as AppError).category).toBe('CONFIG');
      expect((e as AppError).message).toContain('datasources');
    }
  });

  it('datasources 不是对象 → CONFIG', () => {
    expect(() => parseConfig('datasources: [1,2,3]', PATH)).toThrow(AppError);
  });

  it('缺 driver → CONFIG,报错带 id', () => {
    const bad = `
datasources:
  x:
    host: h
    user: u
`;
    try {
      parseConfig(bad, PATH);
      throw new Error('应当抛错');
    } catch (e) {
      expect((e as AppError).category).toBe('CONFIG');
      expect((e as AppError).message).toContain('x');
      expect((e as AppError).message).toContain('driver');
    }
  });

  it('driver 不在白名单 → CONFIG 列出合法值', () => {
    const bad = `
datasources:
  x:
    driver: oracle
    host: h
    user: u
`;
    try {
      parseConfig(bad, PATH);
      throw new Error('应当抛错');
    } catch (e) {
      expect((e as AppError).category).toBe('CONFIG');
      expect((e as AppError).message).toContain('oracle');
      expect((e as AppError).hint).toContain('mysql');
    }
  });

  it('缺 host → CONFIG', () => {
    const bad = `
datasources:
  x:
    driver: mysql
    user: u
`;
    expect(() => parseConfig(bad, PATH)).toThrow(/host/);
  });

  it('缺 user → CONFIG', () => {
    const bad = `
datasources:
  x:
    driver: mysql
    host: h
`;
    expect(() => parseConfig(bad, PATH)).toThrow(/user/);
  });

  it('port 非数字 → CONFIG', () => {
    const bad = `
datasources:
  x:
    driver: mysql
    host: h
    user: u
    port: "abc"
`;
    expect(() => parseConfig(bad, PATH)).toThrow(/port/);
  });

  it('空 datasources(无数据源)→ CONFIG', () => {
    expect(() => parseConfig('datasources: {}', PATH)).toThrow(AppError);
  });
});
