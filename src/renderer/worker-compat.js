/* eslint-env worker */
'use strict'
/**
 * What Fluxloader worker mods actually reach for.
 *
 * They do not call Sandkit. `refinement/entry.worker.js` calls
 * `corelib.utils.getParticleNameFromNumber`, `corelib.simulation.setCell` and
 * `fluxloaderAPI.events.on` - and corelib builds that surface out of
 * `exposed.raw`, which two patches fill by capturing roughly 250 minified
 * identifiers by name. The one the worker half reads targets
 * `js/336.bundle.js`, a chunk Sandustry 0.5.6 no longer emits, so `raw` is
 * never populated and every call fails.
 *
 * corelib's own entry.worker.js is therefore not run at all - see the skip in
 * src/main/entry.js. It would die on its first line touching exposed.raw, and
 * its last line replaces globalThis.corelib, which would take this surface with
 * it. So this publishes `corelib` itself, with the methods reimplemented
 * against the game's own worker API: the same decision the renderer bridge made
 * when 75 of corelib's 92 anchors went stale.
 *
 * Anything without an equivalent is recorded and readable through
 * `SMLN.unsupported()`, so a player sees which mod wanted what instead of
 * meeting a silent no-op.
 */
;(function installWorkerCompat(self) {
  var SMLN = self.__SMLN_WORKER__
  if (!SMLN || self.corelib) return

  var unsupported = []
  function note(what, why) {
    unsupported.push({ call: what, reason: why })
    SMLN.log('warn', 'worker compat: ' + what + ' - ' + why)
  }

  function api() {
    var a = SMLN.game()
    if (!a) note('corelib', 'the worker API is not available yet')
    return a
  }

  var events = Object.create(null)

  function fire(name, payload, tolerant) {
    var list = events[name]
    if (!list) {
      if (!tolerant) {
        note('fluxloaderAPI.events.trigger("' + name + '")', 'no such event is registered')
      }
      return false
    }
    for (var i = 0; i < list.length; i++) {
      // One listener must not take the worker down, nor the listeners after it.
      try {
        list[i](payload)
      } catch (e) {
        SMLN.log('error', 'worker event "' + name + '" listener threw: ' + (e && e.message))
      }
    }
    return true
  }

  var fluxloaderAPI = {
    events: {
      registerEvent: function (name) { if (!events[name]) events[name] = [] },
      on: function (name, fn) {
        if (typeof fn !== 'function') return
        if (!events[name]) events[name] = []
        events[name].push(fn)
      },
      off: function (name, fn) {
        var list = events[name]
        if (!list) return
        var at = list.indexOf(fn)
        if (at !== -1) list.splice(at, 1)
      },
      trigger: function (name, payload) { return fire(name, payload, false) },
      tryTrigger: function (name, payload) { return fire(name, payload, true) },
      isEventRegistered: function (name) { return !!events[name] },
    },
  }

  var corelib = {
    // refinement assigns into this. It has no equivalent in the game's API, so
    // it exists to be assignable rather than to throw on the way in.
    blockRecipes: {},

    utils: {
      getParticleNameFromNumber: function (type) {
        var a = api()
        if (!a || !a.elements || typeof a.elements.getElementIdFromType !== 'function') return null
        try {
          return a.elements.getElementIdFromType(SMLN.state, type)
        } catch (e) {
          return null
        }
      },
      getCellAtPos: function (x, y) {
        var a = api()
        if (!a || !a.elements || typeof a.elements.getInfoAtPos !== 'function') return null
        try {
          return a.elements.getInfoAtPos(SMLN.state, x, y)
        } catch (e) {
          return null
        }
      },
    },

    simulation: {
      /*
       * corelib's setCell(x, y, type) means "put this element here", and type 0
       * means empty. The game splits that into createAt and removeAt.
       */
      setCell: function (x, y, type) {
        var a = api()
        if (!a || !a.elements) return false
        try {
          if (!type) return !!a.elements.removeAt(SMLN.state, x, y)
          return !!a.elements.createAt(SMLN.state, x, y, type)
        } catch (e) {
          note('corelib.simulation.setCell', (e && e.message) || 'the game refused the call')
          return false
        }
      },
      moveCell: function (fromX, fromY, toX, toY) {
        var a = api()
        if (!a || !a.elements || typeof a.elements.move !== 'function') return false
        try {
          return !!a.elements.move(SMLN.state, fromX, fromY, toX, toY)
        } catch (e) {
          note('corelib.simulation.moveCell', (e && e.message) || 'the game refused the call')
          return false
        }
      },
      createParticle: function (x, y, type) {
        var a = api()
        if (!a || !a.elements || typeof a.elements.createAt !== 'function') return false
        try {
          return !!a.elements.createAt(SMLN.state, x, y, type)
        } catch (e) {
          note('corelib.simulation.createParticle', (e && e.message) || 'the game refused the call')
          return false
        }
      },
    },
  }

  self.fluxloaderAPI = fluxloaderAPI
  self.corelib = corelib
  SMLN.unsupported = function () { return unsupported.slice() }

  // The API only answers once the game has published its state, so the event
  // corelib's dependents wait on fires then and not before.
  SMLN.whenWorkerReady(function () {
    fire('cl:raw-api-setup', undefined, true)
  })
})(typeof self !== 'undefined' ? self : this)
