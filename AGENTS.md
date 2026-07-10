# AGENTS.md

本文档面向在本仓库工作的 AI Agent。先读这里，再改代码。

## 项目定位

`agent-db-cli` 是只读、多数据源的数据库查询 CLI。它给本地开发者和 Agent 提供统一命令，用来列出数据源、查看表、查看 schema、执行读取查询。

核心约束：

- 源码是 TypeScript ESM，源码 import 必须带 `.js` 后缀。
- `tsc` 编译到 `dist/`。
- CLI bin 名是 `agent-db`。
- 成功数据走 stdout；错误、诊断和提示走 stderr。
- 项目不做写操作，不做跨源联邦查询，不做无界大导出。

支持的 driver：

- MySQL 协议族：`mysql`、`doris`、`starrocks`、`tidb`、`oceanbase`
- PostgreSQL：`postgres`
- 达梦 DM：`dm`

## 常用命令

```bash
npm run build
npm run typecheck
npm test
npx vitest run test/guard.test.ts
npm run dev -- list
npm run dev -- query --ds <id> "SELECT 1"
```

集成测试默认不跑真实库。需要时设置门控变量后手动执行：

```bash
npm run test:it
```

门控变量：

- `AGENT_DB_CLI_IT_MYSQL`
- `AGENT_DB_CLI_IT_PG`
- `AGENT_DB_CLI_IT_DORIS`
- `AGENT_DB_CLI_IT_DM`

集成测试前提：

- 目标库已有夹具命名空间 `test20260609`。
- 连接 URL 形如 `mysql://user:pass@host:3306`。
- 密码里的 `@` 编码为 `%40`。
- 本地可放 `.env.it.local`，但绝不能提交。

## 架构入口

主链路：

```text
src/cli.ts
  -> src/app.ts
  -> src/commands/{list,tables,schema,query}.ts
  -> 配置 -> 守卫 -> 方言 -> 执行 -> 输出
```

关键模块：

- `src/cli.ts`：进程入口，负责顶层错误渲染和退出码。
- `src/app.ts`：commander 装配、全局 flag、命令注册。
- `src/commands/`：命令层，保持薄封装，复用共同骨架。
- `src/config/paths.ts`：配置路径优先级为 `AGENT_DB_CLI_CONFIG` > Windows `%APPDATA%\agent-db-cli\datasources.yaml` > `$XDG_CONFIG_HOME/agent-db-cli/datasources.yaml`。
- `src/config/permissions.ts`：POSIX 下强制敏感配置文件权限为 `600`，Windows 跳过。
- `src/config/secrets.ts`：解析 `password: env:VAR`。
- `src/safety/guard.ts`：连库前 SQL 守卫，返回 sanitized SQL 供执行。
- `src/dialects/`：数据库方言策略。新增数据库时新增策略并在 `registry.ts` 注册。
- `src/dialects/normalize.ts`：类型归一。
- `src/dialects/sql-util.ts`：`applyLimit` 强制 500 行硬顶。
- `src/dialects/db-error.ts`：驱动错误分类。
- `src/errors.ts`：退出码契约。
- `src/output/`：输出格式、spill、stdout/stderr 约定。

## 安全红线

安全模型是纵深防护：

1. DB 层只读账号是真边界。
2. 能力允许时使用只读事务。
3. SQL 守卫做防误操作。
4. 资源限额控制查询成本。

改动时必须遵守：

- 不要因为“有只读账号”而放松 SQL 守卫。
- 不要把 SQL 守卫扩展成自称完整的 SQL 沙箱。
- 不要允许多语句。
- 不要新增写操作命令。
- 不要绕过 500 行硬上限。
- 不要把错误、日志或提示写到 stdout。
- 不要提交真实连接串、密码、`.env.it.local`、内部域名或内部 IP。

## SQL 守卫约定

`src/safety/guard.ts` 在连接数据库前执行，按 driver 方言做词法处理：

- 去注释。
- 拒绝多语句。
- 按首关键字 allowlist 放行读取类语句。
- 拦截 `INTO OUTFILE`。
- 拦截锁读特例。
- 返回 sanitized SQL，后续执行必须使用这个结果。

修改 guard 时至少运行：

```bash
npx vitest run test/guard.test.ts
npm test
```

## 方言和驱动

现有 7 个 driver 名收敛到 3 个实现：

- `MysqlFamilyDialect`
- `PgDialect`
- `DmDialect`

新增或修改 driver 时：

- 优先改方言策略，不要把数据库差异塞进命令层。
- 在 `src/dialects/registry.ts` 注册 driver。
- 明确事务只读能力、超时能力、schema 自省能力。
- 补充 dialect matrix、错误分类、limit、自省相关测试。
- 同步检查 README、示例配置和 `skills/`。

关键差异：

- DM 使用 `dmdb` 纯 JS 驱动；只读事务必须 `autoCommit=false` 才跨语句生效；连接需 `loginEncrypt:false`；驱动不透出列类型，所以通过 `fetchAsString` 全字符串交付；LIMIT 外还有 `maxRows` 驱动级兜底。
- Doris / StarRocks 是 OLAP 引擎，无显式只读事务配置，安全依赖只读账号；自省 best-effort。
- MySQL 协议族不同引擎的超时单位和自省深度不同，先看 `src/dialects/registry.ts`。
- PostgreSQL 只读事务强，但仍必须保留 SQL guard。

## 类型归一

`src/dialects/normalize.ts` 是跨驱动输出稳定性的核心：

- 安全整数转 number。
- DECIMAL 转字符串。
- 日期按墙钟文本返回。
- 只有 PostgreSQL `timestamptz` 返回 UTC ISO。

改类型归一时必须补或改 `test/normalize.test.ts`。

## 输出契约

输出是公共 API。保持以下约定：

- stdout 只放成功数据。
- stderr 放错误、诊断和提示。
- 默认 JSON 是列式结构。
- 大结果自动落盘 NDJSON，stdout 只给预览和 `meta.spillPath`。
- `--out` 写完整结果。

改输出时至少检查：

- `test/emit.test.ts`
- `test/output-format.test.ts`
- `test/spill.test.ts`
- `test/cli.test.ts`

## 退出码契约

退出码集中在 `src/errors.ts`：

| 代码 | 含义 |
|---:|---|
| 0 | 成功 |
| 1 | 通用错误、配置错误、SQL 语法错误，或表/结构问题 |
| 2 | SQL 守卫拦截查询 |
| 3 | 超时 |
| 4 | 连接或认证失败 |
| 5 | 数据源不存在 |

改错误分类或退出码时必须同步测试和 README。

## 配置约定

配置文件是 YAML，结构为：

```yaml
datasources:
  example:
    driver: mysql
    host: localhost
    port: 3306
    database: app
    user: readonly
    password: env:DB_PASSWORD
```

注意：

- 不保留旧项目名、旧环境变量或旧配置路径兼容。
- 当前配置环境变量是 `AGENT_DB_CLI_CONFIG`。
- 本地配置示例放 `examples/datasources.example.yaml`。
- 涉及配置字段时同步检查 README 和 `skills/agent-db-datasource-setup/`。

## 仓库约定

- `skills/` 是配套 Agent skill 的版本化副本。改 CLI 行为时同步检查 skill 示例。
- 稳定用户说明放 README；维护细节放本文件。
- GitHub Actions 只跑本地单元验证：`npm ci`、`npm run typecheck`、`npm test`。
- 暂不配置 npm publish、GitHub Release 或包发布流程。
- `package.json` 当前保持 `private: true`。
- 不新增独立 docs 目录，除非用户明确改变仓库策略。

## 变更检查清单

提交前按改动类型选择验证：

- 普通源码改动：`npm run typecheck`、`npm test`。
- SQL guard 改动：再跑 `npx vitest run test/guard.test.ts`。
- 输出改动：重点跑输出相关测试。
- driver / dialect 改动：补充对应 dialect、normalize、db-error、integration gate 说明。
- README / AGENTS 改动：至少跑 `git diff --check`。

公开发布前额外扫描敏感信息：

```bash
rg -n "sydbtool|sy-db-tool|SYDBTOOL|192\.168|GitLab|gitlab|Nexus|npm-group|npm-hosted|CLAUDE|docs/|\.gitlab|\.npmrc|medicare|MEDICARE|Clash|公司内网|npmmirror" .
```
