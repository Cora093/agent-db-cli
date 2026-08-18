/**
 * 结构化错误与退出码 (§9c)。
 *
 * 退出码契约:
 *   0 成功 · 2 守卫拦截 · 3 超时 · 4 连接/认证失败 · 5 数据源不存在 · 1 其它
 *
 * 错误信息只走 stderr,不污染 stdout 的 JSON 数据通道。
 */

export type ErrorCategory =
  // —— 守卫拦截 (exit 2) ——
  | 'BLOCKED_NON_READONLY' // 首关键字不在 allowlist
  | 'BLOCKED_MULTI_STATEMENT' // 多语句
  | 'BLOCKED_FILE_WRITE' // SELECT ... INTO OUTFILE/DUMPFILE
  | 'BLOCKED_LOCKING_READ' // SELECT ... FOR UPDATE/SHARE / LOCK IN SHARE MODE
  // —— 超时 (exit 3) ——
  | 'TIMEOUT'
  // —— 连接/认证 (exit 4) ——
  | 'CONNECT'
  // —— 数据源不存在 (exit 5) ——
  | 'DATASOURCE_NOT_FOUND'
  // —— 其它 (exit 1) ——
  | 'SQL_SYNTAX'
  | 'AMBIGUOUS_TABLE'
  | 'TABLE_NOT_FOUND'
  | 'CONFIG' // 配置不存在/解析失败/字段非法
  | 'CONFIG_PERMISSION' // 权限校验失败
  | 'DRIVER_MISSING' // optional 驱动未安装(如 dmdb)
  | 'BAD_USAGE' // CLI 参数误用
  | 'NOT_READONLY' // 被 ② 只读事务拒绝的写(归 1,见 §9c 注)
  | 'INTERNAL';

const EXIT_CODES: Record<ErrorCategory, number> = {
  BLOCKED_NON_READONLY: 2,
  BLOCKED_MULTI_STATEMENT: 2,
  BLOCKED_FILE_WRITE: 2,
  BLOCKED_LOCKING_READ: 2,
  TIMEOUT: 3,
  CONNECT: 4,
  DATASOURCE_NOT_FOUND: 5,
  SQL_SYNTAX: 1,
  AMBIGUOUS_TABLE: 1,
  TABLE_NOT_FOUND: 1,
  CONFIG: 1,
  CONFIG_PERMISSION: 1,
  DRIVER_MISSING: 1,
  BAD_USAGE: 1,
  NOT_READONLY: 1,
  INTERNAL: 1,
};

export interface ErrorJSON {
  category: ErrorCategory;
  message: string;
  hint?: string;
}

/**
 * 应用级错误。所有面向用户的失败都应抛出 AppError,
 * 由 CLI 顶层统一翻译成 JSON / 文本 + 退出码。
 */
export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly hint?: string;
  /** 可选:底层原始报错(DB 驱动 / IO),用于诊断,不一定展示 */
  readonly cause?: unknown;

  constructor(category: ErrorCategory, message: string, opts: { hint?: string; cause?: unknown } = {}) {
    super(message);
    this.name = 'AppError';
    this.category = category;
    this.hint = opts.hint;
    this.cause = opts.cause;
  }

  get exitCode(): number {
    return EXIT_CODES[this.category];
  }

  toJSON(): ErrorJSON {
    const out: ErrorJSON = { category: this.category, message: this.message };
    if (this.hint) out.hint = this.hint;
    return out;
  }
}

/** 把任意 throwable 归一成 AppError(未知错误归 INTERNAL)。 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError('INTERNAL', message, { cause: err });
}
