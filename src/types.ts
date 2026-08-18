/** 跨层共享的基础类型。 */

/** `driver` 点名真引擎(§4)。MySQL 协议族共享传输,但各自策略。 */
export type DriverName =
  | 'mysql'
  | 'doris'
  | 'starrocks'
  | 'tidb'
  | 'oceanbase'
  | 'postgres'
  | 'dm';

/** SQL 守卫识别出的首关键字类别(§7)。决定是否放行 + 是否需要 LIMIT 改写。 */
export type StatementKind = 'select' | 'with' | 'show' | 'explain' | 'describe';

/** 输出格式(§9)。默认 json(agent-first)。 */
export type OutputFormat = 'json' | 'table' | 'csv';

/**
 * 归一化后的值(0.2.0 输出契约)。Dialect 按列类型(ColKind)把驱动原生值收敛到:
 *   - 整数(含 BIGINT)→ number;超 2^53 安全范围 → string(精度保真)
 *   - DECIMAL / NUMERIC → string(任意精度与 scale 保真)
 *   - 原生 BOOL → boolean(tinyint(1) 不猜,留数字)
 *   - JSON / 数组列 → 原生对象 / 数组(嵌套结构保留)
 *   - 日期/时间 → 文本直传(无时区不贴 Z;timestamptz → UTC ISO)
 *   - 二进制 / BLOB → "<binary, N bytes>" string
 *   - NULL → null(与空串可区分)
 */
export type SqlValue =
  | string
  | number
  | boolean
  | null
  | SqlValue[]
  | { [key: string]: SqlValue };
