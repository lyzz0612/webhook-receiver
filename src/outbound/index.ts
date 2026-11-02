import { feishuOut } from "./feishu";
import { gotifyOut } from "./gotify";
import { ntfyOut } from "./ntfy";
import type { OutboundAdapter } from "./types";
import { webhookOut } from "./webhook";
import { wecomOut } from "./wecom";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const OUTBOUND: Record<string, OutboundAdapter<any>> = Object.fromEntries(
  [ntfyOut, gotifyOut, webhookOut, feishuOut, wecomOut].map((a) => [a.type, a]),
);

export interface FieldDef {
  key: string;
  label: string;
  kind: "text" | "password" | "select" | "textarea";
  options?: string[];
  placeholder?: string;
  help?: string;
  /** Only shown when another field has one of these values. */
  showIf?: { key: string; values: string[] };
}

/** Form definitions for the admin UI, per target type. */
export const OUTBOUND_FIELDS: Record<string, FieldDef[]> = {
  ntfy: [
    { key: "server", label: "服务器", kind: "text", placeholder: "https://ntfy.sh" },
    { key: "topic", label: "Topic", kind: "text" },
    { key: "auth_kind", label: "鉴权", kind: "select", options: ["none", "bearer", "basic"] },
    { key: "auth_token", label: "Access Token", kind: "password", showIf: { key: "auth_kind", values: ["bearer"] } },
    { key: "auth_username", label: "用户名", kind: "text", showIf: { key: "auth_kind", values: ["basic"] } },
    { key: "auth_password", label: "密码", kind: "password", showIf: { key: "auth_kind", values: ["basic"] } },
  ],
  gotify: [
    { key: "server", label: "服务器", kind: "text", placeholder: "https://gotify.example.com" },
    { key: "app_token", label: "App Token", kind: "password" },
  ],
  webhook: [
    { key: "url", label: "URL", kind: "password", help: "可使用 {{title}} 等占位符（会做 URL 编码）" },
    { key: "method", label: "方法", kind: "select", options: ["POST", "PUT", "GET"] },
    { key: "content_type", label: "Content-Type", kind: "text", placeholder: "application/json" },
    { key: "headers", label: "请求头", kind: "textarea", placeholder: "Authorization: Bearer xxx", help: "每行一个 Name: value" },
    {
      key: "body_template",
      label: "Body 模板",
      kind: "textarea",
      placeholder: '{"text": "{{title}}\\n{{body}}"}',
      help: "占位符：{{title}} {{body}} {{text}} {{url}} {{level}} {{tags}} {{group}} {{json}}；留空则发送消息 JSON",
    },
  ],
  feishu: [
    { key: "webhook_url", label: "Webhook URL", kind: "password", placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/..." },
    { key: "sign_secret", label: "签名密钥", kind: "password", help: "机器人开启“签名校验”时填写" },
  ],
  wecom: [{ key: "key", label: "Key 或完整 Webhook URL", kind: "password" }],
};
