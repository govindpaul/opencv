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
 * Protocol (JSON messages):
 *   client -> server: { type: 'create' }
 *                     { type: 'join', room }
 *                     { type: 'move', from, to, promotion }
 *                     { type: 'resign' }
 *                     { type: 'rematch' }
 *                     { type: 'chat', text }
 *   server -> client: { type: 'joined', room, color, state, players, spectator }
 *                     { type: 'state', state, status, players, lastMove }
 *                     { type: 'chat', from, text }
 *                     { type: 'error', message }
 *                     { type: 'opponent', event }   // 'left' | 'joined'
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
    players: { w: null, b: null }, // client objects
    spectators: [],
    gameOver: null, // { result, reason }
    rematchVotes: {}
  };
  return rooms[code];
}

function publicPlayers(room) {
  return {
    w: room.players.w ? true : false,
    b: room.players.b ? true : false
  };
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastState(room, lastMove) {
  var status = room.gameOver
    ? { over: true, result: room.gameOver.result, reason: room.gameOver.reason }
    : room.game.status();
  var payload = {
    type: 'state',
    state: room.game.getState(),
    status: status,
    players: publicPlayers(room),
    lastMove: lastMove || null
  };
  everyone(room).forEach(function (c) { send(c.ws, payload); });
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

function assignColor(room) {
  if (!room.players.w) return 'w';
  if (!room.players.b) return 'b';
  return null; // spectator
}

// ---- Connection handling ------------------------------------------------

wss.on('connection', function (ws) {
  var client = { ws: ws, room: null, color: null };

  ws.on('message', function (raw) {
    var msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return send(ws, { type: 'error', message: 'Invalid message' });
    }
    handleMessage(client, msg);
  });

  ws.on('close', function () {
    handleDisconnect(client);
  });
});

function handleMessage(client, msg) {
  switch (msg.type) {
    case 'create':
      return doJoin(client, createRoom().code);
    case 'join':
      return doJoin(client, (msg.room || '').toUpperCase().trim());
    case 'move':
      return doMove(client, msg);
    case 'resign':
      return doResign(client);
    case 'rematch':
      return doRematch(client);
    case 'chat':
      return doChat(client, msg);
    default:
      return send(client.ws, { type: 'error', message: 'Unknown command' });
  }
}

function doJoin(client, code) {
  var room = rooms[code];
  if (!room) {
    return send(client.ws, { type: 'error', message: 'Room "' + code + '" not found' });
  }
  // Leave any previous room first.
  if (client.room) handleDisconnect(client);

  var color = assignColor(room);
  client.room = room;
  client.color = color;

  var spectator = false;
  if (color) {
    room.players[color] = client;
  } else {
    spectator = true;
    room.spectators.push(client);
  }

  send(client.ws, {
    type: 'joined',
    room: room.code,
    color: color, // null for spectators
    spectator: spectator,
    state: room.game.getState(),
    status: room.gameOver
      ? { over: true, result: room.gameOver.result, reason: room.gameOver.reason }
      : room.game.status(),
    players: publicPlayers(room)
  });

  broadcast(room, { type: 'opponent', event: 'joined', players: publicPlayers(room) }, client);
}

function doMove(client, msg) {
  var room = client.room;
  if (!room) return send(client.ws, { type: 'error', message: 'Not in a room' });
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

  // Detect game end.
  var status = room.game.status();
  if (status.over) {
    room.gameOver = { result: status.result, reason: status.reason };
  }

  broadcastState(room, record);
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
  broadcast(room, { type: 'chat', from: 'system', text: (client.color === 'w' ? 'White' : 'Black') + ' wants a rematch.' });

  if (room.rematchVotes.w && room.rematchVotes.b) {
    // Swap colors so players alternate sides.
    var w = room.players.w, b = room.players.b;
    room.players.w = b;
    room.players.b = w;
    if (room.players.w) room.players.w.color = 'w';
    if (room.players.b) room.players.b.color = 'b';
    room.game = new Chess();
    room.gameOver = null;
    room.rematchVotes = {};
    everyone(room).forEach(function (c) {
      send(c.ws, {
        type: 'joined',
        room: room.code,
        color: c.color,
        spectator: !c.color,
        state: room.game.getState(),
        status: room.game.status(),
        players: publicPlayers(room)
      });
    });
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

  if (client.color && room.players[client.color] === client) {
    room.players[client.color] = null;
    delete room.rematchVotes[client.color];
    broadcast(room, { type: 'opponent', event: 'left', players: publicPlayers(room) }, client);
  } else {
    var idx = room.spectators.indexOf(client);
    if (idx !== -1) room.spectators.splice(idx, 1);
  }

  client.room = null;
  client.color = null;

  // Clean up empty rooms.
  if (!room.players.w && !room.players.b && room.spectators.length === 0) {
    delete rooms[room.code];
  }
}

server.listen(PORT, function () {
  console.log('Chess server running at http://localhost:' + PORT);
});
