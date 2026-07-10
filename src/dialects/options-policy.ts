import type { DriverName } from '../types.js';

export interface OptionPolicy {
  /** 允许从 config.options 透传给驱动的键 */
  allow: string[];
  /** spread 之后强制回写的安全字段 */
  force: Record<string, unknown>;
}

/** MySQL 协议族共享传输 → 共享 mysql2 连接选项策略(§4/§7)。 */
const MYSQL_FAMILY: OptionPolicy = {
  allow: ['connectTimeout', 'charset', 'timezone', 'socketPath'],
  // multipleStatements 必须为 false:多语句防线的驱动层兜底(§7 层 ④)
  force: { multipleStatements: false },
};

const POSTGRES: OptionPolicy = {
  // pg 无 multipleStatements 开关;多语句靠守卫 + 只读事务挡
  allow: ['connectionTimeoutMillis', 'application_name', 'client_encoding'],
  force: {},
};

const DM: OptionPolicy = {
  // dmdb 连接选项保守白名单;autoCommit=false 由 dialect 在连接时设定
  // loginEncrypt:新版 Node(OpenSSL3)下默认 true 会因 legacy cipher 连接失败([6071]),
  // 允许按源关闭(链路可信/已走 SSL 时);见 dm.ts 默认值与 classifyDmError 提示
  allow: ['connectTimeout', 'loginTimeout', 'loginEncrypt'],
  force: {},
};

const POLICIES: Record<DriverName, OptionPolicy> = {
  mysql: MYSQL_FAMILY,
  doris: MYSQL_FAMILY,
  starrocks: MYSQL_FAMILY,
  tidb: MYSQL_FAMILY,
  oceanbase: MYSQL_FAMILY,
  postgres: POSTGRES,
  dm: DM,
};

export function optionPolicy(driver: DriverName): OptionPolicy {
  return POLICIES[driver];
}
