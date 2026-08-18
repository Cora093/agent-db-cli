import mysql from 'mysql2/promise';
import type {
  ColKind,
  Dialect,
  Conn,
  RunOptions,
  QueryResult,
  TableInfo,
  TableSchema,
  IndexInfo,
  ConstraintInfo,
  ForeignKeyInfo,
  IntrospectionStatus,
} from './types.js';
import type { ResolvedDatasource } from '../config/types.js';
import type { ExecutionPolicy, IntrospectionCapability } from './descriptors.js';
import { AppError } from '../errors.js';
import { createRowCollector, planLimit } from './sql-util.js';
import { classifyMysqlError } from './db-error.js';

export interface FamilyParams {
  defaultPort: number;
  introspection: IntrospectionCapability;
  execution: ExecutionPolicy;
}

export interface MysqlConn extends Conn {
  raw: mysql.Connection;
  database?: string;
  discarded: boolean;
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
    const conn = {
      raw,
      database: cfg.database,
      discarded: false,
      close: async () => {
        if (!conn.discarded && raw.state !== 'disconnected') await raw.end();
      },
    } as MysqlConn;
    return conn;
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

      const boundedSql = planLimit(sql, opts.kind, opts.limit + 1);
      return await readMysqlRows(c.raw, boundedSql, opts, start, () => { c.discarded = true; });
    } catch (err) {
      throw classifyMysqlError(err);
    } finally {
      if (readOnlyTransaction.strength !== 'account-only' && !c.discarded) {
        try {
          await c.raw.query(readOnlyTransaction.rollbackSql);
        } catch {
          /* 已读完,回滚失败忽略 */
        }
      }
    }
  }

  async listNamespaces(conn: Conn) {
    const c = conn as MysqlConn;
    const [rows] = await c.raw.query(
      'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME',
    );
    const system = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
    return {
      status: 'full' as const,
      data: (rows as Record<string, unknown>[]).map((r) => {
        const name = r.SCHEMA_NAME as string;
        return { name, system: system.has(name) };
      }),
    };
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
    if (cols.length === 0) throw new AppError('TABLE_NOT_FOUND', `表不存在: ${target}.${table}`);
    const columns = cols.map((r) => ({
      name: r.COLUMN_NAME as string,
      type: r.COLUMN_TYPE as string,
      nullable: r.IS_NULLABLE === 'YES',
      default: (r.COLUMN_DEFAULT as string) ?? null,
      comment: (r.COLUMN_COMMENT as string) || null,
    }));
    const [tblRows] = await c.raw.query(
      'SELECT TABLE_TYPE, TABLE_COMMENT, VIEW_DEFINITION FROM information_schema.TABLES ' +
        'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [target, table],
    );
    const tbl = (tblRows as Record<string, unknown>[])[0] ?? {};
    const type = (tbl.TABLE_TYPE as string) ?? 'UNKNOWN';
    const comment = (tbl.TABLE_COMMENT as string) || null;
    const viewDefinition = type === 'VIEW' ? ((tbl.VIEW_DEFINITION as string) || null) : null;
    const status: IntrospectionStatus = this.p.introspection;
    const detail = status === 'best-effort' ? 'information_schema support varies by compatible engine' : undefined;
    if (status === 'best-effort') {
      const keyColumns = cols.filter((r) => r.COLUMN_KEY === 'PRI').map((r) => r.COLUMN_NAME as string);
      return {
        schema: target, table, type,
        columns: { status: 'full', data: columns },
        primaryKey: { status, data: keyColumns, detail },
        indexes: { status, data: [], detail },
        constraints: { status, data: [], detail },
        foreignKeys: { status, data: [], detail },
        comment: { status: 'full', data: comment },
        viewDefinition: { status, data: viewDefinition, detail },
      };
    }
    const [idxRows] = await c.raw.query(
      'SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS ' +
        'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX',
      [target, table],
    );
    const indexes = groupIndexes(idxRows as Record<string, unknown>[]);
    let constraints: ConstraintInfo[];
    let constraintsStatus: IntrospectionStatus = 'full';
    let constraintsDetail: string | undefined;
    try {
      const [constraintRows] = await c.raw.query(
        'SELECT tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, kcu.COLUMN_NAME, kcu.ORDINAL_POSITION, cc.CHECK_CLAUSE ' +
          'FROM information_schema.TABLE_CONSTRAINTS tc ' +
          'LEFT JOIN information_schema.KEY_COLUMN_USAGE kcu ON kcu.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA ' +
          'AND kcu.TABLE_NAME=tc.TABLE_NAME AND kcu.CONSTRAINT_NAME=tc.CONSTRAINT_NAME ' +
          'LEFT JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA ' +
          'AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME ' +
          "WHERE tc.TABLE_SCHEMA=? AND tc.TABLE_NAME=? AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY','UNIQUE','CHECK') " +
          'ORDER BY tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION',
        [target, table],
      );
      constraints = groupMysqlConstraints(constraintRows as Record<string, unknown>[]);
    } catch {
      constraintsStatus = 'best-effort';
      constraintsDetail = 'CHECK_CONSTRAINTS is unavailable; PK and unique constraints derived from indexes';
      constraints = indexes
        .filter((index) => index.primary || index.unique)
        .map((index) => ({
          name: index.name,
          type: index.primary ? 'PRIMARY KEY' as const : 'UNIQUE' as const,
          columns: index.columns,
        }));
    }
    const [fkRows] = await c.raw.query(
      'SELECT kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME, kcu.ORDINAL_POSITION, ' +
        'kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME, ' +
        'rc.UPDATE_RULE, rc.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE kcu ' +
        'JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA ' +
        'AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME ' +
        'WHERE kcu.TABLE_SCHEMA=? AND kcu.TABLE_NAME=? AND kcu.REFERENCED_TABLE_NAME IS NOT NULL ' +
        'ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION',
      [target, table],
    );
    const foreignKeys = groupMysqlForeignKeys(fkRows as Record<string, unknown>[]);
    const primaryKey = indexes.find((index) => index.primary)?.columns ?? [];
    return {
      schema: target, table, type,
      columns: { status, data: columns },
      primaryKey: { status, data: primaryKey },
      indexes: { status, data: indexes },
      constraints: { status: constraintsStatus, data: constraints, detail: constraintsDetail },
      foreignKeys: { status, data: foreignKeys },
      comment: { status, data: comment },
      viewDefinition: { status, data: viewDefinition },
    };
  }

}

export interface MysqlEventQuery {
  on(event: 'fields', listener: (fields: mysql.FieldPacket[]) => void): this;
  on(event: 'result', listener: (row: unknown[]) => void): this;
  on(event: 'error', listener: (err: unknown) => void): this;
  on(event: 'end', listener: () => void): this;
}

export interface MysqlCallbackConnection {
  query(opts: { sql: string; rowsAsArray: true; timeout: number }): MysqlEventQuery;
  destroy(): void;
}

export async function readMysqlRows(
  raw: mysql.Connection,
  sql: string,
  opts: RunOptions,
  start: number,
  onDiscard: () => void = () => undefined,
): Promise<QueryResult> {
  const callback = (raw as unknown as { connection: MysqlCallbackConnection }).connection;
  return await new Promise<QueryResult>((resolve, reject) => {
    let settled = false;
    let collector: ReturnType<typeof createRowCollector> | undefined;
    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else if (collector) resolve(collector.finish());
      else reject(new Error('MySQL query ended without field metadata'));
    };
    const discard = () => {
      onDiscard();
      callback.destroy();
    };
    const stop = () => {
      discard();
      finish();
    };
    const query = callback.query({ sql, rowsAsArray: true, timeout: opts.timeoutMs });
    query.on('fields', (fields) => {
      const columns = fields.map((f) => f.name);
      collector = createRowCollector(columns, colKinds(fields), opts.limit, start, {
        onRow: opts.onRow,
        retainRows: opts.retainRows,
      });
    });
    query.on('result', (row) => {
      if (settled) return;
      try {
        if (!collector) throw new Error('MySQL row arrived before field metadata');
        if (!collector.add(row)) stop();
      } catch (err) {
        discard();
        finish(err);
      }
    });
    query.on('error', (err) => finish(err));
    query.on('end', () => finish());
  });
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
function groupMysqlConstraints(rows: Record<string, unknown>[]): ConstraintInfo[] {
  const map = new Map<string, ConstraintInfo>();
  for (const r of rows) {
    const name = r.CONSTRAINT_NAME as string;
    let item = map.get(name);
    if (!item) {
      item = { name, type: r.CONSTRAINT_TYPE as ConstraintInfo['type'], columns: [], definition: (r.CHECK_CLAUSE as string) ?? null };
      map.set(name, item);
    }
    if (r.COLUMN_NAME) item.columns.push(r.COLUMN_NAME as string);
  }
  return [...map.values()];
}

function groupMysqlForeignKeys(rows: Record<string, unknown>[]): ForeignKeyInfo[] {
  const map = new Map<string, ForeignKeyInfo>();
  for (const r of rows) {
    const name = r.CONSTRAINT_NAME as string;
    let item = map.get(name);
    if (!item) {
      item = { name, columns: [], referencedSchema: (r.REFERENCED_TABLE_SCHEMA as string) ?? null, referencedTable: r.REFERENCED_TABLE_NAME as string, referencedColumns: [], onUpdate: (r.UPDATE_RULE as string) ?? null, onDelete: (r.DELETE_RULE as string) ?? null };
      map.set(name, item);
    }
    item.columns.push(r.COLUMN_NAME as string);
    item.referencedColumns.push(r.REFERENCED_COLUMN_NAME as string);
  }
  return [...map.values()];
}
