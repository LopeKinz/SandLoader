/* eslint-env browser */
'use strict'
/**
 * SandLoader renderer runtime.
 *
 * Injected ahead of the game bundle, so it exists before any game code runs.
 * Its job is small and specific:
 *
 *   1. Provide `globalThis.__SMLN__.__capture(FH, state)` for the core patch
 *      to call at `game:ready`.
 *   2. Re-publish the game's own `FH` API as `window.SMLN.game` so mods reach
 *      it without patching anything themselves.
 *   3. Offer a tiny event bus that works *before* capture, so mods can
 *      subscribe at load time and get called once the game is up.
 *
 * Everything here is defensive. The game is the host; if a shape changed we
 * report it and keep going rather than throwing inside the renderer, where an
 * uncaught error can take the canvas down.
 */
;(function initSmlnRuntime(global) {
  if (global.__SMLN__ && global.__SMLN__.__ready) return

  // Injected by the prelude from package.json. The literal is only the
  // fallback for a context that loaded runtime.js on its own.
  var VERSION = global.__SMLN_VERSION__ || '0.0.0'
  var listeners = Object.create(null)
  var pending = []
  var captured = { FH: null, state: null, phase: null }

  function log(level, msg, extra) {
    var line = '[SMLN] ' + msg
    try {
      if (level === 'error') console.error(line, extra || '')
      else if (level === 'warn') console.warn(line, extra || '')
      else console.log(line, extra || '')
      // Mirror into the main-process log file when the preload bridge exists.
      if (global.electron && typeof global.electron.log === 'function') {
        global.electron.log(level, 'renderer', msg + (extra ? ' ' + safe(extra) : ''))
      }
    } catch (_) { /* logging must never throw */ }
  }

  function safe(v) {
    try { return typeof v === 'string' ? v : JSON.stringify(v) } catch (_) { return String(v) }
  }

  /** Subscribe. Handlers are isolated: one throwing never blocks the others. */
  function on(event, fn) {
    ;(listeners[event] || (listeners[event] = [])).push(fn)
    // Late subscribers to an already-fired lifecycle event fire immediately.
    if (event === 'ready' && captured.FH) invoke(fn, api)
    return function off() {
      var arr = listeners[event] || []
      var i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    }
  }

  function emit(event, payload) {
    var arr = listeners[event]
    if (!arr) return
    for (var i = 0; i < arr.length; i++) invoke(arr[i], payload)
  }

  function invoke(fn, payload) {
    try { fn(payload) } catch (e) { log('error', 'listener for failed: ' + (e && e.message), e && e.stack) }
  }

  /**
   * Called by the injected core patch. Idempotent - the game emits both
   * `game:ready` and `game:started`, and reloads re-run the whole thing.
   */
  function __capture(FH, state, phase) {
    try {
      captured.FH = FH
      captured.state = state
      captured.phase = phase
      api.game = FH
      api.state = state

      // Sandustry also carries an official, documented API - `sandkit` - which
      // hangs off the state and is obtained through getApi(). It is the layer
      // mods should prefer; `game`/FH is the internal engine API underneath it.
      // Note this build's Sandkit methods are state-first
      // (api.elements.createAt(state, x, y, ...)); newer builds bind state.
      api.sandkit = null
      try {
        if (state && state.sandkit && typeof state.sandkit.getApi === 'function') {
          api.sandkit = state.sandkit.getApi()
        }
      } catch (e) {
        log('warn', 'sandkit.getApi() failed: ' + (e && e.message))
      }
      if (!api.__ready) {
        api.__ready = true
        log('info', 'captured game API at ' + phase +
          ' (FH: ' + Object.keys(FH || {}).length + ' namespaces' +
          ', sandkit: ' + (api.sandkit ? Object.keys(api.sandkit).length + ' namespaces' : 'unavailable') + ')')
        for (var i = 0; i < pending.length; i++) invoke(pending[i], api)
        pending.length = 0
      }
      emit('ready', api)
      emit(phase, api)
    } catch (e) {
      log('error', 'capture failed: ' + (e && e.message), e && e.stack)
    }
  }

  /** Run `fn` once the game API is available (immediately if it already is). */
  function whenReady(fn) {
    if (captured.FH) invoke(fn, api)
    else pending.push(fn)
  }

  /** Current live game state, or null before capture. */
  function getState() { return captured.state }

  /**
   * Post a raw message to the simulation worker.
   * Shape: `[messageType, ...args]`. Returns false if the path is unavailable
   * rather than throwing, so callers can report a clean error.
   */
  function postSim(args) {
    var s = captured.state
    try {
      var mgr = s && s.environment && s.environment.multithreading &&
        s.environment.multithreading.simulation && s.environment.multithreading.simulation.manager
      if (!mgr || typeof mgr.postMessage !== 'function') return false
      mgr.postMessage(args)
      return true
    } catch (e) {
      log('error', 'postSim failed: ' + (e && e.message))
      return false
    }
  }

  /**
   * Call the main process and await a result.
   *
   * The game's preload exposes no general IPC and cannot be modified, so the
   * request rides its fire-and-forget logging bridge under a reserved scope,
   * and the answer comes back as a `__rpcResult` call the main process
   * evaluates in this page. One request in flight per id.
   *
   * The timeout is generous because some actions open a native file dialog and
   * wait on the user.
   */
  var rpcSeq = 0
  var rpcPending = Object.create(null)
  var RPC_TIMEOUT_MS = 180000

  function callMain(action, payload) {
    return new Promise(function (resolve) {
      var id = 'r' + (++rpcSeq)
      if (!global.electron || typeof global.electron.log !== 'function') {
        resolve({ ok: false, error: 'no bridge to the main process' })
        return
      }
      rpcPending[id] = resolve
      try {
        global.electron.log('info', 'smln:rpc',
          JSON.stringify({ id: id, action: action, payload: payload || {} }))
      } catch (e) {
        delete rpcPending[id]
        resolve({ ok: false, error: e && e.message })
        return
      }
      setTimeout(function () {
        if (!rpcPending[id]) return
        delete rpcPending[id]
        resolve({ ok: false, error: 'the main process did not answer' })
      }, RPC_TIMEOUT_MS)
    })
  }

  /** Called by the main process; see reply() in src/main/entry.js. */
  function __rpcResult(id, result) {
    var resolve = rpcPending[id]
    if (!resolve) return
    delete rpcPending[id]
    invoke(resolve, result)
  }

  /*
   * ------------------------------------------------------------ flight ceiling
   *
   * The game keeps a no-fly strip along the top of the world - one soft bound
   * that cancels hovering, one hard bound the player cannot rise past - and
   * reads both out of `store.world.externalMap`. A SandLoader custom map leaves
   * that null, so both fall back to a fixed number of world pixels: 600 and
   * 550. See the smln:top-bound-* patches in src/patch/core-patches.js for the
   * two call sites those numbers come from.
   *
   * Fixed pixels are the bug. The world the game ships is 3840x3840 cells at
   * cellSize 4 - 15360 pixels tall - where 600 pixels is 3.9% of the height.
   * The same 600 pixels on a 201-cell map (804 pixels, the shortest the editor
   * will make) is 75% of it. Short maps get almost no sky.
   *
   * So: keep the vanilla *share*, never exceed the vanilla absolute. A map at
   * least as tall as vanilla keeps the number the game shipped; anything
   * shorter gets the strip scaled down with it.
   */

  /** Cells to world pixels. `cellSize:4` in the bundle's config module, and the
   *  hard-bound site itself computes `store.world.size.height*cellSize`. */
  var CELL_SIZE = 4
  /**
   * The vanilla world's height in cells.
   *
   * Measured in a loaded world - `store.world.size` reads {3840,3840} - not
   * derived, and that distinction cost two wrong numbers before this one. The
   * menu's background world is 720 and is not the game; the 1280x1280
   * `map_blueprint_playtest.png` is the blueprint the loader falls back to and
   * not the map you play. The shipped config sets `procgen.useProcgenMap` and
   * the world is generated at `procgen.params.{width,height}`, both 3840:
   *
   *   g=procgen.params.width ?? map_blueprint.width    // 3840, not 1280
   *
   * The game agrees, twice: it identifies its own map with the literal test
   * `3840===store.world.size.width`, and keeps `{worldWidth:3840*cellSize,
   * worldHeight:3840*cellSize,horizonY:7646}` as that world's dimensions.
   */
  var VANILLA_WORLD_CELLS = 3840
  var VANILLA_WORLD_PX = VANILLA_WORLD_CELLS * CELL_SIZE

  /**
   * Cached per world load, keyed on the world's height in cells - the one thing
   * that changes when a different map is loaded. `topBound` is called from
   * inside the movement code on every frame that asks about the ceiling, so it
   * must not redo this work.
   */
  var boundCache = { cells: -1, values: null }

  /**
   * Is this world a custom map?
   *
   * `location.search` rather than anything in the state, because the state does
   * not know: the game parses `custom_map` out of the query string at boot,
   * hands the id straight to the map loader, and stores nothing about it -
   * `store` carries a `worldId` and a `worldName` and no trace of where the
   * terrain came from. The URL is the only record.
   *
   * The known gap: a custom-map world saved and reloaded through the game's own
   * save system comes back under `load=`, not `custom_map=`, and this returns
   * false for it.
   */
  function isCustomMap() {
    try {
      var search = global.location && global.location.search
      return typeof search === 'string' && search.indexOf('custom_map=') >= 0
    } catch (_) { return false }
  }

  /**
   * The flight ceiling for this world, in world pixels from the top.
   *
   * Called by the injected patch as `topBound(state, 'soft'|'hard', 600|550)`.
   * Total by construction: every path that cannot answer confidently returns
   * `fallback` unchanged, and the whole thing is wrapped, because throwing here
   * would throw inside the game's own movement loop.
   */
  function topBound(state, which, fallback) {
    try {
      if (typeof fallback !== 'number' || !isFinite(fallback)) return fallback

      var s = state || captured.state
      var size = s && s.store && s.store.world && s.store.world.size
      var cells = size && size.height
      if (typeof cells !== 'number' || !isFinite(cells) || cells <= 0) return fallback

      if (boundCache.cells !== cells) {
        boundCache.cells = cells
        boundCache.values = Object.create(null)
      }
      var key = which + ':' + fallback
      var cached = boundCache.values[key]
      if (cached !== undefined) return cached

      var value = fallback
      if (isCustomMap()) {
        var scaled = cells * CELL_SIZE * (fallback / VANILLA_WORLD_PX)
        if (scaled < value) value = scaled
      }
      boundCache.values[key] = value
      return value
    } catch (_) { return fallback }
  }

  /** Ask the game to redraw its React screens. */
  function refreshUI() {
    var FH = captured.FH, s = captured.state
    try {
      if (FH && FH.ui && typeof FH.ui.update === 'function') { FH.ui.update(s); return true }
    } catch (_) {}
    return false
  }

  var api = {
    version: VERSION,
    __ready: false,
    __capture: __capture,
    /**
     * Static type tables. The prelude defines __SMLN_ENUMS__ before this file
     * runs, so it must be read here - anything installed later (the console,
     * mods) captures `SMLN.enums` at its own install time and would otherwise
     * hold an empty object forever.
     */
    enums: global.__SMLN_ENUMS__ || {},
    /** The game's internal engine API (`FH`). Null until capture. */
    game: null,
    /** The game's official Sandkit API, if this build exposes it. */
    sandkit: null,
    /** Live game state. Null until capture. */
    state: null,
    on: on,
    emit: emit,
    whenReady: whenReady,
    getState: getState,
    postSim: postSim,
    /** Flight ceiling for the current world; called by the injected patch. */
    topBound: topBound,
    refreshUI: refreshUI,
    callMain: callMain,
    __rpcResult: __rpcResult,
    log: log,
    /** Registered console commands; populated by console.js. */
    commands: Object.create(null),
  }

  global.__SMLN__ = api
  global.SMLN = api
  log('info', 'runtime v' + VERSION + ' installed, waiting for game')
})(typeof globalThis !== 'undefined' ? globalThis : window)
