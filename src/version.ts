import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 读取自身 package.json 版本(运行时,兼容 dev/tsx 与 dist)。 */
export function getVersion(): string {
  try {
    const pkg = fileURLToPath(new URL('../package.json', import.meta.url));
    return JSON.parse(readFileSync(pkg, 'utf8')).version as string;
  } catch {
    return '0.0.0';
  }
}
