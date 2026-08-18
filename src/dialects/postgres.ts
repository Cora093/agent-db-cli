import pg from 'pg';
import Cursor from 'pg-cursor';
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
} from './types.js';
import type { ResolvedDatasource } from '../config/types.js';
import type { DriverName } from '../types.js';
import type { ExecutionPolicy } from './descriptors.js';
import { AppError } from '../errors.js';
import { createRowCollector, planLimit } from './sql-util.js';
import { classifyPgError } from './db-error.js';

export interface PgConn extends Conn {
  raw: pg.Client;
  defaultSchema?: string;
}

// —— OID → ColKind(A3)。numeric/int8 维持 pg 默认字符串,由 normalize 按 kind 收敛。 ——
const PG_OID_KINDS: Record<number, ColKind> = {
  21: 'int', // int2
  23: 'int', // int4
  20: 'bigint', // int8
  1700: 'decimal', // numeric
  700: 'float', // float4
  701: 'float', // float8
  16: 'bool',
  114: 'json',
  3802: 'json', // jsonb
  1082: 'date',
  1114: 'datetime', // timestamp(无时区)
  1184: 'datetime', // timestamptz(per-client parser 已转 UTC ISO 文本)
  // 数组族
  1000: 'array', // bool[]
  1005: 'array', // int2[]
  1007: 'array', // int4[]
  1016: 'array', // int8[]
  1021: 'array', // float4[]
  1022: 'array', // float8[]
  1231: 'array', // numeric[]
  1009: 'array', // text[]
  1015: 'array', // varchar[]
  199: 'array', // json[]
  3807: 'array', // jsonb[]
  1115: 'array', // timestamp[]
  1182: 'array', // date[]
  1185: 'array', // timestamptz[]
};

function pgColKinds(fields: { dataTypeID: number }[]): ColKind[] {
  return fields.map((f) => PG_OID_KINDS[f.dataTypeID] ?? 'other');
}

const identity = (v: string) => v;

/** timestamptz 文本(如 '2026-06-08 18:00:00.123+08')→ UTC ISO;解析失败原样直传。 */
function tzTextToUtcIso(v: string): string {
  let iso = v.replace(' ', 'T');
  if (/[+-]\d{2}$/.test(iso)) iso += ':00'; // V8 旧式解析器外的稳妥:补全 ±HH:MM
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}

/**
 * per-client 类型解析(B1,不动 pg 全局 parser):
 *   date / 无时区 timestamp → 文本直传(不经 Date,不贴 Z);
 *   timestamptz → UTC ISO(真正的绝对时刻才标 Z)。
 */
const PG_TYPES: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: string) => {
    if (format !== 'binary') {
      if (oid === 1082 || oid === 1114) return identity;
      if (oid === 1184) return tzTextToUtcIso;
    }
    return (pg.types.getTypeParser as (oid: number, format?: string) => unknown)(oid, format);
  }) as pg.CustomTypesConfig['getTypeParser'],
};

/** PostgreSQL 方言。命名空间=schema(在 database 内);裸表名按 search_path / 配置 schema。 */
export class PgDialect implements Dialect {
  constructor(private readonly config: { defaultPort: number; execution: ExecutionPolicy }) {}

  get driver(): DriverName {
    return 'postgres';
  }

  async connect(cfg: ResolvedDatasource): Promise<Conn> {
    const client = new pg.Client({
      host: cfg.host,
      port: cfg.port ?? this.config.defaultPort,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      types: PG_TYPES,
      ...cfg.safeOptions,
    });
    try {
      await client.connect();
    } catch (err) {
      throw classifyPgError(err, 'connect');
    }
    return {
      driver: 'postgres',
      raw: client,
      defaultSchema: cfg.schema,
      close: async () => {
        await client.end();
      },
    } as PgConn;
  }

  async runReadOnly(conn: Conn, sql: string, opts: RunOptions): Promise<QueryResult> {
    const c = conn as PgConn;
    const start = Date.now();
    let inTxn = false;
    const { timeout, readOnlyTransaction } = this.config.execution;
    try {
      if (timeout.unit !== 'none') await c.raw.query(timeout.sql(opts.timeoutMs));
      if (readOnlyTransaction.strength !== 'account-only') {
        await c.raw.query(readOnlyTransaction.beginSql);
        inTxn = true;
      }
      if (c.defaultSchema) {
        // 设置裸表名默认 schema(search_path);标识符做基本清洗
        await c.raw.query(`SET search_path TO ${quoteIdent(c.defaultSchema)}`);
      }

      const plan = planLimit(sql, opts.kind, opts.limit + 1);
      return await readPgRows(c.raw, plan.sql, opts, start);
    } catch (err) {
      throw classifyPgError(err);
    } finally {
      if (inTxn) {
        try {
          if (readOnlyTransaction.strength !== 'account-only') {
            await c.raw.query(readOnlyTransaction.rollbackSql);
          }
        } catch {
          /* ignore */
        }
      }
    }
  }

  async listNamespaces(conn: Conn) {
    const c = conn as PgConn;
    const res = await c.raw.query(
      `SELECT nspname AS name FROM pg_namespace WHERE has_schema_privilege(nspname, 'USAGE') ORDER BY nspname`,
    );
    return {
      status: 'full' as const,
      data: res.rows.map((r) => ({
        name: r.name as string,
        system: (r.name as string) === 'information_schema' || (r.name as string).startsWith('pg_'),
      })),
    };
  }

  async listTables(conn: Conn, like?: string): Promise<TableInfo[]> {
    const c = conn as PgConn;
    let sql =
      `SELECT n.nspname AS schema, c.relname AS name,
              CASE c.relkind WHEN 'r' THEN 'BASE TABLE' WHEN 'v' THEN 'VIEW'
                             WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE c.relkind::text END AS type,
              obj_description(c.oid) AS comment
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','v','m','p')
         AND n.nspname NOT IN ('pg_catalog','information_schema')
         AND n.nspname NOT LIKE 'pg_toast%'`;
    const params: unknown[] = [];
    if (c.defaultSchema) {
      params.push(c.defaultSchema);
      sql += ` AND n.nspname = $${params.length}`;
    }
    if (like) {
      params.push(like);
      sql += ` AND c.relname LIKE $${params.length}`;
    }
    sql += ' ORDER BY n.nspname, c.relname';
    const res = await c.raw.query(sql, params);
    return res.rows.map((r) => ({
      schema: r.schema as string,
      name: r.name as string,
      type: r.type as string,
      comment: (r.comment as string) || null,
    }));
  }

  async getSchema(conn: Conn, table: string, schema?: string): Promise<TableSchema> {
    const c = conn as PgConn;
    const target = await resolvePgSchema(c, table, schema);
    const colRes = await c.raw.query(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS default,
              col_description(a.attrelid, a.attnum) AS comment
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [target, table],
    );
    if (colRes.rows.length === 0) throw new AppError('TABLE_NOT_FOUND', `表不存在: ${target}.${table}`);
    const columns = colRes.rows.map((r) => ({ name: r.name as string, type: r.type as string, nullable: !(r.notnull as boolean), default: (r.default as string) ?? null, comment: (r.comment as string) || null }));
    const idxRes = await c.raw.query(
      `SELECT i.relname AS name, ix.indisunique AS unique, ix.indisprimary AS primary,
              pg_get_indexdef(ix.indexrelid) AS definition,
              pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
              ARRAY(
                SELECT pg_get_indexdef(ix.indexrelid, key.ordinality::integer, true)
                FROM generate_series(1, ix.indnatts) WITH ORDINALITY AS key(position, ordinality)
                ORDER BY key.ordinality
              ) AS columns
       FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = $2 ORDER BY i.relname`,
      [target, table],
    );
    const indexes = idxRes.rows.map((r): IndexInfo => ({
      name: r.name as string,
      columns: r.columns as string[],
      unique: r.unique as boolean,
      primary: r.primary as boolean,
      definition: r.definition as string,
      predicate: (r.predicate as string) ?? null,
    }));
    const constraintRes = await c.raw.query(
      `SELECT con.conname AS name, con.contype AS type, pg_get_constraintdef(con.oid) AS definition,
              ARRAY(SELECT att.attname FROM unnest(con.conkey) WITH ORDINALITY AS keys(attnum, ord)
                    JOIN pg_attribute att ON att.attrelid=con.conrelid AND att.attnum=keys.attnum ORDER BY keys.ord) AS columns
       FROM pg_constraint con JOIN pg_class t ON t.oid=con.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
       WHERE n.nspname=$1 AND t.relname=$2 AND con.contype IN ('p','u','c') ORDER BY con.conname`,
      [target, table],
    );
    const constraints = constraintRes.rows.map((r): ConstraintInfo => ({ name: r.name as string, type: r.type === 'p' ? 'PRIMARY KEY' : r.type === 'u' ? 'UNIQUE' : 'CHECK', columns: r.columns as string[], definition: (r.definition as string) ?? null }));
    const fkRes = await c.raw.query(
      `SELECT con.conname AS name, rn.nspname AS referenced_schema, rt.relname AS referenced_table,
              con.confupdtype AS update_action, con.confdeltype AS delete_action,
              ARRAY(SELECT att.attname FROM unnest(con.conkey) WITH ORDINALITY AS keys(attnum, ord)
                    JOIN pg_attribute att ON att.attrelid=con.conrelid AND att.attnum=keys.attnum ORDER BY keys.ord) AS columns,
              ARRAY(SELECT att.attname FROM unnest(con.confkey) WITH ORDINALITY AS keys(attnum, ord)
                    JOIN pg_attribute att ON att.attrelid=con.confrelid AND att.attnum=keys.attnum ORDER BY keys.ord) AS referenced_columns
       FROM pg_constraint con JOIN pg_class t ON t.oid=con.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
       JOIN pg_class rt ON rt.oid=con.confrelid JOIN pg_namespace rn ON rn.oid=rt.relnamespace
       WHERE n.nspname=$1 AND t.relname=$2 AND con.contype='f' ORDER BY con.conname`,
      [target, table],
    );
    const action = (v: string) => ({ a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' })[v] ?? v;
    const foreignKeys = fkRes.rows.map((r): ForeignKeyInfo => ({ name: r.name as string, columns: r.columns as string[], referencedSchema: r.referenced_schema as string, referencedTable: r.referenced_table as string, referencedColumns: r.referenced_columns as string[], onUpdate: action(r.update_action as string), onDelete: action(r.delete_action as string) }));
    const metaRes = await c.raw.query(
      `SELECT CASE c.relkind WHEN 'r' THEN 'BASE TABLE' WHEN 'p' THEN 'PARTITIONED TABLE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE c.relkind::text END AS type,
              obj_description(c.oid) AS comment,
              CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid, true) ELSE NULL END AS view_definition
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2`,
      [target, table],
    );
    const meta = metaRes.rows[0];
    const full = <T>(data: T) => ({ status: 'full' as const, data });
    return { schema: target, table, type: meta.type as string, columns: full(columns), primaryKey: full(constraints.find((x) => x.type === 'PRIMARY KEY')?.columns ?? []), indexes: full(indexes), constraints: full(constraints), foreignKeys: full(foreignKeys), comment: full((meta.comment as string) || null), viewDefinition: full((meta.view_definition as string) || null) };
  }

}

export interface PgRowCursor {
  readonly fields: { name: string; dataTypeID: number }[];
  read(count: number): Promise<unknown[][]>;
  close(): Promise<void>;
}

export async function collectPgCursor(
  cursor: PgRowCursor,
  opts: RunOptions,
  start: number,
): Promise<QueryResult> {
  let collector: ReturnType<typeof createRowCollector> | undefined;
  try {
    while (true) {
      const batch = (await cursor.read(16)) as unknown[][];
      if (batch.length === 0) break;
      const fields = cursor.fields;
      if (!collector) {
        const columns = fields.map((f) => f.name);
        collector = createRowCollector(columns, pgColKinds(fields), opts.limit, start, {
          onRow: opts.onRow,
          retainRows: opts.retainRows,
        });
      }
      for (const row of batch) {
        if (!collector.add(row)) {
          await cursor.close();
          return collector.finish();
        }
      }
    }
    if (!collector) {
      const fields = cursor.fields;
      collector = createRowCollector(fields.map((field) => field.name), pgColKinds(fields), opts.limit, start);
    }
    await cursor.close();
    return collector.finish();
  } catch (err) {
    await cursor.close().catch(() => undefined);
    throw err;
  }
}

async function readPgRows(
  raw: pg.Client,
  sql: string,
  opts: RunOptions,
  start: number,
): Promise<QueryResult> {
  const cursor = raw.query(new Cursor(sql, [], { rowMode: 'array', types: PG_TYPES }));
  return collectPgCursor(cursor as unknown as PgRowCursor, opts, start);
}

async function resolvePgSchema(c: PgConn, table: string, schema?: string): Promise<string> {
  if (schema) return schema;
  if (c.defaultSchema) return c.defaultSchema;
  const res = await c.raw.query(
    `SELECT n.nspname AS schema FROM pg_class cl
     JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE cl.relname = $1 AND cl.relkind IN ('r','v','m','p')
       AND n.nspname NOT IN ('pg_catalog','information_schema')`,
    [table],
  );
  const schemas = res.rows.map((r) => r.schema as string);
  if (schemas.length === 0) throw new AppError('TABLE_NOT_FOUND', `表不存在: ${table}`);
  if (schemas.length > 1) {
    throw new AppError('AMBIGUOUS_TABLE', `表 '${table}' 存在于多个 schema: ${schemas.join(', ')}`, {
      hint: '请加 --schema <name> 或用 schema.table',
    });
  }
  return schemas[0];
}

/** 基本标识符清洗:仅允许安全字符,用双引号包裹,内部双引号转义。 */
function quoteIdent(ident: string): string {
  return '"' + ident.replace(/"/g, '""') + '"';
}
