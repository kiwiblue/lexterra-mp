// Lexterra MP — Cloudflare Worker entry (PartyServer)
// Routes /parties/<party>/<room> to the matching Durable Object, same URLs as PartyKit.

import { routePartykitRequest, getServerByName } from "partyserver";
import { INTERNAL_HEADER, CLIENT_IP_HEADER } from "./compat.js";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };

export { Main } from "./index.js";
export { Lobby } from "./lobby.js";
export { Stats } from "./stats.js";
export { Auth } from "./auth.js";

export default {
  async fetch(request, env) {
    // Everything arriving here is from outside — never let it pose as a server-to-server call,
    // and stamp the real visitor IP (from Cloudflare, not the client) for per-IP limits.
    const ip = request.headers.get("cf-connecting-ip") ?? "";
    request = new Request(request);
    request.headers.delete(INTERNAL_HEADER);
    request.headers.set(CLIENT_IP_HEADER, ip);
    // Burst protection on every write endpoint
    if (request.method === "POST" && ip && env.POST_LIMIT) {
      const { success } = await env.POST_LIMIT.limit({ key: ip });
      if (!success) return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "Content-Type": "application/json", ...CORS } });
    }
    // Dev only: a stand-in push service so the bot tests can verify that turn notifications are
    // produced, signed (VAPID) and encrypted (aes128gcm). Inert in production.
    if (env.ENVIRONMENT === "dev" && new URL(request.url).pathname.startsWith("/__push_sink/")) {
      const stub = await getServerByName(env.Stats, "main");
      const id = new URL(request.url).pathname.split("/")[2] ?? "";
      if (request.method === "POST") {
        const body = await request.arrayBuffer();
        const ok = /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(request.headers.get("authorization") ?? "")
          && request.headers.get("content-encoding") === "aes128gcm" && body.byteLength > 100;
        await stub.fetch(new Request("https://internal/parties/stats/main/", {
          method: "POST", headers: { "Content-Type": "application/json", "x-lexterra-internal": "1" },
          body: JSON.stringify({ type: "push_sink_hit", id, ok }),
        }));
        return new Response(null, { status: ok ? 201 : 400 });
      }
      return stub.fetch(new Request(`https://internal/parties/stats/main/?push_sink=${encodeURIComponent(id)}`, { headers: { "x-lexterra-internal": "1" } }));
    }
    return (await routePartykitRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
};
