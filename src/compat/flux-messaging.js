'use strict'
/**
 * The Fluxloader messaging and IPC surface, built on SandLoader's own plumbing.
 *
 * `src/compat/fluxloader.js` used to answer `sendGameMessage` /
 * `sendWorkerMessage` with a warning and a no-op. This file replaces that with
 * the real thing, and adds the rest of the Fluxloader IPC that SandLoader can
 * honestly support.
 *
 * Nothing here implements a transport. There are exactly two, both already
 * built:
 *
 *   game <-> worker   src/renderer/messaging.js + src/renderer/worker-runtime.js
 *   renderer <-> main SMLN.callMain over the game's preload log bridge, and
 *                     the main process's reply() executeJavaScript path
 *                     (src/main/entry.js)
 *
 * The shims below are thin adapters onto those. Adding a third IPC stack for
 * Fluxloader compatibility would mean three things to keep working across a
 * game update instead of two.
 */

/**
 * @typedef {Object} ElectronSurfaceCtx
 * @property {string} modId
 * @property {{info:Function,warn:Function,error:Function,debug:Function}} logger
 * @property {(action:string, payload:any) => void} sendToRenderer
 *           Fire-and-forget main -> renderer. Implemented in entry.js by
 *           evaluating a call to SMLN.__fluxEvent(action, payload) in the
 *           game window; the payload is JSON-encoded, never interpolated.
 * @property {{register:(action:string, handler:(payload:any)=>any)=>void}} rpc
 *           Registers an extra action on the existing renderer -> main RPC.
 */

/** Every registered action is namespaced so two mods cannot collide. */
function actionFor(modId, channel) {
  return 'flux:' + modId + ':' + channel
}

/**
 * Refuse a payload that will not survive the crossing, before it crosses.
 *
 * Deliberately not `try { JSON.stringify(v) }`: that only throws on cycles and
 * BigInt. A function or a Symbol is *silently* replaced with `null` (or
 * dropped from an object), so the mod's handler on the far side receives
 * quietly mangled arguments and the bug surfaces somewhere else entirely.
 * Walking the value and naming the offending path is the difference between a
 * one-line fix and an afternoon.
 *
 * @param {unknown} value
 * @param {unknown[]} [seen]
 * @param {string} [path]
 * @returns {string|null} a human reason, or null when the value is fine
 */
function checkSerialisable(value, seen, path) {
  seen = seen || []
  path = path || 'value'
  const t = typeof value
  if (value === null || t === 'boolean' || t === 'number' || t === 'string' || t === 'undefined') return null
  if (t === 'function') return `${path} is a function`
  if (t === 'symbol') return `${path} is a Symbol`
  if (t === 'bigint') return `${path} is a BigInt, which JSON cannot carry`
  if (value instanceof Date) return null
  if (seen.includes(value)) return `${path} is circular`
  seen.push(value)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const r = checkSerialisable(value[i], seen, `${path}[${i}]`)
      if (r) return r
    }
    seen.pop()
    return null
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return `${path} is not a plain object`
  for (const k of Object.keys(value)) {
    const r = checkSerialisable(value[k], seen, `${path}.${k}`)
    if (r) return r
  }
  seen.pop()
  return null
}

/**
 * Renderer-side `fluxloaderAPI` messaging, as source text for the environment
 * shim. Delegates to SMLN.messaging.as(modId) so the mod id is bound once and
 * a mod cannot read another mod's channels.
 * @param {string} modId
 * @returns {string}
 */
function gameShim(modId) {
  var id = JSON.stringify(modId)
  return `
var __smlnMsg = (S && S.messaging && typeof S.messaging.as === "function") ? S.messaging.as(${id}) : null;
function __smlnNoMessaging(name){
  return function(){
    console.warn("[SMLN] fluxloaderAPI." + name + "() is unavailable: SandLoader messaging did not install");
    return false;
  };
}
api.sendWorkerMessage = __smlnMsg
  ? function(channel){
      var r = __smlnMsg.sendWorkerMessage.apply(null, arguments);
      return !!(r && r.sent);
    }
  : __smlnNoMessaging("sendWorkerMessage");
api.listenWorkerMessage = __smlnMsg
  ? function(channel, handler){ return __smlnMsg.onWorkerMessage(channel, handler); }
  : __smlnNoMessaging("listenWorkerMessage");
api.removeWorkerMessageListener = __smlnMsg
  ? function(channel, handler){ return __smlnMsg.offWorkerMessage(channel, handler); }
  : __smlnNoMessaging("removeWorkerMessageListener");
// Fluxloader mods call these from the game context too when they want the
// main process; route them onto SandLoader's existing RPC.
api.invokeElectronIPC = function(channel){
  var args = [].slice.call(arguments, 1);
  if (!S || typeof S.callMain !== "function") return Promise.resolve(null);
  return S.callMain(${JSON.stringify('flux:' + modId + ':')} + channel, { args: args })
    .then(function(r){ return r && r.ok ? r.value : null; });
};
api.sendElectronEvent = api.invokeElectronIPC;
// main -> renderer events arrive through SMLN.__fluxEvent; see entry.js.
api.listenElectronEvent = function(name, handler){
  return S && S.on ? S.on(${JSON.stringify('flux:' + modId + ':')} + name, handler) : function(){};
};
`
}

/**
 * Worker-side `fluxloaderAPI` messaging, as source text. Delegates to
 * `self.__SMLN_WORKER__`, which the interceptor installs ahead of the game's
 * worker code.
 * @param {string} modId
 * @returns {string}
 */
function workerShim(modId) {
  var id = JSON.stringify(modId)
  return `
var __smlnW = g.__SMLN_WORKER__ || null;
function __smlnNoWorker(name){
  return function(){
    console.warn("[SMLN] fluxloaderAPI." + name + "() is unavailable: the SandLoader worker runtime did not install");
    return false;
  };
}
api.sendGameMessage = __smlnW
  ? function(channel){
      var args = [${id}, channel].concat([].slice.call(arguments, 1));
      return __smlnW.sendGameMessage.apply(null, args);
    }
  : __smlnNoWorker("sendGameMessage");
api.listenGameMessage = __smlnW
  ? function(channel, handler){ return __smlnW.onGameMessage(${id}, channel, handler); }
  : __smlnNoWorker("listenGameMessage");
api.removeGameMessageListener = __smlnW
  ? function(channel, handler){ return __smlnW.offGameMessage(${id}, channel, handler); }
  : __smlnNoWorker("removeGameMessageListener");
`
}

/**
 * The electron-environment half: what a Fluxloader mod's electronEntrypoint
 * sees on `fluxloaderAPI`. Runs in the main process, so this is plain objects
 * rather than source text.
 *
 * @param {ElectronSurfaceCtx} ctx
 * @returns {Object}
 */
function electronSurface(ctx) {
  const modId = ctx.modId
  const logger = ctx.logger
  /** channel -> handler, for the renderer -> main direction. */
  const gameHandlers = new Map()

  function guard(channel, handler, kind) {
    return (payload) => {
      try {
        const args = (payload && Array.isArray(payload.args)) ? payload.args : []
        return handler(...args)
      } catch (e) {
        // One mod's bad handler must not take down the RPC listener that every
        // other mod and the mod manager share.
        logger.error(`${kind} handler "${channel}" threw: ${e && e.message}`)
        return { __error: (e && e.message) || String(e) }
      }
    }
  }

  return {
    /** main -> renderer, fire and forget. */
    sendGameEvent(name, ...args) {
      const problem = checkSerialisable(args)
      if (problem) {
        logger.warn(`sendGameEvent("${name}") refused: ${problem}`)
        return false
      }
      try {
        ctx.sendToRenderer('flux:' + modId + ':' + name, args)
        return true
      } catch (e) {
        logger.error(`sendGameEvent("${name}") failed: ${e && e.message}`)
        return false
      }
    },

    /**
     * Fluxloader's name for "handle an event coming from the game". Same
     * direction as handleGameIPC; kept as a separate name because mods use
     * both, and aliasing them silently would hide a typo rather than fix it.
     */
    handleElectronEvent(name, handler) {
      if (typeof handler !== 'function') {
        logger.warn(`handleElectronEvent("${name}") ignored: handler is not a function`)
        return () => {}
      }
      gameHandlers.set(name, handler)
      ctx.rpc.register(actionFor(modId, name), guard(name, handler, 'electron event'))
      logger.debug(`electron event handler registered: ${name}`)
      return () => gameHandlers.delete(name)
    },

    /** renderer -> main, awaited. Same channel space as handleGameIPC. */
    handleGameIPC(channel, handler) {
      if (typeof handler !== 'function') {
        logger.warn(`handleGameIPC("${channel}") ignored: handler is not a function`)
        return () => {}
      }
      gameHandlers.set(channel, handler)
      ctx.rpc.register(actionFor(modId, channel), guard(channel, handler, 'game IPC'))
      logger.debug(`game IPC handler registered: ${channel}`)
      return () => gameHandlers.delete(channel)
    },

    /**
     * main -> main-ish: Fluxloader exposes this for a mod's electron half to
     * call into the host. SandLoader has no second main process to call, so
     * this resolves against the mod's own registered handlers and says so
     * plainly when there is none - a silent null would look like a hang.
     */
    invokeElectronIPC(channel, ...args) {
      const handler = gameHandlers.get(channel)
      if (!handler) {
        logger.warn(`invokeElectronIPC("${channel}"): no handler is registered for it`)
        return Promise.resolve(null)
      }
      try {
        return Promise.resolve(handler(...args))
      } catch (e) {
        logger.error(`invokeElectronIPC("${channel}") threw: ${e && e.message}`)
        return Promise.resolve(null)
      }
    },

    /** Diagnostics for the log and the self-test. */
    _channels() { return [...gameHandlers.keys()] },
  }
}

module.exports = { gameShim, workerShim, electronSurface, actionFor, checkSerialisable }
