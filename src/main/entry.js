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
 */

const path = require('path')
const fs = require('fs')

const log = require('../core/log')
const { toSmlnError } = require('../core/errors')
const locate = require('../asar/locate')
const modLoader = require('../mods/loader')
const flCompat = require('../compat/fluxloader')
const modManage = require('../mods/manage')
const interceptor = require('./interceptor')
const { corePatches } = require('../patch/core-patches')
const prelude = require('../renderer/prelude')
const enums = require('../game/enums')

const VERSION = '0.1.0'

const BUNDLE = 'js/bundle.js'
const SIM_WORKER = 'js/simulation-worker.js'
const UTIL_WORKER = 'js/utility-worker.js'

const runtime = {
  host: null,
  logger: null,
  install: null,
  mods: [],
  flMods: [],
  /** @type {Record<string, any[]>} */
  patchesByFile: { [BUNDLE]: [], [SIM_WORKER]: [], [UTIL_WORKER]: [] },
  rendererScripts: [],
  workerScripts: { [SIM_WORKER]: [], [UTIL_WORKER]: [] },
  errors: [],
  configDir: null,
  modStates: {},
  gameWindow: null,
  interceptor: null,
  listeners: Object.create(null),
}

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

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); return true } catch (_) { return false }
}

/**
 * Per-mod enable/disable, chosen in the in-game manager.
 *
 * Kept out of the mod directories on purpose: a mod folder may be replaced
 * wholesale by an update or a Workshop sync, and the player's choice should
 * survive that.
 */
function modStatePath() { return path.join(runtime.configDir, 'mods.json') }

function loadModStates() {
  try {
    const file = modStatePath()
    if (!fs.existsSync(file)) return {}
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (e) {
    runtime.logger && runtime.logger.warn('mods.json unreadable, all mods enabled: ' + e.message)
    return {}
  }
}

function saveModState(id, enabled) {
  try {
    const states = loadModStates()
    states[id] = !!enabled
    ensureDir(runtime.configDir)
    fs.writeFileSync(modStatePath(), JSON.stringify(states, null, 2))
    runtime.modStates = states
    runtime.logger.info(`mod "${id}" ${enabled ? 'enabled' : 'disabled'} (applies next launch)`)
    return true
  } catch (e) {
    runtime.logger.error(`could not persist mod state for ${id}: ${e.message}`)
    return false
  }
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

/** Metadata handed to the renderer for the manager UI and the splash. */
function modSummary() {
  return [
    ...runtime.mods.map((m) => ({
      id: m.id, name: m.name || m.id, version: m.version,
      flavour: 'smln', enabled: m.enabled !== false, dir: m.dir,
    })),
    ...runtime.flMods.map((m) => ({
      id: m.id, name: m.name || m.id, version: m.version,
      flavour: 'fluxloader', enabled: m.enabled !== false, dir: m.dir,
    })),
  ]
}

/**
 * The game's preload exposes no general-purpose IPC and we cannot modify it,
 * but it does forward renderer logs on `log:write`. SMLN adds a second
 * listener on that channel and treats a reserved scope as a one-way command
 * from the mod manager. Adding a listener does not disturb the game's own.
 */
function installRpc(hostAPI) {
  const ipc = hostAPI && hostAPI.ipcMain
  if (!ipc || typeof ipc.on !== 'function') {
    runtime.logger.warn('no ipcMain from host - mod toggles cannot be saved')
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
      .catch((e) => reply(msg.id, { ok: false, error: String(e && e.message || e) }))
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
  const win = runtime.gameWindow
  if (!win || win.isDestroyed()) return
  const js = `globalThis.__SMLN__&&globalThis.__SMLN__.__rpcResult&&` +
    `globalThis.__SMLN__.__rpcResult(${JSON.stringify(String(id))},${JSON.stringify(result)})`
  win.webContents.executeJavaScript(js).catch(() => { /* page navigated away */ })
}

async function handleRpc(msg) {
  const p = msg.payload || {}
  const logger = runtime.logger.child('mods')

  switch (msg.action) {
    case 'setModEnabled':
      if (typeof p.id !== 'string') return { ok: false, error: 'missing mod id' }
      return { ok: saveModState(p.id, p.enabled !== false), id: p.id }

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

    case 'installMod': {
      const { dialog } = require('electron')
      const picked = await dialog.showOpenDialog(runtime.gameWindow || undefined, {
        title: 'Install mod from ZIP',
        properties: ['openFile'],
        filters: [{ name: 'Mod archive', extensions: ['zip'] }],
      })
      if (picked.canceled || !picked.filePaths.length) return { ok: false, cancelled: true }

      const result = modManage.installFromZip(picked.filePaths[0], {
        smlnRoot: modRoots(runtime.host && runtime.host.paths)[0],
        fluxRoot: fluxloaderRoots(runtime.host && runtime.host.paths)[0] ||
          modRoots(runtime.host && runtime.host.paths)[0],
        logger,
      })
      return result
    }

    case 'removeMod':
      return modManage.remove(p.dir, {
        roots: [...modRoots(runtime.host && runtime.host.paths), ...fluxloaderRoots(runtime.host && runtime.host.paths)],
        logger,
      })

    default:
      runtime.logger.warn(`unknown rpc action "${msg.action}"`)
      return { ok: false, error: 'unknown action: ' + msg.action }
  }
}

function addPatches(target, list) {
  ;(runtime.patchesByFile[target] || (runtime.patchesByFile[target] = [])).push(...list)
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
    runtime.modStates = loadModStates()
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
      runtime.errors.push(found.error)
      logger.error('could not identify the game installation: ' + String(found.error))
    }

    // ---- native SMLN mods
    const roots = modRoots(hostAPI && hostAPI.paths)
    roots.forEach(ensureDir)
    const discovered = modLoader.discover(roots, logger.child('mods'))
    applyModStates(discovered.mods)
    runtime.errors.push(...discovered.errors)
    discovered.errors.forEach((e) => logger.warn(String(e)))

    const ordered = modLoader.resolveOrder(discovered.mods)
    runtime.errors.push(...ordered.errors)
    ordered.errors.forEach((e) => logger.error(String(e)))

    const mainLoaded = modLoader.loadMain(ordered.order, {
      smln: { version: VERSION, install: runtime.install, enums },
      host: hostAPI,
    }, logger.child('mods'))
    runtime.errors.push(...mainLoaded.errors)
    runtime.mods = mainLoaded.loaded

    // ---- fluxloader mods
    const flRoots = fluxloaderRoots(hostAPI && hostAPI.paths)
    const flFound = flCompat.discover(flRoots, logger.child('fluxloader'))
    runtime.errors.push(...flFound.errors)
    flFound.errors.forEach((e) => logger.warn(String(e)))
    applyModStates(flFound.mods)
    runtime.flMods = flFound.mods
    const flActive = runtime.flMods.filter((m) => m.enabled !== false)

    if (flActive.length) {
      const flLoaded = flCompat.loadElectronEntrypoints(
        flActive, { configDir }, logger.child('fluxloader'))
      runtime.errors.push(...flLoaded.errors)
      runtime.flEvents = flLoaded.events
      for (const [target, list] of Object.entries(flLoaded.patches)) {
        addPatches(target, list)
        logger.info(`fluxloader: ${list.length} patch(es) for ${target}`)
      }
      // Renderer + worker halves, each behind its own fluxloaderAPI shim.
      for (const mod of flActive) {
        if (mod.entrypoints.game) {
          runtime.rendererScripts.push(
            flCompat.environmentShim(mod, 'game') + '\n' + fs.readFileSync(mod.entrypoints.game, 'utf8'))
        }
        if (mod.entrypoints.worker) {
          const src = flCompat.environmentShim(mod, 'worker') + '\n' + fs.readFileSync(mod.entrypoints.worker, 'utf8')
          runtime.workerScripts[SIM_WORKER].push(src)
        }
      }
    }

    // ---- patches
    addPatches(BUNDLE, corePatches)
    for (const p of mainLoaded.patches) addPatches(p.target || BUNDLE, [p])

    const total = Object.values(runtime.patchesByFile).reduce((n, l) => n + l.length, 0)
    logger.info(
      `${runtime.mods.length} SMLN mod(s), ${runtime.flMods.length} fluxloader mod(s), ` +
      `${total} patch(es) queued` +
      (runtime.errors.length ? `, ${runtime.errors.length} problem(s) logged` : '')
    )

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
      logger: logger.child('interceptor'),
      preludeFor(rel) {
        if (rel === BUNDLE) {
          const modScripts = modLoader.rendererScripts(runtime.mods, logger.child('mods'))
          return prelude.build({
            modScripts: [...modScripts, ...runtime.rendererScripts],
            mods: modSummary(),
          })
        }
        const workers = runtime.workerScripts[rel]
        if (workers && workers.length) {
          return workers.map((s) => `;try{\n${s}\n}catch(e){console.error("[SMLN] worker mod failed:",e)}`).join('\n')
        }
        return null
      },
    })

    if (!runtime.interceptor.ok) {
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
          try { fn(...args) } catch (e) { runtime.logger && runtime.logger.error(`event ${name} failed`, e) }
        }
        // Mirror onto the fluxloader bus so its mods see scene changes too.
        if (runtime.flEvents) runtime.flEvents.emit(name, ...args)
      },
      on(name, fn) { (runtime.listeners[name] || (runtime.listeners[name] = [])).push(fn) },
    },
    get mods() {
      return [
        ...runtime.mods.map((m) => ({ id: m.id, version: m.version, flavour: 'smln' })),
        ...runtime.flMods.map((m) => ({ id: m.id, version: m.version, flavour: 'fluxloader' })),
      ]
    },
    get problems() { return runtime.errors.map(String) },
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
}

module.exports = smln
module.exports.default = smln
