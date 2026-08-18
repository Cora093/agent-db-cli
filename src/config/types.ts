import type { DriverName } from '../types.js';

/**
 * 配置文件里单个数据源的形态(§5)。
 * `id` 来自 datasources map 的 key,加载时注入。
 */
export interface DatasourceConfig {
  /** 命令行句柄,短 ASCII(由 map key 注入) */
  id: string;
  /** 可选,人话业务名;缺省时 list 回退显示 id */
  label?: string;
  driver: DriverName;
  host: string;
  port?: number;
  /** 连接目标:MySQL=命名空间 / PG=数据库 / DM 可省 */
  database?: string;
  /** 可选,裸表名默认命名空间(PG schema / DM user-schema;MySQL 不适用) */
  schema?: string;
  user: string;
  /** 原始值,可能是 "env:VAR" 引用;由 secret resolver 解析 */
  password?: string;
  /** 连接调优,仅白名单键透传(§7) */
  options?: Record<string, unknown>;
  /** 可选,本源默认服务端超时(秒),有硬顶 */
  timeout?: number;
}

/** 解析后(密码已取出、默认已套用)的数据源,供 Dialect.connect 使用。 */
export interface ResolvedDatasource extends Omit<DatasourceConfig, 'password'> {
  /** 已解析的明文密码(可能为空字符串) */
  password: string;
  /** 已过白名单 + 安全字段回写的连接选项 */
  safeOptions: Record<string, unknown>;
}

export type Datasources = Record<string, DatasourceConfig>;
