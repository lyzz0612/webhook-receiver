import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, forwarded, json, mockFetch, seed, TOKEN, type Sent } from "./helpers";

let sent: Sent[];

beforeEach(async () => {
  sent = mockFetch();
  await seed();
});
afterEach(() => vi.unstubAllGlobals());

describe("routing and auth", () => {
  it("rejects unknown types", async () => {
    expect((await call(`/nope/nas?token=${TOKEN}`)).status).toBe(404);
  });

  it("returns 401 for unknown subscription and wrong token alike", async () => {
    expect((await call(`/default/missing?token=${TOKEN}&body=x`)).status).toBe(401);
    expect((await call(`/default/nas?token=wrong&body=x`)).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("returns 400 when there is no text", async () => {
    expect((await call(`/default/nas?token=${TOKEN}`)).status).toBe(400);
  });
});

describe("default", () => {
  it("accepts JSON with bearer token and reports per-target results", async () => {
    const res = await call(
      "/default/nas",
      json({ title: "部署完成", body: "v1.2.3", level: "warn", tags: ["a", "b"], url: "https://x.test" }, { authorization: `Bearer ${TOKEN}` }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, results: [{ id: "t1", ok: true }] });
    expect(res.headers.get("x-forward-result")).toBe("t1=ok");
    expect(forwarded(sent)).toEqual({ title: "部署完成", body: "v1.2.3", level: "warn", tags: ["a", "b"], url: "https://x.test" });
  });

  it("accepts GET query and body aliases", async () => {
    await call(`/default/nas?token=${TOKEN}&title=t&message=m`);
    expect(forwarded(sent)).toMatchObject({ title: "t", body: "m" });
  });

  it("accepts plain text bodies", async () => {
    await call(`/default/nas?token=${TOKEN}`, { method: "POST", body: "just text", headers: { "content-type": "text/plain" } });
    expect(forwarded(sent)).toEqual({ body: "just text" });
  });
});

describe("bark", () => {
  it("parses /:key/:title/:body", async () => {
    const res = await call(`/bark/nas/${TOKEN}/标题/内容?url=https://x.test&group=g`);
    expect(await res.json()).toMatchObject({ code: 200, message: "success" });
    expect(forwarded(sent)).toEqual({ title: "标题", body: "内容", url: "https://x.test", group: "g" });
  });

  it("parses /:key/:body", async () => {
    await call(`/bark/nas/${TOKEN}/only-body`);
    expect(forwarded(sent)).toEqual({ body: "only-body" });
  });

  it("parses POST /push with device_key", async () => {
    await call("/bark/nas/push", json({ device_key: TOKEN, title: "t", body: "b", level: "critical" }));
    expect(forwarded(sent)).toEqual({ title: "t", body: "b", level: "critical" });
  });

  it("rejects the wrong key", async () => {
    expect((await call(`/bark/nas/wrong/t/b`)).status).toBe(401);
  });
});

describe("ntfy", () => {
  it("parses plain text body with headers", async () => {
    const res = await call(`/ntfy/nas/${TOKEN}`, {
      method: "POST",
      body: "disk full",
      headers: { "x-title": "=?UTF-8?B?5ZGK6K2m?=", "x-priority": "5", "x-tags": "warning,disk" },
    });
    expect(await res.json()).toMatchObject({ event: "message", message: "disk full" });
    expect(forwarded(sent)).toEqual({ title: "告警", body: "disk full", level: "critical", tags: ["warning", "disk"] });
  });

  it("parses JSON publishing with topic in the body", async () => {
    await call("/ntfy/nas", json({ topic: TOKEN, title: "t", message: "m", priority: 4, click: "https://x.test" }));
    expect(forwarded(sent)).toEqual({ title: "t", body: "m", level: "warn", url: "https://x.test" });
  });

  it("accepts GET /topic/publish", async () => {
    await call(`/ntfy/nas/${TOKEN}/publish?message=hi&title=t`);
    expect(forwarded(sent)).toEqual({ title: "t", body: "hi" });
  });
});

describe("gotify", () => {
  it("parses /message with token query", async () => {
    const res = await call(`/gotify/nas/message?token=${TOKEN}`, json({ title: "t", message: "m", priority: 8 }));
    expect(await res.json()).toMatchObject({ title: "t", message: "m" });
    expect(forwarded(sent)).toEqual({ title: "t", body: "m", level: "critical" });
  });

  it("accepts X-Gotify-Key and form bodies", async () => {
    await call("/gotify/nas/message", {
      method: "POST",
      headers: { "x-gotify-key": TOKEN, "content-type": "application/x-www-form-urlencoded" },
      body: "title=t&message=m&priority=5",
    });
    expect(forwarded(sent)).toEqual({ title: "t", body: "m", level: "warn" });
  });
});

describe("chat robots", () => {
  it("wecom text and markdown", async () => {
    const res = await call(`/wecom/nas/cgi-bin/webhook/send?key=${TOKEN}`, json({ msgtype: "text", text: { content: "hello" } }));
    expect(await res.json()).toEqual({ errcode: 0, errmsg: "ok" });
    await call(`/wecom/nas/cgi-bin/webhook/send?key=${TOKEN}`, json({ msgtype: "markdown", markdown: { content: "**b**" } }));
    expect(forwarded(sent, 0)).toEqual({ body: "hello" });
    expect(forwarded(sent, 1)).toEqual({ body: "**b**", markdown: true });
  });

  it("dingtalk markdown", async () => {
    await call(`/dingtalk/nas/robot/send?access_token=${TOKEN}`, json({ msgtype: "markdown", markdown: { title: "T", text: "# x" } }));
    expect(forwarded(sent)).toEqual({ title: "T", body: "# x", markdown: true });
  });

  it("feishu text and post", async () => {
    const res = await call(`/feishu/nas/open-apis/bot/v2/hook/${TOKEN}`, json({ msg_type: "text", content: { text: "hi" } }));
    expect(await res.json()).toMatchObject({ code: 0 });
    await call(
      `/feishu/nas/open-apis/bot/v2/hook/${TOKEN}`,
      json({
        msg_type: "post",
        content: { post: { zh_cn: { title: "T", content: [[{ tag: "text", text: "a " }, { tag: "a", text: "link", href: "https://x" }], [{ tag: "text", text: "b" }]] } } },
      }),
    );
    expect(forwarded(sent, 0)).toEqual({ body: "hi" });
    expect(forwarded(sent, 1)).toEqual({ title: "T", body: "a link\nb" });
  });

  it("discord content and embeds, 204 response", async () => {
    const res = await call(
      `/discord/nas/api/webhooks/0/${TOKEN}`,
      json({ content: "c", embeds: [{ title: "E", description: "d", url: "https://x.test" }] }),
    );
    expect(res.status).toBe(204);
    expect(forwarded(sent)).toEqual({ title: "E", body: "c\n\nd", url: "https://x.test", markdown: true });
  });

  it("slack text, plain ok response", async () => {
    const res = await call(`/slack/nas/services/x/x/${TOKEN}`, json({ text: "hello *world*" }));
    expect(await res.text()).toBe("ok");
    expect(forwarded(sent)).toEqual({ body: "hello *world*", markdown: true });
  });

  it("telegram sendMessage", async () => {
    const res = await call(`/telegram/nas/bot${TOKEN}/sendMessage`, json({ chat_id: 1, text: "<b>hi</b> &amp; bye", parse_mode: "HTML" }));
    expect(await res.json()).toMatchObject({ ok: true });
    expect(forwarded(sent)).toEqual({ body: "hi & bye" });
  });
});

describe("all (auto-detect)", () => {
  const cases: [string, string, RequestInit, string][] = [
    ["bark path", `/all/nas/${TOKEN}/t/b`, {}, "bark"],
    ["bark json", "/all/nas/push", json({ device_key: TOKEN, body: "b" }), "bark"],
    ["ntfy text", `/all/nas/${TOKEN}`, { method: "POST", body: "b" }, "ntfy"],
    ["ntfy headers", `/all/nas/${TOKEN}`, { method: "POST", body: "b", headers: { "x-title": "t" } }, "ntfy"],
    ["gotify", `/all/nas/message?token=${TOKEN}`, json({ message: "m" }), "gotify"],
    ["gotify header", "/all/nas/message", json({ message: "m" }, { "x-gotify-key": TOKEN }), "gotify"],
    ["wecom", `/all/nas/cgi-bin/webhook/send?key=${TOKEN}`, json({ msgtype: "text", text: { content: "x" } }), "wecom"],
    ["dingtalk", `/all/nas/robot/send?access_token=${TOKEN}`, json({ msgtype: "text", text: { content: "x" } }), "dingtalk"],
    ["feishu", `/all/nas/open-apis/bot/v2/hook/${TOKEN}`, json({ msg_type: "text", content: { text: "x" } }), "feishu"],
    ["discord", `/all/nas/api/webhooks/0/${TOKEN}`, json({ content: "x" }), "discord"],
    ["slack", `/all/nas/services/x/x/${TOKEN}`, json({ text: "x" }), "slack"],
    ["telegram", `/all/nas/bot${TOKEN}/sendMessage`, json({ chat_id: 1, text: "x" }), "telegram"],
    ["default json", `/all/nas?token=${TOKEN}`, json({ title: "t", body: "b" }), "default"],
    ["default bearer", "/all/nas", json({ text: "b" }, { authorization: `Bearer ${TOKEN}` }), "default"],
  ];

  it.each(cases)("%s", async (_name, path, init, format) => {
    const res = await call(path, init);
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    expect(res.headers.get("x-detected-format")?.split(";")[0]).toBe(format);
    expect(sent).toHaveLength(1);
  });

  it("returns 401 when the token is nowhere", async () => {
    expect((await call("/all/nas?token=wrong", json({ body: "b" }))).status).toBe(401);
  });
});
