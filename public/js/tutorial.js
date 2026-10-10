// Lexterra — 60-second guided tutorial on a mini board, ending with an offer to play a
// practice game against an easy bot. Entirely client-side.

let ctx = null; // { track, startPractice, onDone }
let step = 0;
let grid = [];
let picked = null;

const $ = (id) => document.getElementById(id);
const N = 5;

// Each step: message, letter in hand (if placing), the cell to place on, or the word to claim.
const STEPS = [
  { text: "Each turn you get <b>one letter</b>. Your letter is <b>A</b> — tap the glowing square to place it.", place: { r: 1, c: 2, letter: "A" } },
  { text: "You made <b>CAT</b>! Claim it: tap the <b>C</b>, then the <b>T</b>.", claim: { from: { r: 1, c: 1 }, to: { r: 1, c: 3 }, word: "CAT" } },
  { text: "<b>+3 points</b> — one per letter. Claiming a word also earns you <b>another letter</b>. Here's an <b>R</b>: place it below the A.", place: { r: 2, c: 2, letter: "R" } },
  { text: "Words go across, <b>down</b> or diagonally, and can share letters. Claim <b>ART</b>: tap the <b>A</b>, then the <b>T</b> at the bottom.", claim: { from: { r: 1, c: 2 }, to: { r: 3, c: 2 }, word: "ART" } },
  { text: "Nice — <b>6 points</b>! Can't find a word? Tap <b>Pass</b> and the turn moves on. The game ends when the board fills or everyone passes.<br><br>In <b>Conquest</b> and <b>Keeps</b>, the tiles in your words become your territory — most tiles wins. In <b>Search</b>, most points wins.", done: true },
];

function reset() {
  grid = Array.from({ length: N }, () => Array(N).fill(null));
  grid[1][1] = "C"; grid[1][3] = "T"; grid[3][2] = "T"; grid[0][4] = "S"; grid[4][0] = "E";
  step = 0; picked = null;
}

function injectStyles() {
  if ($("tut-styles")) return;
  const st = document.createElement("style");
  st.id = "tut-styles";
  st.textContent = `
    #tutorial-screen { position:fixed; inset:0; background:var(--bg); z-index:950; overflow-y:auto; display:none; }
    #tutorial-screen .t-wrap { max-width:420px; margin:0 auto; padding:1.25rem 1rem; display:flex; flex-direction:column; gap:1rem; }
    #tutorial-screen .t-grid { display:grid; grid-template-columns:repeat(5,1fr); gap:4px; width:min(100%,320px); margin:0 auto; }
    #tutorial-screen .t-cell { aspect-ratio:1; border:2px solid var(--cell-border); border-radius:6px; display:flex; align-items:center; justify-content:center;
      font-weight:900; font-size:clamp(1.2rem,8vw,2.2rem); color:var(--text); background:var(--cell-bg); user-select:none;
      text-shadow:-2px -2px 0 #000,2px -2px 0 #000,-2px 2px 0 #000,2px 2px 0 #000; }
    #tutorial-screen .t-cell.mine { color:var(--brand-ink); }
    #tutorial-screen .t-cell.won { background:rgba(var(--brand-rgb),0.25); border-color:var(--brand-fill); }
    #tutorial-screen .t-cell.target { border-color:var(--daily-fill); cursor:pointer; animation:t-pulse 1s ease-in-out infinite; }
    #tutorial-screen .t-cell.picked { border-color:var(--success); background:rgba(34,197,94,0.25); }
    @keyframes t-pulse { 0%,100% { box-shadow:0 0 0 0 rgba(252,211,77,0.6); } 50% { box-shadow:0 0 0 6px rgba(252,211,77,0); } }
    #tutorial-screen .t-text { font-size:0.98rem; line-height:1.55; color:var(--text-2); text-align:center; min-height:4.5em; }
    #tutorial-screen .t-dots { display:flex; gap:6px; justify-content:center; }
    #tutorial-screen .t-dot { width:8px; height:8px; border-radius:50%; background:var(--border); }
    #tutorial-screen .t-dot.on { background:var(--clr-primary-light); }
  `;
  document.head.appendChild(st);
  const el = document.createElement("div");
  el.id = "tutorial-screen";
  el.innerHTML = `<div class="t-wrap" id="tut-wrap"></div>`;
  document.body.appendChild(el);
}

const won = new Set();
function render() {
  const s = STEPS[step];
  const targets = new Set();
  if (s.place) targets.add(`${s.place.r},${s.place.c}`);
  if (s.claim) targets.add(picked ? `${s.claim.to.r},${s.claim.to.c}` : `${s.claim.from.r},${s.claim.from.c}`);
  $("tut-wrap").innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div style="font-weight:900;letter-spacing:0.12em;color:var(--clr-primary-light)">HOW TO PLAY</div>
      <button onclick="closeTutorial(false)" style="background:none;border:none;color:var(--muted);font-size:0.85rem;cursor:pointer">Skip</button>
    </div>
    <div class="t-dots">${STEPS.map((_, i) => `<div class="t-dot${i <= step ? " on" : ""}"></div>`).join("")}</div>
    ${s.place ? `<div style="display:flex;justify-content:center"><div style="width:52px;height:52px;border-radius:8px;background:var(--clr-primary);color:white;font-weight:900;font-size:1.8rem;display:flex;align-items:center;justify-content:center;text-shadow:-2px -2px 0 #000,2px -2px 0 #000,-2px 2px 0 #000,2px 2px 0 #000">${s.place.letter}</div></div>` : ""}
    <div class="t-grid">
      ${grid.map((row, r) => row.map((l, c) => {
        const k = `${r},${c}`;
        return `<div class="t-cell${targets.has(k) ? " target" : ""}${picked && picked.r === r && picked.c === c ? " picked" : ""}${won.has(k) ? " won" : ""}" data-r="${r}" data-c="${c}">${l ?? ""}</div>`;
      }).join("")).join("")}
    </div>
    <div class="t-text" id="tut-text">${s.text}</div>
    ${s.done ? `
      <button class="btn btn-primary" onclick="tutorialPractice()">Play a practice game vs a bot</button>
      <button class="btn btn-secondary" onclick="closeTutorial(true)">I'm ready — back to the menu</button>` : ""}`;
  document.querySelectorAll("#tut-wrap .t-cell").forEach(el => el.addEventListener("click", () => onCell(+el.dataset.r, +el.dataset.c)));
}

function nudge(text) { const el = $("tut-text"); if (el) { el.innerHTML = `${STEPS[step].text}<br><span style="color:var(--warn-ink);font-size:0.85rem">${text}</span>`; } }

function onCell(r, c) {
  const s = STEPS[step];
  if (s.place) {
    if (r !== s.place.r || c !== s.place.c) return nudge("Tap the glowing square.");
    grid[r][c] = s.place.letter;
    step++; render();
  } else if (s.claim) {
    const want = picked ? s.claim.to : s.claim.from;
    if (r !== want.r || c !== want.c) return nudge(picked ? `Now tap the last letter of ${s.claim.word}.` : `Start with the first letter of ${s.claim.word}.`);
    if (!picked) { picked = { r, c }; render(); return; }
    const dr = Math.sign(s.claim.to.r - s.claim.from.r), dc = Math.sign(s.claim.to.c - s.claim.from.c);
    for (let i = 0; i < s.claim.word.length; i++) won.add(`${s.claim.from.r + i * dr},${s.claim.from.c + i * dc}`);
    picked = null; step++; render();
  }
}

export function openTutorial(context) {
  ctx = context;
  injectStyles();
  reset(); won.clear();
  $("tutorial-screen").style.display = "block";
  document.body.style.overflow = "hidden";
  ctx.track("tutorial_start");
  render();
}

window.closeTutorial = (completed) => {
  $("tutorial-screen").style.display = "none";
  document.body.style.overflow = "";
  try { localStorage.setItem("lexterra_tutorial_done", "1"); } catch {}
  if (completed) ctx.track("tutorial_done");
  ctx.onDone?.();
};

window.tutorialPractice = () => {
  window.closeTutorial(true);
  ctx.track("practice_start");
  ctx.startPractice();
};
