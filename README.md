# agent-db-cli

`agent-db-cli` 是一个只读、多数据源的数据库查询 CLI。它面向需要快速查看数据库结构和执行读取查询的开发者，也适合被 AI Agent 作为本地工具调用。

它统一支持 MySQL 协议族、PostgreSQL 和达梦 DM，并在连接数据库前拦截明显的非读取 SQL。CLI 的输出约定很简单：成功数据走 stdout，错误走 stderr，便于脚本和 Agent 稳定消费。

## 适用场景

- 查看本机配置了哪些数据源。
- 搜索表名、查看表结构。
- 对只读库执行 `SELECT` / `SHOW` / `EXPLAIN` 等读取查询。
- 把查询结果输出为 JSON、表格或 CSV。
- 让 Agent 在明确数据源边界内读取数据库信息。

不适合的场景：

- 写入、变更、迁移或管理数据库。
- 跨数据源联邦查询。
- 无限制大批量导出。
- 替代数据库账号权限控制。

## 支持的数据库

| 类型 | driver |
|---|---|
| MySQL 协议族 | `mysql`、`doris`、`starrocks`、`tidb`、`oceanbase` |
| PostgreSQL | `postgres` |
| 达梦 DM | `dm` |

### Driver 能力矩阵

以下矩阵由统一 driver descriptor 校验。`account-only` 表示引擎不启用显式只读事务,安全边界依赖只读账号;`DML-only` 表示显式只读事务主要阻断 DML。超时单位是发送给服务端变量的单位,CLI 的 `--timeout` 仍统一使用秒。

| driver | protocol | default port | introspection | read-only transaction | timeout unit | cancellation | row limit |
|---|---|---:|---|---|---|---|---|
| `mysql` | mysql | 3306 | full | DML-only | ms | connection-close | SQL rewrite + event stream |
| `doris` | mysql | 3306 | best-effort | account-only | s | connection-close | SQL rewrite + event stream |
| `starrocks` | mysql | 3306 | best-effort | account-only | s | connection-close | SQL rewrite + event stream |
| `tidb` | mysql | 3306 | full | DML-only | ms | connection-close | SQL rewrite + event stream |
| `oceanbase` | mysql | 3306 | best-effort | DML-only | us | connection-close | SQL rewrite + event stream |
| `postgres` | postgres | 5432 | full | strong | ms | connection-close | SQL rewrite + cursor |
| `dm` | dm | 5236 | best-effort | strong | none | connection-close | SQL rewrite + result set + maxRows |

## 本地运行

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run dev -- --version
```

本仓库使用 Corepack 固定 `pnpm@11.13.0`。首次使用前请启用 Corepack：`corepack enable`。

开发时通过 `pnpm run dev --` 调用 CLI：

```bash
pnpm run dev -- list
pnpm run dev -- query --ds prod-mysql-ro "SELECT 1"
```

构建后入口位于 `dist/cli.js`，bin 名为 `agent-db`。

## 配置数据源

默认配置文件位置：

| 平台 | 路径 |
|---|---|
| Linux | `$XDG_CONFIG_HOME/agent-db-cli/datasources.yaml`，或 `~/.config/agent-db-cli/datasources.yaml` |
| Windows | `%APPDATA%\agent-db-cli\datasources.yaml` |
| 显式指定 | `AGENT_DB_CLI_CONFIG=/path/to/datasources.yaml`，或命令行 `--config <path>` |

最小配置示例：

```yaml
datasources:
  prod-mysql-ro:
    label: 订单生产库只读
    driver: mysql
    host: prod-mysql-readonly.example.com
    port: 3306
    database: orders
    user: app_readonly
    password: env:PROD_MYSQL_PASSWORD
```

完整多引擎示例见 [`examples/datasources.example.yaml`](examples/datasources.example.yaml)。

配置说明：

- `datasources` 下的 key 就是命令行使用的 `<id>`。
- `label` 可选，用于显示更友好的业务名。
- `password` 可以写明文，也可以用 `env:VAR_NAME` 从环境变量读取。
- PostgreSQL 和 DM 可设置 `schema` 作为裸表名的默认 schema。
- POSIX 系统上，如果配置文件包含明文密码，文件权限必须是 `600`。

## 常用命令

发现 CLI 和 driver 能力（无需配置或连接）：

```bash
agent-db capabilities
```

列出数据源：

```bash
agent-db list
```

列出可见 schema/namespace：

```bash
agent-db namespaces --ds prod-mysql-ro
```

查看表：

```bash
agent-db tables --ds prod-mysql-ro
agent-db tables --ds prod-mysql-ro --like '%order%'
```

查看表结构：

```bash
agent-db schema --ds prod-mysql-ro --table orders
agent-db schema --ds analytics-pg-ro --schema sales --table orders
```

`schema` 的 JSON 中，`columns`、`primaryKey`、`indexes`、`constraints`、`foreignKeys`、`comment` 和 `viewDefinition` 都是 `{ status, data, detail? }`。`status` 为 `full` 时空数组表示确定不存在；`best-effort` 或 `unsupported` 时不能把空数组解释为不存在。表格使用带名称的多 section 输出；CSV 使用统一的 `section,field1,...` 结构，每行列数一致，普通 CSV 解析器可直接读取，不会静默省略键、索引或约束。

执行查询：

```bash
agent-db query --ds prod-mysql-ro "SELECT id, status FROM orders ORDER BY id DESC LIMIT 20"
```

从文件或 stdin 读取 SQL：

```bash
agent-db query --ds prod-mysql-ro --file ./query.sql
cat query.sql | agent-db query --ds prod-mysql-ro --file -
```

## 元数据自省能力

| driver | namespace | columns/comments | PK/index/constraints/FK | view definition |
|---|---|---|---|---|
| `mysql` | full | full | full | full |
| `postgres` | full | full | full | full |
| `dm` | best-effort（从当前账号可见对象推导） | full columns；其余 best-effort | best-effort | best-effort |
| `tidb` | full | full | full | full |
| `doris` / `starrocks` / `oceanbase` | full | full | best-effort | best-effort |

能力状态由命令输出携带；MySQL 协议兼容引擎的 `information_schema` 实现随版本和部署配置变化，因此 best-effort 项不能推断为确定不存在。

## 参数

全局参数：

```text
--config <path>          指定配置文件
--format json|ndjson|table|csv  输出格式，默认 json
--version                输出版本
```

查询参数：

```text
--limit <n>              行数限制，范围 1..500，默认 500
--timeout <sec>          超时时间，默认 30 秒
-f, --file <path>        SQL 文件；使用 - 表示从 stdin 读取
--out <path>             将资源预算内的完整结果写入文件
--no-spill               不写入 spill 文件，改为内联输出预览
```

## 输出约定

结构化输出契约版本为 `1.0`。成功数据只写 stdout，错误、诊断和提示只写 stderr。Commander 参数错误也只输出一个版本化 `BAD_USAGE` JSON；`--help` / `--version` 保持文本成功输出。

- 默认格式是 JSON。小结果保持内联；大结果读取时写入版本化 NDJSON，stdout 只输出预览和 `meta.spillPath`。
- 流式 NDJSON 第一行是 header，每行是 row，完成后追加带最终 metadata 的 trailer。
- `--out <path>` 逐行写同目录临时文件，成功完成后原子替换目标；失败不会截断已有文件。JSON/NDJSON 带完成 metadata；CSV 无法自描述字节截断，因此结果字节预算耗尽时导出失败；table 保持原对齐格式并在 8 MiB 预算内缓冲。

默认 JSON 查询结果是列式结构：

```json
{"contractVersion":"1.0","ds":"prod-mysql-ro","columns":["id","status"],"rows":[[1,"paid"]],"meta":{"rowCount":1,"deliveredRowCount":1,"ms":8,"queryTruncated":false,"deliveryOmittedRows":0,"mode":"inline","spillPath":null,"outPath":null,"bytes":null,"truncationReason":null,"resultBytes":null}}
```

错误 JSON 同样带版本：`{"contractVersion":"1.0","error":{"category":"...","message":"..."}}`。

- `rowCount` 是数据库返回给 CLI 的行数；`deliveredRowCount` 是当前 stdout/文件实际携带的行数。
- `queryTruncated` 表示读取阶段因行数或结果字节预算丢弃了数据库行，`truncationReason` 区分 `row-limit` / `result-bytes`；`deliveryOmittedRows` 只表示预览或 `--no-spill` 在交付层省略的已接受行，两者不得混用。
- `meta.mode` 为 `inline`、`preview`、`stdout` 或 `out`；路径和字节字段始终存在，不适用时为 `null`。
- 所有 NDJSON（`list/tables/schema/query` stdout、spill、`--out .ndjson`）使用同一协议：第一行是版本化 `type: "header"`，含命令、原始 `columns`、唯一 `keys` 和 meta；后续是零或多个版本化 `type: "row"` 记录。流式文件最后追加版本化 `type: "trailer"` 和最终 meta；空结果仍有 header。
- 重复列标签保留在列式 JSON/CSV 的原位置；NDJSON row 的对象 key 全局唯一，冲突时追加 `#N`。
- `--out` 文件内 meta 带真实 `outPath`，`bytes` 是最终文件的 UTF-8 字节数（包含 JSON envelope 或 NDJSON header/rows/trailer）；stdout 摘要报告同一个值。

能力发现无需配置或数据库连接：

```bash
agent-db capabilities
```

它返回版本化 JSON，包含命令、只读 statement keywords/aliases（包括 `desc -> describe`）、limit/timeout、输出格式，以及每个 driver 的事务、服务端超时和自省能力。

### 从 0.1.x 迁移

消费方必须允许新增字段并检查 `contractVersion` 主版本。把旧 `meta.truncated` 迁移为 `meta.queryTruncated`，用 `deliveryOmittedRows` 判断 stdout 是否只是预览；用 `deliveredRowCount` 校验当前载荷。旧的“每行直接是数据对象”NDJSON 解析器必须改为先读取 `type: "header"`，再从每个 `type: "row"` 的 `row` 字段取数据。
`agent-db-cli` 采用多层防护：

1. 使用数据库只读账号。这是真正的安全边界。
2. 数据库支持时使用只读事务。
3. 连接前进行 SQL 守卫检查，拒绝多语句、DML、DDL、文件写入和锁读。
4. 强制资源限制：禁多语句、查询超时、500 行硬上限、8 MiB 客户端结果预算和 1 MiB 单字段预算。MySQL 使用行事件、PostgreSQL 使用 cursor、DM 使用 `ResultSet.getRows` + `maxRows` 在读取层兜底；预算耗尽会停止底层读取。MySQL/PostgreSQL 另有服务端超时，DM 到期后会强制断开并废弃承载查询的连接。spill/`--out` 逐行写文件且不绕过硬顶，未知 LIMIT/FETCH 形态不会静默退化为无界缓冲。

SQL 守卫用于防误操作，不是完整 SQL 沙箱，也不能替代数据库账号权限。

## 退出码

| 代码 | 含义 |
|---:|---|
| 0 | 成功 |
| 1 | 通用错误、配置错误、SQL 语法错误，或表/结构问题 |
| 2 | SQL 守卫拦截查询 |
| 3 | 超时 |
| 4 | 连接或认证失败 |
| 5 | 数据源不存在 |

## 开发验证

```bash
pnpm run typecheck
pnpm test
pnpm exec vitest run test/guard.test.ts
```

`pnpm test` 只运行本地单元测试，不需要真实数据库。

集成测试默认不跑真实库。需要手动准备目标数据库，并创建夹具命名空间 `test20260609`：

```bash
AGENT_DB_CLI_IT_MYSQL='mysql://user:pass@host:3306' \
AGENT_DB_CLI_IT_PG='postgres://user:pass@host:5432/postgres' \
AGENT_DB_CLI_IT_DORIS='mysql://user:pass@host:9030' \
AGENT_DB_CLI_IT_DM='dm://user:pass@host:5236' \
pnpm run test:it
```

只会运行设置了对应 `AGENT_DB_CLI_IT_*` 变量的引擎测试。

## Agent Skills

仓库包含两个可选 skill：

- [`agent-db-query`](skills/agent-db-query/)：只读查询工作流。
- [`agent-db-datasource-setup`](skills/agent-db-datasource-setup/)：从项目文件推导数据源配置。

这些 skill 是随源码版本化的副本。请根据所使用的 Agent 运行时安装或打包。

## 发布状态

当前仓库只提供源码：

- `package.json` 仍标记为 `private: true`。
- 暂未配置 npm publish。
- 暂未配置 GitHub Release 或自动发布流程。
