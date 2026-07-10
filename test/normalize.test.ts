import { describe, it, expect } from 'vitest';
import { normalizeValue } from '../src/dialects/normalize.js';

describe('normalizeValue — int/bigint(A3)', () => {
  it('文本整数 → number(安全范围内)', () => {
    expect(normalizeValue('42', 'int')).toBe(42);
    expect(normalizeValue('0', 'int')).toBe(0);
    expect(normalizeValue('-7', 'bigint')).toBe(-7);
    expect(normalizeValue('5', 'bigint')).toBe(5); // COUNT(*) 等
  });

  it('超 2^53 的文本整数 → 原字符串(精度保真)', () => {
    expect(normalizeValue('9007199254740993', 'bigint')).toBe('9007199254740993');
    expect(normalizeValue('18446744073709551615', 'bigint')).toBe('18446744073709551615');
  });

  it('原生 number / bigint 同样按安全范围分流', () => {
    expect(normalizeValue(42, 'int')).toBe(42);
    expect(normalizeValue(123n, 'bigint')).toBe(123);
    expect(normalizeValue(9007199254740993n, 'bigint')).toBe('9007199254740993');
  });

  it('SELECT TRUE(MySQL LONGLONG)→ 1(number,不猜 bool)', () => {
    expect(normalizeValue('1', 'bigint')).toBe(1);
  });
});

describe('normalizeValue — decimal(A3:恒字符串)', () => {
  it('文本 DECIMAL 原样保留', () => {
    expect(normalizeValue('12000.50', 'decimal')).toBe('12000.50');
    expect(normalizeValue('0.10', 'decimal')).toBe('0.10'); // scale 保留
    expect(normalizeValue('12345678901234567890.50', 'decimal')).toBe('12345678901234567890.50');
  });

  it('驱动给了 number / bigint 也转字符串', () => {
    expect(normalizeValue(12000.5, 'decimal')).toBe('12000.5');
    expect(normalizeValue(5n, 'decimal')).toBe('5');
  });
});

describe('normalizeValue — float(A3)', () => {
  it('文本浮点 → number', () => {
    expect(normalizeValue('3.14', 'float')).toBe(3.14);
    expect(normalizeValue(2.5, 'float')).toBe(2.5);
  });

  it('非有限值降级字符串', () => {
    expect(normalizeValue(Infinity, 'float')).toBe('Infinity');
  });
});

describe('normalizeValue — bool(A3:只对原生 bool 列)', () => {
  it('boolean 原样', () => {
    expect(normalizeValue(true, 'bool')).toBe(true);
    expect(normalizeValue(false, 'bool')).toBe(false);
  });

  it('数字 / 文本形式收敛为 true/false', () => {
    expect(normalizeValue(1, 'bool')).toBe(true);
    expect(normalizeValue(0, 'bool')).toBe(false);
    expect(normalizeValue('t', 'bool')).toBe(true);
    expect(normalizeValue('f', 'bool')).toBe(false);
    expect(normalizeValue('true', 'bool')).toBe(true);
    expect(normalizeValue('false', 'bool')).toBe(false);
  });
});

describe('normalizeValue — json/array(A3:原生结构,不再 stringify)', () => {
  it('JSON 文本 → 解析为对象/数组', () => {
    expect(normalizeValue('{"a":1,"b":"x"}', 'json')).toEqual({ a: 1, b: 'x' });
    expect(normalizeValue('[1,2,3]', 'json')).toEqual([1, 2, 3]);
  });

  it('已解析对象(pg json/jsonb)原样直传', () => {
    const obj = { a: [1, { b: 'x' }] };
    expect(normalizeValue(obj, 'json')).toBe(obj);
  });

  it('pg 数组列:逐元素归一(Date 等驱动原生值可序列化)', () => {
    expect(normalizeValue([1, 2, 3], 'array')).toEqual([1, 2, 3]);
    expect(normalizeValue(['a', null], 'array')).toEqual(['a', null]);
  });

  it('非法 JSON 文本原样直传(不崩)', () => {
    expect(normalizeValue('not-json', 'json')).toBe('not-json');
  });
});

describe('normalizeValue — date/datetime(B1:文本直传,无时区不贴 Z)', () => {
  it('DATE 文本原样', () => {
    expect(normalizeValue('2024-01-15', 'date')).toBe('2024-01-15');
  });

  it('无时区 DATETIME 文本原样(不贴 Z)', () => {
    expect(normalizeValue('2024-01-15 09:00:00', 'datetime')).toBe('2024-01-15 09:00:00');
    expect(normalizeValue('2024-01-15 09:00:00.123', 'datetime')).toBe('2024-01-15 09:00:00.123');
  });

  it('tz-aware 的 UTC ISO(dialect 已转)原样', () => {
    expect(normalizeValue('2024-01-15T01:00:00.000Z', 'datetime')).toBe('2024-01-15T01:00:00.000Z');
  });

  it('兜底:Date 对象按本地墙钟格式化,不贴 Z', () => {
    const d = new Date(2024, 0, 15, 9, 0, 0); // 本地时间 2024-01-15 09:00:00
    expect(normalizeValue(d, 'datetime')).toBe('2024-01-15 09:00:00');
    expect(normalizeValue(d, 'date')).toBe('2024-01-15');
  });
});

describe('normalizeValue — kind 缺省 / other(零回归兜底)', () => {
  it('null / undefined → null', () => {
    expect(normalizeValue(null)).toBeNull();
    expect(normalizeValue(undefined)).toBeNull();
    expect(normalizeValue(null, 'int')).toBeNull();
    expect(normalizeValue(undefined, 'json')).toBeNull();
  });

  it('普通整数/浮点保持 number', () => {
    expect(normalizeValue(42)).toBe(42);
    expect(normalizeValue(3.14)).toBe(3.14);
    expect(normalizeValue(0)).toBe(0);
  });

  it('boolean 保持', () => {
    expect(normalizeValue(true)).toBe(true);
    expect(normalizeValue(false)).toBe(false);
  });

  it('bigint → 字符串(精度保真)', () => {
    expect(normalizeValue(9007199254740993n)).toBe('9007199254740993');
  });

  it('超出安全整数范围的 number → 字符串', () => {
    expect(normalizeValue(2 ** 53)).toBe('9007199254740992'); // 2^53 已超安全整数
  });

  it('Date → ISO 字符串', () => {
    expect(normalizeValue(new Date('2026-06-08T10:00:00Z'))).toBe('2026-06-08T10:00:00.000Z');
  });

  it('Buffer/二进制 → <binary, N bytes> 占位', () => {
    expect(normalizeValue(Buffer.from([1, 2, 3]))).toBe('<binary, 3 bytes>');
    expect(normalizeValue(new Uint8Array([1, 2, 3, 4]))).toBe('<binary, 4 bytes>');
    expect(normalizeValue(Buffer.from([1, 2]), 'other')).toBe('<binary, 2 bytes>');
  });

  it('字符串原样', () => {
    expect(normalizeValue('hello')).toBe('hello');
    expect(normalizeValue('')).toBe('');
  });

  it('未声明 kind 的对象/数组 → JSON 字符串(老行为)', () => {
    expect(normalizeValue({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
    expect(normalizeValue([1, 2, 3])).toBe('[1,2,3]');
  });

  it('NaN / Infinity → 字符串(JSON 不可表示)', () => {
    expect(normalizeValue(NaN)).toBe('NaN');
    expect(normalizeValue(Infinity)).toBe('Infinity');
  });
});
