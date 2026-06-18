// Lexterra MP — Public games lobby
// A single shared room that acts as a registry for public games.

const LOBBY_TTL_MS  = 5 * 60 * 1000;   // 5 min for games awaiting players
const PLAYING_TTL_MS = 25 * 60 * 1000; // 25 min for in-progress games (alarm ends them after 20 min)

// In-memory set of connection IDs that are on the home/join page.
// Resets on Durable Object restart (fine — connections are lost too).
const homeConnections = new Set();

function broadcastCounts(room) {
  const total = [...room.getConnections()].length;
  const inLobby = homeConnections.size;
  room.broadcast(JSON.stringify({ type: "online", total, inLobby }));
}

function pruneStale(games) {
  const now = Date.now();
  const pruned = {};
  for (const [id, g] of Object.entries(games)) {
    const ttl = g.phase === 'playing' ? PLAYING_TTL_MS : LOBBY_TTL_MS;
    if (!g.lastActivity || (now - g.lastActivity) < ttl) {
      pruned[id] = g;
    }
  }
  return pruned;
}

async function applyUpdate(msg, room) {
  const raw = (await room.storage.get("games")) ?? {};
  const games = pruneStale(raw);
  if (msg.type === "register") {
    games[msg.roomId] = {
      roomId: msg.roomId,
      hostName: msg.hostName,
      playerCount: msg.playerCount,
      humanCount: msg.humanCount,
      botCount: msg.botCount,
      lastActivity: msg.lastActivity ?? Date.now(),
      settings: msg.settings,
    };
  } else if (msg.type === "unregister") {
    delete games[msg.roomId];
  } else if (msg.type === "update") {
    if (games[msg.roomId]) Object.assign(games[msg.roomId], msg.patch);
  } else {
    return;
  }
  await room.storage.put("games", games);
  room.broadcast(JSON.stringify({ type: "games", games }));
}

export default {
  async onConnect(conn, room) {
    const raw = (await room.storage.get("games")) ?? {};
    const games = pruneStale(raw);
    if (Object.keys(games).length !== Object.keys(raw).length) {
      await room.storage.put("games", games);
      room.broadcast(JSON.stringify({ type: "games", games }));
    }
    conn.send(JSON.stringify({ type: "games", games }));
    broadcastCounts(room);
  },
  async onClose(conn, room) {
    homeConnections.delete(conn.id);
    broadcastCounts(room);
  },
  async onMessage(message, conn, room) {
    const msg = JSON.parse(message);
    if (msg.type === "hello") {
      if (msg.location === "home") homeConnections.add(conn.id);
      broadcastCounts(room);
      return;
    }
    await applyUpdate(msg, room);
  },
  // Called by the main party via inter-party HTTP (server → lobby)
  async onRequest(req, room) {
    if (req.method === "POST") await applyUpdate(await req.json(), room);
    return new Response("ok");
  },
};
