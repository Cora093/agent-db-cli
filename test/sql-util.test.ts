import { describe, it, expect } from 'vitest';
import { applyLimit, createRowCollector } from '../src/dialects/sql-util.js';

describe('applyLimit (§9b 500 硬顶 / LIMIT 501 改写)', () => {
  it('SELECT 无 LIMIT → 追加', () => {
    expect(applyLimit('SELECT 1', 'select', 501)).toBe('SELECT 1 LIMIT 501');
  });

  it('SELECT 带 ORDER BY 无 LIMIT → 追加在末尾', () => {
    expect(applyLimit('SELECT * FROM t ORDER BY id', 'select', 501)).toBe(
      'SELECT * FROM t ORDER BY id LIMIT 501',
    );
  });

  it('WITH ... SELECT → 追加', () => {
    expect(applyLimit('WITH x AS (SELECT 1) SELECT * FROM x', 'with', 501)).toBe(
      'WITH x AS (SELECT 1) SELECT * FROM x LIMIT 501',
    );
  });

  it('用户 LIMIT 小于 cap → 保留', () => {
    expect(applyLimit('SELECT 1 LIMIT 10', 'select', 501)).toBe('SELECT 1 LIMIT 10');
  });

  it('用户 LIMIT 大于 cap → 夹到 cap', () => {
    expect(applyLimit('SELECT 1 LIMIT 1000', 'select', 501)).toBe('SELECT 1 LIMIT 501');
  });

  it('大小写不敏感,保留原关键字大小写', () => {
    expect(applyLimit('SELECT 1 limit 1000', 'select', 501)).toBe('SELECT 1 limit 501');
  });

  it('MySQL offset, count 形式只夹 count', () => {
    expect(applyLimit('SELECT 1 LIMIT 5, 1000', 'select', 501)).toBe('SELECT 1 LIMIT 5, 501');
    expect(applyLimit('SELECT 1 LIMIT 5, 10', 'select', 501)).toBe('SELECT 1 LIMIT 5, 10');
  });

  it('PG LIMIT count OFFSET n', () => {
    expect(applyLimit('SELECT 1 LIMIT 1000 OFFSET 20', 'select', 501)).toBe(
      'SELECT 1 LIMIT 501 OFFSET 20',
    );
  });

  it('PG OFFSET n LIMIT count', () => {
    expect(applyLimit('SELECT 1 OFFSET 20 LIMIT 1000', 'select', 501)).toBe(
      'SELECT 1 OFFSET 20 LIMIT 501',
    );
  });

  it('LIMIT ALL → 替换为 cap', () => {
    expect(applyLimit('SELECT 1 LIMIT ALL', 'select', 501)).toBe('SELECT 1 LIMIT 501');
  });

  it('子查询里的 LIMIT 不算外层 → 仍追加外层 LIMIT', () => {
    expect(applyLimit('SELECT * FROM (SELECT a FROM t LIMIT 5) s', 'select', 501)).toBe(
      'SELECT * FROM (SELECT a FROM t LIMIT 5) s LIMIT 501',
    );
  });

  it('尾部 OFFSET(无 LIMIT)→ 追加 LIMIT', () => {
    expect(applyLimit('SELECT 1 OFFSET 5', 'select', 501)).toBe('SELECT 1 OFFSET 5 LIMIT 501');
  });

  it('FETCH FIRST 不解析也不破坏(保持原样)', () => {
    const sql = 'SELECT 1 FETCH FIRST 10 ROWS ONLY';
    expect(applyLimit(sql, 'select', 501)).toBe(sql);
  });

  it('SHOW / EXPLAIN / DESCRIBE 不改写', () => {
    expect(applyLimit('SHOW TABLES', 'show', 501)).toBe('SHOW TABLES');
    expect(applyLimit('EXPLAIN SELECT 1', 'explain', 501)).toBe('EXPLAIN SELECT 1');
    expect(applyLimit('DESCRIBE t', 'describe', 501)).toBe('DESCRIBE t');
  });
});

describe('applyLimit — 加固(C:字面量遮罩 / 超大界夹紧 / TOP/ROWNUM 跳过)', () => {
  it("字面量 'no limit' 不再误判 → 仍追加(L1 OOM 路径闭合)", () => {
    expect(applyLimit("SELECT * FROM t WHERE note = 'no limit'", 'select', 501)).toBe(
      "SELECT * FROM t WHERE note = 'no limit' LIMIT 501",
    );
  });

  it("字面量 'LIMIT 5' 不当作已有 LIMIT → 追加", () => {
    expect(applyLimit("SELECT 'limit 5' AS s", 'select', 501)).toBe(
      "SELECT 'limit 5' AS s LIMIT 501",
    );
  });

  it("字面量 'fetch first' 不误判 → 追加", () => {
    expect(applyLimit("SELECT 'fetch first 10 rows only' AS s", 'select', 501)).toBe(
      "SELECT 'fetch first 10 rows only' AS s LIMIT 501",
    );
  });

  it('FETCH FIRST 超大 n → 夹到 cap', () => {
    expect(applyLimit('SELECT 1 FETCH FIRST 1000000 ROWS ONLY', 'select', 501)).toBe(
      'SELECT 1 FETCH FIRST 501 ROWS ONLY',
    );
    expect(applyLimit('SELECT 1 FETCH NEXT 1000 ROWS WITH TIES', 'select', 501)).toBe(
      'SELECT 1 FETCH NEXT 501 ROWS WITH TIES',
    );
  });

  it('FETCH FIRST 小于 cap → 保留', () => {
    const sql = 'SELECT 1 FETCH FIRST 10 ROWS ONLY';
    expect(applyLimit(sql, 'select', 501)).toBe(sql);
  });

  it('开头 TOP n(DM)→ 跳过追加,避免双限语法错(H3/M10)', () => {
    expect(applyLimit('SELECT TOP 10 * FROM t', 'select', 501)).toBe('SELECT TOP 10 * FROM t');
    expect(applyLimit('select distinct top 5 a from t', 'select', 501)).toBe(
      'select distinct top 5 a from t',
    );
    expect(applyLimit('(SELECT TOP 3 a FROM t)', 'select', 501)).toBe('(SELECT TOP 3 a FROM t)');
  });

  it("字面量 'top 10' 不触发 TOP 跳过 → 仍追加", () => {
    expect(applyLimit("SELECT 'top 10' AS s", 'select', 501)).toBe("SELECT 'top 10' AS s LIMIT 501");
  });

  it('ROWNUM 形态(DM/Oracle)→ 跳过追加', () => {
    const sql = 'SELECT * FROM t WHERE ROWNUM <= 10';
    expect(applyLimit(sql, 'select', 501)).toBe(sql);
  });

  it("反斜杠转义字面量内的 limit 不误判:仍追加", () => {
    expect(applyLimit("SELECT * FROM t WHERE a = 'it\\'s no limit'", 'select', 501)).toBe(
      "SELECT * FROM t WHERE a = 'it\\'s no limit' LIMIT 501",
    );
  });

  it("'' 双写转义内的 limit 不误判:仍追加", () => {
    expect(applyLimit("SELECT * FROM t WHERE a = 'it''s no limit'", 'select', 501)).toBe(
      "SELECT * FROM t WHERE a = 'it''s no limit' LIMIT 501",
    );
  });

  it('字面量外的真 LIMIT 照常夹紧(遮罩不影响正常路径)', () => {
    expect(applyLimit("SELECT 'x' AS s LIMIT 99999", 'select', 501)).toBe(
      "SELECT 'x' AS s LIMIT 501",
    );
  });
});

describe('createRowCollector (R2 共享尾段:截断 + ColKind 归一化)', () => {
  it('行数 ≤ limit:不截断,按 kind 归一化', () => {
    const collector = createRowCollector(
      ['id', 'salary', 'meta'],
      ['int', 'decimal', 'json'],
      500,
      Date.now(),
    );
    expect(collector.add(['1', '12000.50', '{"a":1}'])).toBe(true);
    expect(collector.add(['2', '9000.00', null])).toBe(true);

    const result = collector.finish();
    expect(result.truncated).toBe(false);
    expect(result.rows).toEqual([
      [1, '12000.50', { a: 1 }],
      [2, '9000.00', null],
    ]);
    expect(result.columns).toEqual(['id', 'salary', 'meta']);
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it('行数 > limit:截到 limit 并标 truncated', () => {
    const collector = createRowCollector(['n'], ['int'], 5, Date.now());
    for (let i = 0; i < 5; i++) expect(collector.add([String(i)])).toBe(true);
    expect(collector.add(['5'])).toBe(false);

    const result = collector.finish();
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(5);
    expect(result.rows[0]).toEqual([0]);
  });

  it('kinds 缺位的列走默认逻辑', () => {
    const collector = createRowCollector(['a', 'b'], ['other'], 10, Date.now());
    expect(collector.add(['x', 42])).toBe(true);
    expect(collector.finish().rows[0]).toEqual(['x', 42]);
  });
});
