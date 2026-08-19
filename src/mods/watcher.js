'use strict'
/**
 * Mod hot reload: watching, classifying, and rebuilding.
 *
 * WHAT THIS CAN AND CANNOT DO - stated up front, because the honest version is
 * shorter than the marketing one:
 *
 *   JavaScript cannot be unloaded. Once a mod's renderer script has run, its
 *   closures, its patches to shared objects and anything it handed to the game
 *   are simply there. What SandLoader *can* reclaim is what SandLoader handed
 *   out: listeners, timers, messaging handlers and registrations it recorded
 *   (see SMLN.__disposeMod in src/renderer/capabilities.js). Everything else -
 *   a mod that monkey-patched a game function, or captured a reference the
 *   loader never saw - survives a renderer-only reload.
 *
 *   So there are three stages, and the UI is told which one happened:
 *
 *     'renderer'  the mod only contributes renderer code. Dispose it, inject
 *                 the new source, keep playing. No game restart.
 *     'context'   worker code, patches, the manifest or the entrypoint set
 *                 changed. Everything is rebuilt in the main process and the
 *                 game window is reloaded. The Electron app keeps running;
 *                 the current session does not.
 *     'restart'   a main-process (native) entrypoint changed. Node's require
 *                 cache can be cleared, but a module that already registered
 *                 an ipcMain listener, opened a handle or scheduled a timer
 *                 cannot be un-run. Pretending otherwise leaves two copies of
 *                 a mod live at once, which is worse than asking for a restart.
 *
 * The interceptor caches transformed file bodies. Invalidating that cache
 * BEFORE the window reloads is not optional: patching an already-patched body
 * would apply every mod's edits a second time, and the "expected 1 match,
 * found 2" failure that follows names the patch, not the reload that caused it.
 */

const fs = require('fs')
const path = require('path')

const { toSmlnError } = require('../core/errors')

/** Directories and files that produce events but never mean "reload". */
const IGNORED_DIRS = ['.git', 'node_modules', 'logs', '.vscode', '.idea']
const IGNORED_FILES = [/\.tmp$/i, /\.swp$/i, /~$/, /^\.DS_Store$/, /^\.smln-/, /^mods\.json$/, /^approvals\.json$/]

/** What a changed file means. Order matters: first match wins. */
const WATCH_TARGETS = [
  { stage: 'context', what: 'manifest', test: (rel) => /(^|\/)(smln\.mod\.json|modinfo\.json)$/i.test(rel) },
  { stage: 'context', what: 'patches', test: (rel) => /(^|\/)patches\.json$/i.test(rel) },
  { stage: 'renderer', what: 'translations', test: (rel) => /(^|\/)(lang|locales?|i18n)\//i.test(rel) },
  { stage: 'renderer', what: 'assets', test: (rel) => /\.(png|jpe?g|gif|webp|svg|mp3|ogg|wav)$/i.test(rel) },
  { stage: 'renderer', what: 'assets', test: (rel) => /(^|\/)(assets|sprites|textures|sounds)\//i.test(rel) },
  { stage: 'context', what: 'config', test: (rel) => /(^|\/)config\//i.test(rel) },
]

function basenameOf(rel) { return rel.split(/[\\/]/).pop() || '' }

function ignored(rel) {
  const parts = rel.split(/[\\/]/)
  if (parts.some((p) => IGNORED_DIRS.includes(p))) return true
  const base = basenameOf(rel)
  return IGNORED_FILES.some((re) => re.test(base))
}

/**
 * Decide what a changed file inside `mod` means.
 * @param {any} mod        a discovered mod (SMLN or Fluxloader)
 * @param {string} relativePath  path relative to the mod directory, posix-ish
 * @returns {{stage:'renderer'|'context'|'restart', reason:string, what:string}}
 */
function classifyChange(mod, relativePath) {
  const rel = String(relativePath || '').replace(/\\/g, '/')
  const abs = mod && mod.dir ? path.resolve(mod.dir, rel) : null
  const ep = (mod && mod.entrypoints) || {}

  const same = (p) => p && abs && path.resolve(p) === abs

  // Entrypoints first: they are the strongest signal and a file can also match
  // one of the generic patterns below (a worker entrypoint named assets.js).
  if (same(ep.native) || same(mod && mod.main) || same(ep.electron)) {
    return {
      stage: 'restart',
      what: 'native-entrypoint',
      reason: 'a main-process entrypoint changed; already-registered side effects cannot be undone',
    }
  }
  if (same(ep.worker) || same(mod && mod.worker)) {
    return {
      stage: 'context',
      what: 'worker-entrypoint',
      reason: 'worker code is injected into the game\'s worker bundle and only takes effect on a fresh worker',
    }
  }
  if (same(ep.game) || same(mod && mod.renderer)) {
    return { stage: 'renderer', what: 'renderer-entrypoint', reason: 'renderer code changed' }
  }

  for (const target of WATCH_TARGETS) {
    if (target.test(rel)) {
      return {
        stage: target.stage,
        what: target.what,
        reason: `${target.what} changed (${rel})`,
      }
    }
  }

  // A .js file we cannot attribute to a slot is treated as renderer code -
  // the common case is a module the renderer entrypoint requires.
  if (/\.js$/i.test(rel)) {
    return { stage: 'renderer', what: 'source', reason: `${rel} changed` }
  }
  return { stage: 'renderer', what: 'other', reason: `${rel} changed` }
}

const STAGE_RANK = { renderer: 1, context: 2, restart: 3 }

/**
 * Fold several classified changes into one plan. The strongest stage wins:
 * if anything needs a context rebuild, a renderer-only reload would leave the
 * two halves disagreeing about what is loaded.
 *
 * @param {{modId:string, stage:string, reason:string, what:string}[]} changes
 * @returns {{stage:string, mods:string[], reasons:string[], steps:string[], destroysSession:boolean, warn:string|null}}
 */
function planReload(changes, ctx = {}) {
  const list = Array.isArray(changes) ? changes : []
  let stage = 'renderer'
  for (const c of list) {
    if ((STAGE_RANK[c.stage] || 0) > (STAGE_RANK[stage] || 0)) stage = c.stage
  }
  const mods = [...new Set(list.map((c) => c.modId).filter(Boolean))]
  const reasons = [...new Set(list.map((c) => `${c.modId || 'smln'}: ${c.reason}`))]

  const steps = []
  if (stage === 'renderer') {
    steps.push('dispose the affected mods', 're-read their renderer sources', 're-inject them into the page')
  } else if (stage === 'context') {
    steps.push(
      're-run mod discovery, dependency ordering and permission classification',
      'rebuild the patch list from the original definitions',
      'rebuild the renderer and worker script sets',
      'invalidate the prelude and interceptor caches',
      'reload the game window'
    )
  } else {
    steps.push('a main-process entrypoint changed', 'restart Sandustry to load it')
  }

  return {
    stage,
    mods,
    reasons,
    steps,
    // A context reload navigates the window; whatever run was in progress ends.
    destroysSession: stage !== 'renderer',
    warn: stage === 'restart'
      ? 'reload.needsRestart'
      : stage === 'context' ? 'reload.confirmDestructive' : null,
    inGame: !!ctx.inGame,
  }
}

// ---------------------------------------------------------------- watching

/**
 * @param {{roots:string[], mods?:any[], logger:any, debounceMs?:number,
 *          onReload:(plan:any, changes:any[]) => void}} opts
 */
function createWatcher(opts) {
  const logger = opts.logger || { info() {}, warn() {}, error() {}, debug() {} }
  const debounceMs = opts.debounceMs == null ? 250 : opts.debounceMs
  let mods = opts.mods || []
  /** @type {import('fs').FSWatcher[]} */
  const watchers = []
  let timer = null
  let pending = []
  let running = false

  // Recursive fs.watch exists on win32 and darwin only. On Linux we walk the
  // tree and watch each directory; missing that distinction would mean a
  // watcher that silently sees nothing below the top level.
  const recursive = process.platform === 'win32' || process.platform === 'darwin'

  function modFor(absPath) {
    let best = null
    for (const m of mods) {
      if (!m.dir) continue
      const dir = path.resolve(m.dir)
      if (absPath === dir || absPath.startsWith(dir + path.sep)) {
        if (!best || dir.length > path.resolve(best.dir).length) best = m
      }
    }
    return best
  }

  function record(absPath) {
    const mod = modFor(absPath)
    const rel = mod ? path.relative(mod.dir, absPath).replace(/\\/g, '/') : path.basename(absPath)
    if (ignored(rel)) return
    const c = classifyChange(mod || {}, rel)
    pending.push({ modId: mod ? mod.id : null, file: absPath, rel, ...c })
    schedule()
  }

  /**
   * Debounced: an editor saving a file typically produces a rename plus one or
   * more change events, and a formatter on save produces several more. Without
   * this, one Ctrl+S would trigger three reloads.
   */
  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(fire, debounceMs)
  }

  function fire() {
    timer = null
    const changes = pending
    pending = []
    if (!changes.length || running) return
    running = true
    try {
      const plan = planReload(changes)
      logger.info(`change detected in ${plan.mods.join(', ') || 'the mods folder'} -> ${plan.stage} reload`)
      opts.onReload(plan, changes)
    } catch (e) {
      // A watcher callback that throws would take down the main process.
      logger.error('reload handler failed: ' + (e && e.message))
    } finally {
      running = false
    }
  }

  function watchDir(dir) {
    try {
      const w = fs.watch(dir, { recursive, persistent: false }, (_event, filename) => {
        if (!filename) return
        try { record(path.resolve(dir, filename.toString())) }
        catch (e) { logger.debug('watch event ignored: ' + (e && e.message)) }
      })
      // A directory deleted while watched raises 'error'; swallow it rather
      // than letting an unhandled event kill the process.
      w.on('error', (e) => logger.debug(`watcher on ${dir} stopped: ${e && e.message}`))
      watchers.push(w)
      return true
    } catch (e) {
      logger.warn(`cannot watch ${dir}: ${e && e.message}`)
      return false
    }
  }

  function walkAndWatch(dir, depth) {
    if (depth > 6) return
    watchDir(dir)
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return }
    for (const e of entries) {
      if (!e.isDirectory() || IGNORED_DIRS.includes(e.name)) continue
      walkAndWatch(path.join(dir, e.name), depth + 1)
    }
  }

  return {
    start() {
      if (watchers.length) return true
      let any = false
      for (const root of opts.roots || []) {
        if (!fs.existsSync(root)) continue
        if (recursive) any = watchDir(root) || any
        else { walkAndWatch(root, 0); any = watchers.length > 0 }
      }
      if (any) {
        logger.info(`watching ${watchers.length} director${watchers.length === 1 ? 'y' : 'ies'} for mod changes`)
      } else {
        logger.warn('no mod directory could be watched; automatic reload is off')
      }
      return any
    },
    stop() {
      if (timer) { clearTimeout(timer); timer = null }
      pending = []
      for (const w of watchers.splice(0)) {
        try { w.close() } catch (_) { /* already gone */ }
      }
      return true
    },
    isWatching() { return watchers.length > 0 },
    update(next) { mods = next || [] },
    pending() { return pending.slice() },
  }
}

// --------------------------------------------------------------- rebuilding

/**
 * @typedef {Object} RebuildCtx
 * @property {any} logger
 * @property {() => {mods:any[], errors:any[]}} discoverMods
 *           Re-runs discovery, dependency ordering and permission classification.
 * @property {(mods:any[]) => Record<string, any[]>} buildPatches
 *           Returns a FRESH patch map. Must not append to the previous one.
 * @property {(mods:any[]) => {rendererScripts:string[], workerScripts:Record<string,string[]>}} buildScripts
 * @property {() => void} invalidateInterceptor
 * @property {() => void} invalidatePrelude
 * @property {() => void} reloadWindow
 * @property {(action:string, payload:any) => void} [sendToRenderer]
 */

/**
 * Rebuild everything from the mods on disk and reload the game window.
 *
 * The order below is the contract. Steps 4 and 5 in particular must not be
 * swapped: the window must not start requesting files until both caches are
 * empty, or it will be served the previous launch's already-patched bundle.
 *
 * @param {RebuildCtx} ctx
 */
function rebuild(ctx) {
  const logger = ctx.logger
  const steps = []
  const note = (s) => { steps.push(s); logger.info('reload: ' + s) }

  try {
    const discovered = ctx.discoverMods()
    note(`discovered ${discovered.mods.length} mod(s)` +
      (discovered.errors && discovered.errors.length ? `, ${discovered.errors.length} problem(s)` : ''))

    // Built from the mod definitions every time. Appending to the previous map
    // is how a reloaded loader ends up applying the same patch twice.
    const patches = ctx.buildPatches(discovered.mods)
    const patchCount = Object.values(patches).reduce((n, l) => n + l.length, 0)
    note(`rebuilt ${patchCount} patch(es) from scratch`)

    const scripts = ctx.buildScripts(discovered.mods)
    note(`rebuilt ${scripts.rendererScripts.length} renderer script(s)`)

    ctx.invalidatePrelude()
    note('prelude cache cleared')
    ctx.invalidateInterceptor()
    note('interceptor cache cleared (the next request re-transforms the original source)')

    ctx.reloadWindow()
    note('game window reloaded')

    return { ok: true, steps, mods: discovered.mods, patches, scripts, errors: discovered.errors || [] }
  } catch (e) {
    const err = toSmlnError(e, 'reload')
    logger.error(String(err))
    return { ok: false, steps, error: err }
  }
}

module.exports = { createWatcher, classifyChange, planReload, rebuild, WATCH_TARGETS, ignored }
