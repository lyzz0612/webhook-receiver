import { jsonResponse, str } from "../http";
import { randomToken } from "../crypto";
import { splitTags, truthy, type Level, type Message } from "../message";
import { bearer, pick, pickRaw, type RequestView } from "../request-view";
import { Tier, type InboundAdapter } from "./types";

const VERBS = ["publish", "send", "trigger"];

/** Decodes RFC 2047 encoded-words ("=?UTF-8?B?...?="), which ntfy accepts in headers. */
export function decodeEncodedWords(s: string): string {
  return s.replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_all, enc: string, data: string) => {
    try {
      const bytes =
        enc.toLowerCase() === "b"
          ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
          : Uint8Array.from(
              data.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))),
              (c) => c.charCodeAt(0),
            );
      return new TextDecoder().decode(bytes);
    } catch {
      return data;
    }
  });
}

function hdr(v: RequestView, ...names: string[]): string | undefined {
  for (const n of names) {
    const h = v.headers.get(n);
    if (h) return decodeEncodedWords(h);
  }
  return undefined;
}

function param(v: RequestView, headerNames: string[], fieldNames: string[]): string | undefined {
  return hdr(v, ...headerNames) ?? pick(v, ...fieldNames);
}

export function ntfyLevel(p: unknown): Level | undefined {
  const s = str(p)?.trim().toLowerCase();
  if (!s) return undefined;
  if (s === "5" || s === "max" || s === "urgent") return "critical";
  if (s === "4" || s === "high") return "warn";
  return "info";
}

function basicPassword(v: RequestView): string | undefined {
  const m = v.headers.get("authorization")?.match(/^Basic\s+(.+)$/i);
  if (!m) return undefined;
  try {
    const decoded = atob(m[1].trim());
    return decoded.slice(decoded.indexOf(":") + 1);
  } catch {
    return undefined;
  }
}

/** Whether the request has an explicit publish verb or a JSON publish body (topic in the body). */
const isJsonPublish = (v: RequestView) => v.bodyKind === "json" && typeof v.body?.topic === "string";

export const ntfyIn: InboundAdapter = {
  type: "ntfy",
  label: "ntfy",
  tokens: (v) => [v.rest[0], str(v.body?.topic), bearer(v), basicPassword(v)],
  parse(v) {
    const json = isJsonPublish(v);
    const body = json
      ? str(v.body?.message)
      : (pick(v, "message", "m") ?? (v.bodyKind === "none" ? undefined : v.text) ?? "triggered");
    const m: Partial<Message> = {
      title: param(v, ["x-title", "title", "t"], ["title", "t"]),
      body,
      url: param(v, ["x-click", "click"], ["click"]),
      level: ntfyLevel(param(v, ["x-priority", "priority", "prio", "p"], ["priority", "prio", "p"])),
      tags: splitTags(hdr(v, "x-tags", "tags", "tag", "ta") ?? pickRaw(v, "tags") ?? v.query.get("tag")),
      markdown: truthy(param(v, ["x-markdown", "markdown", "md"], ["markdown", "md"])),
    };
    return m;
  },
  respond: ({ message, view }) =>
    jsonResponse({
      id: randomToken(9),
      time: Math.floor(Date.now() / 1000),
      event: "message",
      topic: view.rest[0] ?? str(view.body?.topic) ?? "",
      title: message.title,
      message: message.body,
    }),
  detect(v) {
    if (isJsonPublish(v) || VERBS.includes(v.rest[1] ?? "")) return Tier.Definitive;
    if (hdr(v, "x-title", "x-priority", "x-tags", "x-click", "x-markdown", "title", "priority", "tags")) return Tier.Strong;
    if (v.method !== "GET" && v.rest.length === 1 && v.bodyKind === "text") return Tier.Strong;
    return Tier.Weak;
  },
  urlTemplate: "{base}/{token}",
};
