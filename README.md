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

## 部署

```bash
npm install
npx wrangler deploy
npx wrangler secret put ADMIN_PASSWORD
```

- KV 命名空间在首次部署时由 Wrangler 自动创建
- `SESSION_SECRET` 可选；不设置时会话签名密钥由 `ADMIN_PASSWORD` 派生，修改密码会让所有已登录会话失效

### 推送到 GitHub 后自动部署

`.github/workflows/deploy.yml` 会在推送到 `main` 时运行测试并部署。需要在仓库的 Settings → Secrets and variables → Actions 中添加：

- `CLOUDFLARE_API_TOKEN`：需要 Workers Scripts 编辑、Workers KV Storage 编辑权限
- `CLOUDFLARE_ACCOUNT_ID`

## 开发

```bash
cp .dev.vars.example .dev.vars
npm run dev
npm test
npm run typecheck
```
