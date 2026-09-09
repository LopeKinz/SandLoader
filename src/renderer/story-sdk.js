/* eslint-env browser */
'use strict'
/**
 * SandLoader's story SDK: `SMLN.forMod(id).story`.
 *
 * Two halves. The mission half - objectives - is described first, because the
 * story half reuses all four of its answers. The story half - speakers and
 * steps - is described under THE STORY HALF further down.
 *
 * Sandustry has no objective registry. What it has - measured against the
 * running 0.5.6 build, not inferred - is one module-scope definition table
 * that every part of the objective system consults by identity at call time:
 *
 *   SMLN.webpack.get('92659').qs   12 entries, not frozen, extensible
 *                                  fields: titleKey, descriptionKey,
 *                                          nextObjectives, check
 *
 * Once an id is a key in that table the game's own completion API accepts it
 * (`progression.complete(state, {domain:'objective', id})` gates on
 * `hasOwnProperty.call(qs, id)`), and the game's own panel renders its title.
 * So this file's whole job is to put a mod's entry in that table safely, and
 * to supply the four things the game does not:
 *
 *   1. EVALUATION. The shipped evaluator is generic but fires at only three
 *      event sites, so a mod's `check` would sit there unrun. The SDK ticks
 *      the predicates it owns, on a bounded cadence.
 *
 *      A mod's `check` is deliberately NOT written into `qs`. The game's
 *      evaluator does not catch, so a predicate left in the table would throw
 *      inside the game's own tech-unlock handler; and a completion driven by
 *      the game's evaluator would bypass the durable record below. Evaluation
 *      is either ours or the game's, and half-and-half is the worst of both.
 *
 *   2. DURABILITY. A completed entry is deleted from `store.objectives.active`
 *      about five seconds later and again at world load, and no completed-set
 *      exists anywhere. That five-second deletion is left strictly alone - it
 *      is the game's behaviour and its reasons are not ours to guess - and the
 *      SDK instead keeps its own set in the saved half of the state, under its
 *      own key, re-read at world load before any evaluation.
 *
 *   3. NAMESPACING. Every mod id registers as `<modId>:<id>`, so two mods
 *      cannot collide and the owner of a broken objective is visible in a log
 *      line. Vanilla ids stay bare, so a reference to `find_fluxite` still
 *      means the game's own and cannot be shadowed.
 *
 *   4. DEPENDENCIES. `requires: ['other-mod']` refuses to register when the
 *      named mod is absent or disabled, naming both. A mission that silently
 *      never completes is the failure this exists to prevent.
 *
 * THE STORY HALF: `speaker()` and `step()`.
 *
 * The step table is a real registry - `progression.getSteps(state)` hands back
 * the same live array on every call, unfrozen and extensible - and chaining is
 * pure data: completing a step starts `steps[index+1]`. So a mod is in the
 * story the moment its entry is in that array at the right index, and `step()`
 * is mostly about putting it there and keeping it there.
 *
 * Four things the game does not do, mirroring the four above:
 *
 *   1. EVALUATION, again. `{type:"custom",check}` is data on the entry, but
 *      nothing ticks it. The same ticker that runs objective predicates runs
 *      these, and completion goes through the game's own path - see
 *      NUDGE_EVENT for how, and why it is not re-implemented here.
 *
 *   2. DURABILITY, again. The game's own `completedSteps` is durable and its
 *      three guards are what stop a beat replaying, so they are left alone.
 *      What the SDK adds is its own record of the same fact, so that "has this
 *      mod's beat played" has an answer that does not depend on an array the
 *      game rebuilds from a private literal on every world load.
 *
 *   3. SPEAKERS. The portrait table has two entries, no accessor and no
 *      export, and an unknown speaker is silently drawn as ZOE - so a mod's
 *      character would wear someone else's face with no error at all. One
 *      patch, `smln:story-speakers`, gives that table an identity on the
 *      global. Without it `speaker()` refuses by name rather than registering
 *      a face that would never be worn.
 *
 *   4. ORDERING. `after`/`before` name a step that may not have registered
 *      yet, because load order is not something a mod author can control. A
 *      named step that has not arrived is waited for; one that never arrives
 *      is reported once, by name, and the step is appended rather than lost.
 *
 * What is deliberately NOT here: branching (no field expresses it), and the
 * scripted world effects, which are `id ===` comparisons against vanilla step
 * ids and cannot be reached as data.
 *
 * FAILURE STYLE, following registration.js: nothing here throws at a mod.
 * A refusal is a named Error written to the log with the mod's id and a
 * `false` return, because a mod's load must not be aborted by our validation.
 */
;(function installStorySdk(global) {
  var SMLN = global.__SMLN__
  if (!SMLN || typeof SMLN.forMod !== 'function' || SMLN.__story) return

  /** Our own key in the saved half of the state (`state.store`). */
  var STORE_KEY = 'smlnStory'
  /** Bounded cadence. A mod's predicate must not become a per-frame cost. */
  var TICK_MS = 1000
  /** Throws before a predicate is switched off and reported. */
  var MAX_THROWS = 3
  /** Ticks a step waits for the `after`/`before` it names before giving up. */
  var DEFER_TICKS = 5
  /** The patch that gives the game's portrait table an identity on the global. */
  var SPEAKER_PATCH = 'smln:story-speakers'
  /**
   * The game's own re-evaluation hook, such as it is.
   *
   * A step's `{type:"custom",check}` is data, but nothing polls it: the
   * shipped evaluator runs at world load, at step start, and from three event
   * subscriptions. Two of those three do nothing but call the evaluator, and
   * `auralite:productionChanged` has exactly one listener in the whole 4.3 MB
   * bundle - that one. Emitting it therefore makes the game re-evaluate the
   * current step's predicate and, if it is true, complete the step through its
   * OWN path: the chain advance, the next box, the factory-level unblock and
   * the waypoint cleanup all happen the way they do for a vanilla step,
   * because they are the vanilla path.
   *
   * That is why step completion is not re-implemented here. Owning a copy of
   * the game's step bookkeeping would mean owning every behaviour in it,
   * including the ones whose reasons we do not know.
   *
   * The cost, stated plainly: a future build that adds a second listener to
   * this event would see it fired for a reason that is not auralite. The
   * measurement above is what makes that a small risk today, not a guess.
   */
  var NUDGE_EVENT = 'auralite:productionChanged'
  /**
   * The two speakers the shipped table defines. Used only when the table
   * itself is unreachable, so that `speaker:'zoe'` in a mod's message still
   * means ZOE rather than becoming `<mod>:zoe` on a build where the patch did
   * not apply.
   */
  var KNOWN_SPEAKERS = { zoe: true, pri: true }

  // ------------------------------------------------------- the game's table
  var mod = null
  var moduleFailure = null
  /** Keys that were in `qs` before we touched it. Never ours to overwrite. */
  var vanillaIds = null

  /**
   * Shape check rather than an id check: minified module ids are regenerated
   * on every game build, so '92659' is a hint and never a requirement. The
   * shape - a table of `titleKey`-bearing entries next to the completer and
   * the evaluator - is what actually identifies the module.
   */
  function looksLikeObjectiveModule(m) {
    if (!m || !m.qs || typeof m.qs !== 'object') return false
    if (typeof m.EM !== 'function' || typeof m.bS !== 'function') return false
    for (var k in m.qs) {
      var e = m.qs[k]
      if (e && typeof e === 'object' && typeof e.titleKey === 'string') return true
    }
    return false
  }

  /** The objectives module, or null with a reason on `moduleFailure`. */
  function objectiveModule() {
    if (mod) return mod
    if (!SMLN.webpack || typeof SMLN.webpack.find !== 'function') {
      moduleFailure = 'the webpack bridge is not installed'
      return null
    }
    var found = SMLN.webpack.find(looksLikeObjectiveModule, ['92659'])
    if (!found) {
      moduleFailure = (SMLN.webpack.why && SMLN.webpack.why()) ||
        'no module on this build carries the objectives table'
      return null
    }
    mod = found
    if (!vanillaIds) {
      vanillaIds = Object.create(null)
      for (var k in mod.qs) {
        if (Object.prototype.hasOwnProperty.call(mod.qs, k)) vanillaIds[k] = true
      }
    }
    moduleFailure = null
    return mod
  }

  function isVanillaId(id) { return !!(vanillaIds && vanillaIds[id]) }

  // ------------------------------------------------------------ bookkeeping
  /** fullId -> entry. Only ever entries this SDK put into `qs`. */
  var owned = Object.create(null)
  /** modId -> [fullId] */
  var byMod = Object.create(null)
  /** Registrations made before the table was reachable. */
  var pending = []
  /** fullId -> completion timestamp. Mirrors the saved set; see syncSave(). */
  var completed = Object.create(null)
  /** Identity of the state/store the `completed` set above was read from. */
  var savedFrom = { state: null, store: null }
  var ticker = null

  // --- the story half ---
  /** fullId -> entry. Only ever speakers this SDK put into the portrait table. */
  var ownedSpeakers = Object.create(null)
  /** modId -> [fullId] */
  var speakersByMod = Object.create(null)
  /** Speakers registered before the portrait table existed. */
  var pendingSpeakers = []
  /** Keys the portrait table already had. Never ours to shadow. */
  var vanillaSpeakers = null

  /** fullId -> entry. Only ever steps this SDK put into the step array. */
  var ownedSteps = Object.create(null)
  /** modId -> [fullId] */
  var stepsByMod = Object.create(null)
  /** Steps waiting for the game, or for the `after`/`before` they name. */
  var pendingSteps = []
  /** Ids the step array already had. A bare one of these means the game's own. */
  var vanillaSteps = null
  /** fullId -> completion timestamp. Mirrors the saved set; see syncSave(). */
  var doneSteps = Object.create(null)
  /** Events named by a `completeWhen: {event}` that have fired this session. */
  var firedEvents = Object.create(null)

  /*
   * A warning or an error also files a problem, so it reaches the Problems
   * panel and not only the log. The panel is where a player looks when a mod
   * did not do what they expected, and a dependency refusal that only ever
   * reaches a log file is invisible to exactly the person it is for.
   *
   * Fire and forget: the loader de-duplicates and caps its list, and a problem
   * that cannot be filed must not stop the SDK from working.
   */
  function report(level, modId, msg) {
    try { SMLN.log(level, 'story [' + modId + '] ' + msg) } catch (_e) { /* logging must never throw */ }
    if (level !== 'warn' && level !== 'error') return
    try {
      if (typeof SMLN.callMain !== 'function') return
      var sent = SMLN.callMain('reportProblem', {
        modId: modId, message: msg, severity: level === 'warn' ? 'warn' : 'error',
        code: 'E_STORY', scope: 'story',
      })
      if (sent && typeof sent.catch === 'function') sent.catch(function () {})
    } catch (_e) { /* the panel is a courtesy, never a dependency */ }
  }

  /**
   * A named refusal. Same shape as registration.js's `fail`: an Error with a
   * `code`, logged and returned rather than thrown, so one bad definition
   * cannot abort the mod that wrote it.
   */
  function refuse(code, modId, id, message, kind) {
    var err = new Error(message)
    err.code = code
    err.modId = modId
    err.contentId = id
    report('error', modId, (kind || 'objective') + ' "' + id + '" was not registered [' +
      code + ']: ' + message)
    return err
  }

  /**
   * Run one mod-supplied predicate. Shared by objectives and steps so there is
   * one throw-disable rule rather than two that drift apart, and so a mod's
   * throw is caught here rather than wherever the game happens to call from.
   */
  function runCheck(entry, s, kind) {
    if (!entry.check || entry.disabled) return false
    try {
      return entry.check(s) === true
    } catch (e) {
      entry.throws++
      if (entry.throws >= MAX_THROWS) {
        entry.disabled = true
        report('error', entry.modId, 'the check for ' + kind + ' "' + entry.fullId + '" threw ' +
          entry.throws + ' times and has been switched off: ' + ((e && e.message) || e))
      } else {
        report('warn', entry.modId, 'the check for ' + kind + ' "' + entry.fullId + '" threw: ' +
          ((e && e.message) || e))
      }
      return false
    }
  }

  // ------------------------------------------------------------ ids and refs
  /**
   * A registration id may not carry a namespace of its own. Allowing one
   * would let a mod aim at `other.mod:their-goal` - or at a vanilla key - by
   * writing the colon itself, which is exactly what namespacing exists to
   * prevent.
   */
  function badRegistrationId(id, kind) {
    var what = kind || 'objective'
    if (typeof id !== 'string' || !id) return 'a ' + what + ' needs a non-empty string id'
    if (id.indexOf(':') >= 0) {
      return 'ids are namespaced for you - write "' + id.split(':').pop() +
        '", not "' + id + '"'
    }
    if (/\s/.test(id)) return 'a ' + what + ' id may not contain whitespace'
    return null
  }

  /**
   * Resolve a reference the way the spec says references resolve:
   * an explicit `mod:id` means exactly that, a bare vanilla id means the
   * game's own, and anything else bare means the referring mod's.
   */
  function resolveRef(modId, ref) {
    var s = String(ref)
    if (s.indexOf(':') >= 0) return s
    // "Bare means vanilla" is only answerable once the table has been read,
    // so resolve it here rather than guessing before the game has started.
    if (!vanillaIds) objectiveModule()
    if (isVanillaId(s)) return s
    return modId + ':' + s
  }

  // ----------------------------------------------------------- dependencies
  /**
   * The mod list the loader injected, which carries `enabled` per mod.
   *
   * When it is missing, or does not contain the asking mod, it is not
   * authoritative for this context - a self-test harness, a mod loaded by
   * some other means - and refusing everything on the strength of it would
   * turn an unknown into a false accusation. Say so and register.
   */
  function missingRequirement(modId, requires) {
    if (!requires) return null
    var list = [].concat(requires)
    if (!list.length) return null

    var installed = global.__SMLN_MODS__
    if (!Array.isArray(installed) || !installed.length) {
      report('warn', modId, 'cannot check requires ' + JSON.stringify(list) +
        ': this context has no mod list, so the dependency was assumed present')
      return null
    }
    var known = Object.create(null)
    for (var i = 0; i < installed.length; i++) {
      var m = installed[i]
      if (m && m.id) known[m.id] = m.enabled !== false
    }
    if (!Object.prototype.hasOwnProperty.call(known, modId)) {
      report('warn', modId, 'is not in the loader\'s mod list, so requires ' +
        JSON.stringify(list) + ' could not be checked and was assumed satisfied')
      return null
    }
    for (var j = 0; j < list.length; j++) {
      var need = String(list[j])
      if (!Object.prototype.hasOwnProperty.call(known, need)) {
        return 'mod "' + modId + '" requires mod "' + need + '", which is not installed'
      }
      if (!known[need]) {
        return 'mod "' + modId + '" requires mod "' + need + '", which is installed but disabled'
      }
    }
    return null
  }

  // ------------------------------------------------------------------- text
  /**
   * `title` may be a literal or a locale key - both work, because the game's
   * lookup returns the key verbatim when it is unknown.
   *
   * A key is passed through. A literal is registered under a namespaced key
   * for the current locale and English, following flux-register.js; if that
   * registration is not possible the literal itself becomes the key, which
   * renders as itself rather than as an empty row.
   */
  function textKey(key, value) {
    if (typeof value !== 'string' || !value) return undefined
    if (value.indexOf('|') >= 0) return value
    try {
      var sk = SMLN.sandkit
      if (sk && sk.i18n && typeof sk.i18n.register === 'function') {
        var table = {}
        table[key] = value
        sk.i18n.register('en', table)
        var locale = typeof sk.i18n.getLocale === 'function' ? sk.i18n.getLocale() : null
        if (locale && locale !== 'en') sk.i18n.register(locale, table)
        return key
      }
    } catch (_e) { /* fall through to the literal */ }
    return value
  }

  /**
   * The `string | {key,params}` shape the game's own messages and objective
   * labels use, from either a literal or a locale key.
   *
   * A raw string is rendered verbatim by the game's resolver, so a key must be
   * handed over as `{key}` or it would show as itself. When registration was
   * not possible the literal comes back out as a plain string, which renders
   * as itself rather than as an empty row.
   */
  function translatable(key, value, params) {
    if (value == null) return undefined
    if (typeof value === 'object') return value
    var k = textKey(key, String(value))
    if (k === undefined) return undefined
    if (k.indexOf('|') < 0) return k
    return params ? { key: k, params: params } : { key: k }
  }

  // ------------------------------------------------------------ the objective
  function makeEntry(modId, def) {
    return {
      modId: modId,
      id: def.id,
      fullId: modId + ':' + def.id,
      def: def,
      check: typeof def.check === 'function' ? def.check : null,
      throws: 0,
      disabled: false,
      registered: false,
    }
  }

  /** Put one entry into the game's table. Returns true when it landed. */
  function registerNow(entry) {
    var m = objectiveModule()
    if (!m) return false
    var qs = m.qs

    if (Object.prototype.hasOwnProperty.call(qs, entry.fullId)) {
      var mine = owned[entry.fullId]
      if (mine) {
        refuse('E_STORY_DUPLICATE_ID', entry.modId, entry.id,
          'mod "' + mine.modId + '" already registered "' + entry.fullId + '"')
      } else if (isVanillaId(entry.fullId)) {
        refuse('E_STORY_VANILLA_ID', entry.modId, entry.id,
          '"' + entry.fullId + '" is one of the game\'s own objectives, and ' +
          'SandLoader never overwrites a vanilla entry')
      } else {
        refuse('E_STORY_ID_TAKEN', entry.modId, entry.id,
          '"' + entry.fullId + '" is already a key in the game\'s objective ' +
          'table and was not put there by SandLoader')
      }
      return false
    }

    var def = {
      titleKey: textKey('objectives|' + entry.fullId + '|title', entry.def.title) || entry.fullId,
      descriptionKey: textKey('objectives|' + entry.fullId + '|description', entry.def.description),
    }
    var next = entry.def.next
    if (next) {
      var refs = []
      var list = [].concat(next)
      for (var i = 0; i < list.length; i++) refs.push(resolveRef(entry.modId, list[i]))
      if (refs.length) def.nextObjectives = refs
    }

    // No `check` in the table: see the header. The predicate is ours to run.
    try {
      qs[entry.fullId] = def
    } catch (e) {
      refuse('E_STORY_TABLE_REFUSED', entry.modId, entry.id,
        'the game\'s objective table refused the entry: ' + ((e && e.message) || e))
      return false
    }

    owned[entry.fullId] = entry
    ;(byMod[entry.modId] || (byMod[entry.modId] = [])).push(entry.fullId)
    entry.registered = true
    report('info', entry.modId, 'objective registered as "' + entry.fullId + '"')
    return true
  }

  /** Try every queued registration. Anything refused is dropped, not retried. */
  function flush() {
    if (!pending.length) return
    if (!objectiveModule()) return
    var queue = pending
    pending = []
    for (var i = 0; i < queue.length; i++) registerNow(queue[i])
  }

  /**
   * A chain that names something nobody registered is the silent failure this
   * SDK exists to prevent: the game pushes an unknown id into the active list,
   * where it renders as a raw string and can never be completed, because the
   * completer refuses an id its table does not define.
   *
   * Checked once per entry, on the first tick after it registers - by then
   * every mod in the prelude has run, and a hot-reloaded mod gets its own
   * first tick later.
   */
  function checkRefs(entry) {
    if (entry.refsChecked) return
    entry.refsChecked = true
    var m = mod
    var def = m && m.qs[entry.fullId]
    var refs = def && def.nextObjectives
    if (!refs) return
    for (var i = 0; i < refs.length; i++) {
      if (Object.prototype.hasOwnProperty.call(m.qs, refs[i])) continue
      report('warn', entry.modId, '"' + entry.fullId + '" chains to "' + refs[i] +
        '", which nothing has registered - the game will show it as a raw id and ' +
        'can never complete it')
    }
  }

  // ------------------------------------------------------- the active list
  function activeList(s) {
    var o = s && s.store && s.store.objectives
    return o && Array.isArray(o.active) ? o.active : null
  }

  function activeEntry(s, fullId) {
    var list = activeList(s)
    if (!list) return null
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === fullId) return list[i]
    }
    return null
  }

  /**
   * An objective the player cannot see is not an objective. `qs` only
   * defines; the panel renders `store.objectives.active`, which the game
   * seeds once at tutorial end and thereafter only chains into. So the SDK
   * adds its own ids, and re-adds them after a world load - except the ones
   * it already knows are complete, which would otherwise reappear as
   * unfinished to-dos.
   */
  function ensureActive(entry, s) {
    if (completed[entry.fullId]) return
    var list = activeList(s)
    if (!list) return
    if (activeEntry(s, entry.fullId)) return
    var m = objectiveModule()
    if (m && typeof m.Rp === 'function') {
      try { m.Rp(s, entry.fullId); return } catch (_e) { /* fall through */ }
    }
    list.push({ id: entry.fullId, completed: false })
    try { SMLN.refreshUI() } catch (_e) {}
  }

  function removeFromActive(s, fullId) {
    var m = mod
    if (m && typeof m.J_ === 'function') {
      try { m.J_(s, fullId); return } catch (_e) { /* fall through */ }
    }
    var list = activeList(s)
    if (!list) return
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i] && list[i].id === fullId) list.splice(i, 1)
    }
  }

  // --------------------------------------------------------------- durability
  /**
   * Re-read the saved set whenever the state or its store is replaced - which
   * is what a world load looks like from here. A union would be wrong: two
   * saves have two different sets of finished missions, and carrying one into
   * the other would hand the player completions they never earned.
   *
   * MEASURED, and its limit: the save is written wholesale as
   * `Object.assign({}, state.store)` with no field whitelist, so a top-level
   * key of our own does travel out to disk. That the same key comes back on
   * load is inferred from that same wholesale shape and has NOT been measured
   * against a real save round trip - if a future check finds the loader
   * rebuilding the store field by field, this is the line that breaks.
   */
  function syncSave(s) {
    if (!s || !s.store) return
    if (savedFrom.state === s && savedFrom.store === s.store) return
    savedFrom.state = s
    savedFrom.store = s.store
    var bag = s.store[STORE_KEY]
    completed = readSet(bag && typeof bag === 'object' ? bag.completed : null)
    doneSteps = readSet(bag && typeof bag === 'object' ? bag.steps : null)
  }

  function readSet(saved) {
    var fresh = Object.create(null)
    if (saved && typeof saved === 'object') {
      for (var k in saved) {
        if (Object.prototype.hasOwnProperty.call(saved, k) && saved[k]) fresh[k] = saved[k]
      }
    }
    return fresh
  }

  function rememberCompletion(s, fullId) {
    completed[fullId] = Date.now()
    if (!s || !s.store) return
    var bag = s.store[STORE_KEY]
    if (!bag || typeof bag !== 'object') {
      bag = { version: 1, completed: {} }
      s.store[STORE_KEY] = bag
    }
    if (!bag.completed || typeof bag.completed !== 'object') bag.completed = {}
    bag.completed[fullId] = completed[fullId]
  }

  // --------------------------------------------------------------- completion
  /**
   * The game's own completion path. State-first, as measured; the module's
   * `EM` is the fallback for a build whose `progression` namespace moved.
   */
  function gameComplete(s, fullId) {
    try {
      var fh = SMLN.game
      if (fh && fh.progression && typeof fh.progression.complete === 'function') {
        return fh.progression.complete(s, { domain: 'objective', id: fullId }) === true
      }
      var sk = SMLN.sandkit
      if (sk && sk.progression && typeof sk.progression.complete === 'function') {
        return sk.progression.complete(s, { domain: 'objective', id: fullId }) === true
      }
      var m = objectiveModule()
      if (m && typeof m.EM === 'function') return m.EM(s, fullId) === true
    } catch (e) {
      SMLN.log('warn', 'story: the game refused to complete "' + fullId + '": ' +
        ((e && e.message) || e))
    }
    return false
  }

  function completeFull(s, fullId, modId) {
    var entry = owned[fullId]
    if (entry && s) ensureActive(entry, s)
    var already = !!completed[fullId]
    rememberCompletion(s, fullId)
    var accepted = s ? gameComplete(s, fullId) : false
    if (!already) {
      if (!accepted && s) {
        report('warn', modId || (entry && entry.modId) || 'smln',
          'objective "' + fullId + '" is recorded as complete, but the game did ' +
          'not accept the completion - the panel will not show it')
      }
      try { SMLN.emit('story:complete', { id: fullId, modId: entry ? entry.modId : null }) } catch (_e) {}
    }
    return true
  }

  // ==================================================== speakers and portraits
  /**
   * The game's portrait table, once `smln:story-speakers` has adopted it onto
   * the global. Null until the game bundle has evaluated - and null forever on
   * a build where that one anchor stopped resolving.
   */
  function speakerTable() {
    var t = global.__SMLN__ && global.__SMLN__.storySpeakers
    if (!t || typeof t !== 'object') return null
    if (!vanillaSpeakers) {
      vanillaSpeakers = Object.create(null)
      for (var k in t) {
        if (Object.prototype.hasOwnProperty.call(t, k) && !ownedSpeakers[k]) vanillaSpeakers[k] = true
      }
    }
    return t
  }

  function isVanillaSpeaker(id) {
    if (vanillaSpeakers) return !!vanillaSpeakers[id]
    return !!KNOWN_SPEAKERS[id]
  }

  /**
   * Did the patch definitively fail? The main process reports every anchor it
   * could not resolve and the prelude injects that report, so this is a fact
   * rather than a timeout - and it lets `speaker()` refuse the moment a mod
   * calls it, instead of accepting a face that would never be worn.
   */
  function speakerPatchBroken() {
    try {
      var boot = global.__SMLN_BOOT__
      var broken = boot && boot.anchors && boot.anchors.broken
      if (!Array.isArray(broken)) return false
      for (var i = 0; i < broken.length; i++) {
        if (broken[i] && broken[i].id === SPEAKER_PATCH) return true
      }
    } catch (_e) { /* no report is not a failed report */ }
    return false
  }

  /**
   * A portrait is a `<img src>` and nothing else - it never reaches PixiJS -
   * so a data URL and a path under the game's own `dist/` are equally valid.
   * A bare path is resolved through the mod's own asset folder first, because
   * that is the one a mod controls.
   */
  function portraitUrl(modId, portrait) {
    var p = String(portrait)
    if (/^(?:data:|blob:|https?:)/i.test(p)) return p
    try {
      if (SMLN.assets && typeof SMLN.assets.forMod === 'function') {
        var url = SMLN.assets.forMod(modId).tryUrl(p)
        if (url) return url
      }
    } catch (_e) { /* fall through to the raw path */ }
    // Not one of this mod's own files. The game's own portraits are plain
    // paths under dist/, so the string is left to resolve the same way - said
    // out loud, because a typo here renders as a broken image and nothing else.
    report('info', modId, 'portrait "' + p + '" is not one of this mod\'s assets, so it ' +
      'will be loaded as a path relative to the game\'s own dist/ folder')
    return p
  }

  function registerSpeakerNow(table, entry) {
    if (Object.prototype.hasOwnProperty.call(table, entry.fullId)) {
      refuse('E_STORY_ID_TAKEN', entry.modId, entry.id,
        '"' + entry.fullId + '" is already a key in the game\'s portrait table',
        'speaker')
      return false
    }
    var def = entry.def
    var name = typeof def.name === 'string' && def.name ? def.name : entry.id
    var colour = typeof def.color === 'string' && def.color ? def.color : '#ffe700'
    table[entry.fullId] = {
      portrait: portraitUrl(entry.modId, def.portrait),
      labelKey: textKey('story|speaker|' + entry.fullId, name) || entry.fullId,
      borderColor: def.borderColor || colour,
      labelColor: def.labelColor || colour,
    }
    ownedSpeakers[entry.fullId] = entry
    ;(speakersByMod[entry.modId] || (speakersByMod[entry.modId] = [])).push(entry.fullId)
    entry.registered = true
    report('info', entry.modId, 'speaker registered as "' + entry.fullId + '"')
    return true
  }

  /**
   * @param {boolean} afterBoot true once the game bundle has certainly run, so
   *   a table that is still missing is a missing patch rather than a missing
   *   game - which is the difference between refusing and waiting.
   */
  function flushSpeakers(afterBoot) {
    if (!pendingSpeakers.length) return
    var table = speakerTable()
    var queue = pendingSpeakers
    if (!table) {
      if (!afterBoot) return
      pendingSpeakers = []
      for (var i = 0; i < queue.length; i++) {
        refuse('E_STORY_NO_SPEAKER_TABLE', queue[i].modId, queue[i].id,
          'the game\'s portrait table never appeared, so the ' + SPEAKER_PATCH +
          ' patch is not in this build - and an unregistered speaker is silently ' +
          'drawn as ZOE, so the portrait was not registered rather than left to ' +
          'wear someone else\'s face', 'speaker')
      }
      return
    }
    pendingSpeakers = []
    for (var j = 0; j < queue.length; j++) registerSpeakerNow(table, queue[j])
  }

  // ========================================================== steps and beats
  /**
   * The live step array, by reference. Never cached: `setSteps` replaces the
   * array outright and the game calls it on every world load, so a held
   * reference would silently become last world's list.
   */
  function stepTable() {
    var p = (SMLN.game && SMLN.game.progression) || (SMLN.sandkit && SMLN.sandkit.progression)
    if (!p || typeof p.getSteps !== 'function') return null
    var steps
    try { steps = p.getSteps(SMLN.getState()) } catch (_e) { return null }
    if (!Array.isArray(steps)) return null
    if (!vanillaSteps) {
      vanillaSteps = Object.create(null)
      for (var i = 0; i < steps.length; i++) {
        if (steps[i] && steps[i].id && !ownedSteps[steps[i].id]) vanillaSteps[steps[i].id] = true
      }
    }
    return steps
  }

  function indexOfStep(steps, id) {
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] && steps[i].id === id) return i
    }
    return -1
  }

  /** Same rule as objective references: a bare vanilla id means the game's own. */
  function resolveStepRef(modId, ref) {
    var s = String(ref)
    if (s.indexOf(':') >= 0) return s
    if (!vanillaSteps) stepTable()
    if (vanillaSteps && vanillaSteps[s]) return s
    return modId + ':' + s
  }

  function resolveSpeakerRef(modId, ref) {
    if (ref == null) return undefined
    var s = String(ref)
    if (s.indexOf(':') >= 0) return s
    if (isVanillaSpeaker(s)) return s
    return modId + ':' + s
  }

  /** `store.mods.storyProgression` - the object `FH.storage.ensure` returns. */
  function storyBag(s, create) {
    if (!s || !s.store) return null
    var mods = s.store.mods
    if (!mods) {
      if (!create) return null
      mods = s.store.mods = {}
    }
    var bag = mods.storyProgression
    if (!bag) {
      if (!create) return null
      bag = mods.storyProgression = {}
    }
    return bag
  }

  function gameStepDone(bag, id) {
    return !!(bag && Array.isArray(bag.completedSteps) && bag.completedSteps.indexOf(id) >= 0)
  }

  function rememberStep(s, fullId) {
    if (!doneSteps[fullId]) doneSteps[fullId] = Date.now()
    if (!s || !s.store) return
    var bag = s.store[STORE_KEY]
    if (!bag || typeof bag !== 'object') {
      bag = { version: 1, completed: {} }
      s.store[STORE_KEY] = bag
    }
    if (!bag.steps || typeof bag.steps !== 'object') bag.steps = {}
    bag.steps[fullId] = doneSteps[fullId]
  }

  /**
   * A beat that already played must not play again. The game's own three
   * guards are what stop the replay and they are left exactly as they are -
   * but they all read `completedSteps`, and the SDK's own record is what makes
   * sure this mod's id is still in there after the step array has been rebuilt
   * and the entry re-inserted. Restoring our own id is not fighting the game's
   * bookkeeping; it is the same re-application the mission half does.
   */
  function restoreStep(s, fullId) {
    if (!doneSteps[fullId]) return
    var bag = storyBag(s, true)
    if (!bag) return
    if (!Array.isArray(bag.completedSteps)) bag.completedSteps = []
    if (bag.completedSteps.indexOf(fullId) < 0) bag.completedSteps.push(fullId)
  }

  // ----------------------------------------------------------- the step entry
  function buildMessages(entry) {
    var out = []
    var src = entry.def.messages
    var shows = false
    for (var i = 0; i < src.length; i++) {
      var m = src[i] && typeof src[i] === 'object' ? src[i] : { text: src[i] }
      var msg = {}
      var key = 'story|steps|' + entry.fullId + '|message' + (i + 1)
      var text = translatable(key, m.text, m.params)
      if (text !== undefined) msg.text = text
      var sp = resolveSpeakerRef(entry.modId, m.speaker)
      if (sp) msg.speaker = sp
      if (m.showObjective != null) {
        msg.showObjective = !!m.showObjective
        if (msg.showObjective) shows = true
      }
      if (m.style) msg.style = m.style
      if (m.characterSwitch != null) msg.characterSwitch = !!m.characterSwitch
      if (m.type) msg.type = m.type
      var done = translatable(key + 'Completed', m.completedText)
      if (done !== undefined) msg.completedText = done
      out.push(msg)
    }
    // Showing a box is not starting a step: the step becomes current only when
    // the player reaches a message with `showObjective`, or dismisses the box.
    // A step that never becomes current can never complete, and the chain stops
    // there - so the last message carries it unless the mod said otherwise.
    if (!shows && out.length) out[out.length - 1].showObjective = true
    return out
  }

  /**
   * `{type:"custom"}` with the SDK's guarded predicate on it, never the mod's
   * own. The game's evaluator does not catch, and it calls this from inside its
   * own event handlers - so a mod's throw has to be stopped here.
   */
  function customObjective(entry) {
    var o = { type: 'custom', check: function (s) { return runCheck(entry, s, 'step') } }
    if (typeof entry.def.radius === 'number') o.radius = entry.def.radius
    return o
  }

  function buildObjective(entry) {
    var cw = entry.def.completeWhen
    if (typeof cw === 'function') {
      entry.check = cw
      return customObjective(entry)
    }
    if (cw && typeof cw === 'object') {
      // Data the game completes on its own. Nothing for the SDK to drive.
      if (typeof cw.factoryLevel === 'number') {
        return { type: 'factoryLevel', target: cw.factoryLevel }
      }
      if (cw.waypoint && typeof cw.waypoint === 'object') {
        entry.waypoint = cw.waypoint
        return { type: 'waypoint', radius: cw.waypoint.radius || 100 }
      }
      // Predicates the SDK ticks.
      if (typeof cw.check === 'function') {
        entry.check = cw.check
        return customObjective(entry)
      }
      if (typeof cw.objective === 'string') {
        var ref = resolveRef(entry.modId, cw.objective)
        entry.completeRef = ref
        entry.check = function () { return !!completed[ref] }
        return customObjective(entry)
      }
      if (typeof cw.event === 'string') {
        var ev = cw.event.indexOf(':') >= 0 ? cw.event : entry.modId + ':' + cw.event
        entry.completeEvent = ev
        entry.offEvent = SMLN.on(ev, function () { firedEvents[ev] = true })
        entry.check = function () { return !!firedEvents[ev] }
        return customObjective(entry)
      }
      report('warn', entry.modId, 'step "' + entry.fullId + '" has a completeWhen the SDK does ' +
        'not recognise, so it will complete as soon as it is read')
    }
    // A dialogue-only beat. It completes the moment it starts, because a step
    // with no completion condition stops the whole story dead behind it.
    entry.check = function () { return true }
    return customObjective(entry)
  }

  function buildStepEntry(entry) {
    if (entry.built) return entry.built
    var def = entry.def
    var out = { id: entry.fullId, messages: buildMessages(entry) }
    var objective = buildObjective(entry)
    if (objective) out.objective = objective
    var label = translatable('story|steps|' + entry.fullId + '|objectiveLabel', def.objectiveLabel)
    if (label !== undefined) out.objectiveLabel = label
    var desc = translatable('story|steps|' + entry.fullId + '|objectiveDescription', def.objectiveDescription)
    if (desc !== undefined) out.objectiveDescription = desc
    if (def.blocksFactoryLevel != null) out.blocksFactoryLevel = !!def.blocksFactoryLevel
    if (def.requireAccept != null) out.requireAccept = !!def.requireAccept
    if (typeof def.notificationDelayMs === 'number') out.notificationDelayMs = def.notificationDelayMs
    entry.built = out
    return out
  }

  // -------------------------------------------------------------- insertion
  /**
   * Put one step into the live array at the index its `after`/`before` names.
   *
   * Chaining is array order, so the chain heals itself: inserting at
   * `indexOf(after)+1` leaves the previous step leading into this one and this
   * one leading into whatever used to follow. Nothing else has to be rewritten.
   *
   * @param {boolean} force insert at the end even though the named step is not
   *   there. Only the caller knows whether it has waited long enough.
   * @returns {boolean} true when the step landed.
   */
  function insertStep(steps, entry, force) {
    var at = -1
    var named = null
    if (entry.def.after != null) {
      named = resolveStepRef(entry.modId, entry.def.after)
      var a = indexOfStep(steps, named)
      if (a >= 0) at = a + 1
    }
    if (at < 0 && entry.def.before != null) {
      var b = resolveStepRef(entry.modId, entry.def.before)
      if (named === null) named = b
      var bi = indexOfStep(steps, b)
      if (bi >= 0) at = bi
    }
    if (at < 0) {
      if (named !== null && !force) return false
      at = steps.length
    }
    var built = buildStepEntry(entry)
    steps.splice(at, 0, built)
    ownedSteps[entry.fullId] = entry
    var list = stepsByMod[entry.modId] || (stepsByMod[entry.modId] = [])
    if (list.indexOf(entry.fullId) < 0) list.push(entry.fullId)
    if (!entry.registered) {
      entry.registered = true
      report('info', entry.modId, 'step registered as "' + entry.fullId + '" at position ' + at)
    }
    return true
  }

  /**
   * Insert everything that can be inserted, re-inserting anything the game's
   * own `setSteps` dropped - it rebuilds the array from its private literal on
   * every world load, and a mod's entry is not in that literal.
   *
   * The queue is retried to a fixpoint rather than once, so a step naming
   * another mod's step lands whatever order the two registered in. Load order
   * is not something a mod author can control, so it must not be something
   * they have to reason about.
   */
  function flushSteps(afterBoot) {
    var steps = stepTable()
    if (!steps) return
    for (var k in ownedSteps) {
      if (!Object.prototype.hasOwnProperty.call(ownedSteps, k)) continue
      if (indexOfStep(steps, k) >= 0) continue
      if (pendingSteps.indexOf(ownedSteps[k]) < 0) pendingSteps.push(ownedSteps[k])
    }
    if (!pendingSteps.length) return

    var queue = pendingSteps
    pendingSteps = []
    var moved = true
    while (moved) {
      moved = false
      var left = []
      for (var i = 0; i < queue.length; i++) {
        if (insertStep(steps, queue[i], false)) moved = true
        else left.push(queue[i])
      }
      queue = left
    }

    // Whatever is left names something nobody has registered.
    for (var j = 0; j < queue.length; j++) {
      var entry = queue[j]
      if (!afterBoot) { pendingSteps.push(entry); continue }
      entry.waited++
      if (entry.waited < DEFER_TICKS) { pendingSteps.push(entry); continue }
      if (!entry.missingReported) {
        entry.missingReported = true
        var named = entry.def.after != null
          ? resolveStepRef(entry.modId, entry.def.after)
          : resolveStepRef(entry.modId, entry.def.before)
        report('warn', entry.modId, 'step "' + entry.fullId + '" is ordered against "' + named +
          '", which nothing has registered - it was put at the end of the story instead')
      }
      insertStep(steps, entry, true)
    }
  }

  // ------------------------------------------------------------- evaluation
  /**
   * A waypoint objective carries its radius on the entry but not its position:
   * the game reads that out of the save. So the SDK writes it there, into the
   * same key the game's own steps use.
   */
  function applyWaypoint(s, entry) {
    if (!entry.waypoint || entry.waypointApplied) return
    var w = entry.waypoint
    if (typeof w.x !== 'number' || typeof w.y !== 'number') return
    var bag = storyBag(s, true)
    if (!bag) return
    if (!bag.objectivePositions || typeof bag.objectivePositions !== 'object') {
      bag.objectivePositions = {}
    }
    bag.objectivePositions[entry.fullId] = { x: w.x, y: w.y }
    entry.waypointApplied = true
  }

  /**
   * A speaker the portrait table does not know is drawn as ZOE and nothing
   * says so. Checked once per step, on the first pass after the table is
   * reachable - by then every mod in the prelude has registered its speakers.
   */
  function checkStepSpeakers(entry) {
    if (entry.speakersChecked) return
    var table = speakerTable()
    if (!table) return
    entry.speakersChecked = true
    var msgs = entry.built && entry.built.messages
    if (!msgs) return
    for (var i = 0; i < msgs.length; i++) {
      var sp = msgs[i].speaker
      if (!sp || Object.prototype.hasOwnProperty.call(table, sp)) continue
      report('warn', entry.modId, 'step "' + entry.fullId + '" message ' + (i + 1) +
        ' names speaker "' + sp + '", which nothing has registered - the game draws an ' +
        'unknown speaker as ZOE without saying so')
    }
  }

  /** Keep the SDK's record and the game's in step, in both directions. */
  function syncSteps(s) {
    var bag = storyBag(s, false)
    for (var id in ownedSteps) {
      if (!Object.prototype.hasOwnProperty.call(ownedSteps, id)) continue
      var entry = ownedSteps[id]
      if (!entry.registered) continue
      checkStepSpeakers(entry)
      applyWaypoint(s, entry)
      if (gameStepDone(bag, id)) rememberStep(s, id)
      else restoreStep(s, id)
    }
  }

  /**
   * Complete the current step, if it is ours and its predicate says so.
   *
   * Only the current step, because that is the only one the game's evaluator
   * looks at - which is the same rule the game plays by, not a limitation
   * introduced here.
   */
  function driveStep(s) {
    var bag = storyBag(s, false)
    var current = bag && bag.currentStep
    if (!current) return
    var entry = ownedSteps[current]
    if (!entry || !entry.registered || entry.disabled) return
    if (gameStepDone(bag, current)) return
    if (!entry.check) return
    if (!runCheck(entry, s, 'step')) return

    var events = (SMLN.game && SMLN.game.events) || (SMLN.sandkit && SMLN.sandkit.events)
    if (!events || typeof events.emit !== 'function') {
      if (!entry.driveReported) {
        entry.driveReported = true
        report('warn', entry.modId, 'step "' + entry.fullId + '" is ready to complete, but this ' +
          'build exposes no event bus to run the game\'s own step evaluator with')
      }
      return
    }
    try {
      events.emit(s, NUDGE_EVENT, {})
    } catch (e) {
      report('warn', entry.modId, 'the game refused to re-evaluate "' + entry.fullId + '": ' +
        ((e && e.message) || e))
      return
    }

    if (gameStepDone(storyBag(s, false), current)) {
      rememberStep(s, current)
      report('info', entry.modId, 'step "' + entry.fullId + '" completed')
      try { SMLN.emit('story:step', { id: current, modId: entry.modId }) } catch (_e) {}
      try { SMLN.refreshUI() } catch (_e) {}
    } else if (!entry.driveReported) {
      entry.driveReported = true
      report('warn', entry.modId, 'step "' + entry.fullId + '" met its completion condition, but ' +
        'the game did not complete it - the story will not advance past this beat')
    }
  }

  // --------------------------------------------------------------- the tick
  /**
   * One bounded pass. Everything the SDK does on its own initiative happens
   * here, in this order: the saved set first, so durability is re-applied
   * before any predicate can run and re-decide something already decided.
   */
  function tick() {
    var s = SMLN.getState()
    if (!s || !s.store) return
    syncSave(s)
    flush()

    for (var fullId in owned) {
      if (!Object.prototype.hasOwnProperty.call(owned, fullId)) continue
      var entry = owned[fullId]
      if (!entry.registered) continue
      checkRefs(entry)
      if (completed[fullId]) continue

      // Something else finished it: a chained nextObjectives, another mod, or
      // the game's own hard-coded completion. Record it rather than letting
      // the five-second deletion erase the fact.
      var live = activeEntry(s, fullId)
      if (live && live.completed) { rememberCompletion(s, fullId); continue }

      ensureActive(entry, s)
      if (runCheck(entry, s, 'objective')) completeFull(s, fullId, entry.modId)
    }

    // The story half rides the same pass, in the same order and for the same
    // reason: what is already recorded is re-applied before anything is
    // allowed to decide it again.
    flushSpeakers(true)
    flushSteps(true)
    syncSteps(s)
    driveStep(s)
  }

  function startTicking() {
    if (ticker) return
    ticker = global.setInterval(function () {
      try { tick() } catch (e) {
        SMLN.log('error', 'story: the objective tick threw: ' + ((e && e.message) || e))
      }
    }, TICK_MS)
    // Node hands back a Timeout rather than a number, and an un-unref'd one
    // keeps the self-test process alive after its assertions are done.
    if (ticker && typeof ticker.unref === 'function') ticker.unref()
  }

  function stopTicking() {
    if (!ticker) return
    global.clearInterval(ticker)
    ticker = null
  }

  // ------------------------------------------------------------------ cleanup
  /**
   * Undo everything a mod registered. Called from the disposal path that
   * already exists - `SMLN.forMod(id).onDispose`, drained by
   * `SMLN.__disposeMod` - rather than from a second teardown of our own.
   *
   * Removing the ids from `store.objectives.active` matters as much as
   * removing them from `qs`: an id left in the active list of a save whose
   * mod is gone is permanent, because the game refuses to complete an id its
   * table no longer defines.
   */
  function unregisterMod(modId) {
    var ids = byMod[modId] || []
    var s = SMLN.getState()
    var m = mod
    for (var i = 0; i < ids.length; i++) {
      var fullId = ids[i]
      if (s) { try { removeFromActive(s, fullId) } catch (_e) {} }
      if (m && m.qs) { try { delete m.qs[fullId] } catch (_e) {} }
      delete owned[fullId]
    }
    delete byMod[modId]
    // What this loop deliberately does NOT touch is the saved completed set.
    // A player who turns a mod off and on again must not have to replay its
    // missions, so the record of what they finished outlives the registration
    // that produced it. The same goes for the step record below.

    var keep = []
    for (var p = 0; p < pending.length; p++) {
      if (pending[p].modId !== modId) keep.push(pending[p])
    }
    pending = keep

    var speakers = unregisterSpeakers(modId)
    var steps = unregisterSteps(modId)

    if (ids.length) report('info', modId, 'removed ' + ids.length + ' objective(s)')
    if (speakers) report('info', modId, 'removed ' + speakers + ' speaker(s)')
    if (steps) report('info', modId, 'removed ' + steps + ' step(s)')
    if (!anythingOwned()) stopTicking()
    return ids.length + speakers + steps
  }

  function unregisterSpeakers(modId) {
    var ids = speakersByMod[modId] || []
    var table = speakerTable()
    for (var i = 0; i < ids.length; i++) {
      if (table) { try { delete table[ids[i]] } catch (_e) {} }
      delete ownedSpeakers[ids[i]]
    }
    delete speakersByMod[modId]
    pendingSpeakers = pendingSpeakers.filter(function (e) { return e.modId !== modId })
    return ids.length
  }

  /**
   * Taking a step out splices its neighbours back together, so the chain that
   * ran through it runs straight past it again - which is the whole reason
   * insertion never rewrote anything else.
   */
  function unregisterSteps(modId) {
    var ids = stepsByMod[modId] || []
    var steps = stepTable()
    for (var i = 0; i < ids.length; i++) {
      var entry = ownedSteps[ids[i]]
      if (entry && typeof entry.offEvent === 'function') {
        try { entry.offEvent() } catch (_e) {}
      }
      if (steps) {
        var at = indexOfStep(steps, ids[i])
        if (at >= 0) steps.splice(at, 1)
      }
      delete ownedSteps[ids[i]]
    }
    delete stepsByMod[modId]
    pendingSteps = pendingSteps.filter(function (e) { return e.modId !== modId })
    return ids.length
  }

  function anythingOwned() {
    var k
    for (k in owned) { if (owned[k]) return true }
    for (k in ownedSpeakers) { if (ownedSpeakers[k]) return true }
    for (k in ownedSteps) { if (ownedSteps[k]) return true }
    return !!(pending.length || pendingSpeakers.length || pendingSteps.length)
  }

  // -------------------------------------------------------------- the surface
  function makeStory(modId, facade) {
    var story = {
      /** The namespace every id this mod registers is written under. */
      modId: modId,

      /**
       * Register an objective.
       *
       * @param {Object} def
       * @param {string} def.id            bare; registers as `<modId>:<id>`
       * @param {string} [def.title]       literal text or an i18n key
       * @param {string} [def.description] literal text or an i18n key
       * @param {(state:any)=>boolean} [def.check]  ticked by the SDK
       * @param {string[]} [def.next]      ids chained on completion
       * @param {string[]} [def.requires]  mods that must be installed+enabled
       * @returns {boolean} false if refused; true if registered or queued
       *   until the game is ready
       */
      objective: function (def) {
        if (!def || typeof def !== 'object') {
          refuse('E_STORY_BAD_DEF', modId, String(def), 'an objective needs a definition object')
          return false
        }
        var bad = badRegistrationId(def.id)
        if (bad) {
          refuse('E_STORY_BAD_ID', modId, String(def.id), bad)
          return false
        }
        var missing = missingRequirement(modId, def.requires)
        if (missing) {
          refuse('E_STORY_MISSING_DEPENDENCY', modId, def.id, missing)
          return false
        }

        var entry = makeEntry(modId, def)
        if (owned[entry.fullId]) {
          refuse('E_STORY_DUPLICATE_ID', modId, def.id,
            'mod "' + owned[entry.fullId].modId + '" already registered "' + entry.fullId + '"')
          return false
        }
        for (var i = 0; i < pending.length; i++) {
          if (pending[i].fullId === entry.fullId) {
            refuse('E_STORY_DUPLICATE_ID', modId, def.id,
              '"' + entry.fullId + '" is already queued for registration')
            return false
          }
        }

        pending.push(entry)
        startTicking()
        flush()
        // Registered now, or still queued because the game has not started.
        // Either way the mod's definition was accepted; a refusal at flush
        // time is reported against this mod by name.
        return entry.registered || pending.indexOf(entry) >= 0
      },

      /**
       * Mark an objective complete: in the SDK's durable set first, then
       * through the game's own completion API.
       *
       * A bare id means this mod's own unless it is one of the game's.
       */
      complete: function (id) {
        var fullId = resolveRef(modId, id)
        var s = SMLN.getState()
        if (s) syncSave(s)
        if (!owned[fullId]) {
          var m = objectiveModule()
          if (!m || !Object.prototype.hasOwnProperty.call(m.qs, fullId)) {
            report('error', modId, 'cannot complete "' + fullId +
              '": no objective is registered under that id')
            return false
          }
        }
        return completeFull(s, fullId, modId)
      },

      /**
       * Has it been completed? The SDK's own set is the answer for anything
       * the SDK registered, because the game deletes a completed entry about
       * five seconds later and keeps no record of it.
       */
      isComplete: function (id) {
        var fullId = resolveRef(modId, id)
        var s = SMLN.getState()
        if (s) syncSave(s)
        if (completed[fullId]) return true
        var live = s ? activeEntry(s, fullId) : null
        return !!(live && live.completed)
      },

      /**
       * Publish `<modId>:<name>` on SandLoader's own bus, which any mod can
       * listen to. The emitting mod needs to know nothing about who listens.
       */
      emit: function (name, payload) {
        var event = String(name)
        if (event.indexOf(':') < 0) event = modId + ':' + event
        return SMLN.emit(event, payload)
      },

      /**
       * Listen. Goes through the facade's own `on`, so the subscription is
       * torn down with the mod like every other one it makes.
       */
      on: function (event, fn) {
        return facade.on(String(event), fn)
      },
    }

    // ------------------------------------------------------------ the story
    /**
     * Register a speaker: a face, a name and a colour for the dialogue box.
     *
     * Registers as `<modId>:<id>`, which is also how a message names it -
     * `speaker: 'kira'` in this mod's own step resolves to `my.mod:kira`,
     * while `speaker: 'zoe'` still means the game's ZOE and cannot be
     * shadowed.
     *
     * @param {string} id                bare; registers as `<modId>:<id>`
     * @param {Object} def
     * @param {string} def.portrait      a data: URL, or a path to one of this
     *   mod's own assets. Anything else is taken as a path under the game's
     *   dist/ folder, the way the game's own portraits are.
     * @param {string} [def.name]        literal text or an i18n key
     * @param {string} [def.color]       frame and label colour
     * @param {string} [def.borderColor] overrides `color` for the frame
     * @param {string} [def.labelColor]  overrides `color` for the label
     * @param {string[]} [def.requires]  mods that must be installed+enabled
     * @returns {boolean} false if refused; true if registered or queued until
     *   the game bundle has run
     */
    story.speaker = function (id, def) {
      var d = def && typeof def === 'object' ? def : {}
      var bad = badRegistrationId(id, 'speaker')
      if (bad) {
        refuse('E_STORY_BAD_ID', modId, String(id), bad, 'speaker')
        return false
      }
      if (typeof d.portrait !== 'string' || !d.portrait) {
        refuse('E_STORY_NO_PORTRAIT', modId, id,
          'a speaker needs a portrait - a data: URL, or a path to one of this ' +
          'mod\'s own assets', 'speaker')
        return false
      }
      var missing = missingRequirement(modId, d.requires)
      if (missing) {
        refuse('E_STORY_MISSING_DEPENDENCY', modId, id, missing, 'speaker')
        return false
      }
      // The one refusal that is about the build rather than the definition. An
      // unknown speaker is drawn as ZOE with no error anywhere, so registering
      // one that cannot reach the portrait table would be the silent failure
      // this SDK exists to prevent.
      if (speakerPatchBroken()) {
        refuse('E_STORY_NO_SPEAKER_TABLE', modId, id,
          'the ' + SPEAKER_PATCH + ' anchor did not resolve on this build, so the ' +
          'portrait cannot be registered - an unregistered speaker is silently ' +
          'drawn as ZOE, so nothing was registered rather than a face that would ' +
          'never be worn', 'speaker')
        return false
      }

      var fullId = modId + ':' + id
      if (ownedSpeakers[fullId]) {
        refuse('E_STORY_DUPLICATE_ID', modId, id,
          '"' + fullId + '" is already registered', 'speaker')
        return false
      }
      for (var i = 0; i < pendingSpeakers.length; i++) {
        if (pendingSpeakers[i].fullId === fullId) {
          refuse('E_STORY_DUPLICATE_ID', modId, id,
            '"' + fullId + '" is already queued for registration', 'speaker')
          return false
        }
      }

      var entry = { modId: modId, id: id, fullId: fullId, def: d, registered: false }
      pendingSpeakers.push(entry)
      startTicking()
      flushSpeakers(false)
      return entry.registered || pendingSpeakers.indexOf(entry) >= 0
    }

    /**
     * Register a story beat: an ordered list of dialogue boxes, and what
     * finishes it.
     *
     * `messages` keeps the game's own field names, because they are the
     * vocabulary the game's own steps are written in and a second one would
     * only have to be translated back.
     *
     * @param {Object} def
     * @param {string} def.id            bare; registers as `<modId>:<id>`
     * @param {string} [def.after]       insert after this step
     * @param {string} [def.before]      insert before this step
     * @param {Array} def.messages       `{text, speaker?, showObjective?,
     *   style?, characterSwitch?, type?, completedText?, params?}`; `text` is
     *   a literal or an i18n key
     * @param {Object|Function} [def.completeWhen]  one of
     *   `{factoryLevel:N}`, `{waypoint:{x,y,radius}}`, `{objective:'id'}`,
     *   `{event:'mod:name'}`, `{check:fn}`, or a function. Omitted, the beat
     *   completes as soon as the player has read it.
     * @param {string} [def.objectiveLabel]        literal text or an i18n key
     * @param {string} [def.objectiveDescription]  literal text or an i18n key
     * @param {boolean} [def.blocksFactoryLevel]
     * @param {boolean} [def.requireAccept]
     * @param {number} [def.notificationDelayMs]
     * @param {string[]} [def.requires]  mods that must be installed+enabled
     * @returns {boolean} false if refused; true if inserted or queued
     */
    story.step = function (def) {
      if (!def || typeof def !== 'object') {
        refuse('E_STORY_BAD_DEF', modId, String(def), 'a step needs a definition object', 'step')
        return false
      }
      var bad = badRegistrationId(def.id, 'step')
      if (bad) {
        refuse('E_STORY_BAD_ID', modId, String(def.id), bad, 'step')
        return false
      }
      if (!Array.isArray(def.messages) || !def.messages.length) {
        refuse('E_STORY_NO_MESSAGES', modId, def.id,
          'a step needs at least one message - the messages are the beat', 'step')
        return false
      }
      var missing = missingRequirement(modId, def.requires)
      if (missing) {
        refuse('E_STORY_MISSING_DEPENDENCY', modId, def.id, missing, 'step')
        return false
      }

      var fullId = modId + ':' + def.id
      if (ownedSteps[fullId]) {
        refuse('E_STORY_DUPLICATE_ID', modId, def.id, '"' + fullId + '" is already registered', 'step')
        return false
      }
      for (var i = 0; i < pendingSteps.length; i++) {
        if (pendingSteps[i].fullId === fullId) {
          refuse('E_STORY_DUPLICATE_ID', modId, def.id,
            '"' + fullId + '" is already queued for registration', 'step')
          return false
        }
      }

      var entry = {
        modId: modId, id: def.id, fullId: fullId, def: def,
        check: null, throws: 0, disabled: false, registered: false, waited: 0,
      }
      pendingSteps.push(entry)
      startTicking()
      flushSteps(false)
      return entry.registered || pendingSteps.indexOf(entry) >= 0
    }

    /**
     * Has this beat played? The SDK's own record is the answer, because the
     * array the game guards with is rebuilt from its private literal on every
     * world load and a mod's id is not in that literal.
     */
    story.isStepComplete = function (id) {
      var fullId = resolveStepRef(modId, id)
      var s = SMLN.getState()
      if (s) syncSave(s)
      return !!doneSteps[fullId] || gameStepDone(storyBag(s, false), fullId)
    }

    return story
  }

  // ------------------------------------------------- attach to every facade
  /**
   * `SMLN.forMod` already hands each mod its own surface and already knows
   * how to reclaim it. Wrapping it is how `.story` joins that surface without
   * a second registry of mods, and `facade.onDispose` is how registration is
   * undone - the disposal path exists, so it is used rather than rebuilt.
   */
  var baseForMod = SMLN.forMod
  function forModWithStory(modId, capability) {
    var facade = baseForMod(modId, capability)
    if (facade && !facade.story) {
      try {
        facade.story = makeStory(facade.modId || modId, facade)
        if (typeof facade.onDispose === 'function') {
          facade.onDispose(function () { unregisterMod(facade.modId || modId) })
        }
      } catch (e) {
        SMLN.log('error', 'story: could not attach the SDK to mod "' + modId + '": ' +
          ((e && e.message) || e))
      }
    }
    return facade
  }
  SMLN.forMod = forModWithStory

  // Facades handed out before this part installed would otherwise never get
  // a `.story`; forMod returns the cached object, so asking again attaches it.
  try {
    if (typeof SMLN.__facades === 'function') {
      var existing = SMLN.__facades()
      for (var f = 0; f < existing.length; f++) forModWithStory(existing[f])
    }
  } catch (_e) { /* nothing handed out yet */ }

  // The saved set has to be back in memory before the first evaluation, and a
  // world load is the moment it changes. Both capture phases re-fire on a
  // reload, so this is the load hook the loader already has.
  SMLN.whenReady(function () {
    var s = SMLN.getState()
    if (s) syncSave(s)
    flush()
    // The game bundle has run by now, so a portrait table that is still
    // missing is a missing patch rather than a game that has not started.
    flushSpeakers(true)
    flushSteps(false)
    if (anythingOwned()) startTicking()
  })
  SMLN.on('game:started', function () {
    var s = SMLN.getState()
    if (s) syncSave(s)
    // A world load rebuilds the step array from the game's own literal, so
    // anything of ours has to go back in before the first beat can chain.
    flushSteps(false)
  })

  /** Exposed for the self-test and diagnostics, not for mods. */
  SMLN.__story = {
    tick: tick,
    stop: stopTicking,
    start: startTicking,
    storeKey: STORE_KEY,
    tickMs: TICK_MS,
    maxThrows: MAX_THROWS,
    entries: function () {
      var out = []
      for (var k in owned) {
        if (!Object.prototype.hasOwnProperty.call(owned, k)) continue
        out.push({
          fullId: k, modId: owned[k].modId, id: owned[k].id,
          disabled: owned[k].disabled, throws: owned[k].throws,
        })
      }
      return out
    },
    pending: function () { return pending.length },
    completed: function () {
      var out = []
      for (var k in completed) if (completed[k]) out.push(k)
      return out
    },
    table: function () { var m = objectiveModule(); return m ? m.qs : null },
    why: function () { return moduleFailure },
    unregisterMod: unregisterMod,

    deferTicks: DEFER_TICKS,
    speakerPatch: SPEAKER_PATCH,
    nudgeEvent: NUDGE_EVENT,
    speakerTable: speakerTable,
    stepTable: stepTable,
    speakers: function () { return Object.keys(ownedSpeakers) },
    steps: function () { return Object.keys(ownedSteps) },
    pendingSpeakers: function () { return pendingSpeakers.length },
    pendingSteps: function () { return pendingSteps.length },
    doneSteps: function () {
      var out = []
      for (var k in doneSteps) if (doneSteps[k]) out.push(k)
      return out
    },
  }

  SMLN.log('info', 'story SDK installed (objectives, speakers, steps)')
})(typeof globalThis !== 'undefined' ? globalThis : window)
