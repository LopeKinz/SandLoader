'use strict'
/**
 * Fluxloader mod compatibility.
 *
 * SMLN is not built on Fluxloader and shares no code with it, but the mods
 * people already have should keep working. This module reads the Fluxloader
 * mod format and adapts it onto SandLoader's own machinery.
 *
 * The format (per the official MODDING.md and example mod):
 *
 *   modinfo.json
 *     modID, name, version, author, shortDescription, description,
 *     fluxloaderVersion, dependencies {id: range}, tags,
 *     electronEntrypoint, gameEntrypoint, workerEntrypoint, configSchema
 *
 *   Three environments, each receiving a global `fluxloaderAPI`:
 *     electron - main process, may register file patches
 *     game     - renderer
 *     worker   - simulation/utility worker threads
 *
 *   Patches: { type:'replace', from, to, token }
 *     `token` (default '$') marks where the matched text is spliced back in.
 *
 * Where SMLN cannot honour something exactly, it says so in the log rather
 * than pretending. Nothing here silently no-ops.
 */

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const { SmlnError } = require('../core/errors')
const permissions = require('../mods/permissions')
const semver = require('../mods/semver')
const configStore = require('../mods/config')
const fluxMessaging = require('./flux-messaging')
const flContent = require('./flux-content')
const gameEnums = require('../game/enums')

const MODINFO = 'modinfo.json'

/**
 * The matter-type table the content bridge translates against, in BOTH
 * directions.
 *
 * Fluxloader mods name a matter type ("Slushy"); 0.5.5 stores a number (6).
 * `src/game/enums.js` carries the numeric->name direction that ships with the
 * loader, so the reverse is derived here rather than asking the renderer for
 * it: the electron entrypoints run long before a window exists, and an empty
 * table is not a degraded translation but a total one - every element is
 * rejected as "matterType does not exist (valid: )" while corelib's patches
 * are dropped anyway, which is worse than not bridging at all.
 */
function matterEnum() {
  const table = {}
  const source = (gameEnums && gameEnums.MatterType) || {}
  for (const [key, value] of Object.entries(source)) {
    table[key] = value
    // Only the numeric->name entries need reversing; a table that already
    // carries both directions (the live game's) passes through unchanged.
    if (typeof value === 'string' && !(value in table)) table[value] = Number(key)
  }
  return table
}

/** What SMLN reports as its Fluxloader API level. */
const FLUXLOADER_COMPAT_VERSION = '2.0.0'

/** Renderer-bundle aliases a mod might name in addPatch(). */
const FILE_ALIASES = {
  'bundle.js': 'js/bundle.js',
  'js/bundle.js': 'js/bundle.js',
  'dist/js/bundle.js': 'js/bundle.js',
  'simulation-worker.js': 'js/simulation-worker.js',
  'js/simulation-worker.js': 'js/simulation-worker.js',
  'dist/js/simulation-worker.js': 'js/simulation-worker.js',
  'utility-worker.js': 'js/utility-worker.js',
  'js/utility-worker.js': 'js/utility-worker.js',
  'dist/js/utility-worker.js': 'js/utility-worker.js',
  'manager-worker.js': 'js/manager-worker.js',
  'js/manager-worker.js': 'js/manager-worker.js',
  'dist/js/manager-worker.js': 'js/manager-worker.js',
  'index.html': 'index.html',
}

function normaliseTarget(file) {
  const key = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '')
  return FILE_ALIASES[key] || FILE_ALIASES[key.split('/').pop()] || key
}

/**
 * Convert a Fluxloader patch descriptor into an SMLN patch.
 * @param {any} p        {type, from, to, token}
 * @param {string} owner mod id
 * @param {string} tag
 * @returns {import('../patch/engine').Patch}
 */
function toSmlnPatch(p, owner, tag) {
  const token = p.token == null ? '$' : String(p.token)
  const type = String(p.type || 'replace').toLowerCase()

  if (type === 'regex') {
    const re = p.from instanceof RegExp ? p.from : new RegExp(String(p.from), p.flags || 'g')
    return {
      id: `${owner}:${tag}`,
      owner,
      description: `fluxloader regex patch from ${owner}`,
      find: re,
      replace: String(p.to),
      expect: 'any',
      // One atomic group per mod per file. A Fluxloader mod's patches are
      // written against whichever game build its author had, and they assume
      // each other: corelib's colorIdFix rewrites buffer sizing in one patch
      // and the readers of that buffer in the next. Applying the half that
      // still matches leaves the bundle internally inconsistent - a black
      // screen - while aborting the file outright would take SandLoader's own
      // patches down with it. Grouping gives the third option the engine
      // already implements: this mod's patches for this file all land, or none
      // of them do, and everyone else's are unaffected.
      group: `flux:${owner}`,
      required: p.required === true,
    }
  }

  // Default: literal replace, with `token` standing in for the matched text.
  const from = String(p.from)
  const to = String(p.to)
  return {
    id: `${owner}:${tag}`,
    owner,
    description: `fluxloader replace patch from ${owner}`,
    find: from,
    // Splice the original text wherever the token appears. Returning a
    // function means String.replace uses the value literally, so `$&` and
    // friends inside a mod's replacement text survive untouched - no escaping
    // here, and none wanted.
    replace: () => (to.includes(token) ? to.split(token).join(from) : to),
    expect: 'any',
    // Same reasoning as the regex branch above: this mod's patches for this
    // file stand or fall together, and never take another mod's with them.
    group: `flux:${owner}`,
    required: p.required === true,
  }
}

/**
 * Read one Fluxloader mod directory.
 * @returns {{ok:true, mod:any}|{ok:false, error:SmlnError}}
 */
function readMod(dir) {
  const file = path.join(dir, MODINFO)
  let info
  try {
    info = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return { ok: false, error: new SmlnError('E_MANIFEST_INVALID', `${file}: ${e.message}`) }
  }
  if (!info || typeof info.modID !== 'string' || !info.modID) {
    return { ok: false, error: new SmlnError('E_MANIFEST_INVALID', `${file}: missing modID`) }
  }
  // The loader slot itself is not a mod.
  if (info.modID === 'fluxloader') {
    return { ok: false, error: new SmlnError('E_MANIFEST_INVALID', `${dir}: loader slot, not a mod`, { detail: { skip: true } }) }
  }

  const resolve = (rel) => {
    if (!rel) return undefined
    const abs = path.resolve(dir, rel)
    if (!abs.startsWith(path.resolve(dir) + path.sep)) return undefined
    return fs.existsSync(abs) ? abs : undefined
  }

  const entrypoints = {
    electron: resolve(info.electronEntrypoint),
    game: resolve(info.gameEntrypoint),
    worker: resolve(info.workerEntrypoint),
  }

  // Fluxloader declares dependencies as {id: range}. Keeping only the ids -
  // which is what this did before - silently loaded an incompatible library
  // mod and left the failure to surface as a runtime TypeError somewhere in
  // the dependent. The range is the whole point of declaring it.
  const dependencies = []
  const warnings = []
  if (info.dependencies && typeof info.dependencies === 'object' && !Array.isArray(info.dependencies)) {
    for (const [depId, raw] of Object.entries(info.dependencies)) {
      const declared = typeof raw === 'string' ? raw : '*'
      // Fluxloader marks a soft dependency by prefixing the range with
      // "optional:" - refinement declares `"portals": "optional:^1.0.8"`,
      // meaning "integrate with it when it is there". Reading the prefix as
      // part of the range made it both unparsable AND required, so a mod was
      // dropped for missing something it never actually needed.
      const isOptional = /^optional:/i.test(declared.trim())
      const range = isOptional ? declared.trim().replace(/^optional:/i, '') : declared
      const parsed = semver.parseRange(range)
      if (!parsed.ok) {
        warnings.push(`unparsable range for dependency "${depId}": "${range}" (${parsed.reason})`)
        dependencies.push({ id: depId, range: '*', raw: String(raw), optional: isOptional })
        continue
      }
      dependencies.push({ id: depId, range: range.trim() || '*', raw: String(raw), optional: isOptional })
    }
  } else if (Array.isArray(info.dependencies)) {
    for (const depId of info.dependencies) {
      if (typeof depId === 'string' && depId) dependencies.push({ id: depId, range: '*', raw: '*', optional: false })
    }
  }

  // Legacy Fluxloader manifests have no `permissions` field at all, so the
  // capability has to come from where the code runs. An electronEntrypoint is
  // handed a real `require` (see loadElectronEntrypoints) and is therefore
  // NATIVE; a game- or worker-only mod runs in a context Chromium already
  // denies Node, so it is sandboxed. Where a manifest does declare
  // permissions, classify() takes both inputs and the stricter one wins.
  let declared = []
  if (info.permissions != null) {
    const checked = permissions.validate(info.permissions, { modId: info.modID, source: `${dir}/${MODINFO}` })
    if (!checked.ok) return { ok: false, error: checked.error }
    declared = checked.permissions
  }

  const capability = permissions.classify({
    id: info.modID,
    version: String(info.version || '0.0.0'),
    flavour: 'fluxloader',
    permissions: declared,
    entrypoints: {
      native: !!entrypoints.electron,
      game: !!entrypoints.game,
      worker: !!entrypoints.worker,
    },
  })

  // SMLN is not Fluxloader, so a strict `fluxloaderVersion` match would refuse
  // every mod that pins one. Record the mismatch and load anyway: a warning
  // the author can act on beats a working mod that will not start.
  if (typeof info.fluxloaderVersion === 'string' && info.fluxloaderVersion) {
    const parsed = semver.parseRange(info.fluxloaderVersion)
    if (parsed.ok && !semver.satisfies(FLUXLOADER_COMPAT_VERSION, info.fluxloaderVersion)) {
      warnings.push(
        `declares fluxloaderVersion "${info.fluxloaderVersion}"; SandLoader reports ` +
        `${FLUXLOADER_COMPAT_VERSION} and loads it anyway`)
    }
  }

  return {
    ok: true,
    mod: {
      id: info.modID,
      name: info.name || info.modID,
      version: String(info.version || '0.0.0'),
      dir,
      flavour: 'fluxloader',
      dependencies,
      dependencyIds: dependencies.map((d) => d.id),
      priority: 100,
      enabled: info.enabled !== false,
      entrypoints,
      permissions: declared,
      capability,
      warnings,
      configSchema: info.configSchema || {},
      // Fluxloader's `scriptPath` names a module exporting modifySchema(schema),
      // which the loader calls so a mod can compute its own dropdown options at
      // load time. Custom Map Loader and Skin Loader both use it to list the
      // installed maps/skins; without it their dropdowns only ever offer
      // "default" and the mods look broken.
      scriptPath: resolve(info.scriptPath),
      manifest: info,
    },
  }
}

/** Scan directories for Fluxloader mods. */
function discover(roots, logger) {
  const mods = []
  const errors = []
  const seen = new Set()

  for (const root of roots) {
    let entries
    try {
      if (!fs.existsSync(root)) continue
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch (_) { continue }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(root, entry.name)
      if (!fs.existsSync(path.join(dir, MODINFO))) continue
      const r = readMod(dir)
      if (!r.ok) {
        if (!(r.error.detail && r.error.detail.skip)) errors.push(r.error)
        continue
      }
      if (seen.has(r.mod.id)) continue
      seen.add(r.mod.id)
      mods.push(r.mod)
      logger && logger.info(`fluxloader mod: ${r.mod.id}@${r.mod.version}`)
    }
  }
  return { mods, errors }
}

/**
 * `fluxloaderAPI.modConfig`, backed by SandLoader's one config store.
 *
 * This used to be a private JSON reader/writer living in this file, which
 * meant two stores with two notions of what a value was allowed to be: the
 * settings UI could accept a number the Fluxloader half would later read back
 * as a string. src/mods/config.js is now the only store, and it keeps the
 * same on-disk layout so config files written by the old code still load.
 *
 * The async/sync split is Fluxloader's: mods call `get`/`set` expecting
 * promises and `getSync` expecting a value, so both are offered.
 */
/**
 * Run a mod's `scriptPath` module so it can rewrite its own config schema.
 *
 * Fluxloader lets a mod compute options at load time: Custom Map Loader lists
 * every installed mod tagged "map", Skin Loader every mod tagged "skin". The
 * module is ESM (`export function modifySchema(schema)`), so the export keyword
 * is stripped and the function is called in a context carrying this mod's
 * `fluxloaderAPI` - the same one its entrypoint gets, so `getEnabledMods()`
 * inside the script sees the real mod list.
 *
 * A script that throws costs that mod its computed options and nothing else:
 * the schema it was handed is left as the manifest declared it.
 *
 * @param {any} mod
 * @param {object} schema  mutated in place
 * @param {any} api        the mod's fluxloaderAPI
 * @param {any} logger
 */
/**
 * One mod in the shape Fluxloader hands to `getEnabledMods()` and to the
 * `fl:mod-loaded` / `fl:mod-unloaded` listeners: `{info, path}`, where `info`
 * is the raw modinfo.json plus the fields Fluxloader guarantees.
 *
 * Both callers go through here so they cannot drift apart: mods discover each
 * other by tag through the event and then look the same mod up in the map, and
 * a descriptor that differed between the two would make that lookup miss.
 * `info.tags` is always an array even when the manifest omits it, because
 * every consumer calls `.includes()` on it straight away.
 *
 * @param {any} mod
 * @returns {{info: object, path: string}}
 */
function modDescriptor(mod) {
  const info = (mod.manifest && typeof mod.manifest === 'object') ? mod.manifest : {}
  return {
    info: Object.assign({}, info, {
      modID: mod.id,
      name: mod.name || mod.id,
      version: mod.version,
      tags: Array.isArray(info.tags) ? info.tags : [],
    }),
    path: mod.dir,
  }
}

function runSchemaScript(mod, schema, api, logger) {
  if (!mod.scriptPath) return schema
  try {
    const source = fs.readFileSync(mod.scriptPath, 'utf8')
    const sandbox = {
      console, fluxloaderAPI: api, module: { exports: {} },
      require, path, fs, JSON, Object, Array, String, Number, Boolean,
    }
    sandbox.globalThis = sandbox
    sandbox.exports = sandbox.module.exports
    vm.createContext(sandbox)
    // `export function modifySchema` is not valid in a classic script, and the
    // scripts are small and self-contained, so the keyword is simply dropped
    // rather than standing up an ESM loader for one function.
    const classic = source.replace(/^\s*export\s+/gm, '')
    new vm.Script(classic, { filename: mod.scriptPath }).runInContext(sandbox)
    const fn = sandbox.modifySchema ||
      (sandbox.module.exports && sandbox.module.exports.modifySchema)
    if (typeof fn !== 'function') {
      logger.warn(`${mod.id}: scriptPath exports no modifySchema(), leaving the schema as declared`)
      return schema
    }
    fn(schema)
    logger.debug(`${mod.id}: schema script applied`)
  } catch (e) {
    logger.warn(`${mod.id}: schema script failed, leaving the schema as declared: ${e && e.message}`)
  }
  return schema
}

function makeConfigStore(configDir, mod, logger) {
  const normalised = configStore.normaliseSchema(mod.configSchema)
  if (!normalised.ok) {
    logger.warn(`configSchema for ${mod.id} is invalid, treating it as empty: ${normalised.error.message}`)
  }
  const schema = normalised.ok ? normalised.schema : {}
  const store = configStore.createStore({ dir: configDir, id: mod.id, schema, logger })

  return {
    schema: mod.configSchema,
    store,
    /**
     * Fluxloader's `get` is awaited by some mods and used directly by others:
     * corelib opens with `const config = fluxloaderAPI.modConfig.get("corelib")`
     * and skinloader passes the result straight into `data.config`, then reads
     * `config.skin`. A plain Promise satisfies the first group and silently
     * gives the second `undefined` for every key - skinloader dies on
     * "Skin 'undefined' could not be found".
     *
     * So the value is returned with a `then` bolted on: reading a property
     * works, and awaiting works, because a thenable is all `await` requires.
     */
    get(key) {
      // Fluxloader mods call `get(<their own modID>)` to fetch the WHOLE config
      // object, not a key inside it - corelib opens with
      // `get("corelib")`, skinloader with `get("skinloader")`, custommaploader
      // awaits `get("custommaploader")`. Treating that as a key name returns
      // undefined and the mod reads `config.skin` off nothing, dying with
      // "Skin 'undefined' could not be found". A key that happens to equal the
      // mod id is not a real ambiguity: no schema here declares one.
      const value = (key == null || key === mod.id) ? store.getAllSync() : store.getSync(key)
      if (value === null || typeof value !== 'object') {
        // A primitive cannot carry a `then`, so hand back a resolved promise
        // that also coerces sensibly - mods read objects here in practice.
        return Promise.resolve(value)
      }
      if (typeof value.then === 'function') return value
      // Mods split on whether they await this: custommaploader does,
      // skinloader reads `.skin` straight off the return. So the object is
      // handed back as itself AND made awaitable.
      //
      // What `then` resolves WITH matters more than it looks. The promise
      // machinery unwraps a thenable by calling its `then`, and if that
      // resolves with the same thenable it unwraps again - forever, allocating
      // a promise per turn until the heap dies. That is not a hypothetical: it
      // took the whole game down at startup, after every synchronous phase had
      // already logged success, because one mod awaited its config.
      //
      // Resolving with a plain copy terminates the unwrapping: the copy has no
      // `then`, so the machinery accepts it as a final value.
      const plain = Object.assign({}, value)
      return Object.defineProperty(value, 'then', {
        value: (onFulfilled, onRejected) => Promise.resolve(plain).then(onFulfilled, onRejected),
        enumerable: false,
        configurable: true,
        writable: true,
      })
    },
    async set(key, value) {
      const r = store.set(key, value)
      if (!r.ok) logger.warn(`${mod.id}: rejected config "${key}": ${r.error.message}`)
      return r.ok
    },
    async getAll() { return store.getAllSync() },
    async setAll(obj) {
      const r = store.setAll(obj || {})
      return r.ok
    },
    getSync(key) { return store.getSync(key) },
  }
}

/**
 * Build the `fluxloaderAPI` object for the electron environment and run a
 * mod's electron entrypoint inside a vm context, as Fluxloader does.
 *
 * @returns {{patches: Record<string, any[]>, errors: SmlnError[], events: any}}
 */
function loadElectronEntrypoints(mods, ctx, logger) {
  /** @type {Record<string, any[]>} */
  const patches = Object.create(null)
  /**
   * dist-relative path -> absolute replacement file, from `setPatch(...,
   * {type:'overwrite', file})`. Asset swaps, not text edits: this is how a map
   * mod supplies its terrain PNGs and a skin mod its sprites.
   *
   * Kept apart from `patches` because the patch engine is a text engine. A PNG
   * pushed through it is read as UTF-8, mangled by the decode, and matched
   * against anchors it cannot contain - which is why the skin silently failed
   * to apply and the map images never swapped at all.
   * @type {Record<string, string>}
   */
  const overrides = Object.create(null)
  // Set the moment corelib publishes `globalThis.corelib`, from inside the
  // mods loop below - see the comment at the install site for why it cannot
  // wait until the loop has finished.
  let content = null
  const matterTable = ctx.matterEnum || matterEnum()
  const errors = []
  const listeners = Object.create(null)

  // Everything mods publish with `globalThis.x = ...` lands here, and every
  // mod's context inherits from it. That is how a library mod exports its API:
  // corelib ends on `globalThis.corelib = new CoreLib()` and its dependents
  // call `corelib.elements.registerElement(...)` as a bare global.
  const universe = {
    console,
    require,
    process,
    Buffer,
    setTimeout,
    setInterval,
    clearTimeout,
    clearInterval,
    URL,
    TextEncoder,
    TextDecoder,
    // Fluxloader's electron entrypoints run with these node builtins already
    // in scope; mods use `path.join(...)` at top level without requiring it.
    path,
    fs,
  }
  universe.globalThis = universe

  // Events a mod declared via registerEvent. Fluxloader distinguishes a
  // declared event from a typo'd one: `trigger` on an unknown name is a
  // programming error and throws, while `tryTrigger` is the tolerant variant
  // used on hot paths where the listener may legitimately not exist yet.
  const registered = new Set()

  const bus = {
    on(name, fn) { (listeners[name] || (listeners[name] = [])).push(fn) },
    off(name, fn) {
      const a = listeners[name] || []
      const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1)
    },
    emit(name, ...args) {
      for (const fn of listeners[name] || []) {
        try { fn(...args) } catch (e) { logger.error(`fl event ${name} handler failed: ${e.message}`) }
      }
    },
    /** Declare an extension point. Idempotent: re-registering is not an error. */
    registerEvent(name) {
      if (typeof name !== 'string' || !name) return false
      registered.add(name)
      if (!listeners[name]) listeners[name] = []
      return true
    },
    isEventRegistered(name) { return registered.has(name) },
    /**
     * Fire a declared event. Throws on an undeclared name so a mistyped event
     * surfaces at the call site instead of silently never firing.
     */
    trigger(name, ...args) {
      if (!registered.has(name)) {
        throw new Error(`event "${name}" was triggered before it was registered`)
      }
      bus.emit(name, ...args)
      return true
    },
    /** Fire only if declared. Returns whether anything was dispatched. */
    tryTrigger(name, ...args) {
      if (!registered.has(name)) return false
      bus.emit(name, ...args)
      return true
    },
  }

  for (const mod of mods) {
    const entry = mod.entrypoints.electron
    if (!entry) continue
    const modLog = logger.child(mod.id)
    const tags = new Map()

    function addTo(file, patch, tag) {
      const target = normaliseTarget(file)
      const key = tag || `p${tags.size}`
      tags.set(key, target)
      ;(patches[target] || (patches[target] = [])).push(toSmlnPatch(patch, mod.id, key))
      modLog.debug(`patch ${key} queued for ${target}`)
    }

    function setTo(file, tag, patch) {
      const target = normaliseTarget(file)

      // An overwrite names a replacement file rather than describing an edit,
      // so it belongs in the override map the interceptor already serves from.
      if (patch && String(patch.type || '').toLowerCase() === 'overwrite') {
        if (typeof patch.file !== 'string' || !patch.file) {
          modLog.warn(`setPatch("${file}", "${tag}") ignored: an overwrite needs a "file"`)
          return
        }
        if (!fs.existsSync(patch.file)) {
          modLog.warn(`setPatch("${file}", "${tag}") ignored: ${patch.file} does not exist`)
          return
        }
        overrides[target] = patch.file
        tags.set(tag, target)
        modLog.debug(`override: ${target} -> ${patch.file}`)
        return
      }

      const list = patches[target] || (patches[target] = [])
      const id = `${mod.id}:${tag}`
      const i = list.findIndex((p) => p.id === id)
      const built = toSmlnPatch(patch, mod.id, tag)
      if (i >= 0) list[i] = built; else list.push(built)
      tags.set(tag, target)
    }

    /**
     * Apply one patch per file in a bundle map. The game ships the same logic
     * across several bundles under different minified names, so mods pass
     * `{ "js/bundle.js": ["Vh","d"], "js/336.bundle.js": ["n","l.ev"] }` and one
     * mapper that receives that file's names as arguments. An array form (no
     * per-file names) passes the filename instead. A throwing mapper is logged
     * and skipped rather than aborting the other files: a bundle that this
     * version of the game no longer ships should cost one patch, not all of them.
     */
    function mapPatch(fileMap, tag, mapFn, label) {
      if (typeof mapFn !== 'function') {
        modLog.error(`${label} ignored: mapper is not a function`)
        return
      }
      const isArray = Array.isArray(fileMap)
      const files = isArray ? fileMap : Object.keys(fileMap || {})
      for (const f of files) {
        try {
          const names = isArray ? [f] : fileMap[f]
          const built = Array.isArray(names) ? mapFn(...names) : mapFn(names)
          if (!built) continue
          if (tag) setTo(f, tag, built)
          else addTo(f, built, isArray ? undefined : undefined)
        } catch (e) {
          modLog.error(`${label} failed for ${f}: ${e.message}`)
        }
      }
    }

    const api = {
      version: '2.0.0-smln',
      modID: mod.id,
      modConfig: makeConfigStore(ctx.configDir, mod, modLog),
      events: bus,
      addPatch: (file, patch) => addTo(file, patch),
      setPatch: (file, tag, patch) => setTo(file, tag, patch),
      /**
       * Whether a patch with this tag is queued for this file, from ANY mod.
       * Mods use it to detect each other's presence and adapt - refinement
       * checks for a "petalium" patch to decide what to call an element.
       * The tag is matched against the id suffix because ids are namespaced
       * as `<modId>:<tag>` here, while the caller knows only the tag.
       */
      patchExists: (file, tag) => {
        const target = normaliseTarget(file)
        const wanted = String(tag || '')
        if (!wanted) return false
        const list = patches[target] || []
        return list.some((p) => {
          const id = String(p.id || '')
          return id === wanted || id.endsWith(':' + wanted) || id.includes(':' + wanted + ':')
        })
      },
      removePatch: (file, tag) => {
        const target = normaliseTarget(file)
        // An override lives in its own map, so clearing one has to look there
        // too - skinloader calls this for every sprite when the player picks
        // "default", and a leftover override would pin the old skin forever.
        if (overrides[target]) delete overrides[target]
        const list = patches[target] || []
        const id = `${mod.id}:${tag}`
        const i = list.findIndex((p) => p.id === id)
        if (i >= 0) list.splice(i, 1)
      },
      addMappedPatch: (fileMap, mapFn) => mapPatch(fileMap, undefined, mapFn, 'addMappedPatch'),
      /**
       * Same mapping as addMappedPatch but replaces any previous patch carrying
       * the same tag, so a mod that re-runs its setup does not stack duplicates.
       */
      setMappedPatch: (fileMap, tag, mapFn) => mapPatch(fileMap, tag, mapFn, 'setMappedPatch'),
      log: (...a) => modLog.info(a.map(String).join(' ')),
      /**
       * The mods ROOT, not this mod's own folder: mods join it with a mod id
       * (`path.join(getModsPath(), sourceMod, "img.png")`) to reach another
       * mod's assets, so returning the mod folder would double the id segment.
       * Derived per-mod rather than from a single configured root because mods
       * load from several roots (local, userData, Workshop) and a sibling mod
       * lives under the same root as the mod asking for it.
       */
      getModsPath: () => path.dirname(mod.dir),

      /**
       * The game's asset root inside app.asar - the `dist` directory, not the
       * archive root. Mods join it with a subfolder and read through `fs`,
       * which Electron resolves inside an asar transparently.
       *
       * The `dist` segment is the whole point: Custom Map Loader asks for
       * `getGameAsarPath() + "/img"`, and the images live at `dist/img`
       * inside the archive. Returning the archive root sends it to `/img`,
       * which does not exist, and every stock map file fails to load with
       * "Could not find map file".
       */
      getGameAsarPath: () => (ctx.install && ctx.install.asar
        ? path.join(ctx.install.asar, 'dist')
        : ''),

      /**
       * Every enabled mod, keyed by id, in the shape Fluxloader hands out:
       * `{[id]: {info, path}}` where `info` is the raw modinfo.json. Mods use
       * it to discover each other by tag - a map loader collects everything
       * tagged "map", a skin loader everything tagged "skin" - so `info.tags`
       * has to be present even when a manifest omitted it, or the filter throws
       * instead of simply finding nothing.
       */
      getEnabledMods: () => {
        const out = {}
        const list = []
        for (const m of mods) {
          if (m.enabled === false) continue
          const d = modDescriptor(m)
          out[m.id] = d
          list.push(d)
        }
        // Mods disagree about what this returns, and both readings are in use:
        // custommaploader and skinloader do `Object.values(...)`, while
        // refinement calls `.filter(...)` straight on the result. Returning
        // either shape alone breaks the other - refinement died on
        // "getEnabledMods(...).filter is not a function".
        //
        // So the keyed object also carries the iteration methods, bound to the
        // value list. They are non-enumerable, which keeps `Object.values`,
        // `Object.keys` and JSON.stringify seeing exactly the mod entries.
        for (const name of ['filter', 'map', 'forEach', 'find', 'some', 'every', 'slice']) {
          Object.defineProperty(out, name, {
            value: (...args) => list[name](...args),
            enumerable: false, configurable: true, writable: true,
          })
        }
        Object.defineProperty(out, 'length', {
          value: list.length, enumerable: false, configurable: true, writable: true,
        })
        Object.defineProperty(out, Symbol.iterator, {
          value: () => list[Symbol.iterator](),
          enumerable: false, configurable: true, writable: true,
        })
        return out
      },
    }

    // Real cross-context messaging and IPC, on SandLoader's existing
    // transports. See src/compat/flux-messaging.js.
    // Let the mod compute its own schema options now that its API exists, then
    // rebuild the config store on the result - the store bakes defaults and
    // validation from the schema, so a dropdown gaining options afterwards
    // would still reject every one of them.
    if (mod.scriptPath) {
      const grown = runSchemaScript(mod, JSON.parse(JSON.stringify(mod.configSchema || {})), api, modLog)
      mod.configSchema = grown
      api.modConfig = makeConfigStore(ctx.configDir, mod, modLog)
    }

    Object.assign(api, fluxMessaging.electronSurface({
      modId: mod.id,
      logger: modLog,
      sendToRenderer: ctx.sendToRenderer || (() => {
        modLog.warn('sendGameEvent: the game window is not attached yet')
      }),
      rpc: ctx.rpc || { register: () => {
        modLog.warn('IPC handler registered before the RPC bridge existed; it will not receive calls')
      } },
    }))

    try {
      const source = fs.readFileSync(entry, 'utf8')
      const modRoot = path.resolve(mod.dir)

      // Each mod gets its OWN context whose global object inherits from the
      // shared `universe`. Reads fall through to whatever other mods published
      // there (`corelib`, `DataRegistry`, ...), while `fluxloaderAPI` and the
      // other per-mod slots sit on the mod's own object and shadow it - so two
      // mods cannot overwrite each other's id, config or channels, and a
      // callback that fires later (corelib applies its patches from
      // `fl:pre-scene-loaded`) still sees the API of the mod that registered
      // it rather than whichever mod happened to load last.
      const sandbox = Object.create(universe)
      // `globalThis` points at the shared object, so a mod's own
      // `globalThis.corelib = ...` publishes to every other mod, exactly as it
      // does when Fluxloader runs these files in one scope.
      sandbox.globalThis = universe
      sandbox.fluxloaderAPI = api
      const moduleObj = { exports: {} }
      vm.createContext(sandbox)

      sandbox.module = moduleObj
      sandbox.exports = moduleObj.exports
      sandbox.__dirname = path.dirname(entry)
      sandbox.__filename = entry

      // Library mods split themselves across modules/*.js and pull them in at
      // entrypoint scope, so every included file must share ONE scope: a class
      // declared in modules/blocks.js has to be visible to the entrypoint and
      // to the files included after it. Running each in the same context with
      // `var`-style top-level bindings gives exactly that, which `require`
      // (module-per-file, isolated scope) would not.
      sandbox.includeVMScript = function includeVMScript(relative) {
        if (typeof relative !== 'string' || !relative) {
          throw new TypeError('includeVMScript expects a file path relative to the mod folder')
        }
        // Confine reads to the mod's own folder: an entrypoint must not be able
        // to read the player's disk by way of "../../.." in an include path.
        const target = path.resolve(modRoot, relative)
        if (target !== modRoot && !target.startsWith(modRoot + path.sep)) {
          throw new Error(`includeVMScript("${relative}") escapes the mod folder`)
        }
        if (!fs.existsSync(target)) {
          throw new Error(`includeVMScript("${relative}") not found in ${mod.id}`)
        }
        const included = fs.readFileSync(target, 'utf8')
        // Same context as the entrypoint, so a class declared here is visible
        // to the entrypoint and to the files included after it, and this mod's
        // own fluxloaderAPI is the one in scope.
        new vm.Script(included, { filename: target }).runInContext(sandbox)
        modLog.debug(`included ${relative}`)
        return true
      }

      // Fluxloader mods call a bare log(level, tag, ...message). Route it at
      // the matching level so a mod's own debug output stays debug-level here.
      sandbox.log = function log(level, ...rest) {
        const levels = ['debug', 'info', 'warn', 'error']
        const lvl = levels.includes(level) ? level : 'info'
        const parts = (levels.includes(level) ? rest : [level, ...rest])
        modLog[lvl](parts.map((x) => (typeof x === 'string' ? x : String(x))).join(' '))
      }

      new vm.Script(source, { filename: entry }).runInContext(sandbox)

      // Swap corelib's content modules for capturing shims the instant corelib
      // publishes itself, before the next mod in this loop runs. A dependent
      // mod calls `corelib.elements.registerElement(...)` at its OWN
      // entrypoint's top level - not from the deferred event - so installing
      // after the loop would let those calls reach corelib's original registry,
      // where their only fate is to become the stale patches this bridge
      // exists to replace.
      if (!content && universe.corelib) {
        content = flContent.install(universe, {
          modId: 'corelib',
          logger: logger.child('content'),
          matterEnum: matterTable,
        })
      }

      const exported = moduleObj.exports
      if (exported && typeof exported.onLoad === 'function') exported.onLoad()
      modLog.info(`electron entrypoint loaded (${Object.keys(patches).length} patched file(s) so far)`)
    } catch (e) {
      errors.push(new SmlnError('E_MOD_LOAD', `fluxloader mod "${mod.id}" electron entrypoint failed: ${e.message}`, { cause: e }))
      modLog.error('electron entrypoint threw', e && e.stack)
    }
  }

  // Announce every enabled mod. Loader mods discover the content they serve
  // through this event rather than by scanning the folder themselves:
  // custommaploader collects mods tagged "map" here, skinloader those tagged
  // "skin". Without it they know only their own built-in default, and the
  // player's installed maps and skins never appear.
  //
  // Fired after the whole loop, not inside it, for two reasons: a mod that is
  // pure assets has no electron entrypoint and would be skipped by the loop's
  // `continue`, and a listener registered by a mod loaded late must still see
  // the mods that loaded before it - emitting per-mod mid-loop would deliver
  // each mod only to the listeners that happened to already exist.
  bus.registerEvent('fl:mod-loaded')
  for (const mod of mods) {
    if (mod.enabled === false) continue
    bus.emit('fl:mod-loaded', modDescriptor(mod))
  }

  bus.emit('fl:all-mods-loaded')

  // Library mods do not queue their patches while their entrypoint runs; they
  // defer until a scene is about to load, because that is the first moment
  // Fluxloader has a game to patch. corelib is the case that matters - its
  // entrypoint only calls `registerElement`/`registerRecipe` into an in-memory
  // registry, and every one of its ~90 patches is emitted later from
  // `fl:pre-scene-loaded` -> `corelib.applyPatches()`.
  //
  // SandLoader has no scene of its own to hang that on: it transforms the
  // bundle once, on the way to disk, and the caller harvests `patches`
  // synchronously the moment this function returns. So the event has to fire
  // here, after every entrypoint has registered its content and its listener
  // but before anyone reads the patch set. Without it the listener simply
  // never runs, the registry is never translated into patches, and mods load
  // cleanly while registering nothing - the game ships unmodified.
  //
  // Declared before firing so a mod using `trigger`/`isEventRegistered`
  // (rather than the tolerant `tryTrigger`) sees a known event, and emitted
  // via the bus directly so a mod that registered no listener is not an error.
  // If corelib never loaded, install now so `content` is always defined; it
  // simply reports that no corelib global was found.
  if (!content) {
    content = flContent.install(universe, {
      modId: 'corelib',
      logger: logger.child('content'),
      matterEnum: matterTable,
    })
  }
  for (const reason of content.reasons) logger.debug(`content bridge: ${reason}`)

  // Sandkit lives in the renderer, so what was captured here has to cross the
  // process boundary. corelib already crosses it the same way for its own
  // registry, so this reuses the existing RPC rather than inventing a
  // transport. The handler reads `content.captured` when it is called, not
  // now, so registrations that arrive later - from the deferred event below -
  // are included.
  if (ctx.rpc && typeof ctx.rpc.register === 'function') {
    ctx.rpc.register('smln:flux-content', () => ({
      elements: content.captured.elements,
      soils: content.captured.soils,
      blocks: content.captured.blocks,
      tech: content.captured.tech,
      upgrades: content.captured.upgrades,
      unsupported: content.captured.unsupported,
    }))
  }

  bus.registerEvent('fl:pre-scene-loaded')
  // The scene name is not decoration: listeners branch on it. custommaploader
  // only resolves the configured map into `loadedMapData` when the scene is
  // "game" or "intro", and emitting with no argument left every such listener
  // in its no-op branch - the mod loaded, reported success, and then answered
  // its own renderer half with `undefined`, which crashed on `.valid`.
  // "game" is the scene SandLoader is actually preparing the bundle for.
  bus.emit('fl:pre-scene-loaded', 'game')

  // Drop only the patches the bridge now supplies through the game's own
  // registry. Everything else corelib queued is left exactly as it was.
  let dropped = 0
  for (const target of Object.keys(patches)) {
    const before = patches[target].length
    patches[target] = patches[target].filter((p) => !flContent.shouldSuppress(p.id))
    dropped += before - patches[target].length
    if (!patches[target].length) delete patches[target]
  }
  if (dropped) {
    logger.info(`content bridge: ${dropped} superseded patch(es) dropped, ` +
      `${content.captured.elements.length} element(s) and ` +
      `${content.captured.soils.length} soil(s) captured for the game's own registry`)
  }

  return { patches, overrides, errors, events: bus, content: content.captured }
}

/**
 * Renderer/worker-side shim source. Prepended before a mod's game or worker
 * entrypoint so `fluxloaderAPI` exists in that environment too.
 */
function environmentShim(mod, environment) {
  const schema = mod.configSchema || {}
  const defaults = {}
  for (const [k, spec] of Object.entries(schema)) {
    if (spec && typeof spec === 'object' && 'default' in spec) defaults[k] = spec.default
  }
  const id = JSON.stringify(mod.id)
  const messaging = environment === 'worker'
    ? fluxMessaging.workerShim(mod.id)
    : fluxMessaging.gameShim(mod.id)

  return `var g=typeof globalThis!=="undefined"?globalThis:self;
var S=g.__SMLN__;
var api={};
var __store=Object.assign(${JSON.stringify(defaults)},
  (g.__SMLN_FLUX_CONFIG__&&g.__SMLN_FLUX_CONFIG__[${id}])||{});
function __bus(){
  var L=Object.create(null);var R=Object.create(null);
  var B={on:function(n,f){(L[n]||(L[n]=[])).push(f);return function(){var a=L[n]||[],i=a.indexOf(f);if(i>=0)a.splice(i,1)}},
          off:function(n,f){var a=L[n]||[],i=a.indexOf(f);if(i>=0)a.splice(i,1)},
          emit:function(n){var a=L[n]||[],r=[].slice.call(arguments,1);
            for(var i=0;i<a.length;i++){try{a[i].apply(null,r)}catch(e){console.error("[SMLN] fl event",n,e)}}}};
  // Mirrors the electron-side bus: declared events can be triggered, an
  // undeclared name throws from trigger and is a no-op for tryTrigger.
  B.registerEvent=function(n){if(!n)return false;R[n]=true;if(!L[n])L[n]=[];return true};
  B.isEventRegistered=function(n){return !!R[n]};
  B.trigger=function(n){if(!R[n])throw new Error('event "'+n+'" was triggered before it was registered');
    B.emit.apply(null,arguments);return true};
  B.tryTrigger=function(n){if(!R[n])return false;B.emit.apply(null,arguments);return true};
  return B;
}
api.version=${JSON.stringify(FLUXLOADER_COMPAT_VERSION + '-smln')};
api.modID=${id};
api.environment=${JSON.stringify(environment)};
api.events=__bus();
api.modConfig={
  schema:${JSON.stringify(schema)},
  get:function(k){return Promise.resolve(k==null?__store:__store[k])},
  getSync:function(k){return k==null?__store:__store[k]},
  set:function(k,v){
    __store[k]=v;
    if(S&&typeof S.callMain==="function"){
      return S.callMain("setModConfig",{mod:${id},id:${id},key:k,value:v})
        .then(function(r){return !!(r&&r.ok)});
    }
    return Promise.resolve(true);
  }
};
api.log=function(){console.log.apply(console,["["+api.modID+"]"].concat([].slice.call(arguments)))};
${messaging}
if(S){
  // Bridge the game's own lifecycle onto the fl:* names mods listen for.
  if(S.on)S.on("ready",function(){try{api.events.emit("fl:scene-loaded",${JSON.stringify(environment)})}catch(e){}});
  api.game=function(){return S.game};
  api.state=function(){return S.getState()};
}
// The live simulation state. Mods read this every frame and treat it as a
// plain property, so it is a getter over the host's current state rather than
// a value captured once at load - a snapshot would go stale on the first
// scene change and silently hand mods a dead object. Defined whether or not
// the host bridge exists yet so that reading it early yields undefined
// instead of throwing on a missing global.
function __state(){try{return S&&typeof S.getState==="function"?S.getState():undefined}catch(e){return undefined}}
Object.defineProperty(api,"gameInstanceState",{enumerable:true,get:__state});
api.gameInstance={};
Object.defineProperty(api.gameInstance,"state",{enumerable:true,get:__state});
// Kept for mods that reach for the global rather than the local binding. The
// local one below is authoritative; this is a best-effort convenience and the
// last mod to load wins it, which is exactly why the local exists.
try{g.fluxloaderAPI=api}catch(e){}
var fluxloaderAPI=api;
`
}

/**
 * Wrap one Fluxloader entrypoint together with its shim.
 *
 * The wrapping IIFE is the point. Fluxloader hands each mod a global called
 * `fluxloaderAPI`, and SMLN concatenates every mod into one script - so a
 * single global meant the second mod's shim overwrote the first's `modID`,
 * config store and message channels, and mod A started receiving mod B's
 * messages. A function scope per mod gives each one its own object while
 * keeping the name mods actually write.
 *
 * @param {any} mod
 * @param {'game'|'worker'} environment
 * @param {string} source
 * @returns {string}
 */
function wrapEntrypoint(mod, environment, source) {
  // The IIFE is async because mod entrypoints legitimately use top-level
  // `await` (corelib ends on `await corelib.init()`); a plain function wrapper
  // turns that into a SyntaxError that kills the whole bundle, not just the mod.
  // `.catch` mirrors the try/catch for rejections that escape after the first
  // await, which a bare try/catch around an async body would not see.
  return `/* --- fluxloader mod (${environment}): ${mod.id}@${mod.version} --- */
;(async function(){
'use strict';
try{
${environmentShim(mod, environment)}
${source}
}catch(e){
  console.error("[SMLN] fluxloader mod ${JSON.stringify(mod.id).slice(1, -1)} (${environment}) failed:", e);
}
})().catch(function(e){
  console.error("[SMLN] fluxloader mod ${JSON.stringify(mod.id).slice(1, -1)} (${environment}) failed:", e);
});`
}

module.exports = {
  matterEnum,
  discover,
  readMod,
  toSmlnPatch,
  normaliseTarget,
  loadElectronEntrypoints,
  environmentShim,
  wrapEntrypoint,
  makeConfigStore,
  FLUXLOADER_COMPAT_VERSION,
  MODINFO,
}
