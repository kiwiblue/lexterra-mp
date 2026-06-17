// Lexterra MP — Stats accumulator
// POST { type:"game_end", outcome:"completed"|"abandoned", mode, boardSize, minWordLen, botCount, humanCount }
// GET  → JSON report with totals and percentages

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
      return new Response("ok");
    }

    if (req.method === "GET") {
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
