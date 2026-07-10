import { describe, it, expect } from 'vitest';
import { DmDialect } from '../src/dialects/dm.js';

// dmdb 是 CJS 包,Node 把它的 await import() 包成 { __esModule, default, dmdb } 命名空间——
// 真正 API 在 .default 上。dm.ts 必须取 .default 兜底回命名空间本身,否则
// dmdb.getConnection 是 undefined,出现 "dmdb.getConnection is not a function"。
// 这条测试锁定该 unwrap 不再回归。
describe('DmDialect: dmdb ESM/CJS import unwrap', () => {
  it('connect 触达驱动 getConnection;不会再抛 "is not a function"', async () => {
    const d = new DmDialect();
    let err: Error | undefined;
    try {
      await d.connect({
        id: 'probe',
        driver: 'dm',
        host: '127.0.0.1',
        port: 1, // 必拒绝
        user: 'x',
        password: 'x',
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err, 'connect 必须失败(端口 1 拒绝)').toBeDefined();
    const msg = (err?.message ?? '') + '\n' + ((err as { cause?: Error })?.cause?.message ?? '');
    expect(msg).not.toMatch(/is not a function/);
  });
});
