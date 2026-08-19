/* eslint-env browser */
'use strict'
/**
 * Runtime adapter for Sandustry's official `manifestVersion: 1` main entries.
 *
 * Official entries are not ordinary scripts. Sandustry compiles each entry as
 * `new Function("__sandkit", ...)`, exposes `const sandkit = __sandkit`, and
 * runs the body inside an async IIFE. SandLoader injects before the game bundle,
 * so executing an official entry at injection time is always too early: neither
 * the game state nor the Sandkit API exists yet.
 *
 * This adapter preserves the important parts of the official contract while
 * using the API surface SandLoader captured from the current game build:
 *
 *   - exactly-once execution after the game and the Sandkit adapter are ready;
 *   - an async body, so top-level `await` keeps working;
 *   - `sandkit.api`, `sandkit.state`, `sandkit.engine`, `sandkit.enums`;
 *   - synchronous per-mod settings backed by SandLoader's config store;
 *   - mod-relative `assets.getUrl()` / `sprites.loadFromMod()`.
 *
 * It deliberately does NOT invent APIs a legacy game build does not have. A
 * v1-only method on Sandustry 0.5.4 must fail clearly as unavailable instead of
 * silently pretending a registration succeeded.
 */
;(function installOfficialRuntime(global) {
  var SMLN = global.__SMLN__
  if (!SMLN || SMLN.official) return

  var running = Object.create(null)

  function copy(obj) {
    var out = {}
    if (!obj || typeof obj !== 'object') return out
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k]
    }
    return out
  }

  function deriveSettings(modId, initial) {
    var values = copy(initial)
    var listeners = []

    if (typeof SMLN.on === 'function') {
      SMLN.on('smln:config-changed', function (payload) {
        if (!payload || payload.mod !== modId || typeof payload.key !== 'string') return
        values[payload.key] = payload.value
        var snapshot = copy(values)
        for (var i = 0; i < listeners.length; i++) {
          try { listeners[i](snapshot) }
          catch (e) { SMLN.log('error', '[official:' + modId + '] settings listener threw: ' + (e && e.message)) }
        }
      })
    }

    return {
      get: function (key) { return values[key] },
      getAll: function () { return copy(values) },
      onChange: function (fn) {
        if (typeof fn !== 'function') return function () {}
        listeners.push(fn)
        return function () {
          var i = listeners.indexOf(fn)
          if (i >= 0) listeners.splice(i, 1)
        }
      },
    }
  }

  function scopedAssetUrl(modId, rel) {
    if (!SMLN.assets || typeof SMLN.assets.forMod !== 'function') {
      throw new Error('SandLoader asset resolver is unavailable')
    }
    return SMLN.assets.forMod(modId).url(rel)
  }

  function makeApi(modId, settingsValues) {
    var base = SMLN.api || SMLN.sandkit
    if (!base || typeof base !== 'object') {
      throw new Error('the game Sandkit API is unavailable on this build')
    }

    // Inherit unknown namespaces so SandLoader never becomes the reason a
    // method disappears. Only the namespaces that need mod identity are
    // shadowed below.
    var api = Object.create(base)
    api.settings = deriveSettings(modId, settingsValues)

    var baseAssets = base.assets && typeof base.assets === 'object' ? base.assets : null
    var assets = baseAssets ? Object.create(baseAssets) : {}
    assets.getUrl = function (relativePath) { return scopedAssetUrl(modId, relativePath) }
    api.assets = assets

    var baseSprites = base.sprites && typeof base.sprites === 'object' ? base.sprites : null
    if (baseSprites) {
      var sprites = Object.create(baseSprites)
      sprites.loadFromMod = function (spriteId, relativePath, opts) {
        if (typeof baseSprites.load !== 'function') {
          throw new Error('api.sprites.load() is unavailable on this game build')
        }
        return baseSprites.load(spriteId, scopedAssetUrl(modId, relativePath), opts || {})
      }
      api.sprites = sprites
    }

    return api
  }

  function makeSandkit(modId, apiVersion, settingsValues) {
    var st = SMLN.getState()
    var raw = SMLN.sandkit || {}
    return {
      apiVersion: Number(apiVersion) || 1,
      state: st,
      api: makeApi(modId, settingsValues),
      engine: { api: SMLN.game, state: st },
      enums: (raw && raw.enums) || SMLN.enums || {},
      react: (raw && raw.react) || global.React || null,
    }
  }

  function settingsFor(modId) {
    try {
      if (typeof SMLN.forMod !== 'function') return Promise.resolve({})
      var facade = SMLN.forMod(modId)
      if (!facade || !facade.config || typeof facade.config.getAll !== 'function') return Promise.resolve({})
      return Promise.resolve(facade.config.getAll()).catch(function (e) {
        SMLN.log('warn', '[official:' + modId + '] could not load settings: ' + (e && e.message))
        return {}
      })
    } catch (e) {
      return Promise.resolve({})
    }
  }

  /**
   * Execute one official main entry. `body` is an async function whose sole
   * argument is the official `sandkit` object; prelude.js generates it around
   * the mod source, matching Sandustry's own async-entry semantics.
   */
  function execute(modId, apiVersion, body) {
    if (typeof modId !== 'string' || !modId || typeof body !== 'function') return
    if (running[modId]) return
    var started = false

    function start() {
      if (started || running[modId]) return
      // The Sandkit adapter listens to the same `ready` event and is installed
      // before this adapter in prelude.js, so by the time this listener runs
      // SMLN.api has already been built when the game exposes Sandkit.
      if (!SMLN.game) return
      started = true
      running[modId] = true

      settingsFor(modId).then(function (settingsValues) {
        var sandkit = makeSandkit(modId, apiVersion, settingsValues)
        return body(sandkit)
      }).then(function () {
        SMLN.log('info', '[official:' + modId + '] main entry loaded')
      }, function (e) {
        SMLN.log('error', '[official:' + modId + '] main entry failed: ' +
          ((e && e.message) || String(e)), e && e.stack)
      })
    }

    if (typeof SMLN.on === 'function') SMLN.on('ready', start)
    else if (typeof SMLN.whenReady === 'function') SMLN.whenReady(function () { global.setTimeout(start, 0) })
  }

  SMLN.official = {
    execute: execute,
    makeSandkit: makeSandkit,
  }

  SMLN.log('info', 'official Sandkit entry adapter installed')
})(typeof globalThis !== 'undefined' ? globalThis : window)
