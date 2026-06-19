// Lexterra MP — PartyKit server
// Each room is one game instance. The server is the source of truth for game state.

// ── Banned claimable words (profanity filter) ────────────────────────
// Add words in lowercase. Keep in sync with public/index.html.
const BANNED_WORDS = new Set([
  "cunt","cunts","fuck","fucked","fucker","fuckers","fucking","fuckings",
  "fuckoff","fuckoffs","fucks","fuckup","fuckups","fuckwit","fuckwits",
  "headfuck","headfucks","mindfuck","mindfucks","motherfucker","motherfuckers",
  "motherfucking","starfucker","starfuckers","starfucking","starfuckings",
]);
function isBannedWord(w) { return BANNED_WORDS.has(w.toLowerCase()); }

async function notifyLobby(room, msg) {
  try {
    await room.context.parties.lobby.get("main").fetch("/", {
      method: "POST",
      body: JSON.stringify(msg),
      headers: { "Content-Type": "application/json" },
    });
  } catch {}
}

async function notifyStats(room, state, outcome) {
  try {
    const all = [
      ...Object.values(state.players),
      ...Object.values(state.disconnectedPlayers ?? {}).map(d => d.player),
    ];
    await room.context.parties.stats.get("main").fetch("/", {
      method: "POST",
      body: JSON.stringify({
        type: "game_end",
        outcome,
        mode: state.settings?.territoryMode ?? "off",
        boardSize: state.settings?.boardSize ?? 10,
        minWordLen: state.settings?.minWordLen ?? 4,
        botCount: all.filter(p => p.isBot).length,
        humanCount: all.filter(p => !p.isBot).length,
      }),
      headers: { "Content-Type": "application/json" },
    });
  } catch {}
}

const INACTIVITY_MS = 20 * 60 * 1000; // 20 minutes of no player action → end game

async function resetAlarm(room) {
  try { await room.storage.setAlarm(Date.now() + INACTIVITY_MS); } catch {}
}

// In-memory spectator tracking (per room instance, resets on DO restart — fine)
const spectatorConns = new Set();

function broadcastSpectatorCount(room) {
  room.broadcast(JSON.stringify({ type: "spectators", count: spectatorConns.size }));
}

// Grace period before processing a disconnect — gives mobile users time to
// reconnect after briefly switching apps without being booted from the game.
const pendingDisconnects = new Map(); // connId → timeoutId
const DISCONNECT_GRACE_MS = 8000;

async function processDisconnect(connId, room) {
  const state = await room.storage.get("state");
  if (!state) return;

  // Host leaving the lobby — send everyone home
  if (state.phase === "lobby" && state.host === connId) {
    if (state.isPublic) await notifyLobby(room, { type: "unregister", roomId: room.id });
    state.phase = "ended";
    await room.storage.put("state", state);
    room.broadcast(JSON.stringify({ type: "host_left" }));
    return;
  }

  const player = state.players[connId];
  if (!player || player.isBot) return;

  if (!state.disconnectedPlayers) state.disconnectedPlayers = {};
  state.disconnectedPlayers[connId] = { player: { ...player }, turnIndex: state.turnOrder.indexOf(connId) };
  delete state.players[connId];

  if (state.phase === "playing") {
    // Reassign host to another human if the host disconnected
    if (state.host === connId) {
      const nextHuman = state.turnOrder.find(id => !state.players[id]?.isBot);
      if (nextHuman) state.host = nextHuman;
    }

    const wasTheirTurn = state.cur === connId;
    state.turnOrder = state.turnOrder.filter(id => id !== connId);
    if (wasTheirTurn) {
      if (state.turnOrder.length === 0) {
        state.phase = "ended";
        await notifyStats(room, state, "abandoned");
      } else {
        const next = state.turnOrder[0];
        state.cur = next;
        Object.values(state.players).forEach(p => { p.lettersLeft = 0; });
        state.players[next].lettersLeft = 1;
      }
    }
    // Don't auto-end when only bots remain — the player may be reloading
  }

  await room.storage.put("state", state);
  room.broadcast(JSON.stringify({ type: "player_left", connId, name: player.name }));
  room.broadcast(JSON.stringify({ type: "state", state }));
}

/** @type {import("partykit/server").PartyKitServer} */
export default {
  async onConnect(conn, room) {
    const state = await room.storage.get("state");
    conn.send(JSON.stringify({ type: "state", state: state ?? null }));
    if (state?.isPublic && state?.phase === "ended") {
      await notifyLobby(room, { type: "unregister", roomId: room.id });
    }
  },

  async onMessage(message, conn, room) {
    const msg = JSON.parse(message);

    switch (msg.type) {

      // Host creates a new game
      case "create": {
        const state = {
          phase: "lobby",       // lobby | playing | ended
          host: conn.id,
          isPublic: msg.isPublic ?? false,
          settings: msg.settings, // { boardSize, minWordLen, territoryMode, timeLimit }
          players: {},            // { [connId]: { name, color, score, wordsFound, isReady } }
          grid: null,             // filled when game starts
          territory: null,
          claimed: [],
          cur: null,              // connId of current player
          turnOrder: [],          // [connId, ...]
          consecutivePasses: 0,
        };
        state.players[conn.id] = { name: msg.name, color: msg.color, score: 0, wordsFound: 0, isReady: false, isHost: true };
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "state", state }));
        break;
      }

      // Player joins an existing lobby
      case "join": {
        const state = await room.storage.get("state");
        if (!state) {
          conn.send(JSON.stringify({ type: "error", message: "Game not available." }));
          return;
        }
        if (state.phase === "playing") {
          // Game already started — redirect to spectator so they can request to join
          spectatorConns.add(conn.id);
          broadcastSpectatorCount(room);
          conn.send(JSON.stringify({ type: "watching" }));
          conn.send(JSON.stringify({ type: "state", state }));
          return;
        }
        if (state.phase !== "lobby") {
          conn.send(JSON.stringify({ type: "error", message: "Game not available." }));
          return;
        }
        const playerEntries = Object.entries(state.players);
        if (playerEntries.length >= 4) {
          // Bump the last bot to make room, or reject if no bots
          const bots = playerEntries.filter(([, p]) => p.isBot);
          if (bots.length === 0) {
            conn.send(JSON.stringify({ type: "error", message: "Game is full (4 players max)." }));
            return;
          }
          delete state.players[bots[bots.length - 1][0]];
        }
        const takenColors = Object.values(state.players).map(p => p.color);
        const available = ["Red","Blue","Pink","Yellow","Green","Grey"].filter(c => !takenColors.includes(c));
        state.players[conn.id] = {
          name: msg.name,
          color: available[0] ?? "Grey",
          score: 0,
          wordsFound: 0,
          isReady: false,
          isHost: false,
        };
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "state", state }));
        break;
      }

      // Player marks themselves ready
      case "ready": {
        const state = await room.storage.get("state");
        if (!state) return;
        if (state.players[conn.id]) state.players[conn.id].isReady = true;
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "state", state }));
        break;
      }

      // Player renames themselves
      case "rename": {
        const state = await room.storage.get("state");
        if (!state || state.phase !== "lobby" || !state.players[conn.id]) return;
        const name = (msg.name || '').trim().toUpperCase().slice(0, 12);
        if (name) state.players[conn.id].name = name;
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "state", state }));
        break;
      }

      // Host adds a bot
      case "add-bot": {
        const state = await room.storage.get("state");
        if (!state || state.host !== conn.id || state.phase !== "lobby") return;
        if (Object.keys(state.players).length >= 4) return;
        const bots = Object.values(state.players).filter(p => p.isBot);
        const botId = `bot_${conn.id}_${bots.length}`;
        const takenColors = Object.values(state.players).map(p => p.color);
        const color = ["Red","Blue","Pink","Yellow","Green","Grey"].find(c => !takenColors.includes(c)) ?? "Grey";
        state.players[botId] = { name: `BOT${bots.length + 1}`, color, score: 0, wordsFound: 0, isReady: true, isHost: false, isBot: true, botDifficulty: "easy" };
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "state", state }));
        break;
      }

      // Host removes a bot
      case "remove-bot": {
        const state = await room.storage.get("state");
        if (!state || state.host !== conn.id || state.phase !== "lobby") return;
        if (state.players[msg.botId]?.isBot) {
          delete state.players[msg.botId];
          await room.storage.put("state", state);
          room.broadcast(JSON.stringify({ type: "state", state }));
        }
        break;
      }

      // Host sets bot difficulty
      case "bot-difficulty": {
        const state = await room.storage.get("state");
        if (!state || state.host !== conn.id || state.phase !== "lobby") return;
        if (state.players[msg.botId]?.isBot) {
          state.players[msg.botId].botDifficulty = msg.difficulty;
          await room.storage.put("state", state);
          room.broadcast(JSON.stringify({ type: "state", state }));
        }
        break;
      }

      // Host updates game settings
      case "settings": {
        const state = await room.storage.get("state");
        if (!state || state.host !== conn.id || state.phase !== "lobby") return;
        state.settings = { ...state.settings, ...msg.settings };
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "state", state }));
        break;
      }

      // Host starts the game
      case "start": {
        const state = await room.storage.get("state");
        if (!state || state.host !== conn.id) return;
        if (Object.keys(state.players).length < 2) return;
        state.lastActivity = Date.now();
        if (state.isPublic) await notifyLobby(room, { type: "update", roomId: room.id, patch: { phase: "playing", lastActivity: state.lastActivity } });
        const { boardSize } = state.settings;
        state.phase = "playing";
        state.grid = Array.from({ length: boardSize }, () => Array(boardSize).fill(null));
        state.territory = state.settings.territoryMode !== "off"
          ? Array.from({ length: boardSize }, () => Array(boardSize).fill(null))
          : null;
        state.turnOrder = Object.keys(state.players).filter(id => !state.players[id].isBot || true);
        state.cur = state.turnOrder[0];
        state.consecutivePasses = 0;
        state.consecutiveHumanPasses = 0;
        // Only the first player gets a letter; everyone else starts at 0
        Object.values(state.players).forEach(p => { p.lettersLeft = 0; });
        state.players[state.cur].lettersLeft = 1;
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "state", state }));
        await resetAlarm(room);
        break;
      }

      // A player places a letter
      case "place": {
        const state = await room.storage.get("state");
        if (!state || state.phase !== "playing") return;
        const placeCurBot = state.players[state.cur]?.isBot;
        if (state.cur !== conn.id && !(placeCurBot && state.host === conn.id)) return;
        const { r, c, letter } = msg;
        if (state.grid[r][c] !== null) return;
        state.grid[r][c] = { letter, pi: state.cur };
        state.players[state.cur].lettersLeft--;
        state.consecutivePasses = 0;
        state.players[state.cur].passesThisRound = 0;
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "state", state }));
        await resetAlarm(room);
        break;
      }

      // A player claims a word
      case "claim": {
        const state = await room.storage.get("state");
        if (!state || state.phase !== "playing") return;
        const claimCurBot = state.players[state.cur]?.isBot;
        if (state.cur !== conn.id && !(claimCurBot && state.host === conn.id)) return;
        const { word, path, score } = msg;
        if (isBannedWord(word)) return;
        if (state.claimed.some(c => {
          const w = word.toLowerCase(), cw = c.word.toLowerCase();
          return w === cw ||
            w === cw + 's' || w === cw + 'es' ||
            (w.endsWith('ies') && cw === w.slice(0,-3) + 'y') ||
            cw === w + 's' || cw === w + 'es' ||
            (cw.endsWith('ies') && w === cw.slice(0,-3) + 'y');
        })) return;
        state.claimed.push({ word, path, connId: state.cur, score });
        state.players[state.cur].score += score;
        state.players[state.cur].wordsFound++;
        state.players[state.cur].lettersLeft++;
        state.consecutivePasses = 0;
        if (!state.players[state.cur]?.isBot) state.consecutiveHumanPasses = 0;
        state.players[state.cur].passesThisRound = 0;
        state.lastActivity = Date.now();
        if (state.isPublic) await notifyLobby(room, { type: "update", roomId: room.id, patch: { lastActivity: state.lastActivity } });
        if (state.territory) {
          path.forEach(({ r, c }) => { state.territory[r][c] = state.cur; });
        }
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "state", state }));
        await resetAlarm(room);
        break;
      }

      // A player passes their turn
      case "pass": {
        const state = await room.storage.get("state");
        if (!state || state.phase !== "playing") return;
        const passCurBot = state.players[state.cur]?.isBot;
        if (state.cur !== conn.id && !(passCurBot && state.host === conn.id)) return;
        state.consecutivePasses++;
        if (!state.players[state.cur]?.isBot) state.consecutiveHumanPasses = (state.consecutiveHumanPasses ?? 0) + 1;
        if (msg.isRealPass !== false) {
          state.players[state.cur].passesThisRound = (state.players[state.cur].passesThisRound ?? 0) + 1;
          state.players[state.cur].totalPasses = (state.players[state.cur].totalPasses ?? 0) + 1;
        }
        const idx = state.turnOrder.indexOf(state.cur);
        const nextId = state.turnOrder[(idx + 1) % state.turnOrder.length];
        state.players[state.cur].lettersLeft = 0;
        state.players[nextId].lettersLeft = 1;
        state.cur = nextId;
        // End game when all players have passed consecutively
        if (state.consecutivePasses >= state.turnOrder.length * 2) {
          state.phase = "ended";
          if (state.isPublic) await notifyLobby(room, { type: "unregister", roomId: room.id });
          await notifyStats(room, state, "completed");
        }
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "state", state }));
        if (state.phase === "playing") await resetAlarm(room);
        break;
      }

      // Reconnecting player reclaims their old slot
      case "rejoin": {
        const state = await room.storage.get("state");
        if (!state) { conn.send(JSON.stringify({ type: "error", message: "Game not found." })); return; }

        // If still within the grace period, player never left — just remap connId
        if (pendingDisconnects.has(msg.oldConnId)) {
          clearTimeout(pendingDisconnects.get(msg.oldConnId));
          pendingDisconnects.delete(msg.oldConnId);
          if (state.players[msg.oldConnId]) {
            state.players[conn.id] = state.players[msg.oldConnId];
            delete state.players[msg.oldConnId];
            if (state.host === msg.oldConnId) state.host = conn.id;
            if (state.cur === msg.oldConnId) state.cur = conn.id;
            const ti = state.turnOrder.indexOf(msg.oldConnId);
            if (ti !== -1) state.turnOrder[ti] = conn.id;
            if (state.territory) for (let r = 0; r < state.territory.length; r++)
              for (let c = 0; c < state.territory[r].length; c++)
                if (state.territory[r][c] === msg.oldConnId) state.territory[r][c] = conn.id;
            for (const claim of state.claimed ?? [])
              if (claim.connId === msg.oldConnId) claim.connId = conn.id;
            if (state.grid) for (let r = 0; r < state.grid.length; r++)
              for (let c = 0; c < state.grid[r].length; c++)
                if (state.grid[r][c]?.pi === msg.oldConnId) state.grid[r][c].pi = conn.id;
            await room.storage.put("state", state);
            room.broadcast(JSON.stringify({ type: "state", state }));
            return;
          }
        }

        const saved = state.disconnectedPlayers?.[msg.oldConnId];
        if (!saved) { conn.send(JSON.stringify({ type: "error", message: "Slot expired — please join normally." })); return; }
        state.players[conn.id] = saved.player;
        delete state.disconnectedPlayers[msg.oldConnId];
        if (state.phase === "playing") {
          const insertAt = Math.min(saved.turnIndex, state.turnOrder.length);
          state.turnOrder.splice(insertAt, 0, conn.id);
        }
        if (state.host === msg.oldConnId) state.host = conn.id;
        if (state.cur === msg.oldConnId) { state.cur = conn.id; }
        if (state.territory) for (let r = 0; r < state.territory.length; r++)
          for (let c = 0; c < state.territory[r].length; c++)
            if (state.territory[r][c] === msg.oldConnId) state.territory[r][c] = conn.id;
        for (const claim of state.claimed ?? [])
          if (claim.connId === msg.oldConnId) claim.connId = conn.id;
        if (state.grid) for (let r = 0; r < state.grid.length; r++)
          for (let c = 0; c < state.grid[r].length; c++)
            if (state.grid[r][c]?.pi === msg.oldConnId) state.grid[r][c].pi = conn.id;
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "state", state }));
        break;
      }

      // Spectator announces themselves
      case "watch": {
        spectatorConns.add(conn.id);
        broadcastSpectatorCount(room);
        break;
      }

      // Spectator requests to join by replacing a bot
      case "join_request": {
        const state = await room.storage.get("state");
        if (!state || state.phase !== "playing") return;
        if (!spectatorConns.has(conn.id)) return;
        const expiresAt = Date.now() + 30000;
        state.pendingJoinRequest = { connId: conn.id, name: msg.name, expiresAt };
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "spectator_request", connId: conn.id, name: msg.name, expiresAt }));
        break;
      }

      // Host approves a spectator — mode:"replace" swaps a bot, mode:"add" inserts as new player
      case "grant_join": {
        const state = await room.storage.get("state");
        if (!state || state.phase !== "playing") return;
        if (state.host !== conn.id) return;
        const { botId, requestConnId, mode } = msg;
        const req = state.pendingJoinRequest;
        if (!req || req.connId !== requestConnId || Date.now() > req.expiresAt) return;

        if (mode === "add") {
          const takenColors = Object.values(state.players).map(p => p.color);
          const color = ["Red","Blue","Pink","Yellow","Green","Grey"].find(c => !takenColors.includes(c)) ?? "Grey";
          state.players[requestConnId] = {
            name: req.name, color, score: 0, wordsFound: 0, lettersLeft: 0, isBot: false, isReady: true,
          };
          state.turnOrder.push(requestConnId);
        } else {
          const bot = state.players[botId];
          if (!bot?.isBot) return;
          state.players[requestConnId] = {
            name: req.name,
            color: bot.color,
            score: bot.score,
            wordsFound: bot.wordsFound,
            lettersLeft: bot.lettersLeft ?? 0,
            isBot: false,
            isReady: true,
          };
          const botIdx = state.turnOrder.indexOf(botId);
          if (botIdx !== -1) state.turnOrder[botIdx] = requestConnId;
          if (state.cur === botId) state.cur = requestConnId;
          delete state.players[botId];
          if (state.territory) for (let r = 0; r < state.territory.length; r++)
            for (let c = 0; c < state.territory[r].length; c++)
              if (state.territory[r][c] === botId) state.territory[r][c] = requestConnId;
          for (const claim of state.claimed ?? [])
            if (claim.connId === botId) claim.connId = requestConnId;
          if (state.grid) for (let r = 0; r < state.grid.length; r++)
            for (let c = 0; c < state.grid[r].length; c++)
              if (state.grid[r][c]?.pi === botId) state.grid[r][c].pi = requestConnId;
        }

        delete state.pendingJoinRequest;
        spectatorConns.delete(requestConnId);
        broadcastSpectatorCount(room);
        await room.storage.put("state", state);
        for (const c of room.getConnections()) {
          if (c.id === requestConnId) { c.send(JSON.stringify({ type: "join_granted" })); break; }
        }
        room.broadcast(JSON.stringify({ type: "state", state }));
        break;
      }

      // Host replaces a departed player with a bot
      case "replace_with_bot": {
        const state = await room.storage.get("state");
        if (!state || state.phase !== "playing") return;
        if (state.host !== conn.id) return;
        const { oldConnId, difficulty } = msg;
        const saved = state.disconnectedPlayers?.[oldConnId];
        if (!saved) return;
        const botId = `bot_${Date.now()}`;
        const botNum = Object.values(state.players).filter(p => p.isBot).length + 1;
        state.players[botId] = {
          ...saved.player,
          name: `BOT${botNum}`,
          isBot: true,
          botDifficulty: difficulty ?? "easy",
          isReady: true,
          lettersLeft: 0,
        };
        const insertAt = Math.min(saved.turnIndex, state.turnOrder.length);
        state.turnOrder.splice(insertAt, 0, botId);
        delete state.disconnectedPlayers[oldConnId];
        if (state.territory) for (let r = 0; r < state.territory.length; r++)
          for (let c = 0; c < state.territory[r].length; c++)
            if (state.territory[r][c] === oldConnId) state.territory[r][c] = botId;
        for (const claim of state.claimed ?? [])
          if (claim.connId === oldConnId) claim.connId = botId;
        if (state.grid) for (let r = 0; r < state.grid.length; r++)
          for (let c = 0; c < state.grid[r].length; c++)
            if (state.grid[r][c]?.pi === oldConnId) state.grid[r][c].pi = botId;
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "state", state }));
        break;
      }

      // Player intentionally leaves the settings lobby (Return to Lobby button before game starts)
      case "leave_lobby": {
        const state = await room.storage.get("state");
        if (!state || state.phase !== "lobby") return;
        if (pendingDisconnects.has(conn.id)) {
          clearTimeout(pendingDisconnects.get(conn.id));
          pendingDisconnects.delete(conn.id);
        }
        if (state.host === conn.id) {
          if (state.isPublic) await notifyLobby(room, { type: "unregister", roomId: room.id });
          state.phase = "ended";
          await room.storage.put("state", state);
          room.broadcast(JSON.stringify({ type: "host_left" }));
        } else {
          const player = state.players[conn.id];
          if (!player || player.isBot) return;
          delete state.players[conn.id];
          await room.storage.put("state", state);
          room.broadcast(JSON.stringify({ type: "state", state }));
        }
        break;
      }

      // Player intentionally leaves the game (Return to Lobby button)
      case "leave_game": {
        const state = await room.storage.get("state");
        if (!state || state.phase !== "playing") return;
        const player = state.players[conn.id];
        if (!player || player.isBot) return;
        // Save slot so host can still replace with a bot if other humans remain
        if (!state.disconnectedPlayers) state.disconnectedPlayers = {};
        state.disconnectedPlayers[conn.id] = { player: { ...player }, turnIndex: state.turnOrder.indexOf(conn.id) };
        delete state.players[conn.id];
        const wasTheirTurn = state.cur === conn.id;
        state.turnOrder = state.turnOrder.filter(id => id !== conn.id);
        if (wasTheirTurn) {
          if (state.turnOrder.length === 0) {
            state.phase = "ended";
          } else {
            const next = state.turnOrder[0];
            state.cur = next;
            Object.values(state.players).forEach(p => { p.lettersLeft = 0; });
            state.players[next].lettersLeft = 1;
          }
        }
        // End game if only bots remain — no one left to drive them
        if (state.phase === "playing" && !Object.values(state.players).some(p => !p.isBot)) {
          state.phase = "ended";
          if (state.isPublic) await notifyLobby(room, { type: "unregister", roomId: room.id });
          await notifyStats(room, state, "abandoned");
        }
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "player_left", connId: conn.id, name: player.name }), [conn.id]);
        room.broadcast(JSON.stringify({ type: "state", state }), [conn.id]);
        break;
      }

      // Player hover position — relay to everyone else without touching state
      case "hover": {
        room.broadcast(JSON.stringify({ type: "hover", connId: conn.id, r: msg.r, c: msg.c }), [conn.id]);
        break;
      }

      // Host resets the game back to lobby with same players + settings
      case "reset": {
        const state = await room.storage.get("state");
        if (!state || state.host !== conn.id) return;
        if (!["ended", "playing"].includes(state.phase)) return;
        const fresh = {
          ...state,
          phase: "lobby",
          grid: null,
          territory: null,
          claimed: [],
          cur: null,
          turnOrder: [],
          consecutivePasses: 0,
          consecutiveHumanPasses: 0,
        };
        Object.keys(fresh.players).forEach(id => {
          fresh.players[id].score = 0;
          fresh.players[id].wordsFound = 0;
          fresh.players[id].lettersLeft = 0;
          fresh.players[id].isReady = false;
          fresh.players[id].passesThisRound = 0;
          fresh.players[id].totalPasses = 0;
        });
        await room.storage.put("state", fresh);
        // Spectators can't follow a reset back to settings — send them home
        for (const c of room.getConnections()) {
          if (spectatorConns.has(c.id)) {
            spectatorConns.delete(c.id);
            c.send(JSON.stringify({ type: "host_left" }));
          }
        }
        broadcastSpectatorCount(room);
        room.broadcast(JSON.stringify({ type: "state", state: fresh }));
        if (fresh.isPublic) {
          const freshPlayers = Object.values(fresh.players);
          await notifyLobby(room, { type: "update", roomId: room.id, patch: {
            phase: "lobby",
            playerCount: freshPlayers.length,
            humanCount: freshPlayers.filter(p => !p.isBot).length,
            botCount: freshPlayers.filter(p => p.isBot).length,
          }});
        }
        break;
      }

    }
  },

  async onClose(conn, room) {
    // Spectators: handle immediately, no grace period needed
    if (spectatorConns.has(conn.id)) {
      spectatorConns.delete(conn.id);
      const state = await room.storage.get("state");
      if (state?.pendingJoinRequest?.connId === conn.id) {
        delete state.pendingJoinRequest;
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "request_cancelled" }));
      }
      if (state?.phase === "playing" && !Object.values(state.players ?? {}).some(p => !p.isBot)) {
        state.phase = "ended";
        if (state.isPublic) await notifyLobby(room, { type: "unregister", roomId: room.id });
        await notifyStats(room, state, "abandoned");
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "state", state }));
      }
      broadcastSpectatorCount(room);
      return;
    }

    // Players: grace period — mobile users briefly switching apps won't be booted
    const tid = setTimeout(async () => {
      pendingDisconnects.delete(conn.id);
      await processDisconnect(conn.id, room);
    }, DISCONNECT_GRACE_MS);
    pendingDisconnects.set(conn.id, tid);
  },

  async onAlarm(room) {
    const state = await room.storage.get("state");
    if (!state || state.phase !== "playing") return;
    state.phase = "ended";
    if (state.isPublic) await notifyLobby(room, { type: "unregister", roomId: room.id });
    await notifyStats(room, state, "abandoned");
    await room.storage.put("state", state);
    room.broadcast(JSON.stringify({ type: "state", state }));
  },
};
