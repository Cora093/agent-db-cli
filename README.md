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

列出数据源：

```bash
agent-db list
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

执行查询：

```bash
agent-db query --ds prod-mysql-ro "SELECT id, status FROM orders ORDER BY id DESC LIMIT 20"
```

从文件或 stdin 读取 SQL：

```bash
agent-db query --ds prod-mysql-ro --file ./query.sql
cat query.sql | agent-db query --ds prod-mysql-ro --file -
```

## 参数

全局参数：

```text
--config <path>          指定配置文件
--format json|table|csv  输出格式，默认 json
--version                输出版本
```

查询参数：

```text
--limit <n>              行数限制，范围 1..500，默认 500
--timeout <sec>          超时时间，默认 30 秒
-f, --file <path>        SQL 文件；使用 - 表示从 stdin 读取
--out <path>             将完整结果写入文件
--no-spill               不写入 spill 文件，改为内联输出预览
```

## 输出约定

- 成功数据输出到 stdout。
- 错误和提示输出到 stderr。
- 默认格式是 JSON。
- 大结果会自动写入 NDJSON 文件，stdout 只输出预览和 `meta.spillPath`。
- `--out <path>` 会把完整结果写入指定文件。

这个约定方便 shell 脚本和 Agent 把 stdout 当作纯数据通道处理。

## 只读安全模型

`agent-db-cli` 采用多层防护：

1. 使用数据库只读账号。这是真正的安全边界。
2. 数据库支持时使用只读事务。
3. 连接前进行 SQL 守卫检查，拒绝多语句、DML、DDL、文件写入和锁读。
4. 强制资源限制：禁多语句、服务端超时、500 行硬上限。

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
