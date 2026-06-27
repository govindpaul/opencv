/*
 * integration.test.js — end-to-end server/protocol QA over real WebSockets.
 *
 * Spawns the actual server and drives it with WebSocket clients to cover the
 * multiplayer protocol, gameplay rules over the wire, connection robustness
 * (liveness with stripped pongs, seat reclaim, persistence across restart) and
 * error handling. Run with `npm test` (alongside the engine unit tests).
 */
'use strict';

var path = require('path');
var fs = require('fs');
var os = require('os');
var { spawn } = require('child_process');
var WebSocket = require('ws');

// Short liveness sweep so the stripped-pong test runs quickly.
process.env.CHESS_HEARTBEAT_MS = process.env.CHESS_HEARTBEAT_MS || '700';

var SERVER = path.join(__dirname, '..', 'server.js');
var PORT = 9033;
var URL = 'ws://localhost:' + PORT;
var DATA = path.join(os.tmpdir(), 'chess-qa-' + process.pid + '.json');

var passed = 0, failed = 0;
function ok(cond, name) { if (cond) passed++; else { failed++; console.error('  FAIL: ' + name); } }
var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

function startServer(extraEnv) {
  var env = Object.assign({}, process.env, { PORT: String(PORT), CHESS_DATA_FILE: DATA }, extraEnv || {});
  var p = spawn('node', [SERVER], { env: env, stdio: 'ignore' });
  return p;
}

function client(opts) {
  var ws = new WebSocket(URL, opts);
  ws.msgs = [];
  ws.alive = true;
  ws.on('message', function (d) { ws.msgs.push(JSON.parse(d)); });
  ws.on('close', function () { ws.alive = false; });
  ws.on('error', function () {});
  return ws;
}
function send(ws, m) { ws.send(JSON.stringify(m)); }
function last(ws, type) { for (var i = ws.msgs.length - 1; i >= 0; i--) if (ws.msgs[i].type === type) return ws.msgs[i]; return null; }
function waitFor(ws, type, ms) {
  ms = ms || 2000;
  var start = Date.now();
  return (function poll() {
    if (last(ws, type)) return Promise.resolve(last(ws, type));
    if (Date.now() - start > ms) return Promise.resolve(null);
    return wait(40).then(poll);
  })();
}

async function play(ws, opp, moves) {
  for (var i = 0; i < moves.length; i++) {
    var who = i % 2 === 0 ? ws : opp;
    send(who, { type: 'move', from: moves[i][0], to: moves[i][1], promotion: moves[i][2] });
    await wait(60);
  }
}

async function main() {
  try { fs.unlinkSync(DATA); } catch (e) {}
  var srv = startServer();
  await wait(900);

  // ---- 1. Create / join / colors / turn enforcement ----
  var a = client(), b = client();
  await wait(150);
  send(a, { type: 'create' });
  var ja = await waitFor(a, 'joined');
  ok(ja && ja.color === 'w', 'creator is white');
  var room = ja.room, aId = ja.playerId;
  send(b, { type: 'join', room: room });
  var jb = await waitFor(b, 'joined');
  ok(jb && jb.color === 'b', 'second player is black');
  var bId = jb.playerId;

  send(b, { type: 'move', from: 'e7', to: 'e5' }); // black out of turn
  await wait(80);
  ok(last(b, 'error') && /turn/i.test(last(b, 'error').message), 'out-of-turn move rejected');

  // ---- 2. Illegal + malformed moves don't crash, are rejected ----
  send(a, { type: 'move', from: 'e2', to: 'e5' });
  await wait(60);
  ok(last(a, 'error'), 'illegal pawn jump rejected');
  send(a, { type: 'move' }); // malformed
  send(a, { type: 'move', from: 'zz', to: 99 }); // garbage
  await wait(80);
  ok(last(a, 'error'), 'malformed move rejected (no crash)');

  // ---- 3. Capture is recorded ----
  await play(a, b, [['e2', 'e4'], ['d7', 'd5'], ['e4', 'd5']]);
  var st = await waitFor(a, 'state');
  var hist = st.state.history;
  ok(hist.length === 3 && hist[2].capture && hist[2].san === 'exd5', 'capture recorded with SAN exd5');

  // ---- 4. Draw offer / decline / accept ----
  send(a, { type: 'draw', action: 'offer' });
  var off = await waitFor(b, 'drawOffer');
  ok(off && off.from === 'w', 'opponent receives draw offer');
  send(b, { type: 'draw', action: 'decline' });
  await wait(80);
  ok(last(b, 'drawDeclined'), 'draw decline delivered');
  send(a, { type: 'draw', action: 'offer' });
  await wait(80);
  send(b, { type: 'draw', action: 'accept' });
  await wait(100);
  var drawState = last(a, 'state');
  ok(drawState.status.over && drawState.status.result === 'draw' && drawState.status.reason === 'agreement', 'draw by agreement');

  // ---- 5. Rematch swaps colors & resets ----
  send(a, { type: 'rematch' }); send(b, { type: 'rematch' });
  await wait(150);
  var ra = last(a, 'joined');
  ok(ra && ra.color === 'b' && ra.state.history.length === 0, 'rematch resets board and swaps a to black');

  // ---- 6. Resign ends the game ----
  // a is now black; make a couple moves then a resigns
  send(b, { type: 'move', from: 'e2', to: 'e4' }); await wait(60); // b is white now
  send(a, { type: 'resign' });
  await wait(100);
  var resz = last(a, 'state');
  ok(resz && resz.status.over && resz.status.result === 'w' && resz.status.reason === 'resignation', 'resignation gives win to opponent');

  // ---- 7. Spectator can watch, cannot move ----
  var spec = client();
  await wait(80);
  send(spec, { type: 'join', room: room });
  var js = await waitFor(spec, 'joined');
  ok(js && js.spectator === true && js.color === null, 'third connection becomes spectator');
  a.close(); b.close(); spec.close();
  await wait(150);

  // ---- 8. Full game to checkmate (Scholar's mate) ----
  var c = client(), d = client();
  await wait(120);
  send(c, { type: 'create' }); var jc = await waitFor(c, 'joined');
  var room2 = jc.room, cId = jc.playerId;
  send(d, { type: 'join', room: room2 }); await waitFor(d, 'joined');
  await play(c, d, [['e2', 'e4'], ['e7', 'e5'], ['f1', 'c4'], ['b8', 'c6'], ['d1', 'h5'], ['g8', 'f6'], ['h5', 'f7']]);
  var mateState = await waitFor(c, 'state');
  ok(mateState.status.over && mateState.status.result === 'w' && mateState.status.reason === 'checkmate', 'Scholar\'s mate ends in checkmate, white wins');
  ok(mateState.state.history[6].san === 'Qxf7#', 'final move SAN is Qxf7#');

  // ---- 9. Promotion + castling + en passant over the wire ----
  var e = client(), f = client();
  await wait(120);
  send(e, { type: 'create' }); var je = await waitFor(e, 'joined'); var room3 = je.room;
  send(f, { type: 'join', room: room3 }); await waitFor(f, 'joined');
  // White king-side castle line + en passant setup
  await play(e, f, [
    ['e2', 'e4'], ['e7', 'e5'],
    ['g1', 'f3'], ['b8', 'c6'],
    ['f1', 'c4'], ['f8', 'c5'],
    ['e1', 'g1'] // O-O
  ]);
  var castSt = await waitFor(e, 'state');
  ok(castSt.state.history[6].castle === 'k' && castSt.state.history[6].san === 'O-O', 'king-side castling works over the wire');
  e.close(); f.close();
  await wait(120);

  // ---- 10. Reconnect reclaims seat after socket loss ----
  var g = client(), h = client();
  await wait(120);
  send(g, { type: 'create' }); var jg = await waitFor(g, 'joined');
  var room4 = jg.room, gId = jg.playerId;
  send(h, { type: 'join', room: room4 }); await waitFor(h, 'joined');
  send(g, { type: 'move', from: 'd2', to: 'd4' }); await wait(80);
  g.terminate(); // abrupt socket loss
  await wait(200);
  ok(last(h, 'opponent') && last(h, 'opponent').event === 'disconnected', 'opponent reported disconnected (seat held)');
  var g2 = client(); await wait(100);
  send(g2, { type: 'join', room: room4, playerId: gId });
  var jg2 = await waitFor(g2, 'joined');
  ok(jg2 && jg2.reconnected === true && jg2.color === 'w' && jg2.state.history.length === 1, 'reconnect reclaims white seat + live game');
  g2.close(); h.close();
  await wait(120);

  // ---- 11. Liveness survives stripped pongs (Render proxy scenario) ----
  var lp = client({ autoPong: false }); // never answers protocol pings
  await wait(120);
  send(lp, { type: 'create' });
  await waitFor(lp, 'joined');
  // keep sending app-level pings (data frames) but no pongs
  var pinger = setInterval(function () { if (lp.readyState === 1) send(lp, { type: 'ping' }); }, 150);
  await wait(1600); // > 2 heartbeat windows below
  clearInterval(pinger);
  ok(lp.alive === true, 'client sending app-pings stays alive despite stripped pongs');
  lp.close();
  await wait(120);

  // ---- 12. Persistence across a hard server restart ----
  var pcli = client(); var pOpp = client();
  await wait(120);
  send(pcli, { type: 'create' }); var jp = await waitFor(pcli, 'joined');
  var room5 = jp.room, pId = jp.playerId;
  send(pOpp, { type: 'join', room: room5 }); await waitFor(pOpp, 'joined');
  await play(pcli, pOpp, [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3']]);
  await wait(1300); // debounced save
  pcli.close(); pOpp.close();
  srv.kill('SIGKILL');
  await wait(500);
  srv = startServer();
  await wait(900);
  var pcli2 = client(); await wait(120);
  send(pcli2, { type: 'join', room: room5, playerId: pId });
  var jp2 = await waitFor(pcli2, 'joined', 3000);
  ok(jp2 && jp2.reconnected === true && jp2.state.history.length === 3 && jp2.state.history[2].san === 'Nf3',
     'game restored from disk across server restart');
  pcli2.close();

  srv.kill('SIGKILL');
  try { fs.unlinkSync(DATA); } catch (e) {}

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
