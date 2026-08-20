/* eslint-env browser */
'use strict'
/**
 * Game-side half of SandLoader's cross-context messaging.
 *
 * The mirror of src/renderer/worker-runtime.js; read that file's header for
 * why the transport is an added `message` listener carrying a plain-object
 * envelope, and why neither can collide with Sandustry's own worker protocol.
 *
 * Verified worker layout (0.5.4 bundle, the object `setHandlers` operates on):
 *
 *   state.environment.multithreading.simulation = {
 *     manager:   Worker,                    // js/manager-worker.js
 *     utility:   Worker,                    // js/utility-worker.js
 *     threads:   [ { worker: Worker, meta } ],  // js/simulation-worker.js
 *     ...
 *   }
 *
 * The three are treated deliberately differently:
 *
 *   simulation threads - the default target. This is the only place worker
 *                        mod source is injected, so it is the only place a
 *                        mod's handler can exist. A message goes to every
 *                        thread; the mod decides whether it cares which.
 *   manager            - reachable, but only when asked for explicitly.
 *   utility            - not a mod target. It is the save thread; a mod
 *                        message arriving mid-save has nothing to gain and a
 *                        stalled save to lose. No worker mod code is injected
 *                        there either, so nothing would receive it anyway.
 *
 * The workers do not exist when this file runs - the game builds them during
 * startup - so attachment is retried until it succeeds and then stops.
 */
;(function installSmlnMessaging(global) {
  var SMLN = global.__SMLN__
  if (!SMLN || SMLN.messaging) return

  var ENVELOPE = '__smln'
  var PROTOCOL = 1
  var ATTACH_RETRY_MS = 500
  var ATTACH_MAX_TRIES = 60

  /** "modId channel" -> handler[] */
  var handlers = Object.create(null)
  /** Worker handles we have already attached to. */
  var attached = typeof WeakSet === 'function' ? new WeakSet() : null
  var attachedFallback = []
  var targets = { threads: [], manager: null, utility: null }
  var seq = 0
  var tries = 0
  var attachTimer = null
  var stats = { attached: 0, sent: 0, received: 0, delivered: 0, dropped: 0, refused: 0 }

  function key(modID, channel) { return modID + ' ' + channel }

  function isAttached(worker) {
    if (attached) return attached.has(worker)
    return attachedFallback.indexOf(worker) >= 0
  }

  function markAttached(worker) {
    if (attached) attached.add(worker)
    else attachedFallback.push(worker)
  }

  // ------------------------------------------------------- payload checking
  /** Same contract as the worker side; see worker-runtime.js. */
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

  // ------------------------------------------------------------- attachment
  function collectTargets() {
    var s = SMLN.getState()
    var sim = s && s.environment && s.environment.multithreading && s.environment.multithreading.simulation
    if (!sim) return false
    targets.manager = sim.manager || null
    targets.utility = sim.utility || null
    targets.threads = []
    var list = sim.threads || []
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].worker) targets.threads.push(list[i].worker)
    }
    return !!(targets.threads.length || targets.manager)
  }

  function onWorkerMessage(event) {
    var data = event && event.data
    var problem = validEnvelope(data)
    if (problem === null) return          // the game's own traffic
    if (problem) { stats.dropped++; SMLN.log('warn', 'messaging: dropped an envelope - ' + problem); return }

    stats.received++
    var list = handlers[key(data.modID, data.channel)]
    if (!list || !list.length) {
      // Not buffered on this side on purpose: the game half of a mod is
      // loaded before the workers exist, so a handler that is going to be
      // registered already has been. A message with no listener here is a
      // mod bug, and saying so beats hiding it in a queue.
      SMLN.log('warn', 'messaging: no game handler for ' + data.modID + '/' + data.channel)
      stats.dropped++
      return
    }
    for (var i = 0; i < list.length; i++) {
      try { list[i].apply(null, data.args) }
      catch (e) { SMLN.log('error', 'messaging: handler for ' + data.modID + '/' + data.channel + ' threw: ' + (e && e.message), e && e.stack) }
    }
    stats.delivered++
  }

  function attach() {
    if (!collectTargets()) return false
    var all = targets.threads.slice()
    if (targets.manager) all.push(targets.manager)
    var added = 0
    for (var i = 0; i < all.length; i++) {
      var w = all[i]
      if (!w || isAttached(w) || typeof w.addEventListener !== 'function') continue
      // Additive: the game sets `worker.onmessage = fn` and both fire.
      w.addEventListener('message', onWorkerMessage)
      markAttached(w)
      added++
    }
    if (added) {
      stats.attached += added
      SMLN.log('info', 'messaging attached to ' + added + ' worker(s) (' +
        targets.threads.length + ' simulation, ' + (targets.manager ? '1 manager' : 'no manager') + ')')
    }
    return true
  }

  function scheduleAttach() {
    if (attachTimer) return
    attachTimer = global.setInterval(function () {
      tries++
      if (attach() || tries >= ATTACH_MAX_TRIES) {
        global.clearInterval(attachTimer)
        attachTimer = null
        if (tries >= ATTACH_MAX_TRIES && !stats.attached) {
          SMLN.log('warn', 'messaging: no simulation worker appeared after ' +
            ((ATTACH_MAX_TRIES * ATTACH_RETRY_MS) / 1000) + 's - worker messaging is unavailable')
        }
      }
    }, ATTACH_RETRY_MS)
  }

  SMLN.on('ready', function () { if (!attach()) scheduleAttach() })

  // ---------------------------------------------------------------- sending
  function post(workerList, modID, channel, args, label) {
    var problem = serialisable(args)
    if (problem) {
      stats.refused++
      SMLN.log('warn', 'messaging: refused to send ' + modID + '/' + channel + ' - ' + problem)
      return { sent: 0, refused: true, reason: problem }
    }
    attach()
    if (!workerList.length) {
      SMLN.log('warn', 'messaging: nothing to send ' + modID + '/' + channel + ' to - no ' + label + ' worker is reachable yet')
      return { sent: 0, refused: false, reason: 'no ' + label + ' worker' }
    }
    var envelope = {
      v: PROTOCOL,
      type: 'flux-message',
      dir: 'game->worker',
      modID: modID,
      channel: channel,
      args: args,
      seq: ++seq,
    }
    envelope[ENVELOPE] = true
    var sent = 0
    for (var i = 0; i < workerList.length; i++) {
      try { workerList[i].postMessage(envelope); sent++ }
      catch (e) { SMLN.log('error', 'messaging: postMessage failed - ' + (e && e.message)) }
    }
    stats.sent += sent
    return { sent: sent, refused: false }
  }

  function sendWorkerMessage(modID, channel) {
    return post(targets.threads, modID, channel, [].slice.call(arguments, 2), 'simulation')
  }

  function sendManagerMessage(modID, channel) {
    return post(targets.manager ? [targets.manager] : [], modID, channel, [].slice.call(arguments, 2), 'manager')
  }

  function onMessage(modID, channel, handler) {
    if (typeof handler !== 'function') return function () {}
    var k = key(modID, channel)
    ;(handlers[k] || (handlers[k] = [])).push(handler)
    return function off() {
      var list = handlers[k]
      if (!list) return
      var i = list.indexOf(handler)
      if (i >= 0) list.splice(i, 1)
    }
  }

  function offMessage(modID, channel, handler) {
    var list = handlers[key(modID, channel)]
    if (!list) return false
    var i = list.indexOf(handler)
    if (i < 0) return false
    list.splice(i, 1)
    return true
  }

  /**
   * The recommended form. Binding the mod id here is what keeps two mods from
   * reading each other's channels: the id is not a parameter the mod supplies
   * per call, so `listenWorkerMessage("tick")` in mod A cannot see mod B's
   * "tick". `book` is the capability facade's bookkeeping, so hot reload can
   * unsubscribe everything this mod registered.
   */
  function as(modID, book) {
    return {
      modID: modID,
      sendWorkerMessage: function (channel) {
        var args = [modID, channel].concat([].slice.call(arguments, 1))
        return sendWorkerMessage.apply(null, args)
      },
      sendManagerMessage: function (channel) {
        var args = [modID, channel].concat([].slice.call(arguments, 1))
        return sendManagerMessage.apply(null, args)
      },
      onWorkerMessage: function (channel, handler) {
        var off = onMessage(modID, channel, handler)
        if (book && book.messaging) book.messaging.push(off)
        return off
      },
      offWorkerMessage: function (channel, handler) { return offMessage(modID, channel, handler) },
    }
  }

  SMLN.messaging = {
    sendWorkerMessage: sendWorkerMessage,
    sendManagerMessage: sendManagerMessage,
    onWorkerMessage: onMessage,
    offWorkerMessage: offMessage,
    as: as,
    attach: attach,
    targets: function () {
      return {
        simulation: targets.threads.length,
        manager: !!targets.manager,
        utility: !!targets.utility,
        attachedCount: stats.attached,
      }
    },
    stats: function () {
      return { attached: stats.attached, sent: stats.sent, received: stats.received,
        delivered: stats.delivered, dropped: stats.dropped, refused: stats.refused }
    },
  }

  SMLN.log('info', 'messaging installed, waiting for workers')
})(typeof globalThis !== 'undefined' ? globalThis : window)
