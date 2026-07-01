# Lexterra MP

Online multiplayer version of [Lexterra](https://github.com/kiwiblue/lexterra) — a real-time word-claiming board game.

Built with [PartyKit](https://www.partykit.io) for real-time game rooms.

## Project Structure

```
party/
  index.js      — PartyKit server: room management, game state, turn logic
public/
  index.html    — Game client: lobby, board, UI
  words.js      — SOWPODS dictionary (copy from standalone)
partykit.json   — PartyKit config
```

## Development

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm run dev       # starts local PartyKit server at localhost:1999
```

Open `http://localhost:1999` in multiple browser tabs to test multiplayer locally.

## Deploy

```bash
npm run deploy    # deploys to PartyKit cloud (free hobby tier)
```

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
