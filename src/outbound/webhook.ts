import { z } from "zod";
import { composeText, type Message } from "../message";
import { hostOf, type OutboundAdapter } from "./types";

const schema = z.object({
  url: z.string().min(1, "url 不能为空"),
  method: z.enum(["GET", "POST", "PUT"]).default("POST"),
  content_type: z.string().default("application/json"),
  /** One "Name: value" per line. */
  headers: z.string().default(""),
  body_template: z.string().default(""),
});

export type WebhookConfig = z.infer<typeof schema>;

function fields(msg: Message): Record<string, string> {
  return {
    title: msg.title ?? "",
    body: msg.body,
    text: composeText(msg),
    url: msg.url ?? "",
    level: msg.level ?? "info",
    tags: (msg.tags ?? []).join(","),
    group: msg.group ?? "",
  };
}

/** Replaces {{name}} placeholders. {{json}} is the whole message as JSON. */
export function render(template: string, msg: Message, escape: (s: string) => string): string {
  const values = fields(msg);
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (all, name: string) => {
    if (name === "json") return JSON.stringify(msg);
    return name in values ? escape(values[name]) : all;
  });
}

export function parseHeaderLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim();
    if (name) out[name] = line.slice(i + 1).trim();
  }
  return out;
}

const jsonEscape = (s: string) => JSON.stringify(s).slice(1, -1);

export const webhookOut: OutboundAdapter<WebhookConfig> = {
  type: "webhook",
  label: "通用 Webhook",
  schema,
  secretFields: ["url", "headers"],
  named: true,
  // Only the host: the path or query may carry a key.
  summary: (c) => [c.method, hostOf(c.url)].filter(Boolean).join(" "),
  build(msg, c) {
    const url = render(c.url, msg, encodeURIComponent);
    const headers = parseHeaderLines(c.headers);
    if (c.method === "GET") return { url, init: { method: "GET", headers } };
    const isJson = c.content_type.includes("json");
    const body = c.body_template ? render(c.body_template, msg, isJson ? jsonEscape : (s) => s) : JSON.stringify(msg);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = c.content_type;
    return { url, init: { method: c.method, headers, body } };
  },
};
