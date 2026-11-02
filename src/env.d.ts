// Secrets are not part of wrangler.jsonc, so `wrangler types` can't see them.
interface Secrets {
  ADMIN_PASSWORD: string;
  SESSION_SECRET?: string;
}

interface Env extends Secrets {}

declare namespace Cloudflare {
  interface Env extends Secrets {}
}
