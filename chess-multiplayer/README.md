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
- **Click-to-move and drag-and-drop**, with highlighted legal moves, last-move
  and check indicators, and a promotion picker.
- **Spectators** can watch any in-progress game.
- **Move list** in algebraic notation, **in-game chat**, **resign** and
  **rematch** (with automatic color swap).
- Reconnect-friendly: the room code lives in the URL hash, so refreshing or
  sharing `…/#ROOMCODE` rejoins.

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
├── server.js              # HTTP + WebSocket server, room & game management
├── src/chess-engine.js    # Shared chess rules engine (runs on server + client)
├── public/
│   ├── index.html         # Lobby + game UI
│   ├── style.css          # Styling
│   └── app.js             # Client: board rendering, WS protocol, interaction
└── test/engine.test.js    # Engine unit tests
```

## How it works

The server keeps the canonical `Chess` game state for each room. When a player
sends a `move`, the server replays it through the engine; if it is legal it
updates the state and broadcasts the new position (plus status: check / mate /
draw) to both players and any spectators. The browser loads the very same
engine module to render legal-move hints locally, which keeps the UI snappy
without trusting the client for correctness.
