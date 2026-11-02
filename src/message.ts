export type Level = "info" | "warn" | "critical";

export interface Message {
  title?: string;
  body: string;
  url?: string;
  level?: Level;
  tags?: string[];
  group?: string;
  markdown?: boolean;
  extra?: Record<string, unknown>;
}

const CRITICAL = ["critical", "crit", "error", "err", "fatal", "urgent", "max", "emergency", "alert"];
const WARN = ["warn", "warning", "high", "timesensitive"];

/** Maps free-form level names. Numeric scales differ per format, so adapters map those themselves. */
export function normalizeLevel(v: unknown): Level | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  if (!s || /^\d+$/.test(s)) return undefined;
  if (CRITICAL.includes(s)) return "critical";
  if (WARN.includes(s)) return "warn";
  return "info";
}

export function splitTags(v: unknown): string[] | undefined {
  const list = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : [];
  const tags = list.map((t) => t.trim()).filter(Boolean);
  return tags.length ? tags : undefined;
}

export function truthy(v: unknown): boolean {
  if (v === true || v === 1) return true;
  return typeof v === "string" && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

export function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Trims fields, drops empty ones; promotes a lone title to body. Returns null when there is no text. */
export function finalize(m: Partial<Message>): Message | null {
  const clean = (s?: string) => {
    const t = s?.trim();
    return t ? t : undefined;
  };
  let title = clean(m.title);
  let body = clean(m.body);
  if (!body && title) {
    body = title;
    title = undefined;
  }
  if (!body) return null;
  const out: Message = { body };
  if (title) out.title = title;
  const url = clean(m.url);
  if (url) out.url = url;
  if (m.level) out.level = m.level;
  if (m.tags?.length) out.tags = m.tags;
  const group = clean(m.group);
  if (group) out.group = group;
  if (m.markdown) out.markdown = true;
  if (m.extra && Object.keys(m.extra).length) out.extra = m.extra;
  return out;
}

/** "title\n\nbody[\n\nurl]" for targets without separate fields. */
export function composeText(m: Message, opts: { url?: boolean } = {}): string {
  const parts = [m.title, m.body];
  if (opts.url) parts.push(m.url);
  return parts.filter(Boolean).join("\n\n");
}

const encoder = new TextEncoder();

export function truncateBytes(s: string, max: number): string {
  if (encoder.encode(s).length <= max) return s;
  const ellipsis = "…";
  const budget = max - encoder.encode(ellipsis).length;
  const chars = Array.from(s);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (encoder.encode(chars.slice(0, mid).join("")).length <= budget) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join("") + ellipsis;
}
