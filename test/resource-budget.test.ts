import { describe, expect, it } from 'vitest';
import {
  MAX_FIELD_BYTES,
  createRowCollector,
  planLimit,
} from '../src/dialects/sql-util.js';

describe('query resource budgets', () => {
  it('stops before retaining the limit probe row', () => {
    const c = createRowCollector(['n'], ['int'], 2, Date.now());
    expect(c.add([1])).toBe(true);
    expect(c.add([2])).toBe(true);
    expect(c.add([3])).toBe(false);
    expect(c.finish()).toMatchObject({
      rows: [[1], [2]],
      truncated: true,
      truncationReason: 'row-limit',
    });
  });

  it('stops on a whole-row boundary when result bytes are exhausted', () => {
    const c = createRowCollector(['s'], ['other'], 500, Date.now(), {
      maxResultBytes: 12,
      maxFieldBytes: 100,
    });
    expect(c.add(['12345'])).toBe(true);
    expect(c.add(['67890'])).toBe(false);
    expect(c.finish()).toMatchObject({
      rows: [['12345']],
      truncated: true,
      truncationReason: 'result-bytes',
    });
  });

  it('rejects a single field before it enters the retained result', () => {
    const c = createRowCollector(['s'], ['other'], 500, Date.now());
    expect(() => c.add(['x'.repeat(MAX_FIELD_BYTES + 1)])).toThrow(/字段超过/);
    expect(c.finish().rows).toEqual([]);
  });

  it('marks unknown LIMIT/FETCH forms as requiring a driver cap', () => {
    expect(planLimit('SELECT * FROM t LIMIT ?', 'select', 501)).toMatchObject({
      serverBounded: false,
    });
    expect(planLimit('SELECT * FROM t FETCH FIRST (?) ROWS ONLY', 'select', 501)).toMatchObject({
      serverBounded: false,
    });
  });

  it('marks every non-select statement kind as requiring a driver cap', () => {
    for (const kind of ['show', 'explain', 'describe'] as const) {
      expect(planLimit(kind.toUpperCase(), kind, 501)).toMatchObject({ serverBounded: false });
    }
  });
});
