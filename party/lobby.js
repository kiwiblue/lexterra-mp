// Lexterra MP — Public games lobby
// A single shared room that acts as a registry for public games.

import { Server } from "partyserver";
import { makeRoom } from "./compat.js";

const LOBBY_TTL_MS  = 5 * 60 * 1000;   // 5 min for games awaiting players
const PLAYING_TTL_MS = 25 * 60 * 1000; // 25 min for in-progress games (alarm ends them after 20 min)

// Who is on the home/join page is stored on each connection's state, so it
// survives hibernation.
function broadcastCounts(room) {
  let total = 0, inLobby = 0;
  for (const conn of room.getConnections()) {
    total++;
    if (conn.state?.home) inLobby++;
  }
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

// Every visitor stays connected to the lobby, so it hibernates between messages
// to avoid being billed for idle time.
export class Lobby extends Server {
  static options = { hibernate: true };
  room = makeRoom(this);

  async onConnect(conn) {
    const room = this.room;
    const raw = (await room.storage.get("games")) ?? {};
    const games = pruneStale(raw);
    if (Object.keys(games).length !== Object.keys(raw).length) {
      await room.storage.put("games", games);
      room.broadcast(JSON.stringify({ type: "games", games }));
    }
    conn.send(JSON.stringify({ type: "games", games }));
    broadcastCounts(room);
  }

  onClose() {
    broadcastCounts(this.room);
  }

  async onMessage(conn, message) {
    const msg = JSON.parse(message);
    if (msg.type === "hello") {
      conn.setState({ home: msg.location === "home" });
      broadcastCounts(this.room);
      return;
    }
    await applyUpdate(msg, this.room);
  }

  // Called by game rooms (server → lobby)
  async onRequest(req) {
    if (req.method === "POST") await applyUpdate(await req.json(), this.room);
    return new Response("ok");
  }
}
