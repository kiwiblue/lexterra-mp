// Lexterra MP — PartyKit server
// Each room is one game instance. The server is the source of truth for game state.

async function notifyLobby(room, msg) {
  try {
    await room.context.parties.lobby.get("main").fetch("/", {
      method: "POST",
      body: JSON.stringify(msg),
      headers: { "Content-Type": "application/json" },
    });
  } catch {}
}

/** @type {import("partykit/server").PartyKitServer} */
export default {
  async onConnect(conn, room) {
    const state = await room.storage.get("state");
    conn.send(JSON.stringify({ type: "state", state: state ?? null }));
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
        if (!state || state.phase !== "lobby") {
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
        if (state.isPublic) await notifyLobby(room, { type: "update", roomId: room.id, patch: { phase: "playing" } });
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
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "state", state }));
        break;
      }

      // A player claims a word
      case "claim": {
        const state = await room.storage.get("state");
        if (!state || state.phase !== "playing") return;
        const claimCurBot = state.players[state.cur]?.isBot;
        if (state.cur !== conn.id && !(claimCurBot && state.host === conn.id)) return;
        const { word, path, score } = msg;
        if (state.claimed.some(c => c.word === word)) return;
        state.claimed.push({ word, path, connId: state.cur, score });
        state.players[state.cur].score += score;
        state.players[state.cur].wordsFound++;
        state.players[state.cur].lettersLeft++;
        state.consecutivePasses = 0;
        if (!state.players[state.cur]?.isBot) state.consecutiveHumanPasses = 0;
        if (state.territory) {
          path.forEach(({ r, c }) => { state.territory[r][c] = state.cur; });
        }
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "state", state }));
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
        const idx = state.turnOrder.indexOf(state.cur);
        const nextId = state.turnOrder[(idx + 1) % state.turnOrder.length];
        state.players[state.cur].lettersLeft = 0;
        state.players[nextId].lettersLeft = 1;
        state.cur = nextId;
        // End game when all players have passed consecutively
        if (state.consecutivePasses >= state.turnOrder.length * 2) {
          state.phase = "ended";
          if (state.isPublic) await notifyLobby(room, { type: "unregister", roomId: room.id });
        }
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "state", state }));
        break;
      }

      // Reconnecting player reclaims their old slot
      case "rejoin": {
        const state = await room.storage.get("state");
        if (!state) { conn.send(JSON.stringify({ type: "error", message: "Game not found." })); return; }
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
        });
        await room.storage.put("state", fresh);
        room.broadcast(JSON.stringify({ type: "state", state: fresh }));
        if (fresh.isPublic) {
          await notifyLobby(room, { type: "update", roomId: room.id, patch: { phase: "lobby", playerCount: Object.keys(fresh.players).length } });
        }
        break;
      }

    }
  },

  async onClose(conn, room) {
    const state = await room.storage.get("state");
    if (!state) return;
    if (state.isPublic && state.phase === "lobby" && state.host === conn.id) {
      await notifyLobby(room, { type: "unregister", roomId: room.id });
    }
    const player = state.players[conn.id];
    if (player && !player.isBot) {
      // Preserve slot so player can rejoin after refresh
      if (!state.disconnectedPlayers) state.disconnectedPlayers = {};
      state.disconnectedPlayers[conn.id] = { player: { ...player }, turnIndex: state.turnOrder.indexOf(conn.id) };
      delete state.players[conn.id];
      if (state.phase === "playing") {
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
        const humanCount = state.turnOrder.filter(id => !state.players[id]?.isBot).length;
        if (humanCount === 0) state.phase = "ended";
      }
      await room.storage.put("state", state);
      room.broadcast(JSON.stringify({ type: "player_left", connId: conn.id, name: player.name }), [conn.id]);
      room.broadcast(JSON.stringify({ type: "state", state }), [conn.id]);
    }
  },
};
