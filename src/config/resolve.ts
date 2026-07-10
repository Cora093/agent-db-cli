import type { DatasourceConfig, ResolvedDatasource } from './types.js';
import { resolveSecret } from './secrets.js';
import { sanitizeOptions } from '../safety/options.js';
import { optionPolicy } from '../dialects/options-policy.js';

/**
 * 把配置里的原始数据源解析为可直接用于连接的形态(§5/§6/§7):
 *   - password:resolveSecret(env: 引用 → 取环境变量)
 *   - safeOptions:按 driver 策略过白名单 + 强制回写安全字段
 *
 * 仅在真正要连接某个源时调用(故 list 不需要所有 env 都已设置)。
 */
export function resolveDatasource(
  cfg: DatasourceConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedDatasource {
  const password = resolveSecret(cfg.password, env);
  const policy = optionPolicy(cfg.driver);
  const safeOptions = sanitizeOptions(cfg.options, policy.allow, policy.force);

  const { password: _omit, options: _omit2, ...rest } = cfg;
  return { ...rest, password, safeOptions };
}
