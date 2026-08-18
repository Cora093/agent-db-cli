import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  readMysqlRows,
  type MysqlCallbackConnection,
  type MysqlEventQuery,
} from '../src/dialects/mysql-family.js';
import { collectPgCursor, type PgRowCursor } from '../src/dialects/postgres.js';

class FakeMysqlQuery extends EventEmitter implements MysqlEventQuery {
  override on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener);
  }
}

function mysqlReader(rows: unknown[][], opts: { limit: number; huge?: boolean }) {
  const query = new FakeMysqlQuery();
  let destroyed = false;
  const connection: MysqlCallbackConnection = {
    query: () => {
      queueMicrotask(() => {
        query.emit('fields', [{ name: 'v', type: 253 }]);
        for (const row of rows) {
          if (destroyed) break;
          query.emit('result', row);
        }
        if (destroyed) query.emit('error', new Error('late socket error'));
        else query.emit('end');
      });
      return query;
    },
    destroy: vi.fn(() => { destroyed = true; }),
  };
  const raw = { connection } as never;
  return { raw, connection, query, opts };
}

describe('bounded driver readers', () => {
  it.each(['show', 'explain', 'describe'] as const)('MySQL %s remains usable and stops after cap', async (kind) => {
    const f = mysqlReader([[1], [2], [3], [4]], { limit: 2 });
    const discarded = vi.fn();
    const result = await readMysqlRows(f.raw, kind.toUpperCase(), {
      kind,
      limit: 2,
      timeoutMs: 1000,
    }, Date.now(), discarded);
    expect(result.rows).toEqual([[1], [2]]);
    expect(result.truncated).toBe(true);
    expect(f.connection.destroy).toHaveBeenCalledOnce();
    expect(discarded).toHaveBeenCalledOnce();
  });

  it('MySQL unknown LIMIT remains bounded by event reader', async () => {
    const f = mysqlReader([[1], [2], [3]], { limit: 1 });
    const result = await readMysqlRows(f.raw, 'SELECT 1 LIMIT ?', {
      kind: 'select', limit: 1, timeoutMs: 1000,
    }, Date.now());
    expect(result.rows).toEqual([[1]]);
    expect(result.truncated).toBe(true);
    expect(f.connection.destroy).toHaveBeenCalledOnce();
  });

  it('MySQL byte exhaustion destroys query and absorbs late error', async () => {
    const f = mysqlReader([['x'.repeat(1024 * 1024 + 1)], ['later']], { limit: 500 });
    await expect(readMysqlRows(f.raw, 'SHOW STATUS', {
      kind: 'show', limit: 500, timeoutMs: 1000,
    }, Date.now())).rejects.toThrow(/字段超过/);
    expect(f.connection.destroy).toHaveBeenCalledOnce();
  });

  it.each(['show', 'explain', 'describe'] as const)('PostgreSQL %s remains cursor-bounded', async (kind) => {
    let reads = 0;
    const cursor: PgRowCursor = {
      fields: [{ name: 'v', dataTypeID: 23 }],
      read: vi.fn(async () => (++reads === 1 ? [[1], [2], [3]] : [])),
      close: vi.fn(async () => undefined),
    };
    const result = await collectPgCursor(cursor, { kind, limit: 2, timeoutMs: 1000 }, Date.now());
    expect(result.rows).toEqual([[1], [2]]);
    expect(result.truncated).toBe(true);
    expect(cursor.close).toHaveBeenCalledOnce();
    expect(cursor.read).toHaveBeenCalledTimes(1);
  });

  it('PostgreSQL unknown FETCH remains bounded by cursor', async () => {
    const cursor: PgRowCursor = {
      fields: [{ name: 'v', dataTypeID: 23 }],
      read: vi.fn(async () => [[1], [2]]),
      close: vi.fn(async () => undefined),
    };
    const result = await collectPgCursor(cursor, {
      kind: 'select', limit: 1, timeoutMs: 1000,
    }, Date.now());
    expect(result.rows).toEqual([[1]]);
    expect(cursor.close).toHaveBeenCalledOnce();
  });

  it('PostgreSQL empty cursors preserve field metadata and close the portal', async () => {
    const cursor: PgRowCursor = {
      fields: [{ name: 'id', dataTypeID: 23 }, { name: 'name', dataTypeID: 25 }],
      read: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
    };
    const result = await collectPgCursor(cursor, {
      kind: 'select', limit: 500, timeoutMs: 1000,
    }, Date.now());
    expect(result.columns).toEqual(['id', 'name']);
    expect(result.rows).toEqual([]);
    expect(cursor.close).toHaveBeenCalledOnce();
  });

  it('PostgreSQL byte exhaustion closes cursor before another read', async () => {
    const cursor: PgRowCursor = {
      fields: [{ name: 'v', dataTypeID: 25 }],
      read: vi.fn(async () => [['x'.repeat(1024 * 1024 + 1)]]),
      close: vi.fn(async () => undefined),
    };
    await expect(collectPgCursor(cursor, {
      kind: 'show', limit: 500, timeoutMs: 1000,
    }, Date.now())).rejects.toThrow(/字段超过/);
    expect(cursor.close).toHaveBeenCalledOnce();
    expect(cursor.read).toHaveBeenCalledTimes(1);
  });
});
