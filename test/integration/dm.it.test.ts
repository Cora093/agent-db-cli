import { describe, it, expect } from 'vitest';
import {
  parseDbUrl,
  standardSuite,
  gatedDescribe,
  queryOnce,
  withDatasources,
  type ParsedDb,
} from './helpers.js';

/**
 * 达梦 DM 集成测试。门控 AGENT_DB_CLI_IT_DM=dm://SYSDBA:pass@host:5236。
 * DM:schema=owner、标识符折大写(故表名/夹具用大写)、自省 best-effort(indexes='N/A')。
 * 0.2.0 起经 fetchAsString 数值/日期一律文本交付(dmdb 不透出列类型,精度保真优先,A3)。
 * 夹具 schema TEST20260609 须已由一次性脚本建好。
 */
const ENV = 'AGENT_DB_CLI_IT_DM';

gatedDescribe(ENV)('integration: dm', () => {
  // env 未设时整组 skip,但 describe 回调仍会被收集 → parse 要兜底避免抛错
  const url = process.env[ENV];
  const db: ParsedDb = url ? parseDbUrl(url) : { host: '', port: 0, user: '', password: '' };
  const datasource = {
    driver: 'dm',
    host: db.host,
    port: db.port,
    schema: 'TEST20260609',
    user: db.user,
    password: db.password,
  };
  standardSuite({
    dsId: 'it-dm',
    datasource,
    employeesTable: 'EMPLOYEES',
    departmentsTable: 'DEPARTMENTS',
    empLike: '%EMP%',
    salaryTypeContains: 'decimal',
    salaryKind: 'string',
    fullIntrospection: false,
    missingTable: 'NO_SUCH_TABLE',
  });

  const ds = { 'it-dm': datasource };
  const q = (sql: string) => queryOnce(ds, 'it-dm', sql);

  it('长查询超过 --timeout 后关闭连接并返回 TIMEOUT / exit 3', async () => {
    const started = Date.now();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const timeoutQuery = withDatasources(ds, (runCli) =>
      runCli([
        'query',
        '--ds',
        'it-dm',
        'SELECT COUNT(*) FROM SYSOBJECTS A, SYSOBJECTS B, SYSOBJECTS C',
        '--timeout',
        '1',
      ]),
    );
    const watchdogFailure = new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('DM timeout watchdog exceeded 5s')), 5000);
    });

    let r;
    try {
      r = await Promise.race([timeoutQuery, watchdogFailure]);
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
    }
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.code, r.stderr).toBe(3);
    expect(r.stdout).toBe('');
    expect(JSON.parse(r.stderr.trim()).error.category).toBe('TIMEOUT');
  });

  describe('类型契约(A3/B1,dm-183 真机)', () => {
    it('数值一律文本字符串(dmdb 不透出列类型,精度优先)', async () => {
      const r = await q('SELECT ID FROM EMPLOYEES WHERE ID = 1');
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.rows[0][0]).toBe('1');
    });

    it('高精度 DECIMAL 完整保真,不再经 JS number 丢精(H1)', async () => {
      const r = await q('SELECT CAST(12345678901234567890.55 AS DECIMAL(38,2)) AS D FROM DUAL');
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.rows[0][0]).toBe('12345678901234567890.55');
    });

    it('时间按墙钟文本直传,无 Z', async () => {
      const r = await q('SELECT HIRED_AT FROM EMPLOYEES WHERE ID = 1');
      expect(r.code, r.stderr).toBe(0);
      const ts = r.json!.rows[0][0] as string;
      expect(ts).toMatch(/^2024-01-15[T ]09:00:00/);
      expect(ts.endsWith('Z')).toBe(false);
    });
  });

  describe('限行与守卫(C/D1/E,dm-183 真机)', () => {
    it('TOP n 形态直通,不再被追加 LIMIT 双限报错(H3)', async () => {
      const r = await q('SELECT TOP 2 ID, NAME FROM EMPLOYEES ORDER BY ID');
      expect(r.code, r.stderr).toBe(0);
      expect(r.json!.rows).toEqual([
        ['1', 'Alice'],
        ['2', 'Bob'],
      ]);
    });

    it('FOR UPDATE 被静态拦截 → exit 2,不再真执行(D1)', async () => {
      const r = await q('SELECT * FROM EMPLOYEES FOR UPDATE');
      expect(r.code).toBe(2);
      expect(r.errJson!.error.category).toBe('BLOCKED_LOCKING_READ');
    });

    it('DESCRIBE 实抛 [-2007] → SQL_SYNTAX / exit 1,不再 exit 0(L4)', async () => {
      const r = await q('DESCRIBE EMPLOYEES');
      expect(r.code).toBe(1);
      expect(r.errJson!.error.category).toBe('SQL_SYNTAX');
    });
  });
});
