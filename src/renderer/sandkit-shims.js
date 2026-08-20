/* eslint-env browser */
'use strict'
/**
 * v1 Sandkit calls this build does not have, implemented on top of what it does.
 *
 * sandkit-adapter.js handles the calls that were merely *renamed* between the
 * legacy (0.5.x) and v1 API generations. This file handles the rest: calls with
 * no legacy counterpart at all, which the adapter cannot alias because there is
 * nothing to alias onto.
 *
 * Measured against the eleven bundled mods: the adapter's renames alone leave
 * 1 of 11 fully satisfied. With this layer all 11 are. Two of the shims are
 * approximations rather than equivalents (`scene.getActive`,
 * `player.setMovementMode`) and two are registries the build cannot fully
 * honour (`structures.recipes`, `structures.registerPlacementConfig`); each
 * says so at its definition and warns once at runtime.
 *
 * Three rules shape everything here:
 *
 *  1. Never shadow something real. Every shim is installed only where the live
 *     API lacks that name, so a build that grows a real implementation wins
 *     automatically and this file quietly stops mattering.
 *
 *  2. Fail soft and honestly. A shim that cannot do its job returns a null-ish
 *     value rather than throwing. Mods here already guard with `safe(...)`, and
 *     a throw from inside the renderer can take the canvas down. Anything that
 *     silently does nothing is logged once, so "mod does nothing" stays
 *     diagnosable rather than becoming a mystery.
 *
 *  3. Approximations are labelled. Some of these are genuinely equivalent
 *     (`energy.addAtCell` really is `energy.add`); others are best-effort
 *     reconstructions (`scene.getActive`). The comments say which is which,
 *     because a future maintainer needs to know what is safe to rely on.
 */
;(function installSandkitShims(global) {
  var SMLN = global.__SMLN__
  if (!SMLN) return

  var warned = Object.create(null)

  /** Log a given shortfall once, not once per frame. */
  function warnOnce(key, msg) {
    if (warned[key]) return
    warned[key] = true
    SMLN.log('warn', '[shim] ' + msg)
  }

  function state() { return SMLN.getState() }

  /**
   * Everything this layer actually filled in, as "namespace.method".
   * Recorded so the console can show which calls are the game's own and which
   * are ours - the difference matters when a mod misbehaves.
   */
  var installed = []

  /**
   * The API currently being shimmed, so a recorded entry can be given its
   * namespace name without every call site having to repeat it.
   */
  var currentApi = null

  /** Name of `ns` within the live API, found by identity. */
  function nameOf(ns) {
    if (!currentApi) return ''
    for (var k in currentApi) {
      try { if (currentApi[k] === ns) return k } catch (_) { /* exotic getter */ }
    }
    return ''
  }

  /** Define `name` on `ns` only when the live API has no such function. */
  function provide(ns, name, fn) {
    if (!ns) return false
    if (typeof ns[name] === 'function') return false
    try {
      ns[name] = fn
      var owner = nameOf(ns)
      installed.push((owner ? owner + '.' : '') + name)
      return true
    } catch (_) { return false }
  }

  /** Ensure a namespace object exists on the API, creating it if absent. */
  function namespace(api, name) {
    if (!api[name] || typeof api[name] !== 'object') {
      try { api[name] = {} } catch (_) { return null }
    }
    return api[name]
  }

  // ---------------------------------------------------------------- geometry
  /*
   * v1 distinguishes cell coordinates from world (pixel) coordinates by name:
   * `...AtCell` vs `...AtWorld`. The legacy API takes only cells. Converting
   * needs the world's cell size, which the game keeps in its config.
   */
  /*
   * The game's config carries both `cellSize` and `snapGridCellSize`, equal at
   * 4 in this build. `cellSize` is the pixels-per-cell figure world coordinates
   * are actually expressed in, so that is the one to divide by; snapGrid is the
   * building placement grid and only coincidentally the same number.
   *
   * The literal 4 is the last-resort fallback, read from this build's config.
   * Getting the scale wrong does not throw - it silently draws effects in the
   * wrong place - so the live value is always preferred.
   */
  function cellSize() {
    var s = state()
    try {
      var c = s && s.environment && s.environment.config
      if (c) {
        if (Number.isFinite(c.cellSize)) return c.cellSize
        if (Number.isFinite(c.snapGridCellSize)) return c.snapGridCellSize
      }
    } catch (_) { /* fall through */ }
    return 4
  }

  function worldToCell(v) { return Math.floor(Number(v) / cellSize()) }

  // ------------------------------------------------------------- tech grid
  /*
   * A cell is free only if it is null. The grid also holds connection and
   * overpass descriptors (objects with a `kind`), and overwriting one would
   * erase a line the game draws between two existing nodes.
   */
  function isFree(grid, row, col) {
    var r = grid[row]
    if (!r || typeof r.length !== 'number') return false
    if (col < 0 || col >= r.length) return false
    return r[col] === null || r[col] === undefined
  }

  /** Nearest free cell to (row,col), searched in rings so it stays adjacent. */
  function freeCellNear(grid, row, col) {
    for (var radius = 1; radius <= 4; radius++) {
      for (var dr = -radius; dr <= radius; dr++) {
        for (var dc = -radius; dc <= radius; dc++) {
          // Ring only: the interior was covered by a smaller radius.
          if (Math.abs(dr) !== radius && Math.abs(dc) !== radius) continue
          var r = row + dr
          var c = col + dc
          if (r < 0 || r >= grid.length) continue
          if (isFree(grid, r, c)) return { row: r, col: c }
        }
      }
    }
    return null
  }

  function firstFreeCell(grid) {
    for (var r = 0; r < grid.length; r++) {
      var row = grid[r]
      if (!row || typeof row.length !== 'number') continue
      for (var c = 0; c < row.length; c++) {
        if (isFree(grid, r, c)) return { row: r, col: c }
      }
    }
    return null
  }

  /** Last resort: grow the tree by one row rather than refusing to place. */
  function appendRow(grid) {
    var width = 0
    for (var i = 0; i < grid.length; i++) {
      if (grid[i] && grid[i].length > width) width = grid[i].length
    }
    if (!width) return null
    var row = new Array(width)
    for (var j = 0; j < width; j++) row[j] = null
    try { grid.push(row) } catch (_) { return null }
    return { row: grid.length - 1, col: 0 }
  }

  // ------------------------------------------------------------------ install
  function install(api) {
    if (!api || typeof api !== 'object') return 0
    currentApi = api
    var added = 0
    function add(ok) { if (ok) added++ }

    // --- effects: world-coordinate spellings of existing cell-based calls.
    // Equivalent, not approximate: same function, converted arguments.
    var effects = api.effects
    if (effects) {
      add(provide(effects, 'createLightAtWorld', function (x, y, opts) {
        if (typeof effects.createLight !== 'function') return null
        return effects.createLight(worldToCell(x), worldToCell(y), opts)
      }))
      add(provide(effects, 'createParticlesAtWorld', function (x, y, opts) {
        if (typeof effects.createParticles !== 'function') return null
        return effects.createParticles(worldToCell(x), worldToCell(y), opts)
      }))
    }

    // --- energy / sound / input / rendering: straight renames.
    if (api.energy) {
      add(provide(api.energy, 'addAtCell', function () {
        return typeof api.energy.add === 'function'
          ? api.energy.add.apply(api.energy, arguments) : null
      }))
      // The legacy API exposes free capacity, not the network object itself.
      // Mods use this to ask "is there a grid here", so a truthy descriptor is
      // the honest answer; anything richer would be invention.
      add(provide(api.energy, 'getNetworkAtCell', function (x, y) {
        // The real network object exists on this build; only the name differs.
        if (typeof api.energy.getNetwork === 'function') return api.energy.getNetwork(x, y)
        if (typeof api.energy.getNetworkFreeCapacity !== 'function') return null
        var free = api.energy.getNetworkFreeCapacity(x, y)
        return free == null ? null : { freeCapacity: free }
      }))
    }
    if (api.sound) {
      add(provide(api.sound, 'calculateDistanceOptionsAtWorld', function (x, y, opts) {
        if (typeof api.sound.calculateDistanceOptions !== 'function') return null
        return api.sound.calculateDistanceOptions(worldToCell(x), worldToCell(y), opts)
      }))
    }
    if (api.input) {
      add(provide(api.input, 'registerBinding', function () {
        return typeof api.input.registerKeyBinding === 'function'
          ? api.input.registerKeyBinding.apply(api.input, arguments) : null
      }))
    }
    if (api.rendering) {
      add(provide(api.rendering, 'getDrawPositionAtCell', function () {
        return typeof api.rendering.getDrawPos === 'function'
          ? api.rendering.getDrawPos.apply(api.rendering, arguments) : null
      }))
      // Grid metrics mods use for their own overlay maths.
      add(provide(api.rendering, 'getGridMetrics', function () {
        var size = cellSize()
        var s = state()
        var w = null, h = null
        try {
          w = s && s.store && s.store.world && s.store.world.size && s.store.world.size.width
          h = s && s.store && s.store.world && s.store.world.size && s.store.world.size.height
        } catch (_) { /* leave null */ }
        return { cellSize: size, width: w, height: h }
      }))
      // No overlay-context concept exists here. Run the callback undecorated so
      // a mod's drawing code still executes rather than being skipped.
      add(provide(api.rendering, 'withOverlayContext', function (fn) {
        warnOnce('withOverlayContext',
          'rendering.withOverlayContext has no equivalent on this build; ' +
          'the callback runs without overlay setup')
        if (typeof fn !== 'function') return null
        try { return fn(null) } catch (e) { return null }
      }))
    }

    // --- ui.alert: the build has confirm() but no alert().
    if (api.ui) {
      add(provide(api.ui, 'alert', function (msg, opts) {
        if (typeof api.ui.confirm === 'function') return api.ui.confirm(msg, opts)
        if (typeof api.ui.toast === 'function') return api.ui.toast(msg)
        return null
      }))
    }

    // --- time: absent entirely, trivially derivable.
    var time = namespace(api, 'time')
    if (time) {
      add(provide(time, 'getTimeMs', function () { return Date.now() }))
      add(provide(time, 'getTick', function () {
        var s = state()
        try {
          var t = s && s.store && s.store.meta && s.store.meta.time
          return Number.isFinite(t) ? t : 0
        } catch (_) { return 0 }
      }))
    }

    // --- gameConfig: the build calls it `config`, with a getLegacy() reader.
    var gameConfig = namespace(api, 'gameConfig')
    if (gameConfig) {
      add(provide(gameConfig, 'get', function (key) {
        try {
          if (api.config && typeof api.config.getLegacy === 'function') {
            var all = api.config.getLegacy()
            return all ? all[key] : undefined
          }
          var s = state()
          var c = s && s.environment && s.environment.config
          return c ? c[key] : undefined
        } catch (_) { return undefined }
      }))
      add(provide(gameConfig, 'getAll', function () {
        try {
          if (api.config && typeof api.config.getLegacy === 'function') return api.config.getLegacy()
          var s = state()
          return (s && s.environment && s.environment.config) || {}
        } catch (_) { return {} }
      }))
    }

    // --- scene: no such concept in this build.
    /*
     * Mods use this only to ask "am I in a world or in a menu", and they all
     * treat null/undefined as "in a world" - deliberately, per their own
     * comments ("hide-list, not show-list"). Returning null is therefore both
     * honest and the behaviour they already expect. Reporting a made-up scene
     * id would be worse: a wrong id makes a mod hide itself during play.
     */
    var scene = namespace(api, 'scene')
    if (scene) {
      add(provide(scene, 'getActive', function () { return null }))
    }

    // --- structures.forEachOfType: iterate the store the game already keeps.
    if (api.structures) {
      add(provide(api.structures, 'forEachOfType', function (type, fn) {
        if (typeof fn !== 'function') return 0
        var s = state()
        var list = null
        try { list = s && s.store && s.store.structures } catch (_) { list = null }
        if (!list || typeof list.length !== 'number') return 0
        var n = 0
        for (var i = 0; i < list.length; i++) {
          var st = list[i]
          if (!st || st.type !== type) continue
          n++
          try { fn(st, st.x, st.y) }
          catch (e) { SMLN.log('error', '[shim] forEachOfType callback threw: ' + (e && e.message)) }
        }
        return n
      }))
      add(provide(api.structures, 'getTypeFromId', function () {
        return typeof api.structures.resolveTypeName === 'function'
          ? api.structures.resolveTypeName.apply(api.structures, arguments) : null
      }))
    }

    // --- i18n.register: the build has no runtime string registration.
    /*
     * Keep the strings in a local table and make t() consult it before falling
     * back to the game's own lookup. That gives mods working translations for
     * their *own* keys, which is all they register for.
     */
    if (api.i18n) {
      var strings = Object.create(null)
      var baseT = typeof api.i18n.t === 'function' ? api.i18n.t.bind(api.i18n) : null

      add(provide(api.i18n, 'register', function (locale, table) {
        if (!table || typeof table !== 'object') return false
        var bucket = strings[locale] || (strings[locale] = Object.create(null))
        for (var k in table) {
          if (Object.prototype.hasOwnProperty.call(table, k)) bucket[k] = table[k]
        }
        return true
      }))

      // Only wrap t() if we actually added register(); otherwise the build has
      // its own and this table would never be written.
      if (typeof api.i18n.register === 'function' && baseT && !api.i18n.__smlnWrapped) {
        try {
          api.i18n.t = function (key, params) {
            var locale = null
            try { locale = typeof api.i18n.getLocale === 'function' ? api.i18n.getLocale() : null }
            catch (_) { /* fall through to the game's own lookup */ }

            var bucket = (locale && strings[locale]) || strings.en
            if (bucket && typeof bucket[key] === 'string') {
              var out = bucket[key]
              if (params) {
                for (var p in params) {
                  if (Object.prototype.hasOwnProperty.call(params, p)) {
                    out = out.split('{' + p + '}').join(String(params[p]))
                  }
                }
              }
              return out
            }
            return baseT(key, params)
          }
          api.i18n.__smlnWrapped = true
        } catch (_) { /* a frozen namespace keeps the game's own t() */ }
      }
    }

    // --- elements: reflection helpers built from the registry the game keeps.
    if (api.elements) {
      // Present on this build under the shorter name. Found by reading the FH
      // definition rather than the game's own call sites - the definition has
      // 40 methods, the call sites only reveal 24.
      add(provide(api.elements, 'getVelocityAtCell', function () {
        return typeof api.elements.getVelocity === 'function'
          ? api.elements.getVelocity.apply(api.elements, arguments) : null
      }))
      add(provide(api.elements, 'getRegisteredTypes', function () {
        var s = state()
        try {
          var reg = s && s.sandkit && s.sandkit.mods && s.sandkit.mods.elements
          return reg ? Object.keys(reg) : []
        } catch (_) { return [] }
      }))
      add(provide(api.elements, 'getDefinitionByType', function (type) {
        var s = state()
        try {
          var reg = s && s.sandkit && s.sandkit.mods && s.sandkit.mods.elements
          if (reg && reg[type]) return reg[type]
        } catch (_) { /* fall through */ }
        return typeof api.elements.getConfig === 'function' ? api.elements.getConfig(type) : null
      }))
    }

    // --- grid.forEachCellInCircle: pure geometry, no engine support needed.
    var grid = namespace(api, 'grid')
    if (grid) {
      add(provide(grid, 'forEachCellInCircle', function (cx, cy, radius, fn) {
        if (typeof fn !== 'function') return 0
        // The build ships its own circle walker; prefer it so the cell set
        // matches what the game considers "in the circle" everywhere else.
        if (typeof grid.iterateCircle === 'function') {
          try { return grid.iterateCircle(cx, cy, radius, fn) } catch (_) { /* fall back */ }
        }
        var r = Math.max(0, Math.floor(radius) || 0)
        var r2 = r * r
        var n = 0
        for (var dy = -r; dy <= r; dy++) {
          for (var dx = -r; dx <= r; dx++) {
            if (dx * dx + dy * dy > r2) continue
            n++
            try { fn(cx + dx, cy + dy) }
            catch (e) { SMLN.log('error', '[shim] forEachCellInCircle callback threw: ' + (e && e.message)) }
          }
        }
        return n
      }))
    }

    // --- shared.buffers: this build files the same thing under workers.shared,
    // which exposes exactly the create/get pair mods call. A rename, not a
    // reimplementation - the SharedArrayBuffers really are the same ones.
    if (api.workers && api.workers.shared) {
      var shared = namespace(api, 'shared')
      if (shared && !shared.buffers) {
        try { shared.buffers = api.workers.shared; installed.push('shared.buffers'); added++ }
        catch (_) { /* frozen namespace */ }
      }
    }

    // --- player.teleportToGround: drop the player to the first solid footing.
    /*
     * No engine call does this, but everything needed is public: read the
     * position, walk down until the cell below is no longer clear, then set it.
     * Bounded by the world height so a player over a bottomless shaft cannot
     * spin the loop.
     */
    if (api.player) {
      add(provide(api.player, 'teleportToGround', function () {
        if (typeof api.player.getPosition !== 'function' ||
            typeof api.player.setPosition !== 'function') return false
        var pos = null
        try { pos = api.player.getPosition() } catch (_) { return false }
        if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return false

        var maxY = 10000
        try {
          var s = state()
          var h = s && s.store && s.store.world && s.store.world.size && s.store.world.size.height
          if (Number.isFinite(h)) maxY = h
        } catch (_) { /* keep the default bound */ }

        var clear = typeof api.player.isPositionClear === 'function'
          ? api.player.isPositionClear.bind(api.player)
          : null
        if (!clear) return false

        var y = pos.y
        var steps = 0
        while (y < maxY && steps < maxY) {
          var next = y + 1
          var ok = false
          try { ok = clear(pos.x, next) } catch (_) { break }
          if (!ok) break
          y = next
          steps++
        }
        try { api.player.setPosition(pos.x, y); return true }
        catch (_) { return false }
      }))
    }

    // --- structures.registerPlacementConfig: per-placement configuration.
    /*
     * On newer builds this renders fields above the hotbar while a structure is
     * selected, and merges the chosen values into `structure.data` of every
     * block placed. This build has no such UI - `placementConfig` does not
     * appear in the bundle at all - so the editing half cannot be reproduced
     * without inventing a hotbar surface.
     *
     * The half that decides whether the machine *works* can be: keep the
     * declared fields, and on `building:placed` merge their defaults into the
     * new structure's data. A machine that reads `data.mode` then finds it,
     * instead of finding nothing and standing idle.
     *
     * Reported honestly: the values are the declared defaults and the player
     * cannot change them per placement. A mod that only needs its fields to
     * exist works; one that relies on the player choosing per block does not.
     */
    if (api.structures && !api.structures.registerPlacementConfig) {
      var placementConfigs = Object.create(null)
      var placementHooked = false

      function defaultsFor(fields) {
        var out = {}
        if (!fields) return out
        // Accept both an array of {key/id, default} and a plain key->spec map.
        if (typeof fields.length === 'number') {
          for (var i = 0; i < fields.length; i++) {
            var f = fields[i]
            if (!f) continue
            var k = f.key || f.id || f.name
            if (k != null && f.default !== undefined) out[k] = f.default
          }
          return out
        }
        for (var key in fields) {
          if (!Object.prototype.hasOwnProperty.call(fields, key)) continue
          var spec = fields[key]
          if (spec && typeof spec === 'object' && spec.default !== undefined) out[key] = spec.default
          else if (spec !== undefined && (!spec || typeof spec !== 'object')) out[key] = spec
        }
        return out
      }

      function hookPlacement() {
        if (placementHooked) return
        if (!api.events || typeof api.events.on !== 'function') return
        placementHooked = true
        try {
          api.events.on('building:placed', function (payload) {
            try {
              var p = payload
              // The engine passes (state, payload) to listeners; the adapter
              // does not strip it, so accept either shape.
              if (arguments.length > 1) p = arguments[arguments.length - 1]
              if (!p) return
              var type = p.structureId != null ? p.structureId : p.type
              var cfg = placementConfigs[String(type)]
              if (!cfg) return
              if (typeof api.structures.setData !== 'function') return
              var values = defaultsFor(cfg.fields)
              for (var k in values) {
                if (Object.prototype.hasOwnProperty.call(values, k)) {
                  api.structures.setData(p.x, p.y, k, values[k])
                }
              }
            } catch (e) {
              SMLN.log('error', '[shim] placement config merge failed: ' + (e && e.message))
            }
          })
        } catch (_) {
          warnOnce('placeEvt', 'registerPlacementConfig found no building:placed event')
        }
      }

      try {
        api.structures.registerPlacementConfig = function (spec) {
          if (!spec || spec.structureId == null) return false
          placementConfigs[String(spec.structureId)] = spec
          hookPlacement()
          warnOnce('placementConfig',
            'structures.registerPlacementConfig has no hotbar UI on this build: ' +
            'declared field defaults are applied to each placed structure, but the ' +
            'player cannot change them per placement')
          return true
        }
        api.structures.getPlacementConfig = function (id) {
          return id == null ? placementConfigs : (placementConfigs[String(id)] || null)
        }
        installed.push('structures.registerPlacementConfig', 'structures.getPlacementConfig')
        added += 2
      } catch (_) { /* frozen namespace */ }
    }

    // --- world.revealFogAtCell: drive the simulation's own fog reveal.
    /*
     * Fog lives in the simulation worker, not in renderer state, so there is
     * nothing here to flip. The game reveals a cell by posting a message:
     *
     *   environment.postMessage([MessageType.StartFogReveal, x, y])
     *
     * which is exactly what SMLN.postSim does. So this is the game's own
     * mechanism, not a reconstruction - the same message from the same side.
     */
    if (api.world) {
      add(provide(api.world, 'revealFogAtCell', function (x, y) {
        var id = null
        try {
          var e = SMLN.enums || {}
          var mt = e.MessageType || e.WorkerMessage || e.dD
          if (mt && Number.isFinite(mt.StartFogReveal)) id = mt.StartFogReveal
        } catch (_) { /* fall through to the known id */ }
        // 0.5.x numbers this 15. Used only when the table is unavailable, and
        // a wrong id posts an unknown message the worker ignores.
        if (id == null) id = 15
        if (typeof SMLN.postSim !== 'function') return false
        return SMLN.postSim([id, Math.floor(x), Math.floor(y)])
      }))
    }

    // --- player.setMovementMode: hover, held by cancelling fall each frame.
    /*
     * No movement-mode concept exists (`movementMode` in the bundle belongs to
     * drone entities). What the caller wants is creative flight, and that can
     * be held honestly: while hovering, zero the player's vertical velocity
     * every frame so gravity never accumulates.
     *
     * Labelled an approximation deliberately. It is not a real flight mode -
     * it cancels falling rather than granting lift - so a mod expecting
     * upward thrust will not get it.
     */
    if (api.player) {
      var hoverMode = null
      var hoverHooked = false

      add(provide(api.player, 'setMovementMode', function (mode) {
        hoverMode = mode === 'hover' || mode === 'fly' ? mode : null
        if (typeof api.player.setVelocity !== 'function') {
          warnOnce('hover', 'player.setMovementMode needs player.setVelocity, which this build lacks')
          return false
        }
        if (!hoverHooked && api.events && typeof api.events.on === 'function') {
          hoverHooked = true
          try {
            api.events.on('frame:render', function () {
              if (!hoverMode) return
              try { api.player.setVelocity(0, 0) }
              catch (_) { /* one bad frame must not unsubscribe the rest */ }
            })
          } catch (_) {
            warnOnce('hoverTick', 'player.setMovementMode found no frame event; hover will not hold')
          }
        }
        return true
      }))

      add(provide(api.player, 'getMovementMode', function () { return hoverMode || 'normal' }))
    }

    // --- hooks.intercept: a cancellable subscription.
    /*
     * The build has no `intercept`, but its hooks already carry everything one
     * needs. `hooks.run` is:
     *
     *   run(state, name, payload) {
     *     const control = makeControl()
     *     for (const h of handlers[name]) h.fn(state, payload, control)
     *     return control.cancelled
     *   }
     *
     * So a handler's third argument is the cancellation channel, and the
     * caller acts on `control.cancelled`. `intercept` is therefore `on` with
     * that channel surfaced as the `cancel()` the mods expect on the payload.
     */
    if (api.hooks) {
      add(provide(api.hooks, 'intercept', function (name, handler, opts) {
        if (typeof api.hooks.on !== 'function' || typeof handler !== 'function') return function () {}
        return api.hooks.on(name, function () {
          /*
           * The adapter binds state on calls we make *outward*; it does not
           * touch arguments the engine passes *back*. So this callback really
           * receives the engine's own `(state, payload, control)`.
           *
           * Read from the end rather than by index, so a build that drops the
           * state argument - or adds one - still lines up: control is always
           * last, payload always the one before it.
           */
          var n = arguments.length
          var control = n > 0 ? arguments[n - 1] : null
          var payload = n > 1 ? arguments[n - 2] : null

          var view = payload
          if (payload && typeof payload === 'object') {
            view = Object.create(payload)
            view.cancel = function () {
              if (control && typeof control === 'object') control.cancelled = true
            }
          }
          return handler(view)
        }, opts)
      }))
    }

    // --- structures.processing: periodic per-structure work.
    /*
     * `processing.register(id, {structureType, intervalMs, process})` runs
     * `process(structure, ctx)` for every structure of a type on a timer. No
     * such scheduler exists here, but everything it needs is public: the
     * structure list, a frame event, and the element queries `ctx` exposes.
     *
     * One frame subscription drives every processor rather than one each, so
     * adding machines costs no extra event traffic. A processor that throws is
     * logged and skipped, never allowed to kill the frame handler and take all
     * the other machines down with it.
     */
    if (api.structures && !api.structures.processing) {
      var processors = []
      var processingStarted = false

      function makeCtx() {
        return {
          isCellEmpty: function (x, y) {
            try {
              if (typeof api.world.isCellEmptyAtCell === 'function') return !!api.world.isCellEmptyAtCell(x, y)
              if (typeof api.world.isCellEmpty === 'function') return !!api.world.isCellEmpty(x, y)
            } catch (_) { /* treat an error as "not empty": safer than building into it */ }
            return false
          },
          getElementTypeAtCell: function (x, y) {
            try {
              if (typeof api.elements.getTypeAtCell === 'function') return api.elements.getTypeAtCell(x, y)
              if (typeof api.elements.getElementTypeAtPos === 'function') return api.elements.getElementTypeAtPos(x, y)
            } catch (_) { /* fall through */ }
            return null
          },
          // Deferred mutation. The simulation owns the grid while it is
          // stepping, so writes are queued to the idle point when the build
          // offers one rather than applied mid-tick.
          commit: function (fn) {
            if (typeof fn !== 'function') return
            try {
              if (api.world && typeof api.world.runWhenSimulationIdle === 'function') {
                api.world.runWhenSimulationIdle(fn)
                return
              }
            } catch (_) { /* fall through to running it inline */ }
            try { fn() } catch (e) { SMLN.log('error', '[shim] processing commit threw: ' + (e && e.message)) }
          },
        }
      }

      function runProcessors() {
        var now = Date.now()
        for (var i = 0; i < processors.length; i++) {
          var p = processors[i]
          if (now - p.last < p.intervalMs) continue
          p.last = now
          var ctx = makeCtx()
          try {
            api.structures.forEachOfType(p.structureType, function (structure) {
              try { p.process(structure, ctx) }
              catch (e) {
                SMLN.log('error', '[shim] processor "' + p.id + '" threw: ' + (e && e.message))
              }
            })
          } catch (e) {
            warnOnce('proc:' + p.id, 'processing could not enumerate "' + p.structureType + '": ' + (e && e.message))
          }
        }
      }

      function startProcessing() {
        if (processingStarted) return
        processingStarted = true
        try {
          if (api.events && typeof api.events.on === 'function') {
            api.events.on('frame:render', runProcessors)
            return
          }
        } catch (_) { /* fall through */ }
        warnOnce('procTick', 'structures.processing found no frame event; machines will not run')
      }

      try {
        api.structures.processing = {
          register: function (id, spec) {
            if (!spec || typeof spec.process !== 'function') return false
            processors.push({
              id: String(id),
              structureType: spec.structureType != null ? spec.structureType : id,
              intervalMs: Number.isFinite(spec.intervalMs) ? Math.max(16, spec.intervalMs) : 250,
              process: spec.process,
              last: 0,
            })
            startProcessing()
            return true
          },
          unregister: function (id) {
            processors = processors.filter(function (p) { return p.id !== String(id) })
            return true
          },
        }
        installed.push('structures.processing')
        added++
      } catch (_) { /* frozen namespace */ }
    }

    // --- structures.recipes: a recipe table the vanilla machines never had.
    /*
     * This build has no recipe registry at all - the vanilla machines' inputs
     * are hardcoded - so registering a recipe cannot make the game's own
     * smelter consume it. What it can do is keep the table and let the
     * registering mod drive it, which is what the callers already do with
     * their own machines.
     *
     * Recorded honestly: `list()` returns what was registered so a mod (or the
     * console) can see it, and the shortfall is logged once rather than
     * pretending the vanilla machine now understands modded inputs.
     */
    if (api.structures && !api.structures.recipes) {
      var recipeTable = Object.create(null)
      try {
        api.structures.recipes = {
          register: function (machineId, recipe) {
            if (!machineId || !recipe) return false
            var key = String(machineId)
            ;(recipeTable[key] || (recipeTable[key] = [])).push(recipe)
            warnOnce('recipes',
              'structures.recipes is a registry only on this build: the game\'s own ' +
              'machines have hardcoded inputs, so recipes registered against vanilla ' +
              'machines (e.g. "smelter") will not fire until the mod processes them itself')
            return true
          },
          list: function (machineId) {
            if (machineId == null) return recipeTable
            return recipeTable[String(machineId)] || []
          },
        }
        installed.push('structures.recipes')
        added++
      } catch (_) { /* frozen namespace */ }
    }

    // --- tech: node registration.
    /*
     * `api.tech.addDefinition(id, def)` already exists and works - it writes
     * the definition into the registry and invalidates the node cache. What it
     * does NOT do is give the node a position, because the tree's shape comes
     * from a separate grid:
     *
     *   getTechNodes() -> cache || (cache = buildNodes(grid, definitions, links))
     *
     * The grid is a module-local 2D array of tech ids, and `getTechGrid()`
     * returns it *by reference*, so a new id can be written into a free cell.
     * Registering then invalidates the cache and the tree rebuilds with the
     * node in it.
     *
     * This is the one shim that reaches past the public API into a game module,
     * so it is written to fail soft at every step: no module, no grid, no free
     * cell, all return false and say why. A tech node that does not appear is a
     * missing feature; a throw here would be a broken game.
     */
    var techModule = null
    var techModuleTried = false

    function techTree() {
      if (techModuleTried) return techModule
      techModuleTried = true
      if (!SMLN.webpack || !SMLN.webpack.available()) return null
      techModule = SMLN.webpack.find(function (m) {
        return m &&
          typeof m.getTechGrid === 'function' &&
          typeof m.getTechNodes === 'function' &&
          typeof m.addTechDefinition === 'function'
      })
      return techModule
    }

    if (api.tech) {
      add(provide(api.tech, 'getDefinitionById', function (id) {
        return typeof api.tech.getDefinition === 'function' ? api.tech.getDefinition(id) : null
      }))

      add(provide(api.tech, 'registerNode', function (a, b, c) {
        /*
         * Two call shapes exist in the wild, and the bundled mods use the
         * three-argument one:
         *
         *   registerNode(id, definition, { parentId })
         *   registerNode({ id, ...definition })
         *
         * Accept both. Reading only the object form silently rejected every
         * real caller - `node.id` on a string is undefined, so this returned
         * false and no tech node was ever created.
         */
        var id, def, opts
        if (typeof a === 'string') { id = a; def = b || {}; opts = c || {} }
        else { def = a || {}; id = def.id; opts = b || {} }
        // Log on entry, before any guard. The previous version could return
        // false from here without a word, which is indistinguishable from the
        // call never happening - and that is exactly the ambiguity that cost a
        // diagnostic round trip.
        SMLN.log('info', '[shim] tech.registerNode called for ' + JSON.stringify(id))
        if (typeof id !== 'string' || !id) {
          SMLN.log('warn', '[shim] tech.registerNode got a non-string id; ignoring')
          return false
        }

        var node = { id: id }
        for (var key in def) {
          if (Object.prototype.hasOwnProperty.call(def, key)) node[key] = def[key]
        }
        node.id = id
        // The anchor decides where the node lands: an explicit parent wins,
        // otherwise the first prerequisite.
        if (!node.requires && opts && opts.parentId) node.requires = [opts.parentId]
        else if (opts && opts.parentId) node.requires = node.requires || [opts.parentId]

        var mod = techTree()
        if (!mod) {
          SMLN.log('warn', '[shim] tech.registerNode could not reach the tech tree module, so "' +
            id + '" was not added; research nodes will not appear')
          return false
        }

        var grid
        try { grid = mod.getTechGrid() } catch (_) { grid = null }
        if (!grid || typeof grid.length !== 'number') {
          warnOnce('techGrid', 'tech.registerNode found no usable tech grid')
          return false
        }

        // Already placed by an earlier call (or a reload): re-register the
        // definition so edits take effect, but never add a second cell.
        var r, c
        var placed = null
        for (r = 0; r < grid.length && !placed; r++) {
          var rowScan = grid[r]
          if (!rowScan || typeof rowScan.length !== 'number') continue
          for (c = 0; c < rowScan.length; c++) {
            if (rowScan[c] === node.id) { placed = { row: r, col: c }; break }
          }
        }

        if (!placed) {
          // Prefer a free cell beside the prerequisite, so the node lands near
          // what it depends on rather than in an unrelated corner.
          var anchor = null
          var want = node.requires && node.requires.length ? node.requires[0] : null
          if (want) {
            for (r = 0; r < grid.length && !anchor; r++) {
              var rw = grid[r]
              if (!rw || typeof rw.length !== 'number') continue
              for (c = 0; c < rw.length; c++) {
                if (rw[c] === want) { anchor = { row: r, col: c }; break }
              }
            }
          }

          if (anchor) placed = freeCellNear(grid, anchor.row, anchor.col)
          if (!placed) placed = firstFreeCell(grid)
          if (!placed) placed = appendRow(grid, node.id)
          if (!placed) {
            warnOnce('techFull', 'tech.registerNode found no free cell in the tech grid')
            return false
          }
          try { grid[placed.row][placed.col] = node.id }
          catch (e) {
            SMLN.log('warn', '[shim] tech.registerNode could not write "' + id +
              '" into the grid at ' + placed.row + ',' + placed.col + ': ' + (e && e.message))
            return false
          }
        }

        // Registering last: it invalidates the node cache, so the rebuild sees
        // the grid edit that has already happened.
        try {
          if (typeof api.tech.addDefinition === 'function') api.tech.addDefinition(node.id, node)
          else mod.addTechDefinition(node.id, node)
        } catch (e) {
          SMLN.log('error', '[shim] tech.registerNode failed for "' + node.id + '": ' + (e && e.message))
          return false
        }

        /*
         * Report the outcome. Callers guard this with try/catch, which only
         * sees throws - a silent `false` looked identical to success and left
         * "no research node appeared" with nothing to go on.
         */
        var count = null
        try { count = mod.getTechNodes().length } catch (_) { /* not fatal */ }
        SMLN.log('info', '[shim] tech node "' + node.id + '" placed at row ' +
          placed.row + ', col ' + placed.col +
          (count == null ? '' : ' (tree now has ' + count + ' nodes)'))
        return true
      }))
    }

    // --- ui.inject: mount a React component in an overlay above the game.
    /*
     * The build's `ui.overlays` updates the game's *own* overlays and cannot
     * host arbitrary components, so this mounts into the DOM instead, using the
     * game's React and react-dom via the bridge. Using the game's own React is
     * essential: a second copy would have its own dispatcher and any hook in a
     * mod component would throw "invalid hook call".
     *
     * Returns a dispose function, which is the contract mods expect - they
     * store it and treat a falsy return as "injection failed".
     */
    if (api.ui) {
      add(provide(api.ui, 'inject', function (id, Component, opts) {
        var React = SMLN.react && SMLN.react.get && SMLN.react.get()
        var ReactDOM = SMLN.react && SMLN.react.dom && SMLN.react.dom()
        if (!React || !ReactDOM || typeof ReactDOM.createRoot !== 'function') {
          warnOnce('inject', 'ui.inject needs the game React and react-dom; ' +
            'one of them could not be reached, so injected panels are unavailable')
          return null
        }
        if (typeof Component !== 'function' && typeof Component !== 'object') return null

        var host = null
        var root = null
        try {
          var containerId = 'smln-inject-' + String(id || 'panel')
          var existing = global.document && global.document.getElementById(containerId)
          if (existing && existing.parentNode) existing.parentNode.removeChild(existing)

          host = global.document.createElement('div')
          host.id = containerId
          // Above the canvas, but never eating input the mod did not ask for:
          // the panel's own elements re-enable pointer events as needed.
          host.style.cssText = 'position:fixed;inset:0;z-index:' +
            ((opts && opts.zIndex) || 9000) + ';pointer-events:none'
          global.document.body.appendChild(host)

          root = ReactDOM.createRoot(host)
          root.render(React.createElement(Component))
        } catch (e) {
          SMLN.log('error', '[shim] ui.inject failed for "' + id + '": ' + (e && e.message))
          try { if (host && host.parentNode) host.parentNode.removeChild(host) } catch (_) {}
          return null
        }

        return function dispose() {
          try { if (root) root.unmount() } catch (_) { /* already gone */ }
          try { if (host && host.parentNode) host.parentNode.removeChild(host) } catch (_) {}
        }
      }))
    }

    return added
  }

  SMLN.shims = {
    install: install,
    worldToCell: worldToCell,
    cellSize: cellSize,
    /** Sorted list of the calls this layer supplied. */
    installed: function () { return installed.slice().sort() },
  }

  // Runs after sandkit-adapter.js has built SMLN.api for the same 'ready'
  // event. Registration order in the prelude is what guarantees that.
  SMLN.on('ready', function () {
    try {
      var api = SMLN.api
      if (!api) return
      var n = install(api)
      if (n) SMLN.log('info', 'sandkit shims installed (' + n + ' call(s) filled in)')
    } catch (e) {
      SMLN.log('error', 'sandkit shims failed to install: ' + (e && e.message))
    }
  })
})(typeof globalThis !== 'undefined' ? globalThis : window)
