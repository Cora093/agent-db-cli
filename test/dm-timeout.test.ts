import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDmConn } from '../src/dialects/dm.js';
import { getDialect } from '../src/dialects/registry.js';

interface FakeRaw {
  execute: ReturnType<typeof vi.fn>;
  rollback: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  socket?: { destroy: ReturnType<typeof vi.fn> };
  conn_prop_socketTimeout?: number;
}

const opts = { kind: 'select' as const, limit: 10, timeoutMs: 25 };
const pending = <T>() => new Promise<T>(() => undefined);
function resultSetResult(rows: unknown[][]) {
  let delivered = false;
  return {
    metaData: [{ name: 'ID' }],
    resultSet: {
      getRows: vi.fn(async () => {
        if (delivered) return [];
        delivered = true;
        return rows;
      }),
      close: vi.fn(async () => undefined),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DmDialect client timeout', () => {
  it('covers transaction setup and force-destroys the transport when setup hangs', async () => {
    vi.useFakeTimers();
    const raw: FakeRaw = {
      execute: vi.fn().mockReturnValue(pending()),
      rollback: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockReturnValue(pending()),
      socket: { destroy: vi.fn() },
    };
    const conn = createDmConn(raw);
    const run = getDialect('dm').runReadOnly(conn, 'SELECT SLOW', opts);
    const assertion = expect(run).rejects.toMatchObject({ category: 'TIMEOUT', exitCode: 3 });

    await vi.advanceTimersByTimeAsync(opts.timeoutMs);
    await assertion;

    expect(raw.execute).toHaveBeenCalledOnce();
    expect(raw.conn_prop_socketTimeout).toBe(opts.timeoutMs);
    expect(raw.socket.destroy).toHaveBeenCalledOnce();
    expect(raw.close).not.toHaveBeenCalled();
    expect(raw.rollback).not.toHaveBeenCalled();
  });

  it('returns TIMEOUT when execute and graceful close both never settle', async () => {
    vi.useFakeTimers();
    const raw: FakeRaw = {
      execute: vi.fn().mockResolvedValueOnce({}).mockReturnValueOnce(pending()),
      rollback: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockReturnValue(pending()),
      socket: { destroy: vi.fn() },
    };
    const conn = createDmConn(raw);
    const run = getDialect('dm').runReadOnly(conn, 'SELECT SLOW', opts);
    const assertion = expect(run).rejects.toMatchObject({ category: 'TIMEOUT' });

    await vi.advanceTimersByTimeAsync(opts.timeoutMs);
    await assertion;

    expect(raw.socket.destroy).toHaveBeenCalledOnce();
    expect(raw.close).not.toHaveBeenCalled();
    await expect(conn.close()).resolves.toBeUndefined();
    expect(raw.close).not.toHaveBeenCalled();
  });

  it('bounds fallback cleanup when the internal socket is unavailable', async () => {
    vi.useFakeTimers();
    const raw: FakeRaw = {
      execute: vi.fn().mockResolvedValueOnce({}).mockReturnValueOnce(pending()),
      rollback: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockReturnValue(pending()),
    };
    const run = getDialect('dm').runReadOnly(createDmConn(raw), 'SELECT SLOW', opts);
    const assertion = expect(run).rejects.toMatchObject({ category: 'TIMEOUT' });

    await vi.advanceTimersByTimeAsync(opts.timeoutMs);
    expect(raw.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it('retries graceful command cleanup after close rejects', async () => {
    const raw: FakeRaw = {
      execute: vi.fn(),
      rollback: vi.fn(),
      close: vi.fn().mockRejectedValueOnce(new Error('close failed')).mockResolvedValueOnce(undefined),
      socket: { destroy: vi.fn() },
    };
    const conn = createDmConn(raw);

    await expect(conn.close()).rejects.toThrow('close failed');
    await expect(conn.close()).resolves.toBeUndefined();
    expect(raw.close).toHaveBeenCalledTimes(2);
  });

  it('clears the deadline after success and does not destroy the socket later', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const raw: FakeRaw = {
      execute: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(resultSetResult([['1']])),
      rollback: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      socket: { destroy: vi.fn() },
    };

    const result = await getDialect('dm').runReadOnly(createDmConn(raw), 'SELECT 1', opts);
    await vi.advanceTimersByTimeAsync(opts.timeoutMs * 2);

    expect(result.rows).toEqual([['1']]);
    expect(clearSpy).toHaveBeenCalled();
    expect(raw.socket.destroy).not.toHaveBeenCalled();
    expect(raw.rollback).toHaveBeenCalledOnce();
  });

  it('lets a query result settled before the deadline win the race', async () => {
    vi.useFakeTimers();
    const raw: FakeRaw = {
      execute: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(resultSetResult([['1']])),
      rollback: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      socket: { destroy: vi.fn() },
    };

    const result = await getDialect('dm').runReadOnly(createDmConn(raw), 'SELECT 1', opts);

    expect(result.rows).toEqual([['1']]);
    expect(raw.socket.destroy).not.toHaveBeenCalled();
  });

  it('preserves database error classification and rolls back', async () => {
    const raw: FakeRaw = {
      execute: vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('[-2007] syntax error')),
      rollback: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      socket: { destroy: vi.fn() },
    };

    await expect(getDialect('dm').runReadOnly(createDmConn(raw), 'SELECT BAD', opts)).rejects.toMatchObject({
      category: 'SQL_SYNTAX',
    });
    expect(raw.rollback).toHaveBeenCalledOnce();
    expect(raw.socket.destroy).not.toHaveBeenCalled();
  });
});
