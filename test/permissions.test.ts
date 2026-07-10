import { describe, it, expect } from 'vitest';
import { checkConfigPermissions } from '../src/config/permissions.js';
import { AppError } from '../src/errors.js';

const FILE = '/home/me/.config/agent-db-cli/datasources.yaml';

describe('checkConfigPermissions (§6 强制权限校验)', () => {
  it('Windows 上跳过 POSIX 位校验(%APPDATA% 天然隔离)', () => {
    expect(() =>
      checkConfigPermissions(FILE, { platform: 'win32', getMode: () => 0o100644 }),
    ).not.toThrow();
  });

  it('Linux 上 600 通过', () => {
    expect(() =>
      checkConfigPermissions(FILE, { platform: 'linux', getMode: () => 0o100600 }),
    ).not.toThrow();
  });

  it('Linux 上 group 可读即拒(640)', () => {
    try {
      checkConfigPermissions(FILE, { platform: 'linux', getMode: () => 0o100640 });
      throw new Error('应当抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).category).toBe('CONFIG_PERMISSION');
      expect((e as AppError).hint).toContain('chmod 600');
    }
  });

  it('Linux 上 other 可读即拒(604)', () => {
    expect(() =>
      checkConfigPermissions(FILE, { platform: 'linux', getMode: () => 0o100604 }),
    ).toThrow(AppError);
  });

  it('Linux 上 world-writable 拒(666)', () => {
    expect(() =>
      checkConfigPermissions(FILE, { platform: 'linux', getMode: () => 0o100666 }),
    ).toThrow(AppError);
  });
});
