/* eslint-env worker */
'use strict'
/**
 * SandLoader's worker-side runtime.
 *
 * The interceptor prepends this (and then each worker mod's source) to
 * `js/simulation-worker.js`, so it installs before a single line of the
 * game's worker code runs.
 *
 * TRANSPORT, AND WHY IT CANNOT COLLIDE (verified against the real 0.5.4
 * worker bundle):
 *
 *   The worker dispatches with `self.onmessage = r => { switch (r.data[0]) {
 *   case n.dD.Init: ... } }`. Two facts fall out of that one line:
 *
 *     1. It uses the `onmessage` *property*. `self.addEventListener('message',
 *        ...)` is a separate registration and both fire. We add a listener and
 *        never touch `onmessage`, so the game's dispatch is untouched. We also
 *        never monkey-patch `postMessage` - the game's own traffic is none of
 *        our business.
 *     2. Every game message is an Array whose first element is a numeric id.
 *        Our envelope is a plain object, so `r.data[0]` is `undefined`, no
 *        `case` matches, and the game's switch ignores it completely. No id
 *        allocation, no registry, nothing to keep in sync with a game update.
 *
 * A mod handler that throws is caught here and never rethrown. If it escaped,
 * it would surface inside the message event and could take down the worker
 * that runs the entire simulation - one careless mod would stop the game.
 */
;(function installSmlnWorkerRuntime(self) {
  if (self.__SMLN_WORKER__) return

  // Injected by the prelude from package.json; see runtime.js.
  var VERSION = self.__SMLN_VERSION__ || '0.0.0'
  var ENVELOPE = '__smln'
  var PROTOCOL = 1
  /** Bounded: a mod that never registers a handler must not grow memory forever. */
  var BUFFER_LIMIT = 256

  /** "modId channel" -> handler[] */
  var handlers = Object.create(null)
  /** Envelopes that arrived before anyone was listening for them. */
  var buffered = []
  var seq = 0
  var stats = { received: 0, delivered: 0, buffered: 0, dropped: 0, sent: 0, refused: 0 }

  function key(modID, channel) { return modID + ' ' + channel }

  function log(level, msg) {
    try {
      var line = '[SMLN:worker] ' + msg
      if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.log(line)
    } catch (_e) { /* logging must never throw */ }
  }

  /**
   * Which worker are we in? The three worker bundles share this runtime, and
   * a mod may legitimately care (the utility worker is the save thread).
   * Detected from what the bundle around us defines rather than from a build
   * flag, because there is no build step to set one.
   */
  function detectKind() {
    try {
      if (typeof self.name === 'string' && self.name) {
        if (self.name.indexOf('manager') >= 0) return 'manager'
        if (self.name.indexOf('utility') >= 0) return 'utility'
        if (self.name.indexOf('simulation') >= 0) return 'simulation'
      }
      if (typeof self.location === 'object' && self.location && typeof self.location.href === 'string') {
        var href = self.location.href
        if (href.indexOf('manager-worker') >= 0) return 'manager'
        if (href.indexOf('utility-worker') >= 0) return 'utility'
        if (href.indexOf('simulation-worker') >= 0) return 'simulation'
      }
    } catch (_e) { /* location is not available in every worker flavour */ }
    return 'unknown'
  }

  /**
   * Reject a payload the structured-clone algorithm would throw on, before we
   * hand it to postMessage. A DataCloneError raised inside the game's own
   * message plumbing would look like a game bug, and the mod author would
   * never see the real cause.
   */
  function serialisable(value, seen, path) {
    seen = seen || []
    path = path || 'args'
    var t = typeof value
    if (value === null || t === 'boolean' || t === 'number' || t === 'string' || t === 'undefined') return null
    if (t === 'function') return path + ' is a function'
    if (t === 'symbol') return path + ' is a Symbol'
    if (t === 'bigint') return null
    if (value instanceof Date || value instanceof RegExp) return null
    if (typeof ArrayBuffer !== 'undefined' && (value instanceof ArrayBuffer || ArrayBuffer.isView(value))) return null
    if (seen.indexOf(value) >= 0) return path + ' is circular'
    seen.push(value)
    var i
    if (Object.prototype.toString.call(value) === '[object Array]') {
      for (i = 0; i < value.length; i++) {
        var ra = serialisable(value[i], seen, path + '[' + i + ']')
        if (ra) return ra
      }
      seen.pop()
      return null
    }
    // Anything with a prototype we cannot reason about (a DOM-ish host object,
    // a class instance carrying methods) is refused rather than half-cloned.
    var proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return path + ' is not a plain object'
    for (var k in value) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) continue
      var r = serialisable(value[k], seen, path + '.' + k)
      if (r) return r
    }
    seen.pop()
    return null
  }

  function validEnvelope(data) {
    if (!data || typeof data !== 'object') return null
    if (data[ENVELOPE] !== true) return null
    if (data.v !== PROTOCOL) return 'protocol version ' + data.v + ' (expected ' + PROTOCOL + ')'
    if (typeof data.modID !== 'string' || !data.modID) return 'missing modID'
    if (typeof data.channel !== 'string' || !data.channel) return 'missing channel'
    if (Object.prototype.toString.call(data.args) !== '[object Array]') return 'args is not an array'
    return ''
  }

  function deliver(envelope) {
    var list = handlers[key(envelope.modID, envelope.channel)]
    if (!list || !list.length) return false
    for (var i = 0; i < list.length; i++) {
      try {
        list[i].apply(null, envelope.args)
      } catch (e) {
        // Contained on purpose: this listener shares a thread with the whole
        // simulation. See the file comment.
        log('error', 'handler for ' + envelope.modID + '/' + envelope.channel +
          ' threw: ' + (e && e.message))
      }
    }
    stats.delivered++
    return true
  }

  function flushFor(modID, channel) {
    if (!buffered.length) return
    var k = key(modID, channel)
    var keep = []
    for (var i = 0; i < buffered.length; i++) {
      var env = buffered[i]
      if (key(env.modID, env.channel) === k) deliver(env)
      else keep.push(env)
    }
    buffered = keep
  }

  self.addEventListener('message', function (event) {
    var data = event && event.data
    var problem = validEnvelope(data)
    if (problem === null) return          // not ours; the game's switch owns it
    if (problem) { stats.dropped++; log('warn', 'dropped an envelope: ' + problem); return }

    stats.received++
    if (deliver(data)) return

    // Nobody is listening yet. Worker mod source runs before the game's worker
    // initialises, but a mod may still register asynchronously, so hold the
    // message rather than losing it.
    if (buffered.length >= BUFFER_LIMIT) {
      buffered.shift()
      stats.dropped++
      log('warn', 'inbound buffer full (' + BUFFER_LIMIT + '), dropped the oldest message')
    }
    buffered.push(data)
    stats.buffered++
  })

  function onGameMessage(modID, channel, handler) {
    if (typeof handler !== 'function') return function () {}
    var k = key(modID, channel)
    ;(handlers[k] || (handlers[k] = [])).push(handler)
    flushFor(modID, channel)
    return function off() {
      var list = handlers[k]
      if (!list) return
      var i = list.indexOf(handler)
      if (i >= 0) list.splice(i, 1)
    }
  }

  function offGameMessage(modID, channel, handler) {
    var list = handlers[key(modID, channel)]
    if (!list) return false
    var i = list.indexOf(handler)
    if (i < 0) return false
    list.splice(i, 1)
    return true
  }

  function sendGameMessage(modID, channel) {
    var args = [].slice.call(arguments, 2)
    var problem = serialisable(args)
    if (problem) {
      stats.refused++
      log('warn', 'refused to send ' + modID + '/' + channel + ': ' + problem)
      return false
    }
    var envelope = {
      v: PROTOCOL,
      type: 'flux-message',
      dir: 'worker->game',
      modID: modID,
      channel: channel,
      args: args,
      seq: ++seq,
    }
    envelope[ENVELOPE] = true
    try {
      self.postMessage(envelope)
      stats.sent++
      return true
    } catch (e) {
      stats.refused++
      log('error', 'postMessage failed for ' + modID + '/' + channel + ': ' + (e && e.message))
      return false
    }
  }

  /*
   * The state arrives later than we do.
   *
   * The interceptor prepends this runtime and then each worker mod, so both run
   * before a single line of the game's worker code - and it is the game's code,
   * patched by smln:capture-worker-state, that publishes the state. A mod
   * asking for the Sandkit at its own top level would always find nothing, so
   * it asks through whenWorkerReady and is called once the capture has landed.
   */
  /*
   * The state is not merely late, it is conditional: the worker builds it when
   * the game hands it a world, which may be minutes after the worker started or
   * never, if the player stays in the menu. So this warns once at the quiet
   * threshold and then keeps watching at a slow interval - measured against the
   * real game, where a five-second give-up reported "never published" while the
   * patch had applied and the state simply had not been built yet.
   */
  var READY_POLL_MS = 10
  var READY_SLOW_POLL_MS = 500
  var READY_WARN_MS = 5000
  var readyWaiting = []
  var readyPolling = false
  var readyWarned = false

  function currentState() {
    return self.__SMLN_WORKER__ ? self.__SMLN_WORKER__.state : undefined
  }

  function currentSandkit() {
    var s = currentState()
    return s ? s.sandkit : undefined
  }

  function currentApi() {
    var sk = currentSandkit()
    if (!sk || typeof sk.getApi !== 'function') return null
    try {
      return sk.getApi()
    } catch (e) {
      log('error', 'the worker Sandkit refused getApi(): ' + (e && e.message))
      return null
    }
  }

  function drainReady(state) {
    var waiting = readyWaiting
    readyWaiting = []
    for (var i = 0; i < waiting.length; i++) {
      // One mod throwing must not strand the mods queued behind it.
      try {
        waiting[i](state)
      } catch (e) {
        log('error', 'a whenWorkerReady handler threw: ' + (e && e.message))
      }
    }
  }

  function pollReady(warnAt) {
    readyPolling = true
    var state = currentState()
    if (state) { readyPolling = false; drainReady(state); return }
    var late = Date.now() > warnAt
    if (late && !readyWarned) {
      readyWarned = true
      log('warn', 'no world yet, so the worker state is not built - mods waiting on ' +
        'whenWorkerReady() stay queued (this is normal in the menu)')
    }
    setTimeout(function () { pollReady(warnAt) }, late ? READY_SLOW_POLL_MS : READY_POLL_MS)
  }

  function whenWorkerReady(fn) {
    if (typeof fn !== 'function') return
    var state = currentState()
    if (state) {
      try {
        fn(state)
      } catch (e) {
        log('error', 'a whenWorkerReady handler threw: ' + (e && e.message))
      }
      return
    }
    readyWaiting.push(fn)
    if (!readyPolling) setTimeout(function () { pollReady(Date.now() + READY_WARN_MS) }, 0)
  }

  /** Every handler this runtime put into the game's tables, so it can take them back. */
  var workerRegistrations = []

  /*
   * The game dispatches with `var n = list[i]; try { n.fn(state, payload) }
   * catch (e) {}` - entries are objects carrying `.fn`. It already swallows
   * throws, but silently: a mod would break the simulation with no trace of
   * which one. Wrapping the handler here is what attaches a name to the
   * failure, and what lets hot reload take the handler back afterwards.
   */
  function addWorkerHandler(table, modID, name, fn, kind) {
    var sk = currentSandkit()
    if (!sk) {
      log('warn', 'mod "' + modID + '" asked for a worker ' + kind + ' before the state existed; ' +
        'wrap the call in whenWorkerReady()')
      return false
    }
    if (typeof fn !== 'function') return false
    var bucket = sk[table] || (sk[table] = {})
    var list = bucket[name] || (bucket[name] = [])
    var entry = {
      fn: function (state, payload) {
        try {
          return fn(state, payload)
        } catch (e) {
          log('error', 'worker ' + kind + ' "' + name + '" from mod "' + modID + '" threw: ' +
            (e && e.message))
        }
      },
    }
    list.push(entry)
    workerRegistrations.push({ modID: modID, name: name, kind: kind, table: table, entry: entry })
    return true
  }

  function releaseMod(modID) {
    var kept = []
    for (var i = 0; i < workerRegistrations.length; i++) {
      var r = workerRegistrations[i]
      if (r.modID !== modID) { kept.push(r); continue }
      var sk = currentSandkit()
      var list = sk && sk[r.table] ? sk[r.table][r.name] : null
      if (!list) continue
      var at = list.indexOf(r.entry)
      if (at !== -1) list.splice(at, 1)
    }
    workerRegistrations = kept
  }

  var workerApi = {
    onEvent: function (modID, name, fn) {
      return addWorkerHandler('workerEvents', modID, name, fn, 'event')
    },
    onInterceptor: function (modID, name, fn) {
      return addWorkerHandler('workerInterceptors', modID, name, fn, 'interceptor')
    },
    registrations: function () {
      var out = []
      for (var i = 0; i < workerRegistrations.length; i++) {
        out.push({
          modID: workerRegistrations[i].modID,
          name: workerRegistrations[i].name,
          kind: workerRegistrations[i].kind,
        })
      }
      return out
    },
    releaseMod: releaseMod,
  }

  self.__SMLN_WORKER__ = {
    version: VERSION,
    environment: 'worker',
    workerKind: detectKind(),
    sandkit: currentSandkit,
    game: currentApi,
    whenWorkerReady: whenWorkerReady,
    worker: workerApi,
    onGameMessage: onGameMessage,
    offGameMessage: offGameMessage,
    sendGameMessage: sendGameMessage,
    listeners: function () {
      var out = []
      for (var k in handlers) {
        var parts = k.split(' ')
        out.push({ modID: parts[0], channel: parts[1], count: handlers[k].length })
      }
      return out
    },
    stats: function () {
      return { received: stats.received, delivered: stats.delivered, buffered: buffered.length,
        dropped: stats.dropped, sent: stats.sent, refused: stats.refused }
    },
    log: log,
  }

  log('info', 'worker runtime v' + VERSION + ' installed (' + self.__SMLN_WORKER__.workerKind + ')')
})(typeof self !== 'undefined' ? self : this)
