# webhook-receiver

运行在 Cloudflare Workers 上的推送通知中转服务。它冒充 Bark、ntfy、Gotify、企业微信机器人等常见推送服务的接收接口，按订阅把消息转发到一个或多个目标。设计细节见 [docs/design.md](docs/design.md)。

## URL

```
https://<域名>/{类型}/{订阅名}/...
```

| 类型 | 示例（订阅 `nas`，token `T0k3n`） |
|---|---|
| default（自有格式） | `/default/nas?token=T0k3n`，或 `Authorization: Bearer T0k3n` |
| all（自动识别） | `/all/nas?token=T0k3n`，其余格式的路径写法同样适用 |
| bark | `/bark/nas/T0k3n/标题/内容` |
| ntfy | `/ntfy/nas/T0k3n` |
| gotify | `/gotify/nas/message?token=T0k3n` |
| wecom | `/wecom/nas/cgi-bin/webhook/send?key=T0k3n` |
| dingtalk | `/dingtalk/nas/robot/send?access_token=T0k3n` |
| feishu | `/feishu/nas/open-apis/bot/v2/hook/T0k3n` |
| discord | `/discord/nas/api/webhooks/0/T0k3n` |
| slack | `/slack/nas/services/x/x/T0k3n` |
| telegram | `/telegram/nas/botT0k3n/sendMessage` |

后台 `/admin/` 的订阅列表里可以直接复制每种格式的完整 URL。

自有格式：

```bash
curl -H 'Authorization: Bearer T0k3n' -H 'Content-Type: application/json' \
  -d '{"title":"部署完成","body":"v1.2.3 已上线","level":"info","url":"https://example.com"}' \
  https://<域名>/default/nas
```

字段：`title`、`body`（必填，别名 `message`/`content`/`text`/`desp`/`msg`）、`url`、`level`（`info`/`warn`/`critical`）、`tags`、`group`、`markdown`。也支持 GET query、表单和纯文本 body。

转发目标：ntfy、Gotify、通用 Webhook（支持 body 模板）、飞书机器人、企业微信机器人。至少一个目标成功就返回成功，各目标结果在响应头 `X-Forward-Result` 里；全部失败返回 502。

## 一键部署

点击下方按钮，即可将本项目部署到你的 Cloudflare 账号，**KV 命名空间会自动创建**，无需手动配置：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lyzz0612/webhook-receiver)

> Fork 用户：将上面链接中的 `lyzz0612` 替换为你自己的 GitHub 用户名即可部署你 fork 的仓库。

部署过程中会要求你设置以下内容：

| 配置项 | 说明 |
|--------|------|
| **ADMIN_PASSWORD** | 管理后台登录密码。建议使用 `openssl rand -hex 16` 生成随机字符串 |
| **SUBS** | KV 命名空间，自动创建，无需手动配置 |

部署完成后访问 `https://<你的 Worker 域名>/admin/`，用 `ADMIN_PASSWORD` 登录，新建订阅即可。

部署按钮会在你的 GitHub 账号下创建一个新仓库，并连接 Cloudflare Workers Builds，之后推送到该仓库会自动重新部署。

## 其他部署方式

### 连接已有的 GitHub 仓库（Workers Builds）

在 Cloudflare Dashboard 中通过 **Workers & Pages → Create → Import a repository** 选择本仓库（或你的 fork）。构建命令留空，部署命令使用默认的 `npx wrangler deploy`。KV 同样会在首次部署时自动创建。

部署后在 Worker 的 **Settings → Variables and Secrets** 中添加 secret `ADMIN_PASSWORD`。之后每次推送都会自动部署。

### 命令行

```bash
npm install
npx wrangler deploy
npx wrangler secret put ADMIN_PASSWORD
```

- KV 命名空间在首次部署时由 Wrangler 自动创建
- `SESSION_SECRET` 可选；不设置时会话签名密钥由 `ADMIN_PASSWORD` 派生，修改密码会让所有已登录会话失效

### GitHub Actions

`.github/workflows/deploy.yml` 会在推送到 `main` 时运行测试并部署。如果已经用 Workers Builds 连接了仓库，就不要再配置下面的 secrets，否则每次推送会部署两次。需要在仓库的 Settings → Secrets and variables → Actions 中添加：

- `CLOUDFLARE_API_TOKEN`：需要 Workers Scripts 编辑、Workers KV Storage 编辑权限
- `CLOUDFLARE_ACCOUNT_ID`
- `ADMIN_PASSWORD`：后台密码，部署时作为 Worker secret 上传
- `SESSION_SECRET`（可选）

GitHub 里没有设置的 Worker secret 会保留 Cloudflare 上已有的值。没有设置 `CLOUDFLARE_API_TOKEN` 时，工作流只跑测试、跳过部署。

## 开发

```bash
cp .dev.vars.example .dev.vars
npm run dev
npm test
npm run typecheck
```
