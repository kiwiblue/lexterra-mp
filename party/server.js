// Lexterra MP — Cloudflare Worker entry (PartyServer)
// Routes /parties/<party>/<room> to the matching Durable Object, same URLs as PartyKit.

import { routePartykitRequest } from "partyserver";
import { INTERNAL_HEADER } from "./compat.js";

export { Main } from "./index.js";
export { Lobby } from "./lobby.js";
export { Stats } from "./stats.js";
export { Auth } from "./auth.js";

export default {
  async fetch(request, env) {
    // Everything arriving here is from outside — never let it pose as a server-to-server call
    if (request.headers.has(INTERNAL_HEADER)) {
      request = new Request(request);
      request.headers.delete(INTERNAL_HEADER);
    }
    return (await routePartykitRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
};
