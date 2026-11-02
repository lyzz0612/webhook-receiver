import { jsonResponse, str } from "../http";
import { stripHtml, type Message } from "../message";
import { pick, type RequestView } from "../request-view";
import { Tier, type InboundAdapter } from "./types";

const botToken = (v: RequestView) => (v.rest[0]?.startsWith("bot") ? v.rest[0].slice(3) : undefined);

export const telegramIn: InboundAdapter = {
  type: "telegram",
  label: "Telegram Bot API",
  tokens: (v) => [botToken(v)],
  parse(v): Partial<Message> {
    const text = pick(v, "text", "caption");
    const mode = pick(v, "parse_mode")?.toLowerCase();
    if (mode === "html") return { body: text && stripHtml(text) };
    return { body: text, markdown: mode === "markdown" || mode === "markdownv2" };
  },
  respond: ({ view, message }) =>
    jsonResponse({
      ok: true,
      result: {
        message_id: Math.floor(Date.now() / 1000),
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(str(view.body?.chat_id) ?? view.query.get("chat_id")) || 0, type: "private" },
        text: message.body,
      },
    }),
  detect(v) {
    if (botToken(v) !== undefined && v.rest.length >= 2) return Tier.Definitive;
    if (pick(v, "chat_id") && pick(v, "text")) return Tier.Strong;
    return null;
  },
  urlTemplate: "{base}/bot{token}/sendMessage",
};
