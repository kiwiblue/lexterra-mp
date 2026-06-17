// Lexterra MP — Public games lobby
// A single shared room that acts as a registry for public games.

const ONE_HOUR_MS = 3600000;

function pruneStale(games) {
  const now = Date.now();
  const pruned = {};
  for (const [id, g] of Object.entries(games)) {
    if (!g.lastActivity || (now - g.lastActivity) < ONE_HOUR_MS) {
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
    const count = [...room.getConnections()].length;
    room.broadcast(JSON.stringify({ type: "online", count }));
  },
  async onClose(conn, room) {
    const count = [...room.getConnections()].length;
    room.broadcast(JSON.stringify({ type: "online", count }));
  },
  async onMessage(message, conn, room) {
    await applyUpdate(JSON.parse(message), room);
  },
  // Called by the main party via inter-party HTTP (server → lobby)
  async onRequest(req, room) {
    if (req.method === "POST") await applyUpdate(await req.json(), room);
    return new Response("ok");
  },
};
