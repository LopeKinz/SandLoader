try {
  const { app } = require('electron');
  if (app && app.commandLine) app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
} catch (_) {}
'use strict'
/**
 * The non-Steam bootstrap.
 *
 * `install.js` writes a three-file `resources/app/` directory next to the
 * untouched `app.asar`; Electron prefers `app` over `app.asar` when resolving
 * the application package, so the stub in there runs first and requires this
 * module. See src/asar/platform.js for why that is the attach point and what
 * the trade-offs are.
 *
 * What happens here is the same sequence the Steam host performs, in the same
 * order, because SandLoader's ABI was written against it:
 *
 *   1. build the host API object the loader expects
 *   2. loader.initialize(hostAPI)      - discovery, patches, mod loading
 *   3. loader.startManager()           - installs the file interceptor, then
 *                                        calls back into startGame()
 *   4. startGame() requires the real app.asar/main.js, which creates the
 *      window; by then the interceptor is already serving patched files
 *   5. setGameWindow / onGameStarted / closeGame follow the window's life
 *
 * Step 3 before step 4 is the whole trick: the interceptor must own the file
 * protocol before a single asset is requested, or the game loads its original
 * bundle and the patches quietly do nothing.
 *
 * If any of that fails, the original main.js is required anyway and the player
 * gets an unmodified game. A working unmodded game beats a half-patched broken
 * one - that rule is why every step below is inside a try.
 *
 * Nothing at the top level requires `electron`, so this file can be loaded and
 * inspected by the self-test in plain Node.
 */

const path = require('path')
const fs = require('fs')

const ORIGINAL_MAIN = 'main.js'

/** Where the untouched game actually lives, from inside `resources/app`. */
function originalAppRoot() {
  const resources = process.resourcesPath || path.resolve(__dirname, '..', '..', '..')
  const target = fs.existsSync(path.join(resources, 'game.asar')) ? 'game.asar' : 'app.asar'; return path.join(resources, target)
}

/**
 * Build the object the game's own `initializeFluxloader` passes to a loader.
 * Reproduced field for field from the shipped main.js; a loader written
 * against the Steam host must find exactly the same shape here.
 *
 * @param {{startGame:(opts:any)=>Promise<any>}} hooks
 */
function hostApiFor(hooks) {
  const { app, ipcMain, shell, dialog, screen, BrowserWindow } = require('electron')
  const userData = app.getPath('userData')
  return {
    createWindow: hooks.createWindow || (() => null),
    ipcMain,
    shell,
    dialog,
    screen,
    BrowserWindow,
    paths: {
      // No Workshop folder off Steam; the loader treats a null as "none".
      fluxloader: null,
      mods: path.join(userData, 'fluxloader-mods'),
      userData,
      config: path.join(userData, 'smln', 'config'),
    },
    startGame: hooks.startGame,
  }
}

/**
 * What `boot()` would do, without doing any of it. Exists so the self-test can
 * verify the ordering in plain Node, where `electron` cannot be required.
 * @param {{resourcesPath?:string}} [opts]
 */
function plan(opts = {}) {
  const resources = opts.resourcesPath || process.resourcesPath ||
    path.resolve(__dirname, '..', '..', '..')
  const asar = path.join(resources, 'app.asar')
  const mainFile = path.join(asar, ORIGINAL_MAIN)
  let originalPresent = false
  try {
    const previous = process.noAsar
    process.noAsar = true
    try { originalPresent = fs.existsSync(asar) } finally { process.noAsar = previous }
  } catch (_) { /* treated as absent */ }

  return {
    resources,
    asar,
    mainFile,
    originalPresent,
    steps: [
      'resolve the original app.asar next to this bootstrap',
      'require SandLoader (src/main/entry.js)',
      'loader.initialize(hostAPI)',
      'loader.startManager() - installs the file interceptor',
      'startGame() -> require(app.asar/main.js), which creates the window',
      'setGameWindow / onGameStarted / closeGame follow the window',
    ],
    fallback: 'on any failure, require app.asar/main.js unmodified so the game still runs',
  }
}

/**
 * Run the bootstrap. Called by the generated stub in `resources/app`.
 * @param {{loader?:any}} [opts]
 */
function boot(opts = {}) {
  const logFile = path.resolve(__dirname, "../../smln_debug.log");
  const flog = (m) => fs.appendFileSync(logFile, new Date().toISOString() + " " + m + "\n");
  flog("=== BOOT STARTED ===");
  const asar = originalAppRoot()
  const mainFile = path.join(asar, ORIGINAL_MAIN)

  /** Hand control to the untouched game, whatever happened before. */
  function runOriginal(why) { flog("FALLBACK: " + why);
    if (why) console.warn('[SMLN] starting Sandustry unmodded: ' + why)
    try {
      require(mainFile)
      return true
    } catch (e) {
      console.error('[SMLN] could not start the game at all: ' + (e && e.message))
      throw e
    }
  }

  let loader
  try {
    loader = opts.loader || require('../main/entry')
  } catch (e) {
    return runOriginal('SandLoader failed to load: ' + (e && e.message))
  }

  let started = false
  const hostAPI = hostApiFor({
    /**
     * The loader calls this once its interceptor is live. Requiring the real
     * main.js here - rather than earlier - is what guarantees the ordering.
     */
    async startGame({ unmodded } = {}) {
      if (started) return { success: true }
      started = true
      if (unmodded) console.warn('[SMLN] the loader asked for an unmodded start')
      require(mainFile)
      return { success: true }
    },
  })

  return Promise.resolve()
    .then(() => loader.initialize(hostAPI))
    .then((result) => {
      if (!result || result.success === false) {
        throw new Error((result && result.message) || 'initialize() reported failure')
      }
      return loader.startManager()
    })
    .then((result) => {
      if (!result || result.success === false) {
        throw new Error((result && result.message) || 'startManager() reported failure')
      }
      flog("ATTACHING WINDOW"); attachWindow(loader)
      return { ok: true }
    })
    .catch((e) => {
      if (!started) runOriginal((e && e.message) || String(e))
      else console.error('[SMLN] the loader failed after the game had started: ' + (e && e.message))
      return { ok: false, error: (e && e.message) || String(e) }
    })
}

/**
 * The Steam host calls setGameWindow/onGameStarted/closeGame for us. Off
 * Steam nobody does, so watch Electron's own window events instead - the
 * loader's contract is the same either way.
 */
function attachWindow(loader) {
  let electron
  try { electron = require('electron') } catch (_) { return }
  const { BrowserWindow, app } = electron

  const attach = (win) => {
    try { loader.setGameWindow(win) } catch (_) { /* the loader logs its own */ }
    win.webContents.once('did-finish-load', () => {
      try { loader.onGameStarted() } catch (_) { /* ditto */ }
    })
    win.once('closed', () => {
      try { loader.closeGame() } catch (_) { /* ditto */ }
    })
  }

  const existing = BrowserWindow.getAllWindows()
  if (existing.length) existing.forEach(attach)
  app.on('browser-window-created', (_e, win) => attach(win))
}

module.exports = { boot, plan, hostApiFor, attachWindow, ORIGINAL_MAIN, originalAppRoot }
