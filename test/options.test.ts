import { describe, it, expect } from 'vitest';
import { sanitizeOptions } from '../src/safety/options.js';
import { AppError } from '../src/errors.js';

describe('sanitizeOptions (§7 options 白名单 + 安全字段回写)', () => {
  it('undefined 返回仅含强制安全字段的对象', () => {
    expect(sanitizeOptions(undefined, ['connectTimeout'], { multipleStatements: false })).toEqual({
      multipleStatements: false,
    });
  });

  it('白名单键透传', () => {
    const out = sanitizeOptions({ connectTimeout: 5000 }, ['connectTimeout', 'charset']);
    expect(out).toEqual({ connectTimeout: 5000 });
  });

  it('非白名单键 → CONFIG 报错,带键名', () => {
    try {
      sanitizeOptions({ multipleStatements: true }, ['connectTimeout']);
      throw new Error('应当抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).category).toBe('CONFIG');
      expect((e as AppError).message).toContain('multipleStatements');
    }
  });

  it('强制安全字段在 spread 之后回写,顶掉用户值', () => {
    // 即便白名单"误纳"了 multipleStatements,force 仍强制为 false
    const out = sanitizeOptions(
      { multipleStatements: true, connectTimeout: 1000 },
      ['connectTimeout', 'multipleStatements'],
      { multipleStatements: false },
    );
    expect(out.multipleStatements).toBe(false);
    expect(out.connectTimeout).toBe(1000);
  });

  it('强制字段即使 raw 未提供也存在', () => {
    const out = sanitizeOptions({ connectTimeout: 1000 }, ['connectTimeout'], {
      multipleStatements: false,
    });
    expect(out.multipleStatements).toBe(false);
  });
});
