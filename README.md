# Lexterra MP

Online multiplayer version of [Lexterra](https://github.com/kiwiblue/lexterra) — a real-time word-claiming board game.

Built with [PartyServer](https://github.com/cloudflare/partykit/tree/main/packages/partyserver) — real-time game rooms running as
Cloudflare Durable Objects. (Migrated from the PartyKit hosted platform in October 2026, when it shut down.)

## Hosting

- **Game server** — Cloudflare Worker `lexterra-mp` at `https://api.lexterragame.com`
- **Website** — Cloudflare Pages project `lexterra-mp` at `https://lexterragame.com`, auto-deployed from the `main` branch (`public/`)

Both live in the Action Video Cloudflare account.

## Project Structure

```
party/
  server.js     — Worker entry: routes /parties/<party>/<room> to Durable Objects
  compat.js     — Adapts the original PartyKit-style handlers to PartyServer
  index.js      — Game room (Main): room management, game state, turn logic
  lobby.js      — Public games lobby + online counts (Lobby)
  stats.js      — Leaderboards, XP, coins, admin config (Stats)
  auth.js       — Email magic-link accounts (Auth)
public/
  index.html    — Game client: lobby, board, UI
  admin.html    — Coin economy & High Stakes admin
  words.js      — SOWPODS dictionary (copy from standalone)
wrangler.jsonc  — Worker + Durable Object config
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
npm run deploy    # wrangler deploy → Action Video Cloudflare account
```

Login emails (magic links) are sent with Cloudflare Email Service via the `EMAIL` binding, from
`noreply@lexterragame.com` — no API key needed.

Secrets are managed with `npx wrangler secret put <NAME>`:
- `ADMIN_PASSWORD` — password for `admin.html`. If unset, admin actions are refused.

Server-to-server calls (game results, account merges, lobby updates) carry an internal header
that the Worker strips from every outside request, so they can't be sent from a browser.

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
