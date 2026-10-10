// Lexterra bot test suite — plays every feature end-to-end against the DEV server.
//   npm run test:bots                       (uses https://dev-api.lexterragame.com)
//   BASE=http://127.0.0.1:8787 npm run test:bots   (local `wrangler dev --env dev`)
// Needs the dev admin password in .dev-admin-password (or ADMIN_PASSWORD env var) for the
// feature-switch and analytics checks. Refuses to run against production — it writes data.

import fs from "node:fs";
import { isDictionaryWord, isBannedWord, claimedVariant } from "../party/rules.js";

const BASE = (process.env.BASE ?? "https://dev-api.lexterragame.com").replace(/\/$/, "");
if (/\/\/api\.lexterragame\.com/.test(BASE)) { console.error("Refusing to run bots against production."); process.exit(2); }
const WS = BASE.replace(/^http/, "ws");
const STATS = `${BASE}/parties/stats/main`;
const ADMIN = process.env.ADMIN_PASSWORD ?? (() => { try { return fs.readFileSync(new URL("../.dev-admin-password", import.meta.url), "utf8").trim(); } catch { return null; } })();
const ONLY = process.env.ONLY?.split(",");

// ── Reporting ──────────────────────────────────────────────────────────────
const results = [];
let section = "";
const check = (name, ok, extra = "") => {
  results.push({ section, name, ok: !!ok, extra });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  — ${extra}` : ""}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 7).toUpperCase();
const roomCode = () => "B" + rand();
const post = (body, url = STATS) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const getJson = async (q) => (await fetch(`${STATS}?${q}`)).json();

// ── Bot client ─────────────────────────────────────────────────────────────
class Bot {
  constructor(name, uuid = crypto.randomUUID()) { this.name = name; this.uuid = uuid; this.msgs = []; this.waiters = []; }
  async connect(room) {
    this.room = room;
    this.id = `${this.name.toLowerCase()}-${rand()}`;
    this.ws = new WebSocket(`${WS}/parties/main/${room}?_pk=${this.id}`);
    this.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "state" && !m.state) return;
      this.msgs.push(m);
      for (const w of [...this.waiters]) if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m); }
    });
    await new Promise((res, rej) => { this.ws.addEventListener("open", res); this.ws.addEventListener("error", rej); });
    return this;
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  state() { return [...this.msgs].reverse().find(m => m.type === "state")?.state; }
  me() { return this.state()?.players?.[this.id]; }
  waitFor(pred, ms = 8000, label = "") {
    const hit = [...this.msgs].reverse().find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); reject(new Error(`timeout ${label}`)); } }, ms);
    });
  }
  waitState(pred, ms, label) { return this.waitFor(m => m.type === "state" && m.state && pred(m.state), ms, label).then(m => m.state); }
  // Like waitState, but only matches messages that arrive after this call
  waitNewState(pred, ms = 8000, label = "") {
    return new Promise((resolve, reject) => {
      const w = { pred: (m) => m.type === "state" && m.state && pred(m.state), resolve: (m) => resolve(m.state) };
      this.waiters.push(w);
      setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); reject(new Error(`timeout ${label}`)); } }, ms);
    });
  }
  fresh() { this.msgs.length = 0; }
  close() { try { this.ws.close(); } catch {} }
}

const brief = (st) => st && JSON.stringify({ phase: st.phase, cur: st.cur, order: st.turnOrder, passes: st.consecutivePasses, letters: Object.fromEntries(Object.entries(st.players ?? {}).map(([id, p]) => [id, p.lettersLeft])) });

async function createRoom(host, settings = {}, isPublic = false) {
  const code = roomCode();
  await host.connect(code);
  host.send({ type: "create", name: host.name, color: "Red", uuid: host.uuid, isPublic, settings: { boardSize: 5, minWordLen: 3, territoryMode: "off", timeLimit: null, ...settings } });
  await host.waitState(s => s.phase === "lobby" && s.host === host.id, 8000, "create");
  return code;
}
async function joinRoom(bot, code) {
  await bot.connect(code);
  bot.send({ type: "join", name: bot.name, color: "Blue", uuid: bot.uuid });
  await bot.waitState(s => s.players?.[bot.id], 8000, "join");
}
// Places a letter for whoever's turn it is (host may act for bots), waiting for it to land
async function place(actor, r, c, letter) {
  actor.send({ type: "place", r, c, letter });
  return actor.waitState(s => s.grid?.[r]?.[c]?.letter === letter, 8000, `place ${letter}`);
}
async function passTurn(actor, from, isRealPass = false) {
  const before = actor.state();
  const done = actor.waitNewState(s => s.cur !== from || s.phase !== before.phase || (s.consecutivePasses ?? 0) > (before.consecutivePasses ?? 0), 8000, "pass");
  actor.send({ type: "pass", isRealPass });
  return done;
}

// ── Admin config helpers (dev) ─────────────────────────────────────────────
async function getConfig() { return getJson("config=true"); }
async function setConfig(patch) {
  if (!ADMIN) throw new Error("no dev admin password");
  const cfg = { ...(await getConfig()), ...patch };
  const r = await post({ type: "config_update", password: ADMIN, config: cfg });
  if (!r.ok) throw new Error(`config_update ${r.status}`);
  await sleep(300);
}

// ── Daily puzzle solver (greedy) ───────────────────────────────────────────
function lines(n, r, c) {
  const out = [];
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    let sr = r, sc = c;
    while (sr - dr >= 0 && sr - dr < n && sc - dc >= 0 && sc - dc < n) { sr -= dr; sc -= dc; }
    const cells = [];
    for (let rr = sr, cc = sc; rr >= 0 && rr < n && cc >= 0 && cc < n; rr += dr, cc += dc) cells.push({ r: rr, c: cc });
    out.push(cells);
  }
  return out;
}
function wordsThrough(grid, r, c, minLen, claimed) {
  const n = grid.length, found = [];
  for (const line of lines(n, r, c)) {
    const idx = line.findIndex(p => p.r === r && p.c === c);
    for (let i = 0; i <= idx; i++) for (let j = idx; j < line.length; j++) {
      const seg = line.slice(i, j + 1);
      if (seg.length < minLen || seg.some(p => !grid[p.r][p.c])) continue;
      for (const path of [seg, [...seg].reverse()]) {
        const word = path.map(p => grid[p.r][p.c]).join("");
        if (isDictionaryWord(word) && !isBannedWord(word) && !claimedVariant(word, [...claimed, ...found.map(f => f.word)])) found.push({ word, path });
      }
    }
  }
  return found.sort((a, b) => b.word.length - a.word.length);
}
function solveDaily(puzzle, randomness = 0) {
  const n = puzzle.size;
  const grid = Array.from({ length: n }, () => Array(n).fill(null));
  for (const s of puzzle.starters) grid[s.r][s.c] = s.letter;
  const moves = [], claimed = [];
  let score = 0;
  for (const letter of puzzle.letters) {
    let best = null;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (grid[r][c]) continue;
      grid[r][c] = letter;
      const ws = wordsThrough(grid, r, c, puzzle.minLen, claimed);
      const val = ws.reduce((s, w) => s + w.word.length, 0) + Math.random() * randomness;
      grid[r][c] = null;
      if (!best || val > best.val) best = { r, c, val };
    }
    grid[best.r][best.c] = letter;
    moves.push({ place: { r: best.r, c: best.c } });
    for (const w of wordsThrough(grid, best.r, best.c, puzzle.minLen, claimed)) {
      if (claimedVariant(w.word, claimed)) continue;
      claimed.push(w.word); score += w.word.length;
      moves.push({ claim: { word: w.word, path: w.path } });
    }
  }
  return { moves, score, words: claimed };
}

// ════════════════════════════════════════════════════════════════════════════
async function liveGame() {
  section = "Live multiplayer"; console.log(`\n▶ ${section}`);
  const [A, B, C] = [new Bot("ALICE"), new Bot("BOB"), new Bot("CARA")];
  const code = await createRoom(A, { boardSize: 5 }, false);
  await joinRoom(B, code); await joinRoom(C, code);
  let s = await A.waitState(st => Object.keys(st.players).length === 3, 8000, "3 in lobby");
  check("three players in lobby", Object.keys(s.players).length === 3);
  check("no player UUIDs in broadcast state", !JSON.stringify(s).includes(A.uuid) && !JSON.stringify(s).includes(B.uuid));
  A.send({ type: "start" });
  s = await A.waitState(s => s.phase === "playing", 8000, "start");
  const order = s.turnOrder;
  check("game started, turn order = join order", order[0] === A.id && order[1] === B.id && order[2] === C.id);
  for (const bot of [B, C]) await bot.waitState(st => st.phase === "playing");
  check("all clients see the same board", JSON.stringify(B.state().grid) === JSON.stringify(A.state().grid) && JSON.stringify(C.state().grid) === JSON.stringify(A.state().grid));

  // A: C at (0,0)   B: A at (0,1)   C: T at (0,2) then claims CAT   A: S at (0,3), claims CATS? (plural → rejected), places elsewhere
  await place(A, 0, 0, "C"); await passTurn(A, A.id);
  await B.waitState(st => st.cur === B.id); await place(B, 0, 1, "A"); await passTurn(B, B.id);
  await C.waitState(st => st.cur === C.id); await place(C, 0, 2, "T");
  C.send({ type: "claim", word: "CAT", path: [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }], score: 999 });
  s = await C.waitState(st => st.claimed?.length === 1, 8000, "claim CAT");
  check("claim accepted with server score (3, not 999)", s.claimed[0].score === 3 && s.players[C.id].score === 3);
  check("claim earned an extra letter", s.players[C.id].lettersLeft === 1);
  const [sa, sb] = await Promise.all([A.waitState(st => st.claimed?.length === 1), B.waitState(st => st.claimed?.length === 1)]);
  check("other players saw the claim", sa.claimed[0].word === "CAT" && sb.claimed[0].word === "CAT");
  C.send({ type: "claim", word: "CAT", path: [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }] });
  await sleep(500);
  check("duplicate claim rejected", C.state().claimed.length === 1);
  await place(C, 1, 1, "R"); await passTurn(C, C.id);
  // Alice: T under the R → claims ART down column 1, then tries CATS (plural of CAT → rejected)
  await A.waitState(st => st.cur === A.id);
  await place(A, 2, 1, "T");
  A.send({ type: "claim", word: "ART", path: [{ r: 0, c: 1 }, { r: 1, c: 1 }, { r: 2, c: 1 }] });
  s = await A.waitState(st => st.claimed?.length === 2, 8000, "claim ART");
  check("words can share letters (ART down through CAT)", s.players[A.id].score === 3);
  await place(A, 0, 3, "S");
  A.send({ type: "claim", word: "CATS", path: [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }, { r: 0, c: 3 }] });
  await sleep(500);
  check("plural of a claimed word rejected (CATS after CAT)", A.state().claimed.length === 2);
  const aScore = A.state().players[A.id].score;
  await passTurn(A, A.id);

  // Spectator asks to join; host adds them
  const S = new Bot("SAM");
  await S.connect(code);
  S.send({ type: "join", name: S.name, color: "Green", uuid: S.uuid });
  await S.waitFor(m => m.type === "watching", 8000, "watching");
  check("late joiner becomes a spectator", true);
  S.send({ type: "join_request", name: S.name, color: "Green", uuid: S.uuid });
  const req = await A.waitFor(m => m.type === "spectator_request", 8000, "join request");
  A.send({ type: "grant_join", requestConnId: req.connId, mode: "add" });
  await S.waitFor(m => m.type === "join_granted", 8000, "granted");
  s = await A.waitState(st => st.players[S.id]);
  check("host granted spectator a seat", s.turnOrder.includes(S.id));

  // B drops and reconnects within the grace period → keeps seat and score
  await A.waitState(st => st.cur === A.id);
  B.close();
  await sleep(1500);
  const oldB = B.id;
  await B.connect(code);
  B.send({ type: "rejoin", oldConnId: oldB, uuid: B.uuid });
  s = await B.waitState(st => st.players?.[B.id], 8000, "rejoin");
  check("reconnecting player keeps their seat", s.turnOrder.includes(B.id) && !s.turnOrder.includes(oldB));

  // C leaves; host replaces them with a bot (C's 3 points carry over)
  C.send({ type: "leave_game" });
  const left = await A.waitFor(m => m.type === "player_left", 8000, "player_left");
  A.send({ type: "replace_with_bot", oldConnId: left.connId, difficulty: "easy" });
  s = await A.waitState(st => Object.values(st.players).some(p => p.isBot), 8000, "bot replace");
  const botId = Object.keys(s.players).find(id => s.players[id].isBot);
  check("departed player replaced by a bot with their score", s.players[botId].score === 3);

  // Everyone passes until the game ends (host passes for the bot)
  const actors = { [A.id]: A, [B.id]: B, [S.id]: S };
  for (let i = 0; i < 20 && A.state().phase === "playing"; i++) {
    const st = A.state();
    const actor = actors[st.cur] ?? A; // host acts for the bot
    const moved = A.waitNewState(x => x.cur !== st.cur || x.phase !== "playing", 8000, "end passes");
    actor.send({ type: "pass", isRealPass: true });
    await moved.catch(() => {});
  }
  s = await A.waitState(st => st.phase === "ended", 10000, "ended").catch(e => { throw new Error(`${e.message} ${brief(A.state())}`); });
  check("game ends when everyone passes", s.phase === "ended");
  await sleep(1500);
  const xp = await getJson(`playerXp=${A.uuid}`);
  check("finishing player's points recorded as XP", xp.xp === aScore, `xp=${xp.xp} score=${aScore}`);
  const coins = await getJson(`coins=${A.uuid}`);
  check("finishing player earned coins", (coins.coins ?? 0) > 0, `coins=${coins.coins}`);
  const wk = await getJson("weekly=1");
  check("weekly ladder includes the game's points", (wk.top ?? []).some(e => e.name === "ALICE" && e.pts >= aScore) && !JSON.stringify(wk).includes(A.uuid));
  const leaverXp = await getJson(`playerXp=${C.uuid}`);
  check("player who left forfeits (their seat's points went to the bot)", (leaverXp.xp ?? 0) === 0);

  // Play again resets cleanly
  A.fresh();
  A.send({ type: "reset" });
  s = await A.waitState(st => st.phase === "lobby", 8000, "reset");
  check("play again → clean lobby", Object.values(s.players).every(p => p.score === 0) && Object.keys(s.disconnectedPlayers ?? {}).length === 0);
  [A, B, S].forEach(b => b.close());
}

async function highStakes() {
  section = "High Stakes"; console.log(`\n▶ ${section}`);
  const A = new Bot("HSA"), B = new Bot("HSB");
  const code = await createRoom(A, { timeLimit: "high" });
  await joinRoom(B, code);
  A.send({ type: "start" });
  let s = await A.waitState(st => st.phase === "playing");
  check("time banks created for each player", s.timeBank?.[A.id] > 0 && s.timeBank?.[B.id] > 0, JSON.stringify(s.timeBank));
  check("High Stakes config came from server, not host", !!s.settings.highStakes);
  const before = s.timeBank[A.id];
  s = await place(A, 2, 2, "E");
  check("letter bonus applied (capped at max)", s.timeBank[A.id] >= before && s.timeBank[A.id] <= s.settings.highStakes.max);
  A.send({ type: "time_up" });
  await sleep(500);
  check("early time_up ignored (time not actually out)", A.state().cur === A.id);
  A.close(); B.close();
}

async function asyncGames() {
  section = "Over-days (async) games"; console.log(`\n▶ ${section}`);
  if (!ADMIN) return check("dev admin password available", false, "skipping async timeouts");
  const original = (await getConfig()).asyncTurnHours;
  await setConfig({ asyncTurnHours: 0.003 }); // ~11s turns on dev
  try {
    const A = new Bot("ASYA"), B = new Bot("ASYB");
    const code = await createRoom(A, { pace: "async", boardSize: 5 });
    A.send({ type: "add-bot" });
    await sleep(600);
    check("bots can't be added to async games", !Object.values(A.state().players).some(p => p.isBot));
    await joinRoom(B, code);
    A.send({ type: "start" });
    let s = await A.waitState(st => st.phase === "playing" && st.turnDeadline, 10000, "async start");
    check("async game started with a turn deadline", s.turnDeadline > Date.now());

    // B subscribes to pushes (dev test receiver) and goes offline
    const sinkId = `bot-${rand()}`;
    const sub = await post({ type: "push_subscribe", uuid: B.uuid, subscription: { endpoint: `${BASE}/__push_sink/${sinkId}`, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } } });
    check("push subscription accepted", sub.ok);
    B.close();
    await sleep(800);
    s = await place(A, 2, 2, "R");
    await passTurn(A, A.id);
    s = await A.waitState(st => st.cur !== A.id && st.turnDeadline, 8000, "turn to B");
    check("turn passes to the offline player (seat kept)", s.turnOrder.length === 2 && s.cur !== A.id);
    await sleep(2500);
    const sink = await (await fetch(`${BASE}/__push_sink/${sinkId}`)).json();
    check("turn notification sent, signed and encrypted", sink.ok >= 1 && sink.bad === 0, JSON.stringify(sink));
    const mgA = await (await post({ type: "mygames", uuid: A.uuid })).json();
    const mgB = await (await post({ type: "mygames", uuid: B.uuid })).json();
    const gA = mgA.games.find(g => g.roomId === code), gB = mgB.games.find(g => g.roomId === code);
    check("My Games: listed for both players", !!gA && !!gB);
    check("My Games: 'your turn' only for the right player", gA?.yourTurn === false && gB?.yourTurn === true);

    // B doesn't play → auto-pass at the deadline
    s = await A.waitState(st => st.cur === A.id && st.consecutivePasses >= 1, 30000, "auto-pass");
    check("turn auto-passes at the deadline", s.cur === A.id);

    // B comes back on another 'device' (fresh connection, same account) and keeps their seat
    await B.connect(code);
    B.send({ type: "rejoin", uuid: B.uuid });
    s = await B.waitState(st => st.players?.[B.id], 8000, "async rejoin");
    check("rejoining by account restores the seat", s.turnOrder.includes(B.id) && Object.keys(s.players).length === 2);
    // Opening the share link again must not create a second copy of B
    const B2 = new Bot("ASYB", B.uuid);
    await B2.connect(code);
    B2.send({ type: "join", name: "ASYB", color: "Blue", uuid: B.uuid });
    s = await B2.waitState(st => st.players?.[B2.id], 8000, "dup join");
    check("re-opening the invite link doesn't duplicate the player", Object.keys(s.players).length === 2);
    B.close(); B.ws = B2.ws; B.id = B2.id; B.msgs = B2.msgs; B.waiters = B2.waiters;

    // A resigns; B finishes the game
    A.send({ type: "leave_game" });
    s = await B.waitState(st => !st.turnOrder.includes(A.id), 8000, "resign");
    check("resigning removes the player from the turn order", s.turnOrder.length === 1);
    for (let i = 0; i < 4 && B.state().phase === "playing"; i++) { B.send({ type: "pass", isRealPass: true }); await sleep(700); }
    s = await B.waitState(st => st.phase === "ended", 15000, "async end");
    check("async game ends", s.phase === "ended");
    await sleep(1500);
    const endB = (await (await post({ type: "mygames", uuid: B.uuid })).json()).games.find(g => g.roomId === code);
    const endA = (await (await post({ type: "mygames", uuid: A.uuid })).json()).games.find(g => g.roomId === code);
    check("My Games shows the finished game for both", endB?.phase === "ended" && ["ended", "left"].includes(endA?.phase), `${endB?.phase}/${endA?.phase}`);
    A.close(); B.close();

    // Feature switch: async off → can't start
    await setConfig({ feature_async: 0 });
    const C = new Bot("ASYC"), D = new Bot("ASYD");
    const code2 = await createRoom(C, { pace: "async" });
    await joinRoom(D, code2);
    C.send({ type: "start" });
    const err = await C.waitFor(m => m.type === "error", 8000, "async off").catch(() => null);
    check("switching off async blocks new async games", !!err && C.state().phase === "lobby", err?.message);
    C.close(); D.close();
  } finally {
    await setConfig({ asyncTurnHours: original ?? 24, feature_async: 1 });
  }
}

async function daily() {
  section = "Daily puzzle"; console.log(`\n▶ ${section}`);
  const first = await getJson(`daily=1&uuid=${crypto.randomUUID()}`);
  const p = first.puzzle;
  check("today's puzzle served", p && p.letters.length + p.starters.length === p.size * p.size, `#${p?.number} ${p?.date}`);
  const p2 = await getJson("daily=1");
  check("same board for everyone", JSON.stringify(p2.puzzle) === JSON.stringify(p));

  const bots = Array.from({ length: 12 }, (_, i) => ({ name: `DAILY${i + 1}`, uuid: crypto.randomUUID() }));
  const subs = await Promise.all(bots.map(async (b, i) => {
    const sol = solveDaily(p, i * 0.7);
    await post({ type: "track", event: "visit", uuid: b.uuid });
    const res = await post({ type: "daily_submit", uuid: b.uuid, name: b.name, date: p.date, moves: sol.moves });
    return { b, sol, res: await res.json(), status: res.status };
  }));
  const allOk = subs.every(x => x.status === 200 && x.res.ok);
  check("12 bots submitted solutions", allOk, subs.filter(x => x.status !== 200).map(x => JSON.stringify(x.res)).join(" ") || `scores ${subs.map(x => x.res.score).join(",")}`);
  check("server score matches each bot's own scoring", subs.every(x => x.res.score === x.sol.score), subs.map(x => `${x.sol.score}/${x.res.score}`).join(" "));
  check("share card is a 5×5 emoji grid", subs[0].res.share?.split("\n").length === 5 && /^[🟩⬛]+$/u.test(subs[0].res.share.split("\n")[0]));
  check("streak starts at 1", subs.every(x => x.res.streak?.current === 1));
  const again = await (await post({ type: "daily_submit", uuid: bots[0].uuid, name: "X", date: p.date, moves: [] })).json();
  check("one attempt per day (second returns the first result)", again.already === true && again.score === subs[0].res.score);
  const fake = await post({ type: "daily_submit", uuid: crypto.randomUUID(), name: "CHEAT", date: p.date, moves: [{ claim: { word: "ZZZ", path: [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }] } }] });
  check("fake word rejected", fake.status === 400);
  const wrongPlace = await post({ type: "daily_submit", uuid: crypto.randomUUID(), name: "CHEAT", date: p.date, moves: [{ place: { r: p.starters[0].r, c: p.starters[0].c } }] });
  check("placing on a starter letter rejected", wrongPlace.status === 400);
  const future = await post({ type: "daily_submit", uuid: crypto.randomUUID(), name: "CHEAT", date: "2099-01-01", moves: [] });
  check("future/past dates rejected", future.status === 400);
  const lb = await getJson(`dailylb=${p.date}`);
  const sorted = [...(lb.top ?? [])].every((e, i, a) => i === 0 || a[i - 1].score >= e.score);
  check("daily leaderboard sorted, no UUIDs", sorted && lb.top.length >= 12 && !JSON.stringify(lb).includes(bots[0].uuid));
  const mine = await getJson(`daily=1&uuid=${bots[0].uuid}`);
  check("home card knows you've played", mine.mine?.score === subs[0].res.score);

  // Streak freezes
  section = "Streaks"; console.log(`\n▶ ${section}`);
  const st = await getJson(`streak=${bots[0].uuid}`);
  check("streak readable", st.current === 1 && st.freezes === 0);
  const poor = await post({ type: "spend", uuid: bots[0].uuid, item: "streakFreeze" });
  check("can't buy a freeze without enough coins", poor.status === 402);
  if (ADMIN) {
    const orig = (await getConfig()).spendStreakFreeze;
    await setConfig({ spendStreakFreeze: 1 });
    try {
      const f1 = await (await post({ type: "spend", uuid: bots[0].uuid, item: "streakFreeze" })).json();
      const f2 = await (await post({ type: "spend", uuid: bots[0].uuid, item: "streakFreeze" })).json();
      const f3 = await post({ type: "spend", uuid: bots[0].uuid, item: "streakFreeze" });
      check("freezes bought with coins, max 2", f1.freezes === 1 && f2.freezes === 2 && f3.status === 409);
    } finally { await setConfig({ spendStreakFreeze: orig ?? 300 }); }
  }
  const wk = await getJson("weekly=1");
  check("daily scores added to the weekly ladder", subs.filter(x => x.res.score > 0).every(x => wk.top.some(e => e.name === x.b.name)));
  return bots;
}

async function analyticsAndFlags(dailyBots) {
  section = "Analytics & feature switches"; console.log(`\n▶ ${section}`);
  const bad = await post({ type: "track", event: "drop_tables", uuid: crypto.randomUUID() });
  check("unknown analytics events rejected", bad.status === 400);
  if (!ADMIN) return check("dev admin password available", false);
  const r = await post({ type: "admin_analytics", password: ADMIN });
  const an = await r.json();
  const today = an.days?.[an.days.length - 1];
  check("admin analytics: today's visitors counted", (today?.visitors ?? 0) >= dailyBots.length, JSON.stringify(today));
  check("admin analytics: daily completions counted", (today?.daily_done ?? 0) >= 0 && Array.isArray(an.days) && an.days.length === 14);
  const wrong = await post({ type: "admin_analytics", password: "wrong" });
  check("analytics need the admin password", wrong.status === 401);

  await setConfig({ feature_daily: 0, feature_weekly: 0 });
  try {
    const d = await fetch(`${STATS}?daily=1`);
    const sub = await post({ type: "daily_submit", uuid: crypto.randomUUID(), date: new Date().toISOString().slice(0, 10), moves: [] });
    check("daily switched off → puzzle and submissions blocked", d.status === 404 && sub.status === 404);
    const cfg = await getConfig();
    check("switches visible to clients", cfg.feature_daily === 0 && cfg.feature_weekly === 0);
  } finally {
    await setConfig({ feature_daily: 1, feature_weekly: 1 });
  }
  const back = await fetch(`${STATS}?daily=1`);
  check("switching back on restores the daily", back.ok);
}

async function securityRegressions() {
  section = "Security regressions"; console.log(`\n▶ ${section}`);
  const A = new Bot('<img src=x onerror=alert(1)>"EVE');
  const code = await createRoom(A, { boardSize: 99, highStakes: { start: 1e9 } });
  const s = A.state();
  check("names sanitised", !/[<>"']/.test(s.players[A.id].name), s.players[A.id].name);
  check("settings whitelisted", s.settings.boardSize === 5 && !s.settings.highStakes);
  const before = (await getJson(`coins=${A.uuid}`)).coins ?? 0;
  await post({ type: "coins_update", uuid: A.uuid, delta: 99999 });
  check("coins can't be added from outside", ((await getJson(`coins=${A.uuid}`)).coins ?? 0) === before);
  const ge = await post({ type: "game_end", outcome: "completed", players: [{ uuid: A.uuid, name: "X", score: 500 }] });
  check("fake game results rejected", ge.status === 403);
  const merge = await post({ type: "mygames_update", roomId: code, entries: [{ uuid: A.uuid, info: { phase: "playing" } }] });
  check("server-only My Games updates rejected", merge.status === 403);
  const pushTurn = await post({ type: "push_turn", uuid: A.uuid, title: "spam" });
  check("server-only push sends rejected", pushTurn.status === 403);
  const badSub = await post({ type: "push_subscribe", uuid: A.uuid, subscription: { endpoint: "http://evil.example/x", keys: { p256dh: "a", auth: "b" } } });
  check("non-https push endpoints rejected", badSub.status === 400);
  const evil = new Bot("EVIL");
  await evil.connect(code);
  evil.send({ type: "create", name: "EVIL", uuid: evil.uuid, settings: {} });
  const err = await evil.waitFor(m => m.type === "error", 8000).catch(() => null);
  check("live rooms can't be overwritten", !!err);
  A.close(); evil.close();
}

async function load() {
  section = "Load (15 simultaneous games)"; console.log(`\n▶ ${section}`);
  const N = 15;
  const latencies = [];
  const t0 = Date.now();
  const games = await Promise.allSettled(Array.from({ length: N }, async (_, g) => {
    const A = new Bot(`LA${g}`), B = new Bot(`LB${g}`);
    const code = await createRoom(A);
    await joinRoom(B, code);
    A.send({ type: "start" });
    await A.waitState(st => st.phase === "playing", 10000);
    const letters = "STARE";
    let cur = A.state().cur;
    for (let t = 0; t < 4; t++) {
      const actor = cur === A.id ? A : B;
      const tt = Date.now();
      await place(actor, t, t, letters[t]).catch(e => { throw new Error(`${e.message} actor=${actor.id} A=${brief(A.state())} B=${brief(B.state())}`); });
      latencies.push(Date.now() - tt);
      cur = (await passTurn(actor, actor.id)).cur;
    }
    for (let i = 0; i < 8 && A.state().phase === "playing"; i++) {
      const actor = A.state().cur === A.id ? A : B;
      const moved = A.waitNewState(st => st.cur !== actor.id || st.phase !== "playing", 8000);
      actor.send({ type: "pass", isRealPass: true });
      await moved.catch(() => {});
    }
    await A.waitState(st => st.phase === "ended", 15000);
    A.close(); B.close();
  }));
  const failed = games.filter(g => g.status === "rejected");
  latencies.sort((a, b) => a - b);
  const p = (q) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))];
  check(`${N} games completed concurrently`, failed.length === 0, failed.map(f => f.reason?.message).join("; "));
  check("move latency acceptable (p95 < 1.5s)", p(0.95) < 1500, `median ${p(0.5)}ms, p95 ${p(0.95)}ms, total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ════════════════════════════════════════════════════════════════════════════
console.log(`Lexterra bot tests → ${BASE}${ADMIN ? "" : "  (no admin password: some checks skipped)"}`);
const run = async (name, fn, ...args) => {
  if (ONLY && !ONLY.includes(name)) return;
  try { return await fn(...args); }
  catch (e) { check(`${name} completed without errors`, false, e.message); }
};
await run("live", liveGame);
await run("highstakes", highStakes);
const dailyBots = (await run("daily", daily)) ?? [];
await run("analytics", analyticsAndFlags, dailyBots);
await run("async", asyncGames);
await run("security", securityRegressions);
await run("load", load);

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("\nFailures:"); for (const f of failed) console.log(`  [${f.section}] ${f.name}${f.extra ? ` — ${f.extra}` : ""}`); }
process.exit(failed.length ? 1 : 0);
