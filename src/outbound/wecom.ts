import { z } from "zod";
import { composeText, truncateBytes } from "../message";
import { jsonRequest, parseJsonSafe, tail, type OutboundAdapter } from "./types";

const schema = z.object({
  /** Robot key, or the full webhook URL. */
  key: z.string().min(1, "key 不能为空"),
});

export type WecomConfig = z.infer<typeof schema>;

const TEXT_MAX_BYTES = 2048;
const MARKDOWN_MAX_BYTES = 4096;

export const wecomOut: OutboundAdapter<WecomConfig> = {
  type: "wecom",
  label: "企业微信机器人",
  schema,
  secretFields: ["key"],
  named: true,
  summary: (c) => tail(c.key.replace(/^.*[?&]key=/, "")),
  build(msg, c) {
    const url = /^https?:\/\//.test(c.key)
      ? c.key
      : `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(c.key)}`;
    if (msg.markdown) {
      const parts = [msg.title ? `**${msg.title}**` : "", msg.body, msg.url ? `[打开链接](${msg.url})` : ""];
      const content = truncateBytes(parts.filter(Boolean).join("\n\n"), MARKDOWN_MAX_BYTES);
      return jsonRequest(url, { msgtype: "markdown", markdown: { content } });
    }
    const content = truncateBytes(composeText(msg, { url: true }), TEXT_MAX_BYTES);
    return jsonRequest(url, { msgtype: "text", text: { content } });
  },
  check(_res, text) {
    const j = parseJsonSafe(text);
    if (j && j.errcode !== undefined && j.errcode !== 0) {
      throw new Error(`wecom errcode ${String(j.errcode)}: ${String(j.errmsg ?? "")}`);
    }
  },
};
