// Lexterra MP — Stats accumulator
// POST { type:"game_end", outcome, mode, boardSize, minWordLen, botCount, humanCount, players:[{uuid,name,score,wordsFound}] }
// GET  → aggregate report
// GET ?mode=conquest&size=5 → leaderboard array for that combo

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

function updateLeaderboard(lb, entry) {
  const idx = lb.findIndex(e => e.uuid === entry.uuid);
  if (idx >= 0) {
    if (entry.score > lb[idx].score) lb[idx] = entry;
  } else {
    lb.push(entry);
  }
  lb.sort((a, b) => b.score - a.score);
  return lb.slice(0, 10);
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
        const size = msg.boardSize ?? 5;
        const key = `lb_${mode}_${size}`;
        let lb = (await room.storage.get(key)) ?? [];
        for (const p of msg.players) {
          if (!p.uuid || !(p.score > 0)) continue;
          lb = updateLeaderboard(lb, {
            uuid: p.uuid,
            name: p.name,
            score: p.score,
            wordsFound: p.wordsFound ?? 0,
            won: p.won ?? false,
            minWordLen: msg.minWordLen ?? 3,
            timeLimit: msg.timeLimit ?? 120,
            otherHumans: Math.max(0, (msg.humanCount ?? 1) - 1),
            easyBots: msg.easyBots ?? 0,
            hardBots: msg.hardBots ?? 0,
            date: Date.now(),
          });
        }
        await room.storage.put(key, lb);
      }

      return new Response("ok");
    }

    if (req.method === "GET") {
      const url = new URL(req.url);
      const mode = url.searchParams.get("mode");
      const size = url.searchParams.get("size");

      if (mode && size) {
        const lb = (await room.storage.get(`lb_${mode}_${size}`)) ?? [];
        return new Response(JSON.stringify(lb), {
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
