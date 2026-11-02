export interface Target {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface Subscription {
  name: string;
  token: string;
  enabled: boolean;
  note: string;
  targets: Target[];
  created_at: string;
  updated_at: string;
}

export const NAME_RE = /^[a-z0-9_-]{1,64}$/;
/** Tokens appear in URL paths, so keep them to unreserved characters (':' allows Telegram-shaped tokens). */
export const TOKEN_RE = /^[A-Za-z0-9._~:-]{8,128}$/;
export const MAX_TARGETS = 10;

const key = (name: string) => `sub:${name}`;

export async function getSubscription(kv: KVNamespace, name: string): Promise<Subscription | null> {
  if (!NAME_RE.test(name)) return null;
  return kv.get<Subscription>(key(name), "json");
}

export async function putSubscription(kv: KVNamespace, sub: Subscription): Promise<void> {
  await kv.put(key(sub.name), JSON.stringify(sub));
}

export async function deleteSubscription(kv: KVNamespace, name: string): Promise<void> {
  await kv.delete(key(name));
}

/** KV list is eventually consistent: freshly written subscriptions may be missing for a while. */
export async function listSubscriptions(kv: KVNamespace): Promise<Subscription[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: "sub:", cursor });
    names.push(...page.keys.map((k) => k.name.slice(4)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const subs = await Promise.all(names.map((n) => getSubscription(kv, n)));
  return subs.filter((s): s is Subscription => s !== null).sort((a, b) => a.name.localeCompare(b.name));
}
