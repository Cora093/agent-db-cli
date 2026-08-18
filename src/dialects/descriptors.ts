import { AppError } from '../errors.js';
import type { DriverName } from '../types.js';
import { DmDialect } from './dm.js';
import { MysqlFamilyDialect } from './mysql-family.js';
import { PgDialect } from './postgres.js';
import type { Dialect } from './types.js';

export type ProtocolProfile = 'mysql' | 'postgres' | 'dm';
export type IntrospectionCapability = 'full' | 'best-effort';
export type ReadOnlyTransactionStrength = 'strong' | 'dml-only' | 'account-only';
export type TimeoutUnit = 'milliseconds' | 'seconds' | 'microseconds' | 'none';
export type LimitCapability = 'sql-rewrite' | 'sql-rewrite+driver-max-rows';

export interface LexProfile {
  readonly hashComment: boolean;
  readonly dashNeedsWhitespace: boolean;
  readonly backslashEscape: boolean;
  readonly dollarQuote: boolean;
  readonly backtickQuote: boolean;
}

export interface OptionPolicy {
  readonly allow: readonly string[];
  readonly force: Readonly<Record<string, unknown>>;
}

export type TimeoutPolicy =
  | { readonly unit: 'none' }
  | {
      readonly unit: Exclude<TimeoutUnit, 'none'>;
      readonly sql: (timeoutMs: number) => string;
    };

export type ReadOnlyTransactionPolicy =
  | { readonly strength: 'account-only' }
  | {
      readonly strength: Exclude<ReadOnlyTransactionStrength, 'account-only'>;
      readonly beginSql: string;
      readonly rollbackSql: string;
      readonly autoCommit: boolean;
    };

export interface ExecutionPolicy {
  readonly timeout: TimeoutPolicy;
  readonly readOnlyTransaction: ReadOnlyTransactionPolicy;
}

export interface DriverCapabilities {
  readonly introspection: IntrospectionCapability;
  readonly readOnlyTransaction: ReadOnlyTransactionStrength;
  readonly timeoutUnit: TimeoutUnit;
  readonly cancellation: 'connection-close';
  readonly limit: LimitCapability;
}

export interface DriverDescriptor {
  readonly name: DriverName;
  readonly protocol: ProtocolProfile;
  readonly lex: LexProfile;
  readonly connection: {
    readonly defaultPort: number;
    readonly options: OptionPolicy;
  };
  readonly execution: ExecutionPolicy;
  readonly capabilities: DriverCapabilities;
  readonly createDialect: () => Dialect;
}

const MYSQL_LEX: LexProfile = {
  hashComment: true,
  dashNeedsWhitespace: true,
  backslashEscape: true,
  dollarQuote: false,
  backtickQuote: true,
};
const PG_LEX: LexProfile = {
  hashComment: false,
  dashNeedsWhitespace: false,
  backslashEscape: false,
  dollarQuote: true,
  backtickQuote: false,
};
const DM_LEX: LexProfile = {
  hashComment: false,
  dashNeedsWhitespace: true,
  backslashEscape: false,
  dollarQuote: false,
  backtickQuote: false,
};

const MYSQL_OPTIONS: OptionPolicy = {
  allow: ['connectTimeout', 'charset', 'timezone', 'socketPath'],
  force: { multipleStatements: false },
};
const POSTGRES_OPTIONS: OptionPolicy = {
  allow: ['connectionTimeoutMillis', 'application_name', 'client_encoding'],
  force: {},
};
const DM_OPTIONS: OptionPolicy = {
  allow: ['connectTimeout', 'loginTimeout', 'loginEncrypt'],
  force: {},
};

const mysqlTimeout = (variable: string): TimeoutPolicy => ({
  unit: 'milliseconds',
  sql: (ms) => `SET SESSION ${variable} = ${ms}`,
});
const secondsTimeout = (variable: string): TimeoutPolicy => ({
  unit: 'seconds',
  sql: (ms) => `SET ${variable} = ${Math.ceil(ms / 1000)}`,
});
const microsecondsTimeout = (variable: string): TimeoutPolicy => ({
  unit: 'microseconds',
  sql: (ms) => `SET ${variable} = ${ms * 1000}`,
});
const explicitTransaction = (
  strength: Exclude<ReadOnlyTransactionStrength, 'account-only'>,
  beginSql: string,
  autoCommit = true,
): ReadOnlyTransactionPolicy => ({ strength, beginSql, rollbackSql: 'ROLLBACK', autoCommit });

function defineDescriptor(config: {
  name: DriverName;
  protocol: ProtocolProfile;
  lex: LexProfile;
  defaultPort: number;
  options: OptionPolicy;
  introspection: IntrospectionCapability;
  execution: ExecutionPolicy;
  limit: LimitCapability;
  createDialect: (runtime: {
    driver: DriverName;
    defaultPort: number;
    introspection: IntrospectionCapability;
    execution: ExecutionPolicy;
  }) => Dialect;
}): DriverDescriptor {
  const runtime = {
    driver: config.name,
    defaultPort: config.defaultPort,
    introspection: config.introspection,
    execution: config.execution,
  };
  return {
    name: config.name,
    protocol: config.protocol,
    lex: config.lex,
    connection: { defaultPort: config.defaultPort, options: config.options },
    execution: config.execution,
    capabilities: {
      introspection: config.introspection,
      readOnlyTransaction: config.execution.readOnlyTransaction.strength,
      timeoutUnit: config.execution.timeout.unit,
      cancellation: 'connection-close',
      limit: config.limit,
    },
    createDialect: () => config.createDialect(runtime),
  };
}

const mysqlDescriptor = (
  name: Extract<DriverName, 'mysql' | 'doris' | 'starrocks' | 'tidb' | 'oceanbase'>,
  config: {
    introspection: IntrospectionCapability;
    timeout: TimeoutPolicy;
    readOnlyTransaction: ReadOnlyTransactionPolicy;
  },
): DriverDescriptor =>
  defineDescriptor({
    name,
    protocol: 'mysql',
    lex: MYSQL_LEX,
    defaultPort: 3306,
    options: MYSQL_OPTIONS,
    introspection: config.introspection,
    execution: { timeout: config.timeout, readOnlyTransaction: config.readOnlyTransaction },
    limit: 'sql-rewrite',
    createDialect: (runtime) => new MysqlFamilyDialect(runtime),
  });

const MYSQL_READ_ONLY = explicitTransaction('dml-only', 'START TRANSACTION READ ONLY');
const ACCOUNT_ONLY: ReadOnlyTransactionPolicy = { strength: 'account-only' };

export const DRIVER_DESCRIPTORS = {
  mysql: mysqlDescriptor('mysql', {
    timeout: mysqlTimeout('max_execution_time'),
    readOnlyTransaction: MYSQL_READ_ONLY,
    introspection: 'full',
  }),
  doris: mysqlDescriptor('doris', {
    timeout: secondsTimeout('query_timeout'),
    readOnlyTransaction: ACCOUNT_ONLY,
    introspection: 'best-effort',
  }),
  starrocks: mysqlDescriptor('starrocks', {
    timeout: secondsTimeout('query_timeout'),
    readOnlyTransaction: ACCOUNT_ONLY,
    introspection: 'best-effort',
  }),
  tidb: mysqlDescriptor('tidb', {
    timeout: mysqlTimeout('max_execution_time'),
    readOnlyTransaction: MYSQL_READ_ONLY,
    introspection: 'full',
  }),
  oceanbase: mysqlDescriptor('oceanbase', {
    timeout: microsecondsTimeout('ob_query_timeout'),
    readOnlyTransaction: MYSQL_READ_ONLY,
    introspection: 'best-effort',
  }),
  postgres: defineDescriptor({
    name: 'postgres',
    protocol: 'postgres',
    lex: PG_LEX,
    defaultPort: 5432,
    options: POSTGRES_OPTIONS,
    introspection: 'full',
    execution: {
      timeout: { unit: 'milliseconds', sql: (ms) => `SET statement_timeout = ${ms}` },
      readOnlyTransaction: explicitTransaction('strong', 'BEGIN READ ONLY'),
    },
    limit: 'sql-rewrite',
    createDialect: (runtime) => new PgDialect(runtime),
  }),
  dm: defineDescriptor({
    name: 'dm',
    protocol: 'dm',
    lex: DM_LEX,
    defaultPort: 5236,
    options: DM_OPTIONS,
    introspection: 'best-effort',
    execution: {
      timeout: { unit: 'none' },
      readOnlyTransaction: explicitTransaction('strong', 'SET TRANSACTION READ ONLY', false),
    },
    limit: 'sql-rewrite+driver-max-rows',
    createDialect: (runtime) => new DmDialect(runtime),
  }),
} as const satisfies Record<DriverName, DriverDescriptor>;

export const DRIVER_NAMES = Object.freeze(Object.keys(DRIVER_DESCRIPTORS) as DriverName[]);

export function isDriverName(value: string): value is DriverName {
  return Object.hasOwn(DRIVER_DESCRIPTORS, value);
}

export function getDriverDescriptor(driver: DriverName): DriverDescriptor {
  const descriptor = DRIVER_DESCRIPTORS[driver];
  if (!descriptor) throw new AppError('INTERNAL', `未注册的 driver: ${driver}`);
  return descriptor;
}
