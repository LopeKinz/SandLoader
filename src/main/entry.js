'use strict'
/**
 * SandLoader main-process entry point.
 *
 * Sandustry 0.5.4 loads a mod loader itself: on Steam it scans the Workshop
 * content folder for a `modinfo.json` declaring `modID: "fluxloader"`, requires
 * the `fluxloader.bundle.js` next to it, and drives it through a fixed
 * interface. That interface is the *game's* ABI - the contract a host offers a
 * loader - and implementing it is what makes SMLN work without touching a
 * single game file. SMLN shares no code with the Fluxloader project; it answers
 * the same phone number, and separately knows how to read its mods.
 *
 * What the host gives us (main.js, initializeFluxloader):
 *   createWindow, ipcMain, shell, dialog, screen,
 *   paths: { fluxloader, mods, userData, config },
 *   startGame({ applyPatches, unmodded })
 *
 * What the host calls on us:
 *   initialize(hostAPI), startManager(), getAPI(),
 *   setGameWindow(win), onGameStarted(), closeGame()
 *
 * The host's own file interceptor is commented out in 0.5.4 and its path maths
 * is wrong for packaged builds, so we install our own before the game window
 * exists and never depend on the host to deliver patched code.
 *
 * FAILURE POLICY, which shapes most of the code below: no mod, however broken,
 * may stop the loader. Every stage catches, records the failure in
 * src/core/problems.js with the mod it came from, and carries on with the mods
 * that are fine. The in-game manager shows that list, because a caught error
 * nobody can see is only half a policy - a mod that failed to load otherwise
 * looks exactly like one that loaded and does nothing.
 */

const path = require('path')
const fs = require('fs')

const log = require('../core/log')
const problems = require('../core/problems')
const { SmlnError, toSmlnError } = require('../core/errors')
const locate = require('../asar/locate')
const modLoader = require('../mods/loader')
const flCompat = require('../compat/fluxloader')
const modManage = require('../mods/manage')
const official = require('../mods/official')
const permissions = require('../mods/permissions')
const approvals = require('../mods/approvals')
const configStore = require('../mods/config')
const modStorage = require('../mods/storage')
const netcap = require('../mods/netcap')
const sandbox = require('../mods/sandbox')
const watcher = require('../mods/watcher')
const interceptor = require('./interceptor')
const { corePatches } = require('../patch/core-patches')
const prelude = require('../renderer/prelude')
const enums = require('../game/enums')

const VERSION = '0.1.0'

const BUNDLE = 'js/bundle.js'
const SIM_WORKER = 'js/simulation-worker.js'
const UTIL_WORKER = 'js/utility-worker.js'
const MANAGER_WORKER = 'js/manager-worker.js'
const WORKER_TARGETS = [SIM_WORKER, UTIL_WORKER, MANAGER_WORKER]

const runtime = {
  host: null,
  logger: null,
  install: null,
  mods: [],
  flMods: [],
  /** @type {Record<string, any[]>} */
  patchesByFile: {},
  rendererScripts: [],
  workerScripts: {},
  officialMods: [],
  redirects: {},
  modAssets: {},
  errors: [],
  configDir: null,
  modStates: {},
  settings: {},
  gameWindow: null,
  interceptor: null,
  listeners: Object.create(null),
  approvals: null,
  configs: new Map(),
  storages: new Map(),
  networks: new Map(),
  /** Extra RPC actions registered by Fluxloader electron entrypoints. */
  rpcActions: new Map(),
  watcher: null,
  /** Pending two-phase installs: token -> {review, zipPath}. */
  installs: new Map(),
  flConfig: {},
}

function resetCollections() {
  runtime.patchesByFile = { [BUNDLE]: [], [SIM_WORKER]: [], [UTIL_WORKER]: [], [MANAGER_WORKER]: [] }
  runtime.rendererScripts = []
  runtime.workerScripts = { [SIM_WORKER]: [], [UTIL_WORKER]: [], [MANAGER_WORKER]: [] }
  runtime.redirects = {}
  runtime.modAssets = {}
  runtime.errors = []
  runtime.flConfig = {}
}
resetCollections()

// ------------------------------------------------------------------ helpers

function modRoots(hostPaths) {
  const roots = [path.join(__dirname, '..', '..', 'mods')]
  if (hostPaths && hostPaths.userData) roots.push(path.join(hostPaths.userData, 'smln-mods'))
  return [...new Set(roots.map((r) => path.resolve(r)))]
}

/** Fluxloader keeps its mods in userData/fluxloader-mods; honour that. */
function fluxloaderRoots(hostPaths) {
  const roots = []
  if (hostPaths && hostPaths.mods) roots.push(hostPaths.mods)
  if (hostPaths && hostPaths.userData) roots.push(path.join(hostPaths.userData, 'fluxloader-mods'))
  const workshop = locate.workshopDir()
  if (workshop) roots.push(workshop)
  return [...new Set(roots.map((r) => path.resolve(r)))]
}

function allRoots() {
  const hp = runtime.host && runtime.host.paths
  return [...modRoots(hp), ...fluxloaderRoots(hp)]
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); return true } catch (_) { return false }
}

/** Record a survived failure once, in both the log and the in-game list. */
function note(error, scope, modId, severity) {
  const p = problems.record({ error, scope, modId, severity })
  runtime.errors.push(error)
  const line = String(error)
  if (runtime.logger) {
    if (severity === 'warn') runtime.logger.warn(line)
    else runtime.logger.error(line)
  }
  return p
}

/**
 * Per-mod enable/disable and loader-wide settings, chosen in the in-game
 * manager. Kept out of the mod directories on purpose: a mod folder may be
 * replaced wholesale by an update or a Workshop sync, and the player's choice
 * should survive that.
 */
function modStatePath() { return path.join(runtime.configDir, 'mods.json') }
function settingsPath() { return path.join(runtime.configDir, 'loader.json') }

function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch (e) {
    runtime.logger && runtime.logger.warn(`${path.basename(file)} unreadable, using defaults: ${e.message}`)
    return fallback
  }
}

function writeJsonFile(file, value) {
  try {
    ensureDir(path.dirname(file))
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
    fs.renameSync(tmp, file)
    return true
  } catch (e) {
    runtime.logger && runtime.logger.error(`could not write ${path.basename(file)}: ${e.message}`)
    return false
  }
}

function loadModStates() { return readJsonFile(modStatePath(), {}) }

function saveModState(id, enabled) {
  const states = loadModStates()
  states[id] = !!enabled
  if (!writeJsonFile(modStatePath(), states)) return false
  runtime.modStates = states
  runtime.logger.info(`mod "${id}" ${enabled ? 'enabled' : 'disabled'} (applies on the next reload)`)
  return true
}

/** Apply persisted choices onto freshly discovered mods. */
function applyModStates(mods) {
  for (const mod of mods) {
    if (Object.prototype.hasOwnProperty.call(runtime.modStates, mod.id)) {
      mod.enabled = runtime.modStates[mod.id] !== false
    }
  }
  return mods
}

// ----------------------------------------------------------- capabilities

function capabilityOf(mod) {
  if (mod.capability) return mod.capability
  return permissions.classify({
    id: mod.id,
    version: mod.version,
    flavour: mod.flavour || 'smln',
    permissions: mod.permissions || [],
    entrypoints: {
      native: !!(mod.main || (mod.entrypoints && (mod.entrypoints.native || mod.entrypoints.electron))),
      game: !!(mod.renderer || (mod.entrypoints && mod.entrypoints.game)),
      worker: !!(mod.worker || (mod.entrypoints && mod.entrypoints.worker)),
    },
  })
}

function schemaFor(mod) {
  const raw = mod.configSchema || (mod.manifest && mod.manifest.configSchema) || {}
  const norm = configStore.normaliseSchema(raw)
  if (!norm.ok) {
    note(norm.error, 'config', mod.id, 'warn')
    return {}
  }
  return norm.schema
}

function configFor(mod) {
  if (runtime.configs.has(mod.id)) return runtime.configs.get(mod.id)
  const store = configStore.createStore({
    dir: runtime.configDir,
    id: mod.id,
    schema: schemaFor(mod),
    logger: runtime.logger.child('config'),
  })
  runtime.configs.set(mod.id, store)
  return store
}

function storageFor(modId) {
  if (runtime.storages.has(modId)) return runtime.storages.get(modId)
  const mod = findMod(modId)
  if (!mod) return null
  const s = modStorage.createStorage({
    baseDir: path.join(path.dirname(runtime.configDir), 'mod-data'),
    modId,
    capability: capabilityOf(mod),
    logger: runtime.logger.child('storage'),
  })
  runtime.storages.set(modId, s)
  return s
}

function networkFor(modId) {
  if (runtime.networks.has(modId)) return runtime.networks.get(modId)
  const mod = findMod(modId)
  if (!mod) return null
  const n = netcap.createNetwork({
    modId,
    capability: capabilityOf(mod),
    logger: runtime.logger.child('net'),
  })
  runtime.networks.set(modId, n)
  return n
}

function allMods() {
  return [...runtime.mods, ...runtime.flMods, ...runtime.officialMods]
}

function findMod(id) {
  return allMods().find((m) => m.id === id) || null
}

/** Is this mod allowed to run its privileged half? */
function isApproved(mod) {
  const cap = capabilityOf(mod)
  // Only the native tier needs a decision; a sandboxed mod has nothing to
  // approve and prompting for one would train people to click through.
  if (cap.tier !== permissions.TIERS.NATIVE) return true
  if (!runtime.approvals) return false
  return runtime.approvals.isApproved({ id: mod.id, version: mod.version, capability: cap })
}

// ---------------------------------------------------------------- summaries

/** Metadata handed to the renderer for the manager UI and the splash. */
function modSummary() {
  return allMods().map((m) => {
    const cap = capabilityOf(m)
    const mine = problems.forMod(m.id)
    return {
      id: m.id,
      name: m.name || m.id,
      version: m.version,
      flavour: m.flavour || 'smln',
      enabled: m.enabled !== false,
      dir: m.dir,
      capability: cap,
      hasSettings: Object.keys(schemaFor(m)).length > 0,
      needsApproval: !isApproved(m),
      failed: mine.some((p) => p.severity === 'error'),
      problems: mine.map((p) => p.message),
    }
  })
}

// ------------------------------------------------------------------ the RPC

/**
 * The game's preload exposes no general-purpose IPC and we cannot modify it,
 * but it does forward renderer logs on `log:write`. SMLN adds a second
 * listener on that channel and treats a reserved scope as a request from the
 * mod manager. Adding a listener does not disturb the game's own.
 */
function installRpc(hostAPI) {
  const ipc = hostAPI && hostAPI.ipcMain
  if (!ipc || typeof ipc.on !== 'function') {
    runtime.logger.warn('no ipcMain from host - the in-game manager cannot reach the main process')
    return
  }
  ipc.on('log:write', (_event, payload) => {
    if (!payload || payload.scope !== 'smln:rpc') return
    let msg
    try { msg = JSON.parse(payload.message) } catch (_) { return }
    if (!msg || typeof msg.action !== 'string') return
    Promise.resolve()
      .then(() => handleRpc(msg))
      .then((result) => reply(msg.id, result))
      .catch((e) => {
        // An RPC handler throwing must answer, not hang the caller forever.
        note(toSmlnError(e, `rpc ${msg.action}`), 'rpc', null, 'warn')
        reply(msg.id, { ok: false, error: String((e && e.message) || e) })
      })
  })
  runtime.logger.debug('rpc listener installed on log:write')
}

/**
 * Main -> renderer. The preload bridge is one-way, so results travel back by
 * evaluating a call in the page. The payload is JSON-encoded rather than
 * interpolated, so nothing in it can be read as code.
 */
function reply(id, result) {
  if (id == null) return
  evalInPage(
    `globalThis.__SMLN__&&globalThis.__SMLN__.__rpcResult&&` +
    `globalThis.__SMLN__.__rpcResult(${JSON.stringify(String(id))},${JSON.stringify(result)})`
  )
}

function evalInPage(js) {
  const win = runtime.gameWindow
  if (!win || win.isDestroyed()) return false
  win.webContents.executeJavaScript(js).catch(() => { /* page navigated away */ })
  return true
}

/** Fire-and-forget main -> renderer event, used by Fluxloader's sendGameEvent. */
function sendToRenderer(action, payload) {
  return evalInPage(
    `globalThis.__SMLN__&&globalThis.__SMLN__.emit&&` +
    `globalThis.__SMLN__.emit(${JSON.stringify(String(action))},${JSON.stringify(payload)})`
  )
}

const rpcRegistry = {
  register(action, handler) { runtime.rpcActions.set(action, handler) },
}

async function handleRpc(msg) {
  const p = msg.payload || {}
  const logger = runtime.logger.child('rpc')

  // Extra actions registered by Fluxloader electron entrypoints.
  const extra = runtime.rpcActions.get(msg.action)
  if (extra) {
    const value = await extra(p)
    return { ok: true, value }
  }

  switch (msg.action) {
    // ---------------------------------------------------------- mod listing
    case 'listMods':
      return { ok: true, mods: modSummary() }

    case 'getLoaderState':
      return {
        ok: true,
        version: VERSION,
        locale: runtime.settings.locale || null,
        watching: !!(runtime.watcher && runtime.watcher.isWatching()),
        game: runtime.install
          ? { name: runtime.install.name, version: runtime.install.version, source: runtime.install.source }
          : null,
      }

    case 'getProblems': {
      const snapshot = problems.toJSON()
      return { ok: true, problems: snapshot.problems, summary: snapshot.summary }
    }

    case 'getModDetails': {
      const mod = findMod(p.id)
      if (!mod) return { ok: false, error: 'no such mod: ' + p.id }
      const cap = capabilityOf(mod)
      return {
        ok: true,
        mod: { id: mod.id, name: mod.name, version: mod.version, flavour: mod.flavour || 'smln', dir: mod.dir },
        capability: cap,
        approval: runtime.approvals ? runtime.approvals.approvalFor(mod.id) : null,
        review: approvals.reviewFor(
          approvals.modInfoOf(mod),
          runtime.approvals ? runtime.approvals.approvalFor(mod.id) : null
        ),
        problems: problems.forMod(mod.id),
      }
    }

    case 'setModEnabled':
      if (typeof p.id !== 'string') return { ok: false, error: 'missing mod id' }
      return { ok: saveModState(p.id, p.enabled !== false), id: p.id }

    case 'setLoaderLocale': {
      if (typeof p.locale !== 'string') return { ok: false, error: 'missing locale' }
      runtime.settings.locale = p.locale
      writeJsonFile(settingsPath(), runtime.settings)
      prelude.invalidate()
      return { ok: true, locale: p.locale }
    }

    // -------------------------------------------------------------- config
    case 'getModConfig': {
      const mod = findMod(p.mod || p.id)
      if (!mod) return { ok: false, error: 'no such mod: ' + (p.mod || p.id) }
      const store = configFor(mod)
      const schema = store.schema || {}
      return {
        ok: true,
        schema,
        order: schema.__order || Object.keys(schema),
        values: store.getAllSync(),
        defaults: configStore.defaults(schema),
      }
    }

    case 'setModConfig': {
      const mod = findMod(p.mod || p.id)
      if (!mod) return { ok: false, error: 'no such mod: ' + (p.mod || p.id) }
      const store = configFor(mod)
      const r = store.set(p.key, p.value)
      if (!r.ok) {
        return { ok: false, error: r.error.message, reason: r.error.detail && r.error.detail.reason
          ? r.error.detail.reason : r.error.message, code: r.error.code }
      }
      const spec = (store.schema || {})[p.key] || {}
      // The renderer half keeps its own copy of a Fluxloader mod's config, so
      // it has to be told; otherwise the UI and the mod disagree.
      runtime.flConfig[mod.id] = store.getAllSync()
      sendToRenderer('smln:config-changed', { mod: mod.id, key: p.key, value: r.value })
      return { ok: true, value: r.value, requiresReload: !!spec.requiresReload }
    }

    case 'resetModConfig': {
      const mod = findMod(p.mod || p.id)
      if (!mod) return { ok: false, error: 'no such mod: ' + (p.mod || p.id) }
      const store = configFor(mod)
      if (p.key == null) store.resetAll()
      else store.reset(p.key)
      runtime.flConfig[mod.id] = store.getAllSync()
      return { ok: true, values: store.getAllSync() }
    }

    // --------------------------------------------------------- capabilities
    case 'modStorage':
    case 'modFs': {
      const store = storageFor(p.mod)
      if (!store) return { ok: false, error: 'no such mod: ' + p.mod }
      const target = msg.action === 'modFs'
        ? (typeof store.scoped === 'function' ? store.scoped(p.root || '') : null)
        : store
      if (!target) {
        return { ok: false, code: 'E_PERMISSION_DENIED',
          error: `mod "${p.mod}" does not hold the "filesystem" permission` }
      }
      const fn = target[p.op]
      if (typeof fn !== 'function') return { ok: false, error: 'unknown storage operation: ' + p.op }
      const r = await fn(p.path, p.data)
      return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error.message, code: r.error.code }
    }

    case 'modNet': {
      const net = networkFor(p.mod)
      if (!net) return { ok: false, error: 'no such mod: ' + p.mod }
      const fn = net[p.op || 'fetch']
      if (typeof fn !== 'function') return { ok: false, error: 'unknown network operation: ' + p.op }
      const r = await fn(p.url, p.init)
      return r.ok
        ? { ok: true, value: r.value !== undefined ? r.value : r.response }
        : { ok: false, error: r.error.message, code: r.error.code }
    }

    // -------------------------------------------------------- approvals
    case 'approveMod': {
      const mod = findMod(p.id)
      if (!mod) return { ok: false, error: 'no such mod: ' + p.id }
      const r = runtime.approvals.approve(mod, capabilityOf(mod))
      return r.ok ? { ok: true, record: r.record } : { ok: false, error: r.error.message }
    }

    case 'revokeMod':
      return { ok: runtime.approvals ? runtime.approvals.revoke(p.id) : false, id: p.id }

    // ------------------------------------------------------------ install
    case 'openModsFolder': {
      const dir = p.dir || modRoots(runtime.host && runtime.host.paths)[0]
      ensureDir(dir)
      try {
        const { shell } = require('electron')
        const problem = await shell.openPath(dir)
        return problem ? { ok: false, error: problem } : { ok: true, dir }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    }

    case 'installModReview': {
      const { dialog } = require('electron')
      const picked = await dialog.showOpenDialog(runtime.gameWindow || undefined, {
        title: 'Install mod from ZIP',
        properties: ['openFile'],
        filters: [{ name: 'Mod archive', extensions: ['zip'] }],
      })
      if (picked.canceled || !picked.filePaths.length) return { ok: false, cancelled: true }

      const zipPath = picked.filePaths[0]
      const previous = runtime.approvals ? runtime.approvals.approvalFor(null) : null
      const inspected = approvals.inspectArchive(zipPath, { previous })
      if (!inspected.ok) return { ok: false, error: inspected.error.message, code: inspected.error.code }

      // Re-run the review against this mod's own previous approval now that we
      // know its id.
      const prior = runtime.approvals ? runtime.approvals.approvalFor(inspected.review.mod.id) : null
      const review = approvals.reviewFor(
        {
          id: inspected.review.mod.id,
          name: inspected.review.mod.name,
          version: inspected.review.mod.version,
          flavour: inspected.flavour,
          permissions: inspected.review.capability.permissions.filter((x) => x !== 'node' ||
            inspected.review.capability.contexts.native === false),
          entrypoints: inspected.review.capability.contexts,
        },
        prior
      )

      const token = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
      runtime.installs.set(token, { zipPath, review, cleanup: inspected.cleanup })
      // Nothing has been written yet. The archive is still just a file the
      // user picked; only installModCommit moves it into the mods folder.
      return { ok: true, token, review }
    }

    case 'installModCommit': {
      const pending = runtime.installs.get(p.token)
      if (!pending) return { ok: false, error: 'that install is no longer pending' }
      runtime.installs.delete(p.token)
      try {
        const result = modManage.installFromZip(pending.zipPath, {
          smlnRoot: modRoots(runtime.host && runtime.host.paths)[0],
          fluxRoot: fluxloaderRoots(runtime.host && runtime.host.paths)[0] ||
            modRoots(runtime.host && runtime.host.paths)[0],
          logger,
        })
        if (result.ok && runtime.approvals) {
          runtime.approvals.approve(
            { id: pending.review.mod.id, version: pending.review.mod.version },
            pending.review.capability
          )
        }
        return result
      } finally {
        try { pending.cleanup && pending.cleanup() } catch (_) { /* best effort */ }
      }
    }

    case 'installModAbort': {
      const pending = runtime.installs.get(p.token)
      runtime.installs.delete(p.token)
      try { pending && pending.cleanup && pending.cleanup() } catch (_) { /* best effort */ }
      return { ok: true }
    }

    // Kept so an older renderer, or a mod calling it directly, still works.
    case 'installMod': {
      const reviewed = await handleRpc({ action: 'installModReview', payload: {} })
      if (!reviewed.ok) return reviewed
      return handleRpc({ action: 'installModCommit', payload: { token: reviewed.token } })
    }

    case 'removeMod':
      return modManage.remove(p.dir, { roots: allRoots(), logger })

    // ------------------------------------------------------------- reload
    case 'reloadMods': {
      if (p.plan && !p.apply) {
        const plan = watcher.planReload([{ modId: null, stage: 'context', reason: 'requested from the mod manager', what: 'manual' }])
        return { ok: true, plan }
      }
      return doReload()
    }

    case 'reloadMod': {
      const mod = findMod(p.id)
      if (!mod) return { ok: false, error: 'no such mod: ' + p.id }
      // A renderer-only swap is safe only when the mod contributes nothing
      // else. Anything with a worker half, a native half or patches needs the
      // full rebuild, and saying so beats half-reloading it.
      const cap = capabilityOf(mod)
      const rendererOnly = !!mod.renderer && !mod.worker && !mod.main &&
        !(mod.entrypoints && (mod.entrypoints.worker || mod.entrypoints.native || mod.entrypoints.electron)) &&
        cap.tier !== permissions.TIERS.NATIVE
      if (!rendererOnly) return { ok: true, stage: 'context' }
      try {
        const source = fs.readFileSync(mod.renderer, 'utf8')
        return {
          ok: true,
          stage: 'renderer',
          source: sandbox.wrapRendererMod({ modId: mod.id, capability: cap, source }),
        }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    }

    default:
      runtime.logger.warn(`unknown rpc action "${msg.action}"`)
      return { ok: false, error: 'unknown action: ' + msg.action }
  }
}

function addPatches(target, list) {
  ;(runtime.patchesByFile[target] || (runtime.patchesByFile[target] = [])).push(...list)
}

// ------------------------------------------------------------ mod assembly

/**
 * Discover, order and load everything, filling `runtime`.
 *
 * Split out of `initialize` so a reload can run exactly the same code. Every
 * stage is individually guarded: a throw anywhere in here is recorded against
 * the mod that caused it and the remaining stages still run.
 */
function assemble() {
  const logger = runtime.logger
  resetCollections()
  runtime.modStates = loadModStates()
  runtime.configs.clear()
  runtime.storages.clear()
  runtime.networks.clear()
  runtime.rpcActions.clear()

  const hostPaths = runtime.host && runtime.host.paths
  const roots = modRoots(hostPaths)
  roots.forEach(ensureDir)
  const flRoots = fluxloaderRoots(hostPaths)

  // ---- native SMLN mods
  try {
    const discovered = modLoader.discover(roots, logger.child('mods'))
    applyModStates(discovered.mods)
    for (const e of discovered.errors) note(e, 'mods', null, 'warn')

    const ordered = modLoader.resolveOrder(discovered.mods)
    for (const e of ordered.errors) note(e, 'mods', e.detail && e.detail.mod)

    const mainLoaded = modLoader.loadMain(ordered.order, {
      smln: { version: VERSION, install: runtime.install, enums },
      host: runtime.host,
    }, logger.child('mods'), { isApproved })
    for (const e of mainLoaded.errors) note(e, 'mods', e.detail && e.detail.mod)
    runtime.mods = discovered.mods
    for (const p of mainLoaded.patches) addPatches(p.target || BUNDLE, [p])

    // Renderer halves, each wrapped in its own capability facade and its own
    // try/catch. `ordered.order` is used rather than every discovered mod, so
    // a mod whose dependencies failed does not get injected anyway.
    for (const mod of ordered.order) {
      if (!mod.renderer) continue
      try {
        runtime.rendererScripts.push(sandbox.wrapRendererMod({
          modId: mod.id,
          capability: capabilityOf(mod),
          source: fs.readFileSync(mod.renderer, 'utf8'),
        }))
      } catch (e) {
        note(new SmlnError('E_MOD_LOAD', `could not read the renderer script of "${mod.id}": ${e.message}`,
          { detail: { mod: mod.id } }), 'mods', mod.id)
      }
      if (mod.worker) {
        try {
          runtime.workerScripts[SIM_WORKER].push(fs.readFileSync(mod.worker, 'utf8'))
        } catch (e) {
          note(new SmlnError('E_MOD_LOAD', `could not read the worker script of "${mod.id}": ${e.message}`,
            { detail: { mod: mod.id } }), 'mods', mod.id)
        }
      }
      if (mod.dir) runtime.modAssets[mod.id] = mod.dir
    }
  } catch (e) {
    note(toSmlnError(e, 'SMLN mod discovery'), 'mods')
  }

  // ---- fluxloader mods
  try {
    const flFound = flCompat.discover(flRoots, logger.child('fluxloader'))
    for (const e of flFound.errors) note(e, 'fluxloader', null, 'warn')
    applyModStates(flFound.mods)
    runtime.flMods = flFound.mods
    for (const m of flFound.mods) {
      for (const w of m.warnings || []) {
        note(new SmlnError('E_MANIFEST_INVALID', `fluxloader mod "${m.id}": ${w}`, { detail: { mod: m.id } }),
          'fluxloader', m.id, 'warn')
      }
    }

    const flActive = runtime.flMods.filter((m) => m.enabled !== false)
    if (flActive.length) {
      const flLoaded = flCompat.loadElectronEntrypoints(flActive, {
        configDir: runtime.configDir,
        sendToRenderer,
        rpc: rpcRegistry,
        isApproved,
      }, logger.child('fluxloader'))
      for (const e of flLoaded.errors) note(e, 'fluxloader', e.detail && e.detail.mod)
      runtime.flEvents = flLoaded.events
      for (const [target, list] of Object.entries(flLoaded.patches)) {
        addPatches(target, list)
        logger.info(`fluxloader: ${list.length} patch(es) for ${target}`)
      }

      for (const mod of flActive) {
        if (mod.dir) runtime.modAssets[mod.id] = mod.dir
        try {
          runtime.flConfig[mod.id] = configFor(mod).getAllSync()
        } catch (_) { runtime.flConfig[mod.id] = {} }

        if (mod.entrypoints.game) {
          try {
            runtime.rendererScripts.push(
              flCompat.wrapEntrypoint(mod, 'game', fs.readFileSync(mod.entrypoints.game, 'utf8')))
          } catch (e) {
            note(new SmlnError('E_MOD_LOAD', `fluxloader mod "${mod.id}": ${e.message}`, { detail: { mod: mod.id } }),
              'fluxloader', mod.id)
          }
        }
        if (mod.entrypoints.worker) {
          try {
            runtime.workerScripts[SIM_WORKER].push(
              flCompat.wrapEntrypoint(mod, 'worker', fs.readFileSync(mod.entrypoints.worker, 'utf8')))
          } catch (e) {
            note(new SmlnError('E_MOD_LOAD', `fluxloader mod "${mod.id}": ${e.message}`, { detail: { mod: mod.id } }),
              'fluxloader', mod.id)
          }
        }
      }
    }
  } catch (e) {
    note(toSmlnError(e, 'fluxloader compatibility'), 'fluxloader')
  }

  // ---- official Sandustry mods (manifestVersion 1)
  try {
    const officialFound = official.discover([...roots, ...flRoots], logger.child('official'))
    applyModStates(officialFound.mods)
    for (const e of officialFound.errors) note(e, 'official', null, 'warn')
    runtime.officialMods = officialFound.mods
    const officialActive = officialFound.mods.filter((m) => m.enabled !== false)

    if (officialActive.length) {
      const { patchesByFile: officialPatchMap, errors: patchErrors } =
        official.collectPatches(officialActive, logger.child('official'))
      for (const e of patchErrors) note(e, 'official', e.detail && e.detail.mod)
      for (const [target, list] of Object.entries(officialPatchMap)) addPatches(target, list)

      for (const mod of officialActive) {
        if (mod.dir) runtime.modAssets[mod.id] = mod.dir
        if (mod.entry) {
          try {
            runtime.rendererScripts.push(
              `/* official mod: ${mod.id}@${mod.version} */\n` + fs.readFileSync(mod.entry, 'utf8'))
          } catch (e) {
            note(new SmlnError('E_MOD_LOAD', `official mod "${mod.id}": ${e.message}`, { detail: { mod: mod.id } }),
              'official', mod.id)
          }
        }
        if (mod.workerEntry) {
          try {
            const src = fs.readFileSync(mod.workerEntry, 'utf8')
            runtime.workerScripts[SIM_WORKER].push(src)
            runtime.workerScripts[MANAGER_WORKER].push(src)
          } catch (e) {
            note(new SmlnError('E_MOD_LOAD', `official mod "${mod.id}": ${e.message}`, { detail: { mod: mod.id } }),
              'official', mod.id)
          }
        }
        if (mod.map) {
          logger.warn(`${mod.id} is a map mod; map blueprints need game-side support and are not loaded yet`)
        }
      }

      if (runtime.install) {
        const reader = require('../asar/reader')
        let archive = null
        try { archive = reader.open(runtime.install.asar) } catch (_) { /* overrides are optional */ }
        const has = (rel) => {
          try { return archive ? archive.has('dist/' + rel) : false } catch (_) { return false }
        }
        runtime.redirects = official.buildOverrides(officialActive, has, logger.child('official'))
        if (archive) archive.close()
      }
    }
  } catch (e) {
    note(toSmlnError(e, 'official mod support'), 'official')
  }

  // ---- core patches last, so a mod cannot displace them
  addPatches(BUNDLE, corePatches)

  const total = Object.values(runtime.patchesByFile).reduce((n, l) => n + l.length, 0)
  const summary = problems.summary()
  logger.info(
    `${runtime.mods.length} SMLN mod(s), ${runtime.flMods.length} fluxloader mod(s), ` +
    `${runtime.officialMods.length} official mod(s), ${total} patch(es) queued` +
    (summary.total ? `, ${summary.errors} error(s) and ${summary.warnings} warning(s) logged` : '')
  )
  if (summary.errors) {
    logger.warn(`${summary.errors} mod problem(s) - the game still starts; open SandLoader Mods > Problems to see them`)
  }
  return { mods: allMods(), errors: runtime.errors }
}

/**
 * What the loader actually did, for the splash to show.
 *
 * The splash used to say "loaded 3 mods" and nothing else, which tells a
 * player nothing when a mod is quietly broken. This is the same information
 * the log file carries, in the order it happened, so the thing on screen while
 * the game boots is a report rather than a spinner.
 */
function bootReport() {
  const patches = []
  for (const [target, list] of Object.entries(runtime.patchesByFile)) {
    for (const p of list) {
      patches.push({
        id: p.id,
        owner: p.owner || 'smln',
        target,
        description: p.description || '',
        required: p.required !== false,
      })
    }
  }
  const summary = problems.summary()
  return {
    version: VERSION,
    game: runtime.install
      ? { name: runtime.install.name, version: runtime.install.version, source: runtime.install.source,
          verified: runtime.install.version === enums.VERIFIED.gameVersion }
      : null,
    mods: modSummary(),
    patches,
    counts: {
      mods: allMods().length,
      enabled: allMods().filter((m) => m.enabled !== false).length,
      smln: runtime.mods.length,
      fluxloader: runtime.flMods.length,
      official: runtime.officialMods.length,
      patches: patches.length,
      rendererScripts: runtime.rendererScripts.length,
      workerScripts: Object.values(runtime.workerScripts).reduce((n, l) => n + l.length, 0),
      assets: Object.keys(runtime.modAssets).length,
      errors: summary.errors,
      warnings: summary.warnings,
    },
    targets: Object.keys(runtime.patchesByFile).filter((k) => runtime.patchesByFile[k].length),
  }
}

function buildPreludeOpts() {
  return {
    modScripts: runtime.rendererScripts,
    mods: modSummary(),
    modAssets: Object.fromEntries(
      Object.keys(runtime.modAssets).map((id) => [id, { baseUrl: 'smln-mods/' + id }])
    ),
    fluxConfig: runtime.flConfig,
    locale: runtime.settings.locale || null,
    problems: problems.toJSON(),
    boot: bootReport(),
    reload: true,
  }
}

// --------------------------------------------------------------- the reload

function doReload() {
  const logger = runtime.logger
  problems.clear()
  const result = watcher.rebuild({
    logger,
    discoverMods: () => assemble(),
    // Rebuilt from the mod definitions by assemble(); returning the live map
    // is correct precisely because resetCollections() emptied it first.
    buildPatches: () => runtime.patchesByFile,
    buildScripts: () => ({
      rendererScripts: runtime.rendererScripts,
      workerScripts: runtime.workerScripts,
    }),
    invalidatePrelude: () => prelude.invalidate(),
    invalidateInterceptor: () => runtime.interceptor && runtime.interceptor.invalidate(),
    reloadWindow: () => {
      const win = runtime.gameWindow
      if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache()
    },
    sendToRenderer,
  })

  if (runtime.watcher) runtime.watcher.update(allMods())
  if (runtime.interceptor && runtime.interceptor.setAssets) {
    runtime.interceptor.setAssets(runtime.modAssets)
  }

  return result.ok
    ? { ok: true, report: { steps: result.steps, mods: modSummary(), problems: problems.toJSON() } }
    : { ok: false, error: String(result.error), report: { steps: result.steps } }
}

// --------------------------------------------------------------- ABI surface

async function initialize(hostAPI) {
  try {
    runtime.host = hostAPI
    const userData = (hostAPI && hostAPI.paths && hostAPI.paths.userData) || process.cwd()
    const smlnDir = path.join(userData, 'smln')
    const logDir = path.join(smlnDir, 'logs')
    const configDir = path.join(smlnDir, 'config')
    ensureDir(logDir)
    ensureDir(configDir)

    const logFile = log.init({ dir: logDir, level: process.env.SMLN_LOG_LEVEL || 'info' })
    const logger = log.createLogger('main')
    runtime.logger = logger
    runtime.configDir = configDir
    runtime.settings = readJsonFile(settingsPath(), {})
    runtime.approvals = approvals.createStore({ dir: configDir, logger: logger.child('approvals') })
    installRpc(hostAPI)

    logger.info(`SandLoader ${VERSION} starting`)
    logger.info(`log file: ${logFile}`)
    logger.info(`electron ${process.versions.electron}, node ${process.versions.node}`)

    const found = locate.tryLocate()
    if (found.ok) {
      runtime.install = found.install
      logger.info(`game: ${found.install.name} ${found.install.version} (via ${found.install.source})`)
      if (found.install.version !== enums.VERIFIED.gameVersion) {
        logger.warn(
          `game version ${found.install.version} differs from the verified version ` +
          `${enums.VERIFIED.gameVersion}; hooks anchor on source strings and should hold, ` +
          'but check the patch report on startup'
        )
      }
    } else {
      note(found.error, 'install')
    }

    assemble()

    if (process.env.SMLN_WATCH === '1' || runtime.settings.watch) {
      runtime.watcher = watcher.createWatcher({
        roots: allRoots(),
        mods: allMods(),
        logger: logger.child('watch'),
        onReload: (plan) => {
          if (plan.stage === 'restart') {
            logger.warn('a main-process entrypoint changed; restart Sandustry to load it')
            return
          }
          doReload()
        },
      })
      runtime.watcher.start()
    }

    return { success: true }
  } catch (e) {
    const err = toSmlnError(e, 'initialize')
    if (runtime.logger) runtime.logger.error(String(err), e && e.stack)
    else console.error('[SMLN] initialize failed:', e)
    // Failure makes the host start the game unmodded - the player still plays.
    return { success: false, message: String(err) }
  }
}

async function startManager() {
  const logger = runtime.logger
  try {
    const { protocol } = require('electron')
    const distDir = runtime.install
      ? runtime.install.distDir
      : path.join(process.resourcesPath || '', 'app.asar', 'dist')

    runtime.interceptor = interceptor.install({
      protocol,
      distDir,
      patchesByFile: runtime.patchesByFile,
      redirects: runtime.redirects,
      modAssets: runtime.modAssets,
      onProblem: ({ error, scope, modId }) => note(error, scope || 'patch', modId),
      logger: logger.child('interceptor'),
      preludeFor(rel) {
        if (rel === BUNDLE) return prelude.build(buildPreludeOpts())
        if (WORKER_TARGETS.includes(rel)) {
          const workers = runtime.workerScripts[rel] || []
          // The worker runtime goes in even with no worker mods: it is what
          // makes game -> worker messaging reach a mod that registers later.
          return prelude.buildWorker(workers)
        }
        return null
      },
    })

    if (!runtime.interceptor.ok) {
      note(new SmlnError('E_IO', 'the file interceptor could not be installed'), 'interceptor')
      logger.error('interceptor unavailable - starting the game unmodded')
      await runtime.host.startGame({ applyPatches: passthrough, unmodded: true })
      return { success: true }
    }

    await runtime.host.startGame({ applyPatches: passthrough, unmodded: false })
    return { success: true }
  } catch (e) {
    const err = toSmlnError(e, 'startManager')
    logger && logger.error(String(err), e && e.stack)
    return { success: false, message: String(err) }
  }
}

/**
 * The host's patch callback. Our interceptor already serves patched code, so
 * this is a pass-through; it exists because the ABI requires it and a future
 * host version may re-enable its own interceptor.
 */
function passthrough(_relativePath, content) { return content }

/** The host calls `api.events.trigger(...)` around scene loads. */
function getAPI() {
  return {
    version: VERSION,
    events: {
      trigger(name, ...args) {
        for (const fn of runtime.listeners[name] || []) {
          try { fn(...args) } catch (e) { note(toSmlnError(e, `event ${name}`), 'events', null, 'warn') }
        }
        // Mirror onto the fluxloader bus so its mods see scene changes too.
        if (runtime.flEvents) runtime.flEvents.emit(name, ...args)
      },
      on(name, fn) { (runtime.listeners[name] || (runtime.listeners[name] = [])).push(fn) },
    },
    get mods() {
      return allMods().map((m) => ({
        id: m.id, version: m.version, flavour: m.flavour || 'smln', capability: capabilityOf(m),
      }))
    },
    get problems() { return problems.list().map((p) => `[${p.code}] ${p.modId || p.scope}: ${p.message}`) },
  }
}

function setGameWindow(win) {
  runtime.gameWindow = win
  runtime.logger && runtime.logger.debug('game window attached')
  try {
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2 && /\[SMLN/.test(message)) runtime.logger.warn('renderer: ' + message)
    })
  } catch (_) { /* console forwarding is a nicety */ }
}

function onGameStarted() {
  const logger = runtime.logger
  if (!logger) return
  logger.info('game window finished loading')
  if (runtime.flEvents) runtime.flEvents.emit('fl:game-started')

  const stats = runtime.interceptor && runtime.interceptor.stats && runtime.interceptor.stats()
  if (!stats) return
  logger.info(`interceptor: ${stats.requests} request(s), ${stats.failures} failure(s)`)
  for (const [file, outcomes] of Object.entries(stats.outcomes || {})) {
    for (const o of outcomes) {
      const line = `  ${file} ${o.status.padEnd(8)} ${o.id}${o.reason ? ' - ' + o.reason : ''}`
      if (o.status === 'failed') logger.error(line)
      else logger.info(line)
    }
  }
}

function closeGame() {
  runtime.logger && runtime.logger.info('game window closed')
  runtime.gameWindow = null
  if (runtime.watcher) { runtime.watcher.stop(); runtime.watcher = null }
  log.close().catch(() => {})
}

const smln = {
  version: VERSION,
  initialize,
  startManager,
  getAPI,
  setGameWindow,
  onGameStarted,
  closeGame,
  /** Exposed for the self-test. */
  _runtime: runtime,
  _handleRpc: handleRpc,
  _assemble: assemble,
  _modSummary: modSummary,
  _bootReport: bootReport,
}

module.exports = smln
module.exports.default = smln
