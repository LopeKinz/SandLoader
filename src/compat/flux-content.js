'use strict'
/**
 * Routes Fluxloader content registration onto Sandustry 0.5.5's own API.
 *
 * corelib registers content by patching the game bundle. On 0.5.5 that no
 * longer works: 75 of its 92 patch anchors exist in no shipped file, because
 * the build stopped splitting into numbered chunks and the element registry
 * changed shape (`{name:"Cinder"}` became `{nameKey:"elements|basalt|name"}`
 * with a numeric matterType). Retargeting the patches would still emit entries
 * the game cannot read.
 *
 * It does not need patching. 0.5.5 ships a real registration API - Sandkit's
 * `elements.register`, `terrains.register`, `items.register`,
 * `structures.register` and friends - and SandLoader already wraps it as
 * `SMLN.register` with queuing, ownership and error isolation. So this module
 * replaces corelib's content modules with shims that capture the same calls,
 * translates each definition, and hands it to that layer instead.
 *
 * Runtime mutation of the registry object would not work: the simulation runs
 * across 18 worker threads, each with its own copy, and only the game's own
 * registration path reaches all of them.
 *
 * The mod's source is never touched, and neither is corelib's. Only the
 * objects it published are swapped, after it finished building them.
 */

const translate = require('./flux-translate')

/**
 * corelib patch ids the bridge now supplies through Sandkit. Only these are
 * dropped; every other corelib patch is left alone, so the subsystems whose
 * anchors still match this build keep working.
 */
const SUPPRESSED_PREFIXES = [
  'elements:elementRegistry',
  'elements:soilRegistry',
  'elements:filterlist',
  'elements:particleColors',
  'elements:soilsBreaksWithoutIt',
  'elements:soilsRepeated3Times',
  'elements:onlyRocketBreakable',
  'elements:noShovelHighlightForUnbreakable',
  // Block, tech and upgrade definitions now reach the game through its own
  // registries. Only the definition patches are listed: corelib's UI patches
  // (blockConfigMenu, techUI-*, upgradeUpdating) are left in place, so the
  // subsystems whose anchors still match this build keep working.
  ':blockTypeDefinitions',
  ':blockInventory',
  ':tech:definitions',
  ':upgradeDefinitions',
]

function shouldSuppress(patchId) {
  const id = String(patchId || '')
  return SUPPRESSED_PREFIXES.some((p) => id.includes(p))
}

/**
 * Swap corelib's content modules for capturing shims.
 *
 * @param {object} sandboxGlobal the shared mod global carrying `corelib`
 * @param {{modId:string, logger:any, matterEnum:object}} opts
 */
function install(sandboxGlobal, opts) {
  const o = opts || {}
  const log = o.logger
  const matterEnum = o.matterEnum || {}
  const corelib = sandboxGlobal && sandboxGlobal.corelib
  const captured = { elements: [], soils: [], blocks: [], tech: [], upgrades: [], unsupported: [] }
  const reasons = []

  if (!corelib || typeof corelib !== 'object') {
    return { ok: false, captured, reasons: ['no corelib global was published'] }
  }

  function note(kind, id, reason) {
    captured.unsupported.push({ kind, id, reason })
    log && log.warn(`${kind} "${id}" was not registered: ${reason}`)
  }

  // Read a config's id for an error record without risking a second throw:
  // this is called from inside a catch block, so if `config.id` is itself a
  // throwing getter (the thing that got us here), just fall back silently.
  function safeId(config) {
    try {
      return (config && config.id) || '?'
    } catch (_e) {
      return '?'
    }
  }

  if (corelib.elements && typeof corelib.elements === 'object') {
    // Keep the original object so anything else corelib hung on it survives;
    // only the two registration entry points are replaced.
    // Each shim captures for the bridge and then still calls corelib's own
    // register. Only the patch corelib would later emit is superseded - its
    // registry is what its other modules read back (recipes resolve element
    // ids through it), and leaving that empty breaks mods that never asked to
    // be bridged.
    const previousRegisterElement = typeof corelib.elements.registerElement === 'function'
      ? corelib.elements.registerElement.bind(corelib.elements)
      : null
    const previousRegisterSoil = typeof corelib.elements.registerSoil === 'function'
      ? corelib.elements.registerSoil.bind(corelib.elements)
      : null

    corelib.elements.registerElement = function registerElement(config) {
      // Mods call this at entrypoint top level, so nothing here may throw -
      // not even a config whose `id` is a getter that throws when read.
      try {
        const r = translate.translateElement(config, matterEnum)
        if (!r.ok) { note('element', safeId(config), r.reason) }
        else {
          captured.elements.push({ id: r.def.id, def: r.def })
          log && log.debug(`captured element ${r.def.id}`)
        }
      } catch (e) {
        note('element', safeId(config), `reading the element definition threw: ${e && e.message}`)
      }
      if (previousRegisterElement) {
        try { return previousRegisterElement(config) } catch (_e) { return false }
      }
      return true
    }
    corelib.elements.registerSoil = function registerSoil(config) {
      try {
        const r = translate.translateSoil(config, matterEnum)
        if (!r.ok) { note('soil', safeId(config), r.reason) }
        else {
          captured.soils.push({ id: r.def.id, def: r.def })
          log && log.debug(`captured soil ${r.def.id}`)
        }
      } catch (e) {
        note('soil', safeId(config), `reading the soil definition threw: ${e && e.message}`)
      }
      if (previousRegisterSoil) {
        try { return previousRegisterSoil(config) } catch (_e) { return false }
      }
      return true
    }
  } else {
    reasons.push('corelib published no elements module')
  }

  // Blocks are Sandustry's structures - the machines in the build inventory.
  // corelib keeps its own registry and installs it by patching; on this build
  // those patches match nothing, so the entries are captured and handed to the
  // game's own structure registry instead.
  if (corelib.blocks && typeof corelib.blocks === 'object') {
    const previousBlockRegister = typeof corelib.blocks.register === 'function'
      ? corelib.blocks.register.bind(corelib.blocks)
      : null
    corelib.blocks.register = function register(config) {
      try {
        const r = translate.translateBlock(config)
        if (!r.ok) { note('block', safeId(config), r.reason); return false }
        captured.blocks.push({ id: r.def.id, def: r.def })
        log && log.debug(`captured block ${r.def.id}`)
      } catch (e) {
        note('block', safeId(config), `reading the block definition threw: ${e && e.message}`)
        return false
      }
      // corelib's own register still runs: other mods call `getBlock` to read
      // back what they registered, and portals' schedules key off its registry.
      // Only the patch it would later emit is superseded, not its bookkeeping.
      if (previousBlockRegister) {
        try { return previousBlockRegister(config) } catch (_e) { /* its patches are dropped anyway */ }
      }
      return true
    }
  } else {
    reasons.push('corelib published no blocks module')
  }

  if (corelib.tech && typeof corelib.tech === 'object' && typeof corelib.tech.register === 'function') {
    const previousTechRegister = corelib.tech.register.bind(corelib.tech)
    corelib.tech.register = function register(config) {
      try {
        const r = translate.translateTech(config)
        if (!r.ok) { note('tech', safeId(config), r.reason) }
        else {
          captured.tech.push({ id: r.def.id, def: r.def })
          log && log.debug(`captured tech node ${r.def.id}`)
        }
      } catch (e) {
        note('tech', safeId(config), `reading the tech definition threw: ${e && e.message}`)
      }
      // Same reasoning as blocks and upgrades: corelib's registry backs its
      // own `getTech` lookups, so it must still be filled.
      try { return previousTechRegister(config) } catch (_e) { return false }
    }
  }

  // Tabs, categories and upgrades share one list because the renderer has to
  // rebuild the nesting in registration order - a category before its tab has
  // nothing to attach to.
  if (corelib.upgrades && typeof corelib.upgrades === 'object') {
    const UPGRADE_FNS = {
      registerTab: 'tab',
      registerCategory: 'category',
      registerUpgrade: 'upgrade',
    }
    for (const [fn, kind] of Object.entries(UPGRADE_FNS)) {
      if (typeof corelib.upgrades[fn] !== 'function') continue
      const previous = corelib.upgrades[fn].bind(corelib.upgrades)
      corelib.upgrades[fn] = function registerUpgradePart(config) {
        try {
          const r = translate.translateUpgrade(kind, config)
          if (!r.ok) { note('upgrade', safeId(config), r.reason) }
          else {
            captured.upgrades.push({ id: r.def.id, kind, def: r.def })
            log && log.debug(`captured upgrade ${kind} ${r.def.id}`)
          }
        } catch (e) {
          note('upgrade', safeId(config), `reading the upgrade definition threw: ${e && e.message}`)
        }
        // corelib's own registry still has to be filled. Mods read back what
        // they registered - refinement calls `upgrades.getUpgrade("portals",
        // ...)` to rebalance portals' costs when both are installed - and a
        // capture-only shim left that registry empty, so the lookup returned
        // undefined and took the whole mod down with it. Capturing replaces
        // the patch corelib would emit, never its bookkeeping.
        try { return previous(config) } catch (_e) { return false }
      }
    }
  }

  // Sandustry 0.5.5 has no recipe registry: `sandkit.structures.recipes` is
  // undefined, no namespace matches /recipe/i, and no module carries an
  // input/output shape. There is nothing to register into, so these are
  // recorded with the reason instead of pretending to work.
  const RECIPE_FNS = [
    'registerBasicRecipe', 'registerPressRecipe', 'registerShakerRecipe',
    'registerGrowerRecipe',
  ]
  // Same rule as safeId above: this reads config.input/config.id, either of
  // which may be a throwing getter, so it must not be able to throw itself.
  function safeRecipeId(config, fallback) {
    try {
      return String((config && (config.input || config.id)) || fallback)
    } catch (_e) {
      return fallback
    }
  }

  if (corelib.recipes && typeof corelib.recipes === 'object') {
    for (const fn of RECIPE_FNS) {
      if (typeof corelib.recipes[fn] !== 'function') continue
      corelib.recipes[fn] = function suppressedRecipe(config) {
        try {
          note('recipe', safeRecipeId(config, fn),
            'this Sandustry build has no recipe registry, so recipes cannot be ' +
            'registered by any means (verified against 0.5.5)')
        } catch (e) {
          note('recipe', fn, `reading the recipe definition threw: ${e && e.message}`)
        }
        return false
      }
    }
  }

  return { ok: true, captured, reasons }
}

module.exports = { install, shouldSuppress, SUPPRESSED_PREFIXES }
