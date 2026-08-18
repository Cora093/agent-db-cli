import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseDbUrl, standardSuite, gatedDescribe, queryOnce, type ParsedDb } from './helpers.js';

/**
 * MySQL 集成测试。门控 AGENT_DB_CLI_IT_MYSQL=mysql://user:pass@host:port。
 * 夹具命名空间 test20260609 须已由一次性脚本建好。
 */
const ENV = 'AGENT_DB_CLI_IT_MYSQL';

gatedDescribe(ENV)('integration: mysql', () => {
  // env 未设时整组 skip,但 describe 回调仍会被收集 → parse 要兜底避免抛错
  const url = process.env[ENV];
  const db: ParsedDb = url ? parseDbUrl(url) : { host: '', port: 0, user: '', password: '' };
  const datasource = {
    driver: 'mysql',
    host: db.host,
    port: db.port,
    database: 'test20260609',
    user: db.user,
    password: db.password,
  };
  standardSuite({
    dsId: 'it-mysql',
    datasource,
    employeesTable: 'employees',
    departmentsTable: 'departments',
    empLike: '%emp%',
    salaryTypeContains: 'decimal',
    salaryKind: 'string',
    fullIntrospection: true,
    missingTable: 'no_such_table',
  });

  const ds = { 'it-mysql': datasource };
  const q = (sql: string) => queryOnce(ds, 'it-mysql', sql);

  describe('类型契约(A3/B1)', () => {
    it('整数列 → number', async () => {
      const r = await q('SELECT id FROM employees WHERE id = 1');
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.rows[0][0]).toBe(1);
    });

    it('高精度 DECIMAL → 字符串完整保真', async () => {
      const r = await q("SELECT CAST('12345678901234567890.55' AS DECIMAL(38,2)) AS d");
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.rows[0][0]).toBe('12345678901234567890.55');
    });

    it('DECIMAL scale 保留(1.10 不变 1.1)', async () => {
      const r = await q("SELECT CAST('1.10' AS DECIMAL(10,2)) AS d");
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.rows[0][0]).toBe('1.10');
    });

    it('JSON 函数结果 → 原生对象(不再是 JSON 字符串)', async () => {
      const r = await q("SELECT JSON_OBJECT('a', 1, 'b', 'x') AS j");
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.rows[0][0]).toEqual({ a: 1, b: 'x' });
    });

    it('tinyint(1) 不猜 bool:is_active 仍是数字', async () => {
      const r = await q('SELECT is_active FROM employees WHERE id = 1');
      expect(r.code, r.stderr).toBe(0);
      expect(typeof r.json!.rows[0][0]).toBe('number');
    });

    it('DATE → "YYYY-MM-DD" 文本(不跨日、无时间尾巴)', async () => {
      const r = await q("SELECT CAST('2024-01-15' AS DATE) AS d");
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.rows[0][0]).toBe('2024-01-15');
    });

    it('DATETIME 字面量按墙钟文本直传,无 Z(#18)', async () => {
      const r = await q("SELECT TIMESTAMP '2024-01-15 09:00:00' AS t");
      expect(r.code, r.stderr).toBe(0);
      const ts = r.json!.rows[0][0] as string;
      expect(ts).toMatch(/^2024-01-15[T ]09:00:00/);
      expect(ts.endsWith('Z')).toBe(false);
    });
  });

  describe('守卫与词法(D1/G2/C)', () => {
    it('FOR UPDATE 被静态拦截 → exit 2', async () => {
      const r = await q('SELECT * FROM employees FOR UPDATE');
      expect(r.code).toBe(2);
      expect(r.errJson!.error.category).toBe('BLOCKED_LOCKING_READ');
    });

    it('5--1 是运算式,语义不被注释剥离篡改(G2)', async () => {
      const r = await q('SELECT 5--1');
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.rows[0][0]).toBe(6); // 5 - (-1)
    });

    it("字面量 'no limit' 不再阻断 auto-LIMIT:正常返回(L1)", async () => {
      const r = await q("SELECT name FROM employees WHERE name <> 'no limit' ORDER BY id");
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.rows.length).toBe(5);
    });

    it('SHOW/EXPLAIN/DESCRIBE 通过行事件有界读取保持可用(#6)', async () => {
      for (const sql of [
        'SHOW CREATE TABLE employees',
        'EXPLAIN SELECT * FROM employees',
        'DESCRIBE employees',
      ]) {
        const r = await q(sql);
        expect(r.code, sql + ': ' + r.stderr).toBe(0);
        expect(r.json!.meta.rowCount).toBeGreaterThan(0);
      }
    });

    it('MySQL 1054 未知列(ROWNUM)→ SQL_SYNTAX / exit 1(L13)', async () => {
      const r = await q('SELECT ROWNUM FROM employees');
      expect(r.code).toBe(1);
      expect(r.errJson!.error.category).toBe('SQL_SYNTAX');
    });
  });

  describe('资源预算(#6)', () => {
    it('500+ 行由行事件截断并停止读取', async () => {
      const r = await q('SELECT a.id FROM employees a CROSS JOIN employees b CROSS JOIN employees c CROSS JOIN employees d');
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.meta.rowCount).toBe(500);
      expect(r.json!.meta.queryTruncated).toBe(true);
    });

    it('未知 LIMIT 表达式仍由行事件有界读取', async () => {
      const r = await q('SELECT id FROM employees LIMIT 1 + 1');
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.meta.rowCount).toBeLessThanOrEqual(500);
    });

    it('超大字段被预算拒绝', async () => {
      const r = await q("SELECT REPEAT('x', 1048577) AS big");
      expect(r.code).toBe(1);
      expect(r.errJson!.error.message).toContain('字段超过');
    });

    it('streamed JSON --out 是有效完成文件', async () => {
      const file = path.join(os.tmpdir(), 'agent-db-it-mysql-' + process.pid + '.json');
      try {
        const r = await queryOnce(ds, 'it-mysql', 'SELECT id FROM employees ORDER BY id', ['--out', file]);
        expect(r.code, r.stderr).toBe(0);
        const out = JSON.parse(fs.readFileSync(file, 'utf8'));
        expect(out).toMatchObject({
          contractVersion: '1.0',
          meta: { rowCount: r.json!.meta.rowCount, queryTruncated: false },
        });
      } finally { fs.rmSync(file, { force: true }); }
    });
  });
});
