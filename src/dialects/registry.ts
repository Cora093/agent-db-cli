import type { Dialect } from './types.js';
import type { DriverName } from '../types.js';
import { AppError } from '../errors.js';
import { MysqlFamilyDialect } from './mysql-family.js';
import { PgDialect } from './postgres.js';
import { DmDialect } from './dm.js';

// —— 服务端超时换算(入参恒毫秒,§7)——
const msTimeout = (varName: string) => (ms: number) => `SET SESSION ${varName} = ${ms}`;
const secTimeout = (varName: string) => (ms: number) => `SET ${varName} = ${Math.ceil(ms / 1000)}`;
const usTimeout = (varName: string) => (ms: number) => `SET ${varName} = ${ms * 1000}`;

const RO_TXN = 'START TRANSACTION READ ONLY';

/**
 * 方言注册表(§4)。新增数据库 = 写一个策略 + 在此注册一行,不动上层。
 * 用 getter 惰性构造,避免在不需要某方言时实例化。
 */
const DIALECTS: Record<DriverName, () => Dialect> = {
  mysql: () =>
    new MysqlFamilyDialect({
      driver: 'mysql',
      readOnlyTxn: RO_TXN,
      timeoutSql: msTimeout('max_execution_time'),
      introspection: 'full',
    }),
  tidb: () =>
    new MysqlFamilyDialect({
      driver: 'tidb',
      readOnlyTxn: RO_TXN,
      timeoutSql: msTimeout('max_execution_time'),
      introspection: 'full',
    }),
  oceanbase: () =>
    new MysqlFamilyDialect({
      driver: 'oceanbase',
      readOnlyTxn: RO_TXN,
      timeoutSql: usTimeout('ob_query_timeout'),
      introspection: 'best-effort',
    }),
  doris: () =>
    new MysqlFamilyDialect({
      driver: 'doris',
      readOnlyTxn: null, // OLAP:跳过显式只读事务,靠 ① 只读账号
      timeoutSql: secTimeout('query_timeout'),
      introspection: 'best-effort',
    }),
  starrocks: () =>
    new MysqlFamilyDialect({
      driver: 'starrocks',
      readOnlyTxn: null,
      timeoutSql: secTimeout('query_timeout'),
      introspection: 'best-effort',
    }),
  postgres: () => new PgDialect(),
  dm: () => new DmDialect(),
};

export function getDialect(driver: DriverName): Dialect {
  const factory = DIALECTS[driver];
  if (!factory) {
    throw new AppError('INTERNAL', `未注册的 driver: ${driver}`);
  }
  return factory();
}
