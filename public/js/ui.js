// Lexterra — home hub UI: tabs, sheets, player-name prompt, appearance (light/dark) and the
// small status chips on the mode cards. Game logic lives in index.html; this file only wraps
// a few of its window.* entry points and listens for the lx:* events it dispatches.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

// ── Tabs ───────────────────────────────────────────────────────────────────
const TABS = ["play", "games", "ranks", "me"];
let currentTab = "play";
window.setTab = function (tab, { scroll = true } = {}) {
  if (!TABS.includes(tab)) tab = "play";
  currentTab = tab;
  for (const t of TABS) {
    $(`tab-${t}`)?.classList.toggle("active", t === tab);
    document.querySelector(`.tab[data-tab="${t}"]`)?.classList.toggle("active", t === tab);
    document.querySelector(`.tab[data-tab="${t}"]`)?.setAttribute("aria-current", t === tab ? "page" : "false");
  }
  if (scroll) window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
};
window.openFriends = () => setTab("games");

// ── Sheets ─────────────────────────────────────────────────────────────────
let openSheetId = null, sheetReturnFocus = null;
window.openSheet = function (id) {
  closeSheet(true);
  const el = $(`sheet-${id}`);
  if (!el) return;
  sheetReturnFocus = document.activeElement;
  el.classList.add("open");
  openSheetId = id;
  document.body.style.overflow = "hidden";
  setTimeout(() => el.querySelector("input, .seg-tab.selected, button:not(.icon-btn)")?.focus({ preventScroll: true }), 60);
};
window.closeSheet = function (silent = false) {
  if (!openSheetId) return;
  // Closing the name sheet without saving puts the last saved name back
  if (openSheetId === "name" && nameInput && !nameInput.value.trim()) nameInput.value = store.get("lexterra_name") || "";
  $(`sheet-${openSheetId}`)?.classList.remove("open");
  openSheetId = null;
  document.body.style.overflow = "";
  if (!silent) sheetReturnFocus?.focus?.({ preventScroll: true });
};
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openSheetId) closeSheet(); });

// ── Player name (asked for the first time it's needed) ─────────────────────
const nameInput = $("player-name");
// The game reads the name from the input, so that's the source of truth here too
const currentName = () => (nameInput?.value.trim().toUpperCase() || "");
const hasName = () => !!currentName() && currentName() !== "PLAYER";
let afterName = null;

window.openNameSheet = function (then) {
  afterName = typeof then === "function" ? then : null;
  $("name-sheet-btn").textContent = afterName ? "Continue" : "Save";
  $("name-sheet-error").style.display = "none";
  openSheet("name");
};
window.saveNameSheet = function () {
  const v = nameInput.value.trim().toUpperCase();
  const err = $("name-sheet-error");
  if (!v || v === "PLAYER") { err.textContent = "Pick a name to continue."; err.style.display = ""; nameInput.focus(); return; }
  nameInput.value = v;
  store.set("lexterra_name", v);
  nameInput.dispatchEvent(new Event("blur")); // index.html syncs the name to the server on blur
  closeSheet(true);
  refreshIdentity();
  const next = afterName; afterName = null;
  next?.();
};

// Anything that puts the player's name in front of others asks for one first
for (const fn of ["createGame", "joinGame", "joinPublicGame", "createAsyncGame", "startPractice", "openDailyScreen", "openEndlessScreen"]) {
  const orig = window[fn];
  if (typeof orig !== "function") continue;
  window[fn] = function (...args) {
    if (!hasName()) return openNameSheet(() => window[fn](...args));
    closeSheet(true);
    return orig.apply(this, args);
  };
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
function refreshIdentity() {
  const n = hasName() ? currentName() : "";
  $("greet-title").textContent = n ? `${greeting()}, ${n.charAt(0) + n.slice(1).toLowerCase()}` : "Welcome to Lexterra";
  $("greet-sub").textContent = n ? "What are we playing today?" : "Word games you can play solo, live, or over days.";
  $("greet-name-btn").textContent = n ? "Change name" : "Set name";
  $("me-name").textContent = n || "Player";
  $("me-avatar").textContent = (n || "?").charAt(0);
}

// ── Appearance ─────────────────────────────────────────────────────────────
function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === "light" || choice === "dark") root.dataset.theme = choice; else delete root.dataset.theme;
  document.querySelectorAll("[data-theme-choice]").forEach(b => b.classList.toggle("selected", b.dataset.themeChoice === (choice || "system")));
  const dark = choice === "dark" || (choice !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0E1116" : "#F7F5F0");
}
window.setThemeChoice = function (choice) {
  if (choice === "system") store.del("lexterra_theme"); else store.set("lexterra_theme", choice);
  applyTheme(choice);
};
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => applyTheme(store.get("lexterra_theme") || "system"));

// ── Live sheet ─────────────────────────────────────────────────────────────
const origSetVisibility = window.setVisibility;
window.setVisibility = function (pub) {
  origSetVisibility?.(pub);
  $("vis-hint").textContent = pub ? "Anyone can find and join your room." : "Only people with your room code can join.";
};

// Mirror the open-games list into the Games tab and show a count on the Live card
window.addEventListener("lx:publicgames", (e) => {
  const n = e.detail?.count ?? 0;
  $("live-status").textContent = n ? `${n} open room${n === 1 ? "" : "s"}` : "Play now";
  const mirror = $("games-tab-public");
  if (mirror) mirror.innerHTML = n ? $("open-games-list").innerHTML : `<p class="placeholder" style="padding:8px 0">No open rooms right now — start one and invite a friend.</p>`;
  if (mirror) mirror.style.cssText = "display:flex;flex-direction:column;gap:8px";
});

// ── My games → your-turn strip, tab badge, Friends card status ─────────────
window.addEventListener("lx:mygames", (e) => {
  const games = (e.detail ?? []).filter(g => /^[A-Z0-9]{4,8}$/.test(g.roomId ?? ""));
  const mine = currentName();
  const waiting = games.filter(g => g.yourTurn && g.phase !== "ended" && g.phase !== "left");
  const active = games.filter(g => g.phase !== "ended" && g.phase !== "left");
  const badge = $("games-badge");
  badge.textContent = waiting.length;
  badge.classList.toggle("on", waiting.length > 0);
  const status = $("friends-status");
  status.textContent = waiting.length ? `${waiting.length} waiting on you` : active.length ? `${active.length} game${active.length === 1 ? "" : "s"} going` : "Start a game";
  status.classList.toggle("turn", waiting.length > 0);
  const strip = $("yourturn-strip");
  strip.style.display = waiting.length ? "flex" : "none";
  strip.innerHTML = waiting.map(g => {
    const others = (g.players ?? []).filter(n => n !== mine);
    const who = others.length ? others.join(", ") : "Your game";
    return `<button class="yt-item" data-room="${esc(g.roomId)}"><span class="yt-avatar">${esc(who.charAt(0) || "?")}</span><span class="yt-text"><b>vs ${esc(who)}</b><span>Your turn</span></span></button>`;
  }).join("");
  strip.querySelectorAll("[data-room]").forEach(b => b.addEventListener("click", () => window.openAsyncGame?.(b.dataset.room)));
});

// ── Header stats → Me tab ──────────────────────────────────────────────────
window.addEventListener("lx:stats", (e) => {
  const { xp = 0, coins = 0, level = 1, streak = 0 } = e.detail ?? {};
  const floor = 25 * (level - 1) ** 2, ceil = 25 * level ** 2;
  $("me-level").textContent = `Level ${level} · ${xp.toLocaleString()} XP`;
  $("me-xp-bar").style.width = `${Math.max(3, Math.min(100, ((xp - floor) / (ceil - floor)) * 100))}%`;
  $("me-coins").textContent = coins.toLocaleString();
  $("me-streak").textContent = streak;
  $("me-xp").textContent = xp.toLocaleString();
});

// ── Ranks tab: Daily · Endless · Matches ───────────────────────────────────
let rankView = "daily", endlessMode = "classic", endlessPeriod = "week", myPidCache = null;
async function myPid() {
  if (myPidCache) return myPidCache;
  const uuid = store.get("lexterra_uuid");
  if (!uuid || !crypto.subtle) return null;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(uuid));
  return (myPidCache = Array.from(new Uint8Array(buf).slice(0, 8), b => b.toString(16).padStart(2, "0")).join(""));
}
async function rankRows(list, el, scoreKey = "score", unit = "pts") {
  const me = await myPid();
  el.innerHTML = list.length ? list.slice(0, 20).map((e, i) =>
    `<div class="rk-row${e.pid === me ? " me" : ""}"><span class="rk-pos">${i + 1}</span><span class="rk-name">${esc(e.name)}${e.pid === me ? " (you)" : ""}</span><span class="rk-score">${e[scoreKey]}<span class="hc-sub" style="font-family:var(--font-ui);font-weight:500"> ${unit}</span></span></div>`).join("")
    : `<p class="placeholder">No scores yet — yours could be first!</p>`;
}
async function loadRanks() {
  const base = window.LX_STATS_URL;
  if (!base) return;
  try {
    if (rankView === "daily") {
      const lb = await (await fetch(`${base}?dailylb=${new Date().toISOString().slice(0, 10)}`)).json();
      $("rank-daily-count").textContent = lb.top?.length ? `${lb.top.length}${lb.top.length >= 50 ? "+" : ""} played` : "";
      await rankRows(lb.top ?? [], $("rank-daily-rows"));
      $("rank-daily-btn").style.display = $("daily-card")?.style.display === "none" ? "none" : "";
      $("rank-daily-btn").textContent = $("daily-card-btn")?.textContent || "Play today's puzzle";
    } else if (rankView === "endless") {
      const lb = await (await fetch(`${base}?endlesslb=${endlessMode}&period=${endlessPeriod}`)).json();
      await rankRows(lb.top ?? [], $("rank-endless-rows"));
    }
  } catch {
    const el = $(rankView === "daily" ? "rank-daily-rows" : "rank-endless-rows");
    if (el) el.innerHTML = `<p class="placeholder">Couldn't load the leaderboard.</p>`;
  }
}
window.setRankView = function (v) {
  rankView = v;
  document.querySelectorAll("[data-rank]").forEach(b => b.classList.toggle("selected", b.dataset.rank === v));
  $("rank-daily").style.display = v === "daily" ? "" : "none";
  $("rank-endless").style.display = v === "endless" ? "" : "none";
  $("high-scores-card").style.display = v === "matches" ? "" : "none";
  loadRanks();
};
window.setEndlessRank = function (mode, period) {
  if (mode) endlessMode = mode;
  if (period) endlessPeriod = period;
  document.querySelectorAll("[data-emode]").forEach(b => b.classList.toggle("selected", b.dataset.emode === endlessMode));
  document.querySelectorAll("[data-eperiod]").forEach(b => b.classList.toggle("selected", b.dataset.eperiod === endlessPeriod));
  loadRanks();
};
const origSetTab = window.setTab;
window.setTab = function (tab, opts) { origSetTab(tab, opts); if (tab === "ranks") loadRanks(); };

// ── Small DOM-driven touches ───────────────────────────────────────────────
// Daily hero: overline shows today's date
$("daily-over").textContent = `Daily puzzle · ${new Date().toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" })}`;

// Endless card: friendly text until there's a personal best to show
const endlessBest = $("endless-best");
const fixEndless = () => { if (!endlessBest.textContent.trim()) endlessBest.textContent = "Fresh boards, no limit. Classic or a 10-second Blitz."; };
new MutationObserver(fixEndless).observe(endlessBest, { childList: true, characterData: true, subtree: true });
fixEndless();

// Install row in Me mirrors the install card
const installCard = $("install-card");
const syncInstall = () => { $("me-install-row").style.display = installCard.style.display === "none" ? "none" : ""; };
new MutationObserver(syncInstall).observe(installCard, { attributes: true, attributeFilter: ["style"] });
syncInstall();
window.openInstallFromMe = () => { setTab("play"); setTimeout(() => installCard.scrollIntoView({ behavior: "smooth", block: "center" }), 50); };

// Status snackbar clears itself
const statusEl = $("join-status");
let statusTimer = null;
new MutationObserver(() => {
  clearTimeout(statusTimer);
  if (statusEl.textContent) statusTimer = setTimeout(() => { statusEl.textContent = ""; }, 5000);
}).observe(statusEl, { childList: true, characterData: true, subtree: true });

// A magic-link problem is reported in the account card — take the player there
const authStatus = $("auth-status");
new MutationObserver(() => { if (authStatus.textContent) setTab("me"); }).observe(authStatus, { childList: true, characterData: true, subtree: true });

// Room codes: always uppercase, letters and digits only
$("room-code-input")?.addEventListener("input", (e) => {
  const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (v !== e.target.value) e.target.value = v;
});

window.addEventListener("lx:name", () => refreshIdentity());

// Adaptive bot level (Me tab)
window.addEventListener("lx:botskill", (e) => {
  const { level = 1, games = 0, wins = 0, losses = 0 } = e.detail ?? {};
  $("me-bot-level").textContent = `Lv ${level}`;
  $("me-bot-sub").textContent = games ? `${wins} won · ${losses} lost vs Auto bots` : "Bots adapt as you play";
});

// Over-days switched off in admin: hide its card
const friendsCard = document.querySelector(".mode-card.friends");
new MutationObserver(() => { friendsCard.style.display = $("mygames-card").style.display === "none" ? "none" : ""; })
  .observe($("mygames-card"), { attributes: true, attributeFilter: ["style"] });

applyTheme(store.get("lexterra_theme") || "system");
refreshIdentity();
setTab("play", { scroll: false });
