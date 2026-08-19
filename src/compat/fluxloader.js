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

const MODINFO = 'modinfo.json'

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

  return {
    ok: true,
    mod: {
      id: info.modID,
      name: info.name || info.modID,
      version: String(info.version || '0.0.0'),
      dir,
      flavour: 'fluxloader',
      dependencies: info.dependencies && typeof info.dependencies === 'object'
        ? Object.keys(info.dependencies)
        : [],
      priority: 100,
      enabled: info.enabled !== false,
      entrypoints: {
        electron: resolve(info.electronEntrypoint),
        game: resolve(info.gameEntrypoint),
        worker: resolve(info.workerEntrypoint),
      },
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

/** Config persistence for `fluxloaderAPI.modConfig`, one JSON file per mod. */
function makeConfigStore(configDir, mod, logger) {
  const file = path.join(configDir, `${mod.id}.json`)
  let data = null

  function defaults() {
    const out = {}
    for (const [k, spec] of Object.entries(mod.configSchema || {})) {
      if (spec && 'default' in spec) out[k] = spec.default
    }
    return out
  }

  function load() {
    if (data) return data
    data = defaults()
    try {
      if (fs.existsSync(file)) Object.assign(data, JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch (e) {
      logger.warn(`config for ${mod.id} unreadable, using defaults: ${e.message}`)
    }
    return data
  }

  function save() {
    try {
      fs.mkdirSync(configDir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(load(), null, 2))
      return true
    } catch (e) {
      logger.error(`could not save config for ${mod.id}: ${e.message}`)
      return false
    }
  }

  return {
    schema: mod.configSchema,
    async get(key) { const d = load(); return key == null ? { ...d } : d[key] },
    async set(key, value) { load()[key] = value; save(); return true },
    async getAll() { return { ...load() } },
    async setAll(obj) { Object.assign(load(), obj || {}); save(); return true },
    getSync(key) { const d = load(); return key == null ? { ...d } : d[key] },
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
      // Cross-context messaging is not wired yet; be loud rather than silent.
      sendGameMessage: unsupported('sendGameMessage', modLog),
      sendWorkerMessage: unsupported('sendWorkerMessage', modLog),
      log: (...a) => modLog.info(a.map(String).join(' ')),
    }

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

function unsupported(name, logger) {
  return function () {
    logger.warn(`fluxloaderAPI.${name}() is not implemented by SMLN yet - call ignored`)
    return Promise.resolve(null)
  }
}

/**
 * Renderer/worker-side shim source. Prepended before a mod's game or worker
 * entrypoint so `fluxloaderAPI` exists in that environment too.
 */
function environmentShim(mod, environment) {
  const schema = mod.configSchema || {}
  const cfg = JSON.stringify(schema)
  // Seed the renderer/worker-side store with the schema defaults, then let any
  // persisted values from the main process override them.
  const defaults = {}
  for (const [k, spec] of Object.entries(schema)) {
    if (spec && typeof spec === 'object' && 'default' in spec) defaults[k] = spec.default
  }
  return `;(function(){
var g=typeof globalThis!=="undefined"?globalThis:self;
var S=g.__SMLN__;
var store=Object.assign(${JSON.stringify(defaults)},
  (S&&S.__flConfig&&S.__flConfig[${JSON.stringify(mod.id)}])||{});
function bus(){
  var L=Object.create(null);
  return {on:function(n,f){(L[n]||(L[n]=[])).push(f)},
          off:function(n,f){var a=L[n]||[],i=a.indexOf(f);if(i>=0)a.splice(i,1)},
          emit:function(n){var a=L[n]||[],r=[].slice.call(arguments,1);
            for(var i=0;i<a.length;i++){try{a[i].apply(null,r)}catch(e){console.error("[SMLN] fl event",n,e)}}}}
}
var api=g.fluxloaderAPI=g.fluxloaderAPI||{};
api.modID=${JSON.stringify(mod.id)};
api.environment=${JSON.stringify(environment)};
api.events=api.events||bus();
api.modConfig=api.modConfig||{
  schema:${cfg},
  get:function(k){return Promise.resolve(k==null?store:store[k])},
  getSync:function(k){return k==null?store:store[k]},
  set:function(k,v){store[k]=v;return Promise.resolve(true)}
};
api.log=api.log||function(){console.log.apply(console,["[".concat(api.modID,"]")].concat([].slice.call(arguments)))};
if(S){
  // Bridge the game's own lifecycle onto the fl:* names mods listen for.
  S.on&&S.on("ready",function(){try{api.events.emit("fl:scene-loaded","game")}catch(e){}});
  api.game=function(){return S.game};
  api.state=function(){return S.getState()};
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
  makeConfigStore,
  MODINFO,
}
