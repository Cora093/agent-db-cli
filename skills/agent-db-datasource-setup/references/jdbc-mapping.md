# 连接信息 → agent-db 字段映射

覆盖三类来源:Spring 的 JDBC 配置、.env 风格的 URL/散装变量、docker-compose 服务定义。
不管来源长什么样,最终都收敛为同一组字段:`driver / host / port / database / schema / user / password`。

## 来源 A:Spring 配置(YAML / properties)

认这两种结构(properties 形式同理,`spring.datasource.url=...`):

```yaml
# 单数据源(最常见)
spring:
  datasource:
    url: jdbc:dm://db.example.internal:5236/APP_SCHEMA?serverTimezone=UTC&...
    driver-class-name: dm.jdbc.driver.DmDriver
    username: APP_READER
    password: "..."

# 多数据源(baomidou dynamic-datasource)
spring:
  datasource:
    dynamic:
      primary: master
      datasource:
        master:  { url: ..., username: ..., password: ... }
        slave_1: { url: ..., username: ..., password: ... }
```

- dynamic 结构 → **每个 key 配一个 agent-db 数据源**,id 加后缀(如 `orders-test-master` / `orders-test-slave1`);只想配一个时取 `primary` 指向的。
- url 可能包了 p6spy:`jdbc:p6spy:mysql://...` → 剥掉 `p6spy:` 按里面的真协议处理。

## driver 判定(按 URL 协议,driver-class 佐证)

| JDBC URL 前缀 | driver-class-name | agent-db driver |
|---|---|---|
| `jdbc:mysql://` | `com.mysql.cj.jdbc.Driver` / `com.mysql.jdbc.Driver` | `mysql` |
| `jdbc:dm://` | `dm.jdbc.driver.DmDriver` | `dm` |
| `jdbc:postgresql://` | `org.postgresql.Driver` | `postgres` |

- **Doris / StarRocks / TiDB / OceanBase 走的也是 `jdbc:mysql://`**。线索:FE 查询端口 9030(Doris/StarRocks)、4000(TiDB)、2881(OceanBase)。能确认引擎就点名(`doris` 等,影响 `schema` 命令的自省深度提示);拿不准就先配 `mysql`,功能不受影响。
- 其他协议(oracle / sqlserver / clickhouse...)→ agent-db 不支持,如实告诉用户,别硬配。

## URL 拆解 → 字段

`jdbc:<协议>://<host>:<port>/<path>?<query>`

| agent-db 字段 | 取值 |
|---|---|
| `host` / `port` | URL 网络部分;port 缺省用驱动默认(mysql 3306 / pg 5432 / dm 5236),可不写 |
| `database` | mysql 族 / pg:URL path;**DM:不填**(见下) |
| `schema` | pg:query 里的 `currentSchema`(若有);**DM:URL path**(通常与连接用户同名,同名时可省) |
| `user` / `password` | 配置里的 `username` / `password` 原样搬 |
| `label` | 业务名 + 环境,中文,如 `医保审核 · 测试环境` |

- **DM 的 path 是 schema 不是 database**(DM 里 schema=user,实例级连接),如 `jdbc:dm://h:5236/APP_SCHEMA` → `schema: APP_SCHEMA`(user 也是 APP_SCHEMA 时可整个省略)。
- URL query 参数(`useSSL`、`serverTimezone`、`clobAsString`...)**一律丢弃**,agent-db 自己管连接参数。
- 密码若以后要换成环境变量引用,写 `password: env:VAR_NAME`;默认与现有条目保持一致(明文)。

## 来源 B:.env / DATABASE_URL 风格

```
DATABASE_URL=mysql://user:pass@host:3306/dbname      # 协议://账:密@主机:端口/库
DATABASE_URL=postgres://user:pass@host:5432/dbname   # postgres / postgresql 都见过
# 或散装:
DB_HOST=... DB_PORT=... DB_NAME=... DB_USER=... DB_PASSWORD=...
```

- URL 风格按上表同样规则拆;**账密内嵌在 URL 里**(`user:pass@`),密码可能被 URL 编码(`%40`=`@`),记得解码。
- 散装变量按名字对号入座;变量值若是 `${...}` 占位符,说明真值在部署环境里,如实告诉用户缺哪几个值。

## 来源 C:docker-compose 服务

```yaml
services:
  db:
    image: mysql:8          # 引擎看 image
    ports: ["13306:3306"]   # host=localhost,port=宿主侧(13306)
    environment:
      MYSQL_ROOT_PASSWORD: xxx   # user=root
      MYSQL_DATABASE: app_db
      # postgres 镜像则是 POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB
```

- host 用 `localhost`,port 用**冒号左边的宿主端口**;没有 `ports` 映射的库容器从宿主机连不上,如实告知。
- 前提是容器在本机跑着;验证失败时先提醒用户 `docker compose up`。

## 成品示例

输入(Nacos 拉到的):

```yaml
spring:
  datasource:
    url: jdbc:dm://db.example.internal:5236/APP_SCHEMA?serverTimezone=UTC&useSSL=false&clobAsString=1
    driver-class-name: dm.jdbc.driver.DmDriver
    username: APP_READER
    password: "..."
```

输出(追加进 datasources.yaml):

```yaml
  orders-test:
    label: 订单服务 · 测试环境
    driver: dm
    host: db.example.internal
    port: 5236
    schema: APP_SCHEMA
    user: APP_READER
    password: "..."
```
