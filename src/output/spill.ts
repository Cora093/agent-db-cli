import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** 内联阈值(§9b):行数 ≤ 50 且 序列化字节 ≤ 100KB → 内联,否则落盘。 */
export const INLINE_MAX_ROWS = 50;
export const INLINE_MAX_BYTES = 100 * 1024;

export function withinInlineLimits(rowCount: number, byteLength: number): boolean {
  return rowCount <= INLINE_MAX_ROWS && byteLength <= INLINE_MAX_BYTES;
}

/** 落盘目录:os.tmpdir()/agent-db-cli/。 */
export function spillDir(): string {
  return path.join(os.tmpdir(), 'agent-db-cli');
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/**
 * 落盘文件名:agent-db-<ds>-<yyyymmddTHHMMSS>-<pid>-<rand6>.ndjson
 * 进程本地熵(pid+rand),无共享状态也不撞。
 */
export function spillFileName(
  ds: string,
  opts: { now?: Date; pid?: number; rand?: string } = {},
): string {
  const now = opts.now ?? new Date();
  const pid = opts.pid ?? process.pid;
  const rand = opts.rand ?? crypto.randomBytes(3).toString('hex');
  const safeDs = ds.replace(/[^A-Za-z0-9_.-]/g, '_');
  const ts =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `agent-db-${safeDs}-${ts}-${pid}-${rand}.ndjson`;
}

/**
 * 把 NDJSON 写到落盘目录,返回完整路径。目录按需创建。
 */
export function writeSpill(ds: string, ndjson: string): string {
  const dir = spillDir();
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, spillFileName(ds));
  fs.writeFileSync(full, ndjson, 'utf8');
  return full;
}

/**
 * 机会式 GC(§9b):删除超过 maxAgeMs(默认 24h)的完成文件和中断遗留临时文件。
 * 按龄删天然避开并发新文件;机制为尽力而为,任何错误吞掉不抛。
 */
export function gcSpillDir(
  dir: string = spillDir(),
  opts: { now?: Date; maxAgeMs?: number } = {},
): void {
  const now = opts.now ?? new Date();
  const maxAgeMs = opts.maxAgeMs ?? 24 * 3600 * 1000;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // 目录不存在等
  }
  for (const name of entries) {
    if (!name.endsWith('.ndjson') && !name.includes('.ndjson.tmp-')) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (now.getTime() - st.mtime.getTime() > maxAgeMs) {
        fs.rmSync(full, { force: true });
      }
    } catch {
      // 单文件出错忽略,继续
    }
  }
}
