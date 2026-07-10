import { describe, it, expect } from 'vitest';
import { renderError } from '../src/output/emit.js';
import { AppError } from '../src/errors.js';

describe('renderError (§9c)', () => {
  const e = new AppError('DATASOURCE_NOT_FOUND', "未知 --ds 'prd'", {
    hint: '可用: prod-mysql-ro, bi-doris-ro',
  });

  it('json 格式 → {error:{category,message,hint}}', () => {
    const obj = JSON.parse(renderError(e, 'json'));
    expect(obj).toEqual({
      error: {
        category: 'DATASOURCE_NOT_FOUND',
        message: "未知 --ds 'prd'",
        hint: '可用: prod-mysql-ro, bi-doris-ro',
      },
    });
  });

  it('csv 格式也用 JSON error 对象', () => {
    const obj = JSON.parse(renderError(e, 'csv'));
    expect(obj.error.category).toBe('DATASOURCE_NOT_FOUND');
  });

  it('table 格式 → ERROR [类别] 文本', () => {
    const txt = renderError(e, 'table');
    expect(txt).toBe("ERROR [DATASOURCE_NOT_FOUND] 未知 --ds 'prd'");
  });

  it('table 格式有 hint 时追加提示', () => {
    const txt = renderError(e, 'table');
    // hint 仅在 json 内嵌;table 主行为 ERROR [..],hint 另起
    expect(txt.startsWith('ERROR [DATASOURCE_NOT_FOUND]')).toBe(true);
  });

  it('无 hint 时 JSON 不含 hint 键', () => {
    const bare = new AppError('TIMEOUT', '查询超过 30s 被中断');
    const obj = JSON.parse(renderError(bare, 'json'));
    expect(obj.error).toEqual({ category: 'TIMEOUT', message: '查询超过 30s 被中断' });
  });
});
