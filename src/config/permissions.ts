import fs from 'node:fs';
import { AppError } from '../errors.js';

/**
 * 凭证文件权限校验(§6)。配置与密码不分家,故文件权限即护栏。
 *   - Linux/POSIX:要求 chmod 600;group/other 有任意权限即拒。
 *   - Windows:%APPDATA% 天然按用户隔离,POSIX 位无意义 → 跳过。
 *
 * platform / getMode 可注入,便于测试。
 */
export function checkConfigPermissions(
  filePath: string,
  opts: {
    platform?: NodeJS.Platform;
    getMode?: (p: string) => number;
  } = {},
): void {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') return;

  const getMode = opts.getMode ?? ((p) => fs.statSync(p).mode);
  const mode = getMode(filePath);

  // 0o077 = group + other 的 rwx;非 0 即 group/other 有权限
  if ((mode & 0o077) !== 0) {
    const perm = (mode & 0o777).toString(8).padStart(3, '0');
    throw new AppError(
      'CONFIG_PERMISSION',
      `配置文件权限过宽 (当前 ${perm}),含明文密码,group/other 不应可访问`,
      { hint: `请收紧权限: chmod 600 ${filePath}` },
    );
  }
}
