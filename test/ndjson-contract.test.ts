import { describe, expect, it, vi } from 'vitest';
import { renderView } from '../src/commands/common.js';
import { emitResult } from '../src/output/emit.js';
import { OUTPUT_CONTRACT_VERSION } from '../src/output/contract.js';
import { resolveOutPlan } from '../src/output/plan.js';
import type { SqlValue } from '../src/types.js';

function parseNdjson(output: string): Record<string, unknown>[] {
  return output.trimEnd().split('\n').map((line) => JSON.parse(line));
}

function view(command: string, columns: string[], rows: SqlValue[][], ds?: string): string {
  return renderView({ command, ...(ds ? { ds } : {}), json: {}, columns, rows }, 'ndjson');
}

function expectContract(records: Record<string, unknown>[], command: string, rowCount: number): void {
  expect(records[0]).toMatchObject({
    contractVersion: OUTPUT_CONTRACT_VERSION,
    type: 'header',
    command,
    meta: { rowCount, deliveredRowCount: rowCount },
  });
  for (const record of records.slice(1)) {
    expect(record).toMatchObject({ contractVersion: OUTPUT_CONTRACT_VERSION, type: 'row' });
    expect(record).toHaveProperty('row');
  }
}

describe('one NDJSON contract across commands and files', () => {
  it.each([
    ['list', undefined, ['id'], [['a']]],
    ['tables', 'd', ['name'], [['orders']]],
    ['schema', 'd', ['column'], [['id']]],
  ] as const)('%s uses a versioned header and versioned rows', (command, ds, columns, rows) => {
    const records = parseNdjson(view(command, [...columns], rows.map((row) => [...row]), ds));
    expectContract(records, command, 1);
  });

  it.each(['list', 'tables', 'schema'] as const)('%s empty result still emits a header', (command) => {
    const records = parseNdjson(view(command, ['name'], [], command === 'list' ? undefined : 'd'));
    expectContract(records, command, 0);
    expect(records).toHaveLength(1);
  });

  it('query stdout empty result still emits a full query header', () => {
    const output = emitResult({
      ds: 'd',
      result: { columns: ['x'], rows: [], truncated: false, ms: 2 },
      format: 'ndjson',
    }, { writeOut: vi.fn() });
    const records = parseNdjson(output);
    expectContract(records, 'query', 0);
    expect(records[0]).toMatchObject({
      meta: { rowCount: 0, deliveredRowCount: 0, queryTruncated: false, deliveryOmittedRows: 0 },
    });
    expect(records).toHaveLength(1);
  });

  it('--out .ndjson uses the same versioned contract and truthful stdout bytes', () => {
    const writeOut = vi.fn((_path: string, content: string) => ({ bytes: Buffer.byteLength(content) }));
    const stdout = JSON.parse(emitResult({
      ds: 'd',
      result: { columns: ['x', 'x', 'x#2'], rows: [[1, 2, 3]], truncated: false, ms: 4 },
      format: 'json',
      outPlan: resolveOutPlan('/out/data.ndjson', 'json'),
    }, { writeOut }));
    const content = writeOut.mock.calls[0][1];
    const records = parseNdjson(content);
    expectContract(records, 'query', 1);
    expect(records[0]).toMatchObject({
      keys: ['x', 'x#3', 'x#2'],
      meta: { mode: 'out', outPath: '/out/data.ndjson', bytes: null },
    });
    expect(stdout.meta).toMatchObject({
      outPath: '/out/data.ndjson',
      bytes: Buffer.byteLength(content),
    });
  });
});
