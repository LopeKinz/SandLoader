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

  /** The registry stores plural arrays; register() takes the singular kind. */
  var SINGULAR_KIND = {
    contacts: 'contact',
    shakers: 'shaker',
    kineticPresses: 'kineticPress',
    growers: 'grower',
  }

  /** Element-valued fields, by the names the game's registry uses. */
  var RECIPE_SCALAR_FIELDS = ['inputA', 'inputB', 'outputA', 'outputB', 'input', 'output']
  var RECIPE_LIST_FIELDS = ['outputs', 'outputsAbove', 'outputsBelow']

  /**
   * Turn a translated recipe's element names into type numbers.
   *
   * An unresolvable name fails the whole recipe. Handing the registry
   * `elementType: undefined` would store a recipe that silently never fires,
   * which is worse for the player than being told it was skipped.
   */
  function resolveRecipeElements(def, resolve) {
    var out = {}
    for (var key in def) {
      if (Object.prototype.hasOwnProperty.call(def, key)) out[key] = def[key]
    }

    for (var i = 0; i < RECIPE_SCALAR_FIELDS.length; i++) {
      var f = RECIPE_SCALAR_FIELDS[i]
      if (!(f in out)) continue
      if (out[f] === null || out[f] === undefined) { out[f] = null; continue }
      var n = resolve(out[f])
      if (typeof n !== 'number') {
        return { ok: false, reason: 'no element is named "' + out[f] + '" (field ' + f + ')' }
      }
      out[f] = n
    }

    for (var j = 0; j < RECIPE_LIST_FIELDS.length; j++) {
      var lf = RECIPE_LIST_FIELDS[j]
      if (!Array.isArray(out[lf])) continue
      var list = []
      for (var k = 0; k < out[lf].length; k++) {
        var entry = out[lf][k]
        var t = resolve(entry.name)
        if (typeof t !== 'number') {
          return { ok: false, reason: 'no element is named "' + entry.name + '" (in ' + lf + ')' }
        }
        list.push({ elementType: t, chance: entry.chance })
      }
      out[lf] = list
    }

    return { ok: true, def: out }
  }

  /**
   * Build the name lookup: the vanilla table the main process sent, overlaid
   * with the mod elements the game gave a type number to in this same pass.
   * enums.ElementByName is keyed lowercase, so every lookup is normalised.
   */
  function elementNameResolver(vanilla) {
    var names = {}
    var v = vanilla || {}
    for (var vn in v) {
      if (Object.prototype.hasOwnProperty.call(v, vn)) names[String(vn).toLowerCase()] = v[vn]
    }
    var mods = (SMLN.sandkit && SMLN.sandkit.mods && SMLN.sandkit.mods.elements) || {}
    for (var mn in mods) {
      if (!Object.prototype.hasOwnProperty.call(mods, mn)) continue
      var me = mods[mn]
      var mt = me && (me.elementType || (me.element && me.element.elementType))
      if (typeof mt === 'number') names[String(mn).toLowerCase()] = mt
    }
    return function (name) { return names[String(name).toLowerCase()] }
  }

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
      var blocks = payload.blocks || []
      var techNodes = payload.tech || []
      var upgrades = payload.upgrades || []
      var unsupported = payload.unsupported || []

      // Register display names before the content itself. 0.5.5 stores a
      // `nameKey` on every element and resolves it through i18n at draw time,
      // so an unregistered key shows in-game as "[MISSING: elements|trash|name]"
      // on the hover tooltip. The definition's own `name` is the English text
      // the mod author wrote, and it is registered for the player's current
      // locale as well as English: a German client looks up `de` and would
      // otherwise miss a translation registered only under `en`.
      try {
        var sk = SMLN.sandkit
        if (sk && sk.i18n && typeof sk.i18n.register === 'function') {
          var table = {}
          var all = elements.concat(soils).concat(blocks)
          for (var n = 0; n < all.length; n++) {
            var d = all[n].def
            if (d && d.nameKey && d.name) table[d.nameKey] = d.name
          }
          if (Object.keys(table).length) {
            var locale = typeof sk.i18n.getLocale === 'function' ? sk.i18n.getLocale() : null
            sk.i18n.register('en', table)
            if (locale && locale !== 'en') sk.i18n.register(locale, table)
          }
        }
      } catch (e) {
        SMLN.log('warn', 'fluxloader display names could not be registered: ' +
          ((e && e.message) || e))
      }

      // Recipes name elements, so they have to wait for the element
      // registrations to settle - the game only knows an element's type number
      // once it has registered it. Every entry pushed here resolves rather than
      // rejects, so one bad definition cannot strand the recipes behind it.
      var contentSettled = []

      function hand(entry, register, kind) {
        // One definition failing must not take the others with it: a mod that
        // registers five elements and gets one wrong should lose that one.
        try {
          var done = register(entry.def).then(function () {
            SMLN.log('info', 'fluxloader ' + kind + ' registered: ' + entry.id)
          }, function (e) {
            SMLN.log('error', 'fluxloader ' + kind + ' "' + entry.id + '" failed: ' +
              ((e && e.message) || e))
          })
          contentSettled.push(done)
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

      // Blocks are structures here - the machines in the build inventory.
      for (var b = 0; b < blocks.length; b++) {
        hand(blocks[b], api.structure, 'block')
      }

      // Tech nodes go through the Sandkit shim rather than SMLN.register:
      // the tech tree is a grid the shim has to place a cell in, which is not
      // the flat "register a definition" shape the other content types share.
      var sandkit = SMLN.sandkit
      if (techNodes.length) {
        if (sandkit && sandkit.tech && typeof sandkit.tech.registerNode === 'function') {
          for (var t = 0; t < techNodes.length; t++) {
            try {
              var ok = sandkit.tech.registerNode(techNodes[t].def)
              SMLN.log(ok ? 'info' : 'warn', 'fluxloader tech node "' + techNodes[t].id +
                (ok ? '" registered' : '" was not placed in the tech tree'))
            } catch (e) {
              SMLN.log('error', 'fluxloader tech node "' + techNodes[t].id + '" threw: ' +
                ((e && e.message) || e))
            }
          }
        } else {
          SMLN.log('warn', 'fluxloader: this build exposes no tech registry, so ' +
            techNodes.length + ' research node(s) will not appear')
        }
      }

      // Upgrades have nowhere to go on this build. Sandkit's `upgrades`
      // namespace is read-only (getLevel / getAvailableLevel), and the bundle
      // contains no upgrade registration function at all - unlike structures
      // (registerStructure) and tech (addTechDefinition), both verified
      // present on 0.5.5. So this is a real gap in the game, not a gap in the
      // bridge, and it is reported once with the count rather than pretending
      // per entry.
      if (upgrades.length) {
        SMLN.log('warn', 'fluxloader: ' + upgrades.length + ' upgrade entr(ies) ' +
          '(tabs, categories and upgrades) were not registered - Sandustry 0.5.5 ' +
          'exposes no way to add upgrades, so they cannot appear in the upgrade menu')
      }

      /*
       * Recipes come last: they name elements, and a corelib recipe usually
       * names a corelib element that had to be registered first.
       */
      var recipes = payload.recipes || []
      if (recipes.length) {
        // Only after the elements above are in: the name lookup is built from
        // what the game handed back, and building it early is why a recipe
        // naming a mod's own element reported "no element is named Trash".
        Promise.all(contentSettled).then(function () {
          var live = SMLN.sandkit && SMLN.sandkit.structures && SMLN.sandkit.structures.recipes
          if (!live || typeof live.register !== 'function') {
            SMLN.log('warn', 'fluxloader: ' + recipes.length + ' recipe(s) were not registered - ' +
              'this build has no recipe registry (it arrived in Sandustry 0.5.6)')
            return
          }
          var resolveName = elementNameResolver(payload.elementTypes)
          for (var ri = 0; ri < recipes.length; ri++) {
            var rec = recipes[ri]
            var resolved = resolveRecipeElements(rec.def, resolveName)
            if (!resolved.ok) {
              SMLN.log('warn', 'fluxloader recipe "' + rec.id + '" was not registered: ' +
                resolved.reason)
              continue
            }
            try {
              api.recipe(SINGULAR_KIND[rec.kind] || rec.kind, resolved.def)
            } catch (e) {
              SMLN.log('warn', 'fluxloader recipe "' + rec.id + '" was rejected by the game: ' +
                ((e && e.message) || e))
            }
          }
        })
      }

      // Say what could not be done and why, rather than leaving the player to
      // discover the missing content in-game.
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
