import fs from 'node:fs';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { OUTPUT_FORMATS, type OutputFormat } from './output/plan.js';
import { AppError, toAppError } from './errors.js';
import { loadConfig } from './config/load.js';
import { renderError } from './output/emit.js';
import { getVersion } from './version.js';
import { getCapabilities } from './capabilities.js';
import {
  pickDatasource,
  resolveSqlInput,
  resolveQueryLimits,
} from './commands/common.js';
import { listCommand } from './commands/list.js';
import { tablesCommand } from './commands/tables.js';
import { namespacesCommand } from './commands/namespaces.js';
import { schemaCommand } from './commands/schema.js';
import { queryCommand } from './commands/query.js';

export interface CliIO {
  /** 原样写 stdout(不自动加换行) */
  out: (s: string) => void;
  /** 原样写 stderr */
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
  /** 读取 stdin(用于 -f -);默认读 fd 0 */
  readStdin?: () => string;
}

function parseFormat(v: string): OutputFormat {
  if (!OUTPUT_FORMATS.some((format) => format === v)) {
    throw new AppError('BAD_USAGE', `未知 --format '${v}'`, {
      hint: `可用: ${OUTPUT_FORMATS.join(', ')}`,
    });
  }
  return v as OutputFormat;
}

function parseIntArg(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new InvalidArgumentError('必须是整数');
  return n;
}

/**
 * CLI 入口(可测):解析 argv,分发命令,返回退出码。
 * IO 经注入,stdout 只放数据,stderr 只放错误/提示(§9c)。
 */
export async function run(argv: string[], io: CliIO): Promise<number> {
  const program = new Command();
  program
    .name('agent-db')
    .description('只读多源数据库查询工具(MySQL/PG/达梦及 MySQL 协议族,供 AI Agent 使用)')
    .version(getVersion(), '--version', '显示版本');
  program.exitOverride();
  let commanderStderr = '';
  program.configureOutput({
    writeOut: (s) => io.out(s),
    writeErr: (s) => {
      commanderStderr += s;
    },
  });

  let currentFormat: OutputFormat = 'json';

  const addCommon = (cmd: Command): Command =>
    cmd
      .option('--config <path>', '配置文件路径(覆盖默认按 OS 自算)')
      .option('--format <fmt>', `输出格式 ${OUTPUT_FORMATS.join('|')}`, 'json');

  const begin = (opts: { format: string; config?: string }) => {
    currentFormat = parseFormat(opts.format);
    const cfg = loadConfig({ env: io.env, configPath: opts.config });
    return { fmt: currentFormat, cfg };
  };

  program.command('capabilities').description('输出 CLI 和 driver 能力(无需配置或连接)').action(() => {
    io.out(JSON.stringify(getCapabilities()) + '\n');
  });

  addCommon(program.command('list').description('列所有数据源'))
    .action((opts) => {
      const { fmt, cfg } = begin(opts);
      io.out(listCommand(cfg, fmt) + '\n');
    });

  addCommon(program.command('namespaces').description('列数据源可见的 schema/namespace'))
    .requiredOption('--ds <id>', '数据源 id')
    .action(async (opts) => {
      const { fmt, cfg } = begin(opts);
      const ds = pickDatasource(cfg, opts.ds);
      io.out((await namespacesCommand(ds, fmt, io.env)) + '\n');
    });

  addCommon(program.command('tables').description('列数据源的表(schema 限定)'))
    .requiredOption('--ds <id>', '数据源 id')
    .option('--like <pattern>', '按表名过滤(SQL LIKE)')
    .action(async (opts) => {
      const { fmt, cfg } = begin(opts);
      const ds = pickDatasource(cfg, opts.ds);
      io.out((await tablesCommand(ds, opts.like, fmt, io.env)) + '\n');
    });

  addCommon(program.command('schema').description('单表结构:列/类型/主键/索引/注释'))
    .requiredOption('--ds <id>', '数据源 id')
    .requiredOption('--table <name>', '表名(支持 schema.table)')
    .option('--schema <s>', '默认命名空间(覆盖配置)')
    .action(async (opts) => {
      const { fmt, cfg } = begin(opts);
      const ds = pickDatasource(cfg, opts.ds);
      io.out((await schemaCommand(ds, opts.table, opts.schema, fmt, io.env)) + '\n');
    });

  addCommon(program.command('query').description('执行只读查询(SELECT/WITH/SHOW/EXPLAIN/DESCRIBE)'))
    .argument('[sql]', '查询 SQL(简单查询用位置参数,复杂用 -f)')
    .requiredOption('--ds <id>', '数据源 id')
    .option('-f, --file <path>', 'SQL 文件路径(- 表示 stdin),UTF-8')
    .option('--limit <n>', '行数上限 1..500(默认 500)', parseIntArg)
    .option('--timeout <s>', '服务端超时秒数(默认 30)', parseIntArg)
    .option('--out <path>', '导出到文件(持久,不 GC;按扩展名推断格式)')
    .action(async (sqlArg: string | undefined, opts) => {
      const { fmt, cfg } = begin(opts);
      const ds = pickDatasource(cfg, opts.ds);
      const sql = resolveSqlInput(sqlArg, opts.file, {
        readFile: (p) => fs.readFileSync(p, 'utf8'),
        readStdin: io.readStdin ?? (() => fs.readFileSync(0, 'utf8')),
      });
      const { limit, timeoutMs, notes } = resolveQueryLimits(
        { limit: opts.limit, timeout: opts.timeout },
        ds.timeout,
      );
      for (const n of notes) io.err(n + '\n');
      io.out(
        (await queryCommand(
          ds,
          sql,
          {
            limit,
            timeoutMs,
            out: opts.out,
            warn: (m) => io.err(m + '\n'),
          },
          fmt,
          io.env,
        )) + '\n',
      );
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.exitCode === 0) return 0; // help/version 已经写 stdout
      const message = e.message.replace(/^error:\s*/i, '');
      const detail = commanderStderr.trim().replace(/^error:\s*/i, '');
      const usageError = new AppError('BAD_USAGE', message, {
        hint: detail && detail !== message ? detail : undefined,
      });
      io.err(renderError(usageError, currentFormat) + '\n');
      return usageError.exitCode;
    }
    const appErr = toAppError(e);
    io.err(renderError(appErr, currentFormat) + '\n');
    return appErr.exitCode;
  }
}
