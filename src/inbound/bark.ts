import { jsonResponse, str } from "../http";
import { normalizeLevel, truthy, type Message } from "../message";
import { pick, pickRaw, type RequestView } from "../request-view";
import { Tier, type InboundAdapter } from "./types";

const NTFY_VERBS = ["publish", "send", "trigger"];

/** Segments after the key: /:key[/:body] | /:key/:title/:body | /:key/:title/:subtitle/:body */
function pathParts(v: RequestView): { title?: string; subtitle?: string; body?: string } {
  const p = v.rest[0] === "push" ? [] : v.rest.slice(1);
  if (p.length === 1) return { body: p[0] };
  if (p.length === 2) return { title: p[0], body: p[1] };
  if (p.length >= 3) return { title: p[0], subtitle: p[1], body: p.slice(2).join("/") };
  return {};
}

export const barkIn: InboundAdapter = {
  type: "bark",
  label: "Bark",
  tokens: (v) => [v.rest[0] !== "push" ? v.rest[0] : undefined, str(v.body?.device_key), v.query.get("device_key") ?? undefined],
  parse(v) {
    const p = pathParts(v);
    const subtitle = pick(v, "subtitle") ?? p.subtitle;
    const markdownBody = pick(v, "markdown");
    let body = markdownBody ?? pick(v, "body") ?? p.body;
    if (subtitle) body = body ? `${subtitle}\n${body}` : subtitle;
    const m: Partial<Message> = {
      title: pick(v, "title") ?? p.title,
      body,
      url: pick(v, "url"),
      group: pick(v, "group"),
      level: normalizeLevel(pick(v, "level")),
      markdown: markdownBody !== undefined || truthy(pickRaw(v, "isMarkdown")),
    };
    if (pick(v, "call") === "1") m.level = "critical";
    return m;
  },
  respond: () => jsonResponse({ code: 200, message: "success", timestamp: Math.floor(Date.now() / 1000) }),
  detect(v) {
    if (v.body?.device_key !== undefined || v.query.has("device_key")) return Tier.Definitive;
    if (v.rest[0] === "push") return Tier.Strong;
    if (v.rest.length >= 2 && !NTFY_VERBS.includes(v.rest[1])) return Tier.Strong;
    if (v.method === "GET" && (v.query.has("body") || v.query.has("title"))) return Tier.Strong;
    return Tier.Weak;
  },
  urlTemplate: "{base}/{token}/",
};
