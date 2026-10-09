// Lexterra MP — Public games lobby
// A single shared room that acts as a registry for public games.

import { Server } from "partyserver";
import { makeRoom, isInternal } from "./compat.js";

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

// Browsers can't be trusted to describe a room, so for client-originated updates the lobby
// asks the game room itself and stores that answer. Server-originated updates are trusted.
async function fetchRoomInfo(roomId, room) {
  if (typeof roomId !== "string" || !/^[A-Z0-9]{4,8}$/.test(roomId)) return null;
  try {
    const res = await room.context.parties.main.get(roomId).fetch("/?lobbyinfo=1");
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

async function applyUpdate(msg, room, trusted) {
  if (!msg || typeof msg !== "object") return;
  const raw = (await room.storage.get("games")) ?? {};
  const games = pruneStale(raw);
  if (!trusted) {
    if (!["register", "update", "unregister"].includes(msg.type)) return;
    const info = await fetchRoomInfo(msg.roomId, room);
    if (!info || !info.isPublic || info.phase === "ended") {
      if (!(msg.roomId in games)) return;
      delete games[msg.roomId];
    } else {
      games[msg.roomId] = {
        roomId: msg.roomId, hostName: info.hostName, playerCount: info.playerCount, humanCount: info.humanCount,
        botCount: info.botCount, settings: info.settings, phase: info.phase, lastActivity: Date.now(),
      };
    }
    await room.storage.put("games", games);
    room.broadcast(JSON.stringify({ type: "games", games }));
    return;
  }
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
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "hello") {
      conn.setState({ home: msg.location === "home" });
      broadcastCounts(this.room);
      return;
    }
    await applyUpdate(msg, this.room, false);
  }

  // Called by game rooms only (server → lobby); browser messages are verified against the room
  async onRequest(req) {
    if (!isInternal(req)) return new Response("Forbidden", { status: 403 });
    if (req.method === "POST") {
      let msg;
      try { msg = await req.json(); } catch { return new Response("Bad request", { status: 400 }); }
      await applyUpdate(msg, this.room, true);
    }
    return new Response("ok");
  }
}
