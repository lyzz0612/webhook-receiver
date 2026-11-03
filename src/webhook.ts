import { forward, resultHeader } from "./forward";
import { HttpError, jsonResponse } from "./http";
import { detect, INBOUND, tierName, tokenMatches, type Detection } from "./inbound";
import type { InboundAdapter } from "./inbound/types";
import { finalize, type Message } from "./message";
import { buildView, splitPath, type RequestView } from "./request-view";
import { getSubscription, type Subscription } from "./store";

export interface Resolved {
  sub: Subscription;
  view: RequestView;
  adapter: InboundAdapter;
  detection?: Detection;
  message: Message;
}

/** Steps 1–4 of the forwarding flow: route, authenticate, parse. Shared by the webhook handler and dry-run. */
export async function resolve(req: Request, kv: KVNamespace): Promise<Resolved> {
  const [type, subName, ...rest] = splitPath(new URL(req.url).pathname);
  if (!type || !subName || (type !== "all" && !INBOUND[type])) throw new HttpError(404, "not found");

  const sub = await getSubscription(kv, subName);
  // Unknown subscription and wrong token look the same to the caller.
  if (!sub) throw new HttpError(401, "unauthorized");

  const view = await buildView(req, rest);
  let adapter: InboundAdapter;
  let detection: Detection | undefined;
  if (type === "all") {
    const d = await detect(view, sub.token);
    if (!d) throw new HttpError(401, "unauthorized");
    detection = d;
    adapter = d.adapter;
  } else {
    adapter = INBOUND[type];
    if (!(await tokenMatches(adapter, view, sub.token))) throw new HttpError(401, "unauthorized");
  }

  const message = finalize(adapter.parse(view));
  if (!message) throw new HttpError(400, `no message text found for format "${adapter.type}"`);
  return { sub, view, adapter, detection, message };
}

export async function handleWebhook(req: Request, env: Env): Promise<Response> {
  let r: Resolved;
  try {
    r = await resolve(req, env.SUBS);
  } catch (e) {
    if (e instanceof HttpError) return jsonResponse({ ok: false, error: e.message }, e.status);
    throw e;
  }

  const result = await forward(r.sub.targets, r.message);
  const headers: Record<string, string> = { "x-forward-result": resultHeader(result) };
  if (r.detection) headers["x-detected-format"] = `${r.adapter.type}; tier=${tierName(r.detection.tier)}`;
  console.log(JSON.stringify({ sub: r.sub.name, format: r.adapter.type, forward: headers["x-forward-result"] }));

  if (!result.ok) {
    const error = result.results.length ? "all targets failed" : "no enabled targets";
    const results = result.results.map(({ response: _r, ...t }) => t);
    return jsonResponse({ ok: false, error, results }, 502, headers);
  }

  const res = r.adapter.respond({ view: r.view, message: r.message, result });
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}
