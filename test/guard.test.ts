import { describe, it, expect } from 'vitest';
import { guardSql } from '../src/safety/guard.js';
import { AppError, type ErrorCategory } from '../src/errors.js';

function category(sql: string, driver: 'mysql' | 'postgres' | 'dm'): ErrorCategory | 'OK' {
  try {
    guardSql(sql, driver);
    return 'OK';
  } catch (e) {
    if (e instanceof AppError) return e.category;
    throw e;
  }
}

describe('guardSql — 放行 (§7 allowlist)', () => {
  it('SELECT 放行,kind=select', () => {
    expect(guardSql('SELECT 1', 'mysql')).toEqual({ sql: 'SELECT 1', kind: 'select' });
  });

  it('大小写无关', () => {
    expect(guardSql('select * from t where x=1', 'mysql').kind).toBe('select');
  });

  it('首尾空白被裁剪', () => {
    expect(guardSql('   SELECT 1   ', 'mysql').sql).toBe('SELECT 1');
  });

  it('去除结尾分号(单语句仍放行)', () => {
    expect(guardSql('SELECT 1;', 'mysql')).toEqual({ sql: 'SELECT 1', kind: 'select' });
  });

  it('WITH ... SELECT → kind=with', () => {
    const r = guardSql('WITH x AS (SELECT 1) SELECT * FROM x', 'mysql');
    expect(r.kind).toBe('with');
  });

  it('SHOW / EXPLAIN / DESCRIBE / DESC 放行', () => {
    expect(guardSql('SHOW TABLES', 'mysql').kind).toBe('show');
    expect(guardSql('EXPLAIN SELECT 1', 'mysql').kind).toBe('explain');
    expect(guardSql('DESCRIBE t', 'mysql').kind).toBe('describe');
    expect(guardSql('DESC t', 'mysql').kind).toBe('describe');
  });

  it('EXPLAIN ANALYZE INSERT 由守卫放行(交 ② 只读事务挡)', () => {
    expect(guardSql('EXPLAIN ANALYZE INSERT INTO t VALUES (1)', 'mysql').kind).toBe('explain');
  });

  it('前导括号不影响首关键字识别', () => {
    expect(guardSql('(SELECT 1)', 'mysql').kind).toBe('select');
    expect(guardSql('  ((SELECT 1 UNION SELECT 2))', 'mysql').kind).toBe('select');
  });
});

describe('guardSql — 注释处理', () => {
  it('行注释 -- 被剥离,仍识别 SELECT', () => {
    expect(guardSql('-- pick one\nSELECT 1', 'mysql').kind).toBe('select');
  });

  it('块注释在关键字前被剥离', () => {
    expect(guardSql('/* hello */ SELECT 1', 'mysql').kind).toBe('select');
  });

  it('注释里的分号不算多语句', () => {
    expect(category('SELECT 1 /* ; DROP TABLE t */', 'mysql')).toBe('OK');
  });

  it('注释里的 DROP 不改变首关键字', () => {
    expect(guardSql('SELECT 1 -- ; DROP TABLE t', 'mysql').kind).toBe('select');
  });
});

describe('guardSql — 引号感知', () => {
  it('字符串里的分号不算多语句', () => {
    expect(category("SELECT 'a; b' AS s", 'mysql')).toBe('OK');
  });

  it('字符串里的 outfile 不触发文件写拦截', () => {
    expect(category("SELECT 'into outfile xx' AS s", 'mysql')).toBe('OK');
  });

  it('双引号标识符里的分号被保护', () => {
    expect(category('SELECT "a;b" FROM t', 'mysql')).toBe('OK');
  });
});

describe('guardSql — 拦截非只读首关键字 (exit 2)', () => {
  for (const sql of [
    'UPDATE t SET x=1',
    'INSERT INTO t VALUES (1)',
    'DELETE FROM t',
    'REPLACE INTO t VALUES (1)',
    'DROP TABLE t',
    'CREATE TABLE t (a int)',
    'ALTER TABLE t ADD c int',
    'TRUNCATE t',
    'RENAME TABLE a TO b',
    'GRANT SELECT ON x TO y',
    'REVOKE SELECT ON x FROM y',
    'CALL my_proc()',
    'COMMIT',
    'ROLLBACK',
    'BEGIN',
    'START TRANSACTION',
    'LOCK TABLES t READ',
    'FLUSH PRIVILEGES',
    'KILL 1',
  ]) {
    it(`拦截: ${sql}`, () => {
      expect(category(sql, 'mysql')).toBe('BLOCKED_NON_READONLY');
    });
  }
});

describe('guardSql — 多语句拦截 (exit 2)', () => {
  it('SELECT; DROP 被拦', () => {
    expect(category('SELECT 1; DROP TABLE t', 'mysql')).toBe('BLOCKED_MULTI_STATEMENT');
  });

  it('两条 SELECT 也算多语句', () => {
    expect(category('SELECT 1; SELECT 2', 'mysql')).toBe('BLOCKED_MULTI_STATEMENT');
  });

  it('引号内分号后接真实第二语句被拦', () => {
    expect(category("SELECT 'x'; DROP TABLE t", 'mysql')).toBe('BLOCKED_MULTI_STATEMENT');
  });

  it('结尾多个空分号不算多语句', () => {
    expect(category('SELECT 1 ; ; ', 'mysql')).toBe('OK');
  });
});

describe('guardSql — INTO OUTFILE/DUMPFILE 特例黑名单 (exit 2)', () => {
  it('SELECT ... INTO OUTFILE 被拦', () => {
    expect(category("SELECT * INTO OUTFILE '/tmp/x' FROM t", 'mysql')).toBe('BLOCKED_FILE_WRITE');
  });

  it('SELECT ... INTO DUMPFILE 被拦', () => {
    expect(category("SELECT a INTO DUMPFILE '/tmp/x' FROM t", 'mysql')).toBe('BLOCKED_FILE_WRITE');
  });

  it('大小写无关', () => {
    expect(category("select 1 into outfile '/x'", 'mysql')).toBe('BLOCKED_FILE_WRITE');
  });
});

describe('guardSql — 锁读拦截 (D1, exit 2)', () => {
  for (const sql of [
    'SELECT * FROM t FOR UPDATE',
    'SELECT * FROM t WHERE id = 1 FOR UPDATE NOWAIT',
    'SELECT * FROM t FOR SHARE',
    'SELECT * FROM t FOR NO KEY UPDATE',
    'SELECT * FROM t FOR KEY SHARE',
    'SELECT * FROM t LOCK IN SHARE MODE',
    'select * from t for update',
    'WITH x AS (SELECT * FROM t FOR UPDATE) SELECT * FROM x',
    'SELECT * FROM (SELECT id FROM t FOR UPDATE) s',
  ]) {
    it(`拦截: ${sql}`, () => {
      expect(category(sql, 'mysql')).toBe('BLOCKED_LOCKING_READ');
    });
  }

  it("不误伤:字符串字面量 'for update'", () => {
    expect(category("SELECT * FROM t WHERE note = 'for update'", 'mysql')).toBe('OK');
  });

  it("不误伤:字符串字面量 'lock in share mode'", () => {
    expect(category("SELECT 'lock in share mode' AS s", 'mysql')).toBe('OK');
  });

  it('不误伤:列名 for_update_flag', () => {
    expect(category('SELECT for_update_flag FROM t', 'mysql')).toBe('OK');
  });

  it('不误伤:反引号标识符 `for`', () => {
    expect(category('SELECT `for` FROM t', 'mysql')).toBe('OK');
  });
});

describe('guardSql — 词法方言化 (G)', () => {
  it("PG:'#' 是运算符不是注释,#>> 不被剪掉(G1)", () => {
    const r = guardSql(`SELECT data #>> '{a,b}' FROM t`, 'postgres');
    expect(r.sql).toBe(`SELECT data #>> '{a,b}' FROM t`);
  });

  it.each(['mysql', 'doris', 'starrocks', 'tidb', 'oceanbase'] as const)(
    "%s descriptor 使用 MySQL '#' 行注释词法",
    (driver) => expect(guardSql('SELECT 1 # trailing\n', driver).sql).toBe('SELECT 1'),
  );

  it('MySQL:5--1 是运算式不是注释,语义不被篡改(G2)', () => {
    const r = guardSql('SELECT 5--1', 'mysql');
    expect(r.sql).toBe('SELECT 5--1');
  });

  it('MySQL:-- 后随空白才是注释', () => {
    const r = guardSql('SELECT 1 -- comment\n', 'mysql');
    expect(r.sql).toBe('SELECT 1');
  });

  it('PG:-- 任意后随都是注释', () => {
    const r = guardSql('SELECT 5--1\n', 'postgres');
    expect(r.sql).toBe('SELECT 5');
  });

  it('PG:dollar-quote 是字符串,内部分号不算多语句(G4)', () => {
    const r = guardSql('SELECT $$a;b$$ AS s', 'postgres');
    expect(r.sql).toBe('SELECT $$a;b$$ AS s');
    expect(r.kind).toBe('select');
  });

  it('PG:$tag$..$tag$ 形式同样支持', () => {
    const r = guardSql('SELECT $x$ ; drop table t; $x$ AS s', 'postgres');
    expect(r.kind).toBe('select');
  });

  it('PG:dollar-quote 内的 for update 不触发锁读拦截', () => {
    expect(guardSql('SELECT $$for update$$ AS s', 'postgres').kind).toBe('select');
  });

  it("PG:反斜杠是普通字符,'\\'; DROP ... 的多语句绕过被堵(G3)", () => {
    // standard_conforming_strings 下 '\' 是单字符字符串,后面的 ; DROP 是第二条语句
    expect(() => guardSql("SELECT '\\'; DROP TABLE t; --'", 'postgres')).toThrowError(
      expect.objectContaining({ category: 'BLOCKED_MULTI_STATEMENT' }),
    );
  });

  it("MySQL:反斜杠转义仍生效,'\\'' 在串内不切语句", () => {
    expect(guardSql("SELECT 'it\\'s; fine' AS s", 'mysql').kind).toBe('select');
  });

  it('DM:无 # 注释(# 是普通字符不致剪损)', () => {
    const r = guardSql('SELECT a# FROM t', 'dm');
    expect(r.sql).toBe('SELECT a# FROM t');
  });

});

describe('guardSql — 空输入', () => {
  it('空串 → BAD_USAGE', () => {
    expect(category('', 'mysql')).toBe('BAD_USAGE');
  });
  it('纯空白 → BAD_USAGE', () => {
    expect(category('   \n  ', 'mysql')).toBe('BAD_USAGE');
  });
  it('纯注释 → BAD_USAGE', () => {
    expect(category('-- nothing here', 'mysql')).toBe('BAD_USAGE');
  });
});
