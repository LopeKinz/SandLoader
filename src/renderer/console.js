/* eslint-env browser */
'use strict'
/**
 * In-game developer console.
 *
 * Opens on `^` / backtick / F1. While open it swallows input in the capture
 * phase so the game never sees the keystrokes - otherwise typing "spawn water"
 * would also fire the hotbar and jetpack bindings underneath.
 *
 * Suggestions follow the Minecraft model: a list above the input that narrows
 * as you type, showing the *next* thing you can write. Command names complete
 * first, then each argument completes from its own value set - element names,
 * resource names, on/off - so you can discover the whole surface without docs.
 *
 * Achievement integrity: Sandustry blocks achievement unlocks when
 * `store.integrity.cheatsUsed` is set, and its own cheat routine sets that flag
 * on entry. SMLN honours the same contract by default - any command that
 * mutates the world or your resources marks the save. `integrity off` opts out
 * and the choice is persisted inside the save itself.
 */
;(function installSmlnConsole(global) {
  var SMLN = global.__SMLN__
  if (!SMLN) return
  if (SMLN.console) return

  // Both sources on purpose: SMLN.enums is the supported path, __SMLN_ENUMS__
  // is the raw global the prelude defines first. Reading only the former used
  // to capture an empty object, silently emptying every completion list.
  var E = SMLN.enums && Object.keys(SMLN.enums).length ? SMLN.enums : (global.__SMLN_ENUMS__ || {})
  var MAX_OUTPUT = 300

  // ---------------------------------------------------------------- utilities

  function state() { return SMLN.getState() }
  function FH() { return SMLN.game }

  /** Resolve a dotted path on an object, returning undefined on any gap. */
  function dig(obj, path) {
    var cur = obj
    var parts = path.split('.')
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined
      cur = cur[parts[i]]
    }
    return cur
  }

  function digSet(obj, path, value) {
    var parts = path.split('.')
    var cur = obj
    for (var i = 0; i < parts.length - 1; i++) {
      if (cur == null || typeof cur !== 'object') return false
      cur = cur[parts[i]]
    }
    if (cur == null || typeof cur !== 'object') return false
    cur[parts[parts.length - 1]] = value
    return true
  }

  /**
   * Resource fields, discovered from the live save rather than hardcoded.
   *
   * The game stores counters inconsistently: some are plain numbers on
   * `store.resources`, others are `{available, found}` pairs, and creatures sit
   * under `store.creatures`. A fixed path table silently missed whichever ones
   * did not match, which is why only some resources could be changed. Reading
   * the actual shape also means new counters in a future version just work.
   *
   * @returns {Record<string,string[]>} resource name -> writable paths
   */
  var SUB_FIELDS = ['available', 'found', 'amount', 'count']

  function collectResources(container, prefix, out) {
    if (!container || typeof container !== 'object') return
    Object.keys(container).forEach(function (key) {
      var value = container[key]
      var name = key.toLowerCase()
      if (typeof value === 'number') {
        out[name] = [prefix + key]
        return
      }
      if (value && typeof value === 'object') {
        var subs = SUB_FIELDS.filter(function (f) { return typeof value[f] === 'number' })
        // Write every numeric sub-field: setting `found` without `available`
        // leaves the HUD and the spendable pool disagreeing.
        if (subs.length) out[name] = subs.map(function (f) { return prefix + key + '.' + f })
      }
    })
  }

  function resourceTargets() {
    var out = {}
    var s = state()
    if (!s || !s.store) return out
    collectResources(s.store.resources, 'resources.', out)
    collectResources(s.store.creatures, 'creatures.', out)
    collectResources(s.store.conservatory, 'conservatory.', out)
    if (typeof s.store.productionPoints === 'number') out.productionpoints = ['productionPoints']
    return out
  }

  /** Completion falls back to the known names before a save is loaded. */
  function resourceNames() {
    var live = Object.keys(resourceTargets())
    return live.length ? live.sort() : (E.RESOURCES || []).slice().sort()
  }

  // ------------------------------------------------------------- integrity

  /** SandLoader's persisted settings live on the save object, so they travel with it. */
  function settings() {
    var s = state()
    if (!s || !s.store) return null
    if (!s.store.smln || typeof s.store.smln !== 'object') {
      s.store.smln = { markCheats: true, version: SMLN.version }
    }
    if (typeof s.store.smln.markCheats !== 'boolean') s.store.smln.markCheats = true
    return s.store.smln
  }

  /**
   * Called by every mutating command. Returns a note to append to the reply so
   * the effect on achievements is never silent.
   */
  function markCheatUsed() {
    var s = state()
    var cfg = settings()
    if (!s || !s.store || !cfg) return ''
    if (!cfg.markCheats) return ''
    if (!s.store.integrity || typeof s.store.integrity !== 'object') {
      s.store.integrity = { cheatsUsed: false, modsUsed: false }
    }
    if (s.store.integrity.cheatsUsed) return ''
    s.store.integrity.cheatsUsed = true
    return ' (save marked: achievements now disabled - "integrity" to change)'
  }

  // --------------------------------------------------------------- resolvers

  /**
   * Element name -> numeric id, resolved against the running game.
   *
   * The legacy `ElementType` enum in the bundle lists 20 entries, but the live
   * registry holds 50 and grows whenever a mod registers its own - which is why
   * a hardcoded table could not spawn most materials. Instead we ask the game:
   * `i18n.t('elements|<key>|name')` gives the localised display name, and
   * `elements.getName(state, id)` gives the same string for a numeric id, so
   * matching the two yields key -> id in any language.
   *
   * Built once per capture and cached.
   */
  var elementTable = null

  function buildElementTable() {
    var table = {}
    var f = FH()
    var s = state()

    if (f && f.elements && typeof f.elements.getName === 'function' &&
        f.i18n && typeof f.i18n.t === 'function') {
      var byLocalised = {}
      for (var id = 1; id <= 512; id++) {
        var name
        try { name = f.elements.getName(s, id) } catch (_) { continue }
        if (!name || name === String(id)) continue
        if (byLocalised[name] == null) byLocalised[name] = id
      }
      ;(E.ELEMENT_KEYS || []).forEach(function (key) {
        var localised
        try { localised = f.i18n.t('elements|' + key + '|name') } catch (_) { return }
        if (localised && byLocalised[localised] != null) table[key.toLowerCase()] = byLocalised[localised]
      })
    }

    // Fall back to the static enum for anything the probe could not resolve.
    Object.keys(E.ElementByName || {}).forEach(function (k) {
      if (table[k] == null) table[k] = E.ElementByName[k]
    })
    return table
  }

  function elements() {
    if (!elementTable) elementTable = buildElementTable()
    return elementTable
  }

  SMLN.on && SMLN.on('ready', function () { elementTable = null })

  /** Element name or numeric id -> {id, name}. */
  function resolveElement(token) {
    if (!token) return null
    var t = String(token).toLowerCase()
    if (/^\d+$/.test(t)) return { id: Number(t), name: elementName(Number(t)) }
    var table = elements()
    if (table[t] != null) return { id: table[t], name: t }
    var hits = Object.keys(table).filter(function (k) { return k.indexOf(t) === 0 })
    if (hits.length === 1) return { id: table[hits[0]], name: hits[0] }
    // A name the game ships but whose id we could not resolve: say so, rather
    // than reporting it as unknown and sending the user hunting for a typo.
    var known = (E.ELEMENT_KEYS || []).some(function (k) { return k.toLowerCase() === t })
    if (known) return { id: null, name: t, unresolved: true }
    return null
  }

  /** Terrain name -> canonical key. Terrains are addressed by name, not id. */
  function resolveTerrain(token) {
    if (!token) return null
    var t = String(token).toLowerCase()
    var keys = E.TERRAIN_KEYS || []
    var exact = keys.filter(function (k) { return k.toLowerCase() === t })
    if (exact.length) return exact[0]
    var hits = keys.filter(function (k) { return k.toLowerCase().indexOf(t) === 0 })
    return hits.length === 1 ? hits[0] : null
  }

  function elementName(id) {
    try {
      var f = FH()
      if (f && f.elements && typeof f.elements.getName === 'function') {
        var n = f.elements.getName(state(), id)
        if (n && n !== String(id)) return n
      }
    } catch (_) {}
    return (E.ElementType && E.ElementType[id]) || String(id)
  }

  /**
   * Union of what the live registry resolved and every name the game ships.
   * The two differ before capture (no registry yet) and after a mod registers
   * content the static list has never heard of, so neither alone is enough.
   */
  function elementNames() {
    var seen = {}
    var out = []
    Object.keys(elements()).concat(E.ELEMENT_KEYS || []).forEach(function (n) {
      var k = String(n).toLowerCase()
      if (!seen[k]) { seen[k] = 1; out.push(k) }
    })
    return out.sort()
  }

  function terrainNames() {
    return (E.TERRAIN_KEYS || []).slice().sort()
  }

  /** Everything `spawn` accepts, elements and terrains together. */
  function spawnableNames() {
    var seen = {}
    var out = []
    elementNames().concat(terrainNames()).forEach(function (n) {
      var k = n.toLowerCase()
      if (!seen[k]) { seen[k] = 1; out.push(n) }
    })
    return out.sort()
  }

  /**
   * World grid resolution. The game keeps player and mouse positions in world
   * pixels and divides by this to reach a cell. Verified value is 4; every
   * lookup below is a fallback chain ending there rather than a guess.
   */
  function cellSize() {
    var f = FH()
    try {
      if (f && f.config) {
        if (isFinite(f.config.cellSize)) return f.config.cellSize
        if (typeof f.config.get === 'function') {
          var c = f.config.get()
          if (c && isFinite(c.cellSize)) return c.cellSize
        }
      }
    } catch (_) {}
    var dbg = global.__debug
    if (dbg && dbg.config && isFinite(dbg.config.cellSize)) return dbg.config.cellSize
    return 4
  }

  /**
   * Where `spawn` puts things when no coordinates are given: the mouse if the
   * game knows where it is, otherwise the player's centre. Both live in world
   * pixels; cells are pixels / cellSize.
   */
  function targetCell() {
    var s = state()
    if (!s) return null
    var cs = cellSize() || 4

    var mouse = dig(s, 'session.input.mouse.worldPosition')
    if (mouse && isFinite(mouse.x) && isFinite(mouse.y)) {
      return { x: Math.round(mouse.x / cs), y: Math.round(mouse.y / cs), from: 'cursor' }
    }

    var p = dig(s, 'store.player')
    if (p && isFinite(p.x) && isFinite(p.y)) {
      return {
        x: Math.round((p.x + (p.width || 0) / 2) / cs),
        y: Math.round((p.y + (p.height || 0) / 2) / cs),
        from: 'player',
      }
    }
    return null
  }

  // ---------------------------------------------------------------- commands

  /** @type {Record<string, any>} */
  var commands = Object.create(null)

  function define(spec) { commands[spec.name] = spec }

  define({
    name: 'help',
    summary: 'List commands, or explain one',
    usage: 'help [command]',
    args: [{ name: 'command', optional: true, values: function () { return Object.keys(commands).sort() } }],
    run: function (a) {
      if (a[0] && commands[a[0]]) {
        var c = commands[a[0]]
        return [c.name + ' - ' + c.summary, 'usage: ' + c.usage]
      }
      var out = ['Commands (type a name for details):']
      Object.keys(commands).sort().forEach(function (k) {
        out.push('  ' + k.padEnd(11) + commands[k].summary)
      })
      return out
    },
  })

  define({
    name: 'spawn',
    summary: 'Spawn a material - solid, liquid or gas',
    usage: 'spawn <element> [radius] [x] [y]',
    args: [
      { name: 'material', values: spawnableNames },
      { name: 'radius', optional: true, values: function () { return ['1', '3', '5', '10'] } },
      { name: 'x', optional: true },
      { name: 'y', optional: true },
    ],
    run: function (a) {
      // A name can be either a loose particle or a piece of terrain - "copper"
      // is in fact both - so resolve elements first and fall back to terrain.
      var el = resolveElement(a[0])
      if (el && el.unresolved) {
        // Might still exist as a terrain of the same name (copper is both).
        var asTerrain = resolveTerrain(a[0])
        if (asTerrain) el = null
        else return ['"' + el.name + '" is a known material, but its id could not be resolved',
          'start or load a game first, then try again']
      }
      var terrain = el ? null : resolveTerrain(a[0])
      if (!el && !terrain) {
        return ['unknown material "' + (a[0] || '') + '"',
          'try: list elements   or   list terrains']
      }
      var radius = a[1] ? Math.max(0, Math.min(60, parseInt(a[1], 10) || 0)) : 2
      var origin
      if (a[2] != null && a[3] != null) {
        origin = { x: parseInt(a[2], 10), y: parseInt(a[3], 10) }
        if (!isFinite(origin.x) || !isFinite(origin.y)) return ['x and y must be whole numbers']
      } else {
        origin = targetCell()
        if (!origin) return ['could not work out where to spawn - pass coordinates: spawn ' + el.name + ' ' + radius + ' <x> <y>']
      }

      var f = FH()
      var s = state()
      var place, label

      if (el) {
        if (!f || !f.elements || typeof f.elements.createAt !== 'function') {
          return ['element API unavailable (FH.elements.createAt missing)']
        }
        label = el.name
        place = function (x, y) { f.elements.createAt(s, x, y, el.id, {}) }
      } else {
        if (!f || !f.terrains || typeof f.terrains.createAt !== 'function') {
          return ['terrain API unavailable (FH.terrains.createAt missing)']
        }
        label = terrain + ' (terrain)'
        // Terrains are addressed by name, not by numeric id.
        place = function (x, y) { f.terrains.createAt(s, x, y, terrain) }
      }

      var placed = 0, failed = 0, firstError = null
      for (var dx = -radius; dx <= radius; dx++) {
        for (var dy = -radius; dy <= radius; dy++) {
          if (dx * dx + dy * dy > radius * radius) continue
          try { place(origin.x + dx, origin.y + dy); placed++ }
          catch (e) { failed++; if (!firstError) firstError = e && e.message }
        }
      }
      SMLN.refreshUI()

      if (!placed) {
        return ['nothing was placed at ' + origin.x + ',' + origin.y + ' (' + failed + ' cell(s) rejected)',
          firstError ? 'first error: ' + firstError
            : 'the area may be solid terrain, or outside the world']
      }
      var note = markCheatUsed()
      return ['spawned ' + placed + ' x ' + label + ' at ' + origin.x + ',' + origin.y +
        (origin.from ? ' (' + origin.from + ')' : '') +
        (failed ? ', ' + failed + ' cell(s) rejected' : '') + note]
    },
  })

  define({
    name: 'give',
    summary: 'Add to a resource',
    usage: 'give <resource> <amount>',
    args: [
      { name: 'resource', values: resourceNames },
      { name: 'amount', values: function () { return ['100', '1000', '10000'] } },
    ],
    run: function (a) { return adjust(a[0], a[1], true) },
  })

  define({
    name: 'set',
    summary: 'Set a resource to an exact value',
    usage: 'set <resource> <amount>',
    args: [
      { name: 'resource', values: resourceNames },
      { name: 'amount', values: function () { return ['0', '1000', '1000000'] } },
    ],
    run: function (a) { return adjust(a[0], a[1], false) },
  })

  function adjust(name, rawAmount, relative) {
    var s = state()
    if (!s || !s.store) return ['no game loaded']

    var targets = resourceTargets()
    var key = String(name || '').toLowerCase()
    var paths = targets[key]
    if (!paths) {
      var known = Object.keys(targets).sort()
      return ['unknown resource "' + name + '"',
        known.length ? 'available in this save: ' + known.join(', ') : 'no resource fields found on this save']
    }

    var amount = Number(rawAmount)
    if (!isFinite(amount)) return ['amount must be a number']

    var changed = []
    var refused = []
    paths.forEach(function (path) {
      var before = Number(dig(s.store, path)) || 0
      var next = relative ? before + amount : amount
      if (digSet(s.store, path, next)) changed.push(path.split('.').pop() + ': ' + before + ' -> ' + next)
      else refused.push(path)
    })

    if (!changed.length) return ['could not write ' + paths.join(', ') + ' - field missing on this save']
    SMLN.refreshUI()
    return [key + '  ' + changed.join(', ') +
      (refused.length ? '  (skipped: ' + refused.join(', ') + ')' : '') + markCheatUsed()]
  }

  define({
    name: 'resources',
    summary: 'Show all resource values',
    usage: 'resources',
    args: [],
    run: function () {
      var s = state()
      if (!s || !s.store) return ['no game loaded']
      var targets = resourceTargets()
      var names = Object.keys(targets).sort()
      if (!names.length) return ['no resource fields found on this save']
      return names.map(function (k) {
        var vals = targets[k].map(function (p) {
          return targets[k].length > 1 ? p.split('.').pop() + '=' + dig(s.store, p) : String(dig(s.store, p))
        })
        return '  ' + k.padEnd(16) + vals.join('  ')
      })
    },
  })

  define({
    name: 'integrity',
    summary: 'Control whether cheats disable achievements (saved in your savegame)',
    usage: 'integrity [on|off|clear|status]',
    args: [{ name: 'mode', optional: true, values: function () { return ['on', 'off', 'clear', 'status'] } }],
    run: function (a) {
      var s = state()
      var cfg = settings()
      if (!s || !s.store || !cfg) return ['no game loaded']
      var mode = (a[0] || 'status').toLowerCase()
      var flagged = !!(s.store.integrity && s.store.integrity.cheatsUsed)

      if (mode === 'status') {
        return [
          'marking:     ' + (cfg.markCheats ? 'ON - cheat commands disable achievements' : 'OFF - cheat commands leave achievements intact'),
          'this save:   ' + (flagged ? 'ALREADY MARKED (achievements disabled)' : 'clean'),
          'mods flag:   ' + (dig(s.store, 'integrity.modsUsed') ? 'set' : 'clear'),
          'the setting is stored in the savegame',
        ]
      }
      if (mode === 'on' || mode === 'off') {
        cfg.markCheats = mode === 'on'
        return ['integrity marking ' + mode.toUpperCase() + ' - saved with this game' +
          (mode === 'off' && flagged ? ' (note: this save is already marked; use "integrity clear" to reset it)' : '')]
      }
      if (mode === 'clear') {
        if (!s.store.integrity) s.store.integrity = { cheatsUsed: false, modsUsed: false }
        s.store.integrity.cheatsUsed = false
        s.store.integrity.modsUsed = false
        return ['integrity flags cleared on this save - achievements can unlock again.',
          'Achievements are Steam-global; you are choosing to re-enable them on a modified save.']
      }
      return ['usage: ' + this.usage]
    },
  })

  define({
    name: 'tech',
    summary: 'Toggle free tech/upgrades for this session',
    usage: 'tech <on|off>',
    args: [{ name: 'mode', values: function () { return ['on', 'off'] } }],
    run: function (a) {
      var s = state()
      if (!s || !s.session) return ['no game loaded']
      if (!s.session.cheat) s.session.cheat = { bypassCosts: false }
      var mode = (a[0] || '').toLowerCase()
      if (mode !== 'on' && mode !== 'off') return ['usage: tech <on|off>']
      s.session.cheat.bypassCosts = mode === 'on'
      SMLN.refreshUI()
      // Session-only flag; the game itself does not treat it as save tainting.
      return ['bypassCosts ' + mode.toUpperCase() + ' (session only, not saved)']
    },
  })

  define({
    name: 'sim',
    summary: 'Control the simulation',
    usage: 'sim <pause|resume|speed> [value]',
    args: [
      { name: 'action', values: function () { return ['pause', 'resume', 'speed'] } },
      { name: 'value', optional: true, values: function () { return ['0.5', '1', '2', '5'] } },
    ],
    run: function (a) {
      var M = E.WorkerMessage || {}
      var act = (a[0] || '').toLowerCase()
      var s = state()
      if (act === 'pause' || act === 'resume') {
        var paused = act === 'pause'
        if (s && s.session) s.session.paused = paused
        if (!SMLN.postSim([M.SetPaused, paused])) return ['simulation worker unreachable']
        return ['simulation ' + (paused ? 'paused' : 'resumed')]
      }
      if (act === 'speed') {
        var v = Number(a[1])
        if (!isFinite(v) || v <= 0) return ['speed must be a positive number']
        if (!SMLN.postSim([M.SetSimulationSpeed, v])) return ['simulation worker unreachable']
        return ['simulation speed set to ' + v]
      }
      return ['usage: ' + this.usage]
    },
  })

  define({
    name: 'list',
    summary: 'List known elements, machines or resources',
    usage: 'list <elements|terrains|gases|liquids|solids|machines|resources>',
    args: [{ name: 'kind', values: function () { return ['elements', 'terrains', 'gases', 'liquids', 'solids', 'machines', 'resources'] } }],
    run: function (a) {
      var kind = (a[0] || 'elements').toLowerCase()
      var phase = E.ELEMENT_PHASE || {}
      function byPhase(want) {
        return Object.keys(E.ElementType || {})
          .map(function (id) { return E.ElementType[id] })
          .filter(function (n) { return (phase[n] || '').toLowerCase() === want })
      }
      if (kind === 'resources') return ['  ' + resourceNames().join(', ')]
      if (kind === 'terrains') return wrap(terrainNames())
      if (kind === 'machines') return wrap(Object.values(E.StructureType || {}))
      if (kind === 'gases') return wrap(byPhase('gas'))
      if (kind === 'liquids') return wrap(byPhase('liquid'))
      if (kind === 'solids') return wrap(byPhase('solid').concat(byPhase('powder')))
      return wrap(elementNames())
    },
  })

  function wrap(items) {
    var out = [], line = '  '
    items.forEach(function (n) {
      if ((line + n).length > 76) { out.push(line); line = '  ' }
      line += n + '  '
    })
    if (line.trim()) out.push(line)
    return out.length ? out : ['  (none)']
  }

  define({
    name: 'api',
    summary: "Inspect the game's live modding API",
    usage: 'api [namespace]',
    args: [{ name: 'namespace', optional: true, values: function () { var f = FH(); return f ? Object.keys(f).sort() : [] } }],
    run: function (a) {
      var f = FH()
      if (!f) return ['game API not captured yet']
      if (!a[0]) return ['FH namespaces:'].concat(wrap(Object.keys(f).sort()))
      var ns = f[a[0]]
      if (!ns) return ['no such namespace: ' + a[0]]
      var keys = Object.keys(ns).filter(function (k) { return typeof ns[k] === 'function' }).sort()
      return ['FH.' + a[0] + ' methods:'].concat(wrap(keys))
    },
  })

  define({
    name: 'clear',
    summary: 'Clear the console output',
    usage: 'clear',
    args: [],
    run: function () { ui.output.innerHTML = ''; return [] },
  })

  SMLN.commands = commands
  /** Mods register their own commands through this. */
  SMLN.registerCommand = function (spec) {
    if (!spec || !spec.name || typeof spec.run !== 'function') return false
    if (!spec.args) spec.args = []
    if (!spec.usage) spec.usage = spec.name
    if (!spec.summary) spec.summary = '(mod command)'
    commands[spec.name] = spec
    return true
  }

  // ------------------------------------------------------------ suggestions

  /**
   * Work out what the user could type next.
   * Returns the candidate list plus the token being completed, so Tab can
   * replace exactly that token and nothing else.
   */
  function computeSuggestions(text, caret) {
    var upto = text.slice(0, caret)
    var tokens = upto.split(/\s+/)
    var typing = tokens[tokens.length - 1]
    var index = tokens.length - 1

    var candidates = []
    if (index === 0) {
      candidates = Object.keys(commands).sort().map(function (n) {
        return { value: n, hint: commands[n].summary }
      })
    } else {
      var cmd = commands[tokens[0]]
      if (cmd && cmd.args && cmd.args[index - 1]) {
        var spec = cmd.args[index - 1]
        var values = []
        try { values = spec.values ? spec.values() : [] } catch (_) { values = [] }
        candidates = values.map(function (v) { return { value: String(v), hint: spec.name } })
        if (!candidates.length) candidates = [{ value: '', hint: '<' + spec.name + '>' }]
      }
    }

    var lower = typing.toLowerCase()
    var filtered = candidates.filter(function (c) {
      return c.value && c.value.toLowerCase().indexOf(lower) === 0
    })
    // Fall back to substring matching so "sand" still finds "wetsand".
    if (!filtered.length && lower) {
      filtered = candidates.filter(function (c) {
        return c.value && c.value.toLowerCase().indexOf(lower) >= 0
      })
    }
    if (!lower) filtered = candidates.filter(function (c) { return c.value })
    return { items: filtered.slice(0, 12), typing: typing, tokenStart: caret - typing.length }
  }

  // -------------------------------------------------------------------- UI

  var ui = {}
  var history = []
  var historyIndex = -1
  var sugg = { items: [], selected: 0, typing: '', tokenStart: 0 }
  var open = false

  var CSS = [
    '#smln-console{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;',
    'font:13px/1.5 Consolas,"Cascadia Mono",monospace;color:#d7dae0;display:none}',
    '#smln-console.open{display:block}',
    '#smln-out{max-height:38vh;overflow-y:auto;background:rgba(12,14,18,.93);',
    'border-top:1px solid #ffe70055;padding:8px 12px;white-space:pre-wrap;word-break:break-word}',
    '#smln-out div{padding:1px 0}',
    '#smln-out .u{color:#ffe700}#smln-out .e{color:#ff7a6b}#smln-out .n{color:#8b93a1}',
    '#smln-inputrow{display:flex;align-items:center;background:rgba(8,10,13,.97);',
    'border-top:1px solid #ffe70033;padding:6px 12px}',
    '#smln-prompt{color:#ffe700;margin-right:8px}',
    '#smln-input{flex:1;background:transparent;border:0;outline:0;color:#fff;font:inherit}',
    '#smln-sugg{position:absolute;bottom:100%;left:12px;background:rgba(8,10,13,.98);',
    'border:1px solid #ffe70044;border-bottom:0;max-height:40vh;overflow-y:auto;min-width:280px}',
    '#smln-sugg div{padding:3px 10px;display:flex;gap:14px;justify-content:space-between}',
    '#smln-sugg div.sel{background:#ffe700;color:#111}',
    '#smln-sugg .h{color:#8b93a1;font-size:11px}',
    '#smln-sugg div.sel .h{color:#553}',
  ].join('')

  function el(tag, id, parent) {
    var node = document.createElement(tag)
    if (id) node.id = id
    if (parent) parent.appendChild(node)
    return node
  }

  function build() {
    var style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)

    // Built node by node rather than through innerHTML: no HTML escaping to get
    // wrong, and the structure stays inspectable by the test harness.
    var root = el('div', 'smln-console')
    var out = el('div', 'smln-out', root)
    var row = el('div', 'smln-inputrow', root)
    row.style.position = 'relative'
    var sg = el('div', 'smln-sugg', row)
    sg.style.display = 'none'
    var prompt = el('span', 'smln-prompt', row)
    prompt.textContent = '>'
    var input = el('input', 'smln-input', row)
    if (input.setAttribute) {
      input.setAttribute('autocomplete', 'off')
      input.setAttribute('spellcheck', 'false')
    }
    document.body.appendChild(root)

    ui.root = root
    ui.output = out
    ui.input = input
    ui.sugg = sg

    ui.input.addEventListener('input', refreshSuggestions)
    // NOTE: no keydown listener here on purpose. A capture-phase listener on
    // `window` runs first and must stopPropagation() to keep keys away from
    // the game - which also prevents them from ever reaching this element. All
    // key handling therefore happens in onGlobalKey, which calls onInputKey
    // itself. (This was the bug that made Tab and Enter do nothing.)
    ui.sugg.addEventListener('mousedown', function (ev) {
      var idx = Number(ev.target.closest('div[data-i]') && ev.target.closest('div[data-i]').dataset.i)
      if (isFinite(idx)) { ev.preventDefault(); sugg.selected = idx; acceptSuggestion() }
    })

    print('SandLoader console ready. Type "help", Tab completes, Esc closes.', 'n')
  }

  function print(text, cls) {
    if (!ui.output) return
    var d = document.createElement('div')
    if (cls) d.className = cls
    d.textContent = text
    ui.output.appendChild(d)
    while (ui.output.childNodes.length > MAX_OUTPUT) ui.output.removeChild(ui.output.firstChild)
    ui.output.scrollTop = ui.output.scrollHeight
  }

  function refreshSuggestions() {
    var r = computeSuggestions(ui.input.value, ui.input.selectionStart)
    sugg.items = r.items
    sugg.typing = r.typing
    sugg.tokenStart = r.tokenStart
    if (sugg.selected >= sugg.items.length) sugg.selected = 0
    renderSuggestions()
  }

  function renderSuggestions() {
    if (!sugg.items.length) { ui.sugg.style.display = 'none'; return }
    ui.sugg.style.display = 'block'
    while (ui.sugg.firstChild) ui.sugg.removeChild(ui.sugg.firstChild)

    var selected = null
    sugg.items.forEach(function (c, i) {
      var row = document.createElement('div')
      row.dataset.i = String(i)
      if (i === sugg.selected) { row.className = 'sel'; selected = row }
      var name = document.createElement('span')
      name.textContent = c.value
      var hint = document.createElement('span')
      hint.className = 'h'
      hint.textContent = c.hint || ''
      row.appendChild(name)
      row.appendChild(hint)
      ui.sugg.appendChild(row)
    })
    if (selected && selected.scrollIntoView) selected.scrollIntoView({ block: 'nearest' })
  }

  function acceptSuggestion() {
    var c = sugg.items[sugg.selected]
    if (!c || !c.value) return false
    var v = ui.input.value
    var next = v.slice(0, sugg.tokenStart) + c.value + v.slice(sugg.tokenStart + sugg.typing.length)
    if (!next.endsWith(' ')) next += ' '
    ui.input.value = next
    ui.input.setSelectionRange(next.length, next.length)
    refreshSuggestions()
    return true
  }

  function onInputKey(ev) {
    // Everything typed into the console stays in the console.
    ev.stopPropagation()

    if (ev.key === 'Escape') { ev.preventDefault(); toggle(false); return }

    if (ev.key === 'Tab') {
      ev.preventDefault()
      if (sugg.items.length) {
        if (ev.shiftKey) sugg.selected = (sugg.selected - 1 + sugg.items.length) % sugg.items.length
        else if (sugg.items.length === 1 || sugg.typing) { acceptSuggestion(); return }
        else sugg.selected = (sugg.selected + 1) % sugg.items.length
        renderSuggestions()
      }
      return
    }

    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      var dir = ev.key === 'ArrowDown' ? 1 : -1
      if (sugg.items.length > 1) {
        ev.preventDefault()
        sugg.selected = (sugg.selected + dir + sugg.items.length) % sugg.items.length
        renderSuggestions()
        return
      }
      // No suggestion list to navigate - fall back to command history.
      ev.preventDefault()
      if (!history.length) return
      historyIndex = Math.max(0, Math.min(history.length - 1, historyIndex - dir))
      ui.input.value = history[historyIndex] || ''
      ui.input.setSelectionRange(ui.input.value.length, ui.input.value.length)
      refreshSuggestions()
      return
    }

    if (ev.key === 'Enter') {
      ev.preventDefault()
      // A highlighted, not-yet-typed suggestion completes instead of running.
      if (sugg.items.length && sugg.selected > 0 && sugg.items[sugg.selected].value !== sugg.typing) {
        acceptSuggestion()
        return
      }
      submit()
    }
  }

  function submit() {
    var line = ui.input.value.trim()
    ui.input.value = ''
    refreshSuggestions()
    if (!line) return
    history.push(line)
    if (history.length > 100) history.shift()
    historyIndex = history.length
    print('> ' + line, 'u')
    run(line)
  }

  /** Parse and execute a command line. Never throws out to the game. */
  function run(line) {
    var parts = line.split(/\s+/).filter(Boolean)
    var cmd = commands[parts[0]]
    if (!cmd) {
      var near = Object.keys(commands).filter(function (n) { return n.indexOf(parts[0]) === 0 })
      print('unknown command "' + parts[0] + '"' + (near.length ? ' - did you mean: ' + near.join(', ') : ' - type "help"'), 'e')
      return
    }
    try {
      var out = cmd.run.call(cmd, parts.slice(1))
      if (Array.isArray(out)) out.forEach(function (l) { print(l) })
      else if (typeof out === 'string') print(out)
    } catch (e) {
      print('command failed: ' + (e && e.message), 'e')
      SMLN.log('error', 'console command "' + parts[0] + '" threw', e && e.stack)
    }
  }

  SMLN.runCommand = run

  function toggle(force) {
    open = force == null ? !open : !!force
    ui.root.classList.toggle('open', open)
    if (open) { ui.input.focus(); refreshSuggestions() }
    else { ui.input.blur(); ui.sugg.style.display = 'none' }
  }

  SMLN.console = {
    toggle: toggle,
    print: print,
    isOpen: function () { return open },
    /** Exposed so mods and the self-test can query completion directly. */
    suggest: function (text, caret) {
      return computeSuggestions(text, caret == null ? text.length : caret)
    },
    /** Feed a synthetic key event, for tests and for mod-defined bindings. */
    handleKey: onGlobalKey,
    get input() { return ui.input },
  }

  /**
   * Single key entry point, capture phase on window.
   *
   * It has to be capture-on-window to beat the game's own bindings, and it has
   * to stopPropagation() to keep keys out of the game while typing. But that
   * same stopPropagation prevents the event from ever reaching the <input>,
   * so the console's keys are handled *here* rather than by a listener on the
   * element. Typing still works: stopPropagation blocks listeners, not the
   * browser's default text insertion.
   */
  function onGlobalKey(ev) {
    var isToggle = ev.code === 'Backquote' || ev.code === 'IntlBackslash' ||
      ev.key === '^' || ev.key === 'F1'
    if (isToggle && !ev.ctrlKey && !ev.altKey) {
      ev.preventDefault()
      ev.stopPropagation()
      toggle()
      return
    }
    if (!open) return
    onInputKey(ev)
    // Everything typed while the console is open belongs to the console.
    ev.stopPropagation()
  }

  function boot() {
    if (!document.body) { setTimeout(boot, 50); return }
    build()
    window.addEventListener('keydown', onGlobalKey, true)
    SMLN.log('info', 'console installed (toggle: ^ / backtick / F1)')
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})(typeof globalThis !== 'undefined' ? globalThis : window)
