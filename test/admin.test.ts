import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSubscription } from "../src/store";
import { admin, call, json, login, mockFetch, ORIGIN, seed, TOKEN } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const ntfyTarget = { name: "phone", type: "ntfy", config: { server: "https://ntfy.test", topic: "tp", auth_kind: "bearer", auth_token: "secret-1" } };

describe("admin auth", () => {
  it("rejects a wrong password and unauthenticated calls", async () => {
    expect((await call("/admin/api/login", json({ password: "nope" }, { origin: ORIGIN }))).status).toBe(401);
    expect((await call("/admin/api/subscriptions")).status).toBe(401);
  });

  it("rejects cross-origin writes", async () => {
    const cookie = await login();
    const res = await call("/admin/api/subscriptions", { ...json({ name: "x" }, { origin: "https://evil.test" }), headers: { cookie, origin: "https://evil.test", "content-type": "application/json" } });
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
    const res = await admin("/subscriptions", cookie, { method: "POST", body: JSON.stringify({ name: "ci" }) });
    expect(res.status).toBe(201);
    const sub = (await res.json()) as { token: string };
    expect(sub.token.length).toBeGreaterThanOrEqual(24);
    expect((await admin("/subscriptions", cookie, { method: "POST", body: JSON.stringify({ name: "ci" }) })).status).toBe(409);
    expect((await admin("/subscriptions", cookie, { method: "POST", body: JSON.stringify({ name: "Bad Name" }) })).status).toBe(400);
  });

  it("masks secrets and keeps them when saved blank", async () => {
    const cookie = await login();
    await admin("/subscriptions", cookie, { method: "POST", body: JSON.stringify({ name: "nas", targets: [ntfyTarget] }) });
    const got = (await (await admin("/subscriptions/nas", cookie)).json()) as { targets: { id: string; config: Record<string, string>; secrets_set: string[] }[] };
    const t = got.targets[0];
    expect(t.config.auth_token).toBe("");
    expect(t.secrets_set).toContain("auth_token");

    // Save the masked target back with a changed topic: the secret must survive.
    await admin("/subscriptions/nas", cookie, { method: "PUT", body: JSON.stringify({ targets: [{ ...ntfyTarget, id: t.id, config: { ...t.config, topic: "tp2" } }] }) });
    let stored = await getSubscription(env.SUBS, "nas");
    expect(stored?.targets[0].config).toMatchObject({ topic: "tp2", auth_token: "secret-1" });

    // Explicit clear removes it.
    await admin("/subscriptions/nas", cookie, { method: "PUT", body: JSON.stringify({ targets: [{ ...ntfyTarget, id: t.id, config: t.config, clear: ["auth_token"] }] }) });
    stored = await getSubscription(env.SUBS, "nas");
    expect(stored?.targets[0].config.auth_token).toBe("");
  });

  it("copies targets from another subscription including secrets", async () => {
    const cookie = await login();
    await admin("/subscriptions", cookie, { method: "POST", body: JSON.stringify({ name: "a", targets: [ntfyTarget] }) });
    const a = await getSubscription(env.SUBS, "a");
    const masked = { ...ntfyTarget, config: { ...ntfyTarget.config, auth_token: "" }, copy_from: { sub: "a", id: a!.targets[0].id } };
    await admin("/subscriptions", cookie, { method: "POST", body: JSON.stringify({ name: "b", targets: [masked] }) });
    const b = await getSubscription(env.SUBS, "b");
    expect(b?.targets[0].config.auth_token).toBe("secret-1");
    expect(b?.targets[0].id).not.toBe(a!.targets[0].id);
  });

  it("rejects invalid target config", async () => {
    const cookie = await login();
    const res = await admin("/subscriptions", cookie, { method: "POST", body: JSON.stringify({ name: "x", targets: [{ type: "gotify", config: { server: "not a url" } }] }) });
    expect(res.status).toBe(400);
  });

  it("resets and sets tokens; the old token stops working", async () => {
    mockFetch();
    await seed();
    const cookie = await login();
    const reset = (await (await admin("/subscriptions/nas/token", cookie, { method: "POST", body: "{}" })).json()) as { token: string };
    expect(reset.token).not.toBe(TOKEN);
    expect((await call(`/default/nas?token=${TOKEN}&body=x`)).status).toBe(401);
    expect((await call(`/default/nas?token=${reset.token}&body=x`)).status).toBe(200);
    expect((await admin("/subscriptions/nas/token", cookie, { method: "POST", body: JSON.stringify({ token: "short" }) })).status).toBe(400);
    const set = (await (await admin("/subscriptions/nas/token", cookie, { method: "POST", body: JSON.stringify({ token: "123456:ABC-def_ghi" }) })).json()) as { token: string };
    expect(set.token).toBe("123456:ABC-def_ghi");
  });

  it("deletes", async () => {
    await seed();
    const cookie = await login();
    expect((await admin("/subscriptions/nas", cookie, { method: "DELETE" })).status).toBe(200);
    expect(await getSubscription(env.SUBS, "nas")).toBeNull();
  });
});

describe("test send and dry-run", () => {
  it("tests a target and returns the raw response", async () => {
    mockFetch(() => new Response("accepted", { status: 202 }));
    await seed();
    const cookie = await login();
    const r = (await (await admin("/subscriptions/nas/targets/t1/test", cookie, { method: "POST", body: "{}" })).json()) as Record<string, unknown>;
    expect(r).toMatchObject({ ok: true, status: 202, response: "accepted" });
  });

  it("dry-run detects, parses and builds requests without sending", async () => {
    const sent = mockFetch();
    await seed();
    const cookie = await login();
    const r = (await (
      await admin("/dry-run", cookie, {
        method: "POST",
        body: JSON.stringify({ method: "POST", path: `/all/nas/message?token=${TOKEN}`, headers: { "content-type": "application/json" }, body: '{"message":"m","title":"t"}' }),
      })
    ).json()) as Record<string, unknown>;
    expect(r).toMatchObject({ ok: true, format: "gotify", tier: "definitive", message: { title: "t", body: "m" } });
    expect((r.requests as unknown[]).length).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it("meta lists all 11 inbound types and 5 outbound types", async () => {
    const cookie = await login();
    const meta = (await (await admin("/meta", cookie)).json()) as { inbound: unknown[]; outbound: unknown[] };
    expect(meta.inbound).toHaveLength(11);
    expect(meta.outbound).toHaveLength(5);
  });
});
