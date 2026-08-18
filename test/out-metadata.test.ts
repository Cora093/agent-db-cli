import { describe, expect, it, vi } from 'vitest';
import { emitResult } from '../src/output/emit.js';
import { resolveOutPlan } from '../src/output/plan.js';

describe('persisted output metadata', () => {
  it('.json embeds truthful path and stdout reports exact serialized bytes', () => {
    const writeOut = vi.fn((_path: string, content: string) => ({ bytes: Buffer.byteLength(content, 'utf8') }));
    const stdout = JSON.parse(emitResult({
      ds: 'd',
      result: { columns: ['id'], rows: [[1]], truncated: true, ms: 5 },
      format: 'json',
      outPlan: resolveOutPlan('/out/data.json', 'json'),
    }, { writeOut }));
    const content = writeOut.mock.calls[0][1];
    const persisted = JSON.parse(content);
    expect(persisted.meta).toEqual({
      rowCount: 1,
      deliveredRowCount: 1,
      ms: 5,
      queryTruncated: true,
      deliveryOmittedRows: 0,
      mode: 'out',
      spillPath: null,
      outPath: '/out/data.json',
      bytes: null,
      truncationReason: null,
      resultBytes: null,
    });
    expect(stdout.meta).toEqual({ ...persisted.meta, bytes: Buffer.byteLength(content, 'utf8') });
  });
});
