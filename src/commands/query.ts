import fs from 'node:fs';
import type { DatasourceConfig } from '../config/types.js';
import type { OutputFormat } from '../types.js';
import { getDialect } from '../dialects/registry.js';
import { resolveDatasource } from '../config/resolve.js';
import { guardSql } from '../safety/guard.js';
import { emitResult } from '../output/emit.js';
import { writeSpill, gcSpillDir } from '../output/spill.js';

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
): Promise<string> {
  // ③ 守卫:在连接前拦截非只读 / 多语句 / 文件写 / 锁读(词法按 driver 方言)
  const guarded = guardSql(sql, ds.driver);

  // 机会式 GC(§9b):删超龄落盘文件,非致命
  gcSpillDir();

  const dialect = getDialect(ds.driver);
  const conn = await dialect.connect(resolveDatasource(ds, env));
  try {
    const result = await dialect.runReadOnly(conn, guarded.sql, {
      kind: guarded.kind,
      limit: opts.limit,
      timeoutMs: opts.timeoutMs,
    });
    return emitResult(
      { ds: ds.id, result, format, noSpill: opts.noSpill, outPath: opts.out },
      {
        writeSpill,
        writeOut: (filePath, content) => {
          fs.writeFileSync(filePath, content, 'utf8');
          return { bytes: Buffer.byteLength(content, 'utf8') };
        },
        warn: opts.warn,
      },
    );
  } finally {
    await conn.close();
  }
}
