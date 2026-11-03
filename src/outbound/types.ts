import type { z } from "zod";
import type { Message } from "../message";

export interface OutboundRequest {
  url: string;
  init: RequestInit & { method: string; headers: Record<string, string>; body?: string };
}

export interface OutboundAdapter<C> {
  type: string;
  label: string;
  schema: z.ZodType<C>;
  /** Fields masked in the admin API; blank on update means "keep the stored value". */
  secretFields: string[];
  build(msg: Message, config: C): Promise<OutboundRequest> | OutboundRequest;
  /** Throws when the target reports failure (non-2xx or a business error code). */
  check?(res: Response, text: string): void;
  /** Short non-secret description shown in the admin list (e.g. the ntfy topic). */
  summary(config: C): string;
  /** Whether targets of this type need a name. False when the summary already identifies them (ntfy topic). */
  named: boolean;
}

export const SEND_TIMEOUT_MS = 10_000;

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Last few characters of a secret, enough to tell targets apart without revealing it. */
export function tail(secret: string, n = 4): string {
  return secret.length > n ? `…${secret.slice(-n)}` : "";
}

export function jsonRequest(url: string, payload: unknown, headers: Record<string, string> = {}): OutboundRequest {
  return {
    url,
    init: {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", ...headers },
      body: JSON.stringify(payload),
    },
  };
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

export function parseJsonSafe(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
