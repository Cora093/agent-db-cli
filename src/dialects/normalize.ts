import type { SqlValue } from '../types.js';
import type { ColKind } from './types.js';

/**
 * 把驱动原生值收敛为 JSON 可序列化的值(A3/B1,0.2.0 输出契约)。
 * 按 dialect 给出的 ColKind 分流;kind 缺省/other 时回退老的 typeof 逻辑(零回归兜底)。
 *
 *   - int/bigint:安全整数 → number,超 2^53 → 字符串
 *   - decimal:恒字符串(scale 与任意精度保真)
 *   - float:number
 *   - bool:true / false(只对原生 bool 列;tinyint(1) 不猜)
 *   - json/array:原生对象 / 数组(不再 JSON.stringify)
 *   - date/datetime:文本直传,无时区不贴 Z(B1);tz-aware 由 dialect 给 UTC ISO 文本
 *   - 二进制 / BLOB → "<binary, N bytes>" 占位(非字节级保真)
 *
 * 驱动侧配合:mysql2 dateStrings、pg per-client parser、dmdb fetchAsString,
 * 使数值/日期以文本抵达本函数,避免驱动预先丢精或贴错时区。
 */
export function normalizeValue(raw: unknown, kind?: ColKind): SqlValue {
  if (raw === null || raw === undefined) return null;

  switch (kind) {
    case 'int':
    case 'bigint':
      return normalizeInt(raw);
    case 'decimal':
      return normalizeDecimal(raw);
    case 'float':
      return normalizeFloat(raw);
    case 'bool':
      return normalizeBool(raw);
    case 'json':
    case 'array':
      return normalizeJson(raw);
    case 'date':
    case 'datetime':
      return normalizeTemporal(raw, kind);
    default:
      return normalizeDefault(raw);
  }
}

function normalizeInt(raw: unknown): SqlValue {
  if (typeof raw === 'bigint') {
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : raw.toString();
  }
  if (typeof raw === 'string') {
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : raw;
  }
  return normalizeDefault(raw); // number 走默认(自带超安全范围降级)
}

function normalizeDecimal(raw: unknown): SqlValue {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'bigint') return String(raw);
  return normalizeDefault(raw);
}

function normalizeFloat(raw: unknown): SqlValue {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : String(raw);
  if (typeof raw === 'string') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  return normalizeDefault(raw);
}

function normalizeBool(raw: unknown): SqlValue {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'bigint') return raw !== 0n;
  if (typeof raw === 'string') {
    const low = raw.toLowerCase();
    if (low === 't' || low === 'true' || low === '1' || low === 'y' || low === 'yes') return true;
    if (low === 'f' || low === 'false' || low === '0' || low === 'n' || low === 'no') return false;
    return raw;
  }
  return normalizeDefault(raw);
}

function normalizeJson(raw: unknown): SqlValue {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as SqlValue;
    } catch {
      return raw; // 驱动给的不是合法 JSON 文本:原样直传
    }
  }
  if (Array.isArray(raw)) {
    // pg 数组列:元素可能是 Date/Buffer 等驱动原生值,逐元素归一保证可序列化
    return raw.map((el) => normalizeValue(el));
  }
  if (typeof raw === 'object' && !Buffer.isBuffer(raw) && !(raw instanceof Uint8Array) && !(raw instanceof Date)) {
    return raw as SqlValue; // 已是解析后的 JSON 对象:原样直传,不 stringify
  }
  return normalizeDefault(raw);
}

function normalizeTemporal(raw: unknown, kind: 'date' | 'datetime'): SqlValue {
  // 正路:驱动已按文本交付('YYYY-MM-DD [HH:MM:SS[.fff]]' 或 tz-aware 的 UTC ISO)
  if (typeof raw === 'string') return raw;
  // 兜底:个别路径仍给 Date 时按本地墙钟格式化,杜绝 toISOString() 给无时区值贴 Z
  if (raw instanceof Date) return kind === 'date' ? formatLocalDate(raw) : formatLocalDateTime(raw);
  return normalizeDefault(raw);
}

function formatLocalDate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function formatLocalDateTime(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const ms = d.getMilliseconds();
  const frac = ms > 0 ? `.${p(ms, 3)}` : '';
  return `${formatLocalDate(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${frac}`;
}

/** kind 缺省 / other 的回退逻辑(与 0.1.x 行为一致,零回归)。 */
function normalizeDefault(raw: unknown): SqlValue {
  const t = typeof raw;

  if (t === 'boolean') return raw as boolean;

  if (t === 'bigint') return (raw as bigint).toString();

  if (t === 'number') {
    const n = raw as number;
    if (!Number.isFinite(n)) return String(n); // NaN / Infinity:JSON 不可表示
    if (Number.isInteger(n) && !Number.isSafeInteger(n)) return String(n);
    return n;
  }

  if (t === 'string') return raw as string;

  if (raw instanceof Date) return raw.toISOString();

  if (Buffer.isBuffer(raw)) return `<binary, ${raw.length} bytes>`;
  if (raw instanceof Uint8Array) return `<binary, ${raw.length} bytes>`;

  // 对象 / 数组(未声明 kind 的 JSON 列等):序列化
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}
