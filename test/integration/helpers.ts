import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { run, type CliIO } from '../../src/app.js';

/**
 * 集成测试共享设施。连真实库,断言只读路径(list/tables/schema/query)。
 * 夹具(命名空间 test20260609 + 数据)由一次性脚本预先建好,测试只读不建。
 *
 * 门控:各引擎套件按 `AGENT_DB_CLI_IT_*` 连接 URL 是否存在决定 describe / describe.skip,
 * 故未配变量时 `pnpm test` 仍全绿(整套 skip)。
 */

// 本地便利:若仓库根有 .env.it.local(已 gitignore),把其中变量注入 process.env。
// 不覆盖已存在的环境变量;文件不在就什么都不做。
// 只在本文件(集成测试)被导入时执行,单测不受影响。
(() => {
  const envFile = path.resolve(process.cwd(), '.env.it.local');
  if (!fs.existsSync(envFile)) return;
  for (const raw of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
})();

export interface ParsedDb {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
}

/** 解析 scheme://user:pass@host:port[/db];scheme 仅用于人类分流,这里忽略。 */
export function parseDbUrl(url: string): ParsedDb {
  const u = new URL(url);
  const db = u.pathname && u.pathname !== '/' ? u.pathname.slice(1) : undefined;
  return {
    host: u.hostname,
    port: Number(u.port),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: db,
  };
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

type RunCli = (argv: string[]) => Promise<CliResult>;

/**
 * 用给定数据源 map 写一个临时 datasources.yaml(POSIX chmod 600),
 * 给回一个 runCli(argv) 注入 `--config <tmp>`,跑完删临时目录。
 */
export async function withDatasources<T>(
  datasources: Record<string, Record<string, unknown>>,
  fn: (runCli: RunCli) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-db-cli-it-'));
  const cfgPath = path.join(dir, 'datasources.yaml');
  fs.writeFileSync(cfgPath, stringify({ datasources }), 'utf8');
  if (process.platform !== 'win32') fs.chmodSync(cfgPath, 0o600);

  const runCli: RunCli = async (argv) => {
    let stdout = '';
    let stderr = '';
    const io: CliIO = {
      out: (s) => {
        stdout += s;
      },
      err: (s) => {
        stderr += s;
      },
      env: process.env,
    };
    const code = await run([...argv, '--config', cfgPath], io);
    return { code, stdout, stderr };
  };

  try {
    return await fn(runCli);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface SuiteSpec {
  /** 数据源 id(命令行句柄) */
  dsId: string;
  /** 写进临时配置的数据源对象(driver/host/port/database?/schema?/user/password) */
  datasource: Record<string, unknown>;
  /** employees 表名;DM 大写 EMPLOYEES */
  employeesTable: string;
  /** departments 表名;DM 大写 DEPARTMENTS */
  departmentsTable: string;
  /** --like 过滤;DM 大写 '%EMP%' */
  empLike: string;
  /** salary 列原始类型串应含的子串(小写比较):decimal / numeric */
  salaryTypeContains: string;
  /** salary 归一后的 JS 类型:0.2.0 起全引擎恒 string(DECIMAL 精度保真;DM 经 fetchAsString) */
  salaryKind: 'string' | 'number';
  /** 是否全自省(mysql/pg):PK=[id]、indexes 非 'N/A' */
  fullIntrospection: boolean;
  /** 一个不存在的表名,触发 TABLE_NOT_FOUND */
  missingTable: string;
}

/** 跨引擎共用的只读断言电池。各引擎差异经 SuiteSpec 注入。 */
export function standardSuite(spec: SuiteSpec): void {
  const ds = { [spec.dsId]: spec.datasource };
  const lower = (s: string) => s.toLowerCase();

  it('list 列出该数据源', async () => {
    await withDatasources(ds, async (runCli) => {
      const r = await runCli(['list']);
      expect(r.code, r.stderr).toBe(0);
      const j = JSON.parse(r.stdout);
      expect(j.datasources.map((d: { id: string }) => d.id)).toContain(spec.dsId);
    });
  });

  it('namespaces 列出夹具 namespace', async () => {
    await withDatasources(ds, async (runCli) => {
      const r = await runCli(['namespaces', '--ds', spec.dsId]);
      expect(r.code, r.stderr).toBe(0);
      const j = JSON.parse(r.stdout);
      expect(['full', 'best-effort']).toContain(j.namespaces.status);
      expect(j.namespaces.data.length).toBeGreaterThan(0);
    });
  });

  it('tables --like 命中 employees', async () => {
    await withDatasources(ds, async (runCli) => {
      const r = await runCli(['tables', '--ds', spec.dsId, '--like', spec.empLike]);
      expect(r.code, r.stderr).toBe(0);
      const j = JSON.parse(r.stdout);
      const names = j.tables.map((t: { name: string }) => lower(t.name));
      expect(names).toContain(lower(spec.employeesTable));
    });
  });

  it('schema 返回列/类型/(主键)', async () => {
    await withDatasources(ds, async (runCli) => {
      const r = await runCli(['schema', '--ds', spec.dsId, '--table', spec.employeesTable]);
      expect(r.code, r.stderr).toBe(0);
      const j = JSON.parse(r.stdout);
      const byName = new Map<string, { type: string }>(
        j.columns.data.map((c: { name: string; type: string }) => [lower(c.name), c]),
      );
      for (const col of ['id', 'name', 'salary', 'hired_at', 'is_active', 'dept_id']) {
        expect(byName.has(col), `缺列 ${col}`).toBe(true);
      }
      expect(lower(byName.get('salary')!.type)).toContain(spec.salaryTypeContains);

      if (spec.fullIntrospection) {
        expect(j.primaryKey.status).toBe('full');
        expect(j.primaryKey.data.map(lower)).toContain('id');
        expect(j.indexes.status).toBe('full');
        expect(['full', 'best-effort']).toContain(j.constraints.status);
        expect(j.foreignKeys.status).toBe('full');
        expect(j.comment.status).toBe('full');
        expect(j.viewDefinition.status).toBe('full');
      } else {
        expect(j.indexes.status).toBe('best-effort');
        expect(j.primaryKey.status).toBe('best-effort');
      }
    });
  });

  it('query 返回全部 5 行,顺序正确', async () => {
    await withDatasources(ds, async (runCli) => {
      const r = await runCli([
        'query',
        '--ds',
        spec.dsId,
        `SELECT id, name FROM ${spec.employeesTable} ORDER BY id`,
      ]);
      expect(r.code, r.stderr).toBe(0);
      const j = JSON.parse(r.stdout);
      expect(j.rows.length).toBe(5);
      expect(j.rows.map((row: unknown[]) => row[1])).toEqual([
        'Alice',
        'Bob',
        'Carol',
        'Dave',
        'Eve',
      ]);
      expect(j.meta.queryTruncated).toBe(false);
    });
  });

  it('query --limit 2 截断', async () => {
    await withDatasources(ds, async (runCli) => {
      const r = await runCli([
        'query',
        '--ds',
        spec.dsId,
        `SELECT id, name FROM ${spec.employeesTable} ORDER BY id`,
        '--limit',
        '2',
      ]);
      expect(r.code, r.stderr).toBe(0);
      const j = JSON.parse(r.stdout);
      expect(j.rows.length).toBe(2);
      expect(j.meta.queryTruncated).toBe(true);
    });
  });

  it('DECIMAL 归一:类型保真', async () => {
    await withDatasources(ds, async (runCli) => {
      const r = await runCli([
        'query',
        '--ds',
        spec.dsId,
        `SELECT salary FROM ${spec.employeesTable} WHERE id = 1`,
      ]);
      expect(r.code, r.stderr).toBe(0);
      const j = JSON.parse(r.stdout);
      const salary = j.rows[0][0];
      expect(typeof salary).toBe(spec.salaryKind);
      expect(Number(salary)).toBeCloseTo(12000.5, 2);
    });
  });

  it('NULL 归一为 null', async () => {
    await withDatasources(ds, async (runCli) => {
      // Eve(id=5)的 dept_id 为 NULL
      const r = await runCli([
        'query',
        '--ds',
        spec.dsId,
        `SELECT dept_id FROM ${spec.employeesTable} WHERE id = 5`,
      ]);
      expect(r.code, r.stderr).toBe(0);
      const j = JSON.parse(r.stdout);
      expect(j.rows[0][0]).toBeNull();
    });
  });

  it('时间戳按文本直传:墙钟不变、无时区不贴 Z(B1)', async () => {
    await withDatasources(ds, async (runCli) => {
      const r = await runCli([
        'query',
        '--ds',
        spec.dsId,
        `SELECT hired_at FROM ${spec.employeesTable} WHERE id = 1`,
      ]);
      expect(r.code, r.stderr).toBe(0);
      const j = JSON.parse(r.stdout);
      const ts = j.rows[0][0];
      expect(typeof ts).toBe('string');
      // 库内墙钟 2024-01-15 09:00:00 原样到达,不再经 Date 换算/贴 UTC 标签
      expect(ts).toMatch(/^2024-01-15[T ]09:00:00/);
      expect(ts.endsWith('Z')).toBe(false);
    });
  });

  it('聚合 COUNT(*) = 5', async () => {
    await withDatasources(ds, async (runCli) => {
      const r = await runCli([
        'query',
        '--ds',
        spec.dsId,
        `SELECT COUNT(*) FROM ${spec.employeesTable}`,
      ]);
      expect(r.code, r.stderr).toBe(0);
      const j = JSON.parse(r.stdout);
      // MySQL/PG 的 COUNT(*)(BIGINT)→ number;DM 的 COUNT(*) 是 NUMBER → decimal → 字符串,
      // 故统一 Number 比较(A3 契约:decimal 恒字符串)
      expect(Number(j.rows[0][0])).toBe(5);
    });
  });

  it('JOIN 两表(内连接排除 NULL 外键)', async () => {
    await withDatasources(ds, async (runCli) => {
      const r = await runCli([
        'query',
        '--ds',
        spec.dsId,
        `SELECT e.name, d.name FROM ${spec.employeesTable} e ` +
          `JOIN ${spec.departmentsTable} d ON e.dept_id = d.id ORDER BY e.id`,
      ]);
      expect(r.code, r.stderr).toBe(0);
      const j = JSON.parse(r.stdout);
      expect(j.rows.length).toBe(4); // Eve 的 dept_id 为 NULL,被内连接排除
      expect(j.rows[0]).toEqual(['Alice', 'Engineering']);
    });
  });

  it('tables 无 --like 列出全部夹具表', async () => {
    await withDatasources(ds, async (runCli) => {
      const r = await runCli(['tables', '--ds', spec.dsId]);
      expect(r.code, r.stderr).toBe(0);
      const j = JSON.parse(r.stdout);
      const names = j.tables.map((t: { name: string }) => lower(t.name));
      expect(names).toContain(lower(spec.employeesTable));
      expect(names).toContain(lower(spec.departmentsTable));
    });
  });

  it('不存在的表 → TABLE_NOT_FOUND / 退出码 1', async () => {
    await withDatasources(ds, async (runCli) => {
      const r = await runCli(['schema', '--ds', spec.dsId, '--table', spec.missingTable]);
      expect(r.code).toBe(1);
      const j = JSON.parse(r.stderr.trim());
      expect(j.error.category).toBe('TABLE_NOT_FOUND');
    });
  });

  it('连接失败 → CONNECT / 退出码 4', async () => {
    // 改连 127.0.0.1:1(必被拒)→ 各驱动连接错误应归 CONNECT;
    // 对 DM 也验证 [6001] 网络通信异常 / ECONNREFUSED 的文本分类。
    const badDs = { [spec.dsId]: { ...spec.datasource, host: '127.0.0.1', port: 1 } };
    await withDatasources(badDs, async (runCli) => {
      const r = await runCli(['query', '--ds', spec.dsId, 'SELECT 1']);
      expect(r.code).toBe(4);
      const j = JSON.parse(r.stderr.trim());
      expect(j.error.category).toBe('CONNECT');
    });
  });
}

/** 按引擎门控:URL 存在 → describe;否则 describe.skip。 */
export function gatedDescribe(envVar: string): typeof describe | typeof describe.skip {
  return process.env[envVar] ? describe : describe.skip;
}

/**
 * 单条查询便利封装(引擎特有契约用例用):跑 query 并返回退出码 + 解析后的 stdout/stderr JSON。
 * stdout/stderr 非 JSON 时对应字段为 undefined(由用例自行断言原始文本)。
 */
export async function queryOnce(
  datasources: Record<string, Record<string, unknown>>,
  dsId: string,
  sql: string,
  extraArgs: string[] = [],
): Promise<CliResult & { json?: { columns: string[]; rows: unknown[][]; meta: Record<string, unknown> }; errJson?: { error: { category: string; message: string } } }> {
  const r = await withDatasources(datasources, (runCli) =>
    runCli(['query', '--ds', dsId, ...extraArgs, sql]),
  );
  let json;
  let errJson;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* 非 JSON stdout */
  }
  try {
    errJson = JSON.parse(r.stderr.trim());
  } catch {
    /* 非 JSON stderr */
  }
  return { ...r, json, errJson };
}
