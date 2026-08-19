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
