import type { DriverName, SqlValue, StatementKind } from '../types.js';
import type { ResolvedDatasource } from '../config/types.js';

/**
 * 不透明连接句柄。每个 Dialect 内部实现自己的具体连接(mysql2 / pg / dmdb),
 * 对上层只暴露 close()。Dialect 方法内部 downcast 回自己的具体类型。
 */
export interface Conn {
  readonly driver: DriverName;
  close(): Promise<void>;
}

export interface RunOptions {
  /** 守卫给出的语句类别,决定是否做 LIMIT 改写 */
  kind: StatementKind;
  /** 行数硬顶;内部会取 limit+1 行用于判 truncated */
  limit: number;
  /** 服务端超时(毫秒);各策略自换算单位 */
  timeoutMs: number;
}

/**
 * 驱动原生列类型 → 内部类别(A3)。归一化策略集中在 normalizeValue(raw, kind),
 * 引擎差异只剩「native 类型 → ColKind」映射(各 dialect 自实现)。
 */
export type ColKind =
  | 'int'
  | 'bigint'
  | 'decimal'
  | 'float'
  | 'bool'
  | 'json'
  | 'array'
  | 'date'
  | 'datetime'
  | 'other';

export interface QueryResult {
  columns: string[];
  /** 已按 ColKind 归一化的行;最多 limit 行(若发生截断则恰为 limit 行) */
  rows: SqlValue[][];
  /** 是否还有超过 limit 的行被丢弃 */
  truncated: boolean;
  /** 服务端 + 传输耗时(ms) */
  ms: number;
}

export interface TableInfo {
  /** schema/database 限定;无则 null */
  schema: string | null;
  name: string;
  /** 'BASE TABLE' | 'VIEW' 等,best-effort */
  type?: string;
  comment?: string | null;
}

export interface ColumnInfo {
  name: string;
  /** 原始 DB 类型串(如 varchar(255)、numeric(10,2)) */
  type: string;
  nullable: boolean;
  default?: string | null;
  comment?: string | null;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface TableSchema {
  schema: string | null;
  table: string;
  columns: ColumnInfo[];
  /** 主键列名;空数组表示无主键或 best-effort 未知 */
  primaryKey: string[];
  /** 'N/A' 表示 best-effort 引擎不自省索引(见 note) */
  indexes: IndexInfo[] | 'N/A';
  comment?: string | null;
  /** best-effort 引擎的兜底提示,如 "索引/主键见 SHOW CREATE TABLE" */
  note?: string;
}

/**
 * 唯一的 DB 抽象点(§4)。所有引擎差异收敛到这里;
 * 上层只面向接口,由注册表按 driver 分发。
 */
export interface Dialect {
  readonly driver: DriverName;

  connect(cfg: ResolvedDatasource): Promise<Conn>;

  /** 包只读事务 + 服务端超时 + 限行;读完 ROLLBACK。 */
  runReadOnly(conn: Conn, sql: string, opts: RunOptions): Promise<QueryResult>;

  // —— 引擎语义:策略差异点(主要由 runReadOnly 内部使用,导出便于测试) ——
  /** 开只读事务的 SQL,如 'START TRANSACTION READ ONLY';null=不包显式只读事务(OLAP) */
  readOnlyTxnSQL(): string | null;
  /** 是否必须 autoCommit=false 才能让只读事务跨语句生效(DM=true) */
  needsAutocommitOff(): boolean;
  /** 服务端超时 SQL;入参恒为毫秒,策略内自换算单位;null=不通过 SQL 设置 */
  statementTimeoutSQL(ms: number): string | null;

  listTables(conn: Conn, like?: string): Promise<TableInfo[]>;
  getSchema(conn: Conn, table: string, schema?: string): Promise<TableSchema>;

  mapType(raw: unknown): SqlValue;
}
