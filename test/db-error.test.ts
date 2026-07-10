import { describe, it, expect } from 'vitest';
import { classifyDmError, classifyMysqlError, classifyPgError } from '../src/dialects/db-error.js';

/**
 * DB 错误分类 → 退出码契约(§9c)。
 * 重点覆盖 DM:dmdb 把错误码嵌在 message、无独立 code/errno,故按文本匹配(真机形状)。
 */

describe('classifyDmError(达梦)', () => {
  it('认证失败 [-2501] 用户名或密码错误 → CONNECT(4)', () => {
    const e = classifyDmError(new Error('[-2501] 用户名或密码错误'));
    expect(e.category).toBe('CONNECT');
    expect(e.exitCode).toBe(4);
  });

  it('网络通信异常 [6001] / ECONNREFUSED → CONNECT(4)', () => {
    const e = classifyDmError(
      new Error('[6001] 网络通信异常\nError: connect ECONNREFUSED 127.0.0.1:1'),
    );
    expect(e.category).toBe('CONNECT');
    expect(e.exitCode).toBe(4);
  });

  it('只读事务拒绝写 [-6506] → NOT_READONLY(1)', () => {
    const e = classifyDmError(new Error('[-6506] 试图在只读事务中修改数据'));
    expect(e.category).toBe('NOT_READONLY');
  });

  it('登录加密失败 [6071] → CONNECT(4)', () => {
    const e = classifyDmError(new Error('[6071] 消息加密失败'));
    expect(e.category).toBe('CONNECT');
  });

  it('其它未知错误 → INTERNAL(1)', () => {
    const e = classifyDmError(new Error('[-9999] 某未知内部错误'));
    expect(e.category).toBe('INTERNAL');
    expect(e.exitCode).toBe(1);
  });

  it('语法分析出错 [-2007] → SQL_SYNTAX(数字码优先于文本)', () => {
    const e = classifyDmError(new Error('[-2007] 第1行附近出现错误: 语法分析出错'));
    expect(e.category).toBe('SQL_SYNTAX');
    expect(e.exitCode).toBe(1);
  });

  it('超时文本兜底 → TIMEOUT 且带 hint(R1)', () => {
    const e = classifyDmError(new Error('操作超时'));
    expect(e.category).toBe('TIMEOUT');
    expect(e.hint).toContain('--timeout');
  });

  it('连接期未知错误 → CONNECT(4)', () => {
    const e = classifyDmError(new Error('某握手失败'), 'connect');
    expect(e.category).toBe('CONNECT');
  });
});

describe('classifyMysqlError / classifyPgError(回归)', () => {
  it('MySQL 认证拒绝 ER_ACCESS_DENIED_ERROR → CONNECT', () => {
    const e = classifyMysqlError({ code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, message: 'denied' });
    expect(e.category).toBe('CONNECT');
  });

  it('MySQL ECONNREFUSED → CONNECT', () => {
    const e = classifyMysqlError({ code: 'ECONNREFUSED', message: 'refused' });
    expect(e.category).toBe('CONNECT');
  });

  it('PG 口令错误 28P01 → CONNECT', () => {
    const e = classifyPgError({ code: '28P01', message: 'password authentication failed' });
    expect(e.category).toBe('CONNECT');
  });
});

describe('phase 感知与补充错误码(E1/E2/L13)', () => {
  it('MySQL 连接期 ETIMEDOUT → CONNECT(4),执行期 → TIMEOUT(3)', () => {
    expect(classifyMysqlError({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' }, 'connect').category).toBe('CONNECT');
    expect(classifyMysqlError({ code: 'ETIMEDOUT', message: 'timeout' }, 'run').category).toBe('TIMEOUT');
  });

  it('MySQL 1054 未知列(如 ROWNUM)→ SQL_SYNTAX,不再 INTERNAL', () => {
    const e = classifyMysqlError({ errno: 1054, message: "Unknown column 'ROWNUM' in 'field list'" });
    expect(e.category).toBe('SQL_SYNTAX');
  });

  it('MySQL 1146 表不存在 → SQL_SYNTAX', () => {
    expect(classifyMysqlError({ errno: 1146, message: "Table 'x.t' doesn't exist" }).category).toBe('SQL_SYNTAX');
  });

  it("PG 连接期 'timeout expired'(无 SQLSTATE)→ CONNECT,不再 INTERNAL", () => {
    const e = classifyPgError(new Error('timeout expired'), 'connect');
    expect(e.category).toBe('CONNECT');
    expect(e.exitCode).toBe(4);
  });

  it('PG 执行期未知错误仍 → INTERNAL(零回归)', () => {
    expect(classifyPgError(new Error('something odd'), 'run').category).toBe('INTERNAL');
  });
});
