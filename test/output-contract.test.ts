import { describe, expect, it, vi } from 'vitest';
import { OUTPUT_CONTRACT_VERSION } from '../src/output/contract.js';
import { emitResult, renderError } from '../src/output/emit.js';
import { AppError } from '../src/errors.js';
import type { QueryResult } from '../src/dialects/types.js';

const result: QueryResult = {
  columns: ['id', 'id', 'name'],
  rows: [[1, 2, 'x']],
  truncated: false,
  ms: 4,
};

const deps = {
  writeOut: vi.fn(() => ({ bytes: 10 })),
};

describe('output contract', () => {
  it('versions structured success and error JSON', () => {
    const success = JSON.parse(emitResult({ ds: 'd', result, format: 'json' }, deps));
    const error = JSON.parse(renderError(new AppError('BAD_USAGE', 'bad'), 'json'));
    expect(success.contractVersion).toBe(OUTPUT_CONTRACT_VERSION);
    expect(error.contractVersion).toBe(OUTPUT_CONTRACT_VERSION);
  });

  it('uses uniform inline metadata', () => {
    const output = JSON.parse(emitResult({ ds: 'd', result, format: 'json' }, deps));
    expect(output.meta).toEqual({
      rowCount: 1,
      deliveredRowCount: 1,
      ms: 4,
      queryTruncated: false,
      deliveryOmittedRows: 0,
      mode: 'inline',
      spillPath: null,
      outPath: null,
      bytes: null,
      truncationReason: null,
      resultBytes: null,
    });
  });

  it('preserves duplicate column values in JSON and CSV', () => {
    const json = JSON.parse(emitResult({ ds: 'd', result, format: 'json' }, deps));
    expect(json.columns).toEqual(['id', 'id', 'name']);
    expect(json.rows[0]).toEqual([1, 2, 'x']);
    expect(emitResult({ ds: 'd', result, format: 'csv' }, deps)).toBe(
      'id,id,name\r\n1,2,x',
    );
  });

  it('emits independently parseable NDJSON with metadata first and unique keys', () => {
    const output = emitResult({ ds: 'd', result, format: 'ndjson' }, deps);
    const lines = output.split('\n').map((line) => JSON.parse(line));
    expect(lines).toEqual([
      {
        contractVersion: OUTPUT_CONTRACT_VERSION,
        type: 'header',
        command: 'query',
        ds: 'd',
        columns: ['id', 'id', 'name'],
        keys: ['id', 'id#2', 'name'],
        meta: {
          rowCount: 1,
          deliveredRowCount: 1,
          ms: 4,
          queryTruncated: false,
          deliveryOmittedRows: 0,
          mode: 'stdout',
          spillPath: null,
          outPath: null,
          bytes: null,
          truncationReason: null,
          resultBytes: null,
        },
      },
      {
        contractVersion: OUTPUT_CONTRACT_VERSION,
        type: 'row',
        row: { id: 1, 'id#2': 2, name: 'x' },
      },
    ]);
  });
});
