// Lexterra MP — Public games lobby
// A single shared room that acts as a registry for public games.

async function applyUpdate(msg, room) {
  const games = (await room.storage.get("games")) ?? {};
  if (msg.type === "register") {
    games[msg.roomId] = {
      roomId: msg.roomId,
      hostName: msg.hostName,
      playerCount: msg.playerCount,
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
    const games = (await room.storage.get("games")) ?? {};
    conn.send(JSON.stringify({ type: "games", games }));
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
