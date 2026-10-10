// Lexterra MP — growth features on the Stats party: daily puzzle results, streaks, the weekly
// ladder, analytics, push notifications and the async "My games" index.
// Every feature can be switched off from the admin page (feature_* flags in the coin config).

import { buildPushPayload } from "@block65/webcrypto-web-push";
import { isInternal, cleanName, isUuid } from "./compat.js";
import { dailyPuzzle, replayDaily, shareGrid, utcDate, isDateStr, addDays, daysBetween } from "./daily.js";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
const on = (cfg, f) => Number(cfg[`feature_${f}`] ?? 1) !== 0;

export const ANALYTICS_EVENTS = new Set([
  "visit", "tutorial_start", "tutorial_done", "practice_start", "game_start", "game_end",
  "daily_start", "daily_done", "share", "install", "push_enabled", "async_create",
]);
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
  for (const k of ["push", "mygames"]) {
    const [a, b] = await Promise.all([room.storage.get(`${k}:${fromUuid}`), room.storage.get(`${k}:${toUuid}`)]);
    if (!a) continue;
    await room.storage.put(`${k}:${toUuid}`, k === "push" ? [...(b ?? []), ...a].slice(-5) : { ...(b ?? {}), ...a });
    await room.storage.delete(`${k}:${fromUuid}`);
  }
}

// ── Push ───────────────────────────────────────────────────────────────────
function validSubscription(s) {
  return s && typeof s === "object" && typeof s.endpoint === "string" && s.endpoint.startsWith("https://") && s.endpoint.length < 1000
    && s.keys && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string" && s.keys.p256dh.length < 200 && s.keys.auth.length < 100;
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
      const res = await fetch(sub.endpoint, payload);
      if (res.status === 404 || res.status === 410) continue; // subscription gone
      if (res.ok) sent++;
      keep.push(sub);
    } catch {
      keep.push(sub);
    }
  }
  if (keep.length !== subs.length) await room.storage.put(`push:${uuid}`, keep);
  return sent;
}

// ── Analytics ──────────────────────────────────────────────────────────────
async function track(room, uuid, event) {
  const today = utcDate();
  const pid = await pidOf(uuid);
  const counts = (await room.storage.get(`an:${today}`)) ?? {};
  if (event === "visit") {
    const seenKey = `an_seen:${today}:${pid}`;
    if (await room.storage.get(seenKey)) return;
    await room.storage.put(seenKey, 1);
    counts.visitors = (counts.visitors ?? 0) + 1;
    if (!(await room.storage.get(`an_first:${pid}`))) {
      await room.storage.put(`an_first:${pid}`, today);
      const cohort = (await room.storage.get(`an_cohort:${today}`)) ?? [];
      cohort.push(pid);
      await room.storage.put(`an_cohort:${today}`, cohort);
      counts.newPlayers = (counts.newPlayers ?? 0) + 1;
    }
    // Once a day, drop "seen" markers older than 35 days (retention only needs day 1 and 7)
    if (!(await room.storage.get(`an_pruned:${today}`))) {
      await room.storage.put(`an_pruned:${today}`, 1);
      for (let back = 36; back <= 45; back++) {
        const old = await room.storage.list({ prefix: `an_seen:${addDays(today, -back)}:` });
        if (old.size) await room.storage.delete([...old.keys()].slice(0, 128));
      }
    }
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
    const uuid = q.get("uuid");
    const mine = isUuid(uuid) ? (await room.storage.get(`daily_res:${date}:${uuid}`)) ?? null : null;
    const lb = (await room.storage.get(`daily_lb:${date}`)) ?? [];
    return jsonRes({ puzzle, mine: mine && { score: mine.score, words: mine.words, share: shareGrid(mine.used) }, players: lb.length, nextAt: Date.parse(addDays(date, 1) + "T00:00:00Z") });
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
      const name = cleanName(msg.name);
      await room.storage.put(resKey, { score: r.score, words: r.words, used: r.used, name, at: Date.now() });

      const lb = (await room.storage.get(`daily_lb:${date}`)) ?? [];
      lb.push({ uuid, name, score: r.score, words: r.words.length });
      lb.sort((a, b) => b.score - a.score || b.words - a.words);
      const rank = lb.findIndex(e => e.uuid === uuid) + 1;
      await room.storage.put(`daily_lb:${date}`, lb.slice(0, DAILY_LB_SIZE));

      let streak = null, coins = 0;
      if (on(cfg, "streaks")) {
        streak = applyStreak(await room.storage.get(`streak:${uuid}`), date);
        await room.storage.put(`streak:${uuid}`, streak);
        if (streak.current > 0 && streak.current % 7 === 0) coins += Number(cfg.streakBonus7) || 0;
      }
      coins += Number(cfg.dailyComplete) || 0;
      await addCoins(room, uuid, name, coins);
      if (r.score > 0) {
        await addXp(room, uuid, name, r.score);
        if (on(cfg, "weekly")) await addWeekly(room, [{ uuid, name, score: r.score }]);
      }
      return jsonRes({ ok: true, score: r.score, words: r.words, share: shareGrid(r.used), rank, players: lb.length, streak, coinsEarned: coins });
    }

    case "spend": {
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
      await track(room, msg.uuid, msg.event);
      return jsonRes({ ok: true });
    }

    case "push_subscribe": {
      if (!on(cfg, "push")) return jsonRes({ error: "disabled" }, 404);
      if (!isUuid(msg.uuid) || !validSubscription(msg.subscription)) return jsonRes({ error: "bad_subscription" }, 400);
      const sub = { endpoint: msg.subscription.endpoint, keys: { p256dh: msg.subscription.keys.p256dh, auth: msg.subscription.keys.auth } };
      const subs = ((await room.storage.get(`push:${msg.uuid}`)) ?? []).filter(s => s.endpoint !== sub.endpoint);
      subs.push(sub);
      await room.storage.put(`push:${msg.uuid}`, subs.slice(-5));
      return jsonRes({ ok: true });
    }

    case "push_unsubscribe": {
      if (!isUuid(msg.uuid) || typeof msg.endpoint !== "string") return jsonRes({ error: "bad_request" }, 400);
      const subs = ((await room.storage.get(`push:${msg.uuid}`)) ?? []).filter(s => s.endpoint !== msg.endpoint);
      await room.storage.put(`push:${msg.uuid}`, subs);
      return jsonRes({ ok: true });
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
      if (!(await isAdmin(msg.password, room.env))) return new Response("Unauthorized", { status: 401, headers: CORS });
      return jsonRes({ days: await analyticsReport(room, 14) });
    }
  }
  return null;
}
