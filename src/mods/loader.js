'use strict'
/**
 * Mod discovery, validation and load ordering.
 *
 * A mod is a directory with an `smln.mod.json` manifest. It may contribute
 * three things, all optional:
 *
 *   main     - a CommonJS module loaded in the Electron main process
 *   renderer - a script appended to the injected runtime, next to the console
 *   patches  - additional bundle patches, merged into the core patch list
 *
 * Failures are contained per mod. One bad manifest disables that mod and
 * nothing else; the loader reports it and carries on.
 */

const fs = require('fs')
const path = require('path')

const { SmlnError } = require('../core/errors')

const MANIFEST = 'smln.mod.json'

/**
 * @typedef {Object} Mod
 * @property {string} id
 * @property {string} name
 * @property {string} version
 * @property {string} dir
 * @property {string[]} dependencies
 * @property {number} priority   Lower loads earlier. Default 100.
 * @property {boolean} enabled
 * @property {string} [main]
 * @property {string} [renderer]
 * @property {any} manifest
 */

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/

/**
 * Validate a manifest object into a Mod, or explain precisely why not.
 * @returns {{ok:true, mod:Mod}|{ok:false, error:SmlnError}}
 */
function validate(manifest, dir) {
  const fail = (msg, detail) => ({
    ok: false,
    error: new SmlnError('E_MANIFEST_INVALID', `${path.basename(dir)}/${MANIFEST}: ${msg}`, { detail }),
  })

  if (!manifest || typeof manifest !== 'object') return fail('not a JSON object')
  const id = manifest.id
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    return fail('"id" must be lowercase letters, digits, dot, dash or underscore (2-64 chars)', { id })
  }
  if (typeof manifest.version !== 'string' || !manifest.version) return fail('"version" is required')

  const deps = manifest.dependencies == null ? [] : manifest.dependencies
  if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string')) {
    return fail('"dependencies" must be an array of mod ids')
  }

  for (const key of ['main', 'renderer']) {
    if (manifest[key] != null) {
      if (typeof manifest[key] !== 'string') return fail(`"${key}" must be a file path`)
      const abs = path.resolve(dir, manifest[key])
      // Keep a mod inside its own directory.
      if (!abs.startsWith(path.resolve(dir) + path.sep)) return fail(`"${key}" escapes the mod directory`)
      if (!fs.existsSync(abs)) return fail(`"${key}" points at a missing file: ${manifest[key]}`)
    }
  }

  return {
    ok: true,
    mod: {
      id,
      name: typeof manifest.name === 'string' ? manifest.name : id,
      version: manifest.version,
      dir,
      dependencies: deps,
      priority: Number.isFinite(manifest.priority) ? Number(manifest.priority) : 100,
      enabled: manifest.enabled !== false,
      main: manifest.main ? path.resolve(dir, manifest.main) : undefined,
      renderer: manifest.renderer ? path.resolve(dir, manifest.renderer) : undefined,
      manifest,
    },
  }
}

/**
 * Scan directories for mods.
 * @param {string[]} roots
 * @param {any} logger
 * @returns {{mods:Mod[], errors:SmlnError[]}}
 */
function discover(roots, logger) {
  /** @type {Mod[]} */
  const mods = []
  /** @type {SmlnError[]} */
  const errors = []
  const seen = new Map()

  for (const root of roots) {
    let entries
    try {
      if (!fs.existsSync(root)) continue
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch (e) {
      errors.push(new SmlnError('E_IO', `cannot read mod directory ${root}: ${e.message}`))
      continue
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(root, entry.name)
      const manifestPath = path.join(dir, MANIFEST)
      if (!fs.existsSync(manifestPath)) continue

      let raw
      try {
        raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      } catch (e) {
        errors.push(new SmlnError('E_MANIFEST_INVALID', `${manifestPath}: ${e.message}`))
        continue
      }

      const result = validate(raw, dir)
      if (!result.ok) { errors.push(result.error); continue }

      const mod = result.mod
      if (seen.has(mod.id)) {
        errors.push(new SmlnError('E_MANIFEST_INVALID',
          `duplicate mod id "${mod.id}" (${seen.get(mod.id)} and ${dir}) - the second one is ignored`))
        continue
      }
      seen.set(mod.id, dir)
      mods.push(mod)
      logger && logger.debug(`found mod ${mod.id}@${mod.version}${mod.enabled ? '' : ' (disabled)'}`)
    }
  }

  return { mods, errors }
}

/**
 * Order mods so dependencies load first. Reports missing dependencies and
 * cycles instead of silently producing a wrong order.
 * @param {Mod[]} mods
 * @returns {{order:Mod[], errors:SmlnError[]}}
 */
function resolveOrder(mods) {
  const enabled = mods.filter((m) => m.enabled)
  const byId = new Map(enabled.map((m) => [m.id, m]))
  /** @type {SmlnError[]} */
  const errors = []
  /** @type {Mod[]} */
  const order = []
  const state = new Map() // id -> 'visiting' | 'done'

  // Stable starting order: priority, then id, so runs are reproducible.
  const roots = [...enabled].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))

  function visit(mod, stack) {
    const s = state.get(mod.id)
    if (s === 'done') return true
    if (s === 'visiting') {
      errors.push(new SmlnError('E_DEPENDENCY',
        `dependency cycle: ${[...stack, mod.id].join(' -> ')}`, { detail: { cycle: [...stack, mod.id] } }))
      return false
    }
    state.set(mod.id, 'visiting')
    for (const depId of mod.dependencies) {
      const dep = byId.get(depId)
      if (!dep) {
        errors.push(new SmlnError('E_DEPENDENCY',
          `mod "${mod.id}" needs "${depId}", which is not installed or is disabled`,
          { detail: { mod: mod.id, missing: depId } }))
        state.set(mod.id, 'done')
        return false
      }
      if (!visit(dep, [...stack, mod.id])) { state.set(mod.id, 'done'); return false }
    }
    state.set(mod.id, 'done')
    order.push(mod)
    return true
  }

  for (const m of roots) visit(m, [])
  // Anything that failed above is absent from `order`, which is what we want.
  return { order, errors }
}

/**
 * Load the main-process half of each mod and collect its contributions.
 * @param {Mod[]} order
 * @param {any} ctx    Passed to each mod's exported setup function.
 * @param {any} logger
 * @returns {{loaded:Mod[], patches:any[], errors:SmlnError[]}}
 */
function loadMain(order, ctx, logger) {
  const loaded = []
  const patches = []
  const errors = []

  for (const mod of order) {
    if (!mod.main) { loaded.push(mod); continue }
    try {
      // eslint-disable-next-line import/no-dynamic-require
      const exported = require(mod.main)
      const setup = typeof exported === 'function' ? exported : exported && exported.setup
      let contributed = null
      if (typeof setup === 'function') {
        contributed = setup({ ...ctx, mod, logger: logger.child(mod.id) })
      }
      const modPatches = (contributed && contributed.patches) || exported.patches || []
      for (const p of modPatches) patches.push({ ...p, owner: mod.id })
      loaded.push(mod)
      logger.info(`loaded ${mod.id}@${mod.version}${modPatches.length ? ` (+${modPatches.length} patches)` : ''}`)
    } catch (e) {
      errors.push(new SmlnError('E_MOD_LOAD', `mod "${mod.id}" failed to load: ${e.message}`, { cause: e }))
      logger.error(`mod ${mod.id} failed to load`, e && e.stack)
    }
  }

  return { loaded, patches, errors }
}

/** Read the renderer-side sources of loaded mods, in load order. */
function rendererScripts(order, logger) {
  const out = []
  for (const mod of order) {
    if (!mod.renderer) continue
    try {
      out.push(`/* mod: ${mod.id}@${mod.version} */\n` + fs.readFileSync(mod.renderer, 'utf8'))
    } catch (e) {
      logger.error(`could not read renderer script of ${mod.id}: ${e.message}`)
    }
  }
  return out
}

module.exports = { discover, validate, resolveOrder, loadMain, rendererScripts, MANIFEST }
