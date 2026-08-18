import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseDbUrl, standardSuite, gatedDescribe, queryOnce, type ParsedDb } from './helpers.js';

/**
 * PostgreSQL 集成测试。门控 AGENT_DB_CLI_IT_PG=postgres://user:pass@host:port/postgres。
 * 夹具为 postgres 库内的 schema test20260609(须已由一次性脚本建好)。
 */
const ENV = 'AGENT_DB_CLI_IT_PG';

gatedDescribe(ENV)('integration: postgres', () => {
  // env 未设时整组 skip,但 describe 回调仍会被收集 → parse 要兜底避免抛错
  const url = process.env[ENV];
  const db: ParsedDb = url ? parseDbUrl(url) : { host: '', port: 0, user: '', password: '' };
  const datasource = {
    driver: 'postgres',
    host: db.host,
    port: db.port,
    database: db.database ?? 'postgres',
    schema: 'test20260609',
    user: db.user,
    password: db.password,
  };
  standardSuite({
    dsId: 'it-pg',
    datasource,
    employeesTable: 'employees',
    departmentsTable: 'departments',
    empLike: '%emp%',
    salaryTypeContains: 'numeric',
    salaryKind: 'string',
    fullIntrospection: true,
    missingTable: 'no_such_table',
  });

  const ds = { 'it-pg': datasource };
  const q = (sql: string) => queryOnce(ds, 'it-pg', sql);

  describe('类型契约(A3/B1)', () => {
    it('整数列 → number;numeric 恒字符串且 scale 保留', async () => {
      const r = await q('SELECT 42::int4 AS i, 9007199254740993::numeric AS big, 1.10::numeric(10,2) AS n');
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.rows[0]).toEqual([42, '9007199254740993', '1.10']);
    });

    it('bool → true/false', async () => {
      const r = await q('SELECT TRUE AS t, FALSE AS f');
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.rows[0]).toEqual([true, false]);
    });

    it('jsonb → 原生对象(嵌套保留)', async () => {
      const r = await q(`SELECT '{"a":{"b":[1,2]}}'::jsonb AS j`);
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.rows[0][0]).toEqual({ a: { b: [1, 2] } });
    });

    it('数组列 → 原生数组', async () => {
      const r = await q('SELECT ARRAY[1,2,3] AS a');
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.rows[0][0]).toEqual([1, 2, 3]);
    });

    it('DATE → "YYYY-MM-DD" 文本,不跨日(H2/T1)', async () => {
      const r = await q(`SELECT DATE '2024-01-15' AS d`);
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.rows[0][0]).toBe('2024-01-15');
    });

    it('无时区 timestamp → 墙钟文本,无 Z', async () => {
      const r = await q(`SELECT TIMESTAMP '2024-01-15 09:00:00' AS t`);
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.rows[0][0]).toBe('2024-01-15 09:00:00');
    });

    it('timestamptz → UTC ISO(真正的绝对时刻才标 Z)', async () => {
      const r = await q(`SELECT TIMESTAMPTZ '2024-01-15 09:00:00+08' AS t`);
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.rows[0][0]).toBe('2024-01-15T01:00:00.000Z');
    });
  });

  describe('守卫与词法(D1/G1/G3/G4)', () => {
    it('FOR UPDATE / FOR SHARE 被静态拦截 → exit 2', async () => {
      for (const sql of ['SELECT * FROM employees FOR UPDATE', 'SELECT * FROM employees FOR SHARE']) {
        const r = await q(sql);
        expect(r.code, sql).toBe(2);
        expect(r.errJson!.error.category).toBe('BLOCKED_LOCKING_READ');
      }
    });

    it("#>> 运算符不被当注释剪掉,真机出数(G1)", async () => {
      const r = await q(`SELECT '{"a":{"b":"v"}}'::jsonb #>> '{a,b}' AS x`);
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.rows[0][0]).toBe('v');
    });

    it('dollar-quote 字符串含分号:单语句不误拒(G4)', async () => {
      const r = await q('SELECT $$a;b$$ AS s');
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.rows[0][0]).toBe('a;b');
    });

    it('EXPLAIN 通过 cursor 有界读取保持可用(#6)', async () => {
      const r = await q('EXPLAIN SELECT * FROM employees');
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.meta.rowCount).toBeGreaterThan(0);
    });

    it('PG 语义下 5--1 是注释 → 返回 5', async () => {
      const r = await q('SELECT 5--1');
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.rows[0][0]).toBe(5);
    });

    it("反斜杠按字面量:'\\'; DROP ... 的多语句绕过被堵(G3)", async () => {
      const r = await q("SELECT '\\'; DROP TABLE employees; --'");
      expect(r.code).toBe(2);
      expect(r.errJson!.error.category).toBe('BLOCKED_MULTI_STATEMENT');
    });
  });

  describe('资源预算(#6)', () => {
    it('500+ 行由 cursor 截断并关闭 portal', async () => {
      const r = await q('SELECT generate_series(1, 600) AS n');
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.meta.rowCount).toBe(500);
      expect(r.json!.meta.queryTruncated).toBe(true);
    });

    it('未知 FETCH 表达式仍由 cursor 有界读取', async () => {
      const r = await q('SELECT generate_series(1, 10) FETCH FIRST (1 + 1) ROWS ONLY');
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.meta.rowCount).toBeLessThanOrEqual(500);
    });

    it('超大字段被预算拒绝', async () => {
      const r = await q("SELECT repeat('x', 1048577) AS big");
      expect(r.code).toBe(1);
      expect(r.errJson!.error.message).toContain('字段超过');
    });

    it('streamed NDJSON --out 是版本化完成文件', async () => {
      const file = path.join(os.tmpdir(), 'agent-db-it-pg-' + process.pid + '.ndjson');
      try {
        const r = await queryOnce(ds, 'it-pg', 'SELECT id FROM employees ORDER BY id', ['--out', file]);
        expect(r.code, r.stderr).toBe(0);
        const records = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        expect(records[0]).toMatchObject({ contractVersion: '1.0', type: 'header' });
        expect(records.at(-1)).toMatchObject({
          contractVersion: '1.0',
          type: 'trailer',
          meta: { rowCount: r.json!.meta.rowCount, queryTruncated: false },
        });
      } finally { fs.rmSync(file, { force: true }); }
    });
  });
});
