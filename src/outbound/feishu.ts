import { z } from "zod";
import { base64, hmacSha256 } from "../crypto";
import type { Level } from "../message";
import { jsonRequest, parseJsonSafe, type OutboundAdapter } from "./types";

const schema = z.object({
  webhook_url: z.url(),
  sign_secret: z.string().default(""),
});

export type FeishuConfig = z.infer<typeof schema>;

const COLOR: Record<Level, string> = { info: "blue", warn: "orange", critical: "red" };

export const feishuOut: OutboundAdapter<FeishuConfig> = {
  type: "feishu",
  label: "飞书机器人",
  schema,
  secretFields: ["webhook_url", "sign_secret"],
  async build(msg, c) {
    let payload: Record<string, unknown>;
    if (msg.markdown) {
      const md = msg.url ? `${msg.body}\n\n[打开链接](${msg.url})` : msg.body;
      payload = {
        msg_type: "interactive",
        card: {
          header: msg.title
            ? { title: { tag: "plain_text", content: msg.title }, template: COLOR[msg.level ?? "info"] }
            : undefined,
          elements: [{ tag: "markdown", content: md }],
        },
      };
    } else if (msg.title || msg.url) {
      const lines: unknown[][] = msg.body.split("\n").map((line) => [{ tag: "text", text: line }]);
      if (msg.url) lines.push([{ tag: "a", text: msg.url, href: msg.url }]);
      payload = { msg_type: "post", content: { post: { zh_cn: { title: msg.title ?? "", content: lines } } } };
    } else {
      payload = { msg_type: "text", content: { text: msg.body } };
    }
    if (c.sign_secret) {
      // Feishu signs with key = "timestamp\nsecret" over an empty message.
      const timestamp = Math.floor(Date.now() / 1000).toString();
      payload.timestamp = timestamp;
      payload.sign = base64(await hmacSha256(`${timestamp}\n${c.sign_secret}`, ""));
    }
    return jsonRequest(c.webhook_url, payload);
  },
  check(_res, text) {
    const j = parseJsonSafe(text);
    const code = j?.code ?? j?.StatusCode;
    if (code !== undefined && code !== 0) throw new Error(`feishu code ${String(code)}: ${String(j?.msg ?? "")}`);
  },
};
