// Lexterra MP — per-player records on the Stats party.
//
// Coins and XP used to live in two arrays (player_coins, player_xp) stored under one key each.
// A stored value is capped at 2 MB, so those arrays would eventually fail to save and take every
// coin and XP update down with them. Each player now has their own small records:
//   coin:<uuid>  → { uuid, name, coins, colorUnlocks, lastPlayDate, lastWinDate, dailyBest, … }
//   xp:<uuid>    → { uuid, name, xp, gamesPlayed }
//   xp_top       → top XP_TOP_SIZE players, for the XP leaderboard
// The old arrays are migrated once (and left in place, untouched, as a backup).

import { isUuid } from "./compat.js";

const XP_TOP_SIZE = 200;

export const getCoin = (room, uuid) => room.storage.get(`coin:${uuid}`);
export const putCoin = (room, rec) => room.storage.put(`coin:${rec.uuid}`, rec);
export const deleteCoin = (room, uuid) => room.storage.delete(`coin:${uuid}`);
export const getXp = (room, uuid) => room.storage.get(`xp:${uuid}`);
export const deleteXp = (room, uuid) => room.storage.delete(`xp:${uuid}`);

export async function putXp(room, rec) {
  await room.storage.put(`xp:${rec.uuid}`, rec);
  await updateXpTop(room, rec);
}

// Keeps the small top-N list in step with one player's record (rec = null removes uuid)
export async function updateXpTop(room, rec, removeUuid = null) {
  const top = (await room.storage.get("xp_top")) ?? [];
  const drop = removeUuid ?? rec?.uuid;
  const i = top.findIndex(e => e.uuid === drop);
  const floor = top.length >= XP_TOP_SIZE ? top[top.length - 1].xp : -1;
  if (i < 0 && (!rec || rec.xp <= floor)) return; // not on the board and not good enough to join
  if (i >= 0) top.splice(i, 1);
  if (rec) top.push({ uuid: rec.uuid, name: rec.name, xp: rec.xp, gamesPlayed: rec.gamesPlayed });
  top.sort((a, b) => b.xp - a.xp);
  await room.storage.put("xp_top", top.slice(0, XP_TOP_SIZE));
}

// Lists coin records (admin view), richest first
export async function listCoins(room, limit = 2000) {
  const out = [];
  let start;
  while (out.length < limit) {
    const page = await room.storage.list({ prefix: "coin:", limit: 500, ...(start ? { startAfter: start } : {}) });
    if (!page.size) break;
    for (const [k, v] of page) { out.push(v); start = k; }
    if (page.size < 500) break;
  }
  return out.sort((a, b) => (b.coins ?? 0) - (a.coins ?? 0)).slice(0, limit);
}

// One-time move from the old arrays. Every Stats request waits for it, so nothing reads or writes
// a half-migrated store.
export function ensureAccounts(room) {
  if (!room._accounts) {
    room._accounts = migrate(room).catch((e) => { room._accounts = null; throw e; });
  }
  return room._accounts;
}

async function migrate(room) {
  if (await room.storage.get("accounts_v2")) return;
  const coins = (await room.storage.get("player_coins")) ?? [];
  const xp = (await room.storage.get("player_xp")) ?? [];
  let batch = {};
  const flush = async () => { if (Object.keys(batch).length) await room.storage.put(batch); batch = {}; };
  for (const c of coins) {
    if (!isUuid(c?.uuid)) continue;
    batch[`coin:${c.uuid}`] = c;
    if (Object.keys(batch).length >= 100) await flush();
  }
  for (const x of xp) {
    if (!isUuid(x?.uuid)) continue;
    batch[`xp:${x.uuid}`] = x;
    if (Object.keys(batch).length >= 100) await flush();
  }
  await flush();
  const top = xp.filter(x => isUuid(x?.uuid)).sort((a, b) => b.xp - a.xp).slice(0, XP_TOP_SIZE)
    .map(x => ({ uuid: x.uuid, name: x.name, xp: x.xp, gamesPlayed: x.gamesPlayed }));
  await room.storage.put("xp_top", top);
  await room.storage.put("accounts_v2", { at: Date.now(), coins: coins.length, xp: xp.length });
  console.log(`accounts migrated: ${coins.length} coin records, ${xp.length} xp records`);
}
