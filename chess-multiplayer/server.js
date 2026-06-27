/*
 * server.js — Multiplayer chess server.
 *
 * Responsibilities:
 *   - Serve the static frontend from /public.
 *   - Manage game rooms over WebSocket.
 *   - Hold the authoritative game state; every move is validated server-side
 *     with the shared chess engine before being broadcast, so a tampered
 *     client cannot make an illegal move.
 *
 * Connection robustness:
 *   - A ping/pong heartbeat keeps connections alive through proxies (which
 *     close "idle" WebSockets) and detects dead sockets.
 *   - Players have a stable playerId, so a dropped client can reconnect and
 *     reclaim its seat (and the live game) instead of becoming a spectator.
 *   - A disconnect grace period means a brief network blip does not forfeit
 *     a player's seat.
 *
 * Protocol (JSON messages):
 *   client -> server: { type: 'create', playerId? }
 *                     { type: 'join', room, playerId? }
 *                     { type: 'move', from, to, promotion }
 *                     { type: 'resign' }
 *                     { type: 'rematch' }
 *                     { type: 'chat', text }
 *                     { type: 'ping' }
 *   server -> client: { type: 'joined', room, color, playerId, state, status,
 *                       players, spectator, reconnected }
 *                     { type: 'state', state, status, players, lastMove }
 *                     { type: 'chat', from, text }
 *                     { type: 'error', message }
 *                     { type: 'opponent', event, players }
 *                       // event: 'joined' | 'left' | 'disconnected' | 'reconnected'
 *                     { type: 'pong' }
 */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var WebSocket = require('ws');
var Chess = require('./src/chess-engine');

var PORT = process.env.PORT || 3000;
var PUBLIC_DIR = path.join(__dirname, 'public');
var SRC_DIR = path.join(__dirname, 'src');

// How long a player's seat is held open after a disconnect, allowing a
// reconnect to reclaim it before the seat is freed.
var DISCONNECT_GRACE_MS = 60 * 1000;
// Heartbeat interval; well under typical proxy idle timeouts (~55-120s).
var HEARTBEAT_MS = 25 * 1000;

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// ---- Static file server -------------------------------------------------

function serveStatic(req, res) {
  var urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // A small health endpoint (useful for uptime pings on free hosting).
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // The browser loads the shared engine from /src/chess-engine.js.
  var baseDir = urlPath.indexOf('/src/') === 0 ? __dirname : PUBLIC_DIR;
  var rel = urlPath.indexOf('/src/') === 0 ? urlPath.slice(1) : urlPath;
  var filePath = path.normalize(path.join(baseDir, rel));

  // Prevent path traversal outside the served roots.
  if (filePath.indexOf(PUBLIC_DIR) !== 0 && filePath.indexOf(SRC_DIR) !== 0) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    var ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

var server = http.createServer(serveStatic);
var wss = new WebSocket.Server({ server });

// ---- Room management ----------------------------------------------------

var rooms = Object.create(null);

function genId() {
  return crypto.randomBytes(9).toString('hex');
}

function makeRoomCode() {
  var code;
  do {
    code = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6 hex chars
  } while (rooms[code]);
  return code;
}

function createRoom() {
  var code = makeRoomCode();
  rooms[code] = {
    code: code,
    game: new Chess(),
    players: { w: null, b: null },          // live client objects (or null)
    seats: { w: null, b: null },            // { id } — reserved owner of a seat
    disconnectTimers: { w: null, b: null }, // grace-period timers
    spectators: [],
    gameOver: null,                         // { result, reason }
    drawOffer: null,                        // color that has an open draw offer
    rematchVotes: {},
    updatedAt: Date.now()
  };
  scheduleSave();
  return rooms[code];
}

// ---- Persistence --------------------------------------------------------
//
// Game state is snapshotted to a JSON file so a server restart / crash does
// not lose in-progress games (players reconnect and reclaim their seats).
//
// NOTE: this requires a durable filesystem. Render's FREE tier has an
// EPHEMERAL disk (wiped on every redeploy, restart and spin-down), so games
// will NOT survive a redeploy there — that needs an external store (e.g.
// Postgres/Redis) or a paid plan with a persistent disk. On a normal host,
// a paid disk, or local/self-hosting this keeps games safe across restarts.

var DATA_FILE = process.env.CHESS_DATA_FILE || path.join(__dirname, '.data', 'rooms.json');
var ROOM_TTL_MS = 24 * 60 * 60 * 1000; // forget rooms untouched for 24h
var saveTimer = null;

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(function () {
    saveTimer = null;
    persistNow();
  }, 1000);
}

function persistNow() {
  try {
    var dump = [];
    Object.keys(rooms).forEach(function (code) {
      var r = rooms[code];
      // Only persist rooms with an owned seat (i.e. a real game in progress).
      if (!r.seats.w && !r.seats.b) return;
      dump.push({
        code: r.code,
        game: r.game.getState(),
        seats: r.seats,
        gameOver: r.gameOver,
        updatedAt: r.updatedAt || Date.now()
      });
    });
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(dump));
  } catch (e) {
    console.error('persist failed:', e && e.message);
  }
}

function loadPersisted() {
  var raw;
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8');
  } catch (e) {
    return; // no snapshot yet
  }
  var dump;
  try {
    dump = JSON.parse(raw);
  } catch (e) {
    console.error('corrupt persistence file, ignoring');
    return;
  }
  var now = Date.now();
  var restored = 0;
  dump.forEach(function (d) {
    if (!d || !d.code) return;
    if (now - (d.updatedAt || 0) > ROOM_TTL_MS) return; // stale
    try {
      rooms[d.code] = {
        code: d.code,
        game: new Chess(d.game),
        players: { w: null, b: null },
        seats: d.seats || { w: null, b: null },
        disconnectTimers: { w: null, b: null },
        spectators: [],
        gameOver: d.gameOver || null,
        drawOffer: null,
        rematchVotes: {},
        updatedAt: d.updatedAt || now
      };
      restored++;
    } catch (e) {
      console.error('skip unrestorable room', d.code, e && e.message);
    }
  });
  if (restored) console.log('restored ' + restored + ' game(s) from disk');
}

function publicPlayers(room) {
  // A seat counts as "present" only when a live client occupies it.
  return {
    w: !!room.players.w,
    b: !!room.players.b
  };
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function everyone(room) {
  var list = [];
  if (room.players.w) list.push(room.players.w);
  if (room.players.b) list.push(room.players.b);
  return list.concat(room.spectators);
}

function broadcast(room, msg, except) {
  everyone(room).forEach(function (c) {
    if (c !== except) send(c.ws, msg);
  });
}

function statusOf(room) {
  return room.gameOver
    ? { over: true, result: room.gameOver.result, reason: room.gameOver.reason }
    : room.game.status();
}

function broadcastState(room, lastMove) {
  room.updatedAt = Date.now();
  var payload = {
    type: 'state',
    state: room.game.getState(),
    status: statusOf(room),
    players: publicPlayers(room),
    lastMove: lastMove || null,
    drawOffer: room.drawOffer || null
  };
  everyone(room).forEach(function (c) { send(c.ws, payload); });
  scheduleSave();
}

// First seat with no reserved owner, or null if both are taken/reserved.
function openColor(room) {
  if (!room.seats.w) return 'w';
  if (!room.seats.b) return 'b';
  return null;
}

function seatColorForPlayer(room, playerId) {
  if (!playerId) return null;
  if (room.seats.w && room.seats.w.id === playerId) return 'w';
  if (room.seats.b && room.seats.b.id === playerId) return 'b';
  return null;
}

function roomIsEmpty(room) {
  return !room.players.w && !room.players.b &&
    !room.seats.w && !room.seats.b &&
    room.spectators.length === 0;
}

function maybeCleanup(room) {
  if (roomIsEmpty(room)) {
    delete rooms[room.code];
  }
}

// ---- Connection handling ------------------------------------------------

wss.on('connection', function (ws) {
  var client = { ws: ws, room: null, color: null, playerId: null };

  ws.isAlive = true;
  ws.on('pong', function () { ws.isAlive = true; });

  ws.on('message', function (raw) {
    var msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return send(ws, { type: 'error', message: 'Invalid message' });
    }
    // A bug or malformed payload must never take down the whole server (and
    // with it every other in-progress game), so isolate per-message handling.
    try {
      handleMessage(client, msg);
    } catch (err) {
      console.error('handler error:', err && err.message);
      send(ws, { type: 'error', message: 'Server error handling request' });
    }
  });

  ws.on('close', function () {
    handleDisconnect(client);
  });

  ws.on('error', function () {
    // A socket error is followed by 'close'; nothing extra to do here, but
    // swallowing it prevents an unhandled 'error' from crashing the process.
  });
});

// Heartbeat sweep: terminate sockets that did not answer the previous ping,
// then ping everyone again.
var heartbeat = setInterval(function () {
  wss.clients.forEach(function (ws) {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  });
}, HEARTBEAT_MS);

wss.on('close', function () { clearInterval(heartbeat); });

function handleMessage(client, msg) {
  switch (msg.type) {
    case 'create':
      return doJoin(client, createRoom().code, msg.playerId);
    case 'join':
      return doJoin(client, String(msg.room || '').toUpperCase().trim(), msg.playerId);
    case 'move':
      return doMove(client, msg);
    case 'resign':
      return doResign(client);
    case 'rematch':
      return doRematch(client);
    case 'chat':
      return doChat(client, msg);
    case 'draw':
      return doDraw(client, msg);
    case 'ping':
      // Application-level keepalive (some proxies only reset their idle timer
      // on data frames, not WebSocket control frames).
      return send(client.ws, { type: 'pong' });
    default:
      return send(client.ws, { type: 'error', message: 'Unknown command' });
  }
}

function doJoin(client, code, playerId) {
  var room = rooms[code];
  if (!room) {
    return send(client.ws, { type: 'error', message: 'Room "' + code + '" not found' });
  }

  // Leave any previous room first (e.g. switching rooms on one connection).
  if (client.room && client.room !== room) handleDisconnect(client);

  client.playerId = playerId || client.playerId || genId();

  // Try to reclaim a seat this player already owns (reconnect); otherwise
  // take an open seat; otherwise spectate.
  var color = seatColorForPlayer(room, client.playerId);
  var reconnected = !!color;
  if (!color) color = openColor(room);

  client.room = room;
  client.color = color;

  var spectator = false;
  if (color) {
    // Cancel any pending grace timer for this seat and (re)occupy it.
    if (room.disconnectTimers[color]) {
      clearTimeout(room.disconnectTimers[color]);
      room.disconnectTimers[color] = null;
    }
    // If a different live client somehow holds the seat, displace it.
    if (room.players[color] && room.players[color] !== client) {
      var old = room.players[color];
      old.room = null;
      old.color = null;
      send(old.ws, { type: 'error', message: 'Seat taken over by another connection' });
    }
    room.seats[color] = { id: client.playerId };
    room.players[color] = client;
  } else {
    spectator = true;
    if (room.spectators.indexOf(client) === -1) room.spectators.push(client);
  }

  send(client.ws, {
    type: 'joined',
    room: room.code,
    color: color,            // null for spectators
    playerId: client.playerId,
    spectator: spectator,
    reconnected: reconnected,
    state: room.game.getState(),
    status: statusOf(room),
    players: publicPlayers(room),
    drawOffer: room.drawOffer || null
  });

  broadcast(room, {
    type: 'opponent',
    event: reconnected ? 'reconnected' : 'joined',
    players: publicPlayers(room)
  }, client);

  room.updatedAt = Date.now();
  scheduleSave();
}

var SQUARE_RE = /^[a-h][1-8]$/;
var PROMO_RE = /^[qrbn]$/;

function doMove(client, msg) {
  var room = client.room;
  if (!room) return send(client.ws, { type: 'error', message: 'Not in a room' });
  // Validate coordinates before they reach the engine.
  if (!SQUARE_RE.test(msg.from) || !SQUARE_RE.test(msg.to) ||
      (msg.promotion != null && !PROMO_RE.test(msg.promotion))) {
    return send(client.ws, { type: 'error', message: 'Invalid move' });
  }
  if (room.gameOver) return send(client.ws, { type: 'error', message: 'Game is over' });
  if (!client.color) return send(client.ws, { type: 'error', message: 'Spectators cannot move' });
  if (room.game.turn !== client.color) {
    return send(client.ws, { type: 'error', message: 'Not your turn' });
  }
  if (!room.players.w || !room.players.b) {
    return send(client.ws, { type: 'error', message: 'Waiting for an opponent' });
  }

  var record = room.game.move({ from: msg.from, to: msg.to, promotion: msg.promotion });
  if (!record) {
    return send(client.ws, { type: 'error', message: 'Illegal move' });
  }

  // Any move withdraws an outstanding draw offer.
  room.drawOffer = null;

  var status = room.game.status();
  if (status.over) {
    room.gameOver = { result: status.result, reason: status.reason };
  }

  broadcastState(room, record);
}

function doDraw(client, msg) {
  var room = client.room;
  if (!room || !client.color || room.gameOver) return;
  if (!room.players.w || !room.players.b) return;
  var action = msg.action;

  if (action === 'offer') {
    if (room.drawOffer) return; // an offer is already pending
    room.drawOffer = client.color;
    var label = client.color === 'w' ? 'White' : 'Black';
    broadcast(room, { type: 'chat', from: 'system', text: label + ' offers a draw.' });
    // Tell the opponent so they can show accept/decline.
    var opp = client.color === 'w' ? room.players.b : room.players.w;
    send(opp.ws, { type: 'drawOffer', from: client.color });
  } else if (action === 'accept') {
    // Only the side that did NOT offer can accept.
    if (!room.drawOffer || room.drawOffer === client.color) return;
    room.drawOffer = null;
    room.gameOver = { result: 'draw', reason: 'agreement' };
    broadcastState(room, null);
  } else if (action === 'decline') {
    if (!room.drawOffer || room.drawOffer === client.color) return;
    room.drawOffer = null;
    broadcast(room, { type: 'chat', from: 'system', text: 'Draw offer declined.' });
    broadcast(room, { type: 'drawDeclined' });
  }
}

function doResign(client) {
  var room = client.room;
  if (!room || !client.color || room.gameOver) return;
  var winner = client.color === 'w' ? 'b' : 'w';
  room.gameOver = { result: winner, reason: 'resignation' };
  broadcastState(room, null);
}

function doRematch(client) {
  var room = client.room;
  if (!room || !client.color) return;
  if (!room.gameOver) return;
  room.rematchVotes[client.color] = true;
  broadcast(room, {
    type: 'chat', from: 'system',
    text: (client.color === 'w' ? 'White' : 'Black') + ' wants a rematch.'
  });

  if (room.rematchVotes.w && room.rematchVotes.b) {
    // Swap colors so players alternate sides; keep seat ownership in sync.
    var w = room.players.w, b = room.players.b;
    room.players.w = b;
    room.players.b = w;
    if (room.players.w) room.players.w.color = 'w';
    if (room.players.b) room.players.b.color = 'b';
    room.seats.w = room.players.w ? { id: room.players.w.playerId } : null;
    room.seats.b = room.players.b ? { id: room.players.b.playerId } : null;
    room.game = new Chess();
    room.gameOver = null;
    room.drawOffer = null;
    room.rematchVotes = {};
    room.updatedAt = Date.now();
    everyone(room).forEach(function (c) {
      send(c.ws, {
        type: 'joined',
        room: room.code,
        color: c.color,
        playerId: c.playerId,
        spectator: !c.color,
        reconnected: false,
        state: room.game.getState(),
        status: room.game.status(),
        players: publicPlayers(room)
      });
    });
    scheduleSave();
  }
}

function doChat(client, msg) {
  var room = client.room;
  if (!room) return;
  var text = String(msg.text || '').slice(0, 300);
  if (!text.trim()) return;
  var label = client.color === 'w' ? 'White' : client.color === 'b' ? 'Black' : 'Spectator';
  broadcast(room, { type: 'chat', from: label, text: text });
}

function handleDisconnect(client) {
  var room = client.room;
  if (!room) return;
  var color = client.color;

  if (color && room.players[color] === client) {
    // Free the live connection but hold the seat open for a grace period so
    // the player can reconnect and reclaim it.
    room.players[color] = null;
    broadcast(room, { type: 'opponent', event: 'disconnected', players: publicPlayers(room) }, client);

    if (room.disconnectTimers[color]) clearTimeout(room.disconnectTimers[color]);
    room.disconnectTimers[color] = setTimeout(function () {
      room.disconnectTimers[color] = null;
      // Only release if nobody reclaimed the seat in the meantime.
      if (!room.players[color]) {
        room.seats[color] = null;
        delete room.rematchVotes[color];
        broadcast(room, { type: 'opponent', event: 'left', players: publicPlayers(room) });
        maybeCleanup(room);
        scheduleSave();
      }
    }, DISCONNECT_GRACE_MS);
  } else {
    var idx = room.spectators.indexOf(client);
    if (idx !== -1) room.spectators.splice(idx, 1);
  }

  client.room = null;
  client.color = null;
  maybeCleanup(room);
}

// Last-resort safety nets: a single unexpected error should not terminate
// the process and disconnect every active game.
process.on('uncaughtException', function (err) {
  console.error('uncaughtException:', err && err.stack || err);
});
process.on('unhandledRejection', function (reason) {
  console.error('unhandledRejection:', reason);
});

loadPersisted();

server.listen(PORT, function () {
  console.log('Chess server running at http://localhost:' + PORT);
});
