// Lexterra — Puzzle screen: the Daily puzzle, an unranked replay of it, and Endless puzzles
// (Classic and Blitz). Place the queued letters one at a time, claim words in straight lines;
// words score their length. The server replays every ranked submission to confirm the score.

const MIN_LEN = 3;
const BLITZ_FINAL_SECS = 30; // claiming window after the last Blitz letter lands
const THEMES = [
  { id: "classic", name: "Classic", swatch: ["#0c1628", "#e2e8f0", "#22c55e"] },
  { id: "neon",    name: "Neon",    swatch: ["#0b0820", "#67e8f9", "#d946ef"] },
  { id: "gold",    name: "Gold",    swatch: ["#1c1405", "#fde68a", "#ca8a04"] },
  { id: "ocean",   name: "Ocean",   swatch: ["#082f49", "#e0f2fe", "#06b6d4"] },
  { id: "candy",   name: "Candy",   swatch: ["#2a0f24", "#fbcfe8", "#ec4899"] },
];

let ctx = null;          // set by openDaily / openEndless (see index.html)
let kind = "daily";      // "daily" | "replay" | "endless"
let mode = "classic";    // endless only: "classic" | "blitz"
let puzzle = null;       // { size, minLen, starters, letters, date?, number?, seed? }
let grid = [];           // [r][c] → { letter, starter? } | null
let moves = [];          // [{ place:{r,c} } | { claim:{ word, path } }]
let claimed = [];        // [{ word, path }]
let next = 0;            // index into puzzle.letters
let claimMode = false, claimStart = null;
let result = null;       // finished result for the current kind
let dailyResult = null;  // today's ranked daily result (kept while replaying / viewing boards)
let view = "play";       // "play" | "result" | "board" | "themes"
let submitting = false;
let countdownTimer = null;
let blitzSecs = 10, tileDeadline = 0, finalDeadline = 0, blitzTimer = null;
let endlessLb = { period: "week", data: null };
let viewer = null;       // { date, data, step, timer }
let lastPlaced = null;   // "r,c" of the letter just placed (for the pop animation)

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const statsUrl = () => `https://${ctx.host}/parties/stats/main`;
const post = (body) => fetch(statsUrl(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const storeKey = () => kind === "daily" ? `lexterra_daily_${puzzle.date}` : kind === "replay" ? `lexterra_daily_replay_${puzzle.date}` : `lexterra_endless_${puzzle.seed}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const isBlitz = () => kind === "endless" && mode === "blitz";

// ── Word rules (mirror of party/rules.js) ───────────────────────────────────
function hasBetterRoot(long, short) {
  for (const suf of ["S", "ES", "ING", "ED", "D"]) {
    if (long.endsWith(suf) && long.length > suf.length) {
      const other = long.slice(0, long.length - suf.length);
      if (other !== short && other.length > short.length && ctx.isWord(other)) return true;
    }
  }
  return false;
}
function claimedVariant(w) {
  for (const { word: cw } of claimed) {
    if (w === cw) return cw;
    if ((w === cw + "S" || w === cw + "ES") && !hasBetterRoot(w, cw)) return cw;
    if (w.endsWith("IES") && cw === w.slice(0, -3) + "Y") return cw;
    if ((cw === w + "S" || cw === w + "ES") && !hasBetterRoot(cw, w)) return cw;
    if (cw.endsWith("IES") && w === cw.slice(0, -3) + "Y") return cw;
  }
  return null;
}
function lineBetween(a, b) {
  const dr = b.r - a.r, dc = b.c - a.c;
  if (dr !== 0 && dc !== 0 && Math.abs(dr) !== Math.abs(dc)) return null;
  const len = Math.max(Math.abs(dr), Math.abs(dc));
  if (len === 0) return null;
  const sr = Math.sign(dr), sc = Math.sign(dc);
  return Array.from({ length: len + 1 }, (_, i) => ({ r: a.r + i * sr, c: a.c + i * sc }));
}
function checkClaim(path) {
  if (!path || path.length < MIN_LEN) return { ok: false, why: `Words need ${MIN_LEN}+ letters in a straight line` };
  const letters = path.map(({ r, c }) => grid[r][c]?.letter);
  if (letters.some(l => !l)) return { ok: false, why: "Every square in the word needs a letter" };
  const word = letters.join("");
  const v = claimedVariant(word);
  if (v) return { ok: false, why: v === word ? `${word} already claimed` : `"${v}" already claimed`, word };
  if (ctx.isBanned(word)) return { ok: false, why: "That word isn't allowed", word };
  if (!ctx.isWord(word)) return { ok: false, why: `${word} isn't in the dictionary`, word };
  return { ok: true, word };
}

// ── State ───────────────────────────────────────────────────────────────────
function resetBoard() {
  grid = Array.from({ length: puzzle.size }, () => Array(puzzle.size).fill(null));
  for (const s of puzzle.starters) grid[s.r][s.c] = { letter: s.letter, starter: true };
  moves = []; claimed = []; next = 0; claimMode = false; claimStart = null;
}
function applyMove(m) {
  if (m.place) grid[m.place.r][m.place.c] = { letter: puzzle.letters[next++] };
  else if (m.claim) claimed.push({ word: m.claim.word, path: m.claim.path });
  moves.push(m);
}
function save() { if (isBlitz()) return; try { localStorage.setItem(storeKey(), JSON.stringify(moves)); } catch {} }
function forget() { try { localStorage.removeItem(storeKey()); } catch {} }
function restore() {
  resetBoard();
  if (isBlitz()) return; // Blitz runs can't be paused and resumed
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey()) || "[]");
    for (const m of saved) {
      if (m.place && next < puzzle.letters.length && !grid[m.place.r]?.[m.place.c]) applyMove(m);
      else if (m.claim && checkClaim(m.claim.path).ok) applyMove(m);
    }
  } catch { resetBoard(); }
}
const score = () => claimed.reduce((s, c) => s + c.word.length, 0);
const usedGrid = () => {
  const used = Array.from({ length: puzzle.size }, () => Array(puzzle.size).fill(false));
  for (const c of claimed) for (const { r, c: col } of c.path) used[r][col] = true;
  return used;
};
const shareGrid = (used) => used.map(row => row.map(u => (u ? "🟩" : "⬛")).join("")).join("\n");

// ── Themes ─────────────────────────────────────────────────────────────────
const ownedThemes = () => new Set(["classic", ...THEMES.filter(t => (ctx.getUnlocks?.() ?? {})[`theme_${t.id}`]).map(t => t.id)]);
function currentTheme() {
  let t = "classic";
  try { t = localStorage.getItem("lexterra_tile_theme") || "classic"; } catch {}
  return ownedThemes().has(t) ? t : "classic";
}
function applyTheme() {
  const el = $("daily-screen");
  if (!el) return;
  for (const t of THEMES) el.classList.remove(`th-${t.id}`);
  el.classList.add(`th-${currentTheme()}`);
}

// ── Rendering ───────────────────────────────────────────────────────────────
function injectStyles() {
  if ($("daily-styles")) return;
  const st = document.createElement("style");
  st.id = "daily-styles";
  st.textContent = `
    #daily-screen { position:fixed; inset:0; background:#0f172a; z-index:900; overflow-y:auto; display:none;
      --d-bg:#0c1628; --d-border:#1e3a5f; --d-text:#e2e8f0; --d-starter:#fcd34d; --d-used-bg:rgba(34,197,94,0.18); --d-used-border:#166534; --d-glow:0 0 0 transparent; }
    #daily-screen.th-neon  { --d-bg:#0b0820; --d-border:#3b2a7a; --d-text:#67e8f9; --d-starter:#f0abfc; --d-used-bg:rgba(217,70,239,0.22); --d-used-border:#d946ef; --d-glow:0 0 8px rgba(103,232,249,0.7); }
    #daily-screen.th-gold  { --d-bg:#1c1405; --d-border:#57400c; --d-text:#fde68a; --d-starter:#fb923c; --d-used-bg:rgba(234,179,8,0.22); --d-used-border:#ca8a04; }
    #daily-screen.th-ocean { --d-bg:#082f49; --d-border:#0e7490; --d-text:#e0f2fe; --d-starter:#a5f3fc; --d-used-bg:rgba(6,182,212,0.25); --d-used-border:#06b6d4; }
    #daily-screen.th-candy { --d-bg:#2a0f24; --d-border:#9d174d; --d-text:#fbcfe8; --d-starter:#fde047; --d-used-bg:rgba(236,72,153,0.25); --d-used-border:#ec4899; }
    #daily-screen .d-wrap { max-width:420px; margin:0 auto; padding:1rem; display:flex; flex-direction:column; gap:0.9rem; }
    #daily-screen .card { padding:1rem; }
    #daily-screen .d-head { display:flex; align-items:center; justify-content:space-between; gap:0.5rem; }
    #daily-screen .d-title { font-size:1.15rem; font-weight:900; letter-spacing:0.08em; color:var(--clr-primary-light); }
    #daily-screen .d-sub { font-size:0.72rem; color:#64748b; text-transform:uppercase; letter-spacing:0.1em; }
    #daily-screen .d-icons { display:flex; align-items:center; gap:0.15rem; flex-shrink:0; }
    #daily-screen .d-close { background:none; border:none; color:#64748b; font-size:1.4rem; cursor:pointer; padding:0.2rem 0.4rem; line-height:1; }
    #daily-screen .d-grid { display:grid; margin:0 auto; }
    #daily-screen .d-cell { aspect-ratio:1; border:2px solid var(--d-border); border-radius:6px; display:flex; align-items:center; justify-content:center;
      font-weight:900; font-size:var(--dfs); color:var(--d-text); background:var(--d-bg); cursor:pointer; user-select:none; transition:background 0.12s, border-color 0.12s;
      text-shadow:-2px -2px 0 #000,2px -2px 0 #000,-2px 2px 0 #000,2px 2px 0 #000,var(--d-glow); }
    #daily-screen .d-grid.mini .d-cell { border-width:1px; border-radius:4px; cursor:default;
      text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000; }
    #daily-screen .d-cell.starter { color:var(--d-starter); }
    #daily-screen .d-cell.used { background:var(--d-used-bg); border-color:var(--d-used-border); }
    #daily-screen .d-cell.fresh { animation:d-pop 0.25s ease-out; }
    @keyframes d-pop { from { transform:scale(0.6); opacity:0.3; } to { transform:scale(1); opacity:1; } }
    @media (hover:hover) { #daily-screen .d-cell.empty:hover { border-color:var(--clr-primary); } }
    #daily-screen .d-cell.sel { border-color:var(--clr-primary) !important; background:rgba(var(--clr-primary-rgb),0.25); }
    #daily-screen .d-cell.path-ok { border-color:#22c55e !important; background:rgba(34,197,94,0.25); }
    #daily-screen .d-cell.path-bad { border-color:#ef4444 !important; background:rgba(239,68,68,0.18); }
    #daily-screen .d-queue { display:flex; align-items:center; gap:0.5rem; justify-content:center; }
    #daily-screen .d-tile { width:48px; height:48px; border-radius:8px; background:var(--clr-primary); color:white; font-weight:900; font-size:1.6rem;
      display:flex; align-items:center; justify-content:center; text-shadow:-2px -2px 0 #000,2px -2px 0 #000,-2px 2px 0 #000,2px 2px 0 #000; }
    #daily-screen .d-tile.small { width:30px; height:30px; font-size:0.95rem; background:#1e293b; border:1px solid #334155; opacity:0.8; }
    #daily-screen .d-timer { height:6px; border-radius:3px; background:#0f172a; overflow:hidden; }
    #daily-screen .d-timer > div { height:100%; background:#22c55e; transition:width 0.1s linear, background 0.2s; }
    #daily-screen .d-status { min-height:1.2em; text-align:center; font-size:0.82rem; color:#94a3b8; }
    #daily-screen .d-row { display:flex; gap:0.5rem; }
    #daily-screen .d-row .btn { flex:1; padding:0.6rem 0.5rem; font-size:0.9rem; }
    #daily-screen .d-words { display:flex; flex-wrap:wrap; gap:0.35rem; }
    #daily-screen .d-word { padding:0.2rem 0.5rem; background:#0f172a; border-left:3px solid #22c55e; border-radius:6px; font-size:0.82rem; color:#e2e8f0; }
    #daily-screen .d-big { font-size:2.4rem; font-weight:900; color:var(--clr-primary-light); text-align:center; line-height:1; }
    #daily-screen .d-share { white-space:pre; font-size:1.25rem; line-height:1.15; text-align:center; letter-spacing:0.05em; }
    #daily-screen .d-lb-row { display:flex; justify-content:space-between; align-items:center; gap:0.5rem; font-size:0.85rem; padding:0.35rem 0.25rem; border-bottom:1px solid #1e293b; color:#cbd5e1; border-radius:4px; }
    #daily-screen .d-lb-row.tap { cursor:pointer; }
    @media (hover:hover) { #daily-screen .d-lb-row.tap:hover { background:#0f172a; } }
    #daily-screen .d-lb-row.me { color:var(--clr-primary-light); font-weight:bold; }
    #daily-screen .d-lb-row .d-eye { color:#64748b; margin-left:0.2rem; }
    #daily-screen .d-note { font-size:0.75rem; color:#64748b; text-align:center; }
    #daily-screen .d-badge { display:inline-block; padding:0.15rem 0.5rem; border-radius:999px; font-size:0.68rem; font-weight:bold; letter-spacing:0.06em; text-transform:uppercase; }
    #daily-screen .d-theme { display:flex; align-items:center; gap:0.75rem; padding:0.6rem; border:2px solid #334155; border-radius:10px; background:#0f172a; cursor:pointer; color:#e2e8f0; width:100%; text-align:left; font:inherit; }
    #daily-screen .d-theme.on { border-color:var(--clr-primary); }
    #daily-screen .d-swatch { display:flex; gap:3px; }
    #daily-screen .d-swatch span { width:22px; height:22px; border-radius:5px; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:0.8rem; }
  `;
  document.head.appendChild(st);
  const el = document.createElement("div");
  el.id = "daily-screen";
  el.innerHTML = `<div class="d-wrap" id="daily-wrap"></div>`;
  document.body.appendChild(el);
}

// Cell size that fits inside a card: screen padding (32) + card padding (32) + borders (2)
function cellSize(n = puzzle.size, max = 64, gap = 4) {
  const w = Math.min(420, window.innerWidth) - 66 - (n - 1) * gap;
  return Math.max(30, Math.min(max, Math.floor(w / n)));
}

function gridHTML(g, usedSet, cs, { mini = false, freshKey = null } = {}) {
  const n = g.length;
  return `<div class="d-grid${mini ? " mini" : ""}" style="grid-template-columns:repeat(${n},${cs}px);gap:${mini ? 3 : 4}px;--dfs:${Math.round(cs * 0.62)}px">
    ${g.map((row, r) => row.map((cell, c) => `<div class="d-cell${cell ? (cell.starter ? " starter" : "") : " empty"}${usedSet.has(`${r},${c}`) ? " used" : ""}${freshKey === `${r},${c}` ? " fresh" : ""}" data-r="${r}" data-c="${c}">${cell ? esc(cell.letter) : ""}</div>`).join("")).join("")}
  </div>`;
}

function headerHTML() {
  let title, sub;
  if (kind === "daily") { title = `DAILY #${puzzle.number}`; sub = view === "play" ? `${esc(puzzle.date)} · same board for everyone` : esc(puzzle.date); }
  else if (kind === "replay") { title = `DAILY #${puzzle.number} · REPLAY`; sub = "Just for fun — your ranked score stays"; }
  else if (mode === "blitz") { title = "⚡ BLITZ"; sub = `${blitzSecs} seconds per letter`; }
  else { title = "ENDLESS"; sub = "Classic · take your time"; }
  return `<div class="d-head">
      <div><div class="d-title">${title}</div><div class="d-sub">${sub}</div></div>
      <div class="d-icons">
        <button class="d-close" onclick="dailyThemes()" aria-label="Tile themes" title="Tile themes" style="font-size:1.1rem">🎨</button>
        <button class="d-close" onclick="closeDaily()" aria-label="Close">✕</button>
      </div>
    </div>`;
}

function render() {
  const wrap = $("daily-wrap");
  if (!wrap || !puzzle) return;
  applyTheme();
  if (view === "themes") return renderThemes();
  if (view === "board") return renderBoardViewer();
  if (result) return renderResult();
  const remaining = puzzle.letters.length - next;
  const usedSet = new Set(claimed.flatMap(c => c.path.map(p => `${p.r},${p.c}`)));
  const queue = puzzle.letters.slice(next, next + 4);
  wrap.innerHTML = `
    ${headerHTML()}
    <div class="card" style="gap:0.75rem">
      <div class="d-queue">
        ${queue.length ? `<span style="font-size:0.72rem;color:#64748b;text-transform:uppercase;letter-spacing:0.08em">Next</span>
          <div class="d-tile">${esc(queue[0])}</div>${queue.slice(1).map(l => `<div class="d-tile small">${esc(l)}</div>`).join("")}
          <span style="font-size:0.72rem;color:#64748b">${remaining} left</span>`
        : `<span style="font-size:0.85rem;color:#22c55e;font-weight:bold">All letters placed — claim any last words, then finish!</span>`}
      </div>
      ${isBlitz() ? `<div class="d-timer"><div id="d-timer-bar" style="width:100%"></div></div>` : ""}
      ${gridHTML(grid, usedSet, cellSize(), { freshKey: lastPlaced })}
      <div class="d-status" id="daily-status">${claimMode ? (claimStart ? "Now tap the last letter of the word" : "Tap the first letter of a word") : (remaining ? "Tap an empty square to place the next letter" : "")}</div>
      <div class="d-row">
        <button class="btn ${claimMode ? "btn-primary" : "btn-secondary"}" onclick="dailyToggleClaim()">${claimMode ? "Cancel claim" : "Claim a word"}</button>
        <button class="btn btn-secondary" onclick="dailyFinish()" ${submitting ? "disabled" : ""}>${submitting ? "Submitting…" : "Finish"}</button>
      </div>
    </div>
    <div class="card" style="gap:0.5rem">
      <div style="display:flex;justify-content:space-between;align-items:baseline"><h2 style="margin:0">Your words</h2><span style="font-weight:900;color:var(--clr-primary-light)">${score()} pts</span></div>
      <div class="d-words">${claimed.length ? claimed.map(c => `<span class="d-word">${esc(c.word)} <span style="color:#64748b">+${c.word.length}</span></span>`).join("") : `<span style="font-size:0.8rem;color:#64748b">No words yet — words go across, down or diagonally, and score one point per letter.${kind === "replay" ? " This replay isn't ranked." : ""}</span>`}</div>
    </div>`;
  lastPlaced = null;
  wrap.querySelectorAll(".d-grid .d-cell").forEach(el => el.addEventListener("click", () => onCell(+el.dataset.r, +el.dataset.c)));
  if (isBlitz()) tickBlitz();
}

function setStatus(text, color = "#94a3b8") { const el = $("daily-status"); if (el) { el.textContent = text; el.style.color = color; } }

function placeAt(r, c) {
  applyMove({ place: { r, c } });
  lastPlaced = `${r},${c}`;
  if (isBlitz()) startTileClock();
  save();
  render();
}

function onCell(r, c) {
  if (result || submitting || view !== "play") return;
  if (claimMode) {
    if (!claimStart) {
      if (!grid[r][c]) return setStatus("Start on a square with a letter", "#ef4444");
      claimStart = { r, c };
      document.querySelector(`.d-cell[data-r="${r}"][data-c="${c}"]`)?.classList.add("sel");
      return setStatus("Now tap the last letter of the word");
    }
    const path = lineBetween(claimStart, { r, c });
    const check = checkClaim(path);
    if (!check.ok) {
      (path ?? []).forEach(p => document.querySelector(`.d-cell[data-r="${p.r}"][data-c="${p.c}"]`)?.classList.add("path-bad"));
      claimStart = null;
      setTimeout(() => { if (view === "play" && !result) render(); }, 700);
      return setStatus(path ? check.why : "Words must be in a straight line", "#ef4444");
    }
    applyMove({ claim: { word: check.word, path } });
    claimMode = false; claimStart = null; save();
    render();
    return setStatus(`${check.word} +${check.word.length}!`, "#22c55e");
  }
  if (grid[r][c]) return setStatus("That square already has a letter — tap “Claim a word” to claim", "#eab308");
  if (next >= puzzle.letters.length) return setStatus("No letters left — claim words or finish", "#eab308");
  placeAt(r, c);
}

// ── Blitz clock ────────────────────────────────────────────────────────────
// Each letter gets a few seconds; if time runs out it drops into a random empty square.
// After the last letter there's a short window to claim, then the run finishes itself.
function startTileClock() {
  if (next < puzzle.letters.length) { tileDeadline = Date.now() + blitzSecs * 1000; finalDeadline = 0; }
  else { tileDeadline = 0; finalDeadline = Date.now() + BLITZ_FINAL_SECS * 1000; }
}
function stopBlitz() { clearInterval(blitzTimer); blitzTimer = null; tileDeadline = 0; finalDeadline = 0; }
function tickBlitz() {
  if (!blitzTimer) blitzTimer = setInterval(tickBlitz, 100);
  if (result || submitting || view !== "play" || !isBlitz()) return;
  const now = Date.now();
  const bar = $("d-timer-bar");
  if (tileDeadline) {
    const left = Math.max(0, tileDeadline - now);
    if (bar) { const f = left / (blitzSecs * 1000); bar.style.width = `${f * 100}%`; bar.style.background = f > 0.5 ? "#22c55e" : f > 0.25 ? "#eab308" : "#ef4444"; }
    if (left === 0) {
      const empty = [];
      grid.forEach((row, r) => row.forEach((cell, c) => { if (!cell) empty.push({ r, c }); }));
      if (!empty.length) return startTileClock();
      const spot = empty[Math.floor(Math.random() * empty.length)];
      claimMode = false; claimStart = null;
      placeAt(spot.r, spot.c);
      setStatus("Too slow — the letter dropped on its own!", "#ef4444");
    }
  } else if (finalDeadline) {
    const left = Math.max(0, finalDeadline - now);
    if (bar) { bar.style.width = `${(left / (BLITZ_FINAL_SECS * 1000)) * 100}%`; bar.style.background = "#a78bfa"; }
    const st = $("daily-status");
    if (st && !claimMode) { st.textContent = `Last chance to claim — ${Math.ceil(left / 1000)}s`; st.style.color = "#a78bfa"; }
    if (left === 0) { finalDeadline = 0; finish(true); }
  }
}

window.dailyToggleClaim = () => { claimMode = !claimMode; claimStart = null; render(); };
window.dailyFinish = () => finish(false);

async function finish(auto) {
  if (submitting || result) return;
  const remaining = puzzle.letters.length - next;
  if (!auto && !isBlitz()) {
    const once = kind === "daily" ? " You only get one go each day." : "";
    const msg = remaining > 0
      ? `You still have ${plural(remaining, "letter")} to place. Finish anyway?${kind === "endless" ? " Unfinished boards don't count for the leaderboard." : once}`
      : `Submit your score of ${score()}?${once}`;
    if (!confirm(msg)) return;
  }
  if (kind === "replay") {
    result = { score: score(), words: claimed.map(c => c.word), share: shareGrid(usedGrid()), local: true };
    forget();
    view = "result";
    return render();
  }
  stopBlitz();
  submitting = true; render();
  try {
    const body = kind === "daily"
      ? { type: "daily_submit", uuid: ctx.getUUID(), name: ctx.getName(), date: puzzle.date, moves }
      : { type: "endless_submit", uuid: ctx.getUUID(), name: ctx.getName(), seed: puzzle.seed, moves };
    const res = await post(body);
    const data = await res.json();
    if (!res.ok) {
      const why = {
        wrong_day: "This puzzle has ended — a new one is ready.",
        empty: "Place at least one letter before finishing.",
        too_many_today: "Too many daily results from this network today — try again tomorrow.",
        rate_limited: "Slow down a moment, then try again.",
        stale: "This board was replaced by a newer one (maybe in another tab). Start a new puzzle.",
      }[data.error];
      throw new Error(why ?? `Couldn't submit (${data.error}${data.word ? `: ${data.word}` : ""}).`);
    }
    result = data;
    forget();
    view = "result";
    if (kind === "daily") { dailyResult = data; ctx.track("daily_done"); ctx.onResult?.(data); }
    else { ctx.track("endless_done"); endlessLb.data = null; ctx.onEndless?.(data); }
  } catch (e) {
    alert(e.message || "Network error — your progress is saved, try again.");
  } finally {
    submitting = false;
    render();
  }
}

// ── Sharing ────────────────────────────────────────────────────────────────
function shareText() {
  if (kind === "endless") {
    return `Lexterra Endless · ${mode === "blitz" ? "⚡ Blitz" : "Classic"} — ${result.score} pts, ${plural(result.words.length, "word")}${result.isPB ? " (new best!)" : ""}\n${result.share}\nlexterragame.com`;
  }
  const streak = result.streak?.current ?? ctx.streak?.() ?? 0;
  return `Lexterra Daily #${puzzle.number} — ${result.score} pts, ${plural(result.words.length, "word")}${streak > 1 ? `\n🔥 ${streak}-day streak` : ""}\n${result.share}\nlexterragame.com`;
}

window.dailyShare = async () => {
  const text = shareText();
  ctx.track("share");
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
  } catch (e) { if (e?.name === "AbortError") return; }
  try { await navigator.clipboard.writeText(text); ctx.toast?.("Result copied — paste it anywhere!"); }
  catch { prompt("Copy your result:", text); }
};

// ── Results ────────────────────────────────────────────────────────────────
function wordsCard(words, title = "Your words") {
  return `<div class="card" style="gap:0.4rem">
      <h2 style="margin:0 0 0.25rem">${title}</h2>
      <div class="d-words">${words.map(w => `<span class="d-word">${esc(w)} <span style="color:#64748b">+${w.length}</span></span>`).join("") || `<span style="font-size:0.8rem;color:#64748b">No words this time.</span>`}</div>
    </div>`;
}

function renderResult() {
  if (kind === "endless") return renderEndlessResult();
  if (kind === "replay") return renderReplayResult();
  const wrap = $("daily-wrap");
  const streak = result.streak?.current ?? ctx.streak?.() ?? 0;
  wrap.innerHTML = `
    ${headerHTML()}
    <div class="card" style="gap:0.75rem;align-items:center">
      <div class="d-big">${result.score}</div>
      <div style="font-size:0.75rem;color:#64748b;text-transform:uppercase;letter-spacing:0.1em">points · ${plural(result.words.length, "word")}${result.rank ? ` · #${result.rank} of ${result.players}` : ""}</div>
      ${streak ? `<div style="font-size:0.95rem;color:#f97316;font-weight:bold">🔥 ${streak}-day streak</div>` : ""}
      ${result.coinsEarned ? `<div style="font-size:0.8rem;color:#eab308">+${result.coinsEarned} coins</div>` : ""}
      <div class="d-share">${esc(result.share ?? "")}</div>
      <button class="btn btn-primary" style="width:100%" onclick="dailyShare()">Share result</button>
      <button class="btn btn-secondary" style="width:100%" onclick="dailyReplay()">Play it again — just for fun</button>
      <div class="d-note" id="daily-next"></div>
    </div>
    <div class="card" style="gap:0.6rem;align-items:center" id="daily-best-card">
      <h2 style="margin:0;align-self:flex-start">Today's best board</h2>
      <p class="placeholder" style="margin:0">Loading…</p>
    </div>
    ${wordsCard(result.words)}
    <div class="card" style="gap:0.2rem">
      <h2 style="margin:0 0 0.25rem">Today's top scores</h2>
      <p class="d-note" style="text-align:left;margin:0 0 0.3rem">Tap a player to watch how they played.</p>
      <div id="daily-lb"><p class="placeholder">Loading…</p></div>
    </div>`;
  const tick = () => {
    const el = $("daily-next"); if (!el) return;
    const ms = Math.max(0, (ctx.nextAt ?? 0) - Date.now());
    el.textContent = `Next puzzle in ${Math.floor(ms / 3600000)}h ${Math.floor(ms / 60000) % 60}m`;
  };
  tick(); clearInterval(countdownTimer); countdownTimer = setInterval(tick, 30000);
  loadDailyBoards();
}

async function loadDailyBoards() {
  try {
    const lb = await (await fetch(`${statsUrl()}?dailylb=${encodeURIComponent(puzzle.date)}`)).json();
    const myPid = ctx.myPid?.();
    const top = (lb.top ?? []).slice(0, 10);
    const el = $("daily-lb");
    if (el) {
      el.innerHTML = top.map((e, i) =>
        `<div class="d-lb-row tap${e.pid === myPid ? " me" : ""}" data-pid="${esc(e.pid)}"><span>${i + 1}. ${esc(e.name)}${e.pid === myPid ? " ★" : ""}</span><span>${e.score} pts<span class="d-eye">›</span></span></div>`).join("")
        || `<p class="placeholder">You're the first today!</p>`;
      el.querySelectorAll(".d-lb-row.tap").forEach(row => row.addEventListener("click", () => openBoard(puzzle.date, row.dataset.pid)));
    }
    const best = $("daily-best-card");
    if (!best) return;
    const data = top[0] ? await fetchBoard(puzzle.date, top[0].pid) : null;
    if (!$("daily-best-card")) return;
    if (!data) { best.style.display = "none"; return; }
    const { g, used } = boardAt(data, data.moves.length);
    best.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;width:100%;gap:0.5rem">
        <h2 style="margin:0">Today's best board</h2>
        <span style="font-weight:900;color:var(--clr-primary-light);white-space:nowrap">${esc(data.name)} · ${data.score}</span>
      </div>
      ${gridHTML(g, used, cellSize(5, 40, 3), { mini: true })}
      <button class="btn btn-secondary" style="width:100%" id="daily-best-btn">Watch how they did it</button>`;
    $("daily-best-btn").addEventListener("click", () => openBoard(puzzle.date, top[0].pid, data));
  } catch {}
}

function renderReplayResult() {
  const wrap = $("daily-wrap");
  const ranked = dailyResult?.score ?? null;
  const diff = ranked === null ? null : result.score - ranked;
  wrap.innerHTML = `
    ${headerHTML()}
    <div class="card" style="gap:0.75rem;align-items:center">
      <div class="d-big">${result.score}</div>
      <div style="font-size:0.75rem;color:#64748b;text-transform:uppercase;letter-spacing:0.1em">replay points · ${plural(result.words.length, "word")}</div>
      ${ranked !== null ? `<div style="font-size:0.9rem;color:${diff > 0 ? "#22c55e" : "#94a3b8"};font-weight:bold;text-align:center">${diff > 0 ? `${diff} more than your ranked score of ${ranked}!` : diff === 0 ? `Same as your ranked score of ${ranked}` : `Your ranked score was ${ranked}`}</div>` : ""}
      <div class="d-share">${esc(result.share)}</div>
      <div class="d-row" style="width:100%">
        <button class="btn btn-primary" onclick="dailyReplay()">Try again</button>
        <button class="btn btn-secondary" onclick="dailyBackToResult()">Back to results</button>
      </div>
    </div>
    ${wordsCard(result.words)}`;
}

function renderEndlessResult() {
  const wrap = $("daily-wrap");
  const r = result;
  const lbTabs = ["week", "all"].map(p => `<button class="size-pill${endlessLb.period === p ? " selected" : ""}" onclick="endlessLbPeriod('${p}')">${p === "week" ? "This week" : "All time"}</button>`).join("");
  let note = "";
  if (!r.complete) note = "Place every letter to get on the leaderboard.";
  else if (!r.inTime) note = "That run went over the Blitz time limit, so it isn't ranked.";
  else if (!r.ranked) note = "Claim at least one word to get on the leaderboard.";
  wrap.innerHTML = `
    ${headerHTML()}
    <div class="card" style="gap:0.75rem;align-items:center">
      ${r.isPB ? `<span class="d-badge" style="background:rgba(234,179,8,0.15);color:#facc15;border:1px solid #a16207">★ New personal best</span>` : ""}
      <div class="d-big">${r.score}</div>
      <div style="font-size:0.75rem;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;text-align:center">points · ${plural(r.words.length, "word")} · best ${r.best ?? r.score}</div>
      ${r.ranked && (r.rankWeek || r.rankAll) ? `<div style="font-size:0.85rem;color:#cbd5e1">${r.rankWeek ? `#${r.rankWeek} this week` : ""}${r.rankWeek && r.rankAll ? " · " : ""}${r.rankAll ? `#${r.rankAll} all time` : ""}</div>` : ""}
      ${note ? `<div class="d-note">${note}</div>` : ""}
      <div class="d-share">${esc(r.share ?? "")}</div>
      <div class="d-row" style="width:100%">
        <button class="btn btn-primary" onclick="endlessNew()">New puzzle</button>
        <button class="btn btn-secondary" onclick="dailyShare()">Share</button>
      </div>
      ${mode === "classic" ? `<button class="btn btn-secondary" style="width:100%" onclick="endlessSwitch('blitz')">Try ⚡ Blitz</button>` : `<button class="btn btn-secondary" style="width:100%" onclick="endlessSwitch('classic')">Try Classic (untimed)</button>`}
    </div>
    ${wordsCard(r.words)}
    <div class="card" style="gap:0.4rem">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;flex-wrap:wrap">
        <h2 style="margin:0">${mode === "blitz" ? "Blitz" : "Classic"} leaders</h2>
        <div class="pill-group">${lbTabs}</div>
      </div>
      <div id="endless-lb"><p class="placeholder">Loading…</p></div>
    </div>`;
  loadEndlessLb();
}

async function loadEndlessLb() {
  try {
    if (!endlessLb.data || endlessLb.data.period !== endlessLb.period || endlessLb.data.mode !== mode) {
      endlessLb.data = await (await fetch(`${statsUrl()}?endlesslb=${mode}&period=${endlessLb.period}`)).json();
    }
    const el = $("endless-lb");
    if (!el) return;
    const myPid = ctx.myPid?.();
    el.innerHTML = (endlessLb.data.top ?? []).slice(0, 10).map((e, i) =>
      `<div class="d-lb-row${e.pid === myPid ? " me" : ""}"><span>${i + 1}. ${esc(e.name)}${e.pid === myPid ? " ★" : ""}</span><span>${e.score} pts</span></div>`).join("")
      || `<p class="placeholder">No scores yet — yours could be first!</p>`;
  } catch {
    const el = $("endless-lb");
    if (el) el.innerHTML = `<p class="placeholder">Couldn't load the leaderboard.</p>`;
  }
}

window.endlessLbPeriod = (p) => { endlessLb.period = p; render(); };

// ── Board viewer (someone's finished daily, replayed move by move) ─────────
async function fetchBoard(date, pid) {
  try {
    const res = await post({ type: "daily_board", uuid: ctx.getUUID(), date, pid });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}
function boardAt(data, step) {
  const n = data.puzzle.size;
  const g = Array.from({ length: n }, () => Array(n).fill(null));
  for (const s of data.puzzle.starters) g[s.r][s.c] = { letter: s.letter, starter: true };
  const used = new Set();
  let k = 0, lastWord = null, lastCell = null;
  for (const m of data.moves.slice(0, step)) {
    if (m.place) { g[m.place.r][m.place.c] = { letter: data.puzzle.letters[k++] }; lastCell = `${m.place.r},${m.place.c}`; lastWord = null; }
    else if (m.claim) { for (const p of m.claim.path) used.add(`${p.r},${p.c}`); lastWord = m.claim.word; lastCell = null; }
  }
  return { g, used, lastWord, lastCell, words: data.moves.slice(0, step).filter(m => m.claim).map(m => m.claim.word) };
}
async function openBoard(date, pid, preloaded = null) {
  stopViewer();
  view = "board";
  const v = viewer = { date, data: preloaded, step: 0, timer: null };
  render();
  $("daily-screen").scrollTop = 0;
  if (!preloaded) {
    v.data = await fetchBoard(date, pid);
    if (viewer !== v || view !== "board") return;
    if (!v.data) { v.error = true; return render(); }
  }
  ctx.track("board_view");
  playViewer();
}
function stopViewer() { if (viewer?.timer) clearInterval(viewer.timer); if (viewer) viewer.timer = null; }
function playViewer() {
  stopViewer();
  if (!viewer?.data) return;
  if (viewer.step >= viewer.data.moves.length) viewer.step = 0;
  viewer.timer = setInterval(() => {
    if (!viewer || view !== "board") return stopViewer();
    viewer.step++;
    if (viewer.step >= viewer.data.moves.length) { viewer.step = viewer.data.moves.length; stopViewer(); }
    render();
  }, 380);
  render();
}
window.dailyViewerPlay = () => { if (viewer?.timer) { stopViewer(); render(); } else playViewer(); };
window.dailyViewerEnd = () => { stopViewer(); viewer.step = viewer.data.moves.length; render(); };
window.dailyViewerBack = () => { stopViewer(); viewer = null; view = "result"; render(); };

function renderBoardViewer() {
  const wrap = $("daily-wrap");
  const back = `<button class="btn btn-secondary" style="width:100%" onclick="dailyViewerBack()">← Back to results</button>`;
  if (!viewer?.data) {
    wrap.innerHTML = `${headerHTML()}<div class="card" style="gap:0.75rem"><p class="placeholder">${viewer?.error ? "That board isn't available." : "Loading board…"}</p>${back}</div>`;
    return;
  }
  const d = viewer.data;
  const total = d.moves.length;
  const { g, used, lastWord, lastCell, words } = boardAt(d, viewer.step);
  const pts = words.reduce((s, w) => s + w.length, 0);
  wrap.innerHTML = `
    ${headerHTML()}
    <div class="card" style="gap:0.75rem">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:0.5rem">
        <h2 style="margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.name)}'s board</h2>
        <span style="font-weight:900;color:var(--clr-primary-light);white-space:nowrap">${pts} / ${d.score} pts</span>
      </div>
      ${gridHTML(g, used, cellSize(), { freshKey: lastCell })}
      <div class="d-status" style="color:${lastWord ? "#22c55e" : "#94a3b8"}">${lastWord ? `${esc(lastWord)} +${lastWord.length}` : viewer.step >= total ? "Final board" : `Move ${viewer.step} of ${total}`}</div>
      <div class="d-timer"><div style="width:${total ? (viewer.step / total) * 100 : 100}%;background:var(--clr-primary)"></div></div>
      <div class="d-row">
        <button class="btn btn-primary" onclick="dailyViewerPlay()">${viewer.timer ? "Pause" : viewer.step >= total ? "Replay ▶" : "Play ▶"}</button>
        <button class="btn btn-secondary" onclick="dailyViewerEnd()" ${viewer.step >= total ? "disabled" : ""}>Skip to end</button>
      </div>
    </div>
    ${wordsCard(words, "Their words")}
    ${back}`;
}

// ── Themes picker ──────────────────────────────────────────────────────────
let themesReturn = "play";
window.dailyThemes = () => { if (view === "themes") return; themesReturn = view; view = "themes"; render(); };
window.dailyThemesBack = () => { view = themesReturn; render(); };
function renderThemes() {
  const wrap = $("daily-wrap");
  const owned = ownedThemes(), cur = currentTheme();
  const cost = ctx.themeCost?.() ?? 150;
  wrap.innerHTML = `
    ${headerHTML()}
    <div class="card" style="gap:0.6rem">
      <div style="display:flex;justify-content:space-between;align-items:baseline"><h2 style="margin:0">Tile themes</h2><span style="font-size:0.8rem;color:#eab308">${ctx.getCoins?.() ?? 0} coins</span></div>
      <p class="d-note" style="text-align:left;margin:0">Change how your puzzle boards look. Themes are just for looks, and they're yours to keep.</p>
      ${THEMES.map(t => {
        const has = owned.has(t.id);
        return `<button class="d-theme${t.id === cur ? " on" : ""}" onclick="dailyPickTheme('${t.id}')">
          <span class="d-swatch"><span style="background:${t.swatch[0]};color:${t.swatch[1]};border:1px solid ${t.swatch[2]}">A</span><span style="background:${t.swatch[2]}55;border:1px solid ${t.swatch[2]};color:${t.swatch[1]}">B</span></span>
          <span style="flex:1;font-weight:bold">${t.name}</span>
          <span style="font-size:0.78rem;color:${t.id === cur ? "var(--clr-primary-light)" : has ? "#94a3b8" : "#eab308"}">${t.id === cur ? "In use" : has ? "Use" : `${cost} coins`}</span>
        </button>`;
      }).join("")}
      <button class="btn btn-secondary" style="width:100%" onclick="dailyThemesBack()">Done</button>
    </div>`;
}
window.dailyPickTheme = async (id) => {
  if (!ownedThemes().has(id)) {
    const cost = ctx.themeCost?.() ?? 150;
    if (!confirm(`Unlock the ${THEMES.find(t => t.id === id).name} theme for ${cost} coins?`)) return;
    try {
      const res = await post({ type: "spend", item: "tileTheme", theme: id, uuid: ctx.getUUID() });
      const data = await res.json();
      if (!res.ok) {
        if (typeof data.balance === "number") ctx.onCoins?.(data.balance);
        return alert(data.error === "insufficient_coins" ? `Not enough coins (need ${data.cost}, have ${data.balance}). Finish daily puzzles and games to earn more.` : "Couldn't unlock that theme — please try again.");
      }
      ctx.onCoins?.(data.coins, { [`theme_${id}`]: 8.64e15 });
      ctx.track("theme_buy");
    } catch { return alert("Couldn't reach the coin bank — please try again."); }
  }
  try { localStorage.setItem("lexterra_tile_theme", id); } catch {}
  render();
};

// ── Opening & switching ────────────────────────────────────────────────────
function show() {
  injectStyles();
  $("daily-screen").style.display = "block";
  document.body.style.overflow = "hidden";
}
function loading(text) { $("daily-wrap").innerHTML = `<p class="placeholder" style="padding-top:3rem">${text}</p>`; }
function failed(text) { $("daily-wrap").innerHTML = `<div style="padding-top:3rem;text-align:center;display:flex;flex-direction:column;gap:1rem;align-items:center"><p class="placeholder">${esc(text)}</p><button class="btn btn-secondary" onclick="closeDaily()">Close</button></div>`; }

export async function openDaily(context) {
  ctx = context;
  show();
  stopBlitz(); stopViewer();
  kind = "daily"; view = "play"; result = null; viewer = null;
  loading("Loading today's puzzle…");
  try {
    const [data, prof] = await Promise.all([
      fetch(`${statsUrl()}?daily=1`).then(r => r.json()),
      post({ type: "profile", uuid: ctx.getUUID() }).then(r => r.json()),
    ]);
    if (!data.puzzle) throw new Error();
    puzzle = data.puzzle;
    ctx.nextAt = data.nextAt;
    dailyResult = prof.dailyMine ? { ...prof.dailyMine, players: data.players } : null;
    result = dailyResult;
    if (result) view = "result";
    else { restore(); if (!moves.length) ctx.track("daily_start"); }
    render();
  } catch {
    failed("Couldn't load today's puzzle.");
  }
}

window.dailyReplay = () => {
  kind = "replay"; view = "play"; result = null;
  forget(); resetBoard();
  ctx.track("daily_replay");
  render();
  $("daily-screen").scrollTop = 0;
};
window.dailyBackToResult = () => { kind = "daily"; result = dailyResult; view = "result"; render(); };

export async function openEndless(context, m, fresh = false) {
  ctx = context;
  show();
  stopBlitz(); stopViewer();
  kind = "endless"; mode = m === "blitz" ? "blitz" : "classic"; view = "play"; result = null; viewer = null;
  loading(mode === "blitz" ? "Dealing a Blitz board…" : "Dealing a fresh board…");
  try {
    const res = await post({ type: "endless_start", uuid: ctx.getUUID(), mode, fresh });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error === "too_many_today" ? "You've played a lot of puzzles today — take a break and come back tomorrow!" : "Couldn't deal a puzzle.");
    puzzle = data.puzzle;
    blitzSecs = data.blitzSecs ?? ctx.blitzSecs?.() ?? 10;
    restore();
    if (!data.resumed) ctx.track("endless_start");
    if (mode === "blitz") startTileClock();
    render();
    $("daily-screen").scrollTop = 0;
  } catch (e) {
    failed(e.message || "Couldn't deal a puzzle.");
  }
}
window.endlessNew = () => openEndless(ctx, mode, true);
window.endlessSwitch = (m) => openEndless(ctx, m, true);

window.closeDaily = () => {
  if (isBlitz() && !result && view === "play" && moves.length && !confirm("Leave this Blitz run? It won't count.")) return;
  const el = $("daily-screen");
  if (el) el.style.display = "none";
  document.body.style.overflow = "";
  clearInterval(countdownTimer);
  stopBlitz(); stopViewer();
  ctx?.onClose?.();
};

window.addEventListener("resize", () => { if ($("daily-screen")?.style.display === "block" && ((view === "play" && !result) || view === "board")) render(); });
