import { randomToken } from "../crypto";
import { HttpError, isObj, str } from "../http";
import { OUTBOUND } from "../outbound";
import type { Target } from "../store";

/** Target as returned to the admin UI: secret values blanked, with a list of which ones are set. */
export interface MaskedTarget extends Target {
  secrets_set: string[];
}

export function maskTarget(t: Target): MaskedTarget {
  const secretFields = OUTBOUND[t.type]?.secretFields ?? [];
  const config = { ...t.config };
  const secrets_set: string[] = [];
  for (const f of secretFields) {
    if (config[f] !== undefined && config[f] !== "") secrets_set.push(f);
    config[f] = "";
  }
  return { ...t, config, secrets_set };
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

  const submitted = isObj(input.config) ? { ...input.config } : {};
  const clear = Array.isArray(input.clear) ? input.clear.map(String) : [];
  if (existing && existing.type === type) {
    for (const f of adapter.secretFields) {
      const blank = submitted[f] === undefined || submitted[f] === "";
      if (blank && !clear.includes(f) && existing.config[f] !== undefined) submitted[f] = existing.config[f];
    }
  }
  const parsed = adapter.schema.safeParse(submitted);
  const name = (str(input.name) ?? "").trim() || adapter.label;
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ");
    throw new HttpError(400, `目标「${name}」配置无效：${detail}`);
  }
  return {
    id: existing?.id ?? randomToken(6),
    name,
    type,
    enabled: input.enabled !== false,
    config: parsed.data as Record<string, unknown>,
  };
}
