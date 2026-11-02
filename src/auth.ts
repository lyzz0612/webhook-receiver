import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { base64url, hmacSha256, safeEqual } from "./crypto";

export const SESSION_COOKIE = "wr_session";
const SESSION_TTL_SECONDS = 7 * 24 * 3600;

export type AppEnv = { Bindings: Env };

function sessionKey(env: Env): string {
  // Derived from the password when SESSION_SECRET is unset, so changing the password logs everyone out.
  return env.SESSION_SECRET || `session:${env.ADMIN_PASSWORD}`;
}

async function sign(env: Env, payload: string): Promise<string> {
  return base64url(await hmacSha256(sessionKey(env), payload));
}

export async function createSession(env: Env, now = Date.now()): Promise<string> {
  const exp = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const payload = `v1.${exp}`;
  return `${payload}.${await sign(env, payload)}`;
}

export async function verifySession(env: Env, value: string | undefined, now = Date.now()): Promise<boolean> {
  if (!value || !env.ADMIN_PASSWORD) return false;
  const i = value.lastIndexOf(".");
  if (i < 0) return false;
  const payload = value.slice(0, i);
  const [version, exp] = payload.split(".");
  if (version !== "v1" || !(Number(exp) > now / 1000)) return false;
  return safeEqual(value.slice(i + 1), await sign(env, payload));
}

export async function checkPassword(env: Env, password: unknown): Promise<boolean> {
  if (!env.ADMIN_PASSWORD || typeof password !== "string") return false;
  return safeEqual(password, env.ADMIN_PASSWORD);
}

export function setSessionCookie(c: Context<AppEnv>, value: string): void {
  setCookie(c, SESSION_COOKIE, value, {
    path: "/admin",
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Strict",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/admin" });
}

/** Rejects cross-site writes: browsers always send Origin on POST/PUT/DELETE fetches. */
export const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: "cross-origin request" }, 403);
  }
  await next();
};

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!(await verifySession(c.env, getCookie(c, SESSION_COOKIE)))) return c.json({ error: "unauthorized" }, 401);
  await next();
};
