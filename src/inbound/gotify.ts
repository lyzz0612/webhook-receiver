import { jsonResponse, obj, str } from "../http";
import type { Level, Message } from "../message";
import { bearer, pick, pickRaw, type RequestView } from "../request-view";
import { Tier, type InboundAdapter } from "./types";

export function gotifyLevel(p: unknown): Level | undefined {
  const n = Number(str(p));
  if (str(p) === undefined || Number.isNaN(n)) return undefined;
  if (n >= 8) return "critical";
  if (n >= 4) return "warn";
  return "info";
}

let nextId = 1;

export const gotifyIn: InboundAdapter = {
  type: "gotify",
  label: "Gotify",
  tokens: (v) => [v.query.get("token") ?? undefined, v.headers.get("x-gotify-key") ?? undefined, bearer(v)],
  parse(v: RequestView): Partial<Message> {
    const extras = obj(pickRaw(v, "extras"));
    const display = obj(extras["client::display"]);
    const click = obj(obj(extras["client::notification"]).click);
    return {
      title: pick(v, "title"),
      body: pick(v, "message"),
      level: gotifyLevel(pickRaw(v, "priority")),
      url: str(click.url),
      markdown: display.contentType === "text/markdown",
    };
  },
  respond: ({ message }) =>
    jsonResponse({
      id: nextId++,
      appid: 1,
      title: message.title ?? "",
      message: message.body,
      priority: 0,
      date: new Date().toISOString(),
    }),
  detect(v) {
    if (v.headers.has("x-gotify-key")) return Tier.Definitive;
    if (v.rest[0] === "message") return Tier.Definitive;
    return null;
  },
  urlTemplate: "{base}/message?token={token}",
};
