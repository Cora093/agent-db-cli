import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  DRIVER_DESCRIPTORS,
  DRIVER_NAMES,
  getDriverDescriptor,
  isDriverName,
} from '../src/dialects/descriptors.js';
import { renderDriverCapabilityTable } from '../src/dialects/capability-doc.js';
import { createDmConn } from '../src/dialects/dm.js';
import { getDialect } from '../src/dialects/registry.js';
import type { Conn } from '../src/dialects/types.js';
import type { DriverName } from '../src/types.js';

const EXPECTED = ['mysql', 'doris', 'starrocks', 'tidb', 'oceanbase', 'postgres', 'dm'] as const;
const TIMEOUT_SQL: Record<DriverName, string | null> = {
  mysql: 'SET SESSION max_execution_time = 1500',
  doris: 'SET query_timeout = 2',
  starrocks: 'SET query_timeout = 2',
  tidb: 'SET SESSION max_execution_time = 1500',
  oceanbase: 'SET ob_query_timeout = 1500000',
  postgres: 'SET statement_timeout = 1500',
  dm: null,
};
const BEGIN_SQL: Record<DriverName, string | null> = {
  mysql: 'START TRANSACTION READ ONLY',
  doris: null,
  starrocks: null,
  tidb: 'START TRANSACTION READ ONLY',
  oceanbase: 'START TRANSACTION READ ONLY',
  postgres: 'BEGIN READ ONLY',
  dm: 'SET TRANSACTION READ ONLY',
};

describe('driver descriptor registry', () => {
  it('registers every supported driver exactly once', () => {
    expect(DRIVER_NAMES).toEqual(EXPECTED);
    expect(Object.keys(DRIVER_DESCRIPTORS)).toEqual(EXPECTED);
    for (const name of EXPECTED) {
      expect(isDriverName(name)).toBe(true);
      expect(getDriverDescriptor(name).name).toBe(name);
      expect(getDialect(name).driver).toBe(name);
    }
    expect(isDriverName('oracle')).toBe(false);
  });

  it.each(EXPECTED)('%s has complete policy-derived metadata', (name) => {
    const descriptor = getDriverDescriptor(name);
    expect(descriptor.protocol).toMatch(/^(mysql|postgres|dm)$/);
    expect(descriptor.connection.defaultPort).toBeGreaterThan(0);
    expect(descriptor.lex).toEqual({
      hashComment: expect.any(Boolean),
      dashNeedsWhitespace: expect.any(Boolean),
      backslashEscape: expect.any(Boolean),
      dollarQuote: expect.any(Boolean),
      backtickQuote: expect.any(Boolean),
    });
    expect(descriptor.connection.options.allow).toBeInstanceOf(Array);
    expect(descriptor.connection.options.force).toBeTypeOf('object');
    expect(descriptor.capabilities).toEqual({
      introspection: expect.stringMatching(/^(full|best-effort)$/),
      readOnlyTransaction: descriptor.execution.readOnlyTransaction.strength,
      timeoutUnit: descriptor.execution.timeout.unit,
      cancellation: 'connection-close',
      limit: expect.stringMatching(/^(sql-rewrite|sql-rewrite\+driver-max-rows)$/),
    });
    expect(descriptor.createDialect()).toBeDefined();
  });

  it.each(EXPECTED)('%s timeout conversion is the descriptor-owned executable policy', (name) => {
    const timeout = getDriverDescriptor(name).execution.timeout;
    expect(timeout.unit === 'none' ? null : timeout.sql(1500)).toBe(TIMEOUT_SQL[name]);
  });

  it.each(EXPECTED)('%s executes timeout, transaction and rollback policies', async (name) => {
    const calls: unknown[][] = [];
    const dialect = getDialect(name);
    const raw = fakeRaw(name, calls);
    const conn = name === 'dm'
      ? createDmConn(raw as never)
      : ({ driver: name, raw, close: vi.fn() } as unknown as Conn);

    await dialect.runReadOnly(conn, 'SELECT 1', { kind: 'select', limit: 10, timeoutMs: 1500 });

    const sqlCalls = calls.map((call) => call[0]);
    const timeoutSql = TIMEOUT_SQL[name];
    const beginSql = BEGIN_SQL[name];
    if (timeoutSql) expect(sqlCalls[0]).toBe(timeoutSql);
    else expect(sqlCalls).not.toContain(expect.stringContaining('timeout'));
    if (beginSql) {
      expect(sqlCalls).toContain(beginSql);
      expect(sqlCalls.at(-1)).toBe('ROLLBACK');
    } else {
      expect(sqlCalls).not.toContain('START TRANSACTION READ ONLY');
      expect(sqlCalls).not.toContain('ROLLBACK');
    }
    expect(sqlCalls.some((sql) => queryText(sql).includes('SELECT 1'))).toBe(true);
  });

  it('DM uses autoCommit=false for begin, query, and fallback rollback', async () => {
    const calls: unknown[][] = [];
    const dialect = getDialect('dm');
    const raw = fakeRaw('dm', calls, false);
    const conn = createDmConn(raw as never);

    await dialect.runReadOnly(conn, 'SELECT 1', { kind: 'select', limit: 10, timeoutMs: 1500 });

    expect(calls).toEqual([
      ['SET TRANSACTION READ ONLY', [], { autoCommit: false }],
      ['SELECT 1 LIMIT 11', [], { autoCommit: false, maxRows: 11 }],
      ['ROLLBACK', [], { autoCommit: false }],
    ]);
  });

  it.each(['README.md', 'skills/agent-db-query/references/dialects.md'])(
    '%s embeds the generated capability matrix',
    (path) => expect(fs.readFileSync(path, 'utf8')).toContain(renderDriverCapabilityTable()),
  );
});

function fakeRaw(driver: DriverName, calls: unknown[][], dmRollback = true): Record<string, unknown> {
  if (driver === 'dm') {
    return {
      execute: vi.fn(async (...args: unknown[]) => {
        calls.push(args);
        return { rows: [], metaData: [] };
      }),
      ...(dmRollback ? { rollback: vi.fn(async () => calls.push(['ROLLBACK'])) } : {}),
    };
  }
  if (driver === 'postgres') {
    return {
      query: vi.fn(async (...args: unknown[]) => {
        calls.push(args);
        return { rows: [], fields: [] };
      }),
    };
  }
  return {
    query: vi.fn(async (...args: unknown[]) => {
      calls.push(args);
      return [[], []];
    }),
  };
}

function queryText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    return String((value as { sql?: string; text?: string }).sql ?? (value as { text?: string }).text ?? '');
  }
  return '';
}
