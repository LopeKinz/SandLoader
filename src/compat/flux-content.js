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
  const captured = { elements: [], soils: [], unsupported: [] }
  const reasons = []

  if (!corelib || typeof corelib !== 'object') {
    return { ok: false, captured, reasons: ['no corelib global was published'] }
  }

  function note(kind, id, reason) {
    captured.unsupported.push({ kind, id, reason })
    log && log.warn(`${kind} "${id}" was not registered: ${reason}`)
  }

  if (corelib.elements && typeof corelib.elements === 'object') {
    // Keep the original object so anything else corelib hung on it survives;
    // only the two registration entry points are replaced.
    corelib.elements.registerElement = function registerElement(config) {
      const r = translate.translateElement(config, matterEnum)
      if (!r.ok) { note('element', (config && config.id) || '?', r.reason); return false }
      captured.elements.push({ id: r.def.id, def: r.def })
      log && log.debug(`captured element ${r.def.id}`)
      return true
    }
    corelib.elements.registerSoil = function registerSoil(config) {
      const r = translate.translateSoil(config, matterEnum)
      if (!r.ok) { note('soil', (config && config.id) || '?', r.reason); return false }
      captured.soils.push({ id: r.def.id, def: r.def })
      log && log.debug(`captured soil ${r.def.id}`)
      return true
    }
  } else {
    reasons.push('corelib published no elements module')
  }

  // Sandustry 0.5.5 has no recipe registry: `sandkit.structures.recipes` is
  // undefined, no namespace matches /recipe/i, and no module carries an
  // input/output shape. There is nothing to register into, so these are
  // recorded with the reason instead of pretending to work.
  const RECIPE_FNS = [
    'registerBasicRecipe', 'registerPressRecipe', 'registerShakerRecipe',
    'registerGrowerRecipe',
  ]
  if (corelib.recipes && typeof corelib.recipes === 'object') {
    for (const fn of RECIPE_FNS) {
      if (typeof corelib.recipes[fn] !== 'function') continue
      corelib.recipes[fn] = function suppressedRecipe(config) {
        const id = (config && (config.input || config.id)) || fn
        note('recipe', String(id),
          'this Sandustry build has no recipe registry, so recipes cannot be ' +
          'registered by any means (verified against 0.5.5)')
        return false
      }
    }
  }

  return { ok: true, captured, reasons }
}

module.exports = { install, shouldSuppress, SUPPRESSED_PREFIXES }
