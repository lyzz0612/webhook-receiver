import { randomToken } from "../crypto";
import { HttpError, isObj, str } from "../http";
import { OUTBOUND } from "../outbound";
import type { Target } from "../store";

/** Target as returned to the admin UI: secret values blanked, with a list of which ones are set. */
export interface MaskedTarget extends Target {
  secrets_set: string[];
  /** Non-secret description for the list (computed before masking, e.g. ntfy topic or "…abcd"). */
  summary: string;
}

export function maskTarget(t: Target): MaskedTarget {
  const adapter = OUTBOUND[t.type];
  const parsed = adapter?.schema.safeParse(t.config);
  const summary = parsed?.success ? adapter.summary(parsed.data) : "";
  const config = { ...t.config };
  const secrets_set: string[] = [];
  for (const f of adapter?.secretFields ?? []) {
    if (config[f] !== undefined && config[f] !== "") secrets_set.push(f);
    config[f] = "";
  }
  // Older data may still carry a name on types that no longer have one (ntfy).
  const name = adapter && !adapter.named ? "" : t.name;
  return { ...t, name, config, secrets_set, summary };
}

/**
 * Validates a submitted target. Blank secret fields keep the stored value
 * unless listed in `clear`, so masked values are never written back.
 */
export function mergeTarget(input: unknown, existing: Target | undefined): Target {
  if (!isObj(input)) throw new HttpError(400, "target must be an object");
  const type = str(input.type) ?? "";
  const adapter = OUTBOUND[type];
  if (!adapter) throw new HttpError(400, `unknown target type: ${type}`);

  // Blank form fields count as unset, so schema defaults (e.g. ntfy server) apply.
  const submitted = Object.fromEntries(
    Object.entries(isObj(input.config) ? input.config : {}).filter(([, v]) => v !== "" && v !== undefined && v !== null),
  );
  const clear = Array.isArray(input.clear) ? input.clear.map(String) : [];
  if (existing && existing.type === type) {
    for (const f of adapter.secretFields) {
      const blank = submitted[f] === undefined || submitted[f] === "";
      if (blank && !clear.includes(f) && existing.config[f] !== undefined) submitted[f] = existing.config[f];
    }
  }
  const parsed = adapter.schema.safeParse(submitted);
  // Targets are identified by id. Types whose summary already tells them apart (ntfy topic) have no name;
  // the others need one because their summary is only a host or the tail of a key.
  const name = adapter.named ? (str(input.name) ?? "").trim() : "";
  if (adapter.named && !name) throw new HttpError(400, `${adapter.label}需要填写名称`);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ");
    throw new HttpError(400, `${adapter.label}配置无效：${detail}`);
  }
  return {
    id: existing?.id ?? randomToken(6),
    name,
    type,
    enabled: input.enabled !== false,
    config: parsed.data as Record<string, unknown>,
  };
}
