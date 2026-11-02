import { HttpError, str } from "./http";

const MAX_BODY_BYTES = 256 * 1024;

/** A request parsed once, so every inbound adapter can inspect it (Request bodies are single-read). */
export interface RequestView {
  method: string;
  url: URL;
  /** Decoded path segments after /{type}/{subscription}. */
  rest: string[];
  query: URLSearchParams;
  headers: Headers;
  /** Lower-cased media type without parameters. */
  contentType: string;
  /** Raw body text (empty for multipart). */
  text: string;
  /** Fields of a JSON object or form body. */
  body?: Record<string, unknown>;
  bodyKind: "none" | "json" | "form" | "text";
}

export function splitPath(pathname: string): string[] {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

export async function buildView(req: Request, rest: string[]): Promise<RequestView> {
  const url = new URL(req.url);
  const rawType = req.headers.get("content-type") ?? "";
  const contentType = rawType.split(";")[0].trim().toLowerCase();
  const view: RequestView = {
    method: req.method.toUpperCase(),
    url,
    rest,
    query: url.searchParams,
    headers: req.headers,
    contentType,
    text: "",
    bodyKind: "none",
  };
  if (view.method === "GET" || view.method === "HEAD" || !req.body) return view;

  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) throw new HttpError(413, "payload too large");
  if (buf.byteLength === 0) return view;

  if (contentType === "multipart/form-data") {
    const form = await new Response(buf, { headers: { "content-type": rawType } }).formData();
    const body: Record<string, unknown> = {};
    for (const [k, v] of form) if (typeof v === "string") body[k] = v;
    view.body = body;
    view.bodyKind = "form";
    return view;
  }

  view.text = new TextDecoder().decode(buf);
  if (contentType === "application/x-www-form-urlencoded") {
    view.body = Object.fromEntries(new URLSearchParams(view.text));
    view.bodyKind = "form";
  } else if (contentType.includes("json") || (!contentType && /^\s*\{/.test(view.text))) {
    try {
      const parsed: unknown = JSON.parse(view.text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        view.body = parsed as Record<string, unknown>;
        view.bodyKind = "json";
      } else {
        view.bodyKind = "text";
      }
    } catch {
      view.bodyKind = "text";
    }
  } else {
    view.bodyKind = "text";
  }
  return view;
}

/** First non-empty scalar among the named fields, body before query. */
export function pick(v: RequestView, ...names: string[]): string | undefined {
  for (const n of names) {
    const s = str(v.body?.[n]);
    if (s !== undefined && s !== "") return s;
  }
  for (const n of names) {
    const q = v.query.get(n);
    if (q) return q;
  }
  return undefined;
}

/** Raw field value (may be an object or array), body before query. */
export function pickRaw(v: RequestView, name: string): unknown {
  const b = v.body?.[name];
  if (b !== undefined && b !== null) return b;
  return v.query.get(name) ?? undefined;
}

export function header(v: RequestView, ...names: string[]): string | undefined {
  for (const n of names) {
    const h = v.headers.get(n);
    if (h) return h;
  }
  return undefined;
}

export function bearer(v: RequestView): string | undefined {
  const m = v.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : undefined;
}
