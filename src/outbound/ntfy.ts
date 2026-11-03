import { z } from "zod";
import { base64Utf8 } from "../crypto";
import type { Level } from "../message";
import { hostOf, jsonRequest, type OutboundAdapter } from "./types";

const schema = z.object({
  server: z.url().default("https://ntfy.sh"),
  topic: z.string().min(1, "topic 不能为空"),
  auth_kind: z.enum(["none", "bearer", "basic"]).default("none"),
  auth_token: z.string().default(""),
  auth_username: z.string().default(""),
  auth_password: z.string().default(""),
});

export type NtfyConfig = z.infer<typeof schema>;

const PRIORITY: Record<Level, number> = { info: 3, warn: 4, critical: 5 };

export const ntfyOut: OutboundAdapter<NtfyConfig> = {
  type: "ntfy",
  label: "ntfy",
  schema,
  secretFields: ["auth_token", "auth_password"],
  named: false,
  summary(c) {
    const host = hostOf(c.server);
    return host && host !== "ntfy.sh" ? `${c.topic} @ ${host}` : c.topic;
  },
  build(msg, c) {
    const headers: Record<string, string> = {};
    if (c.auth_kind === "bearer" && c.auth_token) headers.authorization = `Bearer ${c.auth_token}`;
    if (c.auth_kind === "basic") headers.authorization = `Basic ${base64Utf8(`${c.auth_username}:${c.auth_password}`)}`;
    // JSON publishing to the server root avoids header encoding issues with non-ASCII titles.
    return jsonRequest(
      c.server.replace(/\/+$/, "") + "/",
      {
        topic: c.topic,
        message: msg.body,
        title: msg.title,
        priority: msg.level ? PRIORITY[msg.level] : undefined,
        tags: msg.tags,
        click: msg.url,
        markdown: msg.markdown || undefined,
      },
      headers,
    );
  },
};
