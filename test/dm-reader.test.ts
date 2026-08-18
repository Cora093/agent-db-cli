import { describe, expect, it, vi } from 'vitest';
import { collectDmResultSet, type DmResultSet } from '../src/dialects/dm.js';

describe('DM batched result-set reader', () => {
  it('stops at row cap and always closes result set', async () => {
    const rs: DmResultSet = {
      getRows: vi.fn(async () => [['1'], ['2'], ['3']]),
      close: vi.fn(async () => undefined),
    };
    const result = await collectDmResultSet(rs, [{ name: 'v' }], {
      kind: 'show', limit: 2, timeoutMs: 1000,
    }, Date.now());
    expect(result.rows).toEqual([['1'], ['2']]);
    expect(result.truncated).toBe(true);
    expect(rs.getRows).toHaveBeenCalledTimes(1);
    expect(rs.close).toHaveBeenCalledOnce();
  });

  it('byte exhaustion stops batching and closes result set', async () => {
    const rs: DmResultSet = {
      getRows: vi.fn(async () => [['x'.repeat(1024 * 1024 + 1)]]),
      close: vi.fn(async () => undefined),
    };
    await expect(collectDmResultSet(rs, [{ name: 'v' }], {
      kind: 'select', limit: 500, timeoutMs: 1000,
    }, Date.now())).rejects.toThrow(/字段超过/);
    expect(rs.getRows).toHaveBeenCalledTimes(1);
    expect(rs.close).toHaveBeenCalledOnce();
  });
});
