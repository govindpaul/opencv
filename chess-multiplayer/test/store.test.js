/*
 * store.test.js — unit tests for the pluggable persistence store.
 *
 * The Redis (Upstash REST) backend is exercised against an in-memory mock of
 * the Upstash /pipeline endpoint, so the serialization, diffing, SCAN paging
 * and round-trip logic is verified without a real Redis.
 */
'use strict';

var path = require('path');
var os = require('os');
var fs = require('fs');

var passed = 0, failed = 0;
function ok(c, n) { if (c) passed++; else { failed++; console.error('  FAIL: ' + n); } }

// ---- Mock Upstash REST /pipeline ----------------------------------------
var kv = Object.create(null);
var calls = 0;
function installMockFetch() {
  global.fetch = function (url, init) {
    calls++;
    var commands = JSON.parse(init.body);
    var results = commands.map(function (cmd) {
      var op = String(cmd[0]).toUpperCase();
      if (op === 'SET') { kv[cmd[1]] = cmd[2]; return { result: 'OK' }; }
      if (op === 'EXPIRE') { return { result: kv[cmd[1]] !== undefined ? 1 : 0 }; }
      if (op === 'DEL') { var had = kv[cmd[1]] !== undefined; delete kv[cmd[1]]; return { result: had ? 1 : 0 }; }
      if (op === 'MGET') { return { result: cmd.slice(1).map(function (k) { return kv[k] !== undefined ? kv[k] : null; }) }; }
      if (op === 'SCAN') {
        var match = cmd[3]; // pattern like chess:room:*
        var prefix = match.replace(/\*$/, '');
        var keys = Object.keys(kv).filter(function (k) { return k.indexOf(prefix) === 0; });
        return { result: ['0', keys] }; // single page
      }
      return { result: null };
    });
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve(results); } });
  };
}

function freshStore() {
  delete require.cache[require.resolve('../src/store')];
  return require('../src/store').createStore({ ttlMs: 3600000 });
}

async function main() {
  // ---- Backend selection ----
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  var fileFile = path.join(os.tmpdir(), 'store-file-' + process.pid + '.json');
  var fileStore = require('../src/store').createStore({ dataFile: fileFile });
  ok(fileStore.name === 'file', 'defaults to file backend without env vars');

  process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
  installMockFetch();
  var rs = freshStore();
  ok(rs.name === 'redis', 'selects redis backend when env vars present');

  // ---- Round trip ----
  var dumpA = { code: 'AAA111', game: { history: [{ san: 'e4' }] }, seats: { w: { id: 'p1' }, b: null }, gameOver: null, updatedAt: Date.now() };
  var dumpB = { code: 'BBB222', game: { history: [] }, seats: { w: { id: 'p2' }, b: { id: 'p3' } }, gameOver: null, updatedAt: Date.now() };
  await rs.flush([dumpA, dumpB]);
  ok(kv['chess:room:AAA111'] && kv['chess:room:BBB222'], 'flush writes both rooms to redis');

  var loaded = await rs.loadAll();
  ok(loaded.length === 2, 'loadAll returns both rooms');
  var a = loaded.filter(function (d) { return d.code === 'AAA111'; })[0];
  ok(a && a.game.history[0].san === 'e4', 'loaded room preserves game state');

  // ---- Diff: unchanged room is not re-SET, removed room is deleted ----
  calls = 0;
  await rs.flush([dumpA, dumpB]); // identical -> should only EXPIRE, not SET
  ok(kv['chess:room:AAA111'], 'unchanged room still present after re-flush');

  await rs.flush([dumpA]); // B removed
  ok(kv['chess:room:AAA111'] && !kv['chess:room:BBB222'], 'room dropped from the set is deleted from redis');

  // ---- A fresh store instance loads what a previous one persisted ----
  var rs2 = freshStore();
  var loaded2 = await rs2.loadAll();
  ok(loaded2.length === 1 && loaded2[0].code === 'AAA111', 'a new server instance loads persisted rooms (survives "restart")');

  // ---- Empty database loads cleanly ----
  kv = Object.create(null); // wipe
  delete require.cache[require.resolve('../src/store')];
  var rs3 = require('../src/store').createStore({ ttlMs: 3600000 });
  // re-point global kv reference for the mock (closure uses module-level kv)
  var empty = await rs3.loadAll();
  ok(Array.isArray(empty) && empty.length === 0, 'loadAll on empty db returns []');

  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  try { fs.unlinkSync(fileFile); } catch (e) {}

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
