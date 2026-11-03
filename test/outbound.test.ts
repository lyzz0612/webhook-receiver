import { afterEach, describe, expect, it, vi } from "vitest";
import { forward } from "../src/forward";
import type { Message } from "../src/message";
import type { Target } from "../src/store";
import { call, json, mockFetch, seed, TOKEN, webhookTarget } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const msg: Message = { title: "标题", body: "正文", url: "https://x.test", level: "critical", tags: ["a"] };
const target = (type: string, config: Record<string, unknown>): Target => ({ id: type, name: type, type, enabled: true, config });

describe("outbound adapters", () => {
  it("ntfy publishes JSON to the server root with auth", async () => {
    const sent = mockFetch();
    await forward([target("ntfy", { server: "https://ntfy.test/", topic: "tp", auth_kind: "bearer", auth_token: "tk" })], msg);
    expect(sent[0].url).toBe("https://ntfy.test/");
    expect(sent[0].headers.authorization).toBe("Bearer tk");
    expect(JSON.parse(sent[0].body)).toEqual({ topic: "tp", message: "正文", title: "标题", priority: 5, tags: ["a"], click: "https://x.test" });
  });

  it.each([
    ["standard", { server: "https://ntfy.sh", topic: "skyup" }],
    ["blank server", { server: "", topic: "skyup" }],
    ["server without scheme", { server: "ntfy.sh", topic: "skyup" }],
    ["topic as full URL", { server: "", topic: "https://ntfy.sh/skyup" }],
    ["topic as host/path", { topic: "ntfy.sh/skyup" }],
    ["server includes topic", { server: "https://ntfy.sh/skyup", topic: "skyup" }],
    ["server is the topic URL, topic blank", { server: "https://ntfy.sh/skyup", topic: "" }],
  ])("ntfy normalizes %s to ntfy.sh + skyup", async (_name, config) => {
    const sent = mockFetch();
    const r = await forward([target("ntfy", config)], { body: "b" });
    expect(r.ok).toBe(true);
    expect(sent[0].url).toBe("https://ntfy.sh/");
    expect(JSON.parse(sent[0].body).topic).toBe("skyup");
  });

  it("ntfy keeps a self-hosted base path and rejects invalid topics", async () => {
    const sent = mockFetch();
    await forward([target("ntfy", { topic: "https://push.example.com/ntfy/alerts" })], { body: "b" });
    expect(sent[0].url).toBe("https://push.example.com/ntfy/");
    expect(JSON.parse(sent[0].body).topic).toBe("alerts");
    const bad = await forward([target("ntfy", { topic: "has space" })], { body: "b" });
    expect(bad.results[0].error).toContain("topic 只能包含");
  });

  it("reports the reason from the target's error body", async () => {
    mockFetch(() => new Response(JSON.stringify({ code: 40010, http: 400, error: "invalid request: topic invalid" }), { status: 400 }));
    const r = await forward([target("ntfy", { topic: "skyup" })], { body: "b" });
    expect(r.results[0].error).toBe("HTTP 400: invalid request: topic invalid");
  });

  it("gotify posts to /message with the app token", async () => {
    const sent = mockFetch();
    await forward([target("gotify", { server: "https://g.test", app_token: "app" })], { body: "b", markdown: true });
    expect(sent[0].url).toBe("https://g.test/message");
    expect(sent[0].headers["x-gotify-key"]).toBe("app");
    expect(JSON.parse(sent[0].body)).toEqual({ message: "b", priority: 5, extras: { "client::display": { contentType: "text/markdown" } } });
  });

  it("webhook renders templates with JSON escaping", async () => {
    const sent = mockFetch();
    await forward(
      [target("webhook", { url: "https://h.test/?t={{title}}", headers: "X-Key: k", body_template: '{"text":"{{text}}"}' })],
      { title: 'a "q"', body: "line\nnext" },
    );
    expect(sent[0].url).toBe("https://h.test/?t=a%20%22q%22");
    expect(sent[0].headers["x-key"]).toBe("k");
    expect(JSON.parse(sent[0].body)).toEqual({ text: 'a "q"\n\nline\nnext' });
  });

  it("feishu signs requests and checks the response code", async () => {
    const sent = mockFetch(() => new Response(JSON.stringify({ code: 19021, msg: "sign match fail" })));
    const r = await forward([target("feishu", { webhook_url: "https://open.feishu.test/hook/x", sign_secret: "s" })], { body: "b" });
    const body = JSON.parse(sent[0].body);
    expect(body).toMatchObject({ msg_type: "text", content: { text: "b" } });
    expect(body.timestamp).toMatch(/^\d+$/);
    expect(body.sign).toBeTruthy();
    expect(r.ok).toBe(false);
    expect(r.results[0].error).toContain("19021");
  });

  it("wecom builds the URL from a key and checks errcode", async () => {
    const sent = mockFetch(() => new Response(JSON.stringify({ errcode: 0, errmsg: "ok" })));
    const r = await forward([target("wecom", { key: "abc" })], msg);
    expect(sent[0].url).toBe("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc");
    expect(JSON.parse(sent[0].body)).toEqual({ msgtype: "text", text: { content: "标题\n\n正文\n\nhttps://x.test" } });
    expect(r.ok).toBe(true);
  });
});

describe("fan-out", () => {
  it("succeeds when at least one target succeeds and reports each result", async () => {
    mockFetch((req) => (req.url.endsWith("/t2") ? new Response("boom", { status: 500 }) : new Response("{}")));
    await seed("nas", [webhookTarget("t1"), webhookTarget("t2"), webhookTarget("t3", { enabled: false })]);
    const res = await call(`/default/nas?token=${TOKEN}&body=x`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-forward-result")).toBe("t1=ok; t2=error:HTTP 500: boom");
  });

  it("returns 502 when every target fails", async () => {
    mockFetch(() => new Response("no", { status: 503 }));
    await seed("nas", [webhookTarget("t1")]);
    const res = await call(`/bark/nas/${TOKEN}/x`);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, error: "all targets failed" });
  });

  it("returns 502 when there are no enabled targets", async () => {
    mockFetch();
    await seed("nas", []);
    const res = await call(`/default/nas`, json({ body: "x" }, { authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "no enabled targets" });
  });
});
