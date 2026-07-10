import { AppError, type ErrorCategory } from '../errors.js';

/** 出错阶段:连接期的超时/未知错误归 CONNECT,执行期才可能是查询超时(E1/E2)。 */
export type DbPhase = 'connect' | 'run';

interface DriverError {
  code?: string;
  errno?: number;
  message?: string;
}

/** 类别 → 统一的消息/hint 模板(表驱动,消重 R1)。 */
function appErr(category: ErrorCategory, msg: string, err: unknown): AppError {
  switch (category) {
    case 'TIMEOUT':
      return new AppError('TIMEOUT', '查询超时被中断', {
        hint: '加 WHERE/LIMIT 收窄,或调大 --timeout',
        cause: err,
      });
    case 'NOT_READONLY':
      return new AppError('NOT_READONLY', `被只读事务拒绝: ${msg}`, { cause: err });
    case 'SQL_SYNTAX':
      return new AppError('SQL_SYNTAX', msg, { cause: err });
    case 'CONNECT':
      return new AppError('CONNECT', `连接/认证失败: ${msg}`, { cause: err });
    default:
      return new AppError('INTERNAL', msg, { cause: err });
  }
}

// —— MySQL(mysql2:server errno / 驱动 code)——
const MYSQL_ERRNO_CATEGORIES: Record<number, ErrorCategory> = {
  3024: 'TIMEOUT', // ER_QUERY_TIMEOUT(max_execution_time)
  1792: 'NOT_READONLY',
  1064: 'SQL_SYNTAX', // 语法错
  1054: 'SQL_SYNTAX', // 未知列(如 MySQL 上写了 ROWNUM)
  1146: 'SQL_SYNTAX', // 表不存在
  1045: 'CONNECT', // 认证拒绝
  1049: 'CONNECT', // 未知数据库
};
const MYSQL_CODE_CATEGORIES: Record<string, ErrorCategory> = {
  ER_QUERY_TIMEOUT: 'TIMEOUT',
  PROTOCOL_SEQUENCE_TIMEOUT: 'TIMEOUT',
  ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION: 'NOT_READONLY',
  ER_PARSE_ERROR: 'SQL_SYNTAX',
  ER_BAD_FIELD_ERROR: 'SQL_SYNTAX',
  ER_NO_SUCH_TABLE: 'SQL_SYNTAX',
  ER_ACCESS_DENIED_ERROR: 'CONNECT',
};

/** 把 mysql2 错误归类为 AppError(§9c)。 */
export function classifyMysqlError(err: unknown, phase: DbPhase = 'run'): AppError {
  const e = err as DriverError;
  const msg = e.message ?? String(err);

  // 连接期 ETIMEDOUT 是「连不上」而非「查询超时」(E1);执行期保持 TIMEOUT
  if (e.code === 'ETIMEDOUT') {
    return appErr(phase === 'connect' ? 'CONNECT' : 'TIMEOUT', msg, err);
  }
  if (isConnError(e)) return appErr('CONNECT', msg, err);

  const cat =
    (e.errno !== undefined ? MYSQL_ERRNO_CATEGORIES[e.errno] : undefined) ??
    (e.code !== undefined ? MYSQL_CODE_CATEGORIES[e.code] : undefined);
  if (cat) return appErr(cat, msg, err);

  // 连接期无法识别的失败(握手/网络栈各种形状)一律归 CONNECT
  return appErr(phase === 'connect' ? 'CONNECT' : 'INTERNAL', msg, err);
}

// —— PostgreSQL(SQLSTATE)——
const PG_SQLSTATE_CATEGORIES: Record<string, ErrorCategory> = {
  '57014': 'TIMEOUT', // query_canceled(statement_timeout)
  '25006': 'NOT_READONLY', // read_only_sql_transaction
  '42601': 'SQL_SYNTAX',
  '28P01': 'CONNECT',
  '28000': 'CONNECT',
  '3D000': 'CONNECT',
};

/** 把 pg 错误归类为 AppError(SQLSTATE)。 */
export function classifyPgError(err: unknown, phase: DbPhase = 'run'): AppError {
  const e = err as DriverError;
  const msg = e.message ?? String(err);

  if (isConnError(e)) return appErr('CONNECT', msg, err);

  const cat = e.code !== undefined ? PG_SQLSTATE_CATEGORIES[e.code] : undefined;
  if (cat) return appErr(cat, msg, err);

  // 连接期超时('timeout expired')等无 SQLSTATE 的失败 → CONNECT(E2),不再误判 INTERNAL
  return appErr(phase === 'connect' ? 'CONNECT' : 'INTERNAL', msg, err);
}

// —— 达梦 DM(dmdb 把错误码嵌在 message 形如 `[-6506] ...`,无独立 code/errno)——
const DM_CODE_CATEGORIES: Record<string, ErrorCategory> = {
  '-2007': 'SQL_SYNTAX', // 语法分析出错
  '-6506': 'NOT_READONLY', // 试图在只读事务中修改数据
  '-2501': 'CONNECT', // 用户名或密码错误
  '6001': 'CONNECT', // 网络通信异常
  '6071': 'CONNECT', // 消息加密失败(专有 hint 在上游分支)
};

/**
 * DM 错误归类(§14 真机校正):先抽消息里的 `[码]` 数字查表,文本匹配仅兜底。
 */
export function classifyDmError(err: unknown, phase: DbPhase = 'run'): AppError {
  const e = err as DriverError;
  const msg = e.message ?? String(err);
  const low = msg.toLowerCase();

  // 通信加密失败([6071]):新版 Node(OpenSSL3)与 DM 登录加密的 legacy cipher 不兼容
  if (msg.includes('[6071]') || msg.includes('消息加密') || low.includes('digital envelope routines')) {
    return new AppError('CONNECT', `DM 通信加密失败: ${msg}`, {
      hint: '新版 Node(OpenSSL3)与 DM 登录加密不兼容:给该数据源 options 设 loginEncrypt:false(链路可信/已走 SSL 时),或以 NODE_OPTIONS=--openssl-legacy-provider 运行',
      cause: err,
    });
  }

  // 数字码优先
  const m = msg.match(/\[(-?\d+)\]/);
  const byCode = m ? DM_CODE_CATEGORIES[m[1]] : undefined;
  if (byCode) return appErr(byCode, msg, err);

  // 文本兜底
  if (low.includes('只读') || low.includes('read only') || low.includes('read-only')) {
    return appErr('NOT_READONLY', msg, err);
  }
  if (low.includes('timeout') || low.includes('超时')) {
    return appErr('TIMEOUT', msg, err);
  }
  if (
    isConnError(e) ||
    low.includes('用户名或密码') ||
    low.includes('用户名或口令') ||
    low.includes('网络通信异常') ||
    low.includes('econnrefused') ||
    low.includes('enotfound') ||
    low.includes('ehostunreach') ||
    low.includes('econnreset')
  ) {
    return appErr('CONNECT', msg, err);
  }
  return appErr(phase === 'connect' ? 'CONNECT' : 'INTERNAL', msg, err);
}

function isConnError(e: DriverError): boolean {
  return (
    e.code === 'ECONNREFUSED' ||
    e.code === 'ENOTFOUND' ||
    e.code === 'EHOSTUNREACH' ||
    e.code === 'ECONNRESET' ||
    e.code === 'ETIMEDOUT'
  );
}
