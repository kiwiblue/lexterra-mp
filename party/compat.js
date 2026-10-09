// Lexterra MP — PartyKit → PartyServer compatibility layer
// The game handlers were written against PartyKit's `room` object. This builds an
// equivalent `room` for a PartyServer instance so the handler logic stays unchanged.

import { getServerByName } from "partyserver";

// Party name (as used in URLs, e.g. /parties/stats/main) → Durable Object binding name
const BINDINGS = { main: "Main", lobby: "Lobby", stats: "Stats", auth: "Auth" };

// Marks server-to-server calls. These go Durable Object → Durable Object and never pass
// through the Worker entry, which strips this header from every outside request — so a
// request carrying it can only have come from our own code.
export const INTERNAL_HEADER = "x-lexterra-internal";
export const isInternal = (req) => req.headers.get(INTERNAL_HEADER) === "1";

// Player names are rendered into HTML by every client, so strip anything that could
// break out of text or attribute context. Emoji and other unicode are fine.
export function cleanName(raw, fallback = "PLAYER") {
  if (typeof raw !== "string") return fallback;
  const name = raw.replace(/[<>"'`\\\x00-\x1f\x7f]/g, "").trim().toUpperCase().slice(0, 15);
  return name || fallback;
}

// A player's UUID is effectively their account credential (coins, name, email link),
// so it must never reach other players. Returns a copy of game state safe to broadcast.
export function publicState(state) {
  if (!state) return state;
  const strip = (p) => { if (!p) return p; const { uuid, ...rest } = p; return rest; };
  return {
    ...state,
    players: Object.fromEntries(Object.entries(state.players ?? {}).map(([id, p]) => [id, strip(p)])),
    disconnectedPlayers: state.disconnectedPlayers
      ? Object.fromEntries(Object.entries(state.disconnectedPlayers).map(([id, d]) => [id, { ...d, player: strip(d.player) }]))
      : state.disconnectedPlayers,
    pendingJoinRequest: strip(state.pendingJoinRequest),
  };
}

export const isUuid = (v) => typeof v === "string" && /^[A-Za-z0-9-]{8,64}$/.test(v);

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
              const req = new Request(`https://internal/parties/${party}/${name}${path}`, init);
              req.headers.set(INTERNAL_HEADER, "1");
              return stub.fetch(req);
            },
          }),
        }),
      }),
    },
  };
}
