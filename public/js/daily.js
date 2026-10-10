// Lexterra — Daily puzzle screen.
// Same board for everyone each UTC day: place the queued letters one at a time, claim words in
// straight lines. Words score their length. The server replays the moves to confirm the score.

const MIN_LEN = 3;
let ctx = null;          // { host, getUUID, getName, track, isWord, isBanned, onResult, toast }
let puzzle = null;       // { date, number, size, minLen, starters, letters }
let grid = [];           // [r][c] → { letter, starter? } | null
let moves = [];          // [{ place:{r,c} } | { claim:{ word, path } }]
let claimed = [];        // [{ word, path }]
let next = 0;            // index into puzzle.letters
let claimMode = false, claimStart = null;
let result = null;       // server result once submitted
let submitting = false;
let countdownTimer = null;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const storeKey = () => `lexterra_daily_${puzzle.date}`;

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
  if (m.place) {
    grid[m.place.r][m.place.c] = { letter: puzzle.letters[next++] };
  } else if (m.claim) {
    claimed.push({ word: m.claim.word, path: m.claim.path });
  }
  moves.push(m);
}
function save() { try { localStorage.setItem(storeKey(), JSON.stringify(moves)); } catch {} }
function restore() {
  resetBoard();
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey()) || "[]");
    for (const m of saved) {
      if (m.place && next < puzzle.letters.length && !grid[m.place.r]?.[m.place.c]) applyMove(m);
      else if (m.claim && checkClaim(m.claim.path).ok) applyMove(m);
    }
  } catch { resetBoard(); }
}
const score = () => claimed.reduce((s, c) => s + c.word.length, 0);

// ── Rendering ───────────────────────────────────────────────────────────────
function injectStyles() {
  if ($("daily-styles")) return;
  const st = document.createElement("style");
  st.id = "daily-styles";
  st.textContent = `
    #daily-screen { position:fixed; inset:0; background:#0f172a; z-index:900; overflow-y:auto; display:none; }
    #daily-screen .d-wrap { max-width:420px; margin:0 auto; padding:1rem; display:flex; flex-direction:column; gap:0.9rem; }
    #daily-screen .d-head { display:flex; align-items:center; justify-content:space-between; }
    #daily-screen .d-title { font-size:1.15rem; font-weight:900; letter-spacing:0.08em; color:var(--clr-primary-light); }
    #daily-screen .d-sub { font-size:0.72rem; color:#64748b; text-transform:uppercase; letter-spacing:0.1em; }
    #daily-screen .d-close { background:none; border:none; color:#64748b; font-size:1.4rem; cursor:pointer; padding:0.2rem 0.4rem; }
    #daily-screen .d-grid { display:grid; gap:4px; margin:0 auto; }
    #daily-screen .d-cell { aspect-ratio:1; border:2px solid #1e3a5f; border-radius:6px; display:flex; align-items:center; justify-content:center;
      font-weight:900; font-size:var(--dfs); color:#e2e8f0; background:#0c1628; cursor:pointer; user-select:none; transition:background 0.12s, border-color 0.12s;
      text-shadow:-2px -2px 0 #000,2px -2px 0 #000,-2px 2px 0 #000,2px 2px 0 #000; }
    #daily-screen .d-cell.starter { color:#fcd34d; }
    #daily-screen .d-cell.used { background:rgba(34,197,94,0.18); border-color:#166534; }
    #daily-screen .d-cell.empty:hover { border-color:var(--clr-primary); }
    #daily-screen .d-cell.sel { border-color:var(--clr-primary) !important; background:rgba(var(--clr-primary-rgb),0.25); }
    #daily-screen .d-cell.path-ok { border-color:#22c55e !important; background:rgba(34,197,94,0.25); }
    #daily-screen .d-cell.path-bad { border-color:#ef4444 !important; background:rgba(239,68,68,0.18); }
    #daily-screen .d-queue { display:flex; align-items:center; gap:0.5rem; justify-content:center; }
    #daily-screen .d-tile { width:48px; height:48px; border-radius:8px; background:var(--clr-primary); color:white; font-weight:900; font-size:1.6rem;
      display:flex; align-items:center; justify-content:center; text-shadow:-2px -2px 0 #000,2px -2px 0 #000,-2px 2px 0 #000,2px 2px 0 #000; }
    #daily-screen .d-tile.small { width:30px; height:30px; font-size:0.95rem; background:#1e293b; border:1px solid #334155; opacity:0.8; }
    #daily-screen .d-status { min-height:1.2em; text-align:center; font-size:0.82rem; color:#94a3b8; }
    #daily-screen .d-row { display:flex; gap:0.5rem; }
    #daily-screen .d-row .btn { flex:1; padding:0.6rem 0.5rem; font-size:0.9rem; }
    #daily-screen .d-words { display:flex; flex-wrap:wrap; gap:0.35rem; }
    #daily-screen .d-word { padding:0.2rem 0.5rem; background:#0f172a; border-left:3px solid #22c55e; border-radius:6px; font-size:0.82rem; color:#e2e8f0; }
    #daily-screen .d-big { font-size:2.4rem; font-weight:900; color:var(--clr-primary-light); text-align:center; line-height:1; }
    #daily-screen .d-share { white-space:pre; font-size:1.25rem; line-height:1.15; text-align:center; letter-spacing:0.05em; }
    #daily-screen .d-lb-row { display:flex; justify-content:space-between; font-size:0.85rem; padding:0.3rem 0; border-bottom:1px solid #1e293b; color:#cbd5e1; }
    #daily-screen .d-lb-row.me { color:var(--clr-primary-light); font-weight:bold; }
  `;
  document.head.appendChild(st);
  const el = document.createElement("div");
  el.id = "daily-screen";
  el.innerHTML = `<div class="d-wrap" id="daily-wrap"></div>`;
  document.body.appendChild(el);
}

function cellSize() {
  const w = Math.min(420, window.innerWidth) - 32 - (puzzle.size - 1) * 4;
  return Math.max(40, Math.min(72, Math.floor(w / puzzle.size)));
}

function render() {
  const wrap = $("daily-wrap");
  if (!wrap || !puzzle) return;
  if (result) return renderResult();
  const remaining = puzzle.letters.length - next;
  const cs = cellSize();
  const usedSet = new Set(claimed.flatMap(c => c.path.map(p => `${p.r},${p.c}`)));
  const queue = puzzle.letters.slice(next, next + 4);
  wrap.innerHTML = `
    <div class="d-head">
      <div><div class="d-title">DAILY #${puzzle.number}</div><div class="d-sub">${esc(puzzle.date)} · same board for everyone</div></div>
      <button class="d-close" onclick="closeDaily()" aria-label="Close">✕</button>
    </div>
    <div class="card" style="padding:1rem;gap:0.75rem">
      <div class="d-queue">
        ${queue.length ? `<span style="font-size:0.72rem;color:#64748b;text-transform:uppercase;letter-spacing:0.08em">Next</span>
          <div class="d-tile">${esc(queue[0])}</div>${queue.slice(1).map(l => `<div class="d-tile small">${esc(l)}</div>`).join("")}
          <span style="font-size:0.72rem;color:#64748b">${remaining} left</span>`
        : `<span style="font-size:0.85rem;color:#22c55e;font-weight:bold">All letters placed — claim any last words, then finish!</span>`}
      </div>
      <div class="d-grid" style="grid-template-columns:repeat(${puzzle.size},${cs}px);--dfs:${Math.round(cs * 0.62)}px">
        ${grid.map((row, r) => row.map((cell, c) => `<div class="d-cell${cell ? (cell.starter ? " starter" : "") : " empty"}${usedSet.has(`${r},${c}`) ? " used" : ""}" data-r="${r}" data-c="${c}">${cell ? esc(cell.letter) : ""}</div>`).join("")).join("")}
      </div>
      <div class="d-status" id="daily-status">${claimMode ? (claimStart ? "Now tap the last letter of the word" : "Tap the first letter of a word") : (remaining ? "Tap an empty square to place the next letter" : "")}</div>
      <div class="d-row">
        <button class="btn ${claimMode ? "btn-primary" : "btn-secondary"}" onclick="dailyToggleClaim()">${claimMode ? "Cancel claim" : "Claim a word"}</button>
        <button class="btn btn-secondary" onclick="dailyFinish()" ${submitting ? "disabled" : ""}>${submitting ? "Submitting…" : "Finish"}</button>
      </div>
    </div>
    <div class="card" style="padding:1rem;gap:0.5rem">
      <div style="display:flex;justify-content:space-between;align-items:baseline"><h2 style="margin:0">Your words</h2><span style="font-weight:900;color:var(--clr-primary-light)">${score()} pts</span></div>
      <div class="d-words">${claimed.length ? claimed.map(c => `<span class="d-word">${esc(c.word)} <span style="color:#64748b">+${c.word.length}</span></span>`).join("") : `<span style="font-size:0.8rem;color:#64748b">No words yet — words go across, down or diagonally, and score one point per letter.</span>`}</div>
    </div>`;
  wrap.querySelectorAll(".d-cell").forEach(el => el.addEventListener("click", () => onCell(+el.dataset.r, +el.dataset.c)));
}

function setStatus(text, color = "#94a3b8") { const el = $("daily-status"); if (el) { el.textContent = text; el.style.color = color; } }

function onCell(r, c) {
  if (result || submitting) return;
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
      setTimeout(render, 700);
      return setStatus(path ? check.why : "Words must be in a straight line", "#ef4444");
    }
    applyMove({ claim: { word: check.word, path } });
    claimMode = false; claimStart = null; save();
    render();
    return setStatus(`${check.word} +${check.word.length}!`, "#22c55e");
  }
  if (grid[r][c]) return setStatus("That square already has a letter — tap “Claim a word” to claim", "#eab308");
  if (next >= puzzle.letters.length) return setStatus("No letters left — claim words or finish", "#eab308");
  applyMove({ place: { r, c } });
  save();
  render();
}

window.dailyToggleClaim = () => { claimMode = !claimMode; claimStart = null; render(); };

window.dailyFinish = async () => {
  if (submitting || result) return;
  const remaining = puzzle.letters.length - next;
  const msg = remaining > 0
    ? `You still have ${remaining} letter${remaining === 1 ? "" : "s"} to place. Finish anyway? You only get one go each day.`
    : `Submit your score of ${score()}? You only get one go each day.`;
  if (!confirm(msg)) return;
  submitting = true; render();
  try {
    const res = await fetch(`https://${ctx.host}/parties/stats/main`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "daily_submit", uuid: ctx.getUUID(), name: ctx.getName(), date: puzzle.date, moves }),
    });
    const data = await res.json();
    if (!res.ok) {
      const why = {
        wrong_day: "This puzzle has ended — a new one is ready.",
        empty: "Place at least one letter before finishing.",
        too_many_today: "Too many daily results from this network today — try again tomorrow.",
        rate_limited: "Slow down a moment, then try again.",
      }[data.error];
      throw new Error(why ?? `Couldn't submit (${data.error}${data.word ? `: ${data.word}` : ""}).`);
    }
    result = data;
    try { localStorage.removeItem(storeKey()); } catch {}
    ctx.track("daily_done");
    ctx.onResult?.(data);
  } catch (e) {
    alert(e.message || "Network error — your progress is saved, try again.");
  } finally {
    submitting = false;
    render();
  }
};

function shareText() {
  const streak = result.streak?.current ?? ctx.streak?.() ?? 0;
  return `Lexterra Daily #${puzzle.number} — ${result.score} pts, ${result.words.length} word${result.words.length === 1 ? "" : "s"}${streak > 1 ? `\n🔥 ${streak}-day streak` : ""}\n${result.share}\nlexterragame.com`;
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

async function renderResult() {
  const wrap = $("daily-wrap");
  const streak = result.streak?.current ?? ctx.streak?.() ?? 0;
  wrap.innerHTML = `
    <div class="d-head">
      <div><div class="d-title">DAILY #${puzzle.number}</div><div class="d-sub">${esc(puzzle.date)}</div></div>
      <button class="d-close" onclick="closeDaily()" aria-label="Close">✕</button>
    </div>
    <div class="card" style="padding:1.25rem;gap:0.75rem;align-items:center">
      <div class="d-big">${result.score}</div>
      <div style="font-size:0.75rem;color:#64748b;text-transform:uppercase;letter-spacing:0.1em">points · ${result.words.length} word${result.words.length === 1 ? "" : "s"}${result.rank ? ` · #${result.rank} of ${result.players}` : ""}</div>
      ${streak ? `<div style="font-size:0.95rem;color:#f97316;font-weight:bold">🔥 ${streak}-day streak</div>` : ""}
      ${result.coinsEarned ? `<div style="font-size:0.8rem;color:#eab308">+${result.coinsEarned} coins</div>` : ""}
      <div class="d-share">${esc(result.share ?? "")}</div>
      <button class="btn btn-primary" style="width:100%" onclick="dailyShare()">Share result</button>
      <div style="font-size:0.78rem;color:#64748b" id="daily-next"></div>
    </div>
    <div class="card" style="padding:1rem;gap:0.4rem">
      <h2 style="margin:0 0 0.25rem">Your words</h2>
      <div class="d-words">${result.words.map(w => `<span class="d-word">${esc(w)} <span style="color:#64748b">+${w.length}</span></span>`).join("") || `<span style="font-size:0.8rem;color:#64748b">No words this time.</span>`}</div>
    </div>
    <div class="card" style="padding:1rem;gap:0.2rem">
      <h2 style="margin:0 0 0.25rem">Today's top scores</h2>
      <div id="daily-lb"><p class="placeholder">Loading…</p></div>
    </div>`;
  const tick = () => {
    const el = $("daily-next"); if (!el) return;
    const ms = Math.max(0, (ctx.nextAt ?? 0) - Date.now());
    el.textContent = `Next puzzle in ${Math.floor(ms / 3600000)}h ${Math.floor(ms / 60000) % 60}m`;
  };
  tick(); clearInterval(countdownTimer); countdownTimer = setInterval(tick, 30000);
  try {
    const lb = await (await fetch(`https://${ctx.host}/parties/stats/main?dailylb=${encodeURIComponent(puzzle.date)}`)).json();
    const myPid = ctx.myPid?.();
    const el = $("daily-lb");
    if (el) el.innerHTML = (lb.top ?? []).slice(0, 10).map((e, i) =>
      `<div class="d-lb-row${e.pid === myPid ? " me" : ""}"><span>${i + 1}. ${esc(e.name)}${e.pid === myPid ? " ★" : ""}</span><span>${e.score} pts</span></div>`).join("") || `<p class="placeholder">You're the first today!</p>`;
  } catch {}
}

// ── Public API ──────────────────────────────────────────────────────────────
export async function openDaily(context) {
  ctx = context;
  injectStyles();
  $("daily-screen").style.display = "block";
  document.body.style.overflow = "hidden";
  $("daily-wrap").innerHTML = `<p class="placeholder" style="padding-top:3rem">Loading today's puzzle…</p>`;
  try {
    const base = `https://${ctx.host}/parties/stats/main`;
    const [data, prof] = await Promise.all([
      fetch(`${base}?daily=1`).then(r => r.json()),
      fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "profile", uuid: ctx.getUUID() }) }).then(r => r.json()),
    ]);
    if (!data.puzzle) throw new Error();
    puzzle = data.puzzle;
    ctx.nextAt = data.nextAt;
    result = prof.dailyMine ? { ...prof.dailyMine, players: data.players } : null;
    if (!result) { restore(); if (!moves.length) ctx.track("daily_start"); }
    render();
  } catch {
    $("daily-wrap").innerHTML = `<p class="placeholder" style="padding-top:3rem">Couldn't load today's puzzle. <button class="btn btn-secondary" onclick="closeDaily()">Close</button></p>`;
  }
}

window.closeDaily = () => {
  const el = $("daily-screen");
  if (el) el.style.display = "none";
  document.body.style.overflow = "";
  clearInterval(countdownTimer);
  ctx?.onClose?.();
};

window.addEventListener("resize", () => { if ($("daily-screen")?.style.display === "block" && !result) render(); });
