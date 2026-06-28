/*
 * store.js — pluggable persistence backend for game rooms.
 *
 * Two backends, selected automatically:
 *   - Redis (Upstash REST) when UPSTASH_REDIS_REST_URL + _TOKEN are set. This
 *     is durable across server restarts / redeploys, which the alternative
 *     (a local file) is NOT on hosts with an ephemeral disk like Render free.
 *     Uses the Upstash REST API over plain fetch (no dependency, no persistent
 *     connection) and Redis key TTLs to expire idle rooms automatically.
 *   - File (JSON) otherwise — fine for local/self-hosting or a durable disk.
 *
 * Interface:
 *   store.name                  -> 'redis' | 'file'
 *   store.loadAll()             -> Promise<Array<dump>>   (room snapshots)
 *   store.flush(dumps)          -> Promise<void>          (persist current set)
 *
 * A "dump" is { code, game, seats, gameOver, updatedAt }.
 */
'use strict';

var fs = require('fs');
var path = require('path');

function createStore(opts) {
  opts = opts || {};
  // Env vars take precedence (so a dashboard setting can override / rotate
  // without touching the repo); opts.redisUrl/redisToken are a fallback the
  // caller may load from a committed config file.
  var url = process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_REST_URL || opts.redisUrl;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_TOKEN || opts.redisToken;
  if (url && token && typeof fetch === 'function') {
    return redisStore(url, token, opts);
  }
  return fileStore(opts);
}

// ---- File backend -------------------------------------------------------

function fileStore(opts) {
  var file = opts.dataFile;
  return {
    name: 'file',
    flush: function (dumps) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(dumps));
      } catch (e) {
        console.error('persist(file) failed:', e && e.message);
      }
      return Promise.resolve();
    },
    loadAll: function () {
      try {
        var raw = fs.readFileSync(file, 'utf8');
        var arr = JSON.parse(raw);
        return Promise.resolve(Array.isArray(arr) ? arr : []);
      } catch (e) {
        return Promise.resolve([]);
      }
    }
  };
}

// ---- Redis (Upstash REST) backend --------------------------------------

function redisStore(url, token, opts) {
  var base = url.replace(/\/$/, '');
  var ttl = Math.max(60, Math.floor((opts.ttlMs || 86400000) / 1000));
  var PREFIX = 'chess:room:';
  var lastByCode = Object.create(null); // code -> last serialized json written

  function pipe(commands) {
    return fetch(base + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands)
    }).then(function (res) {
      if (!res.ok) throw new Error('redis HTTP ' + res.status);
      return res.json();
    });
  }

  return {
    name: 'redis',
    flush: function (dumps) {
      var cmds = [];
      var present = Object.create(null);
      dumps.forEach(function (d) {
        var json = JSON.stringify(d);
        present[d.code] = true;
        if (lastByCode[d.code] !== json) {
          cmds.push(['SET', PREFIX + d.code, json, 'EX', String(ttl)]);
          lastByCode[d.code] = json;
        } else {
          cmds.push(['EXPIRE', PREFIX + d.code, String(ttl)]); // keep active room alive
        }
      });
      Object.keys(lastByCode).forEach(function (code) {
        if (!present[code]) {
          cmds.push(['DEL', PREFIX + code]);
          delete lastByCode[code];
        }
      });
      if (!cmds.length) return Promise.resolve();
      return pipe(cmds).then(function () {}, function (e) {
        console.error('persist(redis) failed:', e && e.message);
      });
    },
    loadAll: function () {
      var keys = [];
      function scan(cursor) {
        return pipe([['SCAN', cursor, 'MATCH', PREFIX + '*', 'COUNT', '200']]).then(function (r) {
          var result = r[0].result;
          var next = result[0];
          keys = keys.concat(result[1] || []);
          return next === '0' ? null : scan(next);
        });
      }
      return scan('0').then(function () {
        if (!keys.length) return [];
        return pipe([['MGET'].concat(keys)]).then(function (mr) {
          var vals = (mr[0] && mr[0].result) || [];
          var dumps = [];
          vals.forEach(function (v) {
            if (!v) return;
            try {
              var d = JSON.parse(v);
              if (d && d.code) { dumps.push(d); lastByCode[d.code] = v; }
            } catch (e) {}
          });
          return dumps;
        });
      }).then(null, function (e) {
        console.error('load(redis) failed:', e && e.message);
        return [];
      });
    }
  };
}

module.exports = { createStore: createStore };
