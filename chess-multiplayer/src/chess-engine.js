/*
 * chess-engine.js
 *
 * A self-contained chess rules engine with full move generation,
 * check / checkmate / stalemate detection, castling, en passant and
 * promotion. Written as a UMD module so the exact same code runs on the
 * Node server (authoritative validation) and in the browser (instant UI
 * feedback).
 *
 * Board representation:
 *   board[r][c] where r = 0 is rank 8 (top) and r = 7 is rank 1 (bottom),
 *   c = 0 is file 'a'. A piece is { type, color } or null for an empty
 *   square. type is one of p,n,b,r,q,k; color is 'w' or 'b'.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ChessEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FILES = 'abcdefgh';
  var WHITE = 'w';
  var BLACK = 'b';

  function cloneBoard(board) {
    var out = new Array(8);
    for (var r = 0; r < 8; r++) {
      out[r] = new Array(8);
      for (var c = 0; c < 8; c++) {
        var p = board[r][c];
        out[r][c] = p ? { type: p.type, color: p.color } : null;
      }
    }
    return out;
  }

  function inBounds(r, c) {
    return r >= 0 && r < 8 && c >= 0 && c < 8;
  }

  // "e4" -> { r, c }
  function squareToRC(sq) {
    var c = FILES.indexOf(sq[0]);
    var r = 8 - parseInt(sq[1], 10);
    return { r: r, c: c };
  }

  // { r, c } -> "e4"
  function rcToSquare(r, c) {
    return FILES[c] + (8 - r);
  }

  function startingBoard() {
    var back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
    var board = [];
    for (var r = 0; r < 8; r++) {
      board.push(new Array(8).fill(null));
    }
    for (var c = 0; c < 8; c++) {
      board[0][c] = { type: back[c], color: BLACK };
      board[1][c] = { type: 'p', color: BLACK };
      board[6][c] = { type: 'p', color: WHITE };
      board[7][c] = { type: back[c], color: WHITE };
    }
    return board;
  }

  function Chess(state) {
    if (state) {
      this.load(state);
    } else {
      this.reset();
    }
  }

  Chess.prototype.reset = function () {
    this.board = startingBoard();
    this.turn = WHITE;
    // castling rights
    this.castling = { w: { k: true, q: true }, b: { k: true, q: true } };
    this.enPassant = null; // square string e.g. "e3" or null
    this.halfmove = 0; // for fifty-move rule
    this.fullmove = 1;
    this.history = []; // list of move records (SAN + detail)
  };

  // Serialize the full game state for transmission over the wire.
  Chess.prototype.getState = function () {
    return {
      board: cloneBoard(this.board),
      turn: this.turn,
      castling: JSON.parse(JSON.stringify(this.castling)),
      enPassant: this.enPassant,
      halfmove: this.halfmove,
      fullmove: this.fullmove,
      history: this.history.slice()
    };
  };

  Chess.prototype.load = function (state) {
    this.board = cloneBoard(state.board);
    this.turn = state.turn;
    this.castling = JSON.parse(JSON.stringify(state.castling));
    this.enPassant = state.enPassant;
    this.halfmove = state.halfmove || 0;
    this.fullmove = state.fullmove || 1;
    this.history = (state.history || []).slice();
  };

  Chess.prototype.pieceAt = function (sq) {
    var rc = squareToRC(sq);
    return this.board[rc.r][rc.c];
  };

  function opponent(color) {
    return color === WHITE ? BLACK : WHITE;
  }

  // Find the king of the given color. Returns {r,c} or null.
  function findKing(board, color) {
    for (var r = 0; r < 8; r++) {
      for (var c = 0; c < 8; c++) {
        var p = board[r][c];
        if (p && p.type === 'k' && p.color === color) {
          return { r: r, c: c };
        }
      }
    }
    return null;
  }

  // Is square (r,c) attacked by the given color on this board?
  function isAttacked(board, r, c, byColor) {
    // Pawn attacks. byColor pawns attack "forward" in their direction.
    var pdir = byColor === WHITE ? -1 : 1; // white moves up (toward r=0)
    var pawnRows = [r + pdir];
    for (var dc = -1; dc <= 1; dc += 2) {
      var pr = r + pdir, pc = c + dc;
      if (inBounds(pr, pc)) {
        var pp = board[pr][pc];
        if (pp && pp.color === byColor && pp.type === 'p') return true;
      }
    }

    // Knight attacks.
    var kn = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
    for (var i = 0; i < kn.length; i++) {
      var nr = r + kn[i][0], nc = c + kn[i][1];
      if (inBounds(nr, nc)) {
        var np = board[nr][nc];
        if (np && np.color === byColor && np.type === 'n') return true;
      }
    }

    // King attacks (adjacent squares).
    for (var ddr = -1; ddr <= 1; ddr++) {
      for (var ddc = -1; ddc <= 1; ddc++) {
        if (ddr === 0 && ddc === 0) continue;
        var kr = r + ddr, kc = c + ddc;
        if (inBounds(kr, kc)) {
          var kp = board[kr][kc];
          if (kp && kp.color === byColor && kp.type === 'k') return true;
        }
      }
    }

    // Sliding pieces: bishop/queen on diagonals, rook/queen on orthogonals.
    var diag = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    for (var d = 0; d < diag.length; d++) {
      var rr = r + diag[d][0], cc = c + diag[d][1];
      while (inBounds(rr, cc)) {
        var sp = board[rr][cc];
        if (sp) {
          if (sp.color === byColor && (sp.type === 'b' || sp.type === 'q')) return true;
          break;
        }
        rr += diag[d][0];
        cc += diag[d][1];
      }
    }
    var orth = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (var o = 0; o < orth.length; o++) {
      var orr = r + orth[o][0], occ = c + orth[o][1];
      while (inBounds(orr, occ)) {
        var op = board[orr][occ];
        if (op) {
          if (op.color === byColor && (op.type === 'r' || op.type === 'q')) return true;
          break;
        }
        orr += orth[o][0];
        occ += orth[o][1];
      }
    }
    return false;
  }

  Chess.prototype.isCheck = function (color) {
    color = color || this.turn;
    var k = findKing(this.board, color);
    if (!k) return false;
    return isAttacked(this.board, k.r, k.c, opponent(color));
  };

  // Generate pseudo-legal moves (ignores leaving own king in check) for the
  // piece at (r,c). Returns array of move objects.
  function pseudoMoves(game, r, c) {
    var board = game.board;
    var piece = board[r][c];
    if (!piece) return [];
    var color = piece.color;
    var moves = [];
    var forward = color === WHITE ? -1 : 1;

    function addMove(tr, tc, opts) {
      opts = opts || {};
      moves.push({
        from: rcToSquare(r, c),
        to: rcToSquare(tr, tc),
        piece: piece.type,
        color: color,
        capture: opts.capture || false,
        enPassant: opts.enPassant || false,
        castle: opts.castle || null,
        promotion: opts.promotion || null,
        fromRC: { r: r, c: c },
        toRC: { r: tr, c: tc }
      });
    }

    if (piece.type === 'p') {
      var startRow = color === WHITE ? 6 : 1;
      var promoRow = color === WHITE ? 0 : 7;
      var one = r + forward;
      // Forward one
      if (inBounds(one, c) && !board[one][c]) {
        if (one === promoRow) {
          ['q', 'r', 'b', 'n'].forEach(function (pr) { addMove(one, c, { promotion: pr }); });
        } else {
          addMove(one, c);
        }
        // Forward two from start
        var two = r + 2 * forward;
        if (r === startRow && !board[two][c]) {
          addMove(two, c);
        }
      }
      // Captures
      for (var dc = -1; dc <= 1; dc += 2) {
        var tr = r + forward, tc = c + dc;
        if (!inBounds(tr, tc)) continue;
        var target = board[tr][tc];
        if (target && target.color !== color) {
          if (tr === promoRow) {
            ['q', 'r', 'b', 'n'].forEach(function (pr) { addMove(tr, tc, { capture: true, promotion: pr }); });
          } else {
            addMove(tr, tc, { capture: true });
          }
        } else if (!target && game.enPassant === rcToSquare(tr, tc)) {
          addMove(tr, tc, { capture: true, enPassant: true });
        }
      }
    } else if (piece.type === 'n') {
      var kn = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
      for (var i = 0; i < kn.length; i++) {
        var nr = r + kn[i][0], nc = c + kn[i][1];
        if (!inBounds(nr, nc)) continue;
        var np = board[nr][nc];
        if (!np) addMove(nr, nc);
        else if (np.color !== color) addMove(nr, nc, { capture: true });
      }
    } else if (piece.type === 'k') {
      for (var ddr = -1; ddr <= 1; ddr++) {
        for (var ddc = -1; ddc <= 1; ddc++) {
          if (ddr === 0 && ddc === 0) continue;
          var kr = r + ddr, kc = c + ddc;
          if (!inBounds(kr, kc)) continue;
          var kp = board[kr][kc];
          if (!kp) addMove(kr, kc);
          else if (kp.color !== color) addMove(kr, kc, { capture: true });
        }
      }
      // Castling
      var rights = game.castling[color];
      var homeRow = color === WHITE ? 7 : 0;
      if (r === homeRow && c === 4 && !isAttacked(board, r, c, opponent(color))) {
        // King-side
        if (rights.k && !board[homeRow][5] && !board[homeRow][6] &&
            board[homeRow][7] && board[homeRow][7].type === 'r' && board[homeRow][7].color === color &&
            !isAttacked(board, homeRow, 5, opponent(color)) &&
            !isAttacked(board, homeRow, 6, opponent(color))) {
          addMove(homeRow, 6, { castle: 'k' });
        }
        // Queen-side
        if (rights.q && !board[homeRow][3] && !board[homeRow][2] && !board[homeRow][1] &&
            board[homeRow][0] && board[homeRow][0].type === 'r' && board[homeRow][0].color === color &&
            !isAttacked(board, homeRow, 3, opponent(color)) &&
            !isAttacked(board, homeRow, 2, opponent(color))) {
          addMove(homeRow, 2, { castle: 'q' });
        }
      }
    } else {
      // Sliding pieces
      var dirs = [];
      if (piece.type === 'b' || piece.type === 'q') {
        dirs = dirs.concat([[-1, -1], [-1, 1], [1, -1], [1, 1]]);
      }
      if (piece.type === 'r' || piece.type === 'q') {
        dirs = dirs.concat([[-1, 0], [1, 0], [0, -1], [0, 1]]);
      }
      for (var di = 0; di < dirs.length; di++) {
        var rr = r + dirs[di][0], cc = c + dirs[di][1];
        while (inBounds(rr, cc)) {
          var sp = board[rr][cc];
          if (!sp) {
            addMove(rr, cc);
          } else {
            if (sp.color !== color) addMove(rr, cc, { capture: true });
            break;
          }
          rr += dirs[di][0];
          cc += dirs[di][1];
        }
      }
    }
    return moves;
  }

  // Apply a move to a board mutably (used both for real moves and for
  // testing whether a move leaves the king in check). Does not update
  // castling rights / turn — caller handles that for real moves.
  function applyMoveToBoard(board, move) {
    var from = move.fromRC, to = move.toRC;
    var piece = board[from.r][from.c];
    board[to.r][to.c] = piece;
    board[from.r][from.c] = null;

    if (move.enPassant) {
      // Captured pawn sits on the moving side's destination file, origin rank.
      board[from.r][to.c] = null;
    }
    if (move.promotion) {
      board[to.r][to.c] = { type: move.promotion, color: piece.color };
    }
    if (move.castle) {
      var homeRow = to.r;
      if (move.castle === 'k') {
        board[homeRow][5] = board[homeRow][7];
        board[homeRow][7] = null;
      } else {
        board[homeRow][3] = board[homeRow][0];
        board[homeRow][0] = null;
      }
    }
  }

  // Legal moves for a single square (filters out king-exposing moves).
  Chess.prototype.movesFrom = function (sq) {
    var rc = squareToRC(sq);
    var piece = this.board[rc.r][rc.c];
    if (!piece || piece.color !== this.turn) return [];
    var self = this;
    return pseudoMoves(this, rc.r, rc.c).filter(function (m) {
      var test = cloneBoard(self.board);
      applyMoveToBoard(test, m);
      var k = findKing(test, piece.color);
      return k && !isAttacked(test, k.r, k.c, opponent(piece.color));
    });
  };

  // All legal moves for the side to move.
  Chess.prototype.allMoves = function () {
    var out = [];
    for (var r = 0; r < 8; r++) {
      for (var c = 0; c < 8; c++) {
        var p = this.board[r][c];
        if (p && p.color === this.turn) {
          out = out.concat(this.movesFrom(rcToSquare(r, c)));
        }
      }
    }
    return out;
  };

  // Build a Standard Algebraic Notation string for a move (computed before
  // the move is applied, using the legal move set for disambiguation).
  Chess.prototype.toSAN = function (move, legalMoves) {
    if (move.castle === 'k') return castleSuffix(this, move, 'O-O');
    if (move.castle === 'q') return castleSuffix(this, move, 'O-O-O');
    var pieceLetter = move.piece === 'p' ? '' : move.piece.toUpperCase();
    var san = pieceLetter;

    if (move.piece !== 'p') {
      // Disambiguation: other same-type pieces that can also reach `to`.
      var sameTarget = legalMoves.filter(function (m) {
        return m.piece === move.piece && m.to === move.to && m.from !== move.from;
      });
      if (sameTarget.length > 0) {
        var sameFile = sameTarget.some(function (m) { return m.from[0] === move.from[0]; });
        var sameRank = sameTarget.some(function (m) { return m.from[1] === move.from[1]; });
        if (!sameFile) san += move.from[0];
        else if (!sameRank) san += move.from[1];
        else san += move.from;
      }
    }

    if (move.capture) {
      if (move.piece === 'p') san += move.from[0];
      san += 'x';
    }
    san += move.to;
    if (move.promotion) san += '=' + move.promotion.toUpperCase();
    return san;
  };

  function castleSuffix(game, move, base) {
    return base;
  }

  // Attempt to make a move. `req` = { from, to, promotion? }.
  // Returns the move record on success, or null if illegal.
  Chess.prototype.move = function (req) {
    var legal = this.movesFrom(req.from);
    var match = null;
    for (var i = 0; i < legal.length; i++) {
      if (legal[i].to === req.to) {
        if (legal[i].promotion) {
          if (legal[i].promotion === (req.promotion || 'q')) {
            match = legal[i];
            break;
          }
        } else {
          match = legal[i];
          break;
        }
      }
    }
    if (!match) return null;

    var allLegal = this.allMoves();
    var san = this.toSAN(match, allLegal);

    var movingColor = this.turn;
    var captured = match.capture;
    var isPawn = match.piece === 'p';

    // Update en passant target (set only on a double pawn push).
    var newEnPassant = null;
    if (isPawn && Math.abs(match.toRC.r - match.fromRC.r) === 2) {
      var midR = (match.toRC.r + match.fromRC.r) / 2;
      newEnPassant = rcToSquare(midR, match.fromRC.c);
    }

    // Apply to the real board.
    applyMoveToBoard(this.board, match);

    // Update castling rights.
    if (match.piece === 'k') {
      this.castling[movingColor].k = false;
      this.castling[movingColor].q = false;
    }
    if (match.piece === 'r') {
      var homeRow = movingColor === WHITE ? 7 : 0;
      if (match.fromRC.r === homeRow && match.fromRC.c === 0) this.castling[movingColor].q = false;
      if (match.fromRC.r === homeRow && match.fromRC.c === 7) this.castling[movingColor].k = false;
    }
    // If a rook is captured on its home square, revoke that right.
    var oppHome = movingColor === WHITE ? 0 : 7;
    if (match.toRC.r === oppHome) {
      if (match.toRC.c === 0) this.castling[opponent(movingColor)].q = false;
      if (match.toRC.c === 7) this.castling[opponent(movingColor)].k = false;
    }

    this.enPassant = newEnPassant;
    this.halfmove = (captured || isPawn) ? 0 : this.halfmove + 1;
    if (movingColor === BLACK) this.fullmove += 1;
    this.turn = opponent(movingColor);

    // Annotate check / checkmate.
    var record = {
      from: match.from,
      to: match.to,
      piece: match.piece,
      color: movingColor,
      san: san,
      capture: captured,
      promotion: match.promotion,
      castle: match.castle,
      enPassant: match.enPassant
    };

    var check = this.isCheck(this.turn);
    var noMoves = this.allMoves().length === 0;
    if (check && noMoves) {
      record.san = san + '#';
      record.checkmate = true;
    } else if (check) {
      record.san = san + '+';
      record.check = true;
    } else if (noMoves) {
      record.stalemate = true;
    }

    this.history.push(record);
    return record;
  };

  Chess.prototype.isCheckmate = function () {
    return this.isCheck(this.turn) && this.allMoves().length === 0;
  };

  Chess.prototype.isStalemate = function () {
    return !this.isCheck(this.turn) && this.allMoves().length === 0;
  };

  // Insufficient material: K vs K, K+minor vs K, K+B vs K+B same color.
  Chess.prototype.isInsufficientMaterial = function () {
    var pieces = [];
    for (var r = 0; r < 8; r++) {
      for (var c = 0; c < 8; c++) {
        var p = this.board[r][c];
        if (p && p.type !== 'k') pieces.push({ p: p, r: r, c: c });
      }
    }
    if (pieces.length === 0) return true;
    if (pieces.length === 1) {
      return pieces[0].p.type === 'n' || pieces[0].p.type === 'b';
    }
    if (pieces.length === 2 && pieces[0].p.type === 'b' && pieces[1].p.type === 'b') {
      var sq0 = (pieces[0].r + pieces[0].c) % 2;
      var sq1 = (pieces[1].r + pieces[1].c) % 2;
      return sq0 === sq1;
    }
    return false;
  };

  Chess.prototype.isDraw = function () {
    return this.isStalemate() || this.isInsufficientMaterial() || this.halfmove >= 100;
  };

  Chess.prototype.isGameOver = function () {
    return this.isCheckmate() || this.isDraw();
  };

  // A short status descriptor for clients.
  Chess.prototype.status = function () {
    if (this.isCheckmate()) {
      return { over: true, result: opponent(this.turn), reason: 'checkmate' };
    }
    if (this.isStalemate()) {
      return { over: true, result: 'draw', reason: 'stalemate' };
    }
    if (this.isInsufficientMaterial()) {
      return { over: true, result: 'draw', reason: 'insufficient material' };
    }
    if (this.halfmove >= 100) {
      return { over: true, result: 'draw', reason: 'fifty-move rule' };
    }
    return { over: false, check: this.isCheck(this.turn), turn: this.turn };
  };

  Chess.squareToRC = squareToRC;
  Chess.rcToSquare = rcToSquare;

  return Chess;
});
