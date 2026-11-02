import { safeEqual } from "../crypto";
import type { Message } from "../message";
import type { RequestView } from "../request-view";
import { barkIn } from "./bark";
import { dingtalkIn, discordIn, feishuIn, slackIn, wecomIn } from "./chatbot";
import { defaultIn } from "./default";
import { gotifyIn } from "./gotify";
import { ntfyIn } from "./ntfy";
import { telegramIn } from "./telegram";
import { Tier, type InboundAdapter } from "./types";

/** Order is the tie-break priority for `all` (highest first); `default` is the fallback. */
const SPECIFIC: InboundAdapter[] = [telegramIn, discordIn, slackIn, feishuIn, wecomIn, dingtalkIn, gotifyIn, ntfyIn, barkIn];

export const INBOUND: Record<string, InboundAdapter> = Object.fromEntries(
  [defaultIn, ...SPECIFIC].map((a) => [a.type, a]),
);

/** Inbound types in the order the admin UI lists them. */
export const INBOUND_TYPES = ["default", "all", "bark", "ntfy", "gotify", "wecom", "dingtalk", "feishu", "discord", "slack", "telegram"];

export const ALL_URL_TEMPLATE = "{base}?token={token}";

export async function tokenMatches(adapter: InboundAdapter, v: RequestView, token: string): Promise<boolean> {
  for (const candidate of adapter.tokens(v)) {
    if (candidate && (await safeEqual(candidate, token))) return true;
  }
  return false;
}

export interface Detection {
  adapter: InboundAdapter;
  tier: Tier;
  /** Candidates whose token position matched, for the dry-run page. */
  candidates: { type: string; tier: Tier | null }[];
}

/**
 * `all`: only adapters that found the subscription token where their format carries it are candidates.
 * The strongest detection wins; ties go to SPECIFIC order. Weak-only matches fall back to `default`.
 * Returns null when no adapter found the token.
 */
export async function detect(v: RequestView, token: string): Promise<Detection | null> {
  const candidates: Detection["candidates"] = [];
  let best: { adapter: InboundAdapter; tier: Tier } | null = null;
  for (const adapter of SPECIFIC) {
    if (!(await tokenMatches(adapter, v, token))) continue;
    const tier = adapter.detect(v);
    candidates.push({ type: adapter.type, tier });
    if (tier !== null && tier > Tier.Weak && (!best || tier > best.tier)) best = { adapter, tier };
  }
  const defaultMatches = await tokenMatches(defaultIn, v, token);
  if (defaultMatches) candidates.push({ type: "default", tier: Tier.Weak });
  if (best) return { ...best, candidates };
  if (defaultMatches || candidates.length) return { adapter: defaultIn, tier: Tier.Weak, candidates };
  return null;
}

export const tierName = (t: Tier) => Tier[t].toLowerCase();

export type { InboundAdapter, Message };
