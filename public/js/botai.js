// Lexterra — bot brain. Pure functions (no DOM), shared by the game page and test/botsim.mjs.
//
// Bots have two halves on purpose:
//   • Placing letters is always sensible at every level — a bot never litters the board with
//     dead clusters like "SSTT" or "QX". It favours letter patterns that real words contain.
//   • Claiming words is where skill shows. A skill value from 0 (beginner) to 1 (expert) sets how
//     many words the bot knows, how often it spots each word, whether it takes the best one, and
//     how many words it chains in a turn — so weak bots miss things the way people do.
//
// Skill comes from the player's adaptive rating (see growth.js → updateBotSkill), nudged a little
// during the game so matches stay close.

const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
// Rough English letter frequencies (per 1000) — a gentle prior so bots favour natural letters
const FREQ = { E: 127, T: 91, A: 82, O: 75, I: 70, N: 67, S: 63, H: 61, R: 60, D: 43, L: 40, C: 28, U: 28, M: 24, W: 24, F: 22, G: 20, Y: 20, P: 19, B: 15, V: 10, K: 8, J: 2, X: 2, Q: 1, Z: 1 };
const LETTERS = Object.keys(FREQ);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rev = (s) => s.split("").reverse().join("");

export const skillToLevel = (s) => 1 + Math.round(clamp(s, 0, 1) * 9); // 1–10, shown to players
export const DIFFICULTY_SKILL = { easy: 0.15, hard: 0.85 };

// words: the bot vocabulary, most common first. isWord: full dictionary check. isBanned: words bots never play.
export function createBotBrain({ words, isWord, isBanned }) {
  const rank = new Map();
  words.forEach((w, i) => { if (!rank.has(w)) rank.set(w, i); });
  const N = words.length;

  // Letter fragments that appear inside real words (both reading directions are playable)
  const grams = new Set();
  for (const w of words) {
    for (let i = 0; i < w.length - 1; i++) grams.add(w.slice(i, i + 2));
    for (let i = 0; i < w.length - 2; i++) grams.add(w.slice(i, i + 3));
  }
  const fragmentOK = (s) => {
    if (s.length < 2) return true;
    if (s.length === 2) return grams.has(s);
    for (let i = 0; i <= s.length - 3; i++) if (!grams.has(s.slice(i, i + 3))) return false;
    return true;
  };

  // How much of the vocabulary a bot of this skill knows (common words first)
  const vocabSize = (s) => Math.round(1200 + (N - 1200) * Math.pow(clamp(s, 0, 1), 1.3));
  const knows = (word, s) => { const r = rank.get(word); return r !== undefined && r < vocabSize(s); };

  function claimedVariant(word, claimed) {
    for (const cw of claimed) {
      if (word === cw || word === cw + "S" || word === cw + "ES" || cw === word + "S" || cw === word + "ES") return true;
      if (word.endsWith("IES") && cw === word.slice(0, -3) + "Y") return true;
      if (cw.endsWith("IES") && word === cw.slice(0, -3) + "Y") return true;
    }
    return false;
  }

  // Maximal run of letters through (r,c) along a direction, as cells in reading order
  function runThrough(grid, r, c, dr, dc) {
    const n = grid.length;
    let sr = r, sc = c;
    while (sr - dr >= 0 && sr - dr < n && sc - dc >= 0 && sc - dc < n && grid[sr - dr][sc - dc]) { sr -= dr; sc -= dc; }
    const cells = [];
    let cr = sr, cc = sc;
    while (cr >= 0 && cr < n && cc >= 0 && cc < n && grid[cr][cc]) { cells.push({ r: cr, c: cc }); cr += dr; cc += dc; }
    return cells;
  }

  // Can the player claim this path under the room's rules?
  function allowed(view, path, botId) {
    if (view.mode === "exclusive" && view.territory) return !path.some(p => { const o = view.territory[p.r]?.[p.c]; return o && o !== botId; });
    return true;
  }

  // What a word is worth to this bot: points in Search mode, tiles won in territory modes
  function value(view, w, botId) {
    if (!view.territory || view.mode === "off" || !view.mode) return w.path.length;
    let v = 0;
    for (const p of w.path) {
      const o = view.territory[p.r]?.[p.c];
      if (o === botId) continue;
      v += o ? 2 : 1; // stealing a tile swings the count twice
    }
    return v + w.path.length * 0.25;
  }

  // Every claimable word on the board (optionally only those touching one cell)
  function findWords(view, botId, { through = null, dictionaryOnly = false, skill = 1 } = {}) {
    const { grid, minLen } = view;
    const claimed = view.claimed ?? [];
    const out = [];
    const seen = new Set();
    const runs = [];
    if (through) {
      for (const [dr, dc] of DIRS) runs.push(runThrough(grid, through.r, through.c, dr, dc));
    } else {
      const n = grid.length;
      for (const [dr, dc] of DIRS) {
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
          if (!grid[r][c]) continue;
          const pr = r - dr, pc = c - dc;
          if (pr >= 0 && pr < n && pc >= 0 && pc < n && grid[pr][pc]) continue; // not a run start
          runs.push(runThrough(grid, r, c, dr, dc));
        }
      }
    }
    for (const run of runs) {
      if (run.length < minLen) continue;
      const letters = run.map(p => grid[p.r][p.c].letter).join("");
      const at = through ? run.findIndex(p => p.r === through.r && p.c === through.c) : -1;
      for (let i = 0; i < run.length; i++) {
        for (let j = i + minLen - 1; j < run.length; j++) {
          if (through && (at < i || at > j)) continue;
          const fwd = letters.slice(i, j + 1);
          for (const [word, path] of [[fwd, run.slice(i, j + 1)], [rev(fwd), run.slice(i, j + 1).reverse()]]) {
            const key = word + ":" + path[0].r + "," + path[0].c;
            if (seen.has(key)) continue;
            seen.add(key);
            if (!isWord(word) || isBanned(word) || claimedVariant(word, claimed)) continue;
            if (!dictionaryOnly && !knows(word, skill)) continue;
            if (!allowed(view, path, botId)) continue;
            out.push({ word, path, score: path.length });
          }
        }
      }
    }
    return out;
  }

  // ── Placing a letter ─────────────────────────────────────────────────────
  // Score every sensible (cell, letter) pair: keep each line through the cell "word-shaped",
  // set up something to claim, and (for stronger bots) avoid gifting easy words to opponents.
  function planPlacement(view, botId, skill, rng = Math.random) {
    const { grid } = view;
    const n = grid.length;
    const empties = [], frontier = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (grid[r][c]) continue;
      empties.push({ r, c });
      let near = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if ((dr || dc) && grid[r + dr]?.[c + dc]) near++;
      if (near) frontier.push({ r, c, near });
    }
    if (!empties.length) return null;
    let cells = frontier.length ? frontier : empties.filter(p => Math.abs(p.r - (n - 1) / 2) <= 1 && Math.abs(p.c - (n - 1) / 2) <= 1);
    if (!cells.length) cells = empties;
    if (cells.length > 40) cells = cells.sort((a, b) => (b.near ?? 0) - (a.near ?? 0) + (rng() - 0.5)).slice(0, 40);

    const s = clamp(skill, 0, 1);
    let best = null;
    for (const cell of cells) {
      for (const letter of LETTERS) {
        grid[cell.r][cell.c] = { letter, pi: botId };
        let health = 0;
        for (const [dr, dc] of DIRS) {
          const run = runThrough(grid, cell.r, cell.c, dr, dc);
          if (run.length < 2) continue;
          const txt = run.map(p => grid[p.r][p.c].letter).join("");
          health += fragmentOK(txt) || fragmentOK(rev(txt)) ? 1 + Math.min(run.length, 5) * 0.15 : -4;
        }
        const mine = findWords(view, botId, { through: cell, skill: s });
        const bestVal = mine.reduce((m, w) => Math.max(m, value(view, w, botId)), 0);
        // Words any player could take next turn that this bot won't take itself
        const gifts = s > 0.35 ? Math.max(0, findWords(view, botId, { through: cell, dictionaryOnly: true }).length - (mine.length ? 1 : 0)) : 0;
        grid[cell.r][cell.c] = null;
        const sc = 2.2 * health
          + (0.6 + 1.8 * s) * bestVal
          + 0.012 * FREQ[letter]
          - 0.7 * s * gifts
          + (1 - s) * 1.6 * rng();
        if (!best || sc > best.sc) best = { r: cell.r, c: cell.c, letter, sc };
      }
    }
    return best && { r: best.r, c: best.c, letter: best.letter };
  }

  // ── Claiming a word ──────────────────────────────────────────────────────
  // Deliberately human: weaker bots know fewer words, overlook some, and don't always pick the best.
  function chooseClaim(view, botId, skill, { boardFull = false, rng = Math.random } = {}) {
    const s = clamp(skill, 0, 1);
    const found = findWords(view, botId, { skill: s });
    if (!found.length) return null;
    const noticed = found.filter(w => {
      let p = 0.28 + 0.66 * s - (1 - s) * 0.07 * Math.max(0, w.word.length - 4);
      if (boardFull) p += 0.25; // with nothing left to place, everyone looks harder
      return rng() < clamp(p, 0.05, 0.97);
    });
    if (!noticed.length) return null;
    if (rng() < 0.3 + 0.7 * s) {
      return noticed.reduce((a, b) => (value(view, b, botId) > value(view, a, botId) ? b : a));
    }
    return noticed[Math.floor(rng() * noticed.length)];
  }

  // How many words a bot will chain in one turn (each claim earns another letter)
  function maxChain(skill, rng = Math.random) {
    const s = clamp(skill, 0, 1);
    let k = 1;
    while (k < 1 + Math.round(s * 4) && rng() < 0.45 + 0.5 * s) k++;
    return k;
  }

  return { planPlacement, chooseClaim, maxChain, findWords, fragmentOK };
}

// Keeps a game close: when the player is well ahead the bot plays a touch better, and when the
// bot is cruising it eases off. Leads are measured in tiles (territory modes) or points (Search).
export function inGameSkill(base, botMetric, humanMetric, cells) {
  const scale = Math.max(6, cells * 0.2);
  return clamp(base + clamp((humanMetric - botMetric) / scale, -1, 1) * 0.15, 0, 1);
}
