// Bot simulator — plays thousands of offline games with the real bot brain and the real game
// rules, to check that (1) difficulty rises smoothly with skill and (2) the adaptive rating
// settles near a 50% win rate for players of any strength.
//
//   node test/botsim.mjs            (quick run)
//   GAMES=200 node test/botsim.mjs  (more games per cell)

import fs from "node:fs";
import { createBotBrain, inGameSkill } from "../public/js/botai.js";
import { initialSkill, nextSkill } from "../party/botskill.js";
import { isBannedWord } from "../party/rules.js";

const root = new URL("..", import.meta.url);
const dictSrc = fs.readFileSync(new URL("party/words.js", root), "utf8");
const DICT = new Set(dictSrc.slice(dictSrc.indexOf('"') + 1, dictSrc.lastIndexOf('"')).split("\\n").filter(Boolean));
const botSrc = fs.readFileSync(new URL("public/botwords.js", root), "utf8");
const BOT_WORDS = botSrc.slice(botSrc.indexOf('"') + 1, botSrc.lastIndexOf('"')).split("\\n").filter(Boolean);
const brain = createBotBrain({ words: BOT_WORDS, isWord: (w) => DICT.has(w), isBanned: (w) => isBannedWord(w) });

const GAMES = Number(process.env.GAMES ?? 60);
let seed = Number(process.env.SEED ?? 12345);
const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// Plays one game. players: [{ id, skill, adaptive? }]. Returns metrics per player.
function playGame(players, { size = 5, minLen = 3, mode = "conquest" } = {}) {
  const grid = Array.from({ length: size }, () => Array(size).fill(null));
  const territory = mode === "off" ? null : Array.from({ length: size }, () => Array(size).fill(null));
  const claimed = [];
  const score = Object.fromEntries(players.map(p => [p.id, 0]));
  const metric = (id) => territory ? territory.flat().filter(o => o === id).length : score[id];
  let cur = 0, passes = 0, turns = 0;
  while (passes < players.length * 2 && turns++ < 400) {
    const p = players[cur];
    const other = players[(cur + 1) % players.length];
    const skill = p.adaptive ? inGameSkill(p.skill, metric(p.id), metric(other.id), size * size) : p.skill;
    const view = { grid, minLen, mode, territory, claimed };
    let letters = 1, acted = false, claims = 0;
    const chain = brain.maxChain(skill, rng);
    for (;;) {
      const full = grid.every(row => row.every(Boolean));
      if (letters > 0 && !full) {
        const mv = brain.planPlacement(view, p.id, skill, rng);
        if (mv) { grid[mv.r][mv.c] = { letter: mv.letter, pi: p.id }; letters--; acted = true; }
      }
      if (claims >= chain) break;
      const w = brain.chooseClaim(view, p.id, skill, { boardFull: grid.every(row => row.every(Boolean)), rng });
      if (!w) break;
      claimed.push(w.word);
      score[p.id] += w.path.length;
      if (territory) for (const c of w.path) territory[c.r][c.c] = p.id;
      letters++; claims++; acted = true;
      if (grid.every(row => row.every(Boolean)) && letters > 0 && claims >= chain) break;
    }
    passes = acted ? 1 : passes + 1;
    cur = (cur + 1) % players.length;
  }
  return Object.fromEntries(players.map(p => [p.id, metric(p.id)]));
}

function result(m, a, b) { return m[a] > m[b] ? "win" : m[a] < m[b] ? "loss" : "draw"; }

const t0 = Date.now();
console.log(`Bot simulator — ${GAMES} games per cell\n`);

// 1. Difficulty ladder: each skill vs a mid-level (0.5) bot
for (const mode of ["conquest", "off"]) {
  console.log(`Win rate vs a level-0.5 bot (${mode === "off" ? "Search" : "Conquest"}, 5×5):`);
  const row = [];
  for (const s of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    let w = 0, d = 0;
    for (let g = 0; g < GAMES; g++) {
      const ps = g % 2 ? [{ id: "A", skill: s }, { id: "B", skill: 0.5 }] : [{ id: "B", skill: 0.5 }, { id: "A", skill: s }];
      const r = result(playGame(ps, { mode }), "A", "B");
      if (r === "win") w++; else if (r === "draw") d++;
    }
    row.push(`skill ${s.toFixed(2)}: ${Math.round(((w + d / 2) / GAMES) * 100)}%`);
  }
  console.log("  " + row.join("  ·  ") + "\n");
}

// 2. Adaptation: a "player" of fixed strength vs Auto bots that re-rate after every game
console.log("Adaptive rating — player strength vs Auto bot, 80 games each (Conquest 5×5):");
for (const [label, h, start] of [["new, weak player", 0.15, initialSkill(0, 0)], ["average player", 0.5, initialSkill(10, 600)], ["strong player", 0.9, initialSkill(40, 4000)]]) {
  let rec = { skill: start, games: 0 };
  const late = [];
  const path = [];
  for (let g = 0; g < 80; g++) {
    const ps = g % 2 ? [{ id: "H", skill: h }, { id: "BOT", skill: rec.skill, adaptive: true }] : [{ id: "BOT", skill: rec.skill, adaptive: true }, { id: "H", skill: h }];
    const m = playGame(ps, { mode: "conquest" });
    const r = result(m, "H", "BOT");
    rec = nextSkill(rec, r, Math.abs(m.H - m.BOT) / Math.max(1, m.H + m.BOT));
    if (g >= 30) late.push(r === "win" ? 1 : r === "draw" ? 0.5 : 0);
    if (g % 10 === 9) path.push(rec.skill.toFixed(2));
  }
  const rate = Math.round((late.reduce((a, b) => a + b, 0) / late.length) * 100);
  console.log(`  ${label.padEnd(18)} starts ${start.toFixed(2)} → bot skill ${path.join(" → ")} · player win rate (games 31–80): ${rate}%`);
}
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
