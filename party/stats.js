// Lexterra MP — Stats accumulator
// POST { type:"game_end", ... }
// GET ?mode=X → { players: [{uuid,name,best,bestComp}], all: [entry,...] }
// GET (no params) → aggregate report

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
function updatePlayers(players, entry) {
  const comp = isCompetitive(entry);
  const idx = players.findIndex(p => p.uuid === entry.uuid);
  if (idx >= 0) {
    const p = players[idx];
    if (entry.score > p.best.score) { p.best = entry; p.name = entry.name; }
    if (comp && (!p.bestComp || entry.score > p.bestComp.score)) p.bestComp = entry;
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
        const playersKey = `lb_${mode}_players`;
        const allKey = `lb_${mode}_all`;
        let players = (await room.storage.get(playersKey)) ?? [];
        let all = (await room.storage.get(allKey)) ?? [];

        for (const p of msg.players) {
          if (!p.uuid || !(p.score > 0)) continue;
          const entry = {
            uuid: p.uuid,
            name: p.name,
            score: p.score,
            wordsFound: p.wordsFound ?? 0,
            won: p.won ?? false,
            boardSize: msg.boardSize ?? 5,
            minWordLen: msg.minWordLen ?? 3,
            timeLimit: msg.timeLimit ?? 120,
            otherHumans: Math.max(0, (msg.humanCount ?? 1) - 1),
            easyBots: msg.easyBots ?? 0,
            hardBots: msg.hardBots ?? 0,
            date: Date.now(),
          };
          players = updatePlayers(players, entry);
          all = updateAll(all, entry);
        }

        await room.storage.put(playersKey, players);
        await room.storage.put(allKey, all);
      }

      return new Response("ok");
    }

    if (req.method === "GET") {
      const url = new URL(req.url);
      const mode = url.searchParams.get("mode");

      if (mode) {
        const players = (await room.storage.get(`lb_${mode}_players`)) ?? [];
        const all = (await room.storage.get(`lb_${mode}_all`)) ?? [];
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
