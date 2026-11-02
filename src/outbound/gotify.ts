import { z } from "zod";
import type { Level } from "../message";
import { joinUrl, jsonRequest, type OutboundAdapter } from "./types";

const schema = z.object({
  server: z.url(),
  app_token: z.string().min(1, "app_token 不能为空"),
});

export type GotifyConfig = z.infer<typeof schema>;

const PRIORITY: Record<Level, number> = { info: 5, warn: 7, critical: 10 };

export const gotifyOut: OutboundAdapter<GotifyConfig> = {
  type: "gotify",
  label: "Gotify",
  schema,
  secretFields: ["app_token"],
  build(msg, c) {
    const extras: Record<string, unknown> = {};
    if (msg.markdown) extras["client::display"] = { contentType: "text/markdown" };
    if (msg.url) extras["client::notification"] = { click: { url: msg.url } };
    return jsonRequest(
      joinUrl(c.server, "message"),
      {
        title: msg.title,
        message: msg.body,
        priority: PRIORITY[msg.level ?? "info"],
        extras: Object.keys(extras).length ? extras : undefined,
      },
      { "x-gotify-key": c.app_token },
    );
  },
};
