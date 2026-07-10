import { describe, it, expect } from 'vitest';
import { AppError, exitCodeFor, toAppError } from '../src/errors.js';

describe('exit code contract (§9c)', () => {
  it('guard blocks exit with 2', () => {
    expect(exitCodeFor('BLOCKED_NON_READONLY')).toBe(2);
    expect(exitCodeFor('BLOCKED_MULTI_STATEMENT')).toBe(2);
    expect(exitCodeFor('BLOCKED_FILE_WRITE')).toBe(2);
  });

  it('timeout exits 3, connect 4, datasource-not-found 5', () => {
    expect(exitCodeFor('TIMEOUT')).toBe(3);
    expect(exitCodeFor('CONNECT')).toBe(4);
    expect(exitCodeFor('DATASOURCE_NOT_FOUND')).toBe(5);
  });

  it('everything else exits 1', () => {
    expect(exitCodeFor('SQL_SYNTAX')).toBe(1);
    expect(exitCodeFor('AMBIGUOUS_TABLE')).toBe(1);
    expect(exitCodeFor('NOT_READONLY')).toBe(1);
    expect(exitCodeFor('INTERNAL')).toBe(1);
  });
});

describe('AppError', () => {
  it('exposes its exit code via the category', () => {
    const e = new AppError('TIMEOUT', '查询超过 30s 被中断');
    expect(e.exitCode).toBe(3);
  });

  it('serializes to the JSON error shape, omitting hint when absent', () => {
    const e = new AppError('DATASOURCE_NOT_FOUND', "未知 --ds 'prd'");
    expect(e.toJSON()).toEqual({
      category: 'DATASOURCE_NOT_FOUND',
      message: "未知 --ds 'prd'",
    });
  });

  it('includes hint when provided', () => {
    const e = new AppError('DATASOURCE_NOT_FOUND', "未知 --ds 'prd'", {
      hint: '可用: prod-mysql-ro',
    });
    expect(e.toJSON()).toEqual({
      category: 'DATASOURCE_NOT_FOUND',
      message: "未知 --ds 'prd'",
      hint: '可用: prod-mysql-ro',
    });
  });
});

describe('toAppError', () => {
  it('passes AppError through unchanged', () => {
    const e = new AppError('SQL_SYNTAX', 'boom');
    expect(toAppError(e)).toBe(e);
  });

  it('wraps an unknown error as INTERNAL preserving the message', () => {
    const wrapped = toAppError(new Error('kaboom'));
    expect(wrapped.category).toBe('INTERNAL');
    expect(wrapped.message).toBe('kaboom');
    expect(wrapped.exitCode).toBe(1);
  });
});
