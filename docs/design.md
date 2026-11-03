# Webhook Receiver 设计文档

## 1. 目标

一个运行在 Cloudflare Workers 上的推送通知中转服务：

- 冒充常见推送服务的接收接口（Bark、ntfy、Gotify、企业微信机器人等），按各自的格式接收请求
- 按订阅把消息转发到该订阅配置的一个或多个目标
- 提供简单的管理后台：固定密码登录，管理订阅、订阅的 token 和转发目标

**不做**：消息日志、全局 token、免 token 的公开订阅、独立于订阅的目标管理。

## 2. 架构

```
 发送方                         Worker                                     目标
                 ┌──────────────────────────────────────────────┐
 Bark 客户端 ──▶ │ /bark/{订阅}/...    ┐                         │
 ntfy 脚本   ──▶ │ /ntfy/{订阅}/...    │ 入站适配器               │
 Grafana 等  ──▶ │ /discord/{订阅}/... ├─▶ ① 取 token             │
 curl        ──▶ │ /default/{订阅}     │   ② 与订阅 token 比较    │
 不确定格式   ──▶ │ /all/{订阅}/...     ┘   ③ 解析成 Message       │
                 │                            │                  │     ┌────────┐
                 │                            ▼                  │ ┌──▶│ ntfy   │
                 │          订阅的 targets[]（并发发送）  ─────────┼─┼──▶│ 飞书    │
                 │                            │                  │ └──▶│ ...    │
                 │                            ▼                  │     └────────┘
                 │          ④ 按入站格式生成成功响应              │
                 │                                              │
                 │ /admin  ── 固定密码 ──▶ 管理订阅              │
                 └───────────────────────┬──────────────────────┘
                                         ▼
                                  KV: sub:{订阅名}
```

核心是一个统一的中间消息模型 `Message`。入站适配器负责“这家的请求长什么样”，出站适配器负责“目标那家要什么格式”，两边独立扩展。

## 3. URL 结构

```
/{类型}/{订阅名}/{剩余部分}
```

- **类型**：`default`（自有格式）、`all`（自动识别）、`bark`、`ntfy`、`gotify`、`wecom`、`dingtalk`、`feishu`、`discord`、`slack`、`telegram`
- **订阅名**：规则为 `[a-z0-9_-]{1,64}`。后台可以改名，改名后所有客户端的 URL 都要更新
- **剩余部分**：交给该类型的入站适配器按自己的规则解析（token 也可能在这里）
- **保留路径**：`/admin`，以及 `/admin/api/*`

订阅名和类型名分处 URL 的两段，互不冲突。新增类型不影响已有订阅。

## 4. 数据模型

### 4.1 订阅（KV）

每个订阅存为一个 KV 键 `sub:{name}`，值为 JSON：

```jsonc
{
  "name": "nas",
  "token": "T0k3n...",          // 必填，新建时自动生成随机值
  "targets": [
    { "id": "t1", "name": "家庭群", "type": "feishu", "enabled": true,
      "config": { "webhook_url": "https://open.feishu.cn/...", "sign_secret": "..." } },
    { "id": "t2", "name": "", "type": "ntfy", "enabled": true,
      "config": { "server": "https://ntfy.sh", "topic": "xxx", "auth_kind": "none" } }
  ],
  "created_at": "2026-11-02T00:00:00Z",
  "updated_at": "2026-11-02T00:00:00Z"
}
```

- 目标跟着订阅走，没有独立的目标表
- 目标以 `id`（订阅内唯一，随机生成）标识；`name` 是可选的备注名，可以为空、可以重复
- 后台列表显示类型和配置摘要，由各出站适配器的 `summary` 生成，不包含敏感值：ntfy 显示 topic（非 ntfy.sh 时加服务器），Gotify 显示服务器域名，Webhook 显示方法和域名，飞书、企业微信显示密钥末 4 位
- 用 zod 判别联合（按 `type`）校验目标配置，前后端共用同一份 schema

### 4.2 KV 一致性带来的影响

KV 是最终一致的，以下行为是已知并接受的：

- 重置 token 后，其他地区的旧 token 最多约 60 秒内仍可用
- 后台列表使用的 `list({ prefix: "sub:" })` 也是最终一致的。新建或删除后，后台用保存接口的返回值直接更新页面，不再重新读取列表
- KV 免费计划每天 1000 次写入。只有后台操作写入，webhook 只读

### 4.3 统一消息 Message

```ts
interface Message {
  title?: string;
  body: string;
  url?: string;            // 点击跳转链接
  level?: "info" | "warn" | "critical";
  tags?: string[];
  group?: string;
  markdown?: boolean;      // body 是否为 Markdown，出站适配器自行降级
  extra?: Record<string, unknown>;  // 入站格式特有、无法映射的字段
}
```

`body` 是唯一必填字段。入站适配器解析不出任何文本时返回 400。

## 5. 鉴权

### 5.1 webhook

- 每个订阅必须有一个 token，不支持公开订阅
- 每个入站适配器到该格式约定的位置取 token（见第 6 节），再与订阅的 token 比较
- 比较使用 `crypto.subtle.timingSafeEqual`，先比较长度
- 订阅不存在、token 不匹配，统一返回 401，不区分具体原因，避免探测订阅名

### 5.2 后台

- 密码放在 Worker secret `ADMIN_PASSWORD`
- 登录成功后下发 HMAC 签名 cookie（`HttpOnly; Secure; SameSite=Strict`），带过期时间。签名密钥放在 secret `SESSION_SECRET`，无需服务端存储
- 登录接口用 Workers Rate Limiting binding 限流，防止暴力破解
- 修改密码 = 修改 secret 后重新部署，后台不提供改密码功能

## 6. 入站适配器

每个入站适配器实现三件事：

```ts
interface InboundAdapter {
  type: string;
  extractToken(req: RequestView): string | null;   // 到该格式约定的位置取 token
  parse(req: RequestView): Message;                 // 解析成统一消息
  respond(result: ForwardResult): Response;         // 生成该格式要求的成功响应
  detect?(req: RequestView, token: string): Tier | null;  // 供 all 使用
}
```

`RequestView` 是请求预解析一次后的只读视图（method、路径剩余段、query、headers、按 content-type 解析的 body 字段，以及原始文本）。Workers 的 Request body 只能读一次，所有适配器都读同一个 `RequestView`。

### 6.1 类型清单

以订阅 `nas`、token `T0k3n` 为例：

| 类型 | 示例 URL | token 位置 | 成功响应 |
|---|---|---|---|
| default | `/default/nas?token=T0k3n` | `?token=` 或 `Authorization: Bearer` | 见 6.2 |
| all | `/all/nas?token=T0k3n` | 由识别结果决定 | 由识别结果决定 |
| bark | `/bark/nas/T0k3n/标题/内容` | 路径第一段，或 body 的 `device_key` | `{"code":200,"message":"success"}` |
| ntfy | `/ntfy/nas/T0k3n` | topic（路径第一段） | 消息对象（含 `id`、`time`、`event:"message"`） |
| gotify | `/gotify/nas/message?token=T0k3n` | `?token=` 或 `X-Gotify-Key` 头 | 消息对象（含 `id`） |
| wecom | `/wecom/nas/cgi-bin/webhook/send?key=T0k3n` | `?key=` | `{"errcode":0,"errmsg":"ok"}` |
| dingtalk | `/dingtalk/nas/robot/send?access_token=T0k3n` | `?access_token=` | `{"errcode":0,"errmsg":"ok"}` |
| feishu | `/feishu/nas/open-apis/bot/v2/hook/T0k3n` | 路径最后一段 | `{"code":0,"msg":"success"}` |
| discord | `/discord/nas/api/webhooks/0/T0k3n` | 路径最后一段 | 204 |
| slack | `/slack/nas/services/x/x/T0k3n` | 路径最后一段 | 纯文本 `ok` |
| telegram | `/telegram/nas/botT0k3n/sendMessage` | 路径中 `bot` 后的部分 | `{"ok":true,"result":{...}}` |

上表的请求格式和响应格式凭经验整理，实现时需逐个对照官方文档核对。真实的发送端实现可以参考 Uptime Kuma 的 `server/notification-providers/` 目录。

各格式的字段映射（要点）：

- **bark**：GET 路径 `/:key/:body` 或 `/:key/:title/:body`，也接受 query/JSON 的 `title`、`body`、`url`、`group`、`level`；`level` 的 `critical`/`timeSensitive` 映射为 `critical`/`warn`
- **ntfy**：POST 纯文本 body 为正文，`X-Title`/`Title`、`X-Priority`、`X-Tags`、`X-Click` 头；也接受发布到根路径的 JSON（`topic`、`title`、`message`、`priority`、`tags`、`click`）。priority 1–2→info，3→info，4→warn，5→critical
- **gotify**：JSON 或表单的 `title`、`message`、`priority`、`extras`；priority 0–3→info，4–7→warn，8–10→critical；`extras["client::display"].contentType == "text/markdown"` 时 `markdown=true`
- **wecom / dingtalk**：`msgtype` 为 `text`（`text.content`）或 `markdown`（`markdown.content`，钉钉另有 `markdown.title`），其余 msgtype 尽量提取文本，提取不到则把原始 JSON 作为正文
- **feishu**：`msg_type` 为 `text`（`content.text`）、`post`（拼接富文本）、`interactive`（提取卡片标题和文本元素）
- **discord**：`content` 为正文；有 `embeds` 时取第一个 embed 的 `title`、`description`、`url`，`markdown=true`
- **slack**：`text` 为正文；有 `blocks` 时拼接 `section`/`header` 的文本，`markdown=true`
- **telegram**：`sendMessage` 的 `text`；`parse_mode` 为 Markdown/MarkdownV2/HTML 时 `markdown=true`（HTML 先剥离标签）；`chat_id` 忽略

### 6.2 default（自有格式）

```jsonc
POST /default/nas
Authorization: Bearer T0k3n
Content-Type: application/json

{
  "title": "部署完成",
  "body": "v1.2.3 已上线",
  "url": "https://example.com/release",
  "level": "info",          // info | warn | critical
  "tags": ["deploy"],
  "group": "ci",
  "markdown": false
}
```

- 也支持 GET：`/default/nas?token=T0k3n&title=..&body=..`，便于 curl、浏览器书签和 iOS 快捷指令
- 也支持表单（`application/x-www-form-urlencoded`）和纯文本 body（整个 body 作为正文）
- 宽松别名：`body` ← `message` / `content` / `text` / `desp` / `msg`；`title` ← `subject`
- 响应：

```json
{ "ok": true, "results": [ { "id": "t1", "name": "家庭群", "ok": true }, { "id": "t2", "name": "手机", "ok": false, "error": "timeout" } ] }
```

### 6.3 all（自动识别）

```
请求
 │
 ▼
预解析 → RequestView
 │
 ▼
依次让每个适配器 extractToken，结果与订阅 token 比较
 │
 ├─ 没有任何适配器取到匹配的 token ──▶ 401
 │
 ▼
在取到匹配 token 的候选适配器中，调用 detect 报告信号等级
 │
 ├─ 有 definitive / strong ──▶ 取等级最高者；同级按固定优先级
 └─ 只有 weak 或没有         ──▶ default（宽松解析）
                                  └─ 提取不到任何文本 ──▶ 400
```

“token 出现在哪个位置”本身就是最强的格式信号。例如企业微信与钉钉都用 `msgtype`，但 token 一个在 `?key=`、一个在 `?access_token=`。

信号等级：

| 等级 | 示例 |
|---|---|
| definitive | `X-Gotify-Key` 头、`/message` 路径 + `?token=`、`/open-apis/bot/v2/hook/`、`/api/webhooks/`、`/services/`、`/bot…/sendMessage`、`device_key` 字段、`msg_type` 字段 |
| strong | `msgtype` 字段、`X-Title`/`X-Priority` 头、`embeds`、`blocks`、`chat_id` + `text`、Bark 形状的 GET 路径 |
| weak | `title` + `body`、单独的 `content` / `text` / `message` |

同级优先级（高到低）：telegram、discord、slack、feishu、wecom、dingtalk、gotify、ntfy、bark、default。

识别结果写入响应头 `X-Detected-Format: gotify; tier=definitive`。成功响应体按识别出的格式生成。

## 7. 出站适配器

```ts
interface OutboundAdapter<C> {
  type: string;
  schema: ZodType<C>;                             // 目标配置校验
  secretFields: (keyof C)[];                      // 后台需要打掩码的字段
  send(msg: Message, config: C): Promise<void>;  // 非 2xx 或业务错误码时抛错
}
```

| 类型 | 配置 | 要点 |
|---|---|---|
| ntfy | `server`、`topic`、`auth`（`none` / `bearer` + token / `basic` + 用户名密码） | 用 JSON 发布到 `server` 根路径，避免 `X-Title` 头里的非 ASCII 编码问题；level→priority：info→3，warn→4，critical→5 |
| gotify | `server`、`app_token` | `POST /message`；level→priority：info→5，warn→7，critical→10；`markdown=true` 时设置 `extras["client::display"].contentType` |
| webhook | `url`、`method`（GET/POST/PUT）、`headers`、`body_template`、`content_type` | 模板只支持 `{{title}}`、`{{body}}`、`{{url}}`、`{{level}}`、`{{tags}}`、`{{group}}` 替换；JSON 类型时替换值做 JSON 字符串转义 |
| feishu | `webhook_url`、`sign_secret`（可选） | 有签名时附带 `timestamp` 和 `sign`（timestamp + "\n" + secret 做 HMAC-SHA256 后 base64）；检查响应 `code == 0` |
| wecom | `key` | `markdown=true` 时用 `markdown` 消息类型，否则 `text`；正文超长截断（以官方限制为准）；检查响应 `errcode == 0` |

通用规则：

- 每个目标请求设置超时（例如 10 秒，用 `AbortSignal.timeout`）
- 目标不支持 Markdown 时，原样作为纯文本发送
- 有 `title` 但目标没有标题字段时，拼成 `title\n\nbody`

## 8. 转发流程

```
1. 解析 URL：type、订阅名、剩余路径
2. 读取 KV sub:{name}；不存在 → 401
3. 入站适配器 extractToken + 比较；不匹配 → 401
4. parse → Message；失败 → 400
5. 对 enabled 的 targets 用 Promise.allSettled 并发 send
6. 至少一个成功 → 入站适配器 respond（2xx）
   全部失败或没有启用的目标 → 502
7. 响应头 X-Forward-Result: t1=ok; t2=error:timeout
```

部分目标失败时仍返回成功，避免发送方重试导致已成功的目标重复收到消息。失败情况只能通过 `X-Forward-Result` 头、`default` 响应体和 `wrangler tail` 观察。

## 9. 管理后台

单页 HTML + 原生 JS，通过 Workers Static Assets 托管在 `/admin`，接口在 `/admin/api/*`。

### 9.1 页面

```
 [订阅名 ____________ ] [+ 新建订阅]

 nas   T0k•••••                                          [编辑订阅]
 [all · 自动识别 ▾]  https://w.dev/all/nas?token=T0k3n        [复制]
 ─────────────────────────────────────────────────────────────
 转发目标（2）                                          [+ 添加目标]
 启用  飞书机器人  家庭群  …1234                    [编辑] [删除]
 停用  ntfy  alerts                               [编辑] [删除]
```

每个订阅一张卡片：

- 格式下拉框列出全部 11 种入站类型，旁边显示所选格式的完整 URL 和复制按钮。每个订阅上次选的格式记在 localStorage
- URL 由前端用 `location.origin` 加各类型的模板拼出，后端不需要额外接口
- 转发目标直接列在卡片里，每行显示类型、备注名（有的话）和配置摘要，可以新增、单条编辑、单条删除
- 复制使用 `navigator.clipboard`（Workers 默认 HTTPS，本地 `wrangler dev` 用 localhost，均可用）

“编辑订阅”弹窗只有三个操作：改名、设置或随机重置 token、删除订阅。

目标编辑弹窗：

- 新增时选择类型，编辑时类型不可改
- 表单按目标 `type` 切换字段
- 敏感字段（`secretFields`）显示为掩码；提交时留空表示不修改，明确清空需要单独操作，避免掩码值被写回

### 9.2 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/admin/api/login` | 校验密码，下发 cookie（限流） |
| POST | `/admin/api/logout` | 清除 cookie |
| GET | `/admin/api/subscriptions` | 订阅列表（敏感字段打掩码，token 返回明文用于拼 URL） |
| POST | `/admin/api/subscriptions` | 新建订阅，自动生成 token |
| PUT | `/admin/api/subscriptions/:name` | 改名：body `{ name }` |
| DELETE | `/admin/api/subscriptions/:name` | 删除订阅 |
| POST | `/admin/api/subscriptions/:name/token` | 重置或手动设置 token |
| POST | `/admin/api/subscriptions/:name/targets` | 新增目标 |
| PUT | `/admin/api/subscriptions/:name/targets/:id` | 编辑单个目标 |
| DELETE | `/admin/api/subscriptions/:name/targets/:id` | 删除单个目标 |
| GET | `/admin/api/meta` | 入站类型和出站表单定义 |

写操作检查 `Origin` 头，配合 `SameSite=Strict` cookie 防 CSRF。

## 10. 技术栈与目录

| 部分 | 选择 |
|---|---|
| 语言 | TypeScript |
| 路由 | Hono |
| 校验 | zod |
| 存储 | Workers KV |
| 后台页面 | Workers Static Assets，单个 HTML + 原生 JS |
| 限流 | Workers Rate Limiting binding |
| 测试 | vitest + `@cloudflare/vitest-plugin`（原 `@cloudflare/vitest-pool-workers`，已改名） |

```
src/
  index.ts              Hono 入口，路由分发
  types.ts              Message、Subscription、Target 类型
  request-view.ts       请求预解析
  store.ts              KV 读写
  auth.ts               token 比较、后台 cookie
  forward.ts            扇出与结果汇总
  inbound/
    index.ts            注册表 + all 自动识别
    default.ts  bark.ts  ntfy.ts  gotify.ts  wecom.ts
    dingtalk.ts feishu.ts discord.ts slack.ts telegram.ts
  outbound/
    index.ts            注册表 + 判别联合 schema
    ntfy.ts  gotify.ts  webhook.ts  feishu.ts  wecom.ts
  admin/
    api.ts              /admin/api/*
public/
  admin/index.html      后台页面
test/
  fixtures/             各格式的真实请求样例
wrangler.jsonc
```

Secret：`ADMIN_PASSWORD`、`SESSION_SECRET`。绑定：KV `SUBS`、Rate Limiting `LOGIN_LIMITER`。

## 11. 待验证事项

- 各入站格式的请求字段和成功响应以官方文档为准，逐个核对第 6.1 节的表格
- 哪些发送方会检查响应体：识别错误的主要代价是回错响应格式
- Bark、ntfy App 是否允许服务器地址带路径（`https://w.dev/bark/nas`）
- telegram 入站：发送方需允许自定义 API 地址；部分客户端会校验 bot token 形状（`数字:字符串`），遇到时考虑生成这种形状的 token
- discord / slack 入站：部分工具会校验 webhook URL 的域名或形状，自定义域名可能被拒绝
- 企业微信机器人的正文长度上限、飞书签名算法细节
- Workers 单请求子请求数量上限（以当前文档为准），后台限制每个订阅的目标数（例如 10）
