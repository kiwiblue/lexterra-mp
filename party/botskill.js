// Lexterra MP — adaptive bot rating. Each player has a bot skill from 0 (beginner) to 1 (expert)
// that their "Auto" bots play at. Beating the bots nudges it up, losing nudges it down, by equal
// steps — so it settles where the player wins about half their games. Steps shrink as the
// rating gets more games behind it, and lopsided results move it a little further.

export const SKILL_MIN = 0.02, SKILL_MAX = 0.98;

// Starting point for someone with no rating yet: brand-new players get gentle bots,
// people with a few games behind them start nearer the middle.
export function initialSkill(gamesPlayed = 0, xp = 0) {
  if (gamesPlayed < 3 && xp < 150) return 0.18;
  return Math.min(0.55, 0.25 + 0.02 * gamesPlayed + xp / 20000);
}

// result: "win" | "loss" | "draw" from the player's point of view; margin 0..1 (how lopsided)
export function nextSkill(rec, result, margin = 0) {
  const r = { skill: rec.skill, games: rec.games ?? 0, wins: rec.wins ?? 0, losses: rec.losses ?? 0, draws: rec.draws ?? 0 };
  const k = Math.max(0.04, 0.12 / Math.sqrt(1 + r.games / 4));
  const push = k * (1 + Math.min(0.3, Math.max(0, margin)));
  if (result === "win") { r.skill += push; r.wins++; }
  else if (result === "loss") { r.skill -= push; r.losses++; }
  else r.draws++;
  r.skill = Math.round(Math.min(SKILL_MAX, Math.max(SKILL_MIN, r.skill)) * 1000) / 1000;
  r.games++;
  return r;
}
