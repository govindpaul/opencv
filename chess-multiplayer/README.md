# ♞ Multiplayer Chess

A real-time, browser-based multiplayer chess game. Two players connect to a
shared room and play with full chess rules; the server is authoritative, so
every move is validated server-side before it is broadcast.

## Features

- **Real-time multiplayer** over WebSockets — create a room, share the code,
  and play.
- **Full chess rules**: legal-move generation, check, checkmate, stalemate,
  castling, en passant, pawn promotion, the fifty-move rule and insufficient
  material draws.
- **Server-authoritative validation** — the same chess engine runs on the
  server and in the browser. The client shows instant legal-move hints; the
  server independently validates every move, so a tampered client cannot cheat.
- **Crisp SVG pieces** (the open "Cburnett" set) that look sharp on desktop
  and mobile.
- **Click-to-move and drag-and-drop** (mouse + touch), with highlighted legal
  moves, last-move and check indicators, smooth move animation, and a
  promotion picker.
- **Sound effects** (synthesized, no downloads) for moves, captures, check,
  castling, promotion and game end — with a toggle.
- **Captured-pieces tray and material advantage** (`+N`), like chess.com.
- **Right-click arrows and square highlights** for analysis (green / red /
  blue / yellow via Shift / Alt / Ctrl).
- **Move-list navigation** — click any move, or use the ◀ ▶ buttons / arrow
  keys, to review earlier positions; press **F** or the Flip button to flip
  the board.
- **Draw offers**, **resign**, a **game-over modal**, and **rematch** (with
  automatic color swap).
- **Spectators** can watch any in-progress game; **in-game chat**.
- **Robust connections**: WebSocket heartbeat, exponential-backoff reconnect,
  and a disconnect grace period so a brief network blip doesn't forfeit your
  seat — you reconnect and reclaim your game.
- **Persistence**: in-progress games are snapshotted to disk so a server
  restart/crash doesn't lose them (see the note under Deploy).
- Reconnect-friendly: the room code lives in the URL hash, so refreshing or
  sharing `…/#ROOMCODE` rejoins.

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| ← / → | Previous / next move |
| Home / End | Jump to start / latest |
| F | Flip board |

## Quick start

```bash
cd chess-multiplayer
npm install
npm start
```

Then open <http://localhost:3000> in two browser tabs (or two devices on the
same network):

1. In the first tab, click **Create new game** and copy the room code.
2. In the second tab, paste the code and click **Join** — or open the copied
   `http://localhost:3000/#ROOMCODE` link directly.
3. White moves first. Have fun!

Set a custom port with `PORT=8080 npm start`.

## Deploy to free public hosting

This app is a **stateful WebSocket server**, so it needs a host that supports
long-lived connections and a persistent process. Vercel/Netlify's free
serverless tiers do **not** (no persistent WebSockets), so use one of the
hosts below. All read the `PORT` env var and serve the game over a single
HTTPS/WSS port automatically.

### Render (recommended, free, one click)

This repo ships a Render Blueprint (`render.yaml`). To deploy:

1. Open <https://dashboard.render.com/blueprints> → **New Blueprint Instance**.
2. Connect this GitHub repo and pick the branch
   `claude/multiplayer-web-chess-3oua9t`.
3. Render reads `render.yaml`, builds, and gives you a public URL like
   `https://multiplayer-chess.onrender.com`.

Or one-click with the deploy button (after pushing the branch):

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

> Render's free web services spin down after ~15 min of inactivity and take a
> few seconds to wake on the next visit — fine for casual play.

### Railway / Fly.io / any container host

A `Dockerfile` is included, so you can deploy the `chess-multiplayer/`
directory to any container platform:

- **Railway**: New Project → Deploy from GitHub repo → set root directory to
  `chess-multiplayer`. It auto-detects the Dockerfile.
- **Fly.io**: `cd chess-multiplayer && fly launch` (uses the Dockerfile).

### Manual web service (any Node host)

- Build command: `npm install`
- Start command: `npm start`
- Root directory: `chess-multiplayer`
- Node version: 18+

## Running the tests

The chess engine has a standalone test suite covering move generation,
captures, castling, en passant, promotion, checkmate and stalemate:

```bash
npm test
```

## Project layout

```
chess-multiplayer/
├── server.js              # HTTP + WebSocket server, rooms, persistence
├── src/chess-engine.js    # Shared chess rules engine (runs on server + client)
├── public/
│   ├── index.html         # Lobby + game UI
│   ├── style.css          # Styling
│   ├── app.js             # Client: board, WS protocol, interaction
│   ├── pieces.js          # Embedded SVG piece set (Cburnett)
│   └── sounds.js          # Web Audio sound effects
└── test/engine.test.js    # Engine unit tests
```

## How it works

The server keeps the canonical `Chess` game state for each room. When a player
sends a `move`, the server replays it through the engine; if it is legal it
updates the state and broadcasts the new position (plus status: check / mate /
draw) to both players and any spectators. The browser loads the very same
engine module to render legal-move hints locally, which keeps the UI snappy
without trusting the client for correctness.

## Persistence and the Render free tier

In-progress games are snapshotted to `chess-multiplayer/.data/rooms.json`
(override with the `CHESS_DATA_FILE` env var) and reloaded on startup, so a
server restart or crash doesn't lose games — players reconnect and reclaim
their seats.

**Important:** this needs a durable filesystem. Render's **free** tier has an
**ephemeral** disk that is wiped on every redeploy, restart and spin-down, so
games will *not* survive a redeploy there. Options for durable storage on
Render free are an external database (e.g. Postgres/Redis) or a paid plan with
a [persistent disk](https://render.com/docs/disks). On a normal host, a paid
disk, or local/self-hosting, file persistence works as-is.

## Credits

Chess piece graphics are the **Cburnett** set (the set used by Wikipedia and
lichess), distributed under a free license (GPL/BSD/CC-BY-SA).
