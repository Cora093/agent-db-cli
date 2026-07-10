import { AppError } from '../errors.js';

/**
 * 凭证解析(§6)。`password` 支持前缀引用,换后端不改格式:
 *   - "env:VAR"  → 从环境变量取(文件里不落明文)
 *   - 其它       → 字面量原样返回
 *   - undefined  → 空串(部分库允许空密码)
 *
 * 评审决定 #17:不做转义。以 "env:" 开头一律按引用处理(字面量撞上极罕见,
 * 撞上时临时改密码或用 inline)。将来可扩展 "keyring:" 等前缀。
 */
export function resolveSecret(raw: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (raw == null) return '';

  if (raw.startsWith('env:')) {
    const varName = raw.slice('env:'.length);
    if (!varName) {
      throw new AppError('CONFIG', 'password 引用 env: 后缺少变量名', {
        hint: '写成 password: env:YOUR_VAR_NAME',
      });
    }
    const val = env[varName];
    if (val == null) {
      throw new AppError('CONFIG', `环境变量未设置: ${varName}`, {
        hint: `password: env:${varName} 引用的环境变量不存在,请先 export ${varName}=...`,
      });
    }
    return val;
  }

  return raw;
}
