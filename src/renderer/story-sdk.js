/* eslint-env browser */
'use strict'
/**
 * The mission half of SandLoader's story SDK: `SMLN.forMod(id).story`.
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
 * WHAT IS NOT HERE. `speaker()` and `step()` - the story half - are a separate
 * task; see the SEAM near the bottom of this file. They exist here only as
 * refusals that say so, because a mod calling one deserves a named error
 * rather than a TypeError or, worse, silence.
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
  function refuse(code, modId, id, message) {
    var err = new Error(message)
    err.code = code
    err.modId = modId
    err.contentId = id
    report('error', modId, 'objective "' + id + '" was not registered [' + code + ']: ' + message)
    return err
  }

  // ------------------------------------------------------------ ids and refs
  /**
   * A registration id may not carry a namespace of its own. Allowing one
   * would let a mod aim at `other.mod:their-goal` - or at a vanilla key - by
   * writing the colon itself, which is exactly what namespacing exists to
   * prevent.
   */
  function badRegistrationId(id) {
    if (typeof id !== 'string' || !id) return 'an objective needs a non-empty string id'
    if (id.indexOf(':') >= 0) {
      return 'ids are namespaced for you - write "' + id.split(':').pop() +
        '", not "' + id + '"'
    }
    if (/\s/.test(id)) return 'an objective id may not contain whitespace'
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
  function textKey(fullId, part, value) {
    if (typeof value !== 'string' || !value) return undefined
    if (value.indexOf('|') >= 0) return value
    var key = 'objectives|' + fullId + '|' + part
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
      titleKey: textKey(entry.fullId, 'title', entry.def.title) || entry.fullId,
      descriptionKey: textKey(entry.fullId, 'description', entry.def.description),
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
    var fresh = Object.create(null)
    var bag = s.store[STORE_KEY]
    var saved = bag && typeof bag === 'object' ? bag.completed : null
    if (saved && typeof saved === 'object') {
      for (var k in saved) {
        if (Object.prototype.hasOwnProperty.call(saved, k) && saved[k]) fresh[k] = saved[k]
      }
    }
    completed = fresh
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
      if (!entry.check || entry.disabled) continue

      var done = false
      try {
        done = entry.check(s) === true
      } catch (e) {
        entry.throws++
        if (entry.throws >= MAX_THROWS) {
          entry.disabled = true
          report('error', entry.modId, 'the check for "' + fullId + '" threw ' +
            entry.throws + ' times and has been switched off: ' + ((e && e.message) || e))
        } else {
          report('warn', entry.modId, 'the check for "' + fullId + '" threw: ' +
            ((e && e.message) || e))
        }
        continue
      }
      if (done) completeFull(s, fullId, entry.modId)
    }
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

    var keep = []
    for (var p = 0; p < pending.length; p++) {
      if (pending[p].modId !== modId) keep.push(pending[p])
    }
    pending = keep

    if (ids.length) report('info', modId, 'removed ' + ids.length + ' objective(s)')
    var any = false
    for (var k in owned) { if (owned[k]) { any = true; break } }
    if (!any && !pending.length) stopTicking()
    return ids.length
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

    // ------------------------------------------------------------------ SEAM
    // speaker() and step() belong to the story half of this SDK and are the
    // next task's work. They are named here so a mod calling one gets an
    // attributed refusal instead of a TypeError, and so the shape of what
    // replaces them is not in doubt:
    //
    //   speaker(id, {name, portrait, color})  -> needs the portrait-table
    //                                            patch; unknown speakers
    //                                            silently become ZOE today.
    //   step({id, after, messages, completeWhen}) -> getSteps()/setSteps(),
    //                                            with `after` ordering
    //                                            resolved by declaration.
    //
    // Neither is implemented. Do not make them return true.
    function notYet(what) {
      return function () {
        report('error', modId, 'story.' + what + '() is not implemented yet - it ' +
          'arrives with the story half of the SDK. Nothing was registered.')
        return false
      }
    }
    story.speaker = notYet('speaker')
    story.step = notYet('step')
    // ------------------------------------------------------------- end SEAM

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
    if (pending.length || byMod && Object.keys(byMod).length) startTicking()
  })
  SMLN.on('game:started', function () {
    var s = SMLN.getState()
    if (s) syncSave(s)
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
  }

  SMLN.log('info', 'story SDK installed (objectives; speakers and steps to follow)')
})(typeof globalThis !== 'undefined' ? globalThis : window)
