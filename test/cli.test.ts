import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, type CliIO } from '../src/app.js';

let dir: string;
let cfgPath: string;

const CONFIG = `
datasources:
  prod-mysql-ro:
    label: 订单生产库
    driver: mysql
    host: 127.0.0.1
    port: 3306
    database: orders
    user: app_readonly
    password: "pw"
  bi-doris-ro:
    driver: doris
    host: 127.0.0.1
    port: 9030
    database: dw
    user: bi
    password: "pw"
`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-db-cli-'));
  cfgPath = path.join(dir, 'datasources.yaml');
  fs.writeFileSync(cfgPath, CONFIG);
  // 含明文密码,Linux 上须 chmod 600,否则 CONFIG_PERMISSION 守卫拒读(见 permissions.ts)
  if (process.platform !== 'win32') fs.chmodSync(cfgPath, 0o600);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function mkIO(): { io: CliIO; out: () => string; err: () => string } {
  const outBuf: string[] = [];
  const errBuf: string[] = [];
  return {
    io: { out: (s) => outBuf.push(s), err: (s) => errBuf.push(s), env: {} },
    out: () => outBuf.join(''),
    err: () => errBuf.join(''),
  };
}

describe('CLI run() — 无需 DB 的路径', () => {
  it('list:退出 0,stdout 给数据源 JSON', async () => {
    const { io, out } = mkIO();
    const code = await run(['list', '--config', cfgPath], io);
    expect(code).toBe(0);
    const obj = JSON.parse(out());
    expect(obj.datasources.map((d: { id: string }) => d.id)).toEqual([
      'prod-mysql-ro',
      'bi-doris-ro',
    ]);
  });

  it('list --format table:对齐表', async () => {
    const { io, out } = mkIO();
    const code = await run(['list', '--config', cfgPath, '--format', 'table'], io);
    expect(code).toBe(0);
    expect(out()).toContain('prod-mysql-ro');
    expect(out()).toContain('driver');
  });

  it('未知 --ds → 退出 5,stderr JSON 错误列出合法 id', async () => {
    const { io, err } = mkIO();
    const code = await run(['query', '--ds', 'prd', '--config', cfgPath, 'SELECT 1'], io);
    expect(code).toBe(5);
    const obj = JSON.parse(err());
    expect(obj.error.category).toBe('DATASOURCE_NOT_FOUND');
    expect(obj.error.hint).toContain('prod-mysql-ro');
  });

  it('非只读 SQL 在连接前被守卫拦截 → 退出 2', async () => {
    const { io, err } = mkIO();
    const code = await run(['query', '--ds', 'prod-mysql-ro', '--config', cfgPath, 'DROP TABLE t'], io);
    expect(code).toBe(2);
    expect(JSON.parse(err()).error.category).toBe('BLOCKED_NON_READONLY');
  });

  it('多语句被拦 → 退出 2', async () => {
    const { io, err } = mkIO();
    const code = await run(
      ['query', '--ds', 'prod-mysql-ro', '--config', cfgPath, 'SELECT 1; DROP TABLE t'],
      io,
    );
    expect(code).toBe(2);
    expect(JSON.parse(err()).error.category).toBe('BLOCKED_MULTI_STATEMENT');
  });

  it('query 无 SQL 输入 → 退出 1 BAD_USAGE', async () => {
    const { io, err } = mkIO();
    const code = await run(['query', '--ds', 'prod-mysql-ro', '--config', cfgPath], io);
    expect(code).toBe(1);
    expect(JSON.parse(err()).error.category).toBe('BAD_USAGE');
  });

  it('--format table 时错误走文本行', async () => {
    const { io, err } = mkIO();
    const code = await run(
      ['query', '--ds', 'prd', '--config', cfgPath, '--format', 'table', 'SELECT 1'],
      io,
    );
    expect(code).toBe(5);
    expect(err()).toContain('ERROR [DATASOURCE_NOT_FOUND]');
  });

  it('未知 --format → 退出 1', async () => {
    const { io, err } = mkIO();
    const code = await run(['list', '--config', cfgPath, '--format', 'xml'], io);
    expect(code).toBe(1);
    expect(JSON.parse(err()).error.category).toBe('BAD_USAGE');
  });

  it('配置文件不存在 → 退出 1 CONFIG', async () => {
    const { io, err } = mkIO();
    const code = await run(['list', '--config', path.join(dir, 'nope.yaml')], io);
    expect(code).toBe(1);
    expect(JSON.parse(err()).error.category).toBe('CONFIG');
  });

  it('--version → 退出 0,打印版本号', async () => {
    const { io, out } = mkIO();
    const code = await run(['--version'], io);
    expect(code).toBe(0);
    expect(out()).toMatch(/\d+\.\d+\.\d+/);
  });

  it('--limit >500 在 stderr 给夹紧提示(随后才连库失败)', async () => {
    const { io, err } = mkIO();
    // 连库会失败(无真实 DB),但夹紧提示应已写到 stderr
    await run(
      ['query', '--ds', 'prod-mysql-ro', '--config', cfgPath, '--limit', '1000', 'SELECT 1'],
      io,
    );
    expect(err()).toContain('500');
  });
});
