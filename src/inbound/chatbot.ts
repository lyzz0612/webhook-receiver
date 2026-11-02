import { arr, isObj, jsonResponse, obj, str } from "../http";
import type { Message } from "../message";
import type { RequestView } from "../request-view";
import { Tier, type InboundAdapter } from "./types";

/** Collects human-readable strings from an unknown payload (fallback for message types we don't model). */
export function collectText(v: unknown, keys = ["title", "text", "content", "description", "desc"], depth = 0): string[] {
  if (depth > 6) return [];
  if (Array.isArray(v)) return v.flatMap((x) => collectText(x, keys, depth + 1));
  if (!isObj(v)) return [];
  const out: string[] = [];
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string" && keys.includes(k) && val.trim()) out.push(val);
    else if (typeof val === "object") out.push(...collectText(val, keys, depth + 1));
  }
  return out;
}

/** WeCom / DingTalk robot payloads ({ msgtype, text|markdown|news|... }). */
function parseMsgtype(v: RequestView): Partial<Message> {
  const b = obj(v.body);
  const type = str(b.msgtype) ?? "text";
  const part = obj(b[type]);
  switch (type) {
    case "text":
      return { body: str(part.content) };
    case "markdown":
    case "markdown_v2":
      return { title: str(part.title), body: str(part.content) ?? str(part.text), markdown: true };
    case "link":
      return { title: str(part.title), body: str(part.text), url: str(part.messageUrl) };
    case "actionCard":
      return { title: str(part.title), body: str(part.text), url: str(part.singleURL), markdown: true };
    case "news":
    case "feedCard": {
      const first = obj(arr(part.articles ?? part.links)[0]);
      return {
        title: str(first.title),
        body: str(first.description) ?? str(first.title),
        url: str(first.url) ?? str(first.messageURL),
      };
    }
    default:
      return { body: collectText(part).join("\n") || JSON.stringify(b) };
  }
}

const errOk = () => jsonResponse({ errcode: 0, errmsg: "ok" });

export const wecomIn: InboundAdapter = {
  type: "wecom",
  label: "企业微信机器人",
  tokens: (v) => [v.query.get("key") ?? undefined],
  parse: parseMsgtype,
  respond: errOk,
  detect: (v) => (v.body?.msgtype !== undefined ? Tier.Strong : Tier.Weak),
  urlTemplate: "{base}/cgi-bin/webhook/send?key={token}",
};

export const dingtalkIn: InboundAdapter = {
  type: "dingtalk",
  label: "钉钉机器人",
  tokens: (v) => [v.query.get("access_token") ?? undefined],
  parse: parseMsgtype,
  respond: errOk,
  detect: (v) => (v.body?.msgtype !== undefined ? Tier.Strong : Tier.Weak),
  urlTemplate: "{base}/robot/send?access_token={token}",
};

/** Flattens a Feishu "post" rich-text body (one locale) into lines. */
function feishuPost(post: Record<string, unknown>): { title?: string; body: string } {
  const locale = obj(post.zh_cn ?? post.en_us ?? post.ja_jp ?? Object.values(post)[0]);
  const lines = arr(locale.content).map((line) =>
    arr(line)
      .map((el) => {
        const e = obj(el);
        if (e.tag === "a") return str(e.text) ?? str(e.href) ?? "";
        if (e.tag === "at") return `@${str(e.user_name) ?? str(e.user_id) ?? ""}`;
        return str(e.text) ?? "";
      })
      .join(""),
  );
  return { title: str(locale.title), body: lines.join("\n") };
}

export const feishuIn: InboundAdapter = {
  type: "feishu",
  label: "飞书机器人",
  tokens: (v) => [v.rest.at(-1)],
  parse(v) {
    const b = obj(v.body);
    const content = obj(b.content);
    switch (str(b.msg_type)) {
      case "text":
        return { body: str(content.text) };
      case "post":
        return feishuPost(obj(content.post));
      case "interactive": {
        const card = obj(b.card ?? content.card);
        const title = str(obj(obj(card.header).title).content);
        const texts = collectText(card.elements ?? obj(card.body).elements ?? card, ["content", "text"]);
        return { title, body: texts.join("\n"), markdown: true };
      }
      default:
        return { body: collectText(b).join("\n") || v.text };
    }
  },
  respond: () => jsonResponse({ code: 0, msg: "success", data: {}, StatusCode: 0, StatusMessage: "success" }),
  detect(v) {
    if (v.body?.msg_type !== undefined) return Tier.Definitive;
    if (v.rest.join("/").startsWith("open-apis/bot/v2/hook")) return Tier.Definitive;
    return null;
  },
  urlTemplate: "{base}/open-apis/bot/v2/hook/{token}",
};

export const discordIn: InboundAdapter = {
  type: "discord",
  label: "Discord Webhook",
  tokens: (v) => [v.rest.at(-1)],
  parse(v) {
    const b = obj(v.body);
    const embed = obj(arr(b.embeds)[0]);
    const content = str(b.content);
    const embedText = [str(embed.description), ...arr(embed.fields).map((f) => `${str(obj(f).name) ?? ""}: ${str(obj(f).value) ?? ""}`)]
      .filter(Boolean)
      .join("\n");
    return {
      title: str(embed.title),
      // finalize() promotes the title to body when there is no other text.
      body: [content, embedText].filter(Boolean).join("\n\n"),
      url: str(embed.url),
      markdown: true,
    };
  },
  respond: ({ view, message }) =>
    view.query.get("wait") === "true"
      ? jsonResponse({ id: String(Date.now()), content: message.body, embeds: [] })
      : new Response(null, { status: 204 }),
  detect(v) {
    if (v.rest[0] === "api" && v.rest[1] === "webhooks") return Tier.Definitive;
    if (Array.isArray(v.body?.embeds)) return Tier.Strong;
    return null;
  },
  urlTemplate: "{base}/api/webhooks/0/{token}",
};

export const slackIn: InboundAdapter = {
  type: "slack",
  label: "Slack Webhook",
  tokens: (v) => [v.rest.at(-1)],
  parse(v) {
    // Slack also accepts form posts with a JSON "payload" field.
    let b = obj(v.body);
    if (typeof b.payload === "string") {
      try {
        b = obj(JSON.parse(b.payload));
      } catch {
        /* keep form body */
      }
    }
    const blocks = arr(b.blocks);
    const header = blocks.map(obj).find((x) => x.type === "header");
    const blockText = blocks
      .map(obj)
      .filter((x) => x !== header)
      .flatMap((x) => [str(obj(x.text).text), ...arr(x.fields).map((f) => str(obj(f).text))])
      .filter(Boolean)
      .join("\n");
    const attachment = obj(arr(b.attachments)[0]);
    return {
      title: str(obj(header?.text).text) ?? str(attachment.title),
      body: str(b.text) ?? (blockText || str(attachment.text) || str(attachment.fallback)),
      url: str(attachment.title_link),
      markdown: true,
    };
  },
  respond: () => new Response("ok", { headers: { "content-type": "text/plain" } }),
  detect(v) {
    if (v.rest[0] === "services") return Tier.Definitive;
    if (Array.isArray(v.body?.blocks) || Array.isArray(v.body?.attachments)) return Tier.Strong;
    return null;
  },
  urlTemplate: "{base}/services/x/x/{token}",
};
