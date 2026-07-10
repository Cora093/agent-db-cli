import { AppError } from '../errors.js';

/**
 * 连接 options 净化(§7)。
 *   1. 仅白名单键透传,其余在配置加载时报错拒绝。
 *   2. 安全关键字段(multipleStatements:false 等)在 spread 之后强制回写,
 *      即便白名单将来误纳某键也顶不掉护栏。
 *
 * 纯函数:allow / force 由各 driver 提供。
 */
export function sanitizeOptions(
  raw: Record<string, unknown> | undefined,
  allow: Iterable<string>,
  force: Record<string, unknown> = {},
): Record<string, unknown> {
  const allowSet = new Set(allow);
  const out: Record<string, unknown> = {};

  if (raw) {
    for (const key of Object.keys(raw)) {
      if (!allowSet.has(key)) {
        throw new AppError('CONFIG', `不允许的连接选项: options.${key}`, {
          hint: `仅支持白名单键: ${[...allowSet].join(', ') || '(无)'}`,
        });
      }
      out[key] = raw[key];
    }
  }

  // 安全字段最后强制回写,覆盖任何用户值
  return { ...out, ...force };
}
