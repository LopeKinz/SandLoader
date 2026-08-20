/* eslint-env browser */
'use strict'
/**
 * Fallback runtime adapter for Sandustry's official `manifestVersion: 1` main
 * entries.
 *
 * SandLoader prefers src/mods/official-native.js, which stages official mods
 * into Sandustry's local-mod folder so the game can own the real main + worker
 * lifecycle. This adapter remains the fallback for any explicitly wrapped
 * official renderer entry and therefore must still fail loudly and handle late
 * installation correctly.
 *
 * makeApi() below throws "the game Sandkit API is unavailable on this build"
 * when SMLN.api and SMLN.sandkit are both absent. On 0.5.x that is not a rare
 * edge case: the renderer never defines state.sandkit.getApi(), so without the
 * smln:sandkit-get-api patch this path throws for *every* official mod. If
 * that error appears, check that patch applied before suspecting the mod.
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
      // The game bundles React as a webpack module and exposes no global, so
      // this was always null and every UI-drawing mod threw on its first line
      // (`const h = React.createElement`). The bridge pulls the *live* instance
      // out of webpack - a second copy would break hooks.
      react: (raw && raw.react) ||
        (SMLN.react && typeof SMLN.react.get === 'function' ? SMLN.react.get() : null) ||
        global.React || null,
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

  /*
   * The flush must happen once, after the *last* entry finishes - not per mod,
   * which would post the registries a dozen times, and not before the slowest
   * mod has registered its content. Entries start together and settle at
   * different times, so count them in and out and fire on reaching zero.
   */
  var outstanding = 0
  var flushTimer = null

  function entryStarted() { outstanding++ }

  function entrySettled() {
    outstanding--
    if (outstanding > 0) return
    // A short settle lets entries that register from a .then() of their own
    // land before the snapshot is taken.
    if (flushTimer) global.clearTimeout(flushTimer)
    flushTimer = global.setTimeout(function () {
      flushTimer = null
      try { flushModRegistries() }
      catch (e) { SMLN.log('error', 'mod content registration failed: ' + (e && e.message)) }
    }, 50)
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
      entryStarted()

      settingsFor(modId).then(function (settingsValues) {
        var sandkit = makeSandkit(modId, apiVersion, settingsValues)
        return body(sandkit)
      }).then(function () {
        SMLN.log('info', '[official:' + modId + '] main entry loaded')
      }, function (e) {
        SMLN.log('error', '[official:' + modId + '] main entry failed: ' +
          ((e && e.message) || String(e)), e && e.stack)
      }).then(entrySettled, entrySettled)
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

  /**
   * Re-send the mod content registries to the simulation workers.
   *
   * Sandustry flushes them once, during world init:
   *
   *   await initBuiltInContent(state)
   *   postAll([RegisterModMatters,    sandkit.mods.matters])
   *   postAll([RegisterModElements,   sandkit.mods.elements])
   *   postAll([RegisterModTerrains,   sandkit.mods.terrains])
   *   postAll([RegisterModStructures, sandkit.mods.structures, snapshot()])
   *   ... emit("mods:initialized") ... emit("game:ready")
   *
   * Official main entries are supposed to run inside that window. SandLoader
   * runs them at game:ready, which is *after* the flush - so a mod's elements
   * and structures land in `state.sandkit.mods` on the main thread and the
   * simulation workers never hear about them. The content is registered and
   * invisible: nothing errors, nothing appears.
   *
   * Rather than move the whole lifecycle, repeat the flush once the entries
   * have run. It is the game's own message, with the game's own registries, on
   * the game's own channel - the workers cannot tell the difference, and a
   * second registration of the same content is what a reload would do anyway.
   */
  function flushModRegistries() {
    var st = SMLN.getState()
    var sim = null
    try {
      sim = st && st.environment && st.environment.multithreading &&
        st.environment.multithreading.simulation
    } catch (_) { sim = null }

    if (!sim || typeof sim.postAll !== 'function') {
      SMLN.log('warn', 'could not reach the simulation workers to register mod content; ' +
        'modded elements and structures will not appear in the world')
      return false
    }

    var mods = (st.sandkit && st.sandkit.mods) || null
    if (!mods) return false

    var W = (SMLN.enums && SMLN.enums.WorkerMessage) || {}
    // Fallbacks are this build's ids, used only if the table is unavailable.
    var MATTERS = Number.isFinite(W.RegisterModMatters) ? W.RegisterModMatters : 75
    var ELEMENTS = Number.isFinite(W.RegisterModElements) ? W.RegisterModElements : 29
    var TERRAINS = Number.isFinite(W.RegisterModTerrains) ? W.RegisterModTerrains : 30
    var STRUCTURES = Number.isFinite(W.RegisterModStructures) ? W.RegisterModStructures : 63

    function send(id, payload, extra) {
      try {
        sim.postAll(st, extra === undefined ? [id, payload] : [id, payload, extra])
        return true
      } catch (e) {
        SMLN.log('error', 'registering mod content with the workers failed (message ' +
          id + '): ' + (e && e.message))
        return false
      }
    }

    var counts = []
    function count(name, obj) {
      var n = obj && typeof obj === 'object' ? Object.keys(obj).length : 0
      if (n) counts.push(name + ':' + n)
      return n
    }

    count('matters', mods.matters)
    count('elements', mods.elements)
    count('terrains', mods.terrains)
    count('structures', mods.structures)
    if (!counts.length) return true // nothing registered; nothing to send

    send(MATTERS, mods.matters || {})
    send(ELEMENTS, mods.elements || {})
    send(TERRAINS, mods.terrains || {})

    // Structures carry a second argument: the game's type-registry snapshot.
    // It is not on FH, so reach the module that exports it; without it the
    // workers get the structures but not the id mapping.
    var snapshot
    try {
      var reg = SMLN.webpack && SMLN.webpack.find(function (m) {
        return m && typeof m.getTypeRegistrySnapshot === 'function'
      })
      if (reg) snapshot = reg.getTypeRegistrySnapshot()
    } catch (_) { snapshot = undefined }
    send(STRUCTURES, mods.structures || {}, snapshot)

    // `misc` entries expect an onInit during the same window.
    try {
      var misc = mods.misc || {}
      for (var k in misc) {
        if (!Object.prototype.hasOwnProperty.call(misc, k)) continue
        var m = misc[k]
        if (m && typeof m.onInit === 'function') {
          try { m.onInit(st) }
          catch (e) { SMLN.log('error', '[official] misc "' + k + '" onInit threw: ' + (e && e.message)) }
        }
      }
    } catch (_) { /* registry shape changed; the sends above still stand */ }

    SMLN.log('info', 'mod content registered with the simulation workers (' +
      counts.join(', ') + (snapshot === undefined ? ', no type snapshot' : '') + ')')
    return true
  }

  SMLN.official = {
    execute: execute,
    makeSandkit: makeSandkit,
    flushModRegistries: flushModRegistries,
  }

  SMLN.log('info', 'official Sandkit entry adapter installed')
})(typeof globalThis !== 'undefined' ? globalThis : window)
