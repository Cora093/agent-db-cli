import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { AppError } from '../errors.js';
import { DRIVER_NAMES, isDriverName } from '../dialects/descriptors.js';
import type { Config, DatasourceConfig } from './types.js';
import { resolveConfigPath } from './paths.js';
import { checkConfigPermissions } from './permissions.js';

/**
 * 解析 + 校验配置文本(纯函数,不碰 IO)。
 * map key 注入为各数据源的 id。
 */
export function parseConfig(text: string, path: string): Config {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    // 不嵌 e.message:yaml 的报错带出错源码帧,会回显该行明文(如 password)。
    // 用错误码 + 行列号重建消息,定位能力保留、内容不泄漏。
    const ye = e as { code?: string; linePos?: { line: number; col: number }[] };
    const pos = ye.linePos?.[0];
    const at = pos ? `(行 ${pos.line} 列 ${pos.col})` : '';
    const code = ye.code ? ` [${ye.code}]` : '';
    throw new AppError('CONFIG', `配置文件 YAML 解析失败${code}${at}`, {
      hint: `检查 ${path} 的缩进与语法`,
    });
  }

  if (!isPlainObject(doc)) {
    throw new AppError('CONFIG', '配置文件顶层应为对象', { hint: `检查 ${path}` });
  }

  const ds = (doc as Record<string, unknown>).datasources;
  if (!isPlainObject(ds)) {
    throw new AppError('CONFIG', "配置缺少 'datasources' 对象", {
      hint: '顶层需有 datasources: 映射,见示例 datasources.yaml',
    });
  }

  const ids = Object.keys(ds);
  if (ids.length === 0) {
    throw new AppError('CONFIG', 'datasources 为空,至少配置一个数据源', {
      hint: `编辑 ${path} 添加数据源`,
    });
  }

  const datasources: Record<string, DatasourceConfig> = {};
  for (const id of ids) {
    datasources[id] = validateDatasource(id, (ds as Record<string, unknown>)[id]);
  }

  return { path, datasources };
}

function validateDatasource(id: string, raw: unknown): DatasourceConfig {
  if (!isPlainObject(raw)) {
    throw new AppError('CONFIG', `数据源 '${id}' 必须是对象`);
  }
  const o = raw as Record<string, unknown>;

  const driver = o.driver;
  if (typeof driver !== 'string') {
    throw new AppError('CONFIG', `数据源 '${id}' 缺少 driver 字段`, {
      hint: `合法 driver: ${DRIVER_NAMES.join(', ')}`,
    });
  }
  if (!isDriverName(driver)) {
    throw new AppError('CONFIG', `数据源 '${id}' 的 driver '${driver}' 不支持`, {
      hint: `合法 driver: ${DRIVER_NAMES.join(', ')}`,
    });
  }

  const host = o.host;
  if (typeof host !== 'string' || !host.trim()) {
    throw new AppError('CONFIG', `数据源 '${id}' 缺少 host 字段`);
  }

  const user = o.user;
  if (typeof user !== 'string' || !user.trim()) {
    throw new AppError('CONFIG', `数据源 '${id}' 缺少 user 字段`);
  }

  const cfg: DatasourceConfig = {
    id,
    driver,
    host,
    user,
  };

  if (o.port !== undefined) {
    if (typeof o.port !== 'number' || !Number.isInteger(o.port) || o.port <= 0) {
      throw new AppError('CONFIG', `数据源 '${id}' 的 port 必须是正整数`);
    }
    cfg.port = o.port;
  }

  cfg.label = optionalString(id, o, 'label');
  cfg.database = optionalString(id, o, 'database');
  cfg.schema = optionalString(id, o, 'schema');
  cfg.password = optionalString(id, o, 'password');

  if (o.options !== undefined) {
    if (!isPlainObject(o.options)) {
      throw new AppError('CONFIG', `数据源 '${id}' 的 options 必须是对象`);
    }
    cfg.options = o.options as Record<string, unknown>;
  }

  if (o.timeout !== undefined) {
    if (typeof o.timeout !== 'number' || o.timeout <= 0) {
      throw new AppError('CONFIG', `数据源 '${id}' 的 timeout 必须是正数(秒)`);
    }
    cfg.timeout = o.timeout;
  }

  return cfg;
}

function optionalString(
  id: string,
  o: Record<string, unknown>,
  key: keyof DatasourceConfig,
): string | undefined {
  const v = o[key as string];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    throw new AppError('CONFIG', `数据源 '${id}' 的 ${String(key)} 必须是字符串`);
  }
  return v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 完整加载流程(含 IO):解析路径 → 存在性 → 权限校验 → 读取 → parseConfig。
 * platform/env 可注入便于测试。
 */
export function loadConfig(
  opts: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    configPath?: string;
  } = {},
): Config {
  const path = opts.configPath ?? resolveConfigPath({ env: opts.env, platform: opts.platform });

  if (!fs.existsSync(path)) {
    throw new AppError('CONFIG', `配置文件不存在: ${path}`, {
      hint: '创建该文件并填入数据源(见示例 datasources.yaml);Linux 记得 chmod 600',
    });
  }

  checkConfigPermissions(path, { platform: opts.platform });

  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (e) {
    throw new AppError('CONFIG', `读取配置文件失败: ${(e as Error).message}`, { cause: e });
  }

  return parseConfig(text, path);
}
