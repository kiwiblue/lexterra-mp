// Lexterra MP — PartyKit → PartyServer compatibility layer
// The game handlers were written against PartyKit's `room` object. This builds an
// equivalent `room` for a PartyServer instance so the handler logic stays unchanged.

import { getServerByName } from "partyserver";

// Party name (as used in URLs, e.g. /parties/stats/main) → Durable Object binding name
const BINDINGS = { main: "Main", lobby: "Lobby", stats: "Stats", auth: "Auth" };

export function makeRoom(server) {
  return {
    get id() { return server.name; },
    storage: server.ctx.storage,
    env: server.env,
    broadcast: (msg, without) => server.broadcast(msg, without),
    getConnections: () => server.getConnections(),
    // Party-to-party calls: room.context.parties.<party>.get(<room>).fetch(path, init)
    context: {
      parties: new Proxy({}, {
        get: (_, party) => ({
          get: (name) => ({
            fetch: async (path, init) => {
              const stub = await getServerByName(server.env[BINDINGS[party]], name);
              return stub.fetch(new Request(`https://internal/parties/${party}/${name}${path}`, init));
            },
          }),
        }),
      }),
    },
  };
}
