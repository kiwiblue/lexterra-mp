// Lexterra MP — PartyKit server
// Each room is one game instance. The server is the source of truth for game state.

/** @type {import("partykit/server").PartyKitServer} */
export default {
  onConnect(conn, room) {
    // Send the current game state to the newly connected player
    conn.send(JSON.stringify({ type: "state", state: room.storage.get("state") ?? null }));
  },

  async onMessage(message, conn, room) {
    const msg = JSON.parse(message);

    switch (msg.type) {

      // Host creates a new game
      case "create": {
        const state = {
          phase: "lobby",       // lobby | playing | ended
          host: conn.id,
          settings: msg.settings, // { boardSize, minWordLen, territoryMode, timeLimit }
          players: {},            // { [connId]: { name, color, score, wordsFound, isReady } }
          grid: null,             // filled when game starts
          territory: null,
          claimed: [],
          cur: null,              // connId of current player
          turnOrder: [],          // [connId, ...]
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

      // Host starts the game
      case "start": {
        const state = await room.storage.get("state");
        if (!state || state.host !== conn.id) return;
        const { boardSize } = state.settings;
        state.phase = "playing";
        state.grid = Array.from({ length: boardSize }, () => Array(boardSize).fill(null));
        state.territory = state.settings.territoryMode !== "off"
          ? Array.from({ length: boardSize }, () => Array(boardSize).fill(null))
          : null;
        state.turnOrder = Object.keys(state.players);
        state.cur = state.turnOrder[0];
        Object.values(state.players).forEach(p => { p.lettersLeft = 1; });
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "state", state }));
        break;
      }

      // A player places a letter
      case "place": {
        const state = await room.storage.get("state");
        if (!state || state.phase !== "playing" || state.cur !== conn.id) return;
        const { r, c, letter } = msg;
        if (state.grid[r][c] !== null) return; // cell already occupied
        state.grid[r][c] = { letter, pi: conn.id };
        state.players[conn.id].lettersLeft--;
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "state", state }));
        break;
      }

      // A player claims a word
      case "claim": {
        const state = await room.storage.get("state");
        if (!state || state.phase !== "playing" || state.cur !== conn.id) return;
        const { word, path, score } = msg;
        // Basic duplicate guard (full validation happens client-side for now)
        if (state.claimed.some(c => c.word === word)) return;
        state.claimed.push({ word, path, connId: conn.id });
        state.players[conn.id].score += score;
        state.players[conn.id].wordsFound++;
        state.players[conn.id].lettersLeft++;
        if (state.territory) {
          path.forEach(({ r, c }) => { state.territory[r][c] = conn.id; });
        }
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "state", state }));
        break;
      }

      // A player passes their turn
      case "pass": {
        const state = await room.storage.get("state");
        if (!state || state.phase !== "playing" || state.cur !== conn.id) return;
        const idx = state.turnOrder.indexOf(conn.id);
        state.cur = state.turnOrder[(idx + 1) % state.turnOrder.length];
        Object.values(state.players).forEach(p => { p.lettersLeft = 1; });
        await room.storage.put("state", state);
        room.broadcast(JSON.stringify({ type: "state", state }));
        break;
      }

    }
  },

  onClose(conn, room) {
    // Notify others that a player disconnected
    room.broadcast(JSON.stringify({ type: "disconnected", connId: conn.id }), [conn.id]);
  },
};
