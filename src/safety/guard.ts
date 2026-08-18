import { AppError } from '../errors.js';
import type { DriverName, StatementKind } from '../types.js';
import { getDriverDescriptor, type LexProfile } from '../dialects/descriptors.js';

export interface GuardResult {
  /** 净化后(注释剥离、结尾分号去除)待执行的 SQL */
  sql: string;
  kind: StatementKind;
}

/** 首关键字 allowlist(§7)。值为对应的 StatementKind。 */
const ALLOWED_FIRST: Record<string, StatementKind> = {
  SELECT: 'select',
  WITH: 'with',
  SHOW: 'show',
  EXPLAIN: 'explain',
  DESCRIBE: 'describe',
  DESC: 'describe',
};

const OUTFILE_RE = /\binto\s+(outfile|dumpfile)\b/i;

/** 锁读子句:PG/MySQL 的 FOR UPDATE/SHARE 变体 + MySQL 遗留 LOCK IN SHARE MODE。 */
const LOCKING_RE = /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b|\block\s+in\s+share\s+mode\b/i;

interface Statement {
  /** 注释已剥离、字符串内容保留 —— 用于执行 */
  exec: string;
  /** 注释已剥离、字符串/标识符内容置空 —— 用于关键字与黑名单扫描 */
  masked: string;
}

function lexFor(driver: DriverName): LexProfile {
  return getDriverDescriptor(driver).lex;
}

/**
 * SQL 守卫(§7 层 ③,防呆非安全边界):
 *   按方言去注释 → 引号感知拒多语句 → 首关键字 allowlist
 *   → INTO OUTFILE / 锁读特例黑名单。
 *
 * 仍执行 sanitize 后的串(非 raw),保留对 MySQL `/*! *​/` 可执行注释的中和;
 * sanitize 已按引擎词法对齐,不再发生语义篡改(G1/G2)。
 * 真边界永远是 ①只读账号 + ②只读事务;此处只做早拦 + 友好报错。
 */
export function guardSql(rawSql: string, driver: DriverName): GuardResult {
  const statements = scan(rawSql, lexFor(driver));

  if (statements.length === 0) {
    throw new AppError('BAD_USAGE', 'SQL 为空', { hint: '提供一条 SELECT/SHOW/EXPLAIN/DESCRIBE 查询' });
  }
  if (statements.length > 1) {
    throw new AppError('BLOCKED_MULTI_STATEMENT', '只允许单条语句,检测到多语句', {
      hint: '一次只发一条查询;不要用 ; 串多条',
    });
  }

  const stmt = statements[0];
  const keyword = firstKeyword(stmt.masked);
  const kind = keyword ? ALLOWED_FIRST[keyword] : undefined;

  if (!kind) {
    throw new AppError(
      'BLOCKED_NON_READONLY',
      `仅允许 SELECT/WITH/SHOW/EXPLAIN/DESCRIBE。收到: ${keyword ?? '(无法识别)'}`,
      { hint: '本工具只读;改写为只读查询' },
    );
  }

  // INTO OUTFILE/DUMPFILE:在 masked 上扫描,避开字符串内的同名文本
  if ((kind === 'select' || kind === 'with') && OUTFILE_RE.test(stmt.masked)) {
    throw new AppError('BLOCKED_FILE_WRITE', '禁止 SELECT ... INTO OUTFILE/DUMPFILE(写文件)', {
      hint: '本工具不导出到服务器文件;用 --out 落到本地',
    });
  }

  // 锁读(D1):任意位置命中即拦(含子查询/CTE);masked 上扫描免误伤字符串字面量
  if ((kind === 'select' || kind === 'with') && LOCKING_RE.test(stmt.masked)) {
    throw new AppError('BLOCKED_LOCKING_READ', '禁止锁读 FOR UPDATE / FOR SHARE / LOCK IN SHARE MODE', {
      hint: '本工具只读;去掉锁子句',
    });
  }

  return { sql: stmt.exec, kind };
}

/**
 * 单遍扫描:按词法配置剥注释、按顶层分号切分、并生成 masked 版本。
 * 引号感知:字符串/标识符内的注释符与分号不生效;
 * 转义按方言:'' 双写恒支持,\ 反斜杠仅 MySQL 族,$tag$ 仅 PG。
 *
 * 已知取舍(防呆边界,② 兜底):
 *   - MySQL `/*! ... *​/` 可执行注释按普通块注释剥离(安全优先)。
 */
function scan(raw: string, lex: LexProfile): Statement[] {
  const statements: Statement[] = [];
  let exec = '';
  let masked = '';

  type Quote = "'" | '"' | '`';
  let quote: Quote | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  /** 当前 dollar-quote 的完整定界符(如 '$$'、'$tag$');null=不在其中 */
  let dollarTag: string | null = null;

  const pushBoth = (ch: string) => {
    exec += ch;
    masked += ch;
  };

  const flush = () => {
    const e = exec.trim();
    if (e.length > 0) statements.push({ exec: e, masked: masked.trim() });
    exec = '';
    masked = '';
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];

    // —— 注释状态 ——
    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        pushBoth('\n'); // 保留换行作为分隔,避免拼词
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
        pushBoth(' '); // 注释整体折叠为一个空格
      }
      continue;
    }

    // —— dollar-quote 字符串状态(PG)——
    if (dollarTag) {
      if (ch === '$' && raw.startsWith(dollarTag, i)) {
        exec += dollarTag;
        masked += dollarTag; // masked 里只留定界符,内容置空(分号不触发切分)
        i += dollarTag.length - 1;
        dollarTag = null;
        continue;
      }
      exec += ch; // 内容原样保留,供执行
      continue;
    }

    // —— 字符串状态 ——
    if (quote) {
      exec += ch; // 字符串内容原样保留,供执行
      // 反斜杠转义(仅 MySQL 族;PG/DM 反斜杠是普通字符):跳过下一字符
      if (lex.backslashEscape && ch === '\\' && quote !== '`') {
        if (next !== undefined) {
          exec += next;
          i++;
        }
        continue;
      }
      if (ch === quote) {
        // 双写转义:'' "" `` 仍在串内
        if (next === quote) {
          exec += next;
          i++;
          continue;
        }
        // 关闭字符串
        masked += quote; // masked 里只留下空的引号对
        quote = null;
        continue;
      }
      // 普通串内字符:masked 不追加(置空内容)
      continue;
    }

    // —— 顶层(非串非注释) ——
    // 注释起始
    if (ch === '-' && next === '-') {
      const after = raw[i + 2];
      if (!lex.dashNeedsWhitespace || after === undefined || /\s/.test(after)) {
        inLineComment = true;
        i++;
        continue;
      }
      // MySQL/DM:`5--1` 里的 -- 是运算符,不是注释
      pushBoth(ch);
      continue;
    }
    if (lex.hashComment && ch === '#') {
      inLineComment = true;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    // dollar-quote 起始(PG):$$ 或 $tag$
    if (lex.dollarQuote && ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(raw.slice(i));
      if (m) {
        dollarTag = m[0];
        exec += dollarTag;
        masked += dollarTag;
        i += dollarTag.length - 1;
        continue;
      }
    }

    // 字符串/标识符起始
    if (ch === "'" || ch === '"' || (lex.backtickQuote && ch === '`')) {
      quote = ch as Quote;
      exec += ch;
      masked += ch; // 开引号入 masked,内容置空
      continue;
    }

    // 顶层语句分隔符
    if (ch === ';') {
      flush();
      continue;
    }

    pushBoth(ch);
  }

  flush();
  return statements;
}

/** 跳过前导空白与左括号,取首个字母关键字(大写)。 */
function firstKeyword(masked: string): string | null {
  let i = 0;
  while (i < masked.length && (/\s/.test(masked[i]) || masked[i] === '(')) i++;
  let word = '';
  while (i < masked.length && /[A-Za-z]/.test(masked[i])) {
    word += masked[i];
    i++;
  }
  return word ? word.toUpperCase() : null;
}
