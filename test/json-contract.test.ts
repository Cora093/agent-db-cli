import { describe, expect, it, vi } from 'vitest';
import { OUTPUT_CONTRACT_VERSION } from '../src/output/contract.js';
import { listCommand } from '../src/commands/list.js';
import { tablesCommand } from '../src/commands/tables.js';
import { schemaCommand } from '../src/commands/schema.js';
import { emitResult, renderError } from '../src/output/emit.js';
import { getCapabilities } from '../src/capabilities.js';
import { AppError } from '../src/errors.js';
import type { DatasourceConfig, Datasources } from '../src/config/types.js';

const connect = vi.fn(async () => ({ close: vi.fn(async () => undefined) }));
const listTables = vi.fn(async () => [{ schema: 'app', name: 'orders', type: 'BASE TABLE' }]);
const getSchema = vi.fn(async () => ({
  schema: 'app',
  table: 'orders',
  type: 'BASE TABLE',
  columns: { status: 'full' as const, data: [{ name: 'id', type: 'bigint', nullable: false }] },
  primaryKey: { status: 'full' as const, data: ['id'] },
  indexes: { status: 'full' as const, data: [] },
  constraints: { status: 'full' as const, data: [] },
  foreignKeys: { status: 'full' as const, data: [] },
  comment: { status: 'full' as const, data: null },
  viewDefinition: { status: 'full' as const, data: null },
}));

vi.mock('../src/dialects/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/dialects/registry.js')>();
  return {
    ...actual,
    getDialect: vi.fn(() => ({
      connect,
      listTables,
      getSchema,
    })),
  };
});

const ds: DatasourceConfig = {
  id: 'test',
  driver: 'mysql',
  host: 'localhost',
  database: 'app',
  user: 'readonly',
  password: 'secret',
};
const config: Datasources = { test: ds };

function expectVersioned(value: string | object): void {
  const output = typeof value === 'string' ? JSON.parse(value) : value;
  expect(output).toHaveProperty('contractVersion', OUTPUT_CONTRACT_VERSION);
}

describe('all JSON envelopes carry the centralized contract version', () => {
  it('versions list success', () => {
    expectVersioned(listCommand(config, 'json'));
  });

  it('versions tables success', async () => {
    expectVersioned(await tablesCommand(ds, undefined, 'json', {}));
  });

  it('versions schema success', async () => {
    expectVersioned(await schemaCommand(ds, 'orders', undefined, 'json', {}));
  });

  it('versions query success', () => {
    expectVersioned(emitResult({
      ds: 'test',
      result: { columns: ['id'], rows: [[1]], truncated: false, ms: 1 },
      format: 'json',
    }, {
      writeOut: () => ({ bytes: 0 }),
    }));
  });

  it('versions capabilities success', () => {
    expectVersioned(getCapabilities());
  });

  it('versions JSON errors', () => {
    expectVersioned(renderError(new AppError('BAD_USAGE', 'bad input'), 'json'));
  });
});
