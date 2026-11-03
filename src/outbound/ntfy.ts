import { z } from "zod";
import { base64Utf8 } from "../crypto";
import type { Level } from "../message";
import { hostOf, jsonRequest, type OutboundAdapter } from "./types";

const withScheme = (s: string) => (/^https?:\/\//i.test(s) ? s : `https://${s}`);

/**
 * Accepts the ways people paste ntfy settings: "ntfy.sh" without a scheme, the topic as a full
 * URL ("https://ntfy.sh/skyup" or "ntfy.sh/skyup"), or the topic URL in the server field.
 * Result: server is an origin (plus base path, for self-hosted ntfy under a path), topic is a bare name.
 */
export function normalizeNtfy(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const c = { ...(input as Record<string, unknown>) };
  let server = typeof c.server === "string" ? c.server.trim() : "";
  let topic = typeof c.topic === "string" ? c.topic.trim() : "";

  if (/[/.]/.test(topic)) {
    // Topic contains a host or path: split it into server + last path segment.
    try {
      const u = new URL(withScheme(topic));
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length) {
        topic = parts.pop()!;
        if (!server) server = u.origin + (parts.length ? "/" + parts.join("/") : "");
      }
    } catch {
      /* leave as is; schema reports it */
    }
  }
  if (server) {
    try {
      const u = new URL(withScheme(server));
      const parts = u.pathname.split("/").filter(Boolean);
      // "https://ntfy.sh/skyup" in the server field: the last segment is the topic.
      if (parts.length && (!topic || parts.at(-1) === topic)) topic = topic || parts.at(-1)!;
      if (parts.length && parts.at(-1) === topic) parts.pop();
      server = u.origin + (parts.length ? "/" + parts.join("/") : "");
    } catch {
      /* leave as is; schema reports it */
    }
  }
  if (server) c.server = server;
  else delete c.server;
  c.topic = topic;
  return c;
}

const schema = z.preprocess(
  normalizeNtfy,
  z.object({
    server: z.url("服务器地址无效，例如 https://ntfy.sh").default("https://ntfy.sh"),
    topic: z
      .string()
      .min(1, "topic 不能为空")
      .regex(/^[\w-]{1,64}$/, "topic 只能包含字母、数字、_ 和 -，例如 skyup"),
    auth_kind: z.enum(["none", "bearer", "basic"]).default("none"),
    auth_token: z.string().default(""),
    auth_username: z.string().default(""),
    auth_password: z.string().default(""),
  }),
);

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
