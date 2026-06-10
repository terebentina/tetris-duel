# Tetris Duel — 1v1 multiplayer Tetris

Browser-based 1v1 Tetris where clearing lines curses your opponent. Last
player standing wins.

## How the duel works

Both players get the **same piece sequence** (shared seed, 7-bag
randomizer), so it's pure skill. Clearing lines inflicts difficulty
effects on your opponent — the more lines at once, the worse it gets:

| Lines cleared | Effect on your opponent |
| --- | --- |
| 1 | ☠ **Cursed pieces** — their next piece(s) are awkward S/Z bricks |
| 2 | 💨 + **Wind** — gusts push their falling piece off its vertical line |
| 3 | 🌀 + **Spin** — their piece auto-rotates on its own |
| 4 (Tetris) | 🔥 All of the above, longer and stronger |

Effects are measured in pieces: e.g. a triple gives the opponent 3 cursed
pieces, wind for 4 pieces and auto-spin for 3 pieces. Effects stack if you
keep clearing. The game ends when one player's stack reaches the top
(or they disconnect — forfeit).

### Controls

`←`/`→` move · `↑`/`X` rotate · `Z` rotate back · `↓` soft drop ·
`Space` hard drop

## Running

```bash
cd tetris
npm install
npm start            # http://localhost:3000  (PORT env to override)
```

Open the page in two browsers: one player hits **Create game** and shares
the 4-letter room code; the other joins with it. Both press **Ready**.

The leaderboard (wins/losses/lines per player name) persists to
`server/data/leaderboard.json` (override with `LEADERBOARD_FILE`).

## Docker

```bash
docker build -t tetris-duel .
docker run -p 3000:3000 -v tetris-data:/app/server/data tetris-duel
```

Note for Kubernetes/ingress deployments: the game uses WebSockets on the
same port as HTTP, so the ingress must allow connection upgrades.

## Architecture

- `server/server.js` — HTTP static server + WebSocket endpoint (`ws`),
  `/api/leaderboard`, `/healthz`
- `server/rooms.js` — transport-agnostic matchmaking/relay logic
  (rooms, ready/start with shared seed, attack relay, forfeits, rematch)
- `server/leaderboard.js` — JSON-file persistence
- `public/js/engine.js` — the Tetris engine (pure logic, runs in Node
  and the browser): board, gravity, kicks, line clears, attack effects
- `public/js/pieces.js` — tetromino tables, seeded RNG, 7-bag
- `public/js/render.js` — canvas renderer: particles, wind gusts, line
  flashes, screen shake, ghost piece, previews
- `public/js/main.js` — screens (menu/lobby/game), input (DAS/ARR),
  game loop, network glue

Gameplay runs client-side; the server relays board snapshots and attack
events and is the authority on match start/end and the leaderboard.

## Tests

```bash
npm test             # engine, pieces, rooms, leaderboard, ws e2e, fuzz
```

The suite includes a full end-to-end match over real WebSockets and a
fuzz test that plays thousands of random moves checking engine
invariants. There is also a headless-browser test (two Chromium pages
playing a real match) that runs automatically when Playwright Chromium
is installed: `npx playwright install chromium`.
