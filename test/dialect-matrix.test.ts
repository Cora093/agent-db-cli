import { describe, it, expect } from 'vitest';
import { getDialect } from '../src/dialects/registry.js';

describe('只读事务策略矩阵 (§7)', () => {
  it('MySQL: START TRANSACTION READ ONLY, autoCommit 无需关', () => {
    const d = getDialect('mysql');
    expect(d.readOnlyTxnSQL()).toBe('START TRANSACTION READ ONLY');
    expect(d.needsAutocommitOff()).toBe(false);
  });

  it('PostgreSQL: BEGIN READ ONLY', () => {
    expect(getDialect('postgres').readOnlyTxnSQL()).toBe('BEGIN READ ONLY');
  });

  it('DM: SET TRANSACTION READ ONLY 且需 autoCommit=false', () => {
    const d = getDialect('dm');
    expect(d.readOnlyTxnSQL()).toBe('SET TRANSACTION READ ONLY');
    expect(d.needsAutocommitOff()).toBe(true);
  });

  it('TiDB / OceanBase 走 MySQL 协议族,支持只读事务', () => {
    expect(getDialect('tidb').readOnlyTxnSQL()).toBe('START TRANSACTION READ ONLY');
    expect(getDialect('oceanbase').readOnlyTxnSQL()).toBe('START TRANSACTION READ ONLY');
  });

  it('Doris / StarRocks(OLAP)跳过显式只读事务,靠 ① 只读账号', () => {
    expect(getDialect('doris').readOnlyTxnSQL()).toBeNull();
    expect(getDialect('starrocks').readOnlyTxnSQL()).toBeNull();
  });
});

describe('服务端超时变量矩阵 (§7,入参恒毫秒,各自换算)', () => {
  it('MySQL / TiDB: max_execution_time(毫秒)', () => {
    expect(getDialect('mysql').statementTimeoutSQL(30000)).toBe(
      'SET SESSION max_execution_time = 30000',
    );
    expect(getDialect('tidb').statementTimeoutSQL(30000)).toBe(
      'SET SESSION max_execution_time = 30000',
    );
  });

  it('PostgreSQL: statement_timeout(毫秒)', () => {
    expect(getDialect('postgres').statementTimeoutSQL(30000)).toBe(
      'SET statement_timeout = 30000',
    );
  });

  it('Doris / StarRocks: query_timeout(秒,向上取整)', () => {
    expect(getDialect('doris').statementTimeoutSQL(30000)).toBe('SET query_timeout = 30');
    expect(getDialect('doris').statementTimeoutSQL(1500)).toBe('SET query_timeout = 2');
    expect(getDialect('starrocks').statementTimeoutSQL(30000)).toBe('SET query_timeout = 30');
  });

  it('OceanBase: ob_query_timeout(微秒)', () => {
    expect(getDialect('oceanbase').statementTimeoutSQL(30000)).toBe(
      'SET ob_query_timeout = 30000000',
    );
  });

  it('DM: 服务端超时变量待 §14 spike 确认 → null(暂靠客户端兜底)', () => {
    expect(getDialect('dm').statementTimeoutSQL(30000)).toBeNull();
  });
});

describe('getDialect', () => {
  it('每个 driver 都能取到对应实例', () => {
    for (const d of ['mysql', 'doris', 'starrocks', 'tidb', 'oceanbase', 'postgres', 'dm'] as const) {
      expect(getDialect(d).driver).toBe(d);
    }
  });
});
