import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { vi } from "vitest";
import app from "../src/index";
import { putSubscription, type Subscription, type Target } from "../src/store";

export const ORIGIN = "https://w.test";
export const TOKEN = "T0k3n-abcdef";

export interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Replaces outbound fetch; `reply` decides each target's response. */
export function mockFetch(reply: (req: Sent) => Response | Promise<Response> = () => new Response("{}")) {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const s: Sent = {
      url: req.url,
      method: req.method,
      headers: Object.fromEntries(req.headers),
      body: await req.text(),
    };
    sent.push(s);
    return reply(s);
  });
  return sent;
}

export function webhookTarget(id = "t1", extra: Partial<Target> = {}): Target {
  return {
    id,
    name: `hook ${id}`,
    type: "webhook",
    enabled: true,
    config: { url: `https://hook.test/${id}`, method: "POST", content_type: "application/json", headers: "", body_template: "" },
    ...extra,
  };
}

export async function seed(name = "nas", targets: Target[] = [webhookTarget()], extra: Partial<Subscription> = {}) {
  const sub: Subscription = {
    name,
    token: TOKEN,
    targets,
    created_at: "2026-11-02T00:00:00Z",
    updated_at: "2026-11-02T00:00:00Z",
    ...extra,
  };
  await putSubscription(env.SUBS, sub);
  return sub;
}

export async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(ORIGIN + path, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

/** Forwarded message as seen by the default webhook target (it posts the Message JSON). */
export function forwarded(sent: Sent[], i = 0): Record<string, unknown> {
  return JSON.parse(sent[i].body) as Record<string, unknown>;
}

let session: string | undefined;

/** Sessions are stateless signed cookies, so one login serves every test (and stays under the login rate limit). */
export async function login(): Promise<string> {
  if (session) return session;
  const res = await call("/admin/api/login", json({ password: "test-password" }, { origin: ORIGIN }));
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  session = (res.headers.get("set-cookie") ?? "").split(";")[0];
  return session;
}

export async function admin(path: string, cookie: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  headers.set("origin", ORIGIN);
  if (init.body) headers.set("content-type", "application/json");
  return call("/admin/api" + path, { ...init, headers });
}
