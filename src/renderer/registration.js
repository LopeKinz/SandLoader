/* eslint-env browser */
'use strict'
/**
 * SandLoader's gameplay registration API: `SMLN.register` and `SMLN.assets`.
 *
 * Sandustry already has a complete content registry - the object the bundle
 * calls `FH`. This file does not reimplement any of it. It sits on top and
 * fixes the four things that make FH awkward to call from a mod:
 *
 *   1. `FH` does not exist until the game emits `game:ready`, so a mod that
 *      registers at load time has to invent its own queue. Here it just works.
 *   2. Almost every FH function is state-first (`FH.elements.register(state,
 *      def)`) and a handful are not. Getting that wrong throws deep inside the
 *      engine with no hint about which call was wrong.
 *   3. FH throws. One bad definition takes out whatever ran it, which - when
 *      mods are concatenated into one script - can be several other mods.
 *   4. FH has no idea who registered what, so nothing can attribute a failure
 *      to a mod or clean up after one.
 *
 * CALLING CONVENTIONS, verified against the real 0.5.4 bundle (module 53601):
 *
 *   state-first:  elements.register(state, def) -> {elementType}
 *                 terrains.register(state, def) -> {cellType}
 *                 matters.register(state, def)  -> {matterType}
 *                 structures.register(state, def, opts?)
 *                 items.register(state, def)
 *                 misc/projectiles.register(state, def)
 *                 triggers.register(state, id, def)
 *                 sprites.load(state, id, path, opts?) -> Promise
 *                 conveyors.registerType(state, structureId, opts)
 *                 launchers.registerType(state, def)
 *                 energy.registerType(state, structureId, kind, opts)
 *                 input.registerKeyBinding(state, id, keys, opts)
 *                 hooks.on(state, hookId, fn, opts?) -> unsubscribe
 *
 *   NOT state-first:  i18n.register(locale, translations)
 *                     i18n.t(key, params)
 *                     queue.registerHandler(type, fn)
 *
 * Two facts worth knowing before writing a mod against this:
 *
 *   - `FH.items.register` reads `state.sandkit.graphics[def.sprite.id]` and
 *     throws if the sprite has not been loaded yet. The queue below is
 *     therefore drained *sequentially*, not with Promise.all, so a sprite load
 *     queued before an item is finished before the item is registered.
 *   - Passing a `name` string on a definition makes the game derive a
 *     translation key (`elements|<id>|name`) and register the English fallback
 *     for you. That is the game's own behaviour, not something added here.
 *
 * RECIPES: Sandustry 0.5.4 has no recipe registry. `api.structures.recipes`
 * exists only in the newer Sandkit v1 (the mods branch). `register.recipe` is
 * therefore feature-detected and rejects with a clear message on this build
 * rather than pretending to have worked.
 */
;(function installSmlnRegistration(global) {
  var SMLN = global.__SMLN__
  if (!SMLN || SMLN.register) return

  /** Extensions the asset resolver will hand out a URL for. */
  var ASSET_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.mp3', '.ogg', '.wav', '.json']

  /** Queued work, drained in order once FH exists. */
  var queue = []
  var draining = false
  var drained = false

  /** "type id" -> {owner, type, id} */
  var registry = Object.create(null)
  /** modId -> entries */
  var byOwner = Object.create(null)
  var stats = { registered: 0, failed: 0 }
  var warnedUnknownOwner = false
  var workerFlushTimer = null

  /** Content mirrored into the simulation workers by Sandustry's registries. */
  var WORKER_CONTENT = { matter: true, element: true, terrain: true, structure: true }

  function fh() { return SMLN.game }
  function state() { return SMLN.getState() }

  /**
   * The game performs its own registry flush before `game:ready`, while this
   * API intentionally drains at `game:ready`. Debounce a second flush after a
   * successful content registration so renderer mods are visible to the
   * simulation workers as well as the main thread.
   */
  function scheduleWorkerFlush(contentType) {
    if (!WORKER_CONTENT[contentType]) return
    if (workerFlushTimer) global.clearTimeout(workerFlushTimer)
    workerFlushTimer = global.setTimeout(function () {
      workerFlushTimer = null
      try {
        if (SMLN.official && typeof SMLN.official.flushModRegistries === 'function') {
          SMLN.official.flushModRegistries()
        }
      } catch (e) {
        SMLN.log('error', 'could not flush registered mod content to the simulation workers: ' +
          ((e && e.message) || String(e)))
      }
    }, 50)
  }

  function fail(code, modId, contentType, contentId, message) {
    var err = new Error(message)
    err.code = code
    err.modId = modId
    err.contentType = contentType
    err.contentId = contentId
    SMLN.log('error', 'registration failed [' + modId + '] ' + contentType +
      ' "' + contentId + '": ' + message)
    stats.failed++
    return err
  }

  function remember(modId, type, id) {
    var k = type + '\u0000' + id
    registry[k] = { owner: modId, type: type, id: id }
    ;(byOwner[modId] || (byOwner[modId] = [])).push({ type: type, id: id })
    stats.registered++
  }

  /**
   * Duplicate detection against both our own index and, where the game
   * exposes it, the live registry - so a collision with a built-in or with an
   * official mod is caught too, not just a collision between SMLN mods.
   */
  function duplicate(modId, type, id, sandkitKey) {
    var k = type + '\u0000' + id
    if (registry[k]) {
      return 'id "' + id + '" is already registered as a ' + type +
        ' by mod "' + registry[k].owner + '"'
    }
    if (sandkitKey) {
      try {
        var s = state()
        var live = s && s.sandkit && s.sandkit.mods && s.sandkit.mods[sandkitKey]
        if (live && Object.prototype.hasOwnProperty.call(live, id)) {
          return 'id "' + id + '" already exists in the game\'s ' + sandkitKey + ' registry'
        }
      } catch (_e) { /* the live registry is a bonus check, never a blocker */ }
    }
    return null
  }

  // ------------------------------------------------------------- the queue
  /**
   * Everything goes through here, before ready and after. `run` is called with
   * (FH, state) and may return a value or a promise.
   */
  function enqueue(modId, contentType, contentId, run, opts) {
    return new Promise(function (resolve, reject) {
      var job = {
        modId: modId, contentType: contentType, contentId: contentId,
        run: run, resolve: resolve, reject: reject,
        sandkitKey: opts && opts.sandkitKey,
        register: !(opts && opts.register === false),
      }
      if (drained && fh()) { execute(job) }
      else { queue.push(job); if (fh()) drain() }
    })
  }

  function execute(job) {
    var F = fh()
    var s = state()
    if (!F) {
      job.reject(fail('E_NOT_READY', job.modId, job.contentType, job.contentId,
        'the game API is not available'))
      return Promise.resolve()
    }
    if (job.register) {
      var dup = duplicate(job.modId, job.contentType, job.contentId, job.sandkitKey)
      if (dup) {
        job.reject(fail('E_DUPLICATE', job.modId, job.contentType, job.contentId, dup))
        return Promise.resolve()
      }
    }
    var out
    try {
      out = job.run(F, s)
    } catch (e) {
      job.reject(fail('E_REGISTER', job.modId, job.contentType, job.contentId,
        (e && e.message) || String(e)))
      return Promise.resolve()
    }
    return Promise.resolve(out).then(
      function (value) {
        if (job.register) {
          remember(job.modId, job.contentType, job.contentId)
          scheduleWorkerFlush(job.contentType)
        }
        job.resolve(value)
      },
      function (e) {
        job.reject(fail('E_REGISTER', job.modId, job.contentType, job.contentId,
          (e && e.message) || String(e)))
      }
    )
  }

  /**
   * Drain sequentially. Order matters: a sprite load queued before an item is
   * what makes `FH.items.register` succeed, and Promise.all would race them.
   * A failing job never stops the queue - the next mod's registration is not
   * this mod's problem.
   */
  function drain() {
    if (draining) return
    draining = true
    var before = { ok: stats.registered, bad: stats.failed }

    function step() {
      if (!queue.length) {
        draining = false
        drained = true
        var ok = stats.registered - before.ok
        var bad = stats.failed - before.bad
        if (ok || bad) {
          SMLN.log(bad ? 'warn' : 'info',
            'registration flush: ' + ok + ' registered, ' + bad + ' failed')
        }
        return
      }
      var job = queue.shift()
      execute(job).then(step, step)
    }
    step()
  }

  SMLN.whenReady(function () { drain() })

  // ------------------------------------------------------------ ownership
  /**
   * Renderer mod sources are concatenated into one script, so there is no
   * per-file identity to infer an owner from. `SMLN.register.as(id)` is the
   * reliable answer, and the capability facade calls it for every mod
   * automatically, so a mod written against its injected `SMLN` is already
   * attributed without doing anything.
   */
  function ownerOf(explicit) {
    if (explicit) return explicit
    if (!warnedUnknownOwner) {
      warnedUnknownOwner = true
      SMLN.log('warn', 'a registration arrived with no owning mod - use the SMLN passed ' +
        'into your mod, or SMLN.register.as("<mod-id>"), so failures can be attributed')
    }
    return 'unknown'
  }

  // ------------------------------------------------------- the public calls
  function makeApi(modId, isRoot) {
    var owner = isRoot ? 'unknown' : ownerOf(modId)

    function simple(contentType, nsName, fnName, sandkitKey) {
      return function (def, extra) {
        var id = def && def.id
        if (!id) {
          return Promise.reject(fail('E_INVALID', owner, contentType, String(id),
            'the definition needs an "id"'))
        }
        return enqueue(owner, contentType, id, function (F, s) {
          var ns = F[nsName]
          if (!ns || typeof ns[fnName] !== 'function') {
            throw new Error('this game build has no FH.' + nsName + '.' + fnName +
              '() - ' + contentType + ' registration is unavailable')
          }
          return extra === undefined ? ns[fnName](s, def) : ns[fnName](s, def, extra)
        }, { sandkitKey: sandkitKey })
      }
    }

    var api = {
      modId: owner,

      element: simple('element', 'elements', 'register', 'elements'),
      terrain: simple('terrain', 'terrains', 'register', 'terrains'),
      matter: simple('matter', 'matters', 'register', 'matters'),
      structure: simple('structure', 'structures', 'register', 'structures'),
      item: null,   // defined below; it has to load its sprite first
      misc: simple('misc', 'misc', 'register', 'misc'),
      projectile: simple('projectile', 'projectiles', 'register', 'projectiles'),

      /**
       * Machines are structures in Sandustry - there is no separate machine
       * registry. Kept as an alias because "machine" is what mod authors look
       * for, and a missing method reads as a missing feature.
       */
      machine: simple('structure', 'structures', 'register', 'structures'),

      trigger: function (id, def) {
        return enqueue(owner, 'trigger', id, function (F, s) {
          if (!F.triggers || typeof F.triggers.register !== 'function') {
            throw new Error('this game build has no FH.triggers.register()')
          }
          return F.triggers.register(s, id, def)
        }, { sandkitKey: 'triggers' })
      },

      sprite: function (id, pathOrUrl, opts) {
        return enqueue(owner, 'sprite', id, function (F, s) {
          if (!F.sprites || typeof F.sprites.load !== 'function') {
            throw new Error('this game build has no FH.sprites.load()')
          }
          var url = resolveAsset(owner, pathOrUrl)
          if (url.error) throw new Error(url.error)
          return F.sprites.load(s, id, url.url, opts || {})
        })
      },

      keyBinding: function (id, keys, opts) {
        return enqueue(owner, 'keyBinding', id, function (F, s) {
          if (!F.input || typeof F.input.registerKeyBinding !== 'function') {
            throw new Error('this game build has no FH.input.registerKeyBinding()')
          }
          return F.input.registerKeyBinding(s, id, keys || [], opts || {})
        })
      },

      conveyorType: function (structureId, opts) {
        return enqueue(owner, 'conveyorType', structureId, function (F, s) {
          if (!F.conveyors || typeof F.conveyors.registerType !== 'function') {
            throw new Error('this game build has no FH.conveyors.registerType()')
          }
          // The game propagates this to the simulation threads itself
          // (verified: registerType calls simulation.postAll with
          // RegisterConveyorType), so SMLN must not post it a second time.
          return F.conveyors.registerType(s, structureId, opts || {})
        })
      },

      launcherType: function (def) {
        var id = (def && (def.upType || def.id)) || 'launcher'
        return enqueue(owner, 'launcherType', id, function (F, s) {
          if (!F.launchers || typeof F.launchers.registerType !== 'function') {
            throw new Error('this game build has no FH.launchers.registerType()')
          }
          // Also self-propagating: it posts RegisterLauncherType to every
          // simulation thread and to the manager.
          return F.launchers.registerType(s, def)
        })
      },

      energyType: function (structureId, kind, opts) {
        return enqueue(owner, 'energyType', structureId, function (F, s) {
          if (!F.energy || typeof F.energy.registerType !== 'function') {
            throw new Error('this game build has no FH.energy.registerType()')
          }
          return F.energy.registerType(s, structureId, kind, opts || {})
        })
      },

      /**
       * Not available on 0.5.4. Feature-detected rather than faked: a mod that
       * silently does nothing is worse than one that says why.
       */
      recipe: function (kind, def) {
        var id = (def && def.id) || String(kind)
        return enqueue(owner, 'recipe', id, function (F, s) {
          var recipes = F.structures && F.structures.recipes
          if (!recipes || typeof recipes.register !== 'function') {
            throw new Error('this Sandustry build has no recipe registry ' +
              '(FH.structures.recipes is absent; it exists only in the newer Sandkit v1) - ' +
              'recipe "' + id + '" was not registered')
          }
          return recipes.register(s, kind, def)
        })
      },

      hook: function (hookId, fn, opts) {
        return enqueue(owner, 'hook', hookId, function (F, s) {
          if (!F.hooks || typeof F.hooks.on !== 'function') {
            throw new Error('this game build has no FH.hooks.on()')
          }
          var guarded = function () {
            try { return fn.apply(null, arguments) }
            catch (e) {
              SMLN.log('error', 'hook "' + hookId + '" from mod "' + owner +
                '" threw: ' + (e && e.message), e && e.stack)
            }
          }
          var o = opts || {}
          if (!o.modId) o.modId = owner
          return F.hooks.on(s, hookId, guarded, o)
        }, { register: false })
      },

      translations: makeTranslations(owner),

      /** Rebind to another mod id; the capability facade uses this. */
      as: function (id) { return makeApi(id) },
    }

    /**
     * Items need their sprite in `state.sandkit.graphics` first, so a
     * definition naming a mod-relative sprite path gets the load queued ahead
     * of the registration. Queue order plus sequential draining is what makes
     * that reliable.
     */
    api.item = function (def) {
      var id = def && def.id
      if (!id) {
        return Promise.reject(fail('E_INVALID', owner, 'item', String(id),
          'the definition needs an "id"'))
      }
      var sprite = def && def.sprite
      var pending = Promise.resolve()
      if (sprite && sprite.id && sprite.path) {
        pending = api.sprite(sprite.id, sprite.path, sprite.options)
      }
      return pending.then(function () {
        return enqueue(owner, 'item', id, function (F, s) {
          if (!F.items || typeof F.items.register !== 'function') {
            throw new Error('this game build has no FH.items.register()')
          }
          return F.items.register(s, def)
        }, { sandkitKey: 'items' })
      })
    }

    return api
  }

  // ---------------------------------------------------------- translations
  /**
   * `FH.i18n.register(locale, flatMap)` - one call per locale, and NOT
   * state-first. Keys without a `|` are namespaced under the mod so two mods
   * cannot fight over "name"; a key that already contains `|` is passed
   * through untouched, which is how a mod deliberately overrides a game string.
   */
  function makeTranslations(owner) {
    function register(a, b) {
      var modId = owner
      var table = a
      if (typeof a === 'string') { modId = a; table = b }
      if (!table || typeof table !== 'object') {
        return Promise.reject(fail('E_INVALID', modId, 'translations', '(all)',
          'expected an object of {locale: {key: text}}'))
      }

      var locales = Object.keys(table)
      if (locales.indexOf('en') < 0) {
        SMLN.log('warn', 'mod "' + modId + '" registered translations for ' +
          locales.join(', ') + ' but no "en" - English is the fallback locale, ' +
          'so keys will show untranslated for everyone else')
      }

      var jobs = locales.map(function (locale) {
        return enqueue(modId, 'translations', locale, function (F) {
          if (!F.i18n || typeof F.i18n.register !== 'function') {
            throw new Error('this game build has no FH.i18n.register()')
          }
          var entries = table[locale]
          if (!entries || typeof entries !== 'object') {
            throw new Error('translations for "' + locale + '" are not an object')
          }
          var out = {}
          for (var key in entries) {
            if (!Object.prototype.hasOwnProperty.call(entries, key)) continue
            var full = key.indexOf('|') >= 0 ? key : 'mod|' + modId + '|' + key
            out[full] = String(entries[key])
          }
          // Not state-first. Verified in the bundle: register:(e,t)=>od(e,t).
          return F.i18n.register(locale, out)
        }, { register: false })
      })

      // One bad locale must not lose the others.
      return Promise.all(jobs.map(function (p) {
        return p.then(function (v) { return { ok: true, value: v } },
          function (e) { return { ok: false, error: e } })
      })).then(function (results) {
        return {
          registered: results.filter(function (r) { return r.ok }).length,
          failed: results.filter(function (r) { return !r.ok }).map(function (r) { return r.error }),
        }
      })
    }

    /** A miss returns the key, never `undefined`. */
    register.get = function (key, params) {
      var F = fh()
      try {
        if (F && F.i18n && typeof F.i18n.t === 'function') {
          var full = key.indexOf('|') >= 0 ? key : 'mod|' + owner + '|' + key
          var out = F.i18n.t(full, params)
          if (typeof out === 'string' && out && out.indexOf('[MISSING:') !== 0) return out
        }
      } catch (_e) { /* fall through to the key */ }
      return key
    }

    return register
  }

  // ---------------------------------------------------------------- assets
  /**
   * Mod assets are served by the main-process interceptor, which already owns
   * every `file://` request under the game's dist directory. A mod's folder is
   * exposed at a virtual path under dist, so a URL built here resolves through
   * the same code path as a game asset - no second server, no protocol
   * registration, no CORS.
   *
   * `__SMLN_MOD_ASSETS__` is injected by the prelude: {modId: {baseUrl}}.
   */
  function resolveAssetRaw(modId, rel) {
    if (typeof rel !== 'string' || !rel) {
      return { error: 'mod "' + modId + '": the asset path is empty' }
    }
    // An absolute URL is the mod's own business; pass it through untouched.
    if (/^(https?:|data:|blob:)/i.test(rel)) return { url: rel }

    if (rel.indexOf('\u0000') >= 0) {
      return { error: 'mod "' + modId + '": the asset path contains a NUL byte' }
    }
    if (rel.indexOf('\\') >= 0) {
      return { error: 'mod "' + modId + '": use forward slashes in asset paths ("' + rel + '")' }
    }
    if (rel.charAt(0) === '/' || /^[A-Za-z]:/.test(rel)) {
      return { error: 'mod "' + modId + '": absolute asset paths are refused ("' + rel + '")' }
    }

    // Normalise and re-check: "a/../../b" only escapes after normalisation.
    var parts = rel.split('/')
    var stack = []
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i]
      if (seg === '' || seg === '.') continue
      if (seg === '..') {
        if (!stack.length) {
          return { error: 'mod "' + modId + '": the asset path escapes the mod folder ("' + rel + '")' }
        }
        stack.pop()
        continue
      }
      stack.push(seg)
    }
    if (!stack.length) return { error: 'mod "' + modId + '": the asset path resolves to nothing' }
    var clean = stack.join('/')

    var dot = clean.lastIndexOf('.')
    var ext = dot >= 0 ? clean.slice(dot).toLowerCase() : ''
    if (ASSET_EXTENSIONS.indexOf(ext) < 0) {
      return {
        error: 'mod "' + modId + '": "' + rel + '" is not a supported asset type (' +
          ASSET_EXTENSIONS.join(' ') + ')',
      }
    }

    var table = global.__SMLN_MOD_ASSETS__ || {}
    var entry = table[modId]
    if (!entry || !entry.baseUrl) {
      return {
        error: 'mod "' + modId + '" has no asset folder registered - ' +
          'SandLoader publishes one only for mods it discovered on disk',
      }
    }
    return { url: entry.baseUrl.replace(/\/+$/, '') + '/' + clean }
  }

  var assetCache = Object.create(null)
  function resolveAsset(modId, rel) {
    var k = modId + '\u0000' + rel
    if (assetCache[k]) return assetCache[k]
    var out = resolveAssetRaw(modId, rel)
    assetCache[k] = out
    return out
  }

  var assets = {
    resolve: function (modId, rel) {
      var r = resolveAsset(modId, rel)
      if (r.error) throw new Error(r.error)
      return r.url
    },
    forMod: function (modId) {
      return {
        url: function (rel) { return assets.resolve(modId, rel) },
        tryUrl: function (rel) { return resolveAsset(modId, rel).url || null },
      }
    },
    /** Unscoped form; the owner has to be named. */
    url: function (modId, rel) { return assets.resolve(modId, rel) },
    extensions: ASSET_EXTENSIONS.slice(),
  }

  // ------------------------------------------------------------------ wire
  var root = makeApi(null, true)
  root.list = function () {
    var out = []
    for (var k in registry) out.push(registry[k])
    return out
  }
  root.owned = function (modId) { return (byOwner[modId] || []).slice() }
  root.stats = function () {
    // `drained` is what separates "this mod registered nothing" from "nothing
    // has run yet": before the game emits `game:ready` every ledger is empty,
    // and a reader that cannot tell the two apart reports the first as fact.
    return {
      registered: stats.registered,
      failed: stats.failed,
      queued: queue.length,
      drained: drained,
    }
  }
  root.flush = function () { drain() }

  SMLN.register = root
  SMLN.assets = assets

  SMLN.log('info', 'registration API installed')
})(typeof globalThis !== 'undefined' ? globalThis : window)
