import type { DatasourceConfig } from '../config/types.js';
import type { OutputFormat } from '../types.js';
import { getDialect } from '../dialects/registry.js';
import type { Dialect } from '../dialects/types.js';
import { resolveDatasource } from '../config/resolve.js';
import { guardSql } from '../safety/guard.js';
import { emitResult } from '../output/emit.js';
import { gcSpillDir, withinInlineLimits } from '../output/spill.js';
import {
  createOutWriter,
  createSpillWriter,
  writeFileAtomically,
  type RowFileWriter,
} from '../output/stream-file.js';

export interface QueryOpts {
  /** 已夹紧的行数硬顶 */
  limit: number;
  /** 已夹紧的服务端超时(毫秒) */
  timeoutMs: number;
  noSpill: boolean;
  out?: string;
  /** 非致命提示通道(stderr);缺省静默 */
  warn?: (msg: string) => void;
}

/**
 * query:执行只读查询(§7/§8/§9)。
 * 顺序:守卫(不连库即可拦)→ 连接 → 只读事务执行 → 输出(内联/落盘/--out)。
 */
export async function queryCommand(
  ds: DatasourceConfig,
  sql: string,
  opts: QueryOpts,
  format: OutputFormat,
  env: NodeJS.ProcessEnv = process.env,
  deps: {
    getDialect?: (driver: DatasourceConfig['driver']) => Dialect;
    createSpillWriter?: typeof createSpillWriter;
    createOutWriter?: typeof createOutWriter;
  } = {},
): Promise<string> {
  // ③ 守卫:在连接前拦截非只读 / 多语句 / 文件写 / 锁读(词法按 driver 方言)
  const guarded = guardSql(sql, ds.driver);

  // 机会式 GC(§9b):删超龄落盘文件,非致命
  gcSpillDir();

  const dialect = (deps.getDialect ?? getDialect)(ds.driver);
  const conn = await dialect.connect(resolveDatasource(ds, env));
  let writer: RowFileWriter | undefined;
  try {
    const streamOut = opts.out && inferStreamableOut(opts.out, format);
    if (streamOut) writer = (deps.createOutWriter ?? createOutWriter)(opts.out!, format, ds.id);
    else if (format === 'json' && !opts.noSpill) {
      writer = (deps.createSpillWriter ?? createSpillWriter)(ds.id);
    }

    const result = await dialect.runReadOnly(conn, guarded.sql, {
      kind: guarded.kind,
      limit: opts.limit,
      timeoutMs: opts.timeoutMs,
      ...(writer ? { onRow: (row, columns) => writer!.write(row, columns), retainRows: 50 } : {}),
    });
    const rowCount = result.rowCount ?? result.rows.length;
    const file = writer?.finish({
      rowCount,
      ms: result.ms,
      truncated: result.truncated,
      truncationReason: result.truncationReason,
      resultBytes: result.resultBytes ?? 0,
    }, result.columns);

    let streamFile = writer && file ? { path: writer.filePath, bytes: file.bytes } : undefined;
    if (writer && !opts.out && withinInlineLimits(rowCount, result.resultBytes ?? 0) && !result.truncated) {
      writer.abort();
      streamFile = undefined;
    } else {
      writer?.commit();
    }

    return emitResult(
      { ds: ds.id, result, format, noSpill: opts.noSpill, outPath: opts.out, streamFile },
      { warn: opts.warn, writeOut: writeFileAtomically },
    );
  } catch (err) {
    writer?.abort();
    throw err;
  } finally {
    if (!conn.discarded) await conn.close();
  }
}

function inferStreamableOut(filePath: string, format: OutputFormat): boolean {
  const ext = filePath.toLowerCase();
  return ext.endsWith('.csv') || ext.endsWith('.ndjson') || ext.endsWith('.json') || format !== 'table';
}
