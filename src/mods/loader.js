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
const semver = require('./semver')
const permissions = require('./permissions')

const MANIFEST = 'smln.mod.json'

/**
 * @typedef {Object} ModDependency
 * @property {string} id
 * @property {string} range     Declared range; "*" for the legacy shorthand or an omitted range.
 * @property {string} raw       The exact range string as written in the manifest ("*" for legacy).
 * @property {boolean} optional True if declared under "optionalDependencies" - a missing or
 *                              incompatible optional dependency is a warning, never a reason
 *                              this mod fails to load.
 */

/**
 * @typedef {Object} Mod
 * @property {string} id
 * @property {string} name
 * @property {string} version
 * @property {string} dir
 * @property {ModDependency[]} dependencies
 * @property {string[]} dependencyIds  Just the ids from `dependencies` (required and optional
 *                                     alike), for callers that only ever needed the id list.
 * @property {number} priority   Lower loads earlier. Default 100.
 * @property {boolean} enabled
 * @property {string} [main]       Native (main-process) entrypoint; from `main` or `entrypoints.native`.
 * @property {string} [renderer]   Game (renderer) entrypoint; from `renderer` or `entrypoints.game`.
 * @property {string} [worker]     Worker entrypoint; from `entrypoints.worker`.
 * @property {{native?:string, game?:string, worker?:string}} entrypoints
 * @property {string[]} permissions   Validated permission names (see ./permissions.js).
 * @property {import('./permissions').Capability} capability
 * @property {string[]} warnings   Non-fatal manifest issues (e.g. a flat entrypoint field
 *                                 overridden by the `entrypoints` object).
 * @property {any} manifest
 */

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/

/**
 * Normalise either dependency syntax into one shape.
 *
 * Both are supported on purpose. The array form predates ranges and is what
 * every existing SMLN mod ships; rewriting those manifests to gain a feature
 * they do not use would be a breaking change for no benefit. The object form
 * is what Fluxloader manifests already use, so a mod ported from there needs
 * no edit either.
 *
 * @param {unknown} raw
 * @param {boolean} optional
 * @returns {{ok:true, deps:ModDependency[]}|{ok:false, reason:string}}
 */
function normaliseDependencies(raw, optional) {
  if (raw == null) return { ok: true, deps: [] }

  /** @type {ModDependency[]} */
  const deps = []

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'string' || !entry) {
        return { ok: false, reason: 'must be an array of mod ids, or an object of {id: versionRange}' }
      }
      deps.push({ id: entry, range: '*', raw: '*', optional })
    }
    return { ok: true, deps }
  }

  if (typeof raw === 'object') {
    for (const [id, range] of Object.entries(raw)) {
      if (typeof range !== 'string') {
        return { ok: false, reason: `the version range for "${id}" must be a string` }
      }
      const parsed = semver.parseRange(range)
      if (!parsed.ok) {
        // A range nobody can parse is rejected here rather than treated as "*".
        // Silently widening a constraint the author wrote deliberately is how
        // an incompatible dependency gets loaded anyway.
        return { ok: false, reason: `unparsable version range for "${id}": "${range}" (${parsed.reason})` }
      }
      deps.push({ id, range: range.trim() || '*', raw: range, optional })
    }
    return { ok: true, deps }
  }

  return { ok: false, reason: 'must be an array of mod ids, or an object of {id: versionRange}' }
}

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

  const required = normaliseDependencies(manifest.dependencies, false)
  if (!required.ok) return fail(`"dependencies" ${required.reason}`)
  const optional = normaliseDependencies(manifest.optionalDependencies, true)
  if (!optional.ok) return fail(`"optionalDependencies" ${optional.reason}`)
  const dependencies = [...required.deps, ...optional.deps]

  const warnings = []

  // Entrypoints. The flat `main`/`renderer` fields are the original spelling;
  // the `entrypoints` object is the newer one and also carries `worker`, which
  // the flat form never had. Both are read, the object wins where they clash,
  // and the clash is reported rather than silently resolved.
  const raw = manifest.entrypoints
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return fail('"entrypoints" must be an object of {game, worker, native}')
  }
  /** @type {Record<string,string|undefined>} */
  const declared = {
    native: (raw && raw.native) != null ? raw.native : manifest.main,
    game: (raw && raw.game) != null ? raw.game : manifest.renderer,
    worker: raw ? raw.worker : undefined,
  }
  if (raw && raw.native != null && manifest.main != null && raw.native !== manifest.main) {
    warnings.push('"entrypoints.native" overrides the flat "main" field')
  }
  if (raw && raw.game != null && manifest.renderer != null && raw.game !== manifest.renderer) {
    warnings.push('"entrypoints.game" overrides the flat "renderer" field')
  }

  /** @type {{native?:string, game?:string, worker?:string}} */
  const entrypoints = {}
  for (const [slot, rel] of Object.entries(declared)) {
    if (rel == null) continue
    if (typeof rel !== 'string') return fail(`"${slot}" entrypoint must be a file path`)
    const abs = path.resolve(dir, rel)
    // Keep a mod inside its own directory. Manifest paths are untrusted input.
    if (!abs.startsWith(path.resolve(dir) + path.sep)) return fail(`"${slot}" entrypoint escapes the mod directory`)
    if (!fs.existsSync(abs)) return fail(`"${slot}" entrypoint points at a missing file: ${rel}`)
    entrypoints[slot] = abs
  }

  const perms = permissions.validate(manifest.permissions, { modId: id, source: `${path.basename(dir)}/${MANIFEST}` })
  if (!perms.ok) return { ok: false, error: perms.error }

  const capability = permissions.classify({
    id,
    version: manifest.version,
    flavour: 'smln',
    permissions: perms.permissions,
    entrypoints: { native: !!entrypoints.native, game: !!entrypoints.game, worker: !!entrypoints.worker },
  })

  return {
    ok: true,
    mod: {
      id,
      name: typeof manifest.name === 'string' ? manifest.name : id,
      version: manifest.version,
      dir,
      dependencies,
      dependencyIds: dependencies.map((d) => d.id),
      priority: Number.isFinite(manifest.priority) ? Number(manifest.priority) : 100,
      enabled: manifest.enabled !== false,
      // Kept alongside `entrypoints` so every existing caller keeps working.
      main: entrypoints.native,
      renderer: entrypoints.game,
      worker: entrypoints.worker,
      entrypoints,
      permissions: perms.permissions,
      capability,
      warnings,
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
 * Order mods so dependencies load first, enforcing declared version ranges.
 *
 * Every failure is reported with a `kind` so the caller can say something
 * useful instead of "dependency problem": the fix for `missing` is to install
 * something, for `disabled` it is one click, and for `incompatible` it is a
 * different build entirely. Collapsing the three into one message has cost
 * people a lot of time in other loaders.
 *
 * Failures cascade. A mod whose dependency failed is skipped too, and its
 * error says the dependency could not be loaded rather than claiming it is
 * missing - it is right there on disk, and telling the user to install it
 * again would send them in a circle.
 *
 * `mods` is the full discovered list, disabled entries included: without them
 * the resolver cannot tell "not installed" from "installed but turned off".
 *
 * @param {Mod[]} mods
 * @returns {{order:Mod[], errors:SmlnError[], skipped:{id:string,kind:string,error:SmlnError}[]}}
 */
function resolveOrder(mods) {
  // `validate()` produces {id, range, ...} entries, but a Mod object can also
  // be built by hand - the official-mod path and the self-test both do it -
  // and those carry plain id strings. Accept either rather than making every
  // caller know which shape it holds.
  for (const mod of mods) {
    if (!Array.isArray(mod.dependencies)) { mod.dependencies = []; continue }
    mod.dependencies = mod.dependencies.map((d) =>
      typeof d === 'string' ? { id: d, range: '*', raw: '*', optional: false } : d)
    if (!Array.isArray(mod.dependencyIds)) mod.dependencyIds = mod.dependencies.map((d) => d.id)
  }

  const all = new Map(mods.map((m) => [m.id, m]))
  const enabled = mods.filter((m) => m.enabled)
  const byId = new Map(enabled.map((m) => [m.id, m]))
  /** @type {SmlnError[]} */
  const errors = []
  /** @type {{id:string,kind:string,error:SmlnError}[]} */
  const skipped = []
  /** @type {Mod[]} */
  const order = []
  const state = new Map() // id -> 'visiting' | 'ok' | 'failed'

  // Stable starting order: priority, then id, so runs are reproducible.
  const roots = [...enabled].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))

  function reject(mod, kind, message, detail) {
    const error = new SmlnError('E_DEPENDENCY', message, { detail: { mod: mod.id, kind, ...detail } })
    errors.push(error)
    skipped.push({ id: mod.id, kind, error })
    state.set(mod.id, 'failed')
    return false
  }

  function visit(mod, stack) {
    const s = state.get(mod.id)
    if (s === 'ok') return true
    if (s === 'failed') return false
    if (s === 'visiting') {
      return reject(mod, 'cycle',
        `dependency cycle: ${[...stack, mod.id].join(' -> ')}`,
        { cycle: [...stack, mod.id] })
    }
    state.set(mod.id, 'visiting')

    for (const dep of mod.dependencies) {
      const label = dep.range === '*' ? `"${dep.id}"` : `"${dep.id}" ${dep.range}`
      const installed = all.get(dep.id)
      const active = byId.get(dep.id)

      if (!installed) {
        if (dep.optional) continue
        return reject(mod, 'missing',
          `mod "${mod.id}" requires ${label}, which is not installed`,
          { dependency: dep.id, range: dep.range })
      }
      if (!active) {
        if (dep.optional) continue
        return reject(mod, 'disabled',
          `mod "${mod.id}" requires ${label}, which is installed but disabled`,
          { dependency: dep.id, range: dep.range, installedVersion: installed.version })
      }

      if (dep.range !== '*') {
        const verdict = semver.explain(active.version, dep.range)
        if (!verdict.ok) {
          if (dep.optional) continue
          const kind = verdict.code === 'E_RANGE_MALFORMED' ? 'malformed' : 'incompatible'
          const message = kind === 'malformed'
            ? `mod "${mod.id}" declares an unparsable version range for "${dep.id}": "${dep.raw}" (${verdict.reason})`
            : `mod "${mod.id}" requires ${label}, installed version is ${active.version}`
          return reject(mod, kind, message,
            { dependency: dep.id, range: dep.range, installedVersion: active.version, reason: verdict.reason })
        }
      }

      if (!visit(active, [...stack, mod.id])) {
        if (dep.optional) continue
        return reject(mod, 'dependency-failed',
          `mod "${mod.id}" requires ${label}, which could not be loaded`,
          { dependency: dep.id, range: dep.range })
      }
    }

    state.set(mod.id, 'ok')
    order.push(mod)
    return true
  }

  // Every mod is visited, so every failure is reported - not just the first.
  for (const m of roots) visit(m, [])
  return { order, errors, skipped }
}

/**
 * Load the main-process half of each mod and collect its contributions.
 *
 * A `main` entrypoint is `require`d into this process with a real `require`,
 * `process` and `Buffer`. That is the NATIVE tier: nothing SandLoader does
 * afterwards can take those back, so the gate has to be *here*, before the
 * require, and it is the user's approval that opens it.
 *
 * @param {Mod[]} order
 * @param {any} ctx    Passed to each mod's exported setup function.
 * @param {any} logger
 * @param {{isApproved?:(mod:Mod)=>boolean}} [opts]
 * @returns {{loaded:Mod[], patches:any[], errors:SmlnError[], refused:Mod[]}}
 */
function loadMain(order, ctx, logger, opts = {}) {
  const loaded = []
  const patches = []
  const errors = []
  const refused = []
  // No predicate means "the caller is not gating" - the pre-permission
  // behaviour - so existing callers keep working unchanged.
  const isApproved = typeof opts.isApproved === 'function' ? opts.isApproved : () => true

  for (const mod of order) {
    if (!mod.main) { loaded.push(mod); continue }

    if (!isApproved(mod)) {
      const err = new SmlnError('E_PERMISSION_DENIED',
        `mod "${mod.id}" runs native code in the main process and has not been approved - it was not loaded`,
        { detail: { mod: mod.id, tier: mod.capability && mod.capability.tier } })
      errors.push(err)
      refused.push(mod)
      logger.warn(String(err))
      continue
    }

    try {
      // eslint-disable-next-line import/no-dynamic-require
      const exported = require(mod.main)
      const setup = typeof exported === 'function' ? exported : exported && exported.setup
      let contributed = null
      if (typeof setup === 'function') {
        contributed = setup({ ...ctx, mod, capability: mod.capability, logger: logger.child(mod.id) })
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

  return { loaded, patches, errors, refused }
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

module.exports = {
  discover, validate, resolveOrder, loadMain, rendererScripts,
  normaliseDependencies, MANIFEST,
}
