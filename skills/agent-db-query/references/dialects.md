# 引擎差异速查(MySQL / PostgreSQL / 达梦 DM / Doris 等)

`agent-db` 把引擎差异收敛在内部 `Dialect` 策略里,但**写 SQL 时仍需注意方言**。

## 命名空间:`database` vs `schema`

| 引擎 | 命名空间 | 一个连接覆盖 | 裸表名解析 |
|---|---|---|---|
| MySQL / Doris / StarRocks / TiDB / OceanBase | **database**(= schema 同义) | 服务器 | 配置的 `database` |
| PostgreSQL | **schema**(在 database 内) | 单个 database | `search_path` / 配置 `schema` |
| 达梦 DM | **schema(= user)** | 实例 | 当前连接用户的 schema |

- 跨 schema 取表:`schema --table sales.orders` 或 `--schema sales`。
- 表名在多个 schema 重名 → 报 `AMBIGUOUS_TABLE`,加 `--schema` 消歧。

## 分页 / 限行

| 引擎 | 写法 |
|---|---|
| MySQL 族 / DM | `... LIMIT 100` 或 `LIMIT 20, 100`(offset, count) |
| PostgreSQL | `... LIMIT 100 OFFSET 20` |

> 工具有 **500 行硬顶**:不管你写多大 LIMIT,最多返回 500 行并标 `truncated`。要全量用 `--out`,或用聚合收窄。

## 标识符引用

| 引擎 | 引用符 |
|---|---|
| MySQL 族 | 反引号 `` `col` `` |
| PostgreSQL / DM | 双引号 `"col"`(注意大小写敏感) |

- DM 默认把未加引号的标识符按**大写**处理(Oracle 风格)。

## 类型与值的呈现

- 大整数 / `DECIMAL` → **字符串**(精度保真,别当 number 解析)。
- JSON / JSONB / 数组列 → **原生对象 / 数组**(已解析,别再 `JSON.parse`)。
- 日期/时间 → **库内墙钟文本**:`DATE` 为 `"YYYY-MM-DD"`,无时区 `DATETIME`/`TIMESTAMP` 为 `"YYYY-MM-DD HH:MM:SS[.fff]"`(空格分隔、**不带 Z**,别当 UTC 解析);仅 PG `timestamptz` 才是 UTC ISO(`"…Z"`)。
- 二进制 / BLOB → 占位串 `<binary, N bytes>`(不导出字节;要原始字节本工具不适合)。
- `NULL` → JSON `null`(与空串 `""` 可区分)。
- **达梦 DM 例外**:dmdb 驱动不透出列类型,**所有值(含 INT/FLOAT/日期)一律字符串**交付。
  数值比较、排序、聚合在 SQL 里做(DB 端类型是对的);别在客户端把 `"42"` 当 number 依赖。

## Driver 能力矩阵

以下矩阵由 CLI 的统一 driver descriptor 校验。`account-only` 表示不包显式只读事务;`DML-only` 表示显式只读事务主要阻断 DML。超时单位是服务端设置单位,CLI 参数仍使用秒。

| driver | protocol | default port | introspection | read-only transaction | timeout unit | cancellation | row limit |
|---|---|---:|---|---|---|---|---|
| `mysql` | mysql | 3306 | full | DML-only | ms | connection-close | SQL rewrite |
| `doris` | mysql | 3306 | best-effort | account-only | s | connection-close | SQL rewrite |
| `starrocks` | mysql | 3306 | best-effort | account-only | s | connection-close | SQL rewrite |
| `tidb` | mysql | 3306 | full | DML-only | ms | connection-close | SQL rewrite |
| `oceanbase` | mysql | 3306 | best-effort | DML-only | us | connection-close | SQL rewrite |
| `postgres` | postgres | 5432 | full | strong | ms | connection-close | SQL rewrite |
| `dm` | dm | 5236 | best-effort | strong | none | connection-close | SQL rewrite + maxRows |

- 对 best-effort 引擎想看键/分布,直接 `query --ds <id> "SHOW CREATE TABLE <t>"`。
- PostgreSQL 的强只读事务会阻断可写 CTE 和 `EXPLAIN ANALYZE INSERT`。
- MySQL 协议族的文件写(`INTO OUTFILE`)仍由工具守卫额外拦截。
- 无论哪种,真正的边界永远是只读账号;只读事务和守卫是纵深防护。
