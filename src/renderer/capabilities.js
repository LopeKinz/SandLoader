/* eslint-env browser */
'use strict'
/**
 * Per-mod capability facades.
 *
 * `SMLN.forMod(id, capability)` returns the object a renderer mod sees as its
 * `SMLN`. src/mods/sandbox.js splices the call into each mod's wrapper, so a
 * mod gets its own surface without having to ask for one.
 *
 * WHAT ACTUALLY ENFORCES WHAT - the honest version:
 *
 *   Sandustry's window is created with Electron's modern defaults
 *   (contextIsolation:true, nodeIntegration:false, no sandbox:false; verified
 *   in the game's main.js). So renderer mod code has no `require`, no
 *   `process`, no `Buffer`, no `module`. Chromium enforces that, not this
 *   file, and nothing here can weaken or strengthen it.
 *
 *   That leaves exactly two privileged things reachable from inside the page:
 *
 *     1. `window.electron` - the contextBridge object from the game's
 *        preload, which can invoke main-process IPC (appQuit,
 *        saveLastPlayedGame, openExternalBrowser, diagnostics, ...).
 *     2. `SMLN.callMain` - SandLoader's own main-process RPC, which installs
 *        and deletes mods, opens folders, and reads and writes config.
 *
 *   Neither is ever placed on a facade. That is the whole of what this file
 *   enforces, plus gating SMLN.net / SMLN.fs on declared permissions - and
 *   those gates are real, because a mod with no Node has no other way out.
 *
 *   What this file does NOT do: stop a determined mod from reading
 *   `globalThis.__SMLN__` directly. Renderer mod sources are concatenated
 *   into one script and share a global scope; the wrapper is a default, not
 *   a cage. Anyone claiming otherwise is selling something. The boundary
 *   that holds against a hostile mod is Electron's, and it holds because the
 *   page has no Node to escape into.
 *
 * FH PRIVILEGE AUDIT (against the real 0.5.4 bundle, module 53601):
 *
 *   Searched the whole FH object literal for `window.electron`, `electron.`,
 *   `ipcRenderer`, `require(`, `process.`, `child_process`,
 *   `saveLastPlayedGame`, `openExternal` and `appQuit`: zero hits for every
 *   one of them. FH is engine surface, not host surface, so it is handed to
 *   mods unwrapped - wrapping ~50 namespaces to guard against nothing would
 *   be pure cost and would break `instanceof`/identity for no gain.
 *
 *   The single exception found is `FH.storage.local`, which is the page's
 *   `localStorage` with no namespacing at all: `get`/`set`/`remove` take a
 *   raw key. That is not a Node escape, but it does let one mod read or
 *   overwrite another mod's keys and the game's own (`lastPlayedGame`).
 *   So exactly that one member is wrapped, per mod, with a key prefix. It is
 *   the only thing wrapped, and it is wrapped for a reason that can be stated.
 */
;(function installSmlnCapabilities(global) {
  var SMLN = global.__SMLN__
  if (!SMLN || SMLN.forMod) return

  var LOCAL_PREFIX = 'smln.mod.'

  /** modId -> facade. A mod must get the same object every time it asks. */
  var facades = Object.create(null)
  /** modId -> the resources we handed out, so __disposeMod can reclaim them. */
  var owned = Object.create(null)

  function bookkeeping(modId) {
    if (!owned[modId]) {
      owned[modId] = {
        dispose: [],
        timers: [],
        intervals: [],
        listeners: [],
        messaging: [],
        registrations: [],
        disposed: false,
      }
    }
    return owned[modId]
  }

  function log(level, modId, msg, extra) {
    try { SMLN.log(level, '[' + modId + '] ' + msg, extra) } catch (_e) { /* logging must never throw */ }
  }

  /**
   * A rejected capability call. Deliberately a rejection with a typed shape
   * rather than an absent property: `SMLN.net.fetch is not a function` sends
   * a mod author hunting through their own code, while this names the
   * manifest line they actually need to add.
   */
  function denied(modId, permission, what) {
    var message = 'mod "' + modId + '" called ' + what + ' without the "' + permission +
      '" permission - add it to the "permissions" array in the manifest'
    var err = new Error(message)
    err.code = 'E_PERMISSION_DENIED'
    err.modId = modId
    err.permission = permission
    return err
  }

  function deniedNamespace(modId, permission, nsName, methods) {
    var ns = {}
    var make = function (name) {
      return function () {
        var err = denied(modId, permission, nsName + '.' + name + '()')
        log('warn', modId, err.message)
        return Promise.reject(err)
      }
    }
    for (var i = 0; i < methods.length; i++) ns[methods[i]] = make(methods[i])
    ns.granted = false
    return ns
  }

  // ------------------------------------------------------------------- RPC
  /**
   * Capability calls travel over the one RPC SandLoader already has. The mod
   * never sees `callMain` itself: the mod id is stamped in here, so a mod
   * cannot ask for another mod's storage by lying about the payload.
   */
  function rpc(modId, action, payload) {
    if (typeof SMLN.callMain !== 'function') {
      return Promise.resolve({ ok: false, error: 'no bridge to the main process' })
    }
    var body = {}
    for (var k in payload) if (Object.prototype.hasOwnProperty.call(payload, k)) body[k] = payload[k]
    body.mod = modId
    return SMLN.callMain(action, body)
  }

  function unwrap(result) {
    if (result && result.ok) return result.value !== undefined ? result.value : result
    var err = new Error((result && result.error) || 'the main process refused the call')
    err.code = (result && result.code) || 'E_IO'
    throw err
  }

  var STORAGE_METHODS = ['readText', 'writeText', 'readJson', 'writeJson', 'exists', 'stat', 'list', 'mkdir', 'remove', 'usage']

  function makeStorage(modId, action) {
    var ns = {}
    var make = function (op) {
      return function (a, b) {
        return rpc(modId, action, { op: op, path: a, data: b }).then(unwrap)
      }
    }
    for (var i = 0; i < STORAGE_METHODS.length; i++) ns[STORAGE_METHODS[i]] = make(STORAGE_METHODS[i])
    ns.granted = true
    return ns
  }

  function makeNet(modId) {
    return {
      granted: true,
      fetch: function (url, init) { return rpc(modId, 'modNet', { op: 'fetch', url: url, init: init }).then(unwrap) },
      json: function (url, init) { return rpc(modId, 'modNet', { op: 'json', url: url, init: init }).then(unwrap) },
      text: function (url, init) { return rpc(modId, 'modNet', { op: 'text', url: url, init: init }).then(unwrap) },
    }
  }

  function makeConfig(modId) {
    return {
      get: function (key) { return rpc(modId, 'getModConfig', {}).then(function (r) {
        if (!r || !r.ok) return undefined
        return key == null ? r.values : r.values[key]
      }) },
      getAll: function () { return rpc(modId, 'getModConfig', {}).then(function (r) { return (r && r.ok && r.values) || {} }) },
      set: function (key, value) { return rpc(modId, 'setModConfig', { key: key, value: value }) },
      reset: function (key) { return rpc(modId, 'resetModConfig', { key: key }) },
      onChange: function (fn) { return facadeOn(modId, 'config:' + modId, fn) },
    }
  }

  // ------------------------------------------------- tracked event handling
  /** Subscriptions made through a facade are remembered so dispose can undo them. */
  function facadeOn(modId, event, fn) {
    var book = bookkeeping(modId)
    var off = SMLN.on(event, fn)
    var entry = { event: event, fn: fn, off: off }
    book.listeners.push(entry)
    return function () {
      try { off() } catch (_e) {}
      var i = book.listeners.indexOf(entry)
      if (i >= 0) book.listeners.splice(i, 1)
    }
  }

  /**
   * Timers are the classic hot-reload leak: a mod sets an interval, the mod
   * is reloaded, and the old interval keeps running against a stale closure
   * forever. Handing out recorded wrappers is the only way a renderer-only
   * reload can honestly claim to have cleaned up.
   */
  function makeTimers(modId) {
    var book = bookkeeping(modId)
    return {
      setTimeout: function (fn, ms) {
        var h = global.setTimeout(function () {
          var i = book.timers.indexOf(h)
          if (i >= 0) book.timers.splice(i, 1)
          try { fn() } catch (e) { log('error', modId, 'setTimeout callback threw: ' + (e && e.message), e && e.stack) }
        }, ms)
        book.timers.push(h)
        return h
      },
      clearTimeout: function (h) {
        var i = book.timers.indexOf(h)
        if (i >= 0) book.timers.splice(i, 1)
        return global.clearTimeout(h)
      },
      setInterval: function (fn, ms) {
        var h = global.setInterval(function () {
          try { fn() } catch (e) { log('error', modId, 'setInterval callback threw: ' + (e && e.message), e && e.stack) }
        }, ms)
        book.intervals.push(h)
        return h
      },
      clearInterval: function (h) {
        var i = book.intervals.indexOf(h)
        if (i >= 0) book.intervals.splice(i, 1)
        return global.clearInterval(h)
      },
    }
  }

  /** The one FH member worth wrapping; see the audit note at the top. */
  function makeLocalStorage(modId) {
    var prefix = LOCAL_PREFIX + modId + '.'
    return {
      get: function (key) {
        try {
          var raw = global.localStorage.getItem(prefix + String(key))
          if (raw === null) return null
          try { return JSON.parse(raw) } catch (_e) { return raw }
        } catch (_e) { return null }
      },
      set: function (key, value) {
        try { global.localStorage.setItem(prefix + String(key), JSON.stringify(value)); return true }
        catch (e) { log('warn', modId, 'localStorage.set failed: ' + (e && e.message)); return false }
      },
      remove: function (key) {
        try { global.localStorage.removeItem(prefix + String(key)); return true } catch (_e) { return false }
      },
    }
  }

  // ------------------------------------------------------------- the facade
  /**
   * Build a mod's surface. An explicit allowlist, never a copy-then-delete:
   * a denylist silently grants anything added to the runtime later, which is
   * exactly the mistake that turns a new convenience method into a hole.
   */
  function forMod(modId, capability) {
    if (typeof modId !== 'string' || !modId) modId = 'unknown'
    if (facades[modId]) return facades[modId]

    var cap = capability && typeof capability === 'object'
      ? capability
      : { tier: 'sandboxed', permissions: [], granted: {}, enforceable: true, badge: 'SANDBOXED' }
    var granted = cap.granted || {}
    var book = bookkeeping(modId)
    var timers = makeTimers(modId)

    var facade = {
      version: SMLN.version,
      modId: modId,
      capability: cap,

      // --- diagnostics
      log: function (level, msg, extra) { return log(level, modId, msg, extra) },

      // --- lifecycle
      on: function (event, fn) { return facadeOn(modId, event, fn) },
      off: function (event, fn) { return SMLN.off ? SMLN.off(event, fn) : undefined },
      emit: function (event, payload) { return SMLN.emit(event, payload) },
      whenReady: function (fn) { return SMLN.whenReady(fn) },
      onDispose: function (fn) {
        if (typeof fn !== 'function') return function () {}
        book.dispose.push(fn)
        return function () {
          var i = book.dispose.indexOf(fn)
          if (i >= 0) book.dispose.splice(i, 1)
        }
      },

      // --- the game. Handed over unwrapped; see the audit note above.
      get game() { return SMLN.game },
      get sandkit() { return SMLN.sandkit },
      get api() { return SMLN.api },
      get state() { return SMLN.state },
      getState: function () { return SMLN.getState() },
      enums: SMLN.enums,
      refreshUI: function () { return SMLN.refreshUI() },
      postSim: function (args) { return SMLN.postSim(args) },

      // --- timers, recorded so a reload can reclaim them
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,

      // --- scoped capabilities
      storage: makeStorage(modId, 'modStorage'),
      config: makeConfig(modId),
      local: makeLocalStorage(modId),
    }

    // Network: a real gate. A mod with no Node has no other way to the wire.
    facade.net = granted.network
      ? makeNet(modId)
      : deniedNamespace(modId, 'network', 'SMLN.net', ['fetch', 'json', 'text'])

    // Wider filesystem. `storage` above is always available because a mod's
    // own private directory is the safe alternative to require('fs') - it is
    // why ordinary persistence needs no permission at all. `fs` is the
    // broader root, and that does need one.
    facade.fs = granted.filesystem
      ? makeStorage(modId, 'modFs')
      : deniedNamespace(modId, 'filesystem', 'SMLN.fs', STORAGE_METHODS)

    // --- console commands. Adding one is not a privileged act - the console
    // is a UI surface, not a capability - and mods have always used it, so
    // withholding it here would break every existing mod for no gain.
    if (typeof SMLN.registerCommand === 'function') {
      facade.registerCommand = function (spec) {
        var owned = {}
        for (var k in spec) if (Object.prototype.hasOwnProperty.call(spec, k)) owned[k] = spec[k]
        owned.owner = modId
        var result = SMLN.registerCommand(owned)
        // Recorded so a hot reload can tell what this mod added, even though
        // the console has no removal path today.
        book.registrations.push({ type: 'command', id: spec && spec.name })
        return result
      }
    }
    if (typeof SMLN.runCommand === 'function') facade.runCommand = SMLN.runCommand
    if (SMLN.console) facade.console = SMLN.console
    if (SMLN.commands) facade.commands = SMLN.commands

    // --- optional subsystems, bound to this mod when they are installed
    if (SMLN.i18n) facade.i18n = SMLN.i18n
    if (SMLN.register && typeof SMLN.register.as === 'function') {
      facade.register = SMLN.register.as(modId)
    }
    if (SMLN.assets && typeof SMLN.assets.forMod === 'function') {
      facade.assets = SMLN.assets.forMod(modId)
    }
    if (SMLN.messaging && typeof SMLN.messaging.as === 'function') {
      facade.messaging = SMLN.messaging.as(modId, book)
    }
    facade.events = {
      on: facade.on,
      off: facade.off,
      emit: facade.emit,
    }

    facades[modId] = facade
    return facade
  }

  /**
   * Reclaim everything a mod was given. Used by hot reload; also useful on
   * its own when a mod is disabled at runtime.
   *
   * Dispose callbacks run in reverse registration order - later registrations
   * usually depend on earlier ones, so unwinding is the order that leaves
   * nothing half-torn-down. Every callback is isolated: one mod's broken
   * cleanup must not strand the rest of the reload.
   */
  function disposeMod(modId) {
    var book = owned[modId]
    var report = {
      modId: modId,
      callbacks: { ran: 0, failed: 0 },
      timers: 0,
      listeners: 0,
      messaging: 0,
      registrations: 0,
      errors: [],
    }
    if (!book) return report

    for (var i = book.dispose.length - 1; i >= 0; i--) {
      try { book.dispose[i](); report.callbacks.ran++ }
      catch (e) {
        report.callbacks.failed++
        report.errors.push((e && e.message) || String(e))
        log('error', modId, 'dispose callback threw: ' + (e && e.message), e && e.stack)
      }
    }
    book.dispose.length = 0

    for (var t = 0; t < book.timers.length; t++) {
      try { global.clearTimeout(book.timers[t]); report.timers++ } catch (_e) {}
    }
    book.timers.length = 0
    for (var v = 0; v < book.intervals.length; v++) {
      try { global.clearInterval(book.intervals[v]); report.timers++ } catch (_e) {}
    }
    book.intervals.length = 0

    for (var l = 0; l < book.listeners.length; l++) {
      try { book.listeners[l].off(); report.listeners++ } catch (_e) {}
    }
    book.listeners.length = 0

    for (var m = 0; m < book.messaging.length; m++) {
      try { book.messaging[m](); report.messaging++ } catch (_e) {}
    }
    book.messaging.length = 0

    report.registrations = book.registrations.length
    book.registrations.length = 0
    book.disposed = true

    // Drop the facade so a reloaded mod gets a fresh one rather than a
    // closure over the state we just tore down.
    delete facades[modId]
    delete owned[modId]

    log('info', modId, 'disposed (' + report.callbacks.ran + ' callback(s), ' +
      report.timers + ' timer(s), ' + report.listeners + ' listener(s))')
    return report
  }

  SMLN.forMod = forMod
  SMLN.__disposeMod = disposeMod
  /** Exposed for the self-test and the mods UI, not for mods. */
  SMLN.__facades = function () { return Object.keys(facades) }
  SMLN.__owned = function (modId) { return owned[modId] || null }

  SMLN.log('info', 'capability facades installed')
})(typeof globalThis !== 'undefined' ? globalThis : window)
