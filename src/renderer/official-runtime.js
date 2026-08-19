/* eslint-env browser */
'use strict'
/**
 * Fallback runtime adapter for Sandustry's official `manifestVersion: 1` main
 * entries.
 *
 * SandLoader now prefers src/mods/official-native.js, which stages official
 * mods into Sandustry's native local-mod folder so the game can own the real
 * main + worker lifecycle. This adapter remains as a compatibility fallback for
 * any explicitly wrapped official renderer entry and therefore must still fail
 * loudly and handle late installation correctly.
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

  function validVersion(value) {
    if (value == null) return null
    var n = Number(value)
    if (!Number.isFinite(n) || n < 0) return null
    return Math.floor(n)
  }

  function makeSandkit(modId, apiVersion, settingsValues) {
    var st = SMLN.getState()
    var raw = SMLN.sandkit || {}

    // Prefer version metadata exposed by the live game when available. The
    // wrapper's manifest/fallback value is only a fallback, so a game reporting
    // apiVersion 0 stays 0 instead of being rewritten by `|| 1`.
    var runtimeVersion = validVersion(raw && raw.apiVersion)
    if (runtimeVersion == null && st && st.sandkit) runtimeVersion = validVersion(st.sandkit.apiVersion)
    if (runtimeVersion == null) runtimeVersion = validVersion(SMLN.apiVersion)

    var requestedVersion = validVersion(apiVersion)
    var versionNum = runtimeVersion != null
      ? runtimeVersion
      : (requestedVersion != null ? requestedVersion : 1)

    return {
      apiVersion: versionNum,
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

    // A fallback entry can be installed after the ready event already fired.
    // Do not wait for an event that will never repeat.
    if (SMLN.game) {
      start()
      return
    }

    if (typeof SMLN.on === 'function') {
      SMLN.on('ready', start)
    } else if (typeof SMLN.whenReady === 'function') {
      SMLN.whenReady(function () { global.setTimeout(start, 0) })
    } else if (typeof SMLN.log === 'function') {
      SMLN.log(
        'warn',
        '[official:' + modId + '] no supported ready handler (SMLN.on or SMLN.whenReady); main entry will not run'
      )
    }
  }

  SMLN.official = {
    execute: execute,
    makeSandkit: makeSandkit,
  }

  SMLN.log('info', 'official Sandkit entry adapter installed')
})(typeof globalThis !== 'undefined' ? globalThis : window)
