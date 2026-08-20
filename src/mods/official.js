'use strict'
/**
 * Sandustry's official mod format (`manifestVersion: 1`).
 *
 *   mods/example-mod/
 *     modinfo.json     manifest
 *     main.js          entry       - main thread
 *     worker.js        workerEntry - manager and simulation worker threads
 *     patches.json     bundle patches
 *     config/          overrides native JSON configs
 *     assets/          overrides textures
 *     map/             blueprints and config for custom maps
 *
 * Three mod manifests exist in the wild and SandLoader reads all of them:
 * this one, Fluxloader's (`modID`), and SandLoader's own `smln.mod.json`. They
 * are told apart by which keys are present, never by guessing.
 *
 * Official entrypoints are lifecycle-sensitive. Sandustry must execute the
 * main entry during world initialisation and workerEntry through its own
 * worker-only Sandkit surface. SandLoader therefore does not prepend those
 * sources to bundle.js anymore: discover() mirrors enabled official mods into
 * the game's native local-mod directory and lets Sandustry's own loader run
 * them. Patches/overrides remain handled here because SandLoader owns the file
 * interceptor on builds where the host patcher is inactive.
 */

const fs = require('fs')
const path = require('path')

const { SmlnError } = require('../core/errors')
const officialPatches = require('../patch/official')
const nativeBridge = require('./official-native')
const officialHost = require('./official-host')

const MANIFEST = 'modinfo.json'
const SUPPORTED_MANIFEST_VERSION = 1
const SUPPORTED_API_VERSION = 1

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,127}$/

/** True when this manifest is the official format rather than Fluxloader's. */
function isOfficial(json) {
  return !!json && json.manifestVersion != null
}

/**
 * @returns {{ok:true, mod:any}|{ok:false, error:SmlnError}}
 */
function readMod(dir) {
  const file = path.join(dir, MANIFEST)
  let json
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return { ok: false, error: new SmlnError('E_MANIFEST_INVALID', `${file}: ${e.message}`) }
  }

  const fail = (msg, detail) => ({
    ok: false,
    error: new SmlnError('E_MANIFEST_INVALID', `${file}: ${msg}`, { detail }),
  })

  if (!isOfficial(json)) return fail('not an official manifest (no manifestVersion)', { skip: true })

  const manifestVersion = Number(json.manifestVersion)
  if (manifestVersion !== SUPPORTED_MANIFEST_VERSION) {
    return fail(
      `manifestVersion ${json.manifestVersion} is not supported (this build reads ${SUPPORTED_MANIFEST_VERSION})`
    )
  }
  if (typeof json.id !== 'string' || !ID_RE.test(json.id)) {
    return fail('"id" must be 2-128 chars of letters, digits, dot, dash or underscore', { id: json.id })
  }
  if (typeof json.version !== 'string' || !json.version) return fail('"version" is required')

  const apiVersion = json.apiVersion == null ? SUPPORTED_API_VERSION : Number(json.apiVersion)
  if (!Number.isInteger(apiVersion) || apiVersion < 1) return fail('"apiVersion" must be a positive integer')

  const deps = json.dependencies == null ? [] : json.dependencies
  if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string')) {
    return fail('"dependencies" must be an array of mod ids')
  }

  /** Keep every declared path inside the mod folder. */
  const root = path.resolve(dir)
  const resolve = (rel, label) => {
    if (rel == null) return { ok: true, value: undefined }
    if (typeof rel !== 'string') return { ok: false, why: `"${label}" must be a path` }
    const abs = path.resolve(dir, rel)
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return { ok: false, why: `"${label}" escapes the mod directory` }
    }
    if (!fs.existsSync(abs)) return { ok: false, why: `"${label}" points at a missing file: ${rel}` }
    return { ok: true, value: abs }
  }

  const entry = resolve(json.entry, 'entry')
  if (!entry.ok) return fail(entry.why)
  const workerEntry = resolve(json.workerEntry, 'workerEntry')
  if (!workerEntry.ok) return fail(workerEntry.why)

  // configOverrides: { configId: "config/x.json" }
  const configOverrides = {}
  for (const [key, rel] of Object.entries(json.configOverrides || {})) {
    const r = resolve(rel, `configOverrides.${key}`)
    if (!r.ok) return fail(r.why)
    configOverrides[key] = r.value
  }

  // textureOverrides: { textureId: "assets/x.png" } or { textureId: {path, frameWidth, frames, intervalMs} }
  const textureOverrides = {}
  for (const [key, value] of Object.entries(json.textureOverrides || {})) {
    const spec = typeof value === 'string' ? { path: value } : value
    if (!spec || typeof spec.path !== 'string') {
      return fail(`textureOverrides.${key} needs a "path"`)
    }
    const r = resolve(spec.path, `textureOverrides.${key}.path`)
    if (!r.ok) return fail(r.why)
    textureOverrides[key] = {
      file: r.value,
      frameWidth: spec.frameWidth,
      frames: spec.frames,
      intervalMs: spec.intervalMs,
    }
  }

  // map blueprints, if this is a map mod
  let map = null
  if (json.map && typeof json.map === 'object') {
    const blueprints = {}
    for (const [key, rel] of Object.entries(json.map.blueprints || {})) {
      const r = resolve(rel, `map.blueprints.${key}`)
      if (!r.ok) return fail(r.why)
      blueprints[key] = r.value
    }
    map = { ...json.map, blueprints }
  }

  return {
    ok: true,
    mod: {
      id: json.id,
      name: typeof json.name === 'string' ? json.name : json.id,
      version: String(json.version),
      description: json.description,
      author: json.author,
      dir,
      flavour: 'official',
      apiVersion,
      dependencies: deps,
      // `loadOrder` is the official spelling of what SandLoader calls priority.
      priority: Number.isFinite(json.loadOrder) ? Number(json.loadOrder) : 0,
      enabled: json.enabled !== false,

      // These drive execution. entry.js checks `mod.entry` / `mod.workerEntry`
      // and injects them via the prelude, which wraps a main entry in
      // SMLN.official.execute() - the deferred, sandkit-aware path, not the
      // raw prepend this once was.
      //
      // They were previously forced to undefined on the theory that the native
      // bridge (official-native.js, staging into <userData>/mods) would run
      // these instead. It does not: Sandustry has no local-mod loader of its
      // own. It delegates to whatever occupies the Workshop loader slot, which
      // is SandLoader. So switching this path off meant nothing ran the mods at
      // all - staging reported success, the manager showed "Enabled", and the
      // entries were never executed. That is the "enabled but not loaded" bug.
      //
      // The staged copies are kept: they are harmless, and they are what a
      // future build with a real native loader would consume.
      entry: entry.value,
      workerEntry: workerEntry.value,
      nativeEntry: entry.value,
      nativeWorkerEntry: workerEntry.value,

      configOverrides,
      textureOverrides,
      map,
      manifest: json,
    },
  }
}

/**
 * Scan directories for official mods and make enabled ones visible to
 * Sandustry's native loader before the game renderer starts.
 *
 * @param {string[]} roots
 * @param {object} logger
 * @param {{readGameFile?:(f:string)=>string|null, workshopPath?:string|null}} [opts]
 *        Supplying `readGameFile` enables the host capability check; without it
 *        discovery behaves exactly as before and `host` comes back null.
 * @returns {{mods:any[], errors:SmlnError[], host:object|null}}
 */
function discover(roots, logger, opts = {}) {
  const mods = []
  const errors = []
  const seen = new Set()

  for (const root of roots) {
    let entries
    try {
      if (!fs.existsSync(root)) continue
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch (_) { continue }

    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue
      const dir = path.join(root, dirent.name)
      if (!fs.existsSync(path.join(dir, MANIFEST))) continue

      const r = readMod(dir)
      if (!r.ok) {
        // A Fluxloader manifest here is not an error; that loader reads it.
        if (!(r.error.detail && r.error.detail.skip)) errors.push(r.error)
        continue
      }
      if (seen.has(r.mod.id)) continue
      seen.add(r.mod.id)
      mods.push(r.mod)
      logger && logger.info(
        `official mod: ${r.mod.id}@${r.mod.version} (apiVersion ${r.mod.apiVersion})` +
        (r.mod.map ? ' [map]' : '')
      )
    }
  }

  // entry.js applies persisted enable/disable state immediately after this
  // function returns. The native bridge reads that same mods.json itself so it
  // can stage the right set *now*, before startGame() lets Sandustry discover
  // local official mods.
  const native = nativeBridge.sync(mods, { logger })
  errors.push(...native.errors)

  // Staging can succeed completely and still achieve nothing: whether the game
  // reads those copies is a property of the build, not of the copy. Check it
  // and report, so the manager stops presenting an unrunnable mod as enabled.
  //
  // Reported once for the build rather than once per mod. The cause is shared,
  // and eleven identical entries would bury the one fact that explains them.
  // The probe reads the *shipped* bundle, so a gap SandLoader itself repairs at
  // patch time still shows up here. Only gaps with no repair are real problems;
  // the rest are recorded as informational so a failed patch stays diagnosable.
  const host = inspectHost(opts)
  if (host && !host.supported && mods.length) {
    const detail = officialHost.explain(host)
    const unrepaired = host.missing.filter((m) => !m.repairedBy)

    if (unrepaired.length) {
      logger && logger.warn(detail)
      errors.push(new SmlnError(
        'E_HOST_UNSUPPORTED',
        `official mods will not run on this build: ${unrepaired.length} requirement(s) unmet ` +
        'with no SandLoader repair available',
        { detail: { host: { missing: unrepaired.map((m) => m.id), report: detail } } }
      ))
    } else {
      logger && logger.info(
        `official Sandkit gap(s) this build leaves to the host: ` +
        `${host.missing.map((m) => m.id).join(', ')} - supplied by ` +
        `${host.missing.map((m) => m.repairedBy).join(', ')}`
      )
    }
  }

  return { mods, errors, host }
}

/**
 * Run the host capability probe, tolerating every way it can be unavailable.
 *
 * discover() is called during boot on a machine we do not control; a failure
 * to *inspect* must never become a failure to *start*. Returns null when the
 * question could not be asked at all.
 */
function inspectHost(opts = {}) {
  const readFile = opts.readGameFile
  if (typeof readFile !== 'function') return null
  try {
    return officialHost.inspect(readFile, { workshopPath: opts.workshopPath || null })
  } catch (_) {
    return null
  }
}

/**
 * Collect every mod's `patches.json`.
 * @returns {{patchesByFile: Record<string, any[]>, errors: SmlnError[]}}
 */
function collectPatches(mods, logger) {
  const patchesByFile = {}
  const errors = []
  for (const mod of mods) {
    const { patchesByFile: mine, errors: mistakes } = officialPatches.load(mod.dir, mod.id)
    errors.push(...mistakes)
    mistakes.forEach((e) => logger && logger.error(String(e)))
    for (const [file, list] of Object.entries(mine)) {
      ;(patchesByFile[file] || (patchesByFile[file] = [])).push(...list)
      logger && logger.info(`${mod.id}: ${list.length} patch(es) for ${file}`)
    }
  }
  return { patchesByFile, errors }
}

/**
 * Build the redirect table the file interceptor uses to serve overrides.
 *
 * Texture ids resolve against the game's own asset folders. `dist/mods/` holds
 * the sprites of the built-in content mods, `dist/img/` the base game's, so a
 * texture id is looked for in both.
 *
 * @returns {Record<string,string>} dist-relative path -> absolute replacement
 */
function buildOverrides(mods, archiveHas, logger) {
  const redirects = {}
  const unresolved = []

  for (const mod of mods) {
    for (const [id, file] of Object.entries(mod.configOverrides || {})) {
      const candidates = [`config/${id}.json`, `js/config/${id}.json`, `${id}.json`]
      const hit = candidates.find((c) => archiveHas(c))
      if (hit) redirects[hit] = file
      else unresolved.push(`${mod.id}: config "${id}"`)
    }
    for (const [id, spec] of Object.entries(mod.textureOverrides || {})) {
      const candidates = [`img/${id}.png`, `mods/${id}.png`, `${id}.png`]
      const hit = candidates.find((c) => archiveHas(c))
      if (hit) redirects[hit] = spec.file
      else unresolved.push(`${mod.id}: texture "${id}"`)
      if (spec.frames != null && logger) {
        logger.warn(
          `${mod.id}: texture "${id}" declares animation metadata ` +
          '(frameWidth/frames/intervalMs), which needs game-side support and is not applied yet'
        )
      }
    }
  }

  if (unresolved.length && logger) {
    logger.warn(
      `${unresolved.length} override target(s) not found in this build: ${unresolved.slice(0, 6).join(', ')}` +
      (unresolved.length > 6 ? ' ...' : '')
    )
  }
  return redirects
}

module.exports = {
  discover, readMod, collectPatches, buildOverrides, isOfficial, inspectHost,
  MANIFEST, SUPPORTED_MANIFEST_VERSION, SUPPORTED_API_VERSION,
}
