/*
 * sounds.js — Lightweight sound effects via the Web Audio API.
 *
 * Sounds are synthesized at runtime (short blips/clicks/chords) so there are
 * no binary assets to ship or download. Exposes a global `Sound` with:
 *   Sound.play(name)   // 'move','capture','check','castle','promote',
 *                      // 'illegal','notify','start','win','lose','draw'
 *   Sound.enabled      // boolean (persisted in localStorage)
 *   Sound.toggle()     // flip and persist
 *   Sound.resume()     // call from a user gesture to unlock audio
 */
(function (root) {
  'use strict';

  var ctx = null;
  function ac() {
    if (!ctx) {
      var AC = root.AudioContext || root.webkitAudioContext;
      if (AC) ctx = new AC();
    }
    return ctx;
  }

  var enabled = true;
  try {
    enabled = localStorage.getItem('chessSound') !== 'off';
  } catch (e) {}

  // A single tone with an envelope.
  function tone(opts) {
    var c = ac();
    if (!c) return;
    var t0 = c.currentTime + (opts.delay || 0);
    var osc = c.createOscillator();
    var gain = c.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(opts.freq, t0);
    if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, t0 + opts.dur);
    var vol = (opts.vol == null ? 0.18 : opts.vol);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    osc.connect(gain).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + opts.dur + 0.02);
  }

  // A short noise burst — gives moves a wood-y "click" transient.
  function click(vol, dur) {
    var c = ac();
    if (!c) return;
    dur = dur || 0.05;
    var n = Math.floor(c.sampleRate * dur);
    var buf = c.createBuffer(1, n, c.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < n; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.5);
    }
    var src = c.createBufferSource();
    src.buffer = buf;
    var g = c.createGain();
    g.gain.value = vol == null ? 0.16 : vol;
    var hp = c.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 1600;
    src.connect(hp).connect(g).connect(c.destination);
    src.start();
  }

  var SOUNDS = {
    move: function () { click(0.13, 0.045); tone({ freq: 260, dur: 0.05, vol: 0.08, type: 'triangle' }); },
    capture: function () { click(0.22, 0.06); tone({ freq: 180, to: 120, dur: 0.09, vol: 0.12, type: 'sawtooth' }); },
    castle: function () { click(0.16, 0.05); tone({ freq: 300, dur: 0.05, vol: 0.08 }); click(0.14, 0.05, 0.06); },
    check: function () { tone({ freq: 660, dur: 0.09, vol: 0.16, type: 'square' }); tone({ freq: 880, dur: 0.12, vol: 0.12, type: 'square', delay: 0.08 }); },
    promote: function () { tone({ freq: 520, dur: 0.1, vol: 0.12 }); tone({ freq: 780, dur: 0.12, vol: 0.12, delay: 0.09 }); tone({ freq: 1040, dur: 0.14, vol: 0.1, delay: 0.18 }); },
    illegal: function () { tone({ freq: 160, to: 110, dur: 0.16, vol: 0.14, type: 'sawtooth' }); },
    notify: function () { tone({ freq: 600, dur: 0.1, vol: 0.12 }); tone({ freq: 800, dur: 0.12, vol: 0.1, delay: 0.1 }); },
    start: function () { tone({ freq: 440, dur: 0.12, vol: 0.12 }); tone({ freq: 660, dur: 0.14, vol: 0.1, delay: 0.1 }); },
    win: function () { [523, 659, 784, 1047].forEach(function (f, i) { tone({ freq: f, dur: 0.18, vol: 0.13, delay: i * 0.11 }); }); },
    lose: function () { [392, 330, 262].forEach(function (f, i) { tone({ freq: f, dur: 0.22, vol: 0.13, type: 'triangle', delay: i * 0.14 }); }); },
    draw: function () { tone({ freq: 440, dur: 0.18, vol: 0.12 }); tone({ freq: 440, dur: 0.2, vol: 0.1, delay: 0.2 }); }
  };

  var Sound = {
    get enabled() { return enabled; },
    set enabled(v) {
      enabled = !!v;
      try { localStorage.setItem('chessSound', enabled ? 'on' : 'off'); } catch (e) {}
    },
    toggle: function () { this.enabled = !enabled; return enabled; },
    resume: function () {
      var c = ac();
      if (c && c.state === 'suspended') c.resume();
    },
    play: function (name) {
      if (!enabled) return;
      var fn = SOUNDS[name];
      if (!fn) return;
      try { this.resume(); fn(); } catch (e) {}
    }
  };

  root.Sound = Sound;
})(typeof self !== 'undefined' ? self : this);
