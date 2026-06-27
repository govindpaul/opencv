/*
 * app.js — Multiplayer chess client.
 *
 * Renders the board with SVG pieces, talks to the server over WebSocket, and
 * provides a chess.com-style experience: drag & drop (mouse + touch), legal
 * move hints, move animation, sounds, captured-material display, right-click
 * arrows/highlights, move-list navigation, draw offers and a result modal.
 */
(function () {
  'use strict';

  var VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  var INITIAL = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };

  var $ = function (id) { return document.getElementById(id); };
  var lobbyEl = $('lobby'), gameEl = $('game'), boardEl = $('board'),
      overlayEl = $('overlay'), connEl = $('connection');

  // ---- Connection state ----
  var ws = null, keepaliveTimer = null;
  var playerId = null;
  try { playerId = sessionStorage.getItem('chessPlayerId') || null; } catch (e) {}
  var RECONNECT_BASE = 1000, RECONNECT_MAX = 20000, reconnectDelay = RECONNECT_BASE;

  // ---- Game state ----
  var liveGame = null;      // ChessEngine at the latest position
  var history = [];         // move records
  var myColor = null;       // 'w' | 'b' | null (spectator)
  var roomCode = null;
  var status = null;        // last server status
  var players = { w: false, b: false };
  var drawOfferFrom = null; // color with an outstanding draw offer

  // ---- View state ----
  var manualFlip = false;
  var viewPly = 0;          // which ply we are viewing (history.length = live)
  var selected = null;
  var legalTargets = [];
  var pendingPromotion = null;
  var highlights = {};      // square -> color class
  var arrows = [];          // { from, to, color }
  var animating = null;     // { from, to } to animate on next render

  function perspective() { return myColor || 'w'; }
  function flipped() { return (perspective() === 'b') !== manualFlip; }
  function atLive() { return viewPly >= history.length; }
  function isOver() { return !!(status && status.over); }

  // ---- WebSocket ----
  // Mobile browsers suspend background tabs: the socket dies and a fresh one
  // can hang in CONNECTING forever (no onopen/onclose). So we use a connection
  // watchdog, force a reconnect whenever the page becomes visible/online, and
  // health-check a seemingly-open socket with a ping that must be answered.
  var reconnectTimer = null, connectGuard = null, healthTimer = null;
  var lastPongAt = 0;

  function connect() {
    clearTimeout(reconnectTimer); reconnectTimer = null;
    clearTimeout(connectGuard);

    // Detach and discard any previous socket so its handlers can't interfere.
    if (ws) {
      try { ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null; ws.close(); } catch (e) {}
    }

    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);
    var sock = ws;

    // Watchdog: if it doesn't open within 8s, kill it and retry (handles the
    // "stuck connecting forever" case after a mobile resume).
    connectGuard = setTimeout(function () {
      if (sock.readyState !== WebSocket.OPEN) { try { sock.close(); } catch (e) {} }
    }, 8000);

    sock.onopen = function () {
      if (sock !== ws) return;
      clearTimeout(connectGuard);
      connEl.textContent = 'connected';
      connEl.className = 'conn-status open';
      reconnectDelay = RECONNECT_BASE;
      lastPongAt = Date.now();
      startKeepalive();
      var hash = location.hash.replace('#', '').trim();
      if (hash) send({ type: 'join', room: hash.toUpperCase(), playerId: playerId });
    };
    sock.onclose = function () {
      if (sock !== ws) return;
      clearTimeout(connectGuard);
      connEl.textContent = 'reconnecting…';
      connEl.className = 'conn-status closed';
      stopKeepalive();
      scheduleReconnect();
    };
    sock.onerror = function () { try { sock.close(); } catch (e) {} };
    sock.onmessage = function (ev) {
      try { handle(JSON.parse(ev.data)); } catch (e) {}
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    var delay = reconnectDelay + Math.floor(Math.random() * 0.3 * reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
    reconnectTimer = setTimeout(connect, delay);
  }

  // Called when the page regains focus / visibility / network.
  //
  // The hard part (per real mobile behaviour): after a tab is backgrounded or
  // the phone is locked, the WebSocket often reports readyState === OPEN but is
  // actually dead — .send() silently does nothing, so it looks "connected" yet
  // moves never reach the server. We therefore do NOT trust readyState: if we
  // haven't seen a pong very recently (keepalive is frozen while backgrounded),
  // we tear the socket down and reconnect fresh.
  var STALE_MS = 12000;
  function isHealthy() {
    return ws && ws.readyState === WebSocket.OPEN && (Date.now() - lastPongAt < STALE_MS);
  }
  function ensureConnected() {
    if (ws && ws.readyState === WebSocket.CONNECTING) return; // already connecting
    if (isHealthy()) { send({ type: 'ping' }); return; }     // refresh liveness
    reconnectDelay = RECONNECT_BASE;
    connect();                                                // force a fresh socket
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(msg)); } catch (e) {}
    }
  }
  function startKeepalive() {
    stopKeepalive();
    send({ type: 'ping' }); // prove liveness immediately on (re)connect
    keepaliveTimer = setInterval(function () { send({ type: 'ping' }); }, 10000);
  }
  function stopKeepalive() { if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; } }

  function handle(msg) {
    switch (msg.type) {
      case 'joined':
        roomCode = msg.room;
        myColor = msg.color;
        players = msg.players;
        drawOfferFrom = msg.drawOffer || null;
        if (msg.playerId) {
          playerId = msg.playerId;
          try { sessionStorage.setItem('chessPlayerId', playerId); } catch (e) {}
        }
        var wasOver = isOver();
        loadState(msg.state, msg.status, null, true);
        location.hash = roomCode;
        showGame();
        if (msg.reconnected) addChat('system', 'Reconnected to your game.');
        else if (msg.spectator) addChat('system', 'You are spectating.');
        else if (!wasOver) Sound.play('start');
        updateDrawUI();
        break;
      case 'state':
        players = msg.players;
        drawOfferFrom = msg.drawOffer || null;
        loadState(msg.state, msg.status, msg.lastMove);
        updateDrawUI();
        break;
      case 'opponent':
        players = msg.players;
        updatePlayerBars();
        updateStatusMessage();
        if (msg.event === 'left') { addChat('system', 'Opponent left the game.'); showToast('Opponent left the game', 'info'); }
        else if (msg.event === 'joined') { addChat('system', 'A player joined.'); showToast('Your opponent joined — game on!', 'info'); Sound.play('notify'); }
        else if (msg.event === 'disconnected') { addChat('system', 'Opponent disconnected — waiting for them to reconnect…'); showToast('Opponent disconnected — waiting…', 'info'); }
        else if (msg.event === 'reconnected') { addChat('system', 'Opponent reconnected.'); showToast('Opponent reconnected', 'info'); }
        break;
      case 'drawOffer':
        drawOfferFrom = msg.from;
        Sound.play('notify');
        updateDrawUI();
        break;
      case 'drawDeclined':
        drawOfferFrom = null;
        updateDrawUI();
        break;
      case 'chat':
        addChat(msg.from, msg.text);
        break;
      case 'pong':
        lastPongAt = Date.now();
        break;
      case 'error':
        flashError(msg.message);
        break;
    }
  }

  function loadState(state, st, lastMove, isJoin) {
    var prevLen = history.length;
    var wasAtLive = atLive() || isJoin;
    liveGame = new ChessEngine(state);
    history = state.history.slice();
    status = st;
    selected = null;
    legalTargets = [];
    pendingPromotion = null;

    // A real new move (not a full resync) → sound + animation, auto-advance.
    if (lastMove && history.length === prevLen + 1) {
      var rec = history[history.length - 1];
      var cap = null;
      if (rec.capture) {
        var prevBoard = boardAtPly(history.length - 1); // board before this move
        var capSq = rec.enPassant ? (rec.to[0] + rec.from[1]) : rec.to;
        var crc = ChessEngine.squareToRC(capSq);
        var victim = prevBoard[crc.r][crc.c];
        if (victim) cap = { sq: capSq, piece: victim, by: rec.color };
      }
      animating = { from: rec.from, to: rec.to, capture: cap };
      playMoveSound(rec);
      highlights = {}; arrows = []; // clear annotations on a new move
    }
    if (wasAtLive || history.length <= prevLen) viewPly = history.length;
    else viewPly = Math.min(viewPly, history.length);

    updatePlayerBars();   // refresh trays before the capture animation runs
    render();
    updateStatusMessage();
    rebuildMoveList();
    updateNavButtons();

    if (status && status.over && lastMove !== undefined) showResult();
    else hideResult();
    if (status && status.over && isJoin) showResult();
  }

  function playMoveSound(rec) {
    if (!rec) return;
    if (rec.checkmate) { Sound.play('check'); return; }
    if (rec.castle) Sound.play('castle');
    else if (rec.promotion) Sound.play('promote');
    else if (rec.capture) Sound.play('capture');
    else Sound.play('move');
    if (rec.check) setTimeout(function () { Sound.play('check'); }, 90);
  }

  // ---- Position reconstruction for navigation ----
  function boardAtPly(ply) {
    if (ply >= history.length) return liveGame.board;
    var g = new ChessEngine();
    for (var i = 0; i < ply; i++) {
      g.move({ from: history[i].from, to: history[i].to, promotion: history[i].promotion });
    }
    return g.board;
  }
  function lastMoveAtPly(ply) { return ply > 0 ? history[ply - 1] : null; }

  // ---- Rendering ----
  function render() {
    var board = boardAtPly(viewPly);
    var lm = lastMoveAtPly(viewPly);
    var showHints = atLive();
    boardEl.innerHTML = '';

    var checkSq = null;
    if (atLive() && status && status.check) checkSq = findKing(board, liveGame.turn);

    for (var i = 0; i < 8; i++) {
      for (var j = 0; j < 8; j++) {
        var r = flipped() ? 7 - i : i;
        var c = flipped() ? 7 - j : j;
        var sq = ChessEngine.rcToSquare(r, c);
        var cell = document.createElement('div');
        cell.className = 'square ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
        cell.dataset.square = sq;

        if (selected === sq && showHints) cell.classList.add('selected');
        if (highlights[sq]) cell.classList.add('hl-' + highlights[sq]);
        if (lm && (lm.from === sq || lm.to === sq)) cell.classList.add('lastmove');
        if (checkSq === sq) cell.classList.add('check');

        if (j === 0) cell.appendChild(coord('rank', 8 - r));
        if (i === 7) cell.appendChild(coord('file', 'abcdefgh'[c]));

        if (showHints && selected) {
          var hm = legalTargets.find(function (m) { return m.to === sq; });
          if (hm) {
            var hint = document.createElement('span');
            hint.className = 'hint ' + (board[r][c] || hm.enPassant ? 'capture' : 'move');
            cell.appendChild(hint);
          }
        }

        var piece = board[r][c];
        if (piece) {
          var pe = document.createElement('span');
          pe.className = 'piece ' + piece.color;
          pe.innerHTML = PIECES[piece.color][piece.type];
          if (showHints && piece.color === myColor && canMove()) pe.classList.add('movable');
          cell.appendChild(pe);
        }
        boardEl.appendChild(cell);
      }
    }

    drawArrows();
    if (animating) { runAnimation(animating); animating = null; }
  }

  function coord(kind, txt) {
    var s = document.createElement('span');
    s.className = 'coord ' + kind;
    s.textContent = txt;
    return s;
  }
  function findKing(board, color) {
    for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) {
      var p = board[r][c];
      if (p && p.type === 'k' && p.color === color) return ChessEngine.rcToSquare(r, c);
    }
    return null;
  }

  // Animate the moved piece sliding from its origin to its target, and (on a
  // capture) make the captured piece dramatically vanish so the player whose
  // piece was taken clearly sees it happen.
  function runAnimation(mv) {
    // Capture feedback first (so it's visible even if the slide is skipped).
    if (mv.capture) {
      var capCell = boardEl.querySelector('[data-square="' + mv.capture.sq + '"]');
      if (capCell) {
        var flash = document.createElement('div');
        flash.className = 'capture-flash';
        capCell.appendChild(flash);
        setTimeout(function () { flash.remove(); }, 420);

        var ghost = document.createElement('div');
        ghost.className = 'capture-ghost';
        ghost.innerHTML = PIECES[mv.capture.piece.color][mv.capture.piece.type];
        capCell.appendChild(ghost);
        setTimeout(function () { ghost.remove(); }, 360);
      }
      // Pop the captured piece into the correct tray.
      var trayId = mv.capture.by === perspective() ? 'capturedBySelf' : 'capturedByOpponent';
      var caps = $(trayId).querySelectorAll('.cap');
      if (caps.length) {
        var lastCap = caps[caps.length - 1];
        lastCap.classList.add('pop');
        setTimeout(function () { lastCap.classList.remove('pop'); }, 420);
      }
    }

    var fromCell = boardEl.querySelector('[data-square="' + mv.from + '"]');
    var toCell = boardEl.querySelector('[data-square="' + mv.to + '"]');
    if (!toCell) return;
    var pe = toCell.querySelector('.piece');
    if (!pe || !fromCell) return;
    var dx = fromCell.offsetLeft - toCell.offsetLeft;
    var dy = fromCell.offsetTop - toCell.offsetTop;
    pe.style.transition = 'none';
    pe.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        pe.style.transition = 'transform 0.16s ease-out';
        pe.style.transform = 'translate(0,0)';
      });
    });
  }

  // ---- Arrows overlay ----
  function squareCenter(sq) {
    var rc = ChessEngine.squareToRC(sq);
    var x = flipped() ? 7 - rc.c : rc.c;
    var y = flipped() ? 7 - rc.r : rc.r;
    return { x: x + 0.5, y: y + 0.5 };
  }
  var ARROW_COLORS = { green: 'rgba(104,168,76,0.9)', red: 'rgba(220,70,70,0.9)', yellow: 'rgba(240,200,70,0.92)', blue: 'rgba(82,142,224,0.9)' };
  function drawArrows() {
    overlayEl.innerHTML = '';
    arrows.forEach(function (a, idx) {
      var p1 = squareCenter(a.from), p2 = squareCenter(a.to);
      var ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);
      var len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      var head = 0.32, shorten = 0.42;
      var ex = p1.x + Math.cos(ang) * (len - shorten);
      var ey = p1.y + Math.sin(ang) * (len - shorten);
      var sx = p1.x + Math.cos(ang) * 0.36;
      var sy = p1.y + Math.sin(ang) * 0.36;
      var col = ARROW_COLORS[a.color] || ARROW_COLORS.green;
      var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', sx); line.setAttribute('y1', sy);
      line.setAttribute('x2', ex); line.setAttribute('y2', ey);
      line.setAttribute('stroke', col); line.setAttribute('stroke-width', '0.16');
      line.setAttribute('stroke-linecap', 'round');
      overlayEl.appendChild(line);
      var tipx = p1.x + Math.cos(ang) * (len - 0.1);
      var tipy = p1.y + Math.sin(ang) * (len - 0.1);
      var a1 = ang + Math.PI - 0.5, a2 = ang + Math.PI + 0.5;
      var tri = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      tri.setAttribute('points',
        tipx + ',' + tipy + ' ' +
        (tipx + Math.cos(a1) * head) + ',' + (tipy + Math.sin(a1) * head) + ' ' +
        (tipx + Math.cos(a2) * head) + ',' + (tipy + Math.sin(a2) * head));
      tri.setAttribute('fill', col);
      overlayEl.appendChild(tri);
    });
  }

  // ---- Interaction ----
  function canMove() {
    return atLive() && myColor && !isOver() && liveGame.turn === myColor && players.w && players.b;
  }

  function selectSquare(sq) {
    selected = sq;
    legalTargets = liveGame.movesFrom(sq);
    render();
  }
  function clearSelection() { selected = null; legalTargets = []; }

  function tryMove(from, to) {
    var moves = liveGame.movesFrom(from).filter(function (m) { return m.to === to; });
    if (!moves.length) return false;
    if (moves[0].promotion) { openPromotion(from, to); return true; }
    // If the socket is a post-resume zombie, a plain send() would silently
    // vanish. Reconnect first and ask the user to retry rather than losing it.
    if (!isHealthy()) { ensureConnected(); showToast('Reconnecting — tap your move again', 'info'); return true; }
    send({ type: 'move', from: from, to: to });
    clearSelection();
    render();
    return true;
  }

  // `prev` is the selection that existed BEFORE this click began, so that a
  // pre-selection made on pointerdown does not get read as a deselect.
  function handleClick(sq, prev) {
    if (Object.keys(highlights).length || arrows.length) { highlights = {}; arrows = []; render(); }
    if (!atLive()) {
      viewPly = history.length;
      clearSelection(); render(); rebuildMoveList(); updateNavButtons(); updateStatusMessage();
      return;
    }
    if (pendingPromotion) return;

    if (prev && prev !== sq && tryMove(prev, sq)) return;
    if (prev && prev === sq) { clearSelection(); render(); return; }

    var rc = ChessEngine.squareToRC(sq);
    var piece = liveGame.board[rc.r][rc.c];
    if (piece && piece.color === myColor && canMove()) { if (selected !== sq) selectSquare(sq); }
    else { clearSelection(); render(); }
  }

  // Pointer-based drag & drop (unifies mouse + touch).
  var drag = null;
  function squareFromPoint(x, y) {
    var el = document.elementFromPoint(x, y);
    while (el && el !== boardEl && !el.dataset.square) el = el.parentElement;
    return el && el.dataset ? el.dataset.square : null;
  }

  function onPointerDown(e) {
    var sq = squareFromPoint(e.clientX, e.clientY);
    if (!sq) return;

    if (e.button === 2) { // right button → annotation
      e.preventDefault();
      drag = { annotate: true, from: sq, color: annotationColor(e) };
      return;
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return;

    var rc = ChessEngine.squareToRC(sq);
    var piece = atLive() ? liveGame.board[rc.r][rc.c] : null;
    drag = { from: sq, startX: e.clientX, startY: e.clientY, moved: false,
             piece: piece, ghost: null, prevSelected: selected };
    // Pre-select to show hints immediately (and to enable dragging).
    if (piece && piece.color === myColor && canMove()) selectSquare(sq);
  }

  function onPointerMove(e) {
    if (!drag || drag.annotate) return;
    var dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    if (!drag.piece || drag.piece.color !== myColor || !canMove()) return;
    if (!drag.moved) {
      drag.moved = true;
      var cell = boardEl.querySelector('[data-square="' + drag.from + '"] .piece');
      if (cell) cell.classList.add('dragging');
      var g = document.createElement('div');
      g.className = 'drag-piece';
      var size = boardEl.querySelector('.square').offsetWidth;
      g.style.width = size + 'px'; g.style.height = size + 'px';
      g.innerHTML = PIECES[drag.piece.color][drag.piece.type];
      document.body.appendChild(g);
      drag.ghost = g;
    }
    if (drag.ghost) {
      drag.ghost.style.left = e.clientX + 'px';
      drag.ghost.style.top = e.clientY + 'px';
    }
  }

  function onPointerUp(e) {
    if (!drag) return;
    var sq = squareFromPoint(e.clientX, e.clientY);

    if (drag.annotate) {
      if (sq) {
        if (sq === drag.from) toggleHighlight(sq, drag.color);
        else toggleArrow(drag.from, sq, drag.color);
      }
      drag = null;
      return;
    }
    if (drag.ghost) { drag.ghost.remove(); }
    var draggedPieceEl = boardEl.querySelector('.piece.dragging');
    if (draggedPieceEl) draggedPieceEl.classList.remove('dragging');

    if (drag.moved) {
      if (sq && sq !== drag.from) {
        if (!tryMove(drag.from, sq)) { clearSelection(); render(); }
      } else { clearSelection(); render(); }
    } else if (sq) {
      handleClick(sq, drag.prevSelected);
    }
    drag = null;
  }

  function annotationColor(e) {
    if (e.shiftKey) return 'red';
    if (e.altKey) return 'blue';
    if (e.ctrlKey || e.metaKey) return 'yellow';
    return 'green';
  }
  function toggleHighlight(sq, color) {
    if (highlights[sq] === color) delete highlights[sq];
    else highlights[sq] = color;
    render();
  }
  function toggleArrow(from, to, color) {
    var idx = arrows.findIndex(function (a) { return a.from === from && a.to === to; });
    if (idx >= 0) arrows.splice(idx, 1);
    else arrows.push({ from: from, to: to, color: color });
    render();
  }

  // ---- Promotion ----
  function openPromotion(from, to) {
    pendingPromotion = { from: from, to: to };
    var picker = $('promotion');
    picker.innerHTML = '';
    ['q', 'r', 'b', 'n'].forEach(function (t) {
      var opt = document.createElement('div');
      opt.className = 'opt';
      opt.innerHTML = PIECES[myColor][t];
      opt.addEventListener('click', function () {
        send({ type: 'move', from: from, to: to, promotion: t });
        closePromotion(); clearSelection();
      });
      picker.appendChild(opt);
    });
    var cell = boardEl.querySelector('[data-square="' + to + '"]');
    var size = cell.offsetWidth;
    picker.style.width = size + 'px';
    picker.style.left = cell.offsetLeft + 'px';
    var top = cell.offsetTop;
    if (top + size * 4 > boardEl.offsetHeight) top = boardEl.offsetHeight - size * 4;
    picker.style.top = Math.max(0, top) + 'px';
    picker.classList.remove('hidden');
  }
  function closePromotion() { pendingPromotion = null; $('promotion').classList.add('hidden'); }

  // ---- Captured material ----
  function computeCaptured() {
    var board = liveGame ? liveGame.board : boardAtPly(viewPly);
    var count = { w: {}, b: {} };
    for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) {
      var p = board[r][c];
      if (p) count[p.color][p.type] = (count[p.color][p.type] || 0) + 1;
    }
    var captured = { w: [], b: [] }, score = { w: 0, b: 0 };
    ['p', 'n', 'b', 'r', 'q'].forEach(function (t) {
      ['w', 'b'].forEach(function (col) {
        var missing = INITIAL[t] - (count[col][t] || 0);
        for (var k = 0; k < missing; k++) captured[col === 'w' ? 'b' : 'w'].push(t);
        score[col === 'w' ? 'b' : 'w'] += missing * VALUE[t];
      });
    });
    return { captured: captured, adv: score.w - score.b };
  }

  function renderCaptured() {
    if (!liveGame) return;
    var info = computeCaptured();
    var selfColor = perspective();
    var oppColor = selfColor === 'w' ? 'b' : 'w';
    fillTray($('capturedBySelf'), info.captured[selfColor], (selfColor === 'w' ? info.adv : -info.adv));
    fillTray($('capturedByOpponent'), info.captured[oppColor], (oppColor === 'w' ? info.adv : -info.adv));
  }
  function fillTray(el, pieces, adv) {
    el.innerHTML = '';
    var order = { q: 0, r: 1, b: 2, n: 3, p: 4 };
    pieces.sort(function (a, b) { return order[a] - order[b]; });
    pieces.forEach(function (t) {
      var s = document.createElement('span');
      s.className = 'cap';
      // captured pieces shown in the opponent-of-tray colour
      s.innerHTML = PIECES[advColorForTray(el)][t];
      el.appendChild(s);
    });
    if (adv > 0) {
      var a = document.createElement('span');
      a.className = 'adv';
      a.textContent = '+' + adv;
      el.appendChild(a);
    }
  }
  function advColorForTray(el) {
    // capturedBySelf holds pieces of the opponent's colour, and vice-versa.
    var selfColor = perspective(), oppColor = selfColor === 'w' ? 'b' : 'w';
    return el.id === 'capturedBySelf' ? oppColor : selfColor;
  }

  // ---- Status / sidebar ----
  function updateStatusMessage() {
    var el = $('statusMsg');
    el.className = 'status-msg';
    if (!liveGame) return;
    if (!players.w || !players.b) {
      el.textContent = 'Waiting for opponent… share room ' + roomCode;
      toggle($('rematchBtn'), false); enable($('resignBtn'), false); enable($('drawBtn'), false);
      return;
    }
    if (status && status.over) {
      el.classList.add('over');
      el.textContent = resultText();
      toggle($('rematchBtn'), !!myColor);
      enable($('resignBtn'), false); enable($('drawBtn'), false);
      return;
    }
    toggle($('rematchBtn'), false);
    enable($('resignBtn'), !!myColor); enable($('drawBtn'), !!myColor);
    var turnName = liveGame.turn === 'w' ? 'White' : 'Black';
    var prefix = '';
    if (status && status.check) { el.classList.add('check'); prefix = 'Check! '; }
    if (!atLive()) { el.textContent = 'Reviewing move ' + viewPly + ' / ' + history.length + ' — click ⏭ for live'; return; }
    if (!myColor) el.textContent = prefix + turnName + ' to move (spectating)';
    else if (liveGame.turn === myColor) el.textContent = prefix + 'Your move';
    else el.textContent = prefix + 'Waiting for opponent…';
  }

  function resultText() {
    if (!status) return '';
    if (status.result === 'draw') return 'Draw by ' + status.reason;
    var winner = status.result === 'w' ? 'White' : 'Black';
    if (myColor && status.result === myColor) return 'You won by ' + status.reason + '!';
    if (myColor) return 'You lost by ' + status.reason;
    return winner + ' won by ' + status.reason;
  }

  function updatePlayerBars() {
    $('roomCode').textContent = roomCode || '—';
    $('myColor').textContent = myColor === 'w' ? 'White' : myColor === 'b' ? 'Black' : 'Spectator';
    var selfColor = perspective(), oppColor = selfColor === 'w' ? 'b' : 'w';
    var oppPresent = players[oppColor];
    var selfPresent = myColor ? players[myColor] : true;
    setDot($('opponentStatus'), oppPresent);
    setDot($('selfStatus'), selfPresent);
    $('opponentBar').querySelector('.who').textContent =
      myColor ? 'Opponent · ' + (oppColor === 'w' ? 'White' : 'Black') : (oppColor === 'w' ? 'White' : 'Black');
    $('selfBar').querySelector('.who').textContent =
      myColor ? 'You · ' + (selfColor === 'w' ? 'White' : 'Black') : (selfColor === 'w' ? 'White' : 'Black');
    renderCaptured();
  }
  function setDot(el, on) { el.className = 'dot ' + (on ? 'online' : 'offline'); }

  // ---- Move list + navigation ----
  function rebuildMoveList() {
    var list = $('moveList');
    list.innerHTML = '';
    for (var i = 0; i < history.length; i += 2) {
      var num = document.createElement('div');
      num.className = 'num';
      num.textContent = (i / 2 + 1) + '.';
      list.appendChild(num);
      list.appendChild(sanCell(i));
      if (history[i + 1]) list.appendChild(sanCell(i + 1));
      else list.appendChild(document.createElement('div'));
    }
    var active = list.querySelector('.san.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }
  function sanCell(idx) {
    var d = document.createElement('div');
    d.className = 'san' + (viewPly === idx + 1 ? ' active' : '');
    d.textContent = history[idx].san;
    d.addEventListener('click', function () { gotoPly(idx + 1); });
    return d;
  }
  function gotoPly(ply) {
    viewPly = Math.max(0, Math.min(ply, history.length));
    clearSelection();
    render(); rebuildMoveList(); updateNavButtons(); updateStatusMessage();
  }
  function updateNavButtons() {
    enable($('navStart'), viewPly > 0);
    enable($('navPrev'), viewPly > 0);
    enable($('navNext'), viewPly < history.length);
    enable($('navEnd'), viewPly < history.length);
  }

  // ---- Draw / result UI ----
  function updateDrawUI() {
    var box = $('drawOfferBox');
    var incoming = drawOfferFrom && myColor && drawOfferFrom !== myColor && !isOver();
    toggle(box, !!incoming);
  }
  function showResult() {
    if (!status || !status.over) return;
    var modal = $('resultModal');
    var title = $('resultTitle');
    title.className = 'result-title';
    var t;
    if (status.result === 'draw') { t = 'Draw'; }
    else if (myColor && status.result === myColor) { t = 'You won!'; title.classList.add('win'); Sound.play('win'); }
    else if (myColor) { t = 'You lost'; title.classList.add('lose'); Sound.play('lose'); }
    else { t = (status.result === 'w' ? 'White' : 'Black') + ' won'; }
    if (status.result === 'draw') Sound.play('draw');
    title.textContent = t;
    $('resultReason').textContent = 'by ' + status.reason;
    toggle($('modalRematchBtn'), !!myColor);
    modal.classList.remove('hidden');
  }
  function hideResult() { $('resultModal').classList.add('hidden'); }

  // ---- Chat + notifications ----
  var unreadChat = 0;
  var toastContainer = null;

  function selfLabel() { return myColor === 'w' ? 'White' : myColor === 'b' ? 'Black' : 'Spectator'; }

  function addChat(from, text) {
    var log = $('chatLog');
    var div = document.createElement('div');
    div.className = 'msg' + (from === 'system' ? ' system' : '');
    if (from === 'system') div.textContent = text;
    else {
      var name = document.createElement('span');
      name.className = 'name'; name.textContent = from + ': ';
      div.appendChild(name); div.appendChild(document.createTextNode(text));
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;

    // Notify on a message from someone else (so the other player notices it
    // even when the chat panel is scrolled out of view, e.g. on mobile).
    if (from !== 'system' && from !== selfLabel()) {
      unreadChat++;
      updateChatBadge();
      flashChatHeader();
      showToast('💬 ' + from + ': ' + text);
      Sound.play('notify');
    }
  }

  function updateChatBadge() {
    var badge = $('chatBadge');
    if (unreadChat > 0) { badge.textContent = unreadChat; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  }
  function flashChatHeader() {
    var h = $('chatBox').querySelector('h3');
    h.classList.remove('flash'); void h.offsetWidth; h.classList.add('flash');
  }
  function clearUnread() { unreadChat = 0; updateChatBadge(); }
  function focusChat() {
    $('chatBox').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    var input = $('chatInput');
    input.focus({ preventScroll: true });
    clearUnread();
  }

  function showToast(text, kind) {
    if (!toastContainer) return;
    var t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = text;
    t.addEventListener('click', function () { focusChat(); dismiss(); });
    toastContainer.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    var killer = setTimeout(dismiss, 4500);
    function dismiss() {
      clearTimeout(killer);
      t.classList.remove('show');
      setTimeout(function () { if (t.parentNode) t.remove(); }, 300);
    }
  }
  function flashError(message) {
    if (lobbyEl && !lobbyEl.classList.contains('hidden')) {
      $('lobbyError').textContent = message;
      setTimeout(function () { $('lobbyError').textContent = ''; }, 4000);
    } else {
      addChat('system', '⚠ ' + message);
      if (/illegal|invalid|turn/i.test(message)) Sound.play('illegal');
    }
    clearSelection();
    if (liveGame) render();
  }

  // ---- Helpers ----
  function toggle(el, show) { el.classList.toggle('hidden', !show); }
  function enable(el, on) { el.disabled = !on; }
  function showGame() { lobbyEl.classList.add('hidden'); gameEl.classList.remove('hidden'); }

  // ---- Init ----
  function init() {
    $('createBtn').addEventListener('click', function () { Sound.resume(); send({ type: 'create', playerId: playerId }); });
    $('joinBtn').addEventListener('click', function () {
      Sound.resume();
      var code = $('roomInput').value.trim().toUpperCase();
      if (code) send({ type: 'join', room: code, playerId: playerId });
    });
    $('roomInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('joinBtn').click(); });

    $('resignBtn').addEventListener('click', function () { if (confirm('Resign this game?')) send({ type: 'resign' }); });
    $('drawBtn').addEventListener('click', function () { send({ type: 'draw', action: 'offer' }); addChat('system', 'Draw offer sent.'); });
    $('acceptDrawBtn').addEventListener('click', function () { send({ type: 'draw', action: 'accept' }); });
    $('declineDrawBtn').addEventListener('click', function () { send({ type: 'draw', action: 'decline' }); drawOfferFrom = null; updateDrawUI(); });
    $('rematchBtn').addEventListener('click', function () { send({ type: 'rematch' }); addChat('system', 'Rematch requested…'); });
    $('modalRematchBtn').addEventListener('click', function () { send({ type: 'rematch' }); hideResult(); addChat('system', 'Rematch requested…'); });
    $('modalCloseBtn').addEventListener('click', hideResult);
    $('flipBtn').addEventListener('click', function () { manualFlip = !manualFlip; render(); updatePlayerBars(); });
    $('leaveBtn').addEventListener('click', function () { location.hash = ''; location.reload(); });
    $('copyBtn').addEventListener('click', function () {
      var url = location.origin + '/#' + roomCode;
      if (navigator.clipboard) navigator.clipboard.writeText(url);
      $('copyBtn').textContent = 'copied!';
      setTimeout(function () { $('copyBtn').textContent = 'copy link'; }, 1500);
    });
    $('chatForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var text = $('chatInput').value;
      if (text.trim()) send({ type: 'chat', text: text });
      $('chatInput').value = '';
      clearUnread();
    });
    $('chatInput').addEventListener('focus', clearUnread);
    $('chatLog').addEventListener('scroll', function () {
      var el = $('chatLog');
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) clearUnread();
    });

    // Toast container for notifications.
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);

    // Sound toggle.
    var sb = $('soundBtn');
    sb.textContent = Sound.enabled ? '🔊' : '🔇';
    sb.classList.toggle('off', !Sound.enabled);
    sb.addEventListener('click', function () {
      var on = Sound.toggle();
      sb.textContent = on ? '🔊' : '🔇';
      sb.classList.toggle('off', !on);
      if (on) { Sound.resume(); Sound.play('move'); }
    });

    // Navigation buttons.
    $('navStart').addEventListener('click', function () { gotoPly(0); });
    $('navPrev').addEventListener('click', function () { gotoPly(viewPly - 1); });
    $('navNext').addEventListener('click', function () { gotoPly(viewPly + 1); });
    $('navEnd').addEventListener('click', function () { gotoPly(history.length); });
    document.addEventListener('keydown', function (e) {
      if (gameEl.classList.contains('hidden')) return;
      if (e.target.tagName === 'INPUT') return;
      if (e.key === 'ArrowLeft') gotoPly(viewPly - 1);
      else if (e.key === 'ArrowRight') gotoPly(viewPly + 1);
      else if (e.key === 'Home') gotoPly(0);
      else if (e.key === 'End') gotoPly(history.length);
      else if (e.key.toLowerCase() === 'f') { manualFlip = !manualFlip; render(); updatePlayerBars(); }
    });

    // Board pointer handlers.
    boardEl.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    boardEl.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    // Reconnect promptly when the user returns to the tab (the #1 cause of
    // "stuck reconnecting" on mobile is the browser suspending the page).
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') ensureConnected();
    });
    window.addEventListener('focus', ensureConnected);
    window.addEventListener('pageshow', ensureConnected);
    window.addEventListener('online', ensureConnected);
    // Proactively drop the socket when the page is frozen / put in bfcache, so
    // we never come back to a "zombie" socket that looks open but is dead.
    function closeForBackground() {
      stopKeepalive();
      try { if (ws) { ws.onclose = null; ws.close(); } } catch (e) {}
    }
    window.addEventListener('pagehide', closeForBackground);
    document.addEventListener('freeze', closeForBackground);
    document.addEventListener('resume', ensureConnected);

    connect();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
