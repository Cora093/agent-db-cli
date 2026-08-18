import type { ColKind, Dialect, Conn, RunOptions, QueryResult, TableInfo, TableSchema } from './types.js';
import type { ResolvedDatasource } from '../config/types.js';
import type { DriverName } from '../types.js';
import type { ExecutionPolicy } from './descriptors.js';
import { AppError } from '../errors.js';
import { applyLimit, mapRows } from './sql-util.js';
import { classifyDmError } from './db-error.js';

const FALLBACK_CLOSE_TIMEOUT_MS = 100;

type DmConnState = 'open' | 'closing' | 'closed' | 'discarded';

export interface DmConn extends Conn {
  raw: DmRawConnection;
  defaultSchema?: string;
  user: string;
  state(): DmConnState;
  discard(): Promise<void>;
}

// dmdb(达梦官方)的最小结构假设。API 形状借鉴 node-oracledb(getConnection/execute/OUT_FORMAT_ARRAY),
// 但实现是纯 JS(net socket 自实现协议),非原生 addon——无需预编译二进制/客户端库。bind 风格等细节仍待 §14 真机校正。
interface DmSocket {
  destroy(): void;
}

interface DmRawConnection {
  execute(
    sql: string,
    binds?: unknown[],
    opts?: { autoCommit?: boolean; outFormat?: unknown; maxRows?: number },
  ): Promise<{ rows?: unknown[][]; metaData?: DmColumnMeta[] }>;
  rollback?(): Promise<void>;
  close(): Promise<void>;
  socket?: DmSocket;
  conn_prop_socketTimeout?: number;
}

interface DmColumnMeta {
  name: string;
  /**
   * 列的 DB 类型名。dm-183 真机(dmdb 1.x)实测 metaData 只有 name、无任何类型字段,
   * 故恒 undefined → 全列落 other;若未来 dmdb 透出该字段,下方映射自动生效。
   */
  dbTypeName?: string;
}

interface DmModule {
  getConnection(cfg: Record<string, unknown>): Promise<DmRawConnection>;
  OUT_FORMAT_ARRAY?: unknown;
  /** 类型常量(node-oracledb 风格);用于 fetchAsString 按类型取文本 */
  NUMBER?: unknown;
  DATE?: unknown;
  fetchAsString?: unknown[];
}

/**
 * DM dbTypeName → ColKind(A3)。dm-183 真机:dmdb 1.x 不透出列类型,全列落 other;
 * 配合 fetchAsString,DM 的数值/日期一律以文本字符串交付(整数也是字符串)——
 * 精度绝对保真优先,number 一致性让步(见 references/dialects.md 的 DM 注)。
 */
const DM_TYPE_KINDS: Record<string, ColKind> = {
  BIGINT: 'bigint',
  INT: 'int',
  INTEGER: 'int',
  SMALLINT: 'int',
  TINYINT: 'int',
  BYTE: 'int',
  NUMBER: 'decimal',
  NUMERIC: 'decimal',
  DECIMAL: 'decimal',
  DEC: 'decimal',
  FLOAT: 'float',
  DOUBLE: 'float',
  REAL: 'float',
  BIT: 'bool',
  BOOLEAN: 'bool',
  BOOL: 'bool',
  DATE: 'date',
  TIMESTAMP: 'datetime',
  DATETIME: 'datetime',
};

function dmColKinds(meta: DmColumnMeta[]): ColKind[] {
  return meta.map((m) => {
    // 去精度后缀(如 'TIMESTAMP(6)'、'NUMBER(10,2)')再查表
    const t = (m.dbTypeName ?? '').toUpperCase().replace(/\(.*\)\s*$/, '').trim();
    return DM_TYPE_KINDS[t] ?? 'other';
  });
}

/**
 * 达梦 DM 方言(尽力兼容,§4/§14)。schema = user;原生 addon 懒加载。
 * 只读事务需 autoCommit=false 才跨语句生效(§7)。
 *
 * ⚠ DM 的 bind 风格、超时变量、自省字典细节由 §14 spike 真机确认;
 * 当前实现按 Oracle 风格假设,并对标识符做白名单校验后插值(避免 bind 风格不确定)。
 */
export class DmDialect implements Dialect {
  constructor(private readonly config: { defaultPort: number; execution: ExecutionPolicy }) {}

  get driver(): DriverName {
    return 'dm';
  }

  async connect(cfg: ResolvedDatasource): Promise<Conn> {
    let dmdb: DmModule;
    try {
      // dmdb 是 CJS 包,Node ESM 把它包成命名空间对象 { __esModule, default, dmdb }——
      // 真正的 API 在 .default 上,顶层不会平铺。必须取 .default 兜底回命名空间本身,
      // 否则 dmdb.getConnection 是 undefined,出现 "dmdb.getConnection is not a function"。
      const ns = (await import('dmdb')) as unknown as DmModule & { default?: DmModule };
      dmdb = ns.default ?? ns;
      // A3:数值/日期按类型取文本(fetchAsString),消除 dmdb 默认 number 预先丢精、
      // 日期经 Date 贴错时区;与 mysql2/pg 的文本交付一致。dm-183 真机验证。
      if (dmdb.NUMBER !== undefined && dmdb.DATE !== undefined) {
        dmdb.fetchAsString = [dmdb.NUMBER, dmdb.DATE];
      }
    } catch (err) {
      throw new AppError('DRIVER_MISSING', '达梦驱动 dmdb 未安装或加载失败', {
        hint: '安装可选依赖: pnpm add dmdb(纯 JS 驱动,无需原生编译/达梦客户端库)',
        cause: err,
      });
    }
    let raw: DmRawConnection;
    try {
      raw = await dmdb.getConnection({
        connectString: `${cfg.host}:${cfg.port ?? this.config.defaultPort}`,
        user: cfg.user,
        password: cfg.password,
        // 只读事务跨语句生效的前提
        autoCommit: false,
        // 默认关登录握手加密:DM 用 legacy cipher,在 Node17+/OpenSSL3 下会 [6071] 消息加密失败、连不上。
        // 这是登录层专有加密,独立于传输 SSL;链路可信/已走 SSL 时安全。可经数据源 options 覆盖回 true
        // (届时需 NODE_OPTIONS=--openssl-legacy-provider)。§14 真机确认。
        loginEncrypt: false,
        ...cfg.safeOptions,
      });
    } catch (err) {
      throw classifyDmError(err, 'connect');
    }
    // 裸表名默认命名空间(§5):配了 schema 就把会话当前 schema 切过去,
    // 使 query 里不带 owner 的表名解析到它(对标 PG 的 search_path)。
    // 自省路径(listTables/getSchema)已显式按 OWNER 过滤,不受影响。
    if (cfg.schema) {
      try {
        await raw.execute(`SET SCHEMA ${identifier(cfg.schema)}`, [], { autoCommit: true });
      } catch (err) {
        throw classifyDmError(err, 'connect');
      }
    }
    return createDmConn(raw, cfg.schema, cfg.user);
  }

  async runReadOnly(conn: Conn, sql: string, opts: RunOptions): Promise<QueryResult> {
    const c = conn as DmConn;
    const start = Date.now();
    const transaction = this.config.execution.readOnlyTransaction;
    if (transaction.strength === 'account-only') {
      throw new AppError('INTERNAL', 'DM descriptor 缺少只读事务策略');
    }
    try {
      const result = await runWithTimeout(c, opts.timeoutMs, async () => {
        await c.raw.execute(transaction.beginSql, [], { autoCommit: transaction.autoCommit });

        const execSql = applyLimit(sql, opts.kind, opts.limit + 1);
        // maxRows:驱动级限行兜底(C)。applyLimit 对 TOP/ROWNUM 等形态跳过改写时,
        // 仍由 dmdb 在取数层封顶,杜绝全量缓冲 OOM。
        return c.raw.execute(execSql, [], {
          autoCommit: transaction.autoCommit,
          maxRows: opts.limit + 1,
        });
      });
      const meta = result.metaData ?? [];
      const columns = meta.map((m) => m.name);

      return mapRows((result.rows ?? []) as unknown[][], columns, dmColKinds(meta), opts.limit, start);
    } catch (err) {
      if (err instanceof AppError && err.category === 'TIMEOUT') throw err;
      throw classifyDmError(err);
    } finally {
      if (c.state() === 'open') {
        try {
          if (c.raw.rollback) await c.raw.rollback();
          else await c.raw.execute(transaction.rollbackSql, [], { autoCommit: transaction.autoCommit });
        } catch {
          /* ignore */
        }
      }
    }
  }

  async listNamespaces(conn: Conn) {
    const c = conn as DmConn;
    const res = await c.raw.execute(
      'SELECT DISTINCT OWNER FROM ALL_OBJECTS ORDER BY OWNER',
      [],
      { autoCommit: false },
    );
    const meta = (res.metaData ?? []).map((m) => m.name.toUpperCase());
    const i = meta.indexOf('OWNER');
    return {
      status: 'best-effort' as const,
      detail: 'namespaces are derived from objects visible to the current user',
      data: (res.rows ?? []).map((r) => {
        const name = r[i] as string;
        return { name, system: name === 'SYS' || name === 'SYSTEM' || name.startsWith('SYS') };
      }),
    };
  }

  async listTables(conn: Conn, like?: string): Promise<TableInfo[]> {
    const c = conn as DmConn;
    const owner = (c.defaultSchema ?? c.user).toUpperCase();
    let sql = `SELECT OWNER, TABLE_NAME FROM ALL_TABLES WHERE OWNER = '${sqlStr(owner)}'`;
    if (like) sql += ` AND TABLE_NAME LIKE '${sqlStr(like)}'`;
    sql += ' ORDER BY TABLE_NAME';
    const res = await c.raw.execute(sql, [], { autoCommit: false });
    const cols = (res.metaData ?? []).map((m) => m.name.toUpperCase());
    const oi = cols.indexOf('OWNER');
    const ni = cols.indexOf('TABLE_NAME');
    return (res.rows ?? []).map((r) => ({
      schema: (r[oi] as string) ?? owner,
      name: r[ni] as string,
    }));
  }

  async getSchema(conn: Conn, table: string, schema?: string): Promise<TableSchema> {
    const c = conn as DmConn;
    const owner = (schema ?? c.defaultSchema ?? c.user).toUpperCase();
    const t = identifier(table);
    const sql =
      `SELECT COLUMN_NAME, DATA_TYPE, NULLABLE, DATA_DEFAULT ` +
      `FROM ALL_TAB_COLUMNS WHERE OWNER = '${sqlStr(owner)}' AND TABLE_NAME = '${sqlStr(t)}' ` +
      `ORDER BY COLUMN_ID`;
    const res = await c.raw.execute(sql, [], { autoCommit: false });
    const meta = (res.metaData ?? []).map((m) => m.name.toUpperCase());
    const idx = (name: string) => meta.indexOf(name);
    const rows = res.rows ?? [];
    if (rows.length === 0) throw new AppError('TABLE_NOT_FOUND', `表不存在: ${owner}.${table}`);

    const columns = rows.map((r) => ({
      name: r[idx('COLUMN_NAME')] as string,
      type: String(r[idx('DATA_TYPE')]),
      nullable: r[idx('NULLABLE')] === 'Y',
      default: (r[idx('DATA_DEFAULT')] as string) ?? null,
    }));

    const objectRes = await c.raw.execute(
      `SELECT o.OBJECT_TYPE, v.TEXT AS VIEW_DEFINITION
       FROM ALL_OBJECTS o LEFT JOIN ALL_VIEWS v ON v.OWNER=o.OWNER AND v.VIEW_NAME=o.OBJECT_NAME
       WHERE o.OWNER='${sqlStr(owner)}' AND o.OBJECT_NAME='${sqlStr(t)}'
         AND o.OBJECT_TYPE IN ('TABLE','VIEW')`,
      [],
      { autoCommit: false },
    );
    const objectMeta = (objectRes.metaData ?? []).map((m) => m.name.toUpperCase());
    const objectRow = objectRes.rows?.[0];
    const objectType = objectRow?.[objectMeta.indexOf('OBJECT_TYPE')] as string | undefined;
    const viewDefinition = objectRow?.[objectMeta.indexOf('VIEW_DEFINITION')] as string | null | undefined;

    return {
      schema: owner,
      table,
      type: objectType === 'TABLE' ? 'BASE TABLE' : objectType === 'VIEW' ? 'VIEW' : 'UNKNOWN',
      columns: { status: 'full', data: columns },
      primaryKey: { status: 'best-effort', data: [], detail: 'DM catalog introspection is not available in this build' },
      indexes: { status: 'best-effort', data: [], detail: 'DM catalog introspection is not available in this build' },
      constraints: { status: 'best-effort', data: [], detail: 'DM catalog introspection is not available in this build' },
      foreignKeys: { status: 'best-effort', data: [], detail: 'DM catalog introspection is not available in this build' },
      comment: { status: 'best-effort', data: null, detail: 'DM catalog introspection is not available in this build' },
      viewDefinition: objectType === 'VIEW'
        ? { status: 'best-effort', data: viewDefinition ?? null, detail: 'view text is returned when visible in ALL_VIEWS' }
        : { status: objectType === 'TABLE' ? 'full' : 'best-effort', data: null, detail: objectType ? undefined : 'object type is unavailable' },
    };
  }

}

/**
 * Isolates dmdb 1.0.49630 internals used for cancellation. Connection.do_close() first awaits
 * rollback, so it cannot enforce a deadline. Each protocol message snapshots
 * conn_prop_socketTimeout, while raw.socket.destroy() immediately aborts the transport.
 */
const dmTransport = {
  configureMessageTimeout(raw: DmRawConnection, timeoutMs: number): void {
    raw.conn_prop_socketTimeout = timeoutMs;
  },
  destroy(raw: DmRawConnection): boolean {
    if (!raw.socket || typeof raw.socket.destroy !== 'function') return false;
    raw.socket.destroy();
    return true;
  },
};

export function createDmConn(raw: DmRawConnection, defaultSchema?: string, user = 'TEST'): Conn {
  let state: DmConnState = 'open';
  const conn: DmConn = {
    driver: 'dm',
    raw,
    defaultSchema,
    user,
    state: () => state,
    discard: async () => {
      if (state === 'discarded' || state === 'closed') return;
      state = 'discarded';
      try {
        if (dmTransport.destroy(raw)) return;
      } catch {
        // The connection remains discarded; use the bounded fallback below.
      }
      // Unknown dmdb shape: graceful close is only best-effort and strictly bounded.
      await settleWithin(Promise.resolve().then(() => raw.close()), FALLBACK_CLOSE_TIMEOUT_MS);
    },
    close: async () => {
      if (state === 'discarded' || state === 'closed' || state === 'closing') return;
      state = 'closing';
      try {
        await raw.close();
        state = 'closed';
      } catch (err) {
        state = 'open';
        throw err;
      }
    },
  };
  return conn;
}

async function runWithTimeout<T>(conn: DmConn, timeoutMs: number, operation: () => Promise<T>): Promise<T> {
  dmTransport.configureMessageTimeout(conn.raw, timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let signalTimeout!: () => void;
  const timeoutSignal = new Promise<void>((resolve) => {
    signalTimeout = resolve;
  });
  const settledOperation = Promise.resolve().then(operation).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  timer = setTimeout(() => {
    timedOut = true;
    void conn.discard();
    signalTimeout();
  }, timeoutMs);

  try {
    const outcome = await Promise.race([settledOperation, timeoutSignal.then(() => undefined)]);
    if (outcome === undefined || timedOut) {
      // discard() is bounded when socket internals are unavailable; never await the operation.
      await conn.discard();
      throw new AppError('TIMEOUT', '查询超时被中断', {
        hint: '加 WHERE/LIMIT 收窄,或调大 --timeout',
      });
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  const handled = promise.then(() => undefined, () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      handled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 标识符白名单校验(DM bind 风格不确定时用于安全插值)。 */
function identifier(name: string): string {
  if (!/^[A-Za-z0-9_$]+$/.test(name)) {
    throw new AppError('BAD_USAGE', `非法标识符: ${name}`, { hint: '表名仅允许字母数字下划线' });
  }
  return name;
}

/** 字符串字面量转义(单引号双写)。 */
function sqlStr(s: string): string {
  return s.replace(/'/g, "''");
}
