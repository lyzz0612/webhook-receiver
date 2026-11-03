import { errorMessage } from "./http";
import type { Message } from "./message";
import { OUTBOUND } from "./outbound";
import { SEND_TIMEOUT_MS, type OutboundRequest } from "./outbound/types";
import type { Target } from "./store";

export interface TargetResult {
  id: string;
  name: string;
  type: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface ForwardResult {
  ok: boolean;
  results: TargetResult[];
}

export async function buildRequest(target: Target, msg: Message): Promise<OutboundRequest> {
  const adapter = OUTBOUND[target.type];
  if (!adapter) throw new Error(`unknown target type: ${target.type}`);
  const parsed = adapter.schema.safeParse(target.config);
  if (!parsed.success) throw new Error(`invalid config: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  return adapter.build(msg, parsed.data);
}

export async function sendToTarget(target: Target, msg: Message): Promise<TargetResult> {
  const base = { id: target.id, name: target.name, type: target.type };
  try {
    const req = await buildRequest(target, msg);
    const res = await fetch(req.url, { ...req.init, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    const text = await res.text();
    if (!res.ok) return { ...base, ok: false, status: res.status, error: `HTTP ${res.status}` };
    OUTBOUND[target.type].check?.(res, text);
    return { ...base, ok: true, status: res.status };
  } catch (e) {
    const error = e instanceof DOMException && e.name === "TimeoutError" ? "timeout" : errorMessage(e);
    return { ...base, ok: false, error };
  }
}

/** Sends to every enabled target concurrently; succeeds when at least one target accepted the message. */
export async function forward(targets: Target[], msg: Message): Promise<ForwardResult> {
  const enabled = targets.filter((t) => t.enabled);
  const results = await Promise.all(enabled.map((t) => sendToTarget(t, msg)));
  return { ok: results.some((r) => r.ok), results };
}

export function resultHeader(r: ForwardResult): string {
  if (!r.results.length) return "none";
  return r.results
    .map((t) => `${t.id}=${t.ok ? "ok" : "error:" + (t.error ?? "").replace(/[;\r\n]/g, " ").slice(0, 80)}`)
    .join("; ");
}
