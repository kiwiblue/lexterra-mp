// Lexterra MP — Stats accumulator
// POST { type:"game_end", ... }
// POST { type:"coins_update", uuid, name, delta, reason } → add/subtract coins (delta may be negative; floored at 0)
// GET ?mode=X → { players: [{uuid,name,best,bestComp}], all: [entry,...] }
// GET ?snapId=X → full game snapshot for the end-screen replay
// GET ?xp=true → XP leaderboard [{ uuid, name, xp, gamesPlayed }] sorted by xp desc
// GET ?coins=UUID → { uuid, name, coins } for one player (coins: 0 if not found)
// GET (no params) → aggregate report

const TOP_SNAPS = 5;

const EMPTY = () => ({
  totalGames: 0,
  completed: 0,
  abandoned: 0,
  modes: {},
  boardSizes: {},
  minWordLens: {},
  totalBots: 0,
  humanOnlyGames: 0,
});

function inc(obj, key) {
  obj[String(key)] = (obj[String(key)] ?? 0) + 1;
}

function isCompetitive(e) {
  return (e.otherHumans ?? 0) > 0 || (e.hardBots ?? 0) > 0;
}

// Per-player best: one entry per UUID, tracking best overall and best competitive separately.
// Name is always updated so a rename is reflected on the next game played.
function updatePlayers(players, entry) {
  const comp = isCompetitive(entry);
  const idx = players.findIndex(p => p.uuid === entry.uuid);
  if (idx >= 0) {
    const p = players[idx];
    p.name = entry.name;
    if (entry.score > p.best.score) {
      p.best = entry;
    } else {
      p.best.name = entry.name;
    }
    if (comp) {
      if (!p.bestComp || entry.score > p.bestComp.score) {
        p.bestComp = entry;
      } else {
        p.bestComp.name = entry.name;
      }
    }
  } else {
    players.push({ uuid: entry.uuid, name: entry.name, best: entry, bestComp: comp ? entry : null });
  }
  players.sort((a, b) => b.best.score - a.best.score);
  return players;
}

// All-time high scores: every game result kept (no dedup), top 100.
function updateAll(all, entry) {
  all.push(entry);
  all.sort((a, b) => b.score - a.score);
  return all.slice(0, 100);
}

const MODE_LABEL = { conquest: "Conquest", exclusive: "Keeps", off: "Search" };

export default {
  async onConnect() {},

  async onRequest(req, room) {
    if (req.method === "POST") {
      const msg = await req.json();
      if (msg.type === "name_update" && msg.uuid && msg.name) {
        for (const mode of ["conquest", "exclusive", "off"]) {
          const playersKey = `lb_${mode}_players`;
          const allKey = `lb_${mode}_all`;
          let players = (await room.storage.get(playersKey)) ?? [];
          let all = (await room.storage.get(allKey)) ?? [];
          const pi = players.findIndex(p => p.uuid === msg.uuid);
          if (pi >= 0) {
            players[pi].name = msg.name;
            if (players[pi].best) players[pi].best.name = msg.name;
            if (players[pi].bestComp) players[pi].bestComp.name = msg.name;
            await room.storage.put(playersKey, players);
          }
          let allChanged = false;
          for (const e of all) { if (e.uuid === msg.uuid) { e.name = msg.name; allChanged = true; } }
          if (allChanged) await room.storage.put(allKey, all);
        }
        // Also update name in XP and coins stores
        let xp = (await room.storage.get("player_xp")) ?? [];
        const xi = xp.findIndex(p => p.uuid === msg.uuid);
        if (xi >= 0) { xp[xi].name = msg.name; await room.storage.put("player_xp", xp); }
        let coins = (await room.storage.get("player_coins")) ?? [];
        const ci = coins.findIndex(p => p.uuid === msg.uuid);
        if (ci >= 0) { coins[ci].name = msg.name; await room.storage.put("player_coins", coins); }
        return new Response("ok");
      }

      if (msg.type === "coins_update" && msg.uuid && typeof msg.delta === "number") {
        let coins = (await room.storage.get("player_coins")) ?? [];
        const ci = coins.findIndex(p => p.uuid === msg.uuid);
        if (ci >= 0) {
          coins[ci].coins = Math.max(0, coins[ci].coins + msg.delta);
          if (msg.name) coins[ci].name = msg.name;
        } else {
          coins.push({ uuid: msg.uuid, name: msg.name ?? "Unknown", coins: Math.max(0, msg.delta) });
        }
        await room.storage.put("player_coins", coins);
        return new Response("ok");
      }

      if (msg.type !== "game_end") return new Response("ok");

      const s = (await room.storage.get("stats")) ?? EMPTY();
      s.totalGames++;
      s[msg.outcome === "completed" ? "completed" : "abandoned"]++;
      inc(s.modes, msg.mode ?? "off");
      inc(s.boardSizes, msg.boardSize ?? 10);
      inc(s.minWordLens, msg.minWordLen ?? 4);
      s.totalBots += msg.botCount ?? 0;
      if ((msg.botCount ?? 0) === 0) s.humanOnlyGames++;
      await room.storage.put("stats", s);

      if (msg.outcome === "completed" && Array.isArray(msg.players)) {
        const mode = msg.mode ?? "off";
        const boardSize = msg.boardSize ?? 5;
        const playersKey = `lb_${mode}_players`;
        const allKey = `lb_${mode}_all`;
        let players = (await room.storage.get(playersKey)) ?? [];
        let all = (await room.storage.get(allKey)) ?? [];
        const gameDate = Date.now();

        // Determine if this game qualifies for a snapshot (top-5 by highest player score)
        let snapId = null;
        if (msg.snapshot) {
          const topScore = msg.players.reduce((m, p) => Math.max(m, p.score ?? 0), 0);
          if (topScore > 0) {
            const snKey = `snaps_${mode}_${boardSize}`;
            let snaps = (await room.storage.get(snKey)) ?? [];
            if (snaps.length < TOP_SNAPS || topScore > snaps[snaps.length - 1].topScore) {
              snapId = `${mode}_${boardSize}_${gameDate}`;
              const isComp = (msg.humanCount ?? 1) > 1 || (msg.hardBots ?? 0) > 0;
              snaps.push({ id: snapId, topScore, isComp, date: gameDate, snapshot: msg.snapshot });
              snaps.sort((a, b) => b.topScore - a.topScore);
              await room.storage.put(snKey, snaps.slice(0, TOP_SNAPS));
            }
          }
        }

        for (const p of msg.players) {
          if (!p.uuid || !(p.score > 0)) continue;
          const entry = {
            uuid: p.uuid,
            name: p.name,
            score: p.score,
            wordsFound: p.wordsFound ?? 0,
            won: p.won ?? false,
            boardSize,
            minWordLen: msg.minWordLen ?? 3,
            timeLimit: msg.timeLimit ?? 120,
            otherHumans: Math.max(0, (msg.humanCount ?? 1) - 1),
            easyBots: msg.easyBots ?? 0,
            hardBots: msg.hardBots ?? 0,
            date: gameDate,
            snapId,
          };
          players = updatePlayers(players, entry);
          all = updateAll(all, entry);
        }

        await room.storage.put(playersKey, players);
        await room.storage.put(allKey, all);

        // Accumulate XP — total points earned across all games, all modes
        let xp = (await room.storage.get("player_xp")) ?? [];
        for (const p of msg.players) {
          if (!p.uuid || !(p.score > 0)) continue;
          const xi = xp.findIndex(e => e.uuid === p.uuid);
          if (xi >= 0) {
            xp[xi].xp += p.score;
            xp[xi].gamesPlayed++;
            xp[xi].name = p.name;
          } else {
            xp.push({ uuid: p.uuid, name: p.name, xp: p.score, gamesPlayed: 1 });
          }
        }
        xp.sort((a, b) => b.xp - a.xp);
        await room.storage.put("player_xp", xp);
      }

      return new Response("ok");
    }

    if (req.method === "GET") {
      const url = new URL(req.url);
      const mode = url.searchParams.get("mode");

      const coinsUuid = url.searchParams.get("coins");
      if (coinsUuid) {
        const coins = (await room.storage.get("player_coins")) ?? [];
        const entry = coins.find(p => p.uuid === coinsUuid);
        return new Response(JSON.stringify(entry ?? { uuid: coinsUuid, coins: 0 }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      if (url.searchParams.get("xp") === "true") {
        const xp = (await room.storage.get("player_xp")) ?? [];
        return new Response(JSON.stringify(xp), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      const snapId = url.searchParams.get("snapId");
      if (snapId) {
        // ID format: "mode_boardSize_timestamp" (e.g. "conquest_5_1719123456789")
        const parts = snapId.split('_');
        const boardSizeStr = parts[parts.length - 2];
        const modePart = parts.slice(0, parts.length - 2).join('_');
        const snKey = `snaps_${modePart}_${boardSizeStr}`;
        const snaps = (await room.storage.get(snKey)) ?? [];
        const snap = snaps.find(s => s.id === snapId);
        if (!snap) return new Response("Not found", { status: 404 });
        return new Response(JSON.stringify(snap.snapshot), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      if (mode) {
        let players = (await room.storage.get(`lb_${mode}_players`)) ?? [];
        let all = (await room.storage.get(`lb_${mode}_all`)) ?? [];
        // One-time migration from old single-list format
        if (!players.length && !all.length) {
          const old = (await room.storage.get(`lb_${mode}`)) ?? [];
          if (old.length) {
            for (const entry of old) {
              players = updatePlayers(players, entry);
              all = updateAll(all, entry);
            }
            await room.storage.put(`lb_${mode}_players`, players);
            await room.storage.put(`lb_${mode}_all`, all);
          }
        }
        return new Response(JSON.stringify({ players, all }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      const s = (await room.storage.get("stats")) ?? EMPTY();
      const total = s.totalGames || 1;
      const pct = n => Math.round((n / total) * 100);

      const fmtMap = (obj) => Object.fromEntries(
        Object.entries(obj)
          .sort(([, a], [, b]) => b - a)
          .map(([k, v]) => [MODE_LABEL[k] ?? k, { count: v, pct: `${pct(v)}%` }])
      );

      const out = {
        totalGames: s.totalGames,
        completed: s.completed,
        abandoned: s.abandoned,
        gameModes: fmtMap(s.modes),
        boardSizes: fmtMap(s.boardSizes),
        minWordLengths: fmtMap(s.minWordLens),
        avgBotsPerGame: s.totalGames > 0
          ? Math.round((s.totalBots / s.totalGames) * 10) / 10
          : 0,
        humanOnlyGames: s.humanOnlyGames,
      };
      return new Response(JSON.stringify(out, null, 2), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    return new Response("Method Not Allowed", { status: 405 });
  },
};
