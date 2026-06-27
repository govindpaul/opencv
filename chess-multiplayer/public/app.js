/*
 * app.js — Multiplayer chess client.
 *
 * Renders the board, talks to the server over WebSocket, and provides
 * instant local feedback (legal-move hints, drag & drop) using the same
 * chess engine the server uses for authoritative validation.
 */
(function () {
  'use strict';

  var GLYPH = {
    w: { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
    b: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' }
  };

  // ---- DOM refs ----
  var $ = function (id) { return document.getElementById(id); };
  var lobbyEl = $('lobby');
  var gameEl = $('game');
  var boardEl = $('board');
  var connEl = $('connection');

  // ---- State ----
  var ws = null;
  var game = null;          // ChessEngine instance mirroring server state
  var myColor = null;       // 'w' | 'b' | null (spectator)
  var roomCode = null;
  // Stable per-tab identity so a reconnect can reclaim the same seat.
  // sessionStorage is per-tab, so two tabs on one machine get distinct ids.
  var playerId = null;
  try { playerId = sessionStorage.getItem('chessPlayerId') || null; } catch (e) {}
  var keepaliveTimer = null;
  var status = null;        // last status from server
  var lastMove = null;      // { from, to }
  var selected = null;      // currently selected square
  var legalTargets = [];    // legal moves from selected square
  var pendingPromotion = null; // { from, to, options }
  var players = { w: false, b: false };

  // Orientation: white players see white at bottom; black players flipped.
  function flipped() { return myColor === 'b'; }

  // ---- WebSocket ----
  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);

    ws.onopen = function () {
      connEl.textContent = 'connected';
      connEl.className = 'conn-status open';
      startKeepalive();
      // Auto-(re)join room from URL hash (e.g. #ABC123) if present. On a
      // reconnect this reclaims our seat via the stored playerId.
      var hash = location.hash.replace('#', '').trim();
      if (hash) {
        send({ type: 'join', room: hash.toUpperCase(), playerId: playerId });
      }
    };
    ws.onclose = function () {
      connEl.textContent = 'reconnecting…';
      connEl.className = 'conn-status closed';
      stopKeepalive();
      setTimeout(connect, 1500);
    };
    ws.onerror = function () {
      // Let onclose handle the retry; just avoid an unhandled error.
      try { ws.close(); } catch (e) {}
    };
    ws.onmessage = function (ev) {
      var msg = JSON.parse(ev.data);
      handle(msg);
    };
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  // Application-level keepalive: keeps proxies from dropping an "idle"
  // connection while a player is thinking, and surfaces a dead link quickly.
  function startKeepalive() {
    stopKeepalive();
    keepaliveTimer = setInterval(function () {
      send({ type: 'ping' });
    }, 20000);
  }
  function stopKeepalive() {
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
  }

  function handle(msg) {
    switch (msg.type) {
      case 'joined':
        roomCode = msg.room;
        myColor = msg.color;
        players = msg.players;
        if (msg.playerId) {
          playerId = msg.playerId;
          try { sessionStorage.setItem('chessPlayerId', playerId); } catch (e) {}
        }
        loadState(msg.state, msg.status);
        location.hash = roomCode;
        showGame();
        if (msg.reconnected) addChat('system', 'Reconnected to your game.');
        else if (msg.spectator) addChat('system', 'You are spectating.');
        break;
      case 'pong':
        break; // keepalive acknowledgement
      case 'state':
        players = msg.players;
        lastMove = msg.lastMove ? { from: msg.lastMove.from, to: msg.lastMove.to } : null;
        if (msg.lastMove) addMoveToList(msg.lastMove);
        loadState(msg.state, msg.status);
        break;
      case 'opponent':
        players = msg.players;
        updatePlayerBars();
        updateStatusMessage();
        if (msg.event === 'left') addChat('system', 'Opponent left the game.');
        else if (msg.event === 'joined') addChat('system', 'A player joined.');
        else if (msg.event === 'disconnected') addChat('system', 'Opponent disconnected — waiting for them to reconnect…');
        else if (msg.event === 'reconnected') addChat('system', 'Opponent reconnected.');
        break;
      case 'chat':
        addChat(msg.from, msg.text);
        break;
      case 'error':
        flashError(msg.message);
        break;
    }
  }

  function loadState(state, st) {
    game = new ChessEngine(state);
    status = st;
    selected = null;
    legalTargets = [];
    pendingPromotion = null;
    render();
    updateStatusMessage();
    updatePlayerBars();
    rebuildMoveList(state.history);
  }

  // ---- Rendering ----
  function render() {
    boardEl.innerHTML = '';
    var checkSquare = null;
    if (status && status.check) {
      checkSquare = findKingSquare(game.turn);
    } else if (game && game.isCheck && game.isCheck(game.turn)) {
      checkSquare = findKingSquare(game.turn);
    }

    for (var i = 0; i < 8; i++) {
      for (var j = 0; j < 8; j++) {
        var r = flipped() ? 7 - i : i;
        var c = flipped() ? 7 - j : j;
        var sq = ChessEngine.rcToSquare(r, c);
        var cell = document.createElement('div');
        cell.className = 'square ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
        cell.dataset.square = sq;

        if (selected === sq) cell.classList.add('selected');
        if (lastMove && (lastMove.from === sq || lastMove.to === sq)) cell.classList.add('lastmove');
        if (checkSquare === sq) cell.classList.add('check');

        // Coordinate labels along edges.
        if (j === 0) {
          var rk = document.createElement('span');
          rk.className = 'coord rank';
          rk.textContent = (8 - r);
          cell.appendChild(rk);
        }
        if (i === 7) {
          var fl = document.createElement('span');
          fl.className = 'coord file';
          fl.textContent = 'abcdefgh'[c];
          cell.appendChild(fl);
        }

        // Legal-move hints.
        var hintMove = legalTargets.find(function (m) { return m.to === sq; });
        if (hintMove) {
          var hint = document.createElement('span');
          hint.className = 'hint ' + (game.board[r][c] || hintMove.enPassant ? 'capture' : 'move');
          cell.appendChild(hint);
        }

        // Piece.
        var piece = game.board[r][c];
        if (piece) {
          var pe = document.createElement('span');
          pe.className = 'piece ' + piece.color;
          pe.textContent = GLYPH[piece.color][piece.type];
          cell.appendChild(pe);
          if (piece.color === myColor) {
            cell.draggable = !isGameOver();
          }
        }

        cell.addEventListener('click', onSquareClick);
        attachDrag(cell, sq);
        boardEl.appendChild(cell);
      }
    }
  }

  function findKingSquare(color) {
    for (var r = 0; r < 8; r++) {
      for (var c = 0; c < 8; c++) {
        var p = game.board[r][c];
        if (p && p.type === 'k' && p.color === color) return ChessEngine.rcToSquare(r, c);
      }
    }
    return null;
  }

  // ---- Interaction ----
  function canMove() {
    return myColor && !isGameOver() && game.turn === myColor && players.w && players.b;
  }

  function onSquareClick(e) {
    var sq = e.currentTarget.dataset.square;
    if (pendingPromotion) return;

    if (selected) {
      var move = legalTargets.find(function (m) { return m.to === sq; });
      if (move) {
        attemptMove(selected, sq);
        return;
      }
    }
    // Select own piece whose turn it is.
    var rc = ChessEngine.squareToRC(sq);
    var piece = game.board[rc.r][rc.c];
    if (piece && piece.color === myColor && canMove()) {
      selectSquare(sq);
    } else {
      selected = null;
      legalTargets = [];
      render();
    }
  }

  function selectSquare(sq) {
    selected = sq;
    legalTargets = game.movesFrom(sq);
    render();
  }

  function attemptMove(from, to) {
    // Detect promotion: a pawn reaching the last rank.
    var moves = game.movesFrom(from).filter(function (m) { return m.to === to; });
    if (moves.length && moves[0].promotion) {
      openPromotion(from, to);
      return;
    }
    send({ type: 'move', from: from, to: to });
    selected = null;
    legalTargets = [];
  }

  function openPromotion(from, to) {
    pendingPromotion = { from: from, to: to };
    var picker = $('promotion');
    picker.innerHTML = '';
    var color = myColor;
    ['q', 'r', 'b', 'n'].forEach(function (t) {
      var opt = document.createElement('div');
      opt.className = 'opt';
      opt.textContent = GLYPH[color][t];
      opt.addEventListener('click', function () {
        send({ type: 'move', from: from, to: to, promotion: t });
        closePromotion();
        selected = null;
        legalTargets = [];
      });
      picker.appendChild(opt);
    });

    // Position the picker over the destination file.
    var cell = boardEl.querySelector('[data-square="' + to + '"]');
    var size = cell.offsetWidth;
    picker.style.width = size + 'px';
    picker.style.left = cell.offsetLeft + 'px';
    // Drop downward unless near the bottom edge.
    var top = cell.offsetTop;
    if (top + size * 4 > boardEl.offsetHeight) top = boardEl.offsetHeight - size * 4;
    picker.style.top = Math.max(0, top) + 'px';
    picker.classList.remove('hidden');
  }

  function closePromotion() {
    pendingPromotion = null;
    $('promotion').classList.add('hidden');
  }

  // ---- Drag and drop ----
  var dragFrom = null;
  function attachDrag(cell, sq) {
    cell.addEventListener('dragstart', function (e) {
      var rc = ChessEngine.squareToRC(sq);
      var piece = game.board[rc.r][rc.c];
      if (!piece || piece.color !== myColor || !canMove()) {
        e.preventDefault();
        return;
      }
      dragFrom = sq;
      selectSquare(sq);
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', sq); } catch (_) {}
    });
    cell.addEventListener('dragover', function (e) {
      if (dragFrom) e.preventDefault();
    });
    cell.addEventListener('drop', function (e) {
      e.preventDefault();
      if (!dragFrom) return;
      var move = legalTargets.find(function (m) { return m.to === sq; });
      if (move) attemptMove(dragFrom, sq);
      dragFrom = null;
    });
  }

  // ---- Status / sidebar ----
  function isGameOver() { return status && status.over; }

  function updateStatusMessage() {
    var el = $('statusMsg');
    el.className = 'status-msg';
    if (!players.w || !players.b) {
      el.textContent = 'Waiting for opponent to join… share room ' + roomCode;
      $('rematchBtn').classList.add('hidden');
      $('resignBtn').classList.remove('hidden');
      return;
    }
    if (status && status.over) {
      el.classList.add('over');
      var txt;
      if (status.result === 'draw') {
        txt = 'Draw — ' + status.reason;
      } else {
        var winner = status.result === 'w' ? 'White' : 'Black';
        txt = winner + ' wins by ' + status.reason;
        if (status.result === myColor) txt = 'You win! (' + status.reason + ')';
        else if (myColor) txt = 'You lose — ' + status.reason;
      }
      el.textContent = txt;
      $('rematchBtn').classList.toggle('hidden', !myColor);
      $('resignBtn').classList.add('hidden');
      return;
    }
    // In progress.
    $('rematchBtn').classList.add('hidden');
    $('resignBtn').classList.toggle('hidden', !myColor);
    var turnName = game.turn === 'w' ? 'White' : 'Black';
    var prefix = '';
    if (status && status.check) { el.classList.add('check'); prefix = 'Check! '; }
    if (!myColor) {
      el.textContent = prefix + turnName + ' to move (spectating)';
    } else if (game.turn === myColor) {
      el.textContent = prefix + 'Your move';
    } else {
      el.textContent = prefix + 'Opponent\'s move';
    }
  }

  function updatePlayerBars() {
    $('roomCode').textContent = roomCode || '—';
    $('myColor').textContent = myColor === 'w' ? 'White' : myColor === 'b' ? 'Black' : 'Spectator';
    var oppColor = myColor === 'w' ? 'b' : 'w';
    var oppPresent = myColor ? players[oppColor] : (players.w && players.b);
    $('opponentStatus').className = 'dot' + (oppPresent ? ' online' : '');
    var oppName = myColor ? (oppColor === 'w' ? 'White' : 'Black') : 'Players';
    $('opponentBar').querySelector('.who').textContent =
      myColor ? 'Opponent (' + oppName + ')' : 'Game';
    $('selfBar').querySelector('.who').textContent =
      myColor ? 'You (' + (myColor === 'w' ? 'White' : 'Black') + ')' : 'Spectator';
  }

  // ---- Move list ----
  function rebuildMoveList(history) {
    var list = $('moveList');
    list.innerHTML = '';
    for (var i = 0; i < history.length; i += 2) {
      var li = document.createElement('li');
      var white = document.createElement('span');
      white.className = 'pair';
      white.textContent = history[i].san;
      li.appendChild(white);
      if (history[i + 1]) {
        var black = document.createElement('span');
        black.className = 'pair';
        black.textContent = history[i + 1].san;
        li.appendChild(black);
      }
      list.appendChild(li);
    }
    list.scrollTop = list.scrollHeight;
  }

  function addMoveToList() { /* handled by rebuild on each state */ }

  // ---- Chat ----
  function addChat(from, text) {
    var log = $('chatLog');
    var div = document.createElement('div');
    div.className = 'msg' + (from === 'system' ? ' system' : '');
    if (from === 'system') {
      div.textContent = text;
    } else {
      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = from + ': ';
      div.appendChild(name);
      div.appendChild(document.createTextNode(text));
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function flashError(message) {
    if (lobbyEl && !lobbyEl.classList.contains('hidden')) {
      $('lobbyError').textContent = message;
      setTimeout(function () { $('lobbyError').textContent = ''; }, 4000);
    } else {
      addChat('system', '⚠ ' + message);
    }
    // An illegal move rejected by the server — resync selection.
    selected = null;
    legalTargets = [];
    if (game) render();
  }

  // ---- View switching ----
  function showGame() {
    lobbyEl.classList.add('hidden');
    gameEl.classList.remove('hidden');
  }
  function showLobby() {
    gameEl.classList.add('hidden');
    lobbyEl.classList.remove('hidden');
  }

  // ---- Wire up controls ----
  function init() {
    $('createBtn').addEventListener('click', function () { send({ type: 'create', playerId: playerId }); });
    $('joinBtn').addEventListener('click', function () {
      var code = $('roomInput').value.trim().toUpperCase();
      if (code) send({ type: 'join', room: code, playerId: playerId });
    });
    $('roomInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('joinBtn').click();
    });
    $('resignBtn').addEventListener('click', function () {
      if (confirm('Resign this game?')) send({ type: 'resign' });
    });
    $('rematchBtn').addEventListener('click', function () { send({ type: 'rematch' }); });
    $('leaveBtn').addEventListener('click', function () {
      location.hash = '';
      location.reload();
    });
    $('copyBtn').addEventListener('click', function () {
      var url = location.origin + '/#' + roomCode;
      navigator.clipboard && navigator.clipboard.writeText(url);
      $('copyBtn').textContent = 'copied!';
      setTimeout(function () { $('copyBtn').textContent = 'copy'; }, 1500);
    });
    $('chatForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var text = $('chatInput').value;
      if (text.trim()) send({ type: 'chat', text: text });
      $('chatInput').value = '';
    });

    connect();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
