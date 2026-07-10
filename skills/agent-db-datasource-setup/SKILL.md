---
name: agent-db-datasource-setup
description: >-
  根据项目代码自动为 agent-db 配置数据源:识别任意项目里的数据库连接配置
  (Spring Cloud + Nacos 配置中心、Spring 本地 yml/properties、.env、docker-compose 等),
  取到 JDBC URL / 账密后转换合并进 agent-db 的 datasources.yaml,并做连通性验证。
  当用户想查某个项目的数据库但 agent-db 还没配对应数据源、
  说"帮我把 XX 项目的数据源配上 / 连一下 XX 项目的库 / 配置数据源"、
  提到 Nacos 等配置中心里的数据库配置,或 agent-db 报 DATASOURCE_NOT_FOUND
  而上下文指向某个项目代码库时,都用本 skill。
---

# agent-db-datasource-setup — 从项目自动配置 agent-db 数据源

目标:用户给一个项目路径(或上下文里有项目),你把它连的数据库变成 `agent-db` 里**可直接查询**的数据源。
通用链路:**识别配置来源 → 选环境 → 取连接信息 → 解析映射 → 合并写入 → 验证**。
本 skill 不绑定任何具体项目或框架——下面的来源清单是常见形态,遇到没列到的形态,目标不变:找到 JDBC URL(或等价的 host/port/库/账密)即可。

## 第 1 步:识别配置来源

在项目里找数据库配置的藏身处(**排除 `target/`、`build/`、`node_modules/`、`dist/`** 等产物目录),按命中情况路由:

| 找到什么 | 说明 | 下一步 |
|---|---|---|
| `**/bootstrap*.yml` 含 `nacos` | Spring Cloud,真配置在 Nacos 配置中心 | 第 2、3 步,详见 [references/nacos.md](references/nacos.md) |
| `**/application*.yml` / `*.properties` 里直接有 `spring.datasource.url`(或 `jdbc:` 串) | Spring 本地配置 | 直接进第 4 步 |
| `.env` / `.env.*` 里有 `DATABASE_URL` / `DB_HOST` 等 | Node / Python 等项目 | 直接进第 4 步 |
| `docker-compose*.yml` 里有 mysql/postgres 等服务 | 本地容器库:`image` + `ports` 映射 + `MYSQL_ROOT_PASSWORD` 等 env | host 通常是 `localhost` + 映射端口,进第 4 步 |
| 都没有 | 兜底:`Grep 'jdbc:'` 全仓搜;还没有就把找过的位置告诉用户,问配置在哪 | — |

- 多个来源同时命中(如既有 bootstrap 又有本地 application-dev.yml)→ 以**实际生效**的为准:Spring 里 profile 对应哪个文件、Nacos 共享配置会覆盖本地,拿不准就把两份都解析出来给用户选。
- 多模块项目里各模块常指向**同一个**配置中心/库,按(地址, namespace, group, data-id)或(host, port, 库, user)去重,别重复配。
- 同一文件内多 profile(`---` 分段)按 `spring.profiles` 区分,等同多环境文件。

## 第 2 步:选环境

配置常按环境拆分:`-dev` / `-test` / `-pre` / `-prod` 后缀文件、`.env.production`、profile 分段等。各环境的配置中心地址、命名空间甚至账密都可能不同。

- 用户指明了环境就用那个;没指明就列出发现的环境问用户(别替用户猜生产)。
- **prod 是红线**:把生产库账密写进本地明文配置,必须先得到用户明确同意,并提醒一句明文存储的事实。dev/test/pre 正常做即可。

## 第 3 步:从配置中心拉配置(仅配置中心路线)

Nacos 项目按 [references/nacos.md](references/nacos.md) 操作(登录、拉取、搜索兜底、代理与集群的坑都在那)。
其他配置中心(Apollo / Consul / Spring Cloud Config...)思路相同:从 bootstrap 拿地址与凭证 → 用其开放 API 拉原文 → 找 `datasource` 部分;具体 API 现查现用,拉不到就向用户要一份配置原文,链路照走。

## 第 4 步:解析连接信息 → agent-db 字段

按 [references/jdbc-mapping.md](references/jdbc-mapping.md) 把 JDBC URL(或 `DATABASE_URL`、compose 服务定义)映射成 agent-db 数据源条目:driver 判定、URL 拆解、多数据源(dynamic-datasource)展开、DM 的 schema 特例都在那。
注意被注释掉的旧配置(`# url: jdbc:mysql://...`)——不是生效配置,别误用,但可作为线索提给用户。

## 第 5 步:合并写入 datasources.yaml

配置文件位置(与 agent-db 一致的解析顺序):

1. 环境变量 `AGENT_DB_CLI_CONFIG` 指向的文件(设置了就用它);
2. Windows:`%APPDATA%\agent-db-cli\datasources.yaml`;
3. 其他:`$XDG_CONFIG_HOME/agent-db-cli/datasources.yaml`(缺省 `~/.config`)。

写入规则:

- **增量合并,不重写整个文件**:先 Read,再用 Edit 在 `datasources:` 下追加新条目,已有条目一字不动。
- **id 命名**:`<项目/应用短名>-<env>`,如 `orders-test`;`label` 用业务名 + 环境,方便日后 `agent-db list` 按业务匹配。
- **同 id 已存在** → 别静默覆盖;对比新旧内容,有差异就把差异摆给用户定夺。
- **同 host+port+database+user 已存在但 id 不同** → 不新增,直接告诉用户已有哪个 id 可用(避免一库多名)。
- 文件不存在就创建(含 `datasources:` 根键);目录不存在先建目录。

## 第 6 步:验证

```bash
agent-db query --ds <新id> "SELECT 1"
```

- 成功 → 向用户汇报:配了哪个 id、指向哪个库(host/database)、怎么用(`agent-db query --ds <id> ...`)。
- `CONNECT` 失败 → 检查:host 是否可达(库所在网段可能与配置中心不同;容器库要用映射后的 localhost 端口)、端口、账密;把连接串原文(密码打码)给用户看,让用户判断。
- 配置来源不可达(如某环境的 Nacos 挂了)→ 如实报告,**不要凭空编造连接信息**;给出可行下一步(换环境 / 找运维 / 用户手工提供配置)。

## 安全与汇报口径

- **密码不回显**:聊天输出、最终汇报里都用 `***` 代替密码;它只该出现在 datasources.yaml 里。
- datasources.yaml 是**明文存储**(agent-db 的既定设计,护栏在 DB 层只读账号);第一次为用户新建该文件时提醒一句:别把它放进同步盘/代码库。
- 只做"读项目配置 + 写本地 agent-db 配置"这一件事;不要改项目里的任何文件,也不要把拉到的整份配置中心原文贴进对话(常混有 Redis 密码等无关敏感信息,只取 datasource 部分)。
