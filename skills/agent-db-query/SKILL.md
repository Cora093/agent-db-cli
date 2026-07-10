---
name: agent-db-query
description: >-
  对已配置的数据源做只读查询与探索,经由 agent-db CLI。
  支持 MySQL(及 MySQL 协议兼容的 Doris / StarRocks / TiDB / OceanBase)、
  PostgreSQL、达梦 DM,以及任何已配置的内部数据源。
  当用户要查数据、看表结构、跑 SELECT、统计/聚合、排查数据问题,
  或提到上述任一数据库/数据源时使用——即使没明说用哪个引擎。
---

# agent-db — 只读数据库查询

`agent-db` 是一个**只读**多数据源查询 CLI。它只能查,不能改(DML/DDL 一律被拒)。
默认输出**列式 JSON**(省 token、解析稳、类型/NULL 保真)。

## 标准流程

不确定表/列时,先发现再查(已知 schema 可跳过):

```
list → tables → schema → query
```

1. `agent-db list` — 看有哪些数据源(`id` / `label` / `driver` / `host` / `database`)。
2. `agent-db tables --ds <id> [--like '%order%']` — 看某源有哪些表(带 schema 限定)。
3. `agent-db schema --ds <id> --table <name> [--schema <s>]` — 看单表结构。
4. `agent-db query --ds <id> "<SELECT ...>"` — 执行查询。

## 选源:显式 `--ds`,无当前源状态

- **每条命令都要 `--ds <id>`**;没有 "use 当前源" 这种隐藏状态(避免多窗口/多 Agent 串味)。
- 不确定用哪个源时先 `agent-db list`,按 `label`(业务名)匹配用户意图,再用其 `id`。
- `--ds` 传错会报错并**列出所有合法 id**,据此自纠。
- **list 里根本没有合适的源**,而用户意图指向某个项目代码库(如"查 XX 项目的库")→ 用 `agent-db-datasource-setup` skill 从项目配置 / Nacos 自动配好数据源,再回来查。

## 输出:默认带 `--format json`

- 查询默认就是列式 JSON;**给人看时**才加 `--format table`;要拖进 Excel 才 `--format csv`。
- 成功结果形如 `{ "ds", "columns", "rows", "meta": { "rowCount", "ms", "truncated", "spillPath" } }`。
- 错误形如 `{ "error": { "category", "message", "hint" } }`,**只在 stderr**;数据通道(stdout)不被污染。

## 写 SQL:简单用位置参数,复杂写临时文件

| 写法 | 何时 |
|---|---|
| `query --ds prod "SELECT 1"` | 短、无引号无换行 |
| `query --ds prod -f q.sql` | **含引号/换行/较长 → 写临时 `.sql`(UTF-8)+ `-f`,跨平台最稳** |
| `query --ds prod -f -` | 管道/stdin |

- **不要用 heredoc 作主路径**:bash `<<'SQL'` 在 Windows PowerShell 不工作(那是 `@'…'@`)。一种心智模型——临时文件——同时走 Win/Linux。
- 文件/stdin 一律按 **UTF-8** 读。

## 安全红线(只读工具)

- **只读**:别试 INSERT/UPDATE/DELETE/DDL,会被拒(退出码 2)。连通性自检用 `query --ds X "SELECT 1"`。
- **窄查询**:少 `SELECT *`,选具体列 + `WHERE`/聚合/`LIMIT`,别拖垮库、别爆上下文。
- **不要自己翻配置文件提取密码、手搓连接**:查询时凭证由 agent-db 配置管理;要新增数据源,走 `agent-db-datasource-setup` skill 的规范流程,而不是即兴拼连接串。

## 大结果:自动落盘,别灌进上下文

- 工具**永不返回超过 500 行**;超阈值会**自动落盘为 NDJSON**,stdout 只给前 50 行预览 + `meta.spillPath`。
- 别把大结果灌进上下文:用 `Read(offset/limit)` / `Grep` 切 `spillPath` 文件,或**缩小 SQL 重查**。
- **聚合/计数用 SQL(`COUNT`/`SUM`/`GROUP BY`),别在客户端数行**——客户端只看到截断后的 ≤500 行,自己数会错。
- 要导出给人:`--out path.csv`(持久文件,按扩展名推断格式)。

## 错误自纠(按 `category`)

| category | 退出码 | 怎么办 |
|---|---|---|
| `SQL_SYNTAX` | 1 | 按 DB 报错的行列改 SQL |
| `DATASOURCE_NOT_FOUND` | 5 | `list` 看合法 id,改 `--ds`;确实没配过 → 走 `agent-db-datasource-setup` skill 配 |
| `TIMEOUT` | 3 | 加 `WHERE`/`LIMIT` 收窄,或 `--timeout` 调大 |
| `BLOCKED_NON_READONLY` / `BLOCKED_MULTI_STATEMENT` / `BLOCKED_FILE_WRITE` / `BLOCKED_LOCKING_READ` | 2 | 换成单条只读 SELECT(去掉 `FOR UPDATE`/`FOR SHARE`/`LOCK IN SHARE MODE` 等锁子句) |
| `AMBIGUOUS_TABLE` | 1 | 加 `--schema <name>` 或用 `schema.table` |
| `CONNECT` | 4 | 源不可达/认证失败,提示用户检查网络与凭证 |

## 生产库

全只读、**无确认门**(保持无摩擦)。没有 "敏感源" 标记;护栏在 DB 层(只读账号 + 只读事务)。

## 引擎差异 & 更多范式

- 各引擎(MySQL / PG / DM / Doris)的语法与命名空间差异:见 [references/dialects.md](references/dialects.md)。
- 常见查询范式(分页、聚合、探索、跨源对比):见 [references/examples.md](references/examples.md)。
