# Lexterra MP

Online multiplayer version of [Lexterra](https://github.com/kiwiblue/lexterra) — a real-time word-claiming board game.

Built with [PartyServer](https://github.com/cloudflare/partykit/tree/main/packages/partyserver) — real-time game rooms running as
Cloudflare Durable Objects. (Migrated from the PartyKit hosted platform in October 2026, when it shut down.)

## Hosting

|            | Production                          | Dev                                       |
|------------|-------------------------------------|-------------------------------------------|
| Website    | https://lexterragame.com (`main`)   | https://dev.lexterra-mp.pages.dev (`dev`) |
| Server     | Worker `lexterra-mp` → `api.lexterragame.com` | Worker `lexterra-mp-dev` → `dev-api.lexterragame.com` |
| Admin      | https://lexterragame.com/admin      | https://dev.lexterra-mp.pages.dev/admin   |
| Data       | Production Durable Objects          | Separate Durable Objects (safe to mess up) |

The website picks its server by hostname, so the `dev` branch preview always talks to the dev
server and shows a **DEV** badge. All of it lives in the Action Video Cloudflare account.

## Rolling back

- **A feature:** untick it under *Feature Switches* on the admin page — takes effect immediately,
  no deploy. (Tutorial, daily puzzle, streaks, weekly ladder, over-days games, push, install prompt.)
- **The website:** Cloudflare dashboard → Pages → lexterra-mp → Deployments → *Rollback* on an
  earlier deployment, or `git revert` on `main`.
- **The server:** `npx wrangler rollback` (pick an earlier version), or redeploy the git tag
  `prod-v0.5.51` (the last release before the growth features).

## Project Structure

```
party/
  server.js     — Worker entry: routes /parties/<party>/<room> to Durable Objects
  compat.js     — Adapts the original PartyKit-style handlers to PartyServer
  index.js      — Game room (Main): room management, game state, turn logic
  lobby.js      — Public games lobby + online counts (Lobby)
  stats.js      — Leaderboards, XP, coins, admin config (Stats)
  growth.js     — Daily puzzle results, streaks, weekly ladder, analytics, push, My Games (on Stats)
  daily.js      — Daily puzzle generation (seeded by DAILY_SALT) and move replay
  rules.js      — Word rules shared by live games and the daily puzzle
  words.js      — Server copy of the dictionary (generated from public/words.js)
  auth.js       — Email magic-link accounts (Auth)
public/
  index.html    — Game client: home, lobby, board, UI
  js/daily.js   — Daily puzzle screen
  js/tutorial.js — 60-second tutorial
  sw.js, manifest.webmanifest, icons/ — installable app (PWA) + push notifications
  admin.html    — Economy settings, feature switches, analytics
  words.js      — SOWPODS dictionary (copy from standalone)
  _headers      — Security headers for Cloudflare Pages
test/bots.mjs   — End-to-end bot test suite (dev only)
wrangler.jsonc  — Worker + Durable Object config (production + `dev` environment)
```

## Development

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm run dev       # starts the game server locally at localhost:8787
```

The client always talks to `SERVER_HOST` in `public/index.html` (production); point it at
`localhost:8787` temporarily to test against a local server. Local secrets go in `.dev.vars`
(gitignored).

## Deploy

```bash
npm run deploy:dev   # dev server   (push the `dev` branch for the dev website)
npm run deploy       # production   (push `main` for the production website)
```
Deploy the server and push the website together — they're released as a pair.

## Testing with bots

```bash
npm run test:bots                 # ~70 checks against the dev server, ~2 minutes
ONLY=daily,async npm run test:bots
```
Covers live games, spectators, reconnects, High Stakes, the daily puzzle (a dozen solver bots),
streaks, the weekly ladder, analytics, feature switches, over-days games (including push delivery
and turn timeouts), security regressions and 15 simultaneous games. It writes test data, so it
refuses to run against production. The dev admin password lives in `.dev-admin-password` (gitignored).

Login emails (magic links) are sent with Cloudflare Email Service via the `EMAIL` binding, from
`noreply@lexterragame.com` — no API key needed.

Secrets are managed with `npx wrangler secret put <NAME>` (add `--env dev` for dev):
- `ADMIN_PASSWORD` — password for `admin.html`. If unset, admin actions are refused.
- `DAILY_SALT` — seeds the daily puzzle so future boards can't be previewed from the code.
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — signs push notifications.

Server-to-server calls (game results, account merges, lobby updates) carry an internal header
that the Worker strips from every outside request, so they can't be sent from a browser.

## Trust model

The browser is never trusted for anything that affects scores, coins or other players:

- Word claims are re-validated on the server (`validateClaim` in `party/index.js`): straight
  line of filled cells, required length, real dictionary word (`party/words.js`, generated from
  `public/words.js` — keep them in sync), not banned, exclusive-mode territory rules. The score
  is always the word length; the client's score is ignored.
- Letter placement checks the player actually has a letter, and that the cell and letter are valid.
- Game settings are whitelisted (`cleanSettings`); High Stakes config can't be set by the host.
- Coins can only be spent (`spend` on the stats party) at the admin-configured price; the undo
  charge is made by the game room itself. Nothing a browser sends can add coins.
- Player UUIDs are account credentials. They are stripped from all state sent to browsers
  (`publicState`) and leaderboards expose a one-way hash (`pid`) instead.
- Names are sanitised on entry (`cleanName`) so they're safe to render.
- Public-lobby listings are fetched from the game room itself, never taken from the client.
- An email is only linked to an account when its owner clicks the magic link; sends are rate-limited
  per address and globally.
- Daily puzzle submissions are replayed on the server (`replayDaily`); one official attempt per
  player per day. Streak freezes and other coin items are priced by the server.
- Push notifications only go to subscriptions a player registered themselves, and are only sent by
  game rooms (internal calls). Async games: seats are reclaimed by account, never by connection id.

When adding, renaming or removing a Durable Object class, add a new entry to `migrations`
in `wrangler.jsonc` — wrangler does not create them automatically.

## Status

- [x] Project scaffold
- [x] PartyKit server skeleton (create/join/start/place/claim/pass)
- [x] Lobby UI (room codes, player list)
- [ ] Game board (port from standalone)
- [ ] Full turn & timer logic
- [ ] End game screen

## Author & Credits

**Chris Sandford** is the sole author, primary developer, and copyright holder of this project.

AI coding assistance (Anthropic's Claude) was used during development and is credited via
`Co-Authored-By` trailers on relevant commits, but holds no authorship or ownership claim
over this codebase. See [LICENSE](LICENSE) for full copyright terms.
