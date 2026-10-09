// Lexterra MP — Cloudflare Worker entry (PartyServer)
// Routes /parties/<party>/<room> to the matching Durable Object, same URLs as PartyKit.

import { routePartykitRequest } from "partyserver";

export { Main } from "./index.js";
export { Lobby } from "./lobby.js";
export { Stats } from "./stats.js";
export { Auth } from "./auth.js";

export default {
  async fetch(request, env) {
    return (await routePartykitRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
};
