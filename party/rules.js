// Lexterra MP — word rules shared by live games and the daily puzzle.
// Keep in sync with the client copies in public/index.html (claimedVariant / hasBetterRoot).

import { isDictionaryWord } from "./words.js";

// Banned claimable words (profanity filter). Lowercase. Keep in sync with public/index.html.
const BANNED_WORDS = new Set([
  "cunt","cunts","fuck","fucked","fucker","fuckers","fucking","fuckings",
  "fuckoff","fuckoffs","fucks","fuckup","fuckups","fuckwit","fuckwits",
  "headfuck","headfucks","mindfuck","mindfucks","motherfucker","motherfuckers",
  "motherfucking","starfucker","starfuckers","starfucking","starfuckings",
]);
export function isBannedWord(w) { return BANNED_WORDS.has(String(w).toLowerCase()); }

// True if `long` has a better dictionary root than `short` — e.g. SITES comes from SITE,
// so it isn't a plural of SIT and may still be claimed after SIT.
function hasBetterRoot(long, short) {
  for (const suf of ["S", "ES", "ING", "ED", "D"]) {
    if (long.endsWith(suf) && long.length > suf.length) {
      const other = long.slice(0, long.length - suf.length);
      if (other !== short && other.length > short.length && isDictionaryWord(other)) return true;
    }
  }
  return false;
}

// Returns the already-claimed word that `word` is a duplicate/plural of, or null.
// `claimedWords` is an array of uppercase words.
export function claimedVariant(word, claimedWords) {
  const w = word.toUpperCase();
  for (const cw0 of claimedWords) {
    const cw = cw0.toUpperCase();
    if (w === cw) return cw0;
    if ((w === cw + "S" || w === cw + "ES") && !hasBetterRoot(w, cw)) return cw0;
    if (w.endsWith("IES") && cw === w.slice(0, -3) + "Y") return cw0;
    if ((cw === w + "S" || cw === w + "ES") && !hasBetterRoot(cw, w)) return cw0;
    if (cw.endsWith("IES") && w === cw.slice(0, -3) + "Y") return cw0;
  }
  return null;
}

// Validates a claim path on an n×n grid of { letter } cells: a straight line (across, down
// or diagonal, either direction) of filled cells spelling `word`. Returns the cleaned path or null.
export function straightPath(grid, word, path, minLen) {
  const n = grid.length;
  if (typeof word !== "string" || !/^[A-Z]{2,}$/.test(word)) return null;
  if (!Array.isArray(path) || path.length !== word.length || path.length < minLen || path.length > n) return null;
  const cells = [];
  for (const p of path) {
    if (!p || !Number.isInteger(p.r) || !Number.isInteger(p.c) || p.r < 0 || p.c < 0 || p.r >= n || p.c >= n) return null;
    cells.push({ r: p.r, c: p.c });
  }
  const dr = Math.sign(cells[1].r - cells[0].r), dc = Math.sign(cells[1].c - cells[0].c);
  if (dr === 0 && dc === 0) return null;
  for (let i = 1; i < cells.length; i++) {
    if (cells[i].r - cells[i - 1].r !== dr || cells[i].c - cells[i - 1].c !== dc) return null;
  }
  if (cells.map(({ r, c }) => grid[r]?.[c]?.letter ?? "").join("") !== word) return null;
  return cells;
}

export { isDictionaryWord };
