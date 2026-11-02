import { Hono } from "hono";
import { adminApi } from "./admin/api";
import type { AppEnv } from "./auth";
import { handleWebhook } from "./webhook";

const app = new Hono<AppEnv>();

// Static assets (public/) are served before the Worker runs, so /admin/ resolves to public/admin/index.html.
app.route("/admin/api", adminApi);
app.get("/", (c) => c.redirect("/admin/"));
app.get("/admin", (c) => c.redirect("/admin/"));
app.all("/admin/*", (c) => c.json({ error: "not found" }, 404));
app.all("*", (c) => handleWebhook(c.req.raw, c.env));

app.onError((e, c) => {
  console.error(e);
  return c.json({ ok: false, error: "internal error" }, 500);
});

export default app;
