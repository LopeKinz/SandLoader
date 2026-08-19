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

const MODINFO = 'modinfo.json'

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
      required: p.required !== false,
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
    required: p.required !== false,
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
      const range = typeof raw === 'string' ? raw : '*'
      const parsed = semver.parseRange(range)
      if (!parsed.ok) {
        warnings.push(`unparsable range for dependency "${depId}": "${range}" (${parsed.reason})`)
        dependencies.push({ id: depId, range: '*', raw: String(raw), optional: false })
        continue
      }
      dependencies.push({ id: depId, range: range.trim() || '*', raw: String(raw), optional: false })
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
    async get(key) { return store.getSync(key) },
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
  const errors = []
  const listeners = Object.create(null)

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

    const api = {
      version: '2.0.0-smln',
      modID: mod.id,
      modConfig: makeConfigStore(ctx.configDir, mod, modLog),
      events: bus,
      addPatch: (file, patch) => addTo(file, patch),
      setPatch: (file, tag, patch) => {
        const target = normaliseTarget(file)
        const list = patches[target] || (patches[target] = [])
        const id = `${mod.id}:${tag}`
        const i = list.findIndex((p) => p.id === id)
        const built = toSmlnPatch(patch, mod.id, tag)
        if (i >= 0) list[i] = built; else list.push(built)
        tags.set(tag, target)
      },
      removePatch: (file, tag) => {
        const target = normaliseTarget(file)
        const list = patches[target] || []
        const id = `${mod.id}:${tag}`
        const i = list.findIndex((p) => p.id === id)
        if (i >= 0) list.splice(i, 1)
      },
      addMappedPatch: (fileMap, mapFn) => {
        // fileMap: { file: tag } or [file]; mapFn produces the patch per file.
        const files = Array.isArray(fileMap) ? fileMap : Object.keys(fileMap || {})
        for (const f of files) {
          try {
            const built = mapFn(f)
            if (built) addTo(f, built, Array.isArray(fileMap) ? undefined : fileMap[f])
          } catch (e) {
            modLog.error(`addMappedPatch failed for ${f}: ${e.message}`)
          }
        }
      },
      log: (...a) => modLog.info(a.map(String).join(' ')),
    }

    // Real cross-context messaging and IPC, on SandLoader's existing
    // transports. See src/compat/flux-messaging.js.
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
      const sandbox = {
        fluxloaderAPI: api,
        console,
        require,
        module: { exports: {} },
        exports: {},
        __dirname: path.dirname(entry),
        __filename: entry,
        process,
        Buffer,
        setTimeout,
        setInterval,
        clearTimeout,
        clearInterval,
        URL,
        TextEncoder,
        TextDecoder,
      }
      sandbox.globalThis = sandbox
      vm.createContext(sandbox)
      new vm.Script(source, { filename: entry }).runInContext(sandbox)

      const exported = sandbox.module.exports
      if (exported && typeof exported.onLoad === 'function') exported.onLoad()
      modLog.info(`electron entrypoint loaded (${Object.keys(patches).length} patched file(s) so far)`)
    } catch (e) {
      errors.push(new SmlnError('E_MOD_LOAD', `fluxloader mod "${mod.id}" electron entrypoint failed: ${e.message}`, { cause: e }))
      modLog.error('electron entrypoint threw', e && e.stack)
    }
  }

  bus.emit('fl:all-mods-loaded')
  return { patches, errors, events: bus }
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
  var L=Object.create(null);
  return {on:function(n,f){(L[n]||(L[n]=[])).push(f);return function(){var a=L[n]||[],i=a.indexOf(f);if(i>=0)a.splice(i,1)}},
          off:function(n,f){var a=L[n]||[],i=a.indexOf(f);if(i>=0)a.splice(i,1)},
          emit:function(n){var a=L[n]||[],r=[].slice.call(arguments,1);
            for(var i=0;i<a.length;i++){try{a[i].apply(null,r)}catch(e){console.error("[SMLN] fl event",n,e)}}}};
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
  return `/* --- fluxloader mod (${environment}): ${mod.id}@${mod.version} --- */
;(function(){
'use strict';
try{
${environmentShim(mod, environment)}
${source}
}catch(e){
  console.error("[SMLN] fluxloader mod ${JSON.stringify(mod.id).slice(1, -1)} (${environment}) failed:", e);
}
})();`
}

module.exports = {
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
