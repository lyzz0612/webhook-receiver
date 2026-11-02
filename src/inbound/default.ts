import { jsonResponse } from "../http";
import { normalizeLevel, splitTags, truthy, type Message } from "../message";
import { bearer, pick, pickRaw, type RequestView } from "../request-view";
import { collectText } from "./chatbot";
import { Tier, type InboundAdapter } from "./types";

export const BODY_ALIASES = ["body", "message", "content", "text", "desp", "msg", "description"];

/** Lenient parse shared by `default` and the `all` fallback. */
export function parseLenient(v: RequestView): Partial<Message> {
  const markdownRaw = pickRaw(v, "markdown");
  return {
    title: pick(v, "title", "subject"),
    body:
      pick(v, ...BODY_ALIASES) ??
      (v.bodyKind === "text" ? v.text : undefined) ??
      // Unknown JSON shape: keep whatever readable text it has.
      (collectText(v.body).join("\n") || undefined),
    url: pick(v, "url", "click", "link"),
    level: normalizeLevel(pick(v, "level", "priority")),
    tags: splitTags(pickRaw(v, "tags")),
    group: pick(v, "group"),
    markdown: markdownRaw !== undefined ? truthy(markdownRaw) : undefined,
  };
}

export const defaultIn: InboundAdapter = {
  type: "default",
  label: "自有格式",
  tokens: (v) => [v.query.get("token") ?? undefined, bearer(v)],
  parse: parseLenient,
  respond: ({ result }) => jsonResponse({ ok: result.ok, results: result.results.map(({ response: _r, ...t }) => t) }),
  detect: () => Tier.Weak,
  urlTemplate: "{base}?token={token}",
};
