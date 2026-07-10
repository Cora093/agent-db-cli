# Nacos 配置读取流程

适用于 Spring Cloud Alibaba 项目:从 `bootstrap*.yml` / `bootstrap*.properties` 中识别 Nacos 地址、命名空间、group、dataId 规则和鉴权信息,再通过 Nacos OpenAPI 读取配置内容。

## 第 1 步:从 bootstrap 取连接参数

重点字段:

- `spring.cloud.nacos.config.server-addr`
- `spring.cloud.nacos.config.namespace`
- `spring.cloud.nacos.config.group`
- `spring.cloud.nacos.config.file-extension`
- `spring.application.name`
- `spring.profiles.active`
- `spring.cloud.nacos.username`
- `spring.cloud.nacos.password`

`server-addr` 可能是逗号分隔的集群地址,任选一个可访问节点即可。命名空间为空时通常表示 public namespace。

## 第 2 步:登录拿 accessToken

```powershell
$login = curl.exe -s --max-time 10 -X POST "http://<server-addr>/nacos/v1/auth/login" `
  --data-urlencode "username=<username>" `
  --data-urlencode "password=<password>" | ConvertFrom-Json
```

- 密码可能包含特殊字符,必须用 `--data-urlencode`。
- 如果服务端未开启鉴权,登录接口可能不可用;后续请求可不带 `accessToken`。
- 不同环境的 Nacos 地址和账号可能不同,必须使用目标环境对应的 bootstrap 配置。

## 第 3 步:计算 dataId

常见默认规则:

```text
<spring.application.name>-<profile>.<file-extension>
```

如果 bootstrap 显式设置了 `spring.cloud.nacos.config.name` 或 `prefix`,以显式配置为准。

共享配置、扩展配置也要检查:

- `spring.cloud.nacos.config.shared-configs`
- `spring.cloud.nacos.config.extension-configs`

数据库连接通常可能在应用主配置、共享 `db` 配置或环境专用配置里。

## 第 4 步:拉取配置

```powershell
curl.exe -s --max-time 10 -G "http://<server-addr>/nacos/v1/cs/configs" `
  --data-urlencode "dataId=<dataId>" `
  --data-urlencode "group=<group>" `
  --data-urlencode "tenant=<namespace>" `
  --data-urlencode "accessToken=$($login.accessToken)"
```

成功时直接返回配置原文。只提取 datasource 相关片段,不要把整份配置中心内容贴进对话,因为它经常包含 Redis、MQ、第三方密钥等无关敏感信息。

## 搜索兜底

不知道 dataId 时,可用 Nacos 配置搜索接口模糊查找:

```powershell
curl.exe -s --max-time 10 -G "http://<server-addr>/nacos/v1/cs/configs" `
  --data-urlencode "search=blur" `
  --data-urlencode "dataId=*db*" `
  --data-urlencode "group=<group>" `
  --data-urlencode "tenant=<namespace>" `
  --data-urlencode "pageNo=1" `
  --data-urlencode "pageSize=50" `
  --data-urlencode "accessToken=$($login.accessToken)"
```

如果配置中心不可达或权限不足,如实报告原因,不要凭空编造数据库连接信息。
