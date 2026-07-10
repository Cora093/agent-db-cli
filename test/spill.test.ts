import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  withinInlineLimits,
  spillFileName,
  gcSpillDir,
  INLINE_MAX_ROWS,
  INLINE_MAX_BYTES,
} from '../src/output/spill.js';

describe('withinInlineLimits (§9b 内联阈值)', () => {
  it('≤50 行且 ≤100KB 内联', () => {
    expect(withinInlineLimits(50, 100 * 1024)).toBe(true);
    expect(withinInlineLimits(1, 10)).toBe(true);
  });
  it('行数超 50 → 落盘', () => {
    expect(withinInlineLimits(51, 10)).toBe(false);
  });
  it('字节超 100KB → 落盘', () => {
    expect(withinInlineLimits(10, 100 * 1024 + 1)).toBe(false);
  });
  it('常量符合设计', () => {
    expect(INLINE_MAX_ROWS).toBe(50);
    expect(INLINE_MAX_BYTES).toBe(100 * 1024);
  });
});

describe('spillFileName (§9b 命名)', () => {
  it('agent-db-<ds>-<ts>-<pid>-<rand>.ndjson', () => {
    const name = spillFileName('prod-mysql-ro', {
      now: new Date(2026, 5, 8, 14, 30, 12),
      pid: 8421,
      rand: 'a3f9c1',
    });
    expect(name).toBe('agent-db-prod-mysql-ro-20260608T143012-8421-a3f9c1.ndjson');
  });

  it('清洗 ds 中的非文件名字符', () => {
    const name = spillFileName('we/ird ds', {
      now: new Date(2026, 0, 1, 0, 0, 0),
      pid: 1,
      rand: 'zzzzzz',
    });
    expect(name).toBe('agent-db-we_ird_ds-20260101T000000-1-zzzzzz.ndjson');
  });
});

describe('gcSpillDir (§9b 24h 机会式 GC)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function tempDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-db-cli-test-'));
    dirs.push(d);
    return d;
  }

  it('删超龄 ndjson,保留新文件', () => {
    const dir = tempDir();
    const now = new Date(2026, 5, 8, 12, 0, 0);
    const old = path.join(dir, 'agent-db-x-old.ndjson');
    const fresh = path.join(dir, 'agent-db-x-fresh.ndjson');
    fs.writeFileSync(old, '{}\n');
    fs.writeFileSync(fresh, '{}\n');
    // old 文件 mtime 设为 25h 前
    const oldTime = new Date(now.getTime() - 25 * 3600 * 1000);
    fs.utimesSync(old, oldTime, oldTime);

    gcSpillDir(dir, { now, maxAgeMs: 24 * 3600 * 1000 });

    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('不删非 ndjson 文件', () => {
    const dir = tempDir();
    const now = new Date(2026, 5, 8, 12, 0, 0);
    const other = path.join(dir, 'keep.txt');
    fs.writeFileSync(other, 'hi');
    const oldTime = new Date(now.getTime() - 100 * 3600 * 1000);
    fs.utimesSync(other, oldTime, oldTime);

    gcSpillDir(dir, { now, maxAgeMs: 24 * 3600 * 1000 });
    expect(fs.existsSync(other)).toBe(true);
  });

  it('目录不存在时不抛错', () => {
    expect(() => gcSpillDir(path.join(os.tmpdir(), 'agent-db-cli-nope-xyz'), {
      now: new Date(),
      maxAgeMs: 1000,
    })).not.toThrow();
  });
});
