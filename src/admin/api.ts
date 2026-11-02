import { Hono, type Context } from "hono";
import {
  checkPassword,
  clearSessionCookie,
  createSession,
  requireSession,
  sameOrigin,
  setSessionCookie,
  type AppEnv,
} from "../auth";
import { randomToken } from "../crypto";
import { buildRequest, sendToTarget } from "../forward";
import { errorMessage, HttpError, isObj, str } from "../http";
import { ALL_URL_TEMPLATE, INBOUND, INBOUND_TYPES, tierName } from "../inbound";
import { OUTBOUND, OUTBOUND_FIELDS } from "../outbound";
import {
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  NAME_RE,
  putSubscription,
  TOKEN_RE,
  type Subscription,
} from "../store";
import type { Target } from "../store";
import { resolve } from "../webhook";
import { copyKey, maskTarget, mergeTarget, mergeTargets } from "./targets";

export const adminApi = new Hono<AppEnv>();

adminApi.onError((e, c) => {
  if (e instanceof HttpError) return c.json({ error: e.message }, e.status as 400);
  console.error(e);
  return c.json({ error: errorMessage(e) }, 500);
});

adminApi.use("*", sameOrigin);

async function readJson(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  try {
    const v: unknown = await c.req.json();
    return isObj(v) ? v : {};
  } catch {
    return {};
  }
}

adminApi.post("/login", async (c) => {
  if (!c.env.ADMIN_PASSWORD) return c.json({ error: "ADMIN_PASSWORD 未设置" }, 503);
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  if (c.env.LOGIN_LIMITER) {
    const { success } = await c.env.LOGIN_LIMITER.limit({ key: `login:${ip}` });
    if (!success) return c.json({ error: "尝试次数过多，请稍后再试" }, 429);
  }
  const body = await readJson(c);
  if (!(await checkPassword(c.env, body.password))) return c.json({ error: "密码错误" }, 401);
  setSessionCookie(c, await createSession(c.env));
  return c.json({ ok: true });
});

adminApi.post("/logout", (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

adminApi.use("*", requireSession);

const view = (s: Subscription) => ({ ...s, targets: s.targets.map(maskTarget) });

async function load(c: Context<AppEnv>): Promise<Subscription> {
  const sub = await getSubscription(c.env.SUBS, c.req.param("name") ?? "");
  if (!sub) throw new HttpError(404, "订阅不存在");
  return sub;
}

/** Loads the source targets referenced by `copy_from`, so copied targets keep their secrets. */
async function copySources(kv: KVNamespace, inputs: unknown): Promise<Map<string, Target>> {
  const map = new Map<string, Target>();
  for (const t of Array.isArray(inputs) ? inputs : []) {
    const ref = isObj(t) && isObj(t.copy_from) ? t.copy_from : undefined;
    if (!ref || map.has(copyKey(ref))) continue;
    const src = await getSubscription(kv, str(ref.sub) ?? "");
    const target = src?.targets.find((x) => x.id === str(ref.id));
    if (target) map.set(copyKey(ref), target);
  }
  return map;
}

function checkToken(token: unknown): string {
  const t = str(token)?.trim() ?? "";
  if (!TOKEN_RE.test(t)) throw new HttpError(400, "token 需为 8–128 位，仅可包含字母、数字和 . _ ~ : -");
  return t;
}

adminApi.get("/meta", (c) =>
  c.json({
    inbound: INBOUND_TYPES.map((type) => ({
      type,
      label: type === "all" ? "自动识别" : INBOUND[type].label,
      urlTemplate: type === "all" ? ALL_URL_TEMPLATE : INBOUND[type].urlTemplate,
    })),
    outbound: Object.values(OUTBOUND).map((a) => ({
      type: a.type,
      label: a.label,
      fields: OUTBOUND_FIELDS[a.type],
      secretFields: a.secretFields,
    })),
  }),
);

adminApi.get("/subscriptions", async (c) => c.json((await listSubscriptions(c.env.SUBS)).map(view)));

adminApi.post("/subscriptions", async (c) => {
  const body = await readJson(c);
  const name = str(body.name)?.trim() ?? "";
  if (!NAME_RE.test(name)) throw new HttpError(400, "订阅名需为 1–64 位小写字母、数字、_ 或 -");
  if (await getSubscription(c.env.SUBS, name)) throw new HttpError(409, "订阅已存在");
  const now = new Date().toISOString();
  const sub: Subscription = {
    name,
    token: body.token ? checkToken(body.token) : randomToken(),
    enabled: body.enabled !== false,
    note: str(body.note) ?? "",
    targets: body.targets ? mergeTargets(body.targets, [], await copySources(c.env.SUBS, body.targets)) : [],
    created_at: now,
    updated_at: now,
  };
  await putSubscription(c.env.SUBS, sub);
  return c.json(view(sub), 201);
});

adminApi.get("/subscriptions/:name", async (c) => c.json(view(await load(c))));

adminApi.put("/subscriptions/:name", async (c) => {
  const sub = await load(c);
  const body = await readJson(c);
  if (body.enabled !== undefined) sub.enabled = body.enabled !== false;
  if (body.note !== undefined) sub.note = str(body.note) ?? "";
  if (body.targets !== undefined) {
    sub.targets = mergeTargets(body.targets, sub.targets, await copySources(c.env.SUBS, body.targets));
  }
  sub.updated_at = new Date().toISOString();
  await putSubscription(c.env.SUBS, sub);
  return c.json(view(sub));
});

adminApi.delete("/subscriptions/:name", async (c) => {
  const sub = await load(c);
  await deleteSubscription(c.env.SUBS, sub.name);
  return c.json({ ok: true });
});

/** Body { token } sets it; an empty body generates a new random token. */
adminApi.post("/subscriptions/:name/token", async (c) => {
  const sub = await load(c);
  const body = await readJson(c);
  sub.token = body.token ? checkToken(body.token) : randomToken();
  sub.updated_at = new Date().toISOString();
  await putSubscription(c.env.SUBS, sub);
  return c.json(view(sub));
});

const TEST_MESSAGE = { title: "测试消息", body: "这是一条来自 webhook-receiver 的测试消息。" };

/** Tests the stored target, or an unsaved draft sent as { target } (blank secrets fall back to the stored ones). */
adminApi.post("/subscriptions/:name/targets/:id/test", async (c) => {
  const sub = await load(c);
  const stored = sub.targets.find((t) => t.id === c.req.param("id"));
  const body = await readJson(c);
  let target = stored;
  if (body.target) {
    const copied = isObj(body.target) ? (await copySources(c.env.SUBS, [body.target])).get(copyKey(body.target.copy_from)) : undefined;
    target = mergeTarget(body.target, stored, stored ?? copied);
  }
  if (!target) throw new HttpError(404, "目标不存在");
  return c.json(await sendToTarget(target, TEST_MESSAGE));
});

/** Body { method, path, headers, body }: resolve the request like a real webhook, but don't send anything. */
adminApi.post("/dry-run", async (c) => {
  const input = await readJson(c);
  const method = (str(input.method) ?? "POST").toUpperCase();
  const path = str(input.path) ?? "/";
  const headers = new Headers();
  if (isObj(input.headers)) for (const [k, v] of Object.entries(input.headers)) headers.set(k, String(v));
  const url = new URL(path.startsWith("/") ? path : `/${path}`, new URL(c.req.url).origin);
  const hasBody = method !== "GET" && method !== "HEAD" && typeof input.body === "string" && input.body !== "";
  const req = new Request(url, { method, headers, body: hasBody ? (input.body as string) : undefined });

  try {
    const r = await resolve(req, c.env.SUBS);
    const requests = await Promise.all(
      r.sub.targets.map(async (t) => {
        try {
          const out = await buildRequest(t, r.message);
          return { id: t.id, name: t.name, type: t.type, enabled: t.enabled, request: { url: out.url, ...out.init } };
        } catch (e) {
          return { id: t.id, name: t.name, type: t.type, enabled: t.enabled, error: errorMessage(e) };
        }
      }),
    );
    return c.json({
      ok: true,
      format: r.adapter.type,
      tier: r.detection ? tierName(r.detection.tier) : "explicit",
      candidates: r.detection?.candidates.map((x) => ({ type: x.type, tier: x.tier === null ? null : tierName(x.tier) })),
      message: r.message,
      requests,
    });
  } catch (e) {
    if (e instanceof HttpError) return c.json({ ok: false, status: e.status, error: e.message });
    throw e;
  }
});
