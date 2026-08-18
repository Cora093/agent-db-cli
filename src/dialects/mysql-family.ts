import mysql from 'mysql2/promise';
import type { ColKind, Dialect, Conn, RunOptions, QueryResult, TableInfo, TableSchema, IndexInfo } from './types.js';
import type { ResolvedDatasource } from '../config/types.js';
import type { DriverName } from '../types.js';
import type { ExecutionPolicy, IntrospectionCapability } from './descriptors.js';
import { AppError } from '../errors.js';
import { applyLimit, mapRows } from './sql-util.js';
import { classifyMysqlError } from './db-error.js';

export interface FamilyParams {
  driver: DriverName;
  defaultPort: number;
  introspection: IntrospectionCapability;
  execution: ExecutionPolicy;
}

interface MysqlConn extends Conn {
  raw: mysql.Connection;
  database?: string;
}

/**
 * mysql2 协议列类型码(field.type,Types 枚举)→ ColKind(A3)。
 * TINY 不特判 tinyint(1) 为 bool(不猜,留数字);未列出的(BLOB/字符串/GEOMETRY 等)→ other。
 */
const MYSQL_TYPE_KINDS: Record<number, ColKind> = {
  0: 'decimal', // DECIMAL
  246: 'decimal', // NEWDECIMAL
  1: 'int', // TINY
  2: 'int', // SHORT
  3: 'int', // LONG
  9: 'int', // INT24
  13: 'int', // YEAR
  8: 'bigint', // LONGLONG
  4: 'float', // FLOAT
  5: 'float', // DOUBLE
  7: 'datetime', // TIMESTAMP
  12: 'datetime', // DATETIME
  10: 'date', // DATE
  14: 'date', // NEWDATE
  245: 'json', // JSON
};

function colKinds(fields: mysql.FieldPacket[]): ColKind[] {
  return fields.map((f) => {
    const code = (f as { columnType?: number; type?: number }).columnType ?? f.type;
    return (code !== undefined && MYSQL_TYPE_KINDS[code]) || 'other';
  });
}

/** MySQL 协议族共享传输(§4):mysql / doris / starrocks / tidb / oceanbase。 */
export class MysqlFamilyDialect implements Dialect {
  constructor(private readonly p: FamilyParams) {}

  get driver(): DriverName {
    return this.p.driver;
  }

  async connect(cfg: ResolvedDatasource): Promise<Conn> {
    let raw: mysql.Connection;
    try {
      raw = await mysql.createConnection({
        host: cfg.host,
        port: cfg.port ?? this.p.defaultPort,
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
        // 精度保真:DECIMAL/BIGINT 取字符串;日期/时间取文本直传(B1,不经 Date 贴 Z)。
        // timezone 仅影响 mysql2 的 JS Date 互转,不改服务端会话 time_zone;
        // TIMESTAMP 列的文本随会话时区渲染(见 references/dialects.md)。
        supportBigNumbers: true,
        bigNumberStrings: true,
        decimalNumbers: false,
        dateStrings: true,
        timezone: 'Z',
        ...cfg.safeOptions, // 白名单 + 强制 multipleStatements:false
      });
    } catch (err) {
      throw classifyMysqlError(err, 'connect');
    }
    return {
      driver: this.driver,
      raw,
      database: cfg.database,
      close: async () => {
        await raw.end();
      },
    } as MysqlConn;
  }

  async runReadOnly(conn: Conn, sql: string, opts: RunOptions): Promise<QueryResult> {
    const c = conn as MysqlConn;
    const start = Date.now();
    const { timeout, readOnlyTransaction } = this.p.execution;
    try {
      if (timeout.unit !== 'none') await c.raw.query(timeout.sql(opts.timeoutMs));
      if (readOnlyTransaction.strength !== 'account-only') {
        await c.raw.query(readOnlyTransaction.beginSql);
      }

      const execSql = applyLimit(sql, opts.kind, opts.limit + 1);
      const [rows, fields] = await c.raw.query({ sql: execSql, rowsAsArray: true });
      const fieldArr = (fields as mysql.FieldPacket[] | undefined) ?? [];
      const columns = fieldArr.map((f) => f.name);

      return mapRows((rows as unknown[][]) ?? [], columns, colKinds(fieldArr), opts.limit, start);
    } catch (err) {
      throw classifyMysqlError(err);
    } finally {
      if (readOnlyTransaction.strength !== 'account-only') {
        try {
          await c.raw.query(readOnlyTransaction.rollbackSql);
        } catch {
          /* 已读完,回滚失败忽略 */
        }
      }
    }
  }

  async listTables(conn: Conn, like?: string): Promise<TableInfo[]> {
    const c = conn as MysqlConn;
    const schema = c.database ?? (await currentDatabase(c.raw));
    let sql =
      'SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_COMMENT ' +
      'FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?';
    const params: unknown[] = [schema];
    if (like) {
      sql += ' AND TABLE_NAME LIKE ?';
      params.push(like);
    }
    sql += ' ORDER BY TABLE_NAME';
    const [rows] = await c.raw.query(sql, params);
    return (rows as Record<string, unknown>[]).map((r) => ({
      schema: (r.TABLE_SCHEMA as string) ?? null,
      name: r.TABLE_NAME as string,
      type: (r.TABLE_TYPE as string) ?? undefined,
      comment: (r.TABLE_COMMENT as string) || null,
    }));
  }

  async getSchema(conn: Conn, table: string, schema?: string): Promise<TableSchema> {
    const c = conn as MysqlConn;
    const target = await resolveSchema(c, table, schema);

    const [colRows] = await c.raw.query(
      'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, COLUMN_COMMENT ' +
        'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [target, table],
    );
    const cols = colRows as Record<string, unknown>[];
    if (cols.length === 0) {
      throw new AppError('TABLE_NOT_FOUND', `表不存在: ${target}.${table}`);
    }

    const columns = cols.map((r) => ({
      name: r.COLUMN_NAME as string,
      type: r.COLUMN_TYPE as string,
      nullable: r.IS_NULLABLE === 'YES',
      default: (r.COLUMN_DEFAULT as string) ?? null,
      comment: (r.COLUMN_COMMENT as string) || null,
    }));
    const primaryKey = cols.filter((r) => r.COLUMN_KEY === 'PRI').map((r) => r.COLUMN_NAME as string);

    const [tblRows] = await c.raw.query(
      'SELECT TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [target, table],
    );
    const comment = ((tblRows as Record<string, unknown>[])[0]?.TABLE_COMMENT as string) || null;

    if (this.p.introspection === 'best-effort') {
      return {
        schema: target,
        table,
        columns,
        primaryKey,
        indexes: 'N/A',
        comment,
        note: '索引/主键(sort-key)best-effort,完整定义见 SHOW CREATE TABLE',
      };
    }

    const [idxRows] = await c.raw.query(
      'SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME ' +
        'FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ' +
        'ORDER BY INDEX_NAME, SEQ_IN_INDEX',
      [target, table],
    );
    const indexes = groupIndexes(idxRows as Record<string, unknown>[]);

    return { schema: target, table, columns, primaryKey, indexes, comment };
  }

}

async function currentDatabase(raw: mysql.Connection): Promise<string> {
  const [rows] = await raw.query('SELECT DATABASE() AS db');
  const db = (rows as Record<string, unknown>[])[0]?.db as string | null;
  if (!db) {
    throw new AppError('BAD_USAGE', '未指定 database,且连接无默认库', {
      hint: '在数据源配置里设置 database,或用 schema.table 指定',
    });
  }
  return db;
}

async function resolveSchema(c: MysqlConn, table: string, schema?: string): Promise<string> {
  if (schema) return schema;
  if (c.database) return c.database;
  // 跨库发现:可能歧义
  const [rows] = await c.raw.query(
    'SELECT TABLE_SCHEMA FROM information_schema.TABLES WHERE TABLE_NAME = ?',
    [table],
  );
  const schemas = (rows as Record<string, unknown>[]).map((r) => r.TABLE_SCHEMA as string);
  if (schemas.length === 0) throw new AppError('TABLE_NOT_FOUND', `表不存在: ${table}`);
  if (schemas.length > 1) {
    throw new AppError('AMBIGUOUS_TABLE', `表 '${table}' 存在于多个 schema: ${schemas.join(', ')}`, {
      hint: '请加 --schema <name> 或用 schema.table',
    });
  }
  return schemas[0];
}

function groupIndexes(rows: Record<string, unknown>[]): IndexInfo[] {
  const map = new Map<string, IndexInfo>();
  for (const r of rows) {
    const name = r.INDEX_NAME as string;
    let idx = map.get(name);
    if (!idx) {
      idx = { name, columns: [], unique: r.NON_UNIQUE === 0, primary: name === 'PRIMARY' };
      map.set(name, idx);
    }
    idx.columns.push(r.COLUMN_NAME as string);
  }
  return [...map.values()];
}
