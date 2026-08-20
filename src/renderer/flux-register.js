/* eslint-env browser */
'use strict'
/**
 * Registers Fluxloader mod content with the running game.
 *
 * The main process captured what corelib's mods registered and translated it
 * into 0.5.5 shape (see src/compat/flux-content.js). Sandkit lives here in the
 * renderer, so this is where the definitions are actually handed over -
 * through SMLN.register, which already queues until the game is ready,
 * attributes failures to a mod and isolates one bad definition from the rest.
 *
 * This is the half of the bridge that could not live in the main process: the
 * simulation runs across 18 worker threads, each with its own copy of the
 * element registry, and only the game's own registration path reaches all of
 * them. Mutating a registry object here would reach none.
 */
;(function installFluxContentBridge(global) {
  var SMLN = global.__SMLN__
  if (!SMLN || !SMLN.register || SMLN.__fluxContentInstalled) return
  SMLN.__fluxContentInstalled = true

  SMLN.whenReady(function () {
    if (typeof SMLN.callMain !== 'function') return
    SMLN.callMain('smln:flux-content').then(function (reply) {
      // callMain wraps a handler's return value in an {ok, value} envelope, as
      // every other caller here unwraps (see hotreload.js). Reading the payload
      // straight off the reply finds undefined everywhere and registers
      // nothing, silently - which is exactly what it did before this line.
      if (!reply) return
      var payload = reply && reply.ok !== undefined ? reply.value : reply
      if (!payload) {
        if (reply && reply.ok === false) {
          SMLN.log('error', 'fluxloader content bridge: ' +
            (reply.error || 'the main process refused the request'))
        }
        return
      }
      var api = SMLN.register.as('corelib')
      var elements = payload.elements || []
      var soils = payload.soils || []
      var unsupported = payload.unsupported || []

      function hand(entry, register, kind) {
        // One definition failing must not take the others with it: a mod that
        // registers five elements and gets one wrong should lose that one.
        try {
          register(entry.def).then(function () {
            SMLN.log('info', 'fluxloader ' + kind + ' registered: ' + entry.id)
          }, function (e) {
            SMLN.log('error', 'fluxloader ' + kind + ' "' + entry.id + '" failed: ' +
              ((e && e.message) || e))
          })
        } catch (e) {
          SMLN.log('error', 'fluxloader ' + kind + ' "' + entry.id + '" threw: ' +
            ((e && e.message) || e))
        }
      }

      for (var i = 0; i < elements.length; i++) {
        hand(elements[i], api.element, 'element')
      }

      // Soils are mineable terrain in Sandustry's model, not elements.
      for (var j = 0; j < soils.length; j++) {
        hand(soils[j], api.terrain, 'soil')
      }

      // Say what could not be done and why, rather than leaving the player to
      // discover the missing content in-game. On 0.5.5 this is every recipe a
      // mod declared: the build has no recipe registry to put them in.
      for (var k = 0; k < unsupported.length; k++) {
        var u = unsupported[k]
        SMLN.log('warn', 'fluxloader ' + u.kind + ' "' + u.id +
          '" was not registered: ' + u.reason)
      }
    }, function (e) {
      SMLN.log('error', 'fluxloader content bridge failed: ' + ((e && e.message) || e))
    })
  })
})(typeof globalThis !== 'undefined' ? globalThis : self)
