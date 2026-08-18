import { describe, it, expect } from 'vitest';
import { AppError, toAppError, type ErrorCategory } from '../src/errors.js';

describe('exit code contract (§9c)', () => {
  it.each([
    ['BLOCKED_NON_READONLY', 2],
    ['BLOCKED_MULTI_STATEMENT', 2],
    ['BLOCKED_FILE_WRITE', 2],
    ['BLOCKED_LOCKING_READ', 2],
    ['TIMEOUT', 3],
    ['CONNECT', 4],
    ['DATASOURCE_NOT_FOUND', 5],
    ['SQL_SYNTAX', 1],
    ['AMBIGUOUS_TABLE', 1],
    ['NOT_READONLY', 1],
    ['INTERNAL', 1],
  ] satisfies [ErrorCategory, number][])('%s exits %i', (category, exitCode) => {
    expect(new AppError(category, 'test').exitCode).toBe(exitCode);
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
