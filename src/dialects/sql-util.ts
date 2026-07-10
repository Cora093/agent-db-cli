import type { StatementKind } from '../types.js';
import type { ColKind, QueryResult } from './types.js';
import { normalizeValue } from './normalize.js';

/**
 * runReadOnly 共享尾段(R2):截断判定 + 按 ColKind 逐列归一化 + 计时。
 * rawRows 由调用方按 limit+1 取回;start 为查询起始时刻(Date.now())。
 */
export function mapRows(
  rawRows: unknown[][],
  columns: string[],
  kinds: ColKind[],
  limit: number,
  start: number,
): QueryResult {
  const truncated = rawRows.length > limit;
  const data = truncated ? rawRows.slice(0, limit) : rawRows;
  const rows = data.map((r) => r.map((v, i) => normalizeValue(v, kinds[i])));
  return { columns, rows, truncated, ms: Date.now() - start };
}

/**
 * 行数硬顶的 LIMIT 改写(§9b/C)。仅对 SELECT/WITH 生效;
 * SHOW/EXPLAIN/DESCRIBE 结果天生小,直接缓冲不改写。
 *
 * 采用「夹紧尾部已有 LIMIT/FETCH 或追加」策略(而非子查询包裹),
 * 以免破坏返回重名列的探索式 SELECT(如 SELECT a.*, b.*)。
 *
 * 检测一律在「字面量遮罩副本」上做(等长,引号内容置空):
 * 消除 'no limit' / 'top 10' 之类字面量误判导致的不夹/误夹(C/L1)。
 * 开头 TOP n、ROWNUM 形态(DM 等)已被引擎限行,跳过追加避免双限语法错。
 *
 * 已知边界(③ 非安全边界):子查询独占 LIMIT 不被外层夹紧;
 * 真兜底是 ② 只读事务 + 服务端超时 + DM maxRows + 取回后 JS 端 ≤limit 截断。
 *
 * cap 即写入 SQL 的上限值(调用方通常传 limit+1 以判 truncated)。
 */
export function applyLimit(sql: string, kind: StatementKind, cap: number): string {
  if (kind !== 'select' && kind !== 'with') return sql;

  const masked = maskLiterals(sql);
  const clamp = (n: string) => String(Math.min(Number(n), cap));

  // 在 masked 上找匹配,按位置改回原 SQL(遮罩等长;命中区在字面量外,与原文相同)
  const rewrite = (re: RegExp, build: (m: RegExpExecArray) => string): string | null => {
    const m = re.exec(masked);
    if (!m) return null;
    return sql.slice(0, m.index) + build(m) + sql.slice(m.index + m[0].length);
  };

  // MySQL: LIMIT offset, count —— 只夹 count
  let out = rewrite(/(\blimit\s+\d+\s*,\s*)(\d+)(\s*)$/i, (m) => m[1] + clamp(m[2]) + m[3]);
  if (out !== null) return out;

  // PG: OFFSET n LIMIT count
  out = rewrite(/(\boffset\s+\d+\s+limit\s+)(\d+)(\s*)$/i, (m) => m[1] + clamp(m[2]) + m[3]);
  if (out !== null) return out;

  // LIMIT count [OFFSET n]
  out = rewrite(/(\blimit\s+)(\d+)((?:\s+offset\s+\d+)?\s*)$/i, (m) => m[1] + clamp(m[2]) + m[3]);
  if (out !== null) return out;

  // LIMIT ALL → 强制为 cap
  out = rewrite(/(\blimit\s+)all(\s*)$/i, (m) => m[1] + cap + m[2]);
  if (out !== null) return out;

  // 标准 FETCH FIRST|NEXT n ROWS ONLY/WITH TIES → 夹 n(超大 FETCH 同样会缓冲爆内存)
  out = rewrite(
    /(\bfetch\s+(?:first|next)\s+)(\d+)(\s+rows?\s+(?:only|with\s+ties)\s*)$/i,
    (m) => m[1] + clamp(m[2]) + m[3],
  );
  if (out !== null) return out;

  // 开头 TOP n(DM/SQLServer 风格)已限行,追加 LIMIT 会双限语法错 → 不动
  if (/^[\s(]*select\s+(?:distinct\s+|all\s+)?top\s+\d+\b/i.test(masked)) return sql;

  // ROWNUM 形态(DM/Oracle 风格)已限行 → 不动
  if (/\browid\b|\brownum\b/i.test(masked)) return sql;

  // 尾部是未识别的 LIMIT/FETCH 形态 → 不追加,避免双 LIMIT 语法错
  if (/\blimit\b[^)]*$/i.test(masked) || /\bfetch\s+(first|next)\b[^)]*$/i.test(masked)) {
    return sql;
  }

  // 其余(无界 SELECT,或仅尾部 OFFSET/ORDER BY 等)→ 追加
  return `${sql} LIMIT ${cap}`;
}

/**
 * 字面量遮罩(等长):引号内的内容替换为空格,引号本身保留。
 * 支持 '' 双写转义与 \ 反斜杠转义(MySQL 风格)。仅供检测,不用于执行。
 */
function maskLiterals(sql: string): string {
  let out = '';
  type Quote = "'" | '"' | '`';
  let quote: Quote | null = null;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (quote) {
      if (ch === '\\' && quote !== '`') {
        out += ' ';
        if (next !== undefined) {
          out += ' ';
          i++;
        }
        continue;
      }
      if (ch === quote) {
        if (next === quote) {
          out += '  ';
          i++;
          continue;
        }
        quote = null;
        out += ch;
        continue;
      }
      out += ' ';
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch as Quote;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}
