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
import { sendToTarget } from "../forward";
import { errorMessage, HttpError, isObj, str } from "../http";
import { ALL_URL_TEMPLATE, INBOUND, INBOUND_TYPES } from "../inbound";
import { OUTBOUND, OUTBOUND_FIELDS } from "../outbound";
import {
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  MAX_TARGETS,
  NAME_RE,
  putSubscription,
  TOKEN_RE,
  type Subscription,
  type Target,
} from "../store";
import { maskTarget, mergeTarget } from "./targets";

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

async function save(kv: KVNamespace, sub: Subscription) {
  sub.updated_at = new Date().toISOString();
  await putSubscription(kv, sub);
  return view(sub);
}

function findTarget(sub: Subscription, id: string | undefined): Target {
  const t = sub.targets.find((x) => x.id === id);
  if (!t) throw new HttpError(404, "目标不存在");
  return t;
}

function checkName(name: unknown): string {
  const n = str(name)?.trim() ?? "";
  if (!NAME_RE.test(n)) throw new HttpError(400, "订阅名需为 1–64 位小写字母、数字、_ 或 -");
  return n;
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
  const name = checkName(body.name);
  if (await getSubscription(c.env.SUBS, name)) throw new HttpError(409, "订阅已存在");
  const now = new Date().toISOString();
  const sub: Subscription = {
    name,
    token: body.token ? checkToken(body.token) : randomToken(),
    targets: [],
    created_at: now,
    updated_at: now,
  };
  await putSubscription(c.env.SUBS, sub);
  return c.json(view(sub), 201);
});

/** Renames the subscription: body { name }. Every client URL changes with it. */
adminApi.put("/subscriptions/:name", async (c) => {
  const sub = await load(c);
  const name = checkName((await readJson(c)).name);
  if (name === sub.name) return c.json(view(sub));
  if (await getSubscription(c.env.SUBS, name)) throw new HttpError(409, "订阅名已存在");
  const oldName = sub.name;
  sub.name = name;
  const updated = await save(c.env.SUBS, sub);
  await deleteSubscription(c.env.SUBS, oldName);
  return c.json(updated);
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
  return c.json(await save(c.env.SUBS, sub));
});

adminApi.post("/subscriptions/:name/targets", async (c) => {
  const sub = await load(c);
  if (sub.targets.length >= MAX_TARGETS) throw new HttpError(400, `每个订阅最多 ${MAX_TARGETS} 个目标`);
  sub.targets.push(mergeTarget(await readJson(c), undefined));
  return c.json(await save(c.env.SUBS, sub), 201);
});

adminApi.put("/subscriptions/:name/targets/:id", async (c) => {
  const sub = await load(c);
  const existing = findTarget(sub, c.req.param("id"));
  const updated = mergeTarget(await readJson(c), existing);
  sub.targets = sub.targets.map((t) => (t.id === existing.id ? updated : t));
  return c.json(await save(c.env.SUBS, sub));
});

adminApi.delete("/subscriptions/:name/targets/:id", async (c) => {
  const sub = await load(c);
  const existing = findTarget(sub, c.req.param("id"));
  sub.targets = sub.targets.filter((t) => t.id !== existing.id);
  return c.json(await save(c.env.SUBS, sub));
});

const TEST_MESSAGE = { title: "测试消息", body: "这是一条来自 webhook-receiver 的测试消息。" };

/** Tests the stored target, or unsaved form contents sent as { target } (blank secrets fall back to the stored ones). */
adminApi.post("/subscriptions/:name/targets/:id/test", async (c) => {
  const sub = await load(c);
  const stored = sub.targets.find((t) => t.id === c.req.param("id"));
  const body = await readJson(c);
  const target = body.target ? mergeTarget(body.target, stored) : stored;
  if (!target) throw new HttpError(404, "目标不存在");
  return c.json(await sendToTarget(target, TEST_MESSAGE));
});
