/* eslint-env browser */
'use strict'
/**
 * A handle on the game's own webpack module registry.
 *
 * Sandustry's renderer is a webpack bundle. Most of what a mod needs is reached
 * through the Sandkit API, but a few things are only available as module
 * exports and never put on a global or on FH - React, react-dom, and the tech
 * tree's grid among them.
 *
 * Webpack's chunk array is the supported way in. Pushing a chunk whose third
 * element is a callback hands us the real `__webpack_require__`:
 *
 *   webpackChunksand_v1.push([[id], {}, (req) => { ... }])
 *
 * We keep that `req` and expose two operations on top of it:
 *
 *   get(id)        - load one module by id
 *   find(predicate) - scan the registry for a module by *shape*
 *
 * `find` is the one to prefer. Minified module ids are regenerated on every
 * game build, so an id is true for exactly one version; a shape check ("has
 * createElement and useState") survives rebuilds. Ids remain useful only as a
 * fast path, and every caller here treats them as a hint, never a requirement.
 *
 * Nothing in this file assumes the scan will succeed. Reaching into a private
 * module graph is archaeology, and it must fail soft: callers get null and
 * report it, rather than the renderer throwing.
 */
;(function installWebpackBridge(global) {
  var SMLN = global.__SMLN__
  if (!SMLN || SMLN.webpack) return

  /** Chunk array globals this game has used, most likely first. */
  var CHUNK_KEYS = ['webpackChunksand_v1', 'webpackChunksandustry', 'webpackChunk']

  var req = null
  var attempted = false
  var failure = null

  function findChunkArray() {
    var i
    for (i = 0; i < CHUNK_KEYS.length; i++) {
      var arr = global[CHUNK_KEYS[i]]
      if (arr && typeof arr.push === 'function') return arr
    }
    // Any global that looks like a webpack chunk array will do.
    for (var k in global) {
      if (k.indexOf('webpackChunk') !== 0) continue
      try {
        var v = global[k]
        if (v && typeof v.push === 'function') return v
      } catch (_) { /* exotic getter; keep looking */ }
    }
    return null
  }

  /**
   * Capture `__webpack_require__`. The callback runs synchronously inside
   * push(), so `req` is set by the time this returns.
   */
  function acquire() {
    if (attempted) return req
    attempted = true

    var chunks = findChunkArray()
    if (!chunks) { failure = 'no webpack chunk array on this build'; return null }

    try {
      chunks.push([
        ['smln-webpack-bridge'],
        {},
        function (r) { req = r },
      ])
    } catch (e) {
      failure = 'chunk push rejected: ' + (e && e.message)
      return null
    }

    if (!req) failure = 'webpack accepted the chunk but handed back no require'
    return req
  }

  /** Load one module by id. Returns null rather than throwing. */
  function get(id) {
    var r = acquire()
    if (!r) return null
    try { return r(id) } catch (_) { return null }
  }

  /**
   * First module whose exports satisfy `predicate`.
   *
   * `hintIds` are tried first so the common case costs a couple of lookups
   * instead of a full registry sweep. Requiring a module executes it; these are
   * all already part of the game's own graph, but one can still throw on load,
   * so failures are skipped rather than aborting the scan.
   */
  function find(predicate, hintIds) {
    var r = acquire()
    if (!r || typeof predicate !== 'function') return null

    var i, mod
    for (i = 0; hintIds && i < hintIds.length; i++) {
      mod = get(hintIds[i])
      try { if (mod && predicate(mod)) return mod } catch (_) { /* keep going */ }
    }

    var ids
    try { ids = r.m ? Object.keys(r.m) : [] } catch (_) { return null }
    for (i = 0; i < ids.length; i++) {
      try { mod = r(ids[i]) } catch (_) { continue }
      try { if (mod && predicate(mod)) return mod } catch (_) { /* keep going */ }
    }
    return null
  }

  SMLN.webpack = {
    get: get,
    find: find,
    available: function () { return !!acquire() },
    why: function () { return failure },
  }
})(typeof globalThis !== 'undefined' ? globalThis : window)
