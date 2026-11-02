const encoder = new TextEncoder();

function sha256(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(s));
}

/** Constant-time string comparison; hashing first makes both inputs the same length. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

export function base64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64url(buf: ArrayBuffer | Uint8Array): string {
  return base64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** UTF-8 safe base64 of a string (btoa only accepts Latin-1). */
export function base64Utf8(s: string): string {
  return base64(encoder.encode(s));
}

export function randomToken(bytes = 24): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function hmacSha256(key: string, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return crypto.subtle.sign("HMAC", k, encoder.encode(data));
}
