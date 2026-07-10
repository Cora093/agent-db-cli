import os from 'node:os';
import path from 'node:path';

/**
 * 按 OS 自算配置文件路径(§5,不引 env-paths)。
 *
 * 解析顺序:
 *   1) AGENT_DB_CLI_CONFIG 指向的那个文件(短路优先)
 *   2) Windows → %APPDATA%\agent-db-cli\datasources.yaml
 *   3) 否则 → $XDG_CONFIG_HOME/agent-db-cli/datasources.yaml,缺省 ~/.config/...
 *
 * platform / env / homedir 可注入,便于测试。
 */
export function resolveConfigPath(
  opts: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    homedir?: string;
  } = {},
): string {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const homedir = opts.homedir ?? os.homedir();

  const override = env.AGENT_DB_CLI_CONFIG;
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }

  if (platform === 'win32') {
    const appData = env.APPDATA && env.APPDATA.trim()
      ? env.APPDATA
      : path.join(homedir, 'AppData', 'Roaming');
    return path.join(appData, 'agent-db-cli', 'datasources.yaml');
  }

  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(homedir, '.config');
  return path.join(base, 'agent-db-cli', 'datasources.yaml');
}
