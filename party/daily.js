// Lexterra MP — Daily puzzle.
// Everyone gets the same 5×5 board each UTC day: a few starter letters plus the same queue of
// letters to place. Players choose where each letter goes and claim words in straight lines.
// The board is derived from DAILY_SALT (a Worker secret) so future days can't be previewed
// from the public source. Submissions are replayed here — the client's score is never trusted.

import { isBannedWord, isDictionaryWord, claimedVariant, straightPath } from "./rules.js";

export const DAILY_SIZE = 5;
export const DAILY_MIN_LEN = 3;
const STARTERS = 3;
const EPOCH = Date.UTC(2026, 9, 10); // 10 Oct 2026 = puzzle #1

// English letter-tile distribution (no blanks). Drawing without replacement keeps the
// vowel/consonant balance natural.
const BAG = "AAAAAAAAABBCCDDDDEEEEEEEEEEEEFFGGGHHIIIIIIIIIJKLLLLMMNNNNNNOOOOOOOOPPQRRRRRRSSSSTTTTTTUUUUVVWWXYYZ";

export const utcDate = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
export const isDateStr = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && utcDate(Date.parse(d + "T00:00:00Z")) === d;
export const dayNumber = (date) => Math.floor((Date.parse(date + "T00:00:00Z") - EPOCH) / 86400000) + 1;
export const addDays = (date, n) => utcDate(Date.parse(date + "T00:00:00Z") + n * 86400000);
export const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);

// sfc32 PRNG seeded from an HMAC of a label (the date for dailies, a random seed for endless)
async function rngFor(label, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const h = new Uint32Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(label)));
  let [a, b, c, d] = h;
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b | 0) + d | 0;
    d = d + 1 | 0; a = b ^ b >>> 9; b = c + (c << 3) | 0; c = c << 21 | c >>> 11; c = c + t | 0;
    return (t >>> 0) / 4294967296;
  };
}

// Returns { date, number, size, minLen, starters:[{r,c,letter}], letters:[...] }
export async function dailyPuzzle(date, salt) {
  if (!salt) throw new Error("DAILY_SALT not set");
  return { date, number: dayNumber(date), ...(await makeBoard("lexterra-daily:" + date, salt)) };
}

// Endless mode: same generator, seeded from a random id the server hands out
export async function endlessPuzzle(seed, salt) {
  if (!salt) throw new Error("DAILY_SALT not set");
  return { seed, ...(await makeBoard("lexterra-endless:" + seed, salt)) };
}

async function makeBoard(label, salt) {
  const rand = await rngFor(label, salt);
  const bag = BAG.split("");
  for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
  let tiles = bag.slice(0, DAILY_SIZE * DAILY_SIZE);
  // A Q with no U is nearly unplayable — swap it for a U if needed
  if (tiles.includes("Q") && !tiles.includes("U")) tiles[tiles.indexOf("Q")] = "U";
  const cells = [];
  for (let r = 0; r < DAILY_SIZE; r++) for (let c = 0; c < DAILY_SIZE; c++) cells.push({ r, c });
  for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
  const starters = cells.slice(0, STARTERS).map((p, i) => ({ ...p, letter: tiles[i] }));
  return { size: DAILY_SIZE, minLen: DAILY_MIN_LEN, starters, letters: tiles.slice(STARTERS) };
}

// Replays a submission. moves: [{ place: { r, c } } | { claim: { word, path } }].
// Placements must use the queue in order and may only target empty cells. Invalid claims are
// rejected (not skipped) so the client and server always agree on the score.
// Returns { ok, score, words, used } or { ok:false, error }.
export function replayDaily(puzzle, moves) {
  if (!Array.isArray(moves) || moves.length > puzzle.letters.length + 150) return { ok: false, error: "bad_moves" };
  const n = puzzle.size;
  const grid = Array.from({ length: n }, () => Array(n).fill(null));
  for (const s of puzzle.starters) grid[s.r][s.c] = { letter: s.letter };
  let next = 0, score = 0;
  const words = [], clean = [];
  const used = Array.from({ length: n }, () => Array(n).fill(false));
  for (const m of moves) {
    if (m && m.place) {
      const { r, c } = m.place;
      if (next >= puzzle.letters.length) return { ok: false, error: "no_letters_left" };
      if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= n || c >= n || grid[r][c]) return { ok: false, error: "bad_place" };
      grid[r][c] = { letter: puzzle.letters[next++] };
      clean.push({ place: { r, c } });
    } else if (m && m.claim) {
      const { word, path } = m.claim;
      const cells = straightPath(grid, word, path, puzzle.minLen);
      if (!cells || isBannedWord(word) || !isDictionaryWord(word) || claimedVariant(word, words)) return { ok: false, error: "bad_claim", word };
      words.push(word);
      clean.push({ claim: { word, path: path.map(({ r, c }) => ({ r, c })) } });
      score += word.length;
      for (const { r, c } of cells) used[r][c] = true;
    } else {
      return { ok: false, error: "bad_move" };
    }
  }
  // `moves` is a sanitised copy (only the fields the replay used) — safe to store and show others
  return { ok: true, score, words, used, moves: clean, placed: next, complete: next === puzzle.letters.length };
}

// Spoiler-free share text: 🟩 = cell used in a claimed word, ⬛ = not used.
export function shareGrid(used) {
  return used.map(row => row.map(u => (u ? "🟩" : "⬛")).join("")).join("\n");
}
