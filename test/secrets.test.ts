import { describe, it, expect } from 'vitest';
import { resolveSecret } from '../src/config/secrets.js';
import { AppError } from '../src/errors.js';

describe('resolveSecret (§6 凭证引用)', () => {
  it('字面量密码原样返回', () => {
    expect(resolveSecret('s3cr3t', {})).toBe('s3cr3t');
  });

  it('缺省密码视为空串', () => {
    expect(resolveSecret(undefined, {})).toBe('');
  });

  it('env:VAR 从环境变量取值', () => {
    expect(resolveSecret('env:BI_DORIS_PWD', { BI_DORIS_PWD: 'fromEnv' })).toBe('fromEnv');
  });

  it('env:VAR 变量未设置时抛 CONFIG 错', () => {
    try {
      resolveSecret('env:MISSING', {});
      throw new Error('应当抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).category).toBe('CONFIG');
      expect((e as AppError).message).toContain('MISSING');
    }
  });

  it('不做转义:以 env: 开头一律按引用处理(§6 决定 #17)', () => {
    // 字面量恰好以 env: 开头的极罕见情形:仍按引用解析,变量名为其后缀
    expect(resolveSecret('env:X', { X: 'y' })).toBe('y');
  });

  it('env: 后为空变量名时报错', () => {
    expect(() => resolveSecret('env:', {})).toThrow(AppError);
  });
});
