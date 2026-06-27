/* Minimal test harness for the chess engine — run with `npm test`. */
'use strict';

var Chess = require('../src/chess-engine');

var passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error('  FAIL: ' + name); }
}
function eq(a, b, name) { ok(a === b, name + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

// Helper: play a sequence of {from,to} and assert each succeeds.
function play(game, moves) {
  moves.forEach(function (m) {
    var rec = game.move(m);
    if (!rec) throw new Error('Move rejected: ' + JSON.stringify(m));
  });
}

// 1. Initial position move counts.
(function () {
  var g = new Chess();
  eq(g.allMoves().length, 20, 'initial legal moves = 20');
  eq(g.turn, 'w', 'white to move first');
})();

// 2. Illegal move rejected.
(function () {
  var g = new Chess();
  ok(g.move({ from: 'e2', to: 'e5' }) === null, 'pawn cannot jump 3');
  ok(g.move({ from: 'e1', to: 'e2' }) === null, 'king blocked by own pawn');
})();

// 3. Basic pawn + capture.
(function () {
  var g = new Chess();
  play(g, [{ from: 'e2', to: 'e4' }, { from: 'd7', to: 'd5' }]);
  var rec = g.move({ from: 'e4', to: 'd5' });
  ok(rec && rec.capture, 'exd5 capture recorded');
})();

// 4. En passant.
(function () {
  var g = new Chess();
  play(g, [
    { from: 'e2', to: 'e4' }, { from: 'a7', to: 'a6' },
    { from: 'e4', to: 'e5' }, { from: 'd7', to: 'd5' }
  ]);
  eq(g.enPassant, 'd6', 'en passant target set');
  var rec = g.move({ from: 'e5', to: 'd6' });
  ok(rec && rec.enPassant, 'en passant capture executes');
  ok(g.pieceAt('d5') === null, 'captured pawn removed');
})();

// 5. Castling king-side.
(function () {
  var g = new Chess();
  play(g, [
    { from: 'e2', to: 'e4' }, { from: 'e7', to: 'e5' },
    { from: 'g1', to: 'f3' }, { from: 'b8', to: 'c6' },
    { from: 'f1', to: 'c4' }, { from: 'f8', to: 'c5' }
  ]);
  var rec = g.move({ from: 'e1', to: 'g1' });
  ok(rec && rec.castle === 'k', 'white castles king-side');
  ok(g.pieceAt('f1') && g.pieceAt('f1').type === 'r', 'rook moved to f1');
  ok(g.pieceAt('g1') && g.pieceAt('g1').type === 'k', 'king moved to g1');
})();

// 6. Promotion.
(function () {
  // Set up a position with a white pawn on the 7th about to promote.
  var g = new Chess();
  var st = g.getState();
  // Clear board and place pieces manually.
  for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) st.board[r][c] = null;
  st.board[1][0] = { type: 'p', color: 'w' }; // a7
  st.board[7][4] = { type: 'k', color: 'w' }; // e1
  st.board[0][7] = { type: 'k', color: 'b' }; // h8
  st.turn = 'w';
  st.castling = { w: { k: false, q: false }, b: { k: false, q: false } };
  g.load(st);
  var rec = g.move({ from: 'a7', to: 'a8', promotion: 'q' });
  ok(rec && rec.promotion === 'q', 'pawn promotes to queen');
  ok(g.pieceAt('a8').type === 'q', 'queen on a8');
})();

// 7. Fool's mate -> checkmate detection.
(function () {
  var g = new Chess();
  play(g, [
    { from: 'f2', to: 'f3' }, { from: 'e7', to: 'e5' },
    { from: 'g2', to: 'g4' }
  ]);
  var rec = g.move({ from: 'd8', to: 'h4' });
  ok(rec && rec.checkmate, 'Qh4# is checkmate');
  ok(g.isCheckmate(), 'isCheckmate() true');
  eq(g.status().result, 'b', 'black wins');
})();

// 8. Stalemate detection.
(function () {
  var g = new Chess();
  var st = g.getState();
  for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) st.board[r][c] = null;
  // Classic stalemate: black king a8, white king c7, white queen b6, black to move.
  st.board[0][0] = { type: 'k', color: 'b' }; // a8
  st.board[1][2] = { type: 'k', color: 'w' }; // c7
  st.board[2][1] = { type: 'q', color: 'w' }; // b6
  st.turn = 'b';
  st.castling = { w: { k: false, q: false }, b: { k: false, q: false } };
  g.load(st);
  ok(g.isStalemate(), 'position is stalemate');
  ok(!g.isCheck('b'), 'black not in check');
  eq(g.status().reason, 'stalemate', 'status reports stalemate');
})();

// 9. Cannot move into check (pinned piece).
(function () {
  var g = new Chess();
  var st = g.getState();
  for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) st.board[r][c] = null;
  st.board[7][4] = { type: 'k', color: 'w' }; // e1
  st.board[6][4] = { type: 'r', color: 'w' }; // e2 (pinned)
  st.board[0][4] = { type: 'r', color: 'b' }; // e8 pinning
  st.board[0][0] = { type: 'k', color: 'b' };
  st.turn = 'w';
  st.castling = { w: { k: false, q: false }, b: { k: false, q: false } };
  g.load(st);
  var moves = g.movesFrom('e2');
  ok(moves.every(function (m) { return m.to[0] === 'e'; }), 'pinned rook stays on e-file');
})();

// 10. Castling forbidden through check.
(function () {
  var g = new Chess();
  var st = g.getState();
  for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) st.board[r][c] = null;
  st.board[7][4] = { type: 'k', color: 'w' }; // e1
  st.board[7][7] = { type: 'r', color: 'w' }; // h1
  st.board[0][5] = { type: 'r', color: 'b' }; // f8 attacks f1
  st.board[0][0] = { type: 'k', color: 'b' };
  st.turn = 'w';
  st.castling = { w: { k: true, q: false }, b: { k: false, q: false } };
  g.load(st);
  var moves = g.movesFrom('e1');
  ok(!moves.some(function (m) { return m.castle === 'k'; }), 'no castling through attacked f1');
})();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
