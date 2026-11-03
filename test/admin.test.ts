import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSubscription } from "../src/store";
import { admin, call, json, login, mockFetch, ORIGIN, seed, TOKEN } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const ntfyTarget = { name: "phone", type: "ntfy", config: { server: "https://ntfy.test", topic: "tp", auth_kind: "bearer", auth_token: "secret-1" } };

type SubView = { name: string; token: string; targets: { id: string; name: string; config: Record<string, string>; secrets_set: string[] }[] };

async function body<T = SubView>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

const post = (b: unknown = {}) => ({ method: "POST", body: JSON.stringify(b) });
const put = (b: unknown) => ({ method: "PUT", body: JSON.stringify(b) });

describe("admin auth", () => {
  it("rejects a wrong password and unauthenticated calls", async () => {
    expect((await call("/admin/api/login", json({ password: "nope" }, { origin: ORIGIN }))).status).toBe(401);
    expect((await call("/admin/api/subscriptions")).status).toBe(401);
  });

  it("rejects cross-origin writes", async () => {
    const cookie = await login();
    const res = await call("/admin/api/subscriptions", {
      method: "POST",
      body: JSON.stringify({ name: "x" }),
      headers: { cookie, origin: "https://evil.test", "content-type": "application/json" },
    });
    expect(res.status).toBe(403);
  });

  it("issues a working session cookie", async () => {
    const cookie = await login();
    expect(cookie).toMatch(/^wr_session=/);
    expect((await admin("/subscriptions", cookie)).status).toBe(200);
  });
});

describe("subscriptions", () => {
  it("creates with a random token, lists, and rejects duplicates and bad names", async () => {
    const cookie = await login();
    const res = await admin("/subscriptions", cookie, post({ name: "ci" }));
    expect(res.status).toBe(201);
    const sub = await body(res);
    expect(sub.token.length).toBeGreaterThanOrEqual(24);
    expect(sub.targets).toEqual([]);
    expect((await body<SubView[]>(admin("/subscriptions", cookie))).map((s) => s.name)).toEqual(["ci"]);
    expect((await admin("/subscriptions", cookie, post({ name: "ci" }))).status).toBe(409);
    expect((await admin("/subscriptions", cookie, post({ name: "Bad Name" }))).status).toBe(400);
  });

  it("renames, keeping token and targets; old name stops working", async () => {
    mockFetch();
    await seed();
    await seed("taken");
    const cookie = await login();
    expect((await admin("/subscriptions/nas", cookie, put({ name: "taken" }))).status).toBe(409);
    expect((await admin("/subscriptions/nas", cookie, put({ name: "Bad Name" }))).status).toBe(400);
    const renamed = await body(admin("/subscriptions/nas", cookie, put({ name: "home" })));
    expect(renamed).toMatchObject({ name: "home", token: TOKEN });
    expect(renamed.targets).toHaveLength(1);
    expect(await getSubscription(env.SUBS, "nas")).toBeNull();
    expect((await call(`/default/nas?token=${TOKEN}&body=x`)).status).toBe(401);
    expect((await call(`/default/home?token=${TOKEN}&body=x`)).status).toBe(200);
  });

  it("resets and sets tokens; the old token stops working", async () => {
    mockFetch();
    await seed();
    const cookie = await login();
    const reset = await body(admin("/subscriptions/nas/token", cookie, post()));
    expect(reset.token).not.toBe(TOKEN);
    expect((await call(`/default/nas?token=${TOKEN}&body=x`)).status).toBe(401);
    expect((await call(`/default/nas?token=${reset.token}&body=x`)).status).toBe(200);
    expect((await admin("/subscriptions/nas/token", cookie, post({ token: "short" }))).status).toBe(400);
    const set = await body(admin("/subscriptions/nas/token", cookie, post({ token: "123456:ABC-def_ghi" })));
    expect(set.token).toBe("123456:ABC-def_ghi");
  });

  it("deletes", async () => {
    await seed();
    const cookie = await login();
    expect((await admin("/subscriptions/nas", cookie, { method: "DELETE" })).status).toBe(200);
    expect(await getSubscription(env.SUBS, "nas")).toBeNull();
    expect((await admin("/subscriptions/nas", cookie, { method: "DELETE" })).status).toBe(404);
  });
});

describe("targets", () => {
  it("adds, edits and deletes a single target", async () => {
    await seed("nas", []);
    const cookie = await login();
    const added = await admin("/subscriptions/nas/targets", cookie, post(ntfyTarget));
    expect(added.status).toBe(201);
    const id = (await body(added)).targets[0].id;

    const edited = await body(admin(`/subscriptions/nas/targets/${id}`, cookie, put({ ...ntfyTarget, config: { ...ntfyTarget.config, topic: "tp2" } })));
    expect(edited.targets).toHaveLength(1);
    expect(edited.targets[0]).toMatchObject({ id, config: { topic: "tp2" } });

    const deleted = await body(admin(`/subscriptions/nas/targets/${id}`, cookie, { method: "DELETE" }));
    expect(deleted.targets).toEqual([]);
    expect((await admin(`/subscriptions/nas/targets/${id}`, cookie, { method: "DELETE" })).status).toBe(404);
  });

  it("masks secrets and keeps them when saved blank; explicit clear removes them", async () => {
    await seed("nas", []);
    const cookie = await login();
    const t = (await body(admin("/subscriptions/nas/targets", cookie, post(ntfyTarget)))).targets[0];
    expect(t.config.auth_token).toBe("");
    expect(t.secrets_set).toContain("auth_token");

    await admin(`/subscriptions/nas/targets/${t.id}`, cookie, put({ ...ntfyTarget, config: { ...t.config, topic: "tp2" } }));
    let stored = await getSubscription(env.SUBS, "nas");
    expect(stored?.targets[0].config).toMatchObject({ topic: "tp2", auth_token: "secret-1" });

    await admin(`/subscriptions/nas/targets/${t.id}`, cookie, put({ ...ntfyTarget, config: t.config, clear: ["auth_token"] }));
    stored = await getSubscription(env.SUBS, "nas");
    expect(stored?.targets[0].config.auth_token).toBe("");
  });

  it("rejects invalid config and enforces the target limit", async () => {
    await seed("nas", []);
    const cookie = await login();
    expect((await admin("/subscriptions/nas/targets", cookie, post({ type: "gotify", config: { server: "not a url" } }))).status).toBe(400);
    expect((await admin("/subscriptions/nas/targets", cookie, post({ type: "nope" }))).status).toBe(400);
    for (let i = 0; i < 10; i++) await admin("/subscriptions/nas/targets", cookie, post(ntfyTarget));
    expect((await admin("/subscriptions/nas/targets", cookie, post(ntfyTarget))).status).toBe(400);
  });

  it("ntfy has no name; other types require one", async () => {
    await seed("nas", []);
    const cookie = await login();
    const sub = await body(admin("/subscriptions/nas/targets", cookie, post({ ...ntfyTarget, name: "ignored" })));
    expect(sub.targets[0].name).toBe("");
    for (const t of [
      { type: "gotify", config: { server: "https://g.example.com", app_token: "app" } },
      { type: "wecom", config: { key: "k" } },
      { type: "feishu", config: { webhook_url: "https://open.feishu.cn/x" } },
      { type: "webhook", config: { url: "https://h.example.com" } },
    ]) {
      expect((await admin("/subscriptions/nas/targets", cookie, post(t))).status).toBe(400);
      expect((await admin("/subscriptions/nas/targets", cookie, post({ ...t, name: "  " }))).status).toBe(400);
    }
  });

  it("the list shows a non-secret summary per type", async () => {
    await seed("nas", []);
    const cookie = await login();
    const add = (t: unknown) => body(admin("/subscriptions/nas/targets", cookie, post(t)));
    // Blank fields as the form sends them: server falls back to https://ntfy.sh.
    await add({ type: "ntfy", config: { server: "", topic: "alerts", auth_kind: "none", auth_token: "" } });
    await add({ type: "ntfy", config: { server: "https://ntfy.example.com", topic: "ops" } });
    await add({ type: "gotify", name: "g", config: { server: "https://g.example.com", app_token: "app" } });
    await add({ type: "wecom", name: "w", config: { key: "secret-key-wxyz" } });
    await add({ type: "feishu", name: "f", config: { webhook_url: "https://open.feishu.cn/open-apis/bot/v2/hook/abcd1234" } });
    const sub = await add({ type: "webhook", name: "h", config: { url: "https://hook.example.com/path?key=s3cret" } });

    expect(sub.targets.map((t) => t.name)).toEqual(["", "", "g", "w", "f", "h"]);
    expect(sub.targets.map((t) => (t as unknown as { summary: string }).summary)).toEqual([
      "alerts",
      "ops @ ntfy.example.com",
      "g.example.com",
      "…wxyz",
      "…1234",
      "POST hook.example.com",
    ]);
    // Summaries never leak secrets.
    expect(JSON.stringify(sub)).not.toMatch(/secret-key|abcd1234|s3cret/);
    expect(new Set(sub.targets.map((t) => t.id)).size).toBe(6);
  });

  it("no longer exposes the target test endpoint", async () => {
    await seed();
    const cookie = await login();
    expect((await admin("/subscriptions/nas/targets/t1/test", cookie, post())).status).toBe(404);
  });
});

describe("meta", () => {
  it("lists all 11 inbound types and 5 outbound types", async () => {
    const cookie = await login();
    const meta = await body<{ inbound: unknown[]; outbound: unknown[] }>(admin("/meta", cookie));
    expect(meta.inbound).toHaveLength(11);
    expect(meta.outbound).toHaveLength(5);
  });

  it("no longer exposes dry-run", async () => {
    const cookie = await login();
    expect((await admin("/dry-run", cookie, post({ path: "/" }))).status).toBe(404);
  });
});
