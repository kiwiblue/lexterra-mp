// Lexterra MP — growth features on the Stats party: daily puzzle results, streaks, the weekly
// ladder, analytics, push notifications and the async "My games" index.
// Every feature can be switched off from the admin page (feature_* flags in the coin config).

import { buildPushPayload } from "@block65/webcrypto-web-push";
import { isInternal, cleanName, isUuid, clientIp } from "./compat.js";
import { dailyPuzzle, endlessPuzzle, replayDaily, shareGrid, utcDate, isDateStr, addDays, daysBetween } from "./daily.js";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
const on = (cfg, f) => Number(cfg[`feature_${f}`] ?? 1) !== 0;

export const ANALYTICS_EVENTS = new Set([
  "visit", "tutorial_start", "tutorial_done", "practice_start", "game_start", "game_end",
  "daily_start", "daily_done", "share", "install", "push_enabled", "async_create",
  "daily_replay", "board_view", "endless_start", "endless_done", "theme_buy",
]);
const ENDLESS_MODES = new Set(["classic", "blitz"]);
const ENDLESS_LB_SIZE = 100;
// Cosmetic tile themes for the puzzle boards (bought with coins, kept forever)
export const TILE_THEMES = ["neon", "gold", "ocean", "candy"];
const FOREVER = 8.64e15; // stored like a colour-unlock expiry so account merges keep it
const MAX_STREAK_FREEZES = 2;
const DAILY_LB_SIZE = 100;
const MYGAMES_KEEP_ENDED_MS = 3 * 86400000;

// Same one-way id the public leaderboards use (see stats.js)
async function pidOf(uuid) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(uuid));
  return Array.from(new Uint8Array(buf).slice(0, 8), b => b.toString(16).padStart(2, "0")).join("");
}

// ISO week id (e.g. "2026-W41") and when it resets (next Monday 00:00 UTC)
export function isoWeek(t = Date.now()) {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday - yearStart) / 86400000 + 1) / 7);
  const resetsAt = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 7);
  return { id: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`, resetsAt };
}

// ── Streaks ────────────────────────────────────────────────────────────────
// A streak is consecutive UTC days with a completed daily puzzle. Freezes (bought with coins)
// cover missed days automatically.
function effectiveStreak(rec, today) {
  if (!rec?.lastDate) return { current: 0, best: rec?.best ?? 0, freezes: rec?.freezes ?? 0, lastDate: null };
  const missed = daysBetween(rec.lastDate, today) - 1; // days skipped since last play (today not yet counted)
  const alive = missed <= 0 || missed <= (rec.freezes ?? 0);
  return { current: alive ? rec.current : 0, best: rec.best ?? 0, freezes: rec.freezes ?? 0, lastDate: rec.lastDate, freezesNeeded: Math.max(0, missed) };
}
function applyStreak(rec, date) {
  rec = rec ?? { current: 0, best: 0, freezes: 0, lastDate: null };
  if (rec.lastDate === date) return rec;
  const gap = rec.lastDate ? daysBetween(rec.lastDate, date) : null;
  if (gap === 1) rec.current += 1;
  else if (gap !== null && gap > 1 && gap - 1 <= rec.freezes) { rec.freezes -= gap - 1; rec.current += 1; }
  else rec.current = 1;
  rec.best = Math.max(rec.best ?? 0, rec.current);
  rec.lastDate = date;
  return rec;
}

// ── Per-IP daily allowances ──────────────────────────────────────────────
// Creating new identities (daily results, analytics visitors, push subscriptions) is capped per
// visitor IP per UTC day, so scripts can't flood storage or the leaderboards with fake accounts.
async function pruneDaily(room) {
  const today = utcDate();
  if (await room.storage.get(`pruned:${today}`)) return;
  await room.storage.put(`pruned:${today}`, 1);
  for (let back = 2; back <= 10; back++) {
    const d = addDays(today, -back);
    for (const prefix of [`ipcap:${d}:`, `an_cap:${d}:`]) {
      const old = await room.storage.list({ prefix, limit: 1000 });
      const keys = [...old.keys()];
      for (let i = 0; i < keys.length; i += 128) await room.storage.delete(keys.slice(i, i + 128));
    }
  }
  for (let back = 36; back <= 45; back++) {
    const old = await room.storage.list({ prefix: `an_seen:${addDays(today, -back)}:`, limit: 1000 });
    const keys = [...old.keys()];
    for (let i = 0; i < keys.length; i += 128) await room.storage.delete(keys.slice(i, i + 128));
  }
}
export async function ipAllowance(room, req, bucket, max) {
  const ip = clientIp(req);
  if (!ip) return true; // internal calls
  await pruneDaily(room);
  const key = `ipcap:${utcDate()}:${bucket}:${ip}`;
  const n = (await room.storage.get(key)) ?? 0;
  if (n >= max) return false;
  await room.storage.put(key, n + 1);
  return true;
}

// ── Shared helpers used from stats.js ─────────────────────────────────────
export async function addWeekly(room, players) {
  const { id } = isoWeek();
  const key = `week:${id}`;
  const week = (await room.storage.get(key)) ?? {};
  let changed = false;
  for (const p of players) {
    if (!p.uuid || !(p.score > 0)) continue;
    const e = week[p.uuid] ?? { name: p.name, pts: 0, games: 0 };
    e.pts += p.score; e.games += 1; e.name = p.name ?? e.name;
    week[p.uuid] = e; changed = true;
  }
  if (changed) await room.storage.put(key, week);
}

async function addXp(room, uuid, name, score) {
  const xp = (await room.storage.get("player_xp")) ?? [];
  const i = xp.findIndex(e => e.uuid === uuid);
  if (i >= 0) { xp[i].xp += score; xp[i].gamesPlayed++; xp[i].name = name; }
  else xp.push({ uuid, name, xp: score, gamesPlayed: 1 });
  xp.sort((a, b) => b.xp - a.xp);
  await room.storage.put("player_xp", xp);
}

async function addCoins(room, uuid, name, amount) {
  if (!(amount > 0)) return;
  const coins = (await room.storage.get("player_coins")) ?? [];
  let i = coins.findIndex(e => e.uuid === uuid);
  if (i < 0) { coins.push({ uuid, name, coins: 0 }); i = coins.length - 1; }
  coins[i].coins = (coins[i].coins ?? 0) + amount;
  coins[i].name = name;
  await room.storage.put("player_coins", coins);
}

// Moves growth data from one account to another when a player links a second browser.
export async function mergeGrowth(room, fromUuid, toUuid) {
  const [sf, st] = await Promise.all([room.storage.get(`streak:${fromUuid}`), room.storage.get(`streak:${toUuid}`)]);
  if (sf) {
    const merged = !st ? sf : (sf.lastDate ?? "") > (st.lastDate ?? "") ? { ...sf, best: Math.max(sf.best, st.best), freezes: Math.max(sf.freezes, st.freezes) } : { ...st, best: Math.max(sf.best, st.best), freezes: Math.max(sf.freezes, st.freezes) };
    await room.storage.put(`streak:${toUuid}`, merged);
    await room.storage.delete(`streak:${fromUuid}`);
  }
  const { id } = isoWeek();
  const week = (await room.storage.get(`week:${id}`)) ?? {};
  if (week[fromUuid]) {
    const t = week[toUuid] ?? { name: week[fromUuid].name, pts: 0, games: 0 };
    t.pts += week[fromUuid].pts; t.games += week[fromUuid].games;
    week[toUuid] = t; delete week[fromUuid];
    await room.storage.put(`week:${id}`, week);
  }
  const [ea, eb] = await Promise.all([room.storage.get(`endless_pb:${fromUuid}`), room.storage.get(`endless_pb:${toUuid}`)]);
  if (ea) {
    await room.storage.put(`endless_pb:${toUuid}`, { classic: Math.max(ea.classic ?? 0, eb?.classic ?? 0), blitz: Math.max(ea.blitz ?? 0, eb?.blitz ?? 0), plays: (ea.plays ?? 0) + (eb?.plays ?? 0) });
    await room.storage.delete(`endless_pb:${fromUuid}`);
  }
  for (const k of ["push", "mygames"]) {
    const [a, b] = await Promise.all([room.storage.get(`${k}:${fromUuid}`), room.storage.get(`${k}:${toUuid}`)]);
    if (!a) continue;
    await room.storage.put(`${k}:${toUuid}`, k === "push" ? [...(b ?? []), ...a].slice(-5) : { ...(b ?? {}), ...a });
    await room.storage.delete(`${k}:${fromUuid}`);
  }
}

// ── Push ───────────────────────────────────────────────────────────────────
// Only real browser push services (plus the dev test receiver on dev) — never arbitrary URLs
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/, /^web\.push\.apple\.com$/, /\.push\.apple\.com$/];
function validSubscription(s, env) {
  if (!s || typeof s !== "object" || typeof s.endpoint !== "string" || s.endpoint.length >= 1000) return false;
  let url;
  try { url = new URL(s.endpoint); } catch { return false; }
  if (url.protocol !== "https:" || url.port) return false;
  const devSink = env.ENVIRONMENT === "dev" && url.hostname === "dev-api.lexterragame.com" && url.pathname.startsWith("/__push_sink/");
  if (!devSink && !PUSH_HOSTS.some(re => re.test(url.hostname))) return false;
  return !!s.keys && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string" && s.keys.p256dh.length < 200 && s.keys.auth.length < 100;
}

async function sendPush(room, uuid, message) {
  const env = room.env;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return 0;
  const subs = (await room.storage.get(`push:${uuid}`)) ?? [];
  if (!subs.length) return 0;
  const vapid = { subject: "mailto:noreply@lexterragame.com", publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  const keep = [];
  let sent = 0;
  for (const sub of subs) {
    try {
      const payload = await buildPushPayload({ data: JSON.stringify(message), options: { ttl: 86400, urgency: "normal", topic: "turn" } }, sub, vapid);
      if (!validSubscription(sub, env)) continue; // stored before the host allowlist existed
      const res = await fetch(sub.endpoint, { ...payload, signal: AbortSignal.timeout(5000) });
      if (res.status === 404 || res.status === 410) continue; // subscription gone
      if (res.ok) sent++;
      keep.push(sub);
    } catch {
      keep.push(sub);
    }
  }
  if (keep.length !== subs.length) {
    // Re-read so a subscription added while we were sending isn't lost; drop only the dead ones
    const dead = new Set(subs.filter(s => !keep.includes(s)).map(s => s.endpoint));
    const now = (await room.storage.get(`push:${uuid}`)) ?? [];
    await room.storage.put(`push:${uuid}`, now.filter(s => !dead.has(s.endpoint)));
  }
  return sent;
}

// ── Analytics ──────────────────────────────────────────────────────────────
async function track(room, uuid, event, req, cfg) {
  const today = utcDate();
  const pid = await pidOf(uuid);
  const counts = (await room.storage.get(`an:${today}`)) ?? {};
  if (event === "visit") {
    const seenKey = `an_seen:${today}:${pid}`;
    if (await room.storage.get(seenKey)) return;
    await room.storage.put(seenKey, 1);
    counts.visitors = (counts.visitors ?? 0) + 1;
    if (!(await room.storage.get(`an_first:${pid}`))) {
      if (!(await ipAllowance(room, req, "visitor", Number(cfg.ipNewVisitors) || 20))) { await room.storage.put(`an:${today}`, counts); return; }
      await room.storage.put(`an_first:${pid}`, today);
      const cohort = (await room.storage.get(`an_cohort:${today}`)) ?? [];
      cohort.push(pid);
      await room.storage.put(`an_cohort:${today}`, cohort);
      counts.newPlayers = (counts.newPlayers ?? 0) + 1;
    }
    await pruneDaily(room);
  } else {
    // Count each player at most 20 times per event per day so a script can't inflate numbers
    const capKey = `an_cap:${today}:${pid}:${event}`;
    const n = (await room.storage.get(capKey)) ?? 0;
    if (n >= 20) return;
    await room.storage.put(capKey, n + 1);
    counts[event] = (counts[event] ?? 0) + 1;
  }
  await room.storage.put(`an:${today}`, counts);
}

async function analyticsReport(room, days = 14) {
  const today = utcDate();
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    const counts = (await room.storage.get(`an:${d}`)) ?? {};
    const cohort = (await room.storage.get(`an_cohort:${d}`)) ?? [];
    const returned = async (offset) => {
      const day = addDays(d, offset);
      if (day > today) return null;
      let n = 0;
      for (let j = 0; j < cohort.length; j += 128) {
        const got = await room.storage.get(cohort.slice(j, j + 128).map(p => `an_seen:${day}:${p}`));
        n += got.size;
      }
      return n;
    };
    out.push({ date: d, ...counts, cohort: cohort.length, d1: await returned(1), d7: await returned(7) });
  }
  return out;
}

// ── Request handlers (return a Response, or null if not ours) ────────────────
export async function growthGet(url, room, cfg) {
  const q = url.searchParams;

  if (q.has("daily")) {
    if (!on(cfg, "daily")) return jsonRes({ error: "disabled" }, 404);
    const date = utcDate();
    const puzzle = await dailyPuzzle(date, room.env.DAILY_SALT);
    const lb = (await room.storage.get(`daily_lb:${date}`)) ?? [];
    const leader = lb[0] ? { name: lb[0].name, score: lb[0].score } : null;
    return jsonRes({ puzzle, players: lb.length, leader, nextAt: Date.parse(addDays(date, 1) + "T00:00:00Z") });
  }

  if (q.has("dailylb")) {
    const date = isDateStr(q.get("dailylb")) ? q.get("dailylb") : utcDate();
    const lb = (await room.storage.get(`daily_lb:${date}`)) ?? [];
    return jsonRes({ date, top: await Promise.all(lb.slice(0, 50).map(async e => ({ pid: await pidOf(e.uuid), name: e.name, score: e.score, words: e.words }))) });
  }

  if (q.has("streak")) {
    const uuid = q.get("streak");
    if (!isUuid(uuid)) return jsonRes({ error: "bad_uuid" }, 400);
    return jsonRes(effectiveStreak(await room.storage.get(`streak:${uuid}`), utcDate()));
  }

  if (q.has("weekly")) {
    const { id, resetsAt } = isoWeek();
    const week = (await room.storage.get(`week:${id}`)) ?? {};
    const rows = Object.entries(week).sort((a, b) => b[1].pts - a[1].pts).slice(0, 50);
    return jsonRes({ week: id, resetsAt, top: await Promise.all(rows.map(async ([u, e]) => ({ pid: await pidOf(u), name: e.name, pts: e.pts, games: e.games }))) });
  }

  if (q.has("endlesslb")) {
    if (!on(cfg, "endless")) return jsonRes({ error: "disabled" }, 404);
    const mode = ENDLESS_MODES.has(q.get("endlesslb")) ? q.get("endlesslb") : "classic";
    const week = q.get("period") === "week";
    const lb = (await room.storage.get(week ? `endless_wk:${mode}:${isoWeek().id}` : `endless_lb:${mode}`)) ?? [];
    return jsonRes({ mode, period: week ? "week" : "all", resetsAt: week ? isoWeek().resetsAt : null,
      top: await Promise.all(lb.slice(0, 50).map(async e => ({ pid: await pidOf(e.uuid), name: e.name, score: e.score, words: e.words }))) });
  }

  if (q.has("pushkey")) return jsonRes({ key: on(cfg, "push") ? room.env.VAPID_PUBLIC_KEY ?? null : null });

  if (q.has("push_sink") && room.env.ENVIRONMENT === "dev") {
    return jsonRes((await room.storage.get(`push_sink:${String(q.get("push_sink")).slice(0, 64)}`)) ?? { ok: 0, bad: 0 });
  }

  return null;
}

export async function growthPost(msg, req, room, cfg, isAdmin) {
  switch (msg.type) {

    case "daily_submit": {
      if (!on(cfg, "daily")) return jsonRes({ error: "disabled" }, 404);
      const { uuid, date, moves } = msg;
      if (!isUuid(uuid)) return jsonRes({ error: "bad_uuid" }, 400);
      const today = utcDate();
      // Allow finishing yesterday's puzzle shortly after midnight UTC
      if (!isDateStr(date) || (date !== today && !(date === addDays(today, -1) && Date.now() - Date.parse(today + "T00:00:00Z") < 3600000))) {
        return jsonRes({ error: "wrong_day" }, 400);
      }
      const resKey = `daily_res:${date}:${uuid}`;
      const prev = await room.storage.get(resKey);
      if (prev) return jsonRes({ ok: true, already: true, score: prev.score, words: prev.words, share: shareGrid(prev.used) });
      const puzzle = await dailyPuzzle(date, room.env.DAILY_SALT);
      const r = replayDaily(puzzle, moves);
      if (!r.ok) return jsonRes({ error: r.error, word: r.word }, 400);
      if (r.placed === 0) return jsonRes({ error: "empty" }, 400);
      if (!(await ipAllowance(room, req, "daily", Number(cfg.ipDailySubmits) || 3))) return jsonRes({ error: "too_many_today" }, 429);
      const name = cleanName(msg.name);
      await room.storage.put(resKey, { score: r.score, words: r.words, used: r.used, moves: r.moves, name, at: Date.now() });

      const lb = (await room.storage.get(`daily_lb:${date}`)) ?? [];
      if (r.score > 0) {
        lb.push({ uuid, name, score: r.score, words: r.words.length });
        lb.sort((a, b) => b.score - a.score || b.words - a.words);
        await room.storage.put(`daily_lb:${date}`, lb.slice(0, DAILY_LB_SIZE));
      }
      const rank = lb.findIndex(e => e.uuid === uuid) + 1 || null;

      let streak = null, coins = 0;
      if (on(cfg, "streaks")) {
        streak = applyStreak(await room.storage.get(`streak:${uuid}`), date);
        await room.storage.put(`streak:${uuid}`, streak);
        if (r.complete && streak.current > 0 && streak.current % 7 === 0) coins += Number(cfg.streakBonus7) || 0;
      }
      // Coins only for finishing the puzzle (every letter placed) with at least one word
      if (r.complete && r.score > 0) coins += Number(cfg.dailyComplete) || 0;
      await addCoins(room, uuid, name, coins);
      if (r.score > 0) {
        await addXp(room, uuid, name, r.score);
        if (on(cfg, "weekly")) await addWeekly(room, [{ uuid, name, score: r.score }]);
      }
      return jsonRes({ ok: true, score: r.score, words: r.words, share: shareGrid(r.used), rank, players: lb.length, streak, coinsEarned: coins });
    }

    // Someone's finished daily board. Today's boards are only shown to players who have already
    // submitted today's puzzle, so nobody can copy the best answer before playing.
    case "daily_board": {
      if (!on(cfg, "daily")) return jsonRes({ error: "disabled" }, 404);
      const { uuid, date, pid } = msg;
      if (!isUuid(uuid) || !isDateStr(date) || typeof pid !== "string" || !/^[0-9a-f]{16}$/.test(pid)) return jsonRes({ error: "bad_request" }, 400);
      const today = utcDate();
      if (date > today) return jsonRes({ error: "bad_request" }, 400);
      if (date >= addDays(today, -1) && !(await room.storage.get(`daily_res:${date}:${uuid}`))) return jsonRes({ error: "play_first" }, 403);
      const lb = (await room.storage.get(`daily_lb:${date}`)) ?? [];
      let owner = null;
      for (const e of lb) if ((await pidOf(e.uuid)) === pid) { owner = e.uuid; break; }
      if (!owner) return jsonRes({ error: "not_found" }, 404);
      const res = await room.storage.get(`daily_res:${date}:${owner}`);
      if (!res?.moves) return jsonRes({ error: "no_board" }, 404);
      return jsonRes({ name: res.name, score: res.score, words: res.words, moves: res.moves, puzzle: await dailyPuzzle(date, room.env.DAILY_SALT) });
    }

    // ── Endless puzzles ──
    // The server hands out a random seed and remembers it, so scores can be replayed and checked
    // like the daily. One live puzzle per player; each seed can be submitted once.
    case "endless_start": {
      if (!on(cfg, "endless")) return jsonRes({ error: "disabled" }, 404);
      if (!isUuid(msg.uuid) || !ENDLESS_MODES.has(msg.mode)) return jsonRes({ error: "bad_request" }, 400);
      const cur = await room.storage.get(`endless_cur:${msg.uuid}`);
      // Resume an unfinished classic puzzle instead of dealing a new one
      if (cur && cur.mode === "classic" && msg.mode === "classic" && !msg.fresh) {
        return jsonRes({ seed: cur.seed, mode: cur.mode, resumed: true, puzzle: await endlessPuzzle(cur.seed, room.env.DAILY_SALT) });
      }
      if (!(await ipAllowance(room, req, "endless", Number(cfg.ipEndlessStarts) || 300))) return jsonRes({ error: "too_many_today" }, 429);
      const seed = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, "0")).join("");
      await room.storage.put(`endless_cur:${msg.uuid}`, { seed, mode: msg.mode, at: Date.now() });
      return jsonRes({ seed, mode: msg.mode, blitzSecs: Number(cfg.endlessBlitzSecs) || 10, puzzle: await endlessPuzzle(seed, room.env.DAILY_SALT) });
    }

    case "endless_submit": {
      if (!on(cfg, "endless")) return jsonRes({ error: "disabled" }, 404);
      const { uuid, seed } = msg;
      if (!isUuid(uuid) || typeof seed !== "string") return jsonRes({ error: "bad_request" }, 400);
      const cur = await room.storage.get(`endless_cur:${uuid}`);
      if (!cur || cur.seed !== seed) return jsonRes({ error: "stale" }, 409);
      const puzzle = await endlessPuzzle(seed, room.env.DAILY_SALT);
      const r = replayDaily(puzzle, msg.moves);
      if (!r.ok) return jsonRes({ error: r.error, word: r.word }, 400);
      await room.storage.delete(`endless_cur:${uuid}`);
      const name = cleanName(msg.name);
      // Blitz gives each letter a few seconds; the whole run must fit in that budget (plus the
      // final claiming window and some slack for the network) to count for the leaderboard.
      const secs = Number(cfg.endlessBlitzSecs) || 10;
      const inTime = cur.mode !== "blitz" || Date.now() - cur.at <= (puzzle.letters.length * secs + 30 + 20) * 1000;
      const ranked = inTime && r.complete && r.score > 0;
      const pbKey = `endless_pb:${uuid}`;
      const pb = (await room.storage.get(pbKey)) ?? { classic: 0, blitz: 0, plays: 0 };
      const isPB = ranked && r.score > (pb[cur.mode] ?? 0);
      pb.plays = (pb.plays ?? 0) + 1;
      if (isPB) pb[cur.mode] = r.score;
      await room.storage.put(pbKey, pb);
      let rankAll = null, rankWeek = null;
      if (ranked) {
        const entry = { uuid, name, score: r.score, words: r.words.length, at: Date.now() };
        const upsert = async (key) => {
          const lb = (await room.storage.get(key)) ?? [];
          const i = lb.findIndex(e => e.uuid === uuid);
          if (i >= 0 && lb[i].score >= r.score) return i + 1;
          if (i >= 0) lb.splice(i, 1);
          lb.push(entry);
          lb.sort((a, b) => b.score - a.score || b.words - a.words || a.at - b.at);
          const kept = lb.slice(0, ENDLESS_LB_SIZE);
          await room.storage.put(key, kept);
          return kept.findIndex(e => e.uuid === uuid) + 1 || null;
        };
        rankAll = await upsert(`endless_lb:${cur.mode}`);
        rankWeek = await upsert(`endless_wk:${cur.mode}:${isoWeek().id}`);
      }
      return jsonRes({ ok: true, mode: cur.mode, score: r.score, words: r.words, share: shareGrid(r.used), ranked, inTime, complete: r.complete, best: pb[cur.mode], isPB, rankAll, rankWeek });
    }

    case "spend": {
      if (msg.item === "tileTheme") {
        if (!isUuid(msg.uuid) || !TILE_THEMES.includes(msg.theme)) return jsonRes({ error: "bad_request" }, 400);
        const cost = Math.max(0, Number(cfg.spendTileTheme) || 0);
        const coins = (await room.storage.get("player_coins")) ?? [];
        const ci = coins.findIndex(p => p.uuid === msg.uuid);
        const balance = ci >= 0 ? (coins[ci].coins ?? 0) : 0;
        const key = `theme_${msg.theme}`;
        if (ci >= 0 && coins[ci].colorUnlocks?.[key]) return jsonRes({ coins: balance, cost: 0, owned: true });
        if (balance < cost) return jsonRes({ error: "insufficient_coins", balance, cost }, 402);
        coins[ci].coins = balance - cost;
        coins[ci].colorUnlocks = { ...(coins[ci].colorUnlocks ?? {}), [key]: FOREVER };
        await room.storage.put("player_coins", coins);
        return jsonRes({ coins: balance - cost, cost, owned: true });
      }
      // Streak freezes are a coin item handled here; other items fall through to stats.js
      if (msg.item !== "streakFreeze") return null;
      if (!on(cfg, "streaks")) return jsonRes({ error: "disabled" }, 404);
      if (!isUuid(msg.uuid)) return jsonRes({ error: "bad_uuid" }, 400);
      const rec = (await room.storage.get(`streak:${msg.uuid}`)) ?? { current: 0, best: 0, freezes: 0, lastDate: null };
      if ((rec.freezes ?? 0) >= MAX_STREAK_FREEZES) return jsonRes({ error: "max_freezes", freezes: rec.freezes }, 409);
      const cost = Math.max(0, Number(cfg.spendStreakFreeze) || 0);
      const coins = (await room.storage.get("player_coins")) ?? [];
      const ci = coins.findIndex(p => p.uuid === msg.uuid);
      const balance = ci >= 0 ? (coins[ci].coins ?? 0) : 0;
      if (balance < cost) return jsonRes({ error: "insufficient_coins", balance, cost }, 402);
      if (cost > 0) { coins[ci].coins = balance - cost; await room.storage.put("player_coins", coins); }
      rec.freezes = (rec.freezes ?? 0) + 1;
      await room.storage.put(`streak:${msg.uuid}`, rec);
      return jsonRes({ coins: balance - cost, cost, freezes: rec.freezes });
    }

    case "track": {
      if (!isUuid(msg.uuid) || !ANALYTICS_EVENTS.has(msg.event)) return jsonRes({ error: "bad_event" }, 400);
      await track(room, msg.uuid, msg.event, req, cfg);
      return jsonRes({ ok: true });
    }

    case "push_subscribe": {
      if (!on(cfg, "push")) return jsonRes({ error: "disabled" }, 404);
      if (!isUuid(msg.uuid) || !validSubscription(msg.subscription, room.env)) return jsonRes({ error: "bad_subscription" }, 400);
      if (!(await ipAllowance(room, req, "push", Number(cfg.ipPushSubscribes) || 10))) return jsonRes({ error: "too_many_today" }, 429);
      const sub = { endpoint: msg.subscription.endpoint, keys: { p256dh: msg.subscription.keys.p256dh, auth: msg.subscription.keys.auth } };
      const subs = ((await room.storage.get(`push:${msg.uuid}`)) ?? []).filter(s => s.endpoint !== sub.endpoint);
      subs.push(sub);
      await room.storage.put(`push:${msg.uuid}`, subs.slice(-5));
      return jsonRes({ ok: true });
    }

    case "push_unsubscribe": {
      if (!isUuid(msg.uuid) || typeof msg.endpoint !== "string") return jsonRes({ error: "bad_request" }, 400);
      const before = (await room.storage.get(`push:${msg.uuid}`)) ?? [];
      const subs = before.filter(s => s.endpoint !== msg.endpoint);
      if (subs.length !== before.length) await room.storage.put(`push:${msg.uuid}`, subs);
      return jsonRes({ ok: true });
    }

    // Everything the home screen needs about the player, in one POST (keeps the uuid out of URLs)
    case "profile": {
      if (!isUuid(msg.uuid)) return jsonRes({ error: "bad_uuid" }, 400);
      const today = utcDate();
      const [coins, xp, st, mine, epb] = await Promise.all([
        room.storage.get("player_coins"), room.storage.get("player_xp"),
        room.storage.get(`streak:${msg.uuid}`), room.storage.get(`daily_res:${today}:${msg.uuid}`),
        room.storage.get(`endless_pb:${msg.uuid}`),
      ]);
      const c = (coins ?? []).find(p => p.uuid === msg.uuid);
      const x = (xp ?? []).find(p => p.uuid === msg.uuid);
      return jsonRes({
        name: c?.name ?? x?.name ?? null, coins: c?.coins ?? 0, colorUnlocks: c?.colorUnlocks ?? {},
        xp: x?.xp ?? 0, gamesPlayed: x?.gamesPlayed ?? 0,
        streak: on(cfg, "streaks") ? effectiveStreak(st, today) : null,
        dailyMine: mine ? { score: mine.score, words: mine.words, share: shareGrid(mine.used) } : null,
        endless: on(cfg, "endless") ? { classic: epb?.classic ?? 0, blitz: epb?.blitz ?? 0, plays: epb?.plays ?? 0 } : null,
      });
    }

    case "mygames": {
      if (!isUuid(msg.uuid)) return jsonRes({ error: "bad_uuid" }, 400);
      const games = (await room.storage.get(`mygames:${msg.uuid}`)) ?? {};
      const now = Date.now();
      const list = Object.entries(games)
        .filter(([, g]) => g.phase !== "ended" || now - g.updatedAt < MYGAMES_KEEP_ENDED_MS)
        .map(([roomId, g]) => ({ roomId, ...g }))
        .sort((a, b) => (b.yourTurn - a.yourTurn) || (b.updatedAt - a.updatedAt));
      return jsonRes({ games: list });
    }

    // ── Server-only (from game rooms) ──
    case "mygames_update": {
      if (!isInternal(req)) return new Response("Forbidden", { status: 403 });
      const { roomId, entries = [], remove = [] } = msg;
      for (const { uuid, info } of entries) {
        const games = (await room.storage.get(`mygames:${uuid}`)) ?? {};
        games[roomId] = { ...info, updatedAt: Date.now() };
        // Drop finished games past their display window
        for (const [id, g] of Object.entries(games)) if (g.phase === "ended" && Date.now() - g.updatedAt > MYGAMES_KEEP_ENDED_MS) delete games[id];
        await room.storage.put(`mygames:${uuid}`, games);
      }
      for (const uuid of remove) {
        const games = (await room.storage.get(`mygames:${uuid}`)) ?? {};
        if (roomId in games) { delete games[roomId]; await room.storage.put(`mygames:${uuid}`, games); }
      }
      return new Response("ok");
    }

    case "push_turn": {
      if (!isInternal(req)) return new Response("Forbidden", { status: 403 });
      if (!on(cfg, "push")) return new Response("ok");
      const sent = await sendPush(room, msg.uuid, { title: msg.title, body: msg.body, url: msg.url, tag: msg.tag });
      return jsonRes({ sent });
    }

    case "push_sink_hit": { // dev-only test receiver (see server.js)
      if (!isInternal(req) || room.env.ENVIRONMENT !== "dev") return new Response("Forbidden", { status: 403 });
      const k = `push_sink:${String(msg.id).slice(0, 64)}`;
      const rec = (await room.storage.get(k)) ?? { ok: 0, bad: 0 };
      rec[msg.ok ? "ok" : "bad"]++;
      await room.storage.put(k, rec);
      return new Response("ok");
    }

    case "admin_analytics": {
      const denied = await isAdmin(msg.password, room.env, req, room);
      if (denied) return denied;
      return jsonRes({ days: await analyticsReport(room, 14) });
    }
  }
  return null;
}
