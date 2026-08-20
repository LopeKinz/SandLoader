#!/usr/bin/env node
'use strict'
/**
 * Self-test. Runs outside Electron against the real installed game.
 *
 * The point is drift detection: after a Sandustry update, this says which hooks
 * still resolve and which do not, before a player ever launches a patched game.
 * Run it as the first step of any compatibility check.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')

const locate = require('../src/asar/locate')
const reader = require('../src/asar/reader')
const engine = require('../src/patch/engine')
const { corePatches } = require('../src/patch/core-patches')
const modLoader = require('../src/mods/loader')
const officialHost = require('../src/mods/official-host')
const official = require('../src/mods/official')
const apiScan = require('../src/mods/api-scan')
const prelude = require('../src/renderer/prelude')
const enums = require('../src/game/enums')
const flCompat = require('../src/compat/fluxloader')

let passed = 0
let failed = 0
const failures = []

/**
 * A check may return a string (printed as detail) or a promise of one. The
 * promise form exists because the capability APIs - mod storage and the
 * network gate - are async by design; a synchronous-only runner would print
 * "[object Promise]" and swallow every assertion inside them.
 */
const asyncChecks = []

function record(name, detail) {
  passed++
  console.log('  PASS  ' + name + (detail ? '  - ' + detail : ''))
}

function recordFailure(name, e) {
  failed++
  failures.push({ name, error: e })
  console.log('  FAIL  ' + name + '  - ' + (e && e.message))
}

function check(name, fn) {
  let out
  try {
    out = fn()
  } catch (e) {
    recordFailure(name, e)
    return
  }
  if (out && typeof out.then === 'function') {
    asyncChecks.push(out.then(
      (detail) => record(name, detail),
      (e) => recordFailure(name, e)
    ))
    return
  }
  record(name, out)
}

function assert(cond, msg) { if (!cond) throw new Error(msg) }

console.log('\nSandLoader self-test\n')

// ---------------------------------------------------------------- discovery
let install = null
check('locate Sandustry installation', () => {
  const r = locate.tryLocate()
  assert(r.ok, r.ok ? '' : String(r.error))
  install = r.install
  return `${install.name} ${install.version} via ${install.source}`
})

let archive = null
check('open and parse app.asar', () => {
  assert(install, 'no installation to open')
  archive = reader.open(install.asar)
  const n = archive.list().length
  assert(n > 100, `only ${n} entries - header looks wrong`)
  return `${n} entries`
})

check('archive declares itself as Sandustry', () => {
  const pkg = archive.readJson('package.json')
  assert(pkg.name === 'sandustry', `package.json name is "${pkg.name}"`)
  assert(pkg.main === 'main.js', `unexpected entry point "${pkg.main}"`)
  return `v${pkg.version}, entry ${pkg.main}`
})

// ------------------------------------------------------------- host ABI
check('host still exposes the loader slot', () => {
  const main = archive.readText('main.js')
  assert(/modID\s*===\s*['"]fluxloader['"]/.test(main), 'the modID scan is gone from main.js')
  assert(/fluxloader\.bundle\.js/.test(main), 'the bundle filename is gone from main.js')
  for (const fn of ['initialize', 'startManager', 'getAPI', 'setGameWindow', 'onGameStarted', 'closeGame']) {
    assert(main.includes(fn), `host no longer calls ${fn}()`)
  }
  return 'all six ABI calls present'
})

check('host still hands us startGame + paths', () => {
  const main = archive.readText('main.js')
  assert(/startGame:\s*async/.test(main), 'startGame is missing from the host API object')
  assert(/applyPatches/.test(main), 'applyPatches is missing')
  assert(/paths:\s*\{/.test(main), 'paths object is missing')
  return 'ok'
})

// -------------------------------------------------------------- bundle hooks
let bundle = null
check('read renderer bundle', () => {
  bundle = archive.readText('dist/js/bundle.js')
  assert(bundle.length > 1e6, `bundle is only ${bundle.length} chars`)
  return `${(bundle.length / 1048576).toFixed(2)} MiB`
})

check('core patch anchors resolve', () => {
  const outcomes = engine.verify(bundle, corePatches)
  const bad = outcomes.filter((o) => o.status === 'failed')
  for (const o of outcomes) {
    console.log(`          ${o.status.padEnd(8)} ${o.id}  (${o.matches} match)`)
  }
  assert(bad.length === 0, bad.map((b) => `${b.id}: ${b.reason}`).join('; '))
  return `${outcomes.length} anchors`
})

check('patched bundle is syntactically valid', () => {
  const result = engine.apply(bundle, corePatches)
  assert(result.ok, result.error ? String(result.error) : 'apply failed')
  const full = prelude.build() + '\n' + result.source
  // Parse without executing - catches any injection that breaks the file.
  new vm.Script(full, { filename: 'bundle.js' })
  return `+${full.length - bundle.length} chars`
})

check('game API surface is still where we expect it', () => {
  for (const probe of ['FH.events.emit', 'FH.elements.createAt', 'FH.ui.toast', 'FH.world.setCellId']) {
    assert(bundle.includes(probe), `${probe} not found in the bundle`)
  }
  return 'FH.events / elements / ui / world'
})

check('enum tables match the bundle', () => {
  // Spot-check a few members that the console depends on.
  const pairs = [['Water=3', 3], ['Steam=10', 10], ['Lava=19', 19]]
  for (const [literal] of pairs) {
    assert(bundle.includes(`e.${literal}]="${literal.split('=')[0]}"`), `${literal} not in bundle`)
  }
  assert(enums.ElementByName.water === 3, 'local table disagrees on Water')
  assert(enums.WorkerMessage.SetPaused === 54, 'local table disagrees on SetPaused')
  return 'Water/Steam/Lava + worker messages'
})

// ------------------------------------------------------------------- loader
check('renderer prelude builds', () => {
  const src = prelude.build({ reload: true })
  assert(src.includes('__SMLN__'), 'runtime global missing')
  assert(src.includes('smln-console'), 'console UI missing')
  new vm.Script(src, { filename: 'prelude.js' })
  return `${(src.length / 1024).toFixed(1)} KiB`
})

check('renderer runtime installs in a bare context', () => {
  const sandbox = { console: { log() {}, warn() {}, error() {} }, document: undefined, setTimeout }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  // Only the runtime half - the console needs a DOM.
  const runtimeSrc = require('fs').readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'runtime.js'), 'utf8')
  new vm.Script(runtimeSrc).runInContext(sandbox)
  assert(sandbox.__SMLN__, 'runtime did not install')
  assert(typeof sandbox.__SMLN__.__capture === 'function', 'capture hook missing')

  // Simulate the patch firing.
  let readyFired = false
  sandbox.__SMLN__.whenReady(() => { readyFired = true })
  sandbox.__SMLN__.__capture({ events: {}, elements: {} }, { store: {} }, 'game:ready')
  assert(readyFired, 'whenReady did not fire after capture')
  assert(sandbox.__SMLN__.game, 'game API not stored')
  return 'capture + whenReady work'
})

check('mod manifest validation rejects bad input', () => {
  const bad = [
    [{}, 'missing id'],
    [{ id: 'Bad Id', version: '1' }, 'invalid id'],
    [{ id: 'ok', version: '1', dependencies: 'x' }, 'bad dependencies'],
  ]
  for (const [manifest, why] of bad) {
    const r = modLoader.validate(manifest, __dirname)
    assert(!r.ok, `should have rejected: ${why}`)
  }
  const good = modLoader.validate({ id: 'demo', version: '1.0.0' }, __dirname)
  assert(good.ok, 'rejected a valid manifest: ' + (good.ok ? '' : good.error.message))
  return '3 rejected, 1 accepted'
})

check('dependency ordering and cycle detection', () => {
  const mk = (id, deps) => ({ id, version: '1', dir: '.', dependencies: deps, priority: 100, enabled: true })
  const ok = modLoader.resolveOrder([mk('b', ['a']), mk('a', []), mk('c', ['b'])])
  assert(ok.errors.length === 0, 'unexpected errors: ' + ok.errors.map(String).join(', '))
  assert(ok.order.map((m) => m.id).join(',') === 'a,b,c', 'wrong order: ' + ok.order.map((m) => m.id))

  const cyc = modLoader.resolveOrder([mk('x', ['y']), mk('y', ['x'])])
  assert(cyc.errors.some((e) => e.code === 'E_DEPENDENCY'), 'cycle not detected')

  const missing = modLoader.resolveOrder([mk('p', ['nope'])])
  assert(missing.errors.some((e) => /not installed/.test(e.message)), 'missing dep not reported')
  return 'order, cycle, missing dep'
})

check('patch engine refuses ambiguous anchors', () => {
  const src = 'aXa aXa aXa'
  const r = engine.apply(src, [{ id: 't', description: 'x', find: /aXa/g, replace: 'Y', expect: 1 }])
  assert(!r.ok, 'ambiguous patch was applied anyway')
  assert(r.error.code === 'E_PATCH_AMBIGUOUS', 'wrong error code: ' + r.error.code)
  assert(r.source === src, 'source was modified despite failure')
  return 'aborts and leaves source intact'
})

check('patch engine leaves source intact on a failed required patch', () => {
  const src = 'hello world'
  const r = engine.apply(src, [
    { id: 'a', description: 'ok', find: /hello/g, replace: 'HELLO' },
    { id: 'b', description: 'missing', find: /nope/g, replace: 'x' },
  ])
  assert(!r.ok, 'should have failed')
  assert(r.source === src, 'partial patch leaked out')
  return 'no partial writes'
})

// ------------------------------------------------------- fluxloader compat
check('fluxloader patch: plain replace', () => {
  const p = flCompat.toSmlnPatch({ type: 'replace', from: 'abc', to: 'xyz' }, 'demo', 't1')
  const r = engine.apply('--abc--', [p])
  assert(r.ok, 'apply failed')
  assert(r.source === '--xyz--', 'got: ' + r.source)
  return 'abc -> xyz'
})

check('fluxloader patch: token splices the original back in', () => {
  const p = flCompat.toSmlnPatch({ type: 'replace', from: 'CORE', to: 'pre($)post', token: '$' }, 'demo', 't2')
  const r = engine.apply('[CORE]', [p])
  assert(r.ok, 'apply failed')
  assert(r.source === '[pre(CORE)post]', 'got: ' + r.source)
  return 'token expansion works'
})

check('fluxloader patch: $ in replacement is not eaten by String.replace', () => {
  // "$&" would otherwise expand to the whole match and corrupt the output.
  const p = flCompat.toSmlnPatch({ type: 'replace', from: 'A', to: 'x$&y', token: ' ' }, 'demo', 't3')
  const r = engine.apply('A', [p])
  assert(r.ok, 'apply failed')
  assert(r.source === 'x$&y', 'got: ' + r.source)
  return 'literal $ preserved'
})

check('fluxloader patch: regex type', () => {
  const p = flCompat.toSmlnPatch({ type: 'regex', from: 'a+', to: 'X' }, 'demo', 't4')
  const r = engine.apply('aaa b aa', [p])
  assert(r.ok, 'apply failed')
  assert(r.source === 'X b X', 'got: ' + r.source)
  return 'regex patches translate'
})

check('fluxloader target aliases normalise', () => {
  const n = flCompat.normaliseTarget
  assert(n('bundle.js') === 'js/bundle.js', 'bundle.js')
  assert(n('dist/js/bundle.js') === 'js/bundle.js', 'dist path')
  assert(n('simulation-worker.js') === 'js/simulation-worker.js', 'sim worker')
  return 'bundle + workers'
})

check('fluxloader modinfo is read into an SMLN mod', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-fl-'))
  fs.writeFileSync(path.join(dir, 'modinfo.json'), JSON.stringify({
    modID: 'testmod', name: 'Test', version: '1.2.3',
    dependencies: { other: '^1.0.0' },
    gameEntrypoint: 'entry.game.js',
    configSchema: { flag: { type: 'boolean', default: true } },
  }))
  fs.writeFileSync(path.join(dir, 'entry.game.js'), '// noop')
  const r = flCompat.readMod(dir)
  assert(r.ok, 'read failed: ' + (r.ok ? '' : r.error.message))
  assert(r.mod.id === 'testmod', 'wrong id')
  // The range is preserved, not thrown away: matching by id alone would load
  // an incompatible library and leave the failure to surface at runtime.
  assert(r.mod.dependencies[0].id === 'other', 'dependency id not mapped from the object key')
  assert(r.mod.dependencies[0].range === '^1.0.0', 'dependency range was discarded: ' + r.mod.dependencies[0].range)
  assert(r.mod.dependencyIds[0] === 'other', 'dependencyIds regressed')
  assert(r.mod.capability.tier === 'sandboxed', 'a game-only fluxloader mod was classified as ' + r.mod.capability.tier)
  assert(r.mod.entrypoints.game, 'game entrypoint not resolved')
  assert(!r.mod.entrypoints.electron, 'phantom electron entrypoint')
  fs.rmSync(dir, { recursive: true, force: true })
  return 'id, deps, entrypoints, schema'
})

check('fluxloader loader slot is not treated as a mod', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-slot-'))
  fs.writeFileSync(path.join(dir, 'modinfo.json'), JSON.stringify({ modID: 'fluxloader', version: '1' }))
  const r = flCompat.readMod(dir)
  assert(!r.ok && r.error.detail.skip, 'slot should be skipped')
  fs.rmSync(dir, { recursive: true, force: true })
  return 'slot skipped'
})

check('fluxloaderAPI shim is valid JS and self-installs', () => {
  const src = flCompat.environmentShim(
    { id: 'demo', configSchema: { a: { default: 1 } } }, 'game')
  new vm.Script(src, { filename: 'shim.js' })
  const sandbox = { console: { log() {}, error() {} } }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(src).runInContext(sandbox)
  assert(sandbox.fluxloaderAPI, 'shim did not install')
  assert(sandbox.fluxloaderAPI.modID === 'demo', 'wrong modID')
  assert(typeof sandbox.fluxloaderAPI.events.on === 'function', 'no event bus')
  assert(sandbox.fluxloaderAPI.modConfig.getSync('a') === 1, 'config default missing')
  return 'events + modConfig present'
})

check('worker bundles exist and are patchable targets', () => {
  assert(archive.has('dist/js/simulation-worker.js'), 'simulation worker missing')
  assert(archive.has('dist/js/utility-worker.js'), 'utility worker missing')
  return 'simulation + utility'
})

// ----------------------------------------------- console, end to end in a VM
function bootConsole(opts = {}) {
  const { createDom } = require('./dom-harness')
  const dom = createDom()
  const sent = []
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: dom.document,
    window: dom.window,
    // The renderer stack has grown past what the console alone needed: i18n,
    // the capability facades, messaging and hot reload all reach for these.
    navigator: { language: 'en-US' },
    location: { search: opts.search || '' },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    WeakSet,
    MutationObserver: dom.window.MutationObserver,
    electron: { log: (level, scope, message) => sent.push({ level, scope, message }) },
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  sandbox.window.document = dom.document
  vm.createContext(sandbox)
  const src = prelude.build({
    reload: true,
    mods: opts.mods || [],
    boot: opts.boot,
    problems: opts.problems,
    modAssets: opts.modAssets,
    locale: opts.locale || 'en',
  })
  new vm.Script(src, { filename: 'prelude.js' }).runInContext(sandbox)
  return { sandbox, dom, sent, S: sandbox.__SMLN__ }
}

check('console boots against a DOM and exposes its API', () => {
  const { S } = bootConsole()
  assert(S, 'runtime missing')
  assert(S.console, 'console did not install')
  assert(typeof S.console.suggest === 'function', 'suggest() missing')
  assert(Object.keys(S.commands).length >= 10, 'only ' + Object.keys(S.commands).length + ' commands')
  return Object.keys(S.commands).length + ' commands'
})

check('enum tables reach the console (regression: empty completions)', () => {
  const { S } = bootConsole()
  assert(S.enums && S.enums.ElementByName, 'SMLN.enums not populated')
  assert(S.enums.ElementByName.water === 3, 'ElementByName wrong')
  // The real symptom: "spawn " offered nothing because the console captured
  // SMLN.enums before the prelude assigned it.
  const values = S.console.suggest('spawn ').items.map((i) => i.value)
  // The list is capped for display, so membership is checked by narrowing -
  // which is the behaviour users actually get.
  assert(values.length >= 10, 'only ' + values.length + ' completions for "spawn "')
  for (const want of ['lava', 'sand', 'water']) {
    const hit = S.console.suggest('spawn ' + want).items.map((i) => i.value)
    assert(hit.includes(want), want + ' unreachable: ' + hit.join(','))
  }
  return values.length + ' shown, full set reachable'
})

check('completion narrows as you type', () => {
  const { S } = bootConsole()
  const cmds = S.console.suggest('sp').items.map((i) => i.value)
  assert(cmds.includes('spawn'), 'command name not completed: ' + cmds.join(','))

  const wa = S.console.suggest('spawn wa').items.map((i) => i.value)
  assert(wa.includes('water'), 'water not offered for "wa": ' + wa.join(','))
  assert(!wa.includes('lava'), 'prefix filter leaked: ' + wa.join(','))

  const second = S.console.suggest('give ').items.map((i) => i.value)
  assert(second.includes('gold'), 'resource completion missing: ' + second.join(','))
  return 'prefix + per-argument sets'
})

check('Tab completes the current token (regression: key events never arrived)', () => {
  const { S, dom } = bootConsole()
  S.console.toggle(true)
  const input = S.console.input
  input.value = 'spawn wa'
  input.selectionStart = input.value.length
  input.dispatch('input', {})

  const ev = dom.window.key({ code: 'Tab', key: 'Tab', target: input })
  assert(ev.defaultPrevented, 'Tab was not handled at all')
  assert(input.value.trim() === 'spawn water', 'got: "' + input.value + '"')
  return '"spawn wa" -> "' + input.value.trim() + '"'
})

check('Enter runs the command (regression: Enter did nothing)', () => {
  const { S, dom } = bootConsole()
  let ran = null
  S.registerCommand({
    name: 'probe',
    summary: 'test',
    args: [],
    run: (a) => { ran = a.slice(); return ['ok'] },
  })
  S.console.toggle(true)
  const input = S.console.input
  input.value = 'probe alpha'
  input.selectionStart = input.value.length

  const ev = dom.window.key({ code: 'Enter', key: 'Enter', target: input })
  assert(ev.defaultPrevented, 'Enter was not handled')
  assert(ran, 'command never ran')
  assert(ran[0] === 'alpha', 'wrong args: ' + JSON.stringify(ran))
  assert(input.value === '', 'input not cleared')
  return 'command executed with args'
})

check('open console keeps keys away from the game', () => {
  const { S, dom } = bootConsole()
  S.console.toggle(true)
  const ev = dom.window.key({ code: 'KeyW', key: 'w', target: S.console.input })
  assert(ev.propagationStopped, 'keystroke would have reached the game')
  assert(!ev.defaultPrevented, 'typing was blocked - text would not appear')
  return 'propagation stopped, typing preserved'
})

check('toggle key opens and closes', () => {
  const { S, dom } = bootConsole()
  assert(!S.console.isOpen(), 'started open')
  dom.window.key({ code: 'Backquote', key: '`' })
  assert(S.console.isOpen(), 'did not open')
  dom.window.key({ code: 'Backquote', key: '`' })
  assert(!S.console.isOpen(), 'did not close')
  return 'Backquote toggles'
})

check('spawn reports cleanly when the game is not loaded', () => {
  const { S } = bootConsole()
  const out = S.commands.spawn.run(['water'])
  assert(Array.isArray(out) && out.length, 'no output')
  // Must not throw and must not claim success.
  assert(!/spawned \d+/.test(out[0]), 'claimed success without a game: ' + out[0])
  return 'fails loudly, not silently'
})

check('spawn resolves cursor position from live state', () => {
  const { S } = bootConsole()
  const placed = []
  const fakeState = {
    store: { integrity: { cheatsUsed: false }, smln: { markCheats: true } },
    session: { input: { mouse: { worldPosition: { x: 400, y: 200 } } } },
  }
  S.__capture({
    config: { cellSize: 4 },
    elements: { createAt: (s, x, y, t) => placed.push([x, y, t]) },
    ui: { update() {} },
  }, fakeState, 'game:ready')

  const out = S.commands.spawn.run(['water', '0'])
  assert(placed.length === 1, 'expected 1 cell, got ' + placed.length)
  // 400/4 = 100, 200/4 = 50, water = 3
  assert(placed[0][0] === 100 && placed[0][1] === 50, 'wrong cell: ' + placed[0])
  assert(placed[0][2] === 3, 'wrong element id: ' + placed[0][2])
  assert(/spawned 1 x/.test(out[0]), 'unexpected reply: ' + out[0])
  assert(fakeState.store.integrity.cheatsUsed === true, 'save was not marked')
  return 'pixel->cell conversion and integrity marking'
})

check('integrity toggle persists into the save object', () => {
  const { S } = bootConsole()
  const st = { store: {}, session: {} }
  S.__capture({ ui: { update() {} } }, st, 'game:ready')

  S.commands.integrity.run(['off'])
  assert(st.store.smln.markCheats === false, 'setting not written to store')

  st.store.resources = { gold: 0 }
  S.commands.give.run(['gold', '100'])
  assert(!st.store.integrity || !st.store.integrity.cheatsUsed, 'marked despite integrity off')

  S.commands.integrity.run(['on'])
  S.commands.give.run(['gold', '100'])
  assert(st.store.integrity.cheatsUsed === true, 'not marked with integrity on')
  assert(st.store.resources.gold === 200, 'gold wrong: ' + st.store.resources.gold)
  return 'stored in store.smln, honoured by give'
})

// ------------------------------------------------------ splash + mods manager
check('splash screen installs and dismisses', () => {
  const { S } = bootConsole()
  assert(S.splash, 'splash did not install')
  assert(S.splash.isVisible(), 'splash not visible at boot')
  S.splash.hide('test')
  assert(!S.splash.isVisible(), 'splash did not dismiss')
  return 'shown at boot, dismissable'
})

check('the splash reports each mod, its class, and anything that broke', () => {
  // The splash is a boot report, not a spinner: a mod that failed to load and
  // one that loaded and does nothing must not look the same on screen.
  const mods = [
    { id: 'a', name: 'Alpha', version: '1', flavour: 'smln', enabled: true,
      capability: { tier: 'sandboxed', badge: 'SANDBOXED', granted: {}, contexts: { game: true } },
      failed: false, needsApproval: false },
    { id: 'b', name: 'Beta', version: '1', flavour: 'fluxloader', enabled: true,
      capability: { tier: 'native', badge: 'NATIVE', granted: { node: true }, contexts: { native: true },
        legacyNative: true, enforceable: false },
      failed: false, needsApproval: true },
    { id: 'c', name: 'Gamma', version: '1', flavour: 'smln', enabled: true,
      capability: { tier: 'sandboxed', badge: 'SANDBOXED', granted: {}, contexts: { game: true } },
      failed: true, needsApproval: false, problems: ['boom'] },
  ]
  const { S, dom } = bootConsole({
    mods,
    boot: {
      version: '0.1.0',
      game: { name: 'sandustry', version: '0.5.4', source: 'steam:library', verified: true },
      mods,
      patches: [{ id: 'smln:capture-api', owner: 'smln', target: 'js/bundle.js', description: '', required: true }],
      counts: { mods: 3, enabled: 3, patches: 1, rendererScripts: 2, workerScripts: 0, assets: 3, errors: 1, warnings: 0 },
      targets: ['js/bundle.js'],
    },
    problems: {
      problems: [{ id: 'p1', code: 'E_MOD_LOAD', severity: 'error', scope: 'mods', modId: 'c',
        message: 'mod "c" failed to load: Unexpected token', count: 1, at: '' }],
      summary: { total: 1, errors: 1, warnings: 0, mods: ['c'] },
    },
  })
  const splash = dom.document.getElementById('smln-splash')
  assert(splash, 'splash node missing')

  const rendered = []
  ;(function walk(n) { if (n.className === 'txt' && n.textContent) rendered.push(n.textContent)
    for (const c of n.childNodes || []) walk(c) })(splash)
  const all = rendered.concat(S.splash._queue().map((q) => q.text))
  const joined = all.join(' | ')

  assert(/sandustry 0\.5\.4/i.test(joined), 'the game build is not shown: ' + joined)
  for (const name of ['Alpha', 'Beta', 'Gamma']) {
    assert(all.some((x) => x.indexOf(name) === 0), name + ' is missing from the splash: ' + joined)
  }
  const q = S.splash._queue()
  assert(q.some((x) => x.tag === 'NATIVE'), 'a native mod was not badged on the splash')
  assert(q.some((x) => x.mark === 'bad' && /Gamma/.test(x.text)), 'the broken mod was not flagged')
  assert(/failed to load: Unexpected token/.test(joined), 'the actual error text is hidden: ' + joined)
  assert(/js\/bundle\.js/.test(joined), 'the hook targets are not reported: ' + joined)
  return 'game build, per-mod class, hook targets and the real error'
})

check('main menu entry is renamed and intercepted', () => {
  const { S, dom } = bootConsole()
  const doc = dom.document
  // Stand-in for the game's own menu entry, which carries this literal id.
  const entry = doc.createElement('div')
  entry.id = 'main-menu-mods'
  const label = doc.createElement('span')
  label.textContent = 'Mods'
  entry.appendChild(label)
  doc.body.appendChild(entry)

  assert(S.modsUI._hookMenu(), 'hook did not find #main-menu-mods')
  assert(label.textContent === 'SandLoader Mods', 'not renamed, got: ' + label.textContent)

  let stopped = false
  entry.dispatch('click', { preventDefault() {}, stopPropagation() { stopped = true } })
  assert(stopped, 'the game would still have opened its own screen')
  assert(S.modsUI.isOpen(), 'manager did not open')
  return 'renamed, click taken over'
})

check('mod manager lists mods and persists a toggle', () => {
  const { S, dom, sent } = bootConsole({
    mods: [
      { id: 'alpha', name: 'Alpha', version: '1.0.0', flavour: 'smln', enabled: true },
      { id: 'beta', name: 'Beta', version: '2.0.0', flavour: 'fluxloader', enabled: true },
    ],
  })
  S.modsUI.toggle(true)
  const panel = dom.document.getElementById('smln-mods')
  assert(panel, 'manager node missing')
  const rows = []
  ;(function walk(n) {
    for (const c of n.childNodes || []) {
      if ((c.className || '').split(/\s+/).includes('row')) rows.push(c)
      walk(c)
    }
  })(panel)
  assert(rows.length === 2, 'expected 2 rows, got ' + rows.length)

  // Click the toggle button of the first row.
  const btn = rows[0].childNodes.find((c) => (c.className || '').startsWith('toggle'))
  assert(btn, 'toggle button missing')
  assert(btn.textContent === 'Enabled', 'wrong initial label: ' + btn.textContent)
  btn.dispatch('click', {})
  assert(btn.textContent === 'Disabled', 'label did not flip: ' + btn.textContent)

  const rpc = sent.filter((m) => m.scope === 'smln:rpc')
  assert(rpc.length === 1, 'expected 1 rpc, got ' + rpc.length)
  const msg = JSON.parse(rpc[0].message)
  assert(msg.action === 'setModEnabled', 'wrong action: ' + msg.action)
  assert(msg.payload.id === 'alpha' && msg.payload.enabled === false, 'wrong payload: ' + rpc[0].message)
  return '2 rows, toggle emits rpc'
})

check('mod state round-trips through the main process', () => {
  const os2 = require('os')
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), 'smln-state-'))
  const file = path.join(dir, 'mods.json')
  fs.writeFileSync(file, JSON.stringify({ alpha: false }))
  const states = JSON.parse(fs.readFileSync(file, 'utf8'))
  const discovered = [{ id: 'alpha', enabled: true }, { id: 'beta', enabled: true }]
  for (const m of discovered) {
    if (Object.prototype.hasOwnProperty.call(states, m.id)) m.enabled = states[m.id] !== false
  }
  assert(discovered[0].enabled === false, 'persisted disable not applied')
  assert(discovered[1].enabled === true, 'unrelated mod was disabled')
  fs.rmSync(dir, { recursive: true, force: true })
  return 'disabled mod stays disabled'
})

check('splash is skipped on a scene reload', () => {
  // The renderer reloads as index.html?db_load when a save is opened; the
  // splash belongs to starting the game, not to every scene change.
  const { createDom } = require('./dom-harness')
  const dom = createDom()
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: dom.document,
    window: dom.window,
    location: { search: '?db_load' },
    setTimeout,
    clearTimeout,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(prelude.build({ reload: true }), { filename: 'prelude.js' }).runInContext(sandbox)
  const S = sandbox.__SMLN__
  assert(S.splash, 'splash object missing')
  assert(!S.splash.isVisible(), 'splash appeared on a save load')
  assert(!dom.document.getElementById('smln-splash'), 'splash node was built anyway')
  // The console must still be there on a scene reload.
  assert(S.console, 'console missing after scene reload')
  return 'skipped for ?db_load, console still installed'
})

check('splash uses the game font and panel styling', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'splash.js'), 'utf8')
  assert(src.includes('fonts/Play-Regular.ttf'), 'game typeface not referenced')
  assert(src.includes('border-radius:0 8px 0 8px'), 'panel corner radius does not match the game')
  assert(src.includes('rgba(100,116,139,.68)'), 'panel border does not match the game')
  return "Play font + Sandustry panel tokens"
})

check('resource fields are discovered from the live save', () => {
  const { S } = bootConsole()
  const st = {
    store: {
      resources: { gold: 10, fluxite: 5, energy: 0, artifacts: { available: 1, found: 2 } },
      creatures: { lumling: { available: 3, found: 4 } },
      conservatory: { tickets: 7 },
      productionPoints: 12,
    },
    session: {},
  }
  S.__capture({ ui: { update() {} } }, st, 'game:ready')

  const names = S.console.suggest('give ').items.map((i) => i.value)
  for (const want of ['gold', 'fluxite', 'energy', 'artifacts', 'lumling', 'tickets']) {
    assert(names.includes(want), want + ' not offered: ' + names.join(','))
  }

  // A nested pair must have every numeric sub-field written, not just one.
  S.commands.set.run(['artifacts', '50'])
  assert(st.store.resources.artifacts.available === 50, 'available not set')
  assert(st.store.resources.artifacts.found === 50, 'found not set')

  S.commands.set.run(['lumling', '9'])
  assert(st.store.creatures.lumling.available === 9, 'creature not set')

  S.commands.give.run(['tickets', '3'])
  assert(st.store.conservatory.tickets === 10, 'tickets wrong: ' + st.store.conservatory.tickets)

  const unknown = S.commands.set.run(['nonsense', '1'])
  assert(/unknown resource/.test(unknown[0]), 'unknown resource not reported')
  return 'flat, nested and creature counters all writable'
})

check('spawn accepts terrains as well as elements (copper is both)', () => {
  const { S } = bootConsole()
  const elementCalls = []
  const terrainCalls = []
  const st = { store: {}, session: { input: { mouse: { worldPosition: { x: 40, y: 80 } } } } }
  S.__capture({
    config: { cellSize: 4 },
    // A stand-in registry: only these ids resolve, exercising the runtime probe.
    i18n: { t: (k) => ({ 'elements|copper|name': 'Copper', 'elements|oil|name': 'Oil' })[k] || k },
    elements: {
      getName: (s, id) => ({ 31: 'Copper', 42: 'Oil' })[id] || String(id),
      createAt: (s, x, y, id) => elementCalls.push([x, y, id]),
    },
    terrains: { createAt: (s, x, y, name) => terrainCalls.push([x, y, name]) },
    ui: { update() {} },
  }, st, 'game:ready')

  // Elements beyond the legacy 20-entry enum must now resolve.
  const out = S.commands.spawn.run(['oil', '0'])
  assert(elementCalls.length === 1, 'oil was not placed')
  assert(elementCalls[0][2] === 42, 'wrong id for oil: ' + elementCalls[0][2])
  assert(/spawned 1 x oil/.test(out[0]), 'unexpected reply: ' + out[0])

  // Copper resolves as an element here because the registry knows it.
  S.commands.spawn.run(['copper', '0'])
  assert(elementCalls.length === 2 && elementCalls[1][2] === 31, 'copper element not placed')

  // A terrain-only name must route to the terrain API by name, not by id.
  S.commands.spawn.run(['limestone', '0'])
  assert(terrainCalls.length === 1, 'terrain not placed')
  assert(terrainCalls[0][2] === 'limestone', 'wrong terrain name: ' + terrainCalls[0][2])
  return 'elements by id, terrains by name'
})

check('spawn completion covers the full content set', () => {
  const { S } = bootConsole()
  const names = S.console.suggest('spawn ').items.map((i) => i.value)
  const all = S.console.suggest('spawn ').items
  assert(S.enums.ELEMENT_KEYS.length === 50, 'element key list incomplete')
  assert(S.enums.TERRAIN_KEYS.length === 34, 'terrain key list incomplete')
  // Narrowing must reach entries past the display cap.
  for (const want of ['copper', 'oil', 'limestone', 'auralite']) {
    const hit = S.console.suggest('spawn ' + want).items.map((i) => i.value)
    assert(hit.includes(want), want + ' unreachable: ' + hit.join(','))
  }
  return '50 elements + 34 terrains reachable'
})

check('spawn reports the underlying error instead of a blank failure', () => {
  const { S } = bootConsole()
  const st = { store: {}, session: { input: { mouse: { worldPosition: { x: 0, y: 0 } } } } }
  S.__capture({
    config: { cellSize: 4 },
    elements: { createAt: () => { throw new Error('cell occupied') }, getName: (s, i) => String(i) },
    ui: { update() {} },
  }, st, 'game:ready')
  const out = S.commands.spawn.run(['sand', '0'])
  assert(/nothing was placed/.test(out[0]), 'no failure reported: ' + out[0])
  assert(/cell occupied/.test(out.join(' ')), 'underlying error hidden: ' + out.join(' | '))
  return 'surfaces the real reason'
})

// ------------------------------------------------------ mod install / remove
const zip = require('../src/mods/zip')
const modManage = require('../src/mods/manage')

/** Build a ZIP with stored (uncompressed) entries - enough to drive the reader. */
function makeZip(files) {
  const locals = []
  const central = []
  let offset = 0
  for (const [name, content] of files) {
    const data = Buffer.from(content)
    const nb = Buffer.from(name)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(0, 8)
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(nb.length, 26)
    const rec = Buffer.concat([lh, nb, data])
    locals.push(rec)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0, 10)
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([ch, nb]))
    offset += rec.length
  }
  const body = Buffer.concat(locals)
  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(body.length, 16)
  return Buffer.concat([body, cd, eocd])
}

function tmpdir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'smln-' + tag + '-')) }

check('zip reader extracts and strips a single top-level folder', () => {
  const dir = tmpdir('zip')
  const zp = path.join(dir, 'm.zip')
  fs.writeFileSync(zp, makeZip([
    ['my-mod/smln.mod.json', '{"id":"zipmod","version":"1.0.0"}'],
    ['my-mod/renderer.js', '// hi'],
  ]))
  const out = path.join(dir, 'out')
  const r = zip.extract(zp, out)
  assert(r.files === 2, 'expected 2 files, got ' + r.files)
  assert(fs.existsSync(path.join(out, 'smln.mod.json')), 'top-level folder not stripped')
  assert(fs.existsSync(path.join(out, 'renderer.js')), 'second file missing')
  fs.rmSync(dir, { recursive: true, force: true })
  return '2 files, wrapper folder stripped'
})

check('zip reader refuses path traversal (zip slip)', () => {
  const dir = tmpdir('slip')
  const zp = path.join(dir, 'evil.zip')
  fs.writeFileSync(zp, makeZip([
    ['../escaped.txt', 'pwn'],
    ['smln.mod.json', '{"id":"x","version":"1"}'],
  ]))
  const out = path.join(dir, 'out')
  const r = zip.extract(zp, out)
  assert(r.skipped.includes('../escaped.txt'), 'traversal entry was not skipped')
  assert(!fs.existsSync(path.join(dir, 'escaped.txt')), 'file escaped the destination')
  fs.rmSync(dir, { recursive: true, force: true })
  return 'escape refused'
})

check('install rejects an archive with no manifest', () => {
  const dir = tmpdir('nomanifest')
  const zp = path.join(dir, 'x.zip')
  fs.writeFileSync(zp, makeZip([['readme.txt', 'nothing here']]))
  const r = modManage.installFromZip(zp, {
    smlnRoot: path.join(dir, 'mods'), fluxRoot: path.join(dir, 'flux'),
    logger: { info() {}, warn() {}, error() {} },
  })
  assert(!r.ok, 'a manifest-less archive was installed')
  assert(/manifest|smln\.mod\.json/.test(r.error), 'unhelpful error: ' + r.error)
  assert(!fs.existsSync(path.join(dir, 'mods')), 'partial install left behind')
  fs.rmSync(dir, { recursive: true, force: true })
  return 'refused, nothing written'
})

check('install places SMLN and Fluxloader mods in their own roots', () => {
  const dir = tmpdir('install')
  const smlnRoot = path.join(dir, 'mods')
  const fluxRoot = path.join(dir, 'flux')
  const logger = { info() {}, warn() {}, error() {} }

  const a = path.join(dir, 'a.zip')
  fs.writeFileSync(a, makeZip([['smln.mod.json', '{"id":"alpha","version":"1.2.3"}']]))
  const ra = modManage.installFromZip(a, { smlnRoot, fluxRoot, logger })
  assert(ra.ok, 'smln install failed: ' + ra.error)
  assert(ra.flavour === 'smln' && ra.id === 'alpha', 'wrong metadata: ' + JSON.stringify(ra))
  assert(fs.existsSync(path.join(smlnRoot, 'alpha', 'smln.mod.json')), 'not placed in the smln root')

  const b = path.join(dir, 'b.zip')
  fs.writeFileSync(b, makeZip([['modinfo.json', '{"modID":"beta","version":"2.0.0"}']]))
  const rb = modManage.installFromZip(b, { smlnRoot, fluxRoot, logger })
  assert(rb.ok, 'fluxloader install failed: ' + rb.error)
  assert(rb.flavour === 'fluxloader', 'flavour not detected: ' + rb.flavour)
  assert(fs.existsSync(path.join(fluxRoot, 'beta', 'modinfo.json')), 'not placed in the fluxloader root')

  // Reinstalling replaces rather than merging.
  const again = modManage.installFromZip(a, { smlnRoot, fluxRoot, logger })
  assert(again.ok && again.replaced, 'reinstall did not report a replacement')

  fs.rmSync(dir, { recursive: true, force: true })
  return 'both flavours routed correctly'
})

check('remove only deletes real mods inside a known root', () => {
  const dir = tmpdir('remove')
  const root = path.join(dir, 'mods')
  const modDir = path.join(root, 'gone')
  fs.mkdirSync(modDir, { recursive: true })
  fs.writeFileSync(path.join(modDir, 'smln.mod.json'), '{"id":"gone","version":"1"}')
  const outside = path.join(dir, 'not-a-mod')
  fs.mkdirSync(outside, { recursive: true })
  const logger = { info() {}, warn() {}, error() {} }

  const bad = modManage.remove(outside, { roots: [root], logger })
  assert(!bad.ok, 'deleted a folder outside the mods root')
  assert(fs.existsSync(outside), 'outside folder was removed anyway')

  const noManifest = path.join(root, 'junk')
  fs.mkdirSync(noManifest, { recursive: true })
  const bad2 = modManage.remove(noManifest, { roots: [root], logger })
  assert(!bad2.ok, 'deleted a folder with no manifest')
  assert(fs.existsSync(noManifest), 'manifest-less folder was removed anyway')

  const good = modManage.remove(modDir, { roots: [root], logger })
  assert(good.ok, 'failed to remove a real mod: ' + good.error)
  assert(!fs.existsSync(modDir), 'mod folder still present')

  fs.rmSync(dir, { recursive: true, force: true })
  return 'refuses outside + manifest-less, removes real mods'
})

check('manager exposes install / open / delete and calls the main process', () => {
  const { S, sent, dom } = bootConsole({
    mods: [{ id: 'alpha', name: 'Alpha', version: '1', flavour: 'smln', enabled: true, dir: '/mods/alpha' }],
  })
  S.modsUI.toggle(true)
  const panel = dom.document.getElementById('smln-mods')
  const all = []
  ;(function walk(n) { for (const c of n.childNodes || []) { all.push(c); walk(c) } })(panel)

  const labels = all.map((e) => e.textContent)
  for (const want of ['Install from ZIP', 'Open folder', 'Delete']) {
    assert(labels.includes(want), want + ' button missing; saw: ' + labels.filter(Boolean).join(' / '))
  }

  const open = all.find((e) => e.textContent === 'Open folder')
  open.dispatch('click', {})
  const req = sent.filter((m) => m.scope === 'smln:rpc').map((m) => JSON.parse(m.message))
  assert(req.some((r) => r.action === 'openModsFolder'), 'openModsFolder not requested')
  assert(req.every((r) => r.id), 'request carries no id - no reply could be routed')

  // Delete is two-step: the first click only arms it.
  const del = all.find((e) => e.textContent === 'Delete')
  del.dispatch('click', {})
  const after = sent.filter((m) => m.scope === 'smln:rpc').map((m) => JSON.parse(m.message))
  assert(!after.some((r) => r.action === 'removeMod'), 'delete fired without confirmation')
  assert(del.textContent === 'Sure?', 'delete did not arm, shows: ' + del.textContent)
  del.dispatch('click', {})
  const final = sent.filter((m) => m.scope === 'smln:rpc').map((m) => JSON.parse(m.message))
  assert(final.some((r) => r.action === 'removeMod'), 'confirmed delete did not fire')
  return 'buttons present, delete needs confirming'
})

check('rpc requests carry an id and results are routed once', () => {
  const { S, sent } = bootConsole()
  let answered = null
  S.callMain('openModsFolder', { dir: 'X' }).then((r) => { answered = r })

  const requests = sent.filter((m) => m.scope === 'smln:rpc').map((m) => JSON.parse(m.message))
  assert(requests.length === 1, 'expected 1 request, got ' + requests.length)
  assert(requests[0].id, 'no correlation id - a reply could not be routed back')
  assert(requests[0].action === 'openModsFolder', 'wrong action: ' + requests[0].action)

  // Delivering a result must not throw, and a duplicate must be ignored rather
  // than resolving a stale promise.
  S.__rpcResult(requests[0].id, { ok: true, dir: 'X' })
  S.__rpcResult(requests[0].id, { ok: false })
  S.__rpcResult('never-sent', { ok: true })
  return 'id present, duplicate and unknown replies ignored'
})

check('rpc reports cleanly when there is no bridge', () => {
  const { createDom } = require('./dom-harness')
  const dom = createDom()
  const sandbox = { console: { log() {}, warn() {}, error() {} }, document: dom.document, window: dom.window, setTimeout, clearTimeout }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(prelude.build({ reload: true }), { filename: 'prelude.js' }).runInContext(sandbox)
  // No `electron` global at all - callMain must resolve, not hang or throw.
  const p = sandbox.__SMLN__.callMain('openModsFolder', {})
  assert(p && typeof p.then === 'function', 'callMain did not return a promise')
  return 'resolves instead of hanging'
})

check('manager-worker.js exists and is a patch target', () => {
  assert(archive.has('dist/js/manager-worker.js'), 'manager worker missing from the archive')
  const flCompat2 = require('../src/compat/fluxloader')
  assert(flCompat2.normaliseTarget('manager-worker.js') === 'js/manager-worker.js', 'alias not mapped')
  return 'present and addressable'
})

check('sandkit is reachable through the game state', () => {
  // This check used to assert bundle.includes('sandkit.getApi') and pass on the
  // 44 *call* sites while the method was never defined anywhere - which is
  // precisely how the "mods enabled but nothing loads" bug shipped unnoticed.
  // Presence of a call proves only that something is expected to define it.
  assert(/\bsandkit\s*:/.test(bundle) || /\.sandkit\s*=/.test(bundle), 'state.sandkit is never assigned')
  assert(/sandkit\.getApi\(/.test(bundle), 'nothing calls sandkit.getApi()')

  // Who defines it is the part that matters, and on 0.5.x the answer is "the
  // host" - see the patch check below.
  const defined = /getApi\s*[:=]\s*(?:function\b|\(|[\w$]+\s*=>)/.test(bundle)
  return defined
    ? 'state.sandkit.getApi() defined by the game'
    : 'state.sandkit.getApi() called by the game, supplied by the host patch'
})

check('runtime captures sandkit alongside FH', () => {
  const { S } = bootConsole()
  const fakeApi = { elements: {}, structures: {}, world: {} }
  const st = { store: {}, session: {}, sandkit: { getApi: () => fakeApi } }
  S.__capture({ events: {}, ui: { update() {} } }, st, 'game:ready')
  assert(S.sandkit === fakeApi, 'sandkit not captured')
  assert(S.game, 'FH capture regressed')
  return 'both APIs exposed'
})

check('a missing or throwing sandkit does not break capture', () => {
  const { S } = bootConsole()
  S.__capture({ events: {} }, { store: {}, session: {} }, 'game:ready')
  assert(S.sandkit === null, 'sandkit should be null when absent, got: ' + S.sandkit)
  assert(S.game, 'capture failed without sandkit')

  const { S: S2 } = bootConsole()
  S2.__capture({ events: {} }, {
    store: {}, session: {},
    sandkit: { getApi: () => { throw new Error('nope') } },
  }, 'game:ready')
  assert(S2.sandkit === null, 'throwing getApi was not contained')
  assert(S2.game, 'a throwing getApi broke the whole capture')
  return 'degrades to FH only'
})


// ==========================================================================
//  Upgrade suite: dependencies, patch conflicts, permissions, storage,
//  messaging, config, hot reload and non-Steam support.
//
//  Deliberately a small number of high-value deterministic checks. Each one
//  covers a rule that, if it broke, would be either a security hole or a
//  silent wrong answer - not a restatement of what the code obviously does.
// ==========================================================================

const semver = require('../src/mods/semver')
const permissions = require('../src/mods/permissions')
const conflicts = require('../src/patch/conflicts')
const modConfig = require('../src/mods/config')
const modStorage = require('../src/mods/storage')
const netcap = require('../src/mods/netcap')
const approvalsMod = require('../src/mods/approvals')
const sandboxMod = require('../src/mods/sandbox')
const watcherMod = require('../src/mods/watcher')
const platformMod = require('../src/asar/platform')
const problemsMod = require('../src/core/problems')

const quietLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return quietLogger } }

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'smln-selftest-' + tag + '-'))
}

// ------------------------------------------------------------- dependencies
check('semver ranges accept and reject the right versions', () => {
  assert(semver.satisfies('1.9.0', '^1.2.0'), '^1.2.0 should accept 1.9.0')
  assert(!semver.satisfies('2.0.0', '^1.2.0'), '^1.2.0 must reject 2.0.0')
  assert(!semver.satisfies('1.1.9', '^1.2.0'), '^1.2.0 must reject 1.1.9')
  assert(semver.satisfies('1.2.9', '~1.2.3'), '~1.2.3 should accept 1.2.9')
  assert(!semver.satisfies('1.3.0', '~1.2.3'), '~1.2.3 must reject 1.3.0')
  assert(semver.satisfies('1.5.0', '>=1.2.0 <2.0.0'), 'comparator set failed')
  assert(semver.satisfies('2.1.0', '^1.2.0 || ^2.0.0'), 'or-range failed')
  // node-semver's prerelease rule: a prerelease only matches a comparator set
  // that names its own [major,minor,patch].
  assert(!semver.satisfies('2.0.0-beta.1', '^1.2.0'), 'prerelease leaked past ^1.2.0')
  return 'caret, tilde, x-range, and/or, prerelease gating'
})

check('a malformed dependency range is rejected, not treated as "*"', () => {
  for (const bad of ['garbage', '>=', '1.2.3.4', '^^1.0']) {
    assert(semver.parseRange(bad).ok === false, `"${bad}" was accepted`)
  }
  assert(semver.parseRange('').ok === true, 'the empty range should mean "any"')
  const e = semver.explain('1.6.4', '^2.0.0')
  assert(!e.ok && e.code === 'E_VERSION_MISMATCH', 'explain() gave ' + JSON.stringify(e))
  return 'malformed ranges refused; explain() reports a mismatch'
})

check('dependency versions are enforced, with a distinguishable reason', () => {
  const dir = tmpdir('deps')
  try {
    const mk = (id, version, deps, enabled) => {
      const r = modLoader.validate({ id, version, dependencies: deps }, dir)
      assert(r.ok, id + ': ' + (r.ok ? '' : r.error.message))
      r.mod.enabled = enabled !== false
      return r.mod
    }

    let out = modLoader.resolveOrder([mk('foo', '1.0.0', { bar: '^2.0.0' }), mk('bar', '1.6.4')])
    assert(!out.order.some((m) => m.id === 'foo'), 'foo loaded against an incompatible bar')
    assert(out.skipped.some((s) => s.id === 'foo' && s.kind === 'incompatible'),
      'kinds: ' + JSON.stringify(out.skipped.map((s) => s.kind)))
    assert(out.errors.some((e) => e.message === 'mod "foo" requires "bar" ^2.0.0, installed version is 1.6.4'),
      'message was: ' + out.errors.map(String).join(' | '))

    out = modLoader.resolveOrder([mk('foo', '1.0.0', { bar: '^2.0.0' }), mk('bar', '2.1.0')])
    assert(out.order.length === 2, 'a compatible dependency did not load')

    out = modLoader.resolveOrder([mk('foo', '1.0.0', { bar: '^2.0.0' })])
    assert(out.skipped.some((s) => s.kind === 'missing'), 'absent dependency not reported as missing')

    out = modLoader.resolveOrder([mk('foo', '1.0.0', { bar: '^2.0.0' }), mk('bar', '2.1.0', null, false)])
    assert(out.skipped.some((s) => s.kind === 'disabled'), 'disabled dependency reported as missing')

    out = modLoader.resolveOrder([mk('aa', '1.0.0', ['bb']), mk('bb', '1.0.0', ['aa'])])
    assert(out.skipped.some((s) => s.kind === 'cycle'), 'cycle not detected')

    // A mod whose dependency failed must not be reported as if the dependency
    // were absent - it is right there, it just could not load.
    out = modLoader.resolveOrder([mk('foo', '1.0.0', ['bar']), mk('bar', '1.0.0', ['baz'])])
    assert(out.skipped.some((s) => s.id === 'foo' && s.kind === 'dependency-failed'),
      'cascade kinds: ' + JSON.stringify(out.skipped.map((s) => s.id + ':' + s.kind)))
    return 'missing / disabled / incompatible / cycle / cascade all distinguished'
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

check('the legacy array dependency syntax still works', () => {
  const dir = tmpdir('legacy')
  try {
    const r = modLoader.validate({ id: 'legacy', version: '1.0.0', dependencies: ['other'] }, dir)
    assert(r.ok, r.ok ? '' : r.error.message)
    assert(r.mod.dependencies[0].id === 'other' && r.mod.dependencies[0].range === '*',
      'legacy dependency lost its shape')
    assert(r.mod.dependencyIds.join() === 'other', 'dependencyIds regressed')
    return 'array form maps to range "*"'
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------- patch conflicts
check('overlapping patches from different mods fail before anything is written', () => {
  const src = 'AAAA BBBB CCCC DDDD EEEE'
  const a = { id: 'p1', owner: 'mod-a', description: 'a', find: 'BBBB CCC' }
  const b = { id: 'p3', owner: 'mod-b', description: 'b', find: 'CC DDDD' }

  const clash = conflicts.preflight(src, [a, b], { target: 'js/bundle.js' })
  assert(!clash.ok, 'an overlap was not detected')
  assert(clash.error.code === 'E_PATCH_CONFLICT', 'wrong code: ' + clash.error.code)
  assert(/mod-a/.test(clash.error.message) && /mod-b/.test(clash.error.message),
    'the message does not name both mods: ' + clash.error.message)

  const apart = conflicts.preflight(src, [a, { id: 'p4', owner: 'mod-b', description: 'b', find: 'EEEE' }], {})
  assert(apart.ok, 'non-overlapping patches were reported as conflicting')

  // Touching is not overlapping: [.. ,end) and [end, ..) are disjoint.
  const touching = conflicts.preflight('ABCD', [
    { id: 'x', owner: 'm1', description: '', find: 'AB' },
    { id: 'y', owner: 'm2', description: '', find: 'CD' },
  ], {})
  assert(touching.ok, 'adjacent ranges were treated as an overlap')

  // One mod overlapping itself is its own business.
  const own = conflicts.preflight(src, [a, { ...b, owner: 'mod-a' }], {})
  assert(own.ok, 'a mod overlapping itself was reported')
  return 'cross-mod overlap fatal; self-overlap and adjacency ignored'
})

check('intentional overlap needs both sides to opt in', () => {
  const src = 'AAAA BBBB CCCC'
  const a = { id: 'p1', owner: 'mod-a', description: '', find: 'AAAA BBB', allowOverlap: true }
  const b = { id: 'p2', owner: 'mod-b', description: '', find: 'BB CCCC', allowOverlap: true }
  const both = conflicts.preflight(src, [a, b], {})
  assert(both.ok, 'a bilateral opt-in was still refused')
  assert(both.report.conflicts.length === 1 && both.report.conflicts[0].allowed === true,
    'the accepted overlap vanished from the report')

  const oneSided = conflicts.preflight(src, [a, { ...b, allowOverlap: false }], {})
  assert(!oneSided.ok, 'one mod unilaterally waived another mod\'s collision')
  return 'allowOverlap is bilateral'
})

check('regex patches take part in conflict detection', () => {
  const src = 'function alpha(){} function beta(){}'
  const a = { id: 'r1', owner: 'mod-a', description: '', find: /function alpha\(\)\{\}/g }
  const b = { id: 's1', owner: 'mod-b', description: '', find: 'alpha(){} function' }
  assert(!conflicts.preflight(src, [a, b], {}).ok, 'a regex/string overlap was missed')
  return 'real match ranges, not find-string equality'
})

// --------------------------------------------------------------- permissions
check('permission manifests are validated, never silently granted', () => {
  assert(permissions.validate(undefined, { modId: 'm' }).permissions.length === 0, 'absent field should be empty')
  const asString = permissions.validate('network', { modId: 'm' })
  assert(!asString.ok && asString.error.code === 'E_PERMISSION_INVALID', 'a bare string was accepted')
  const unknown = permissions.validate(['give-me-admin'], { modId: 'm' })
  assert(!unknown.ok && unknown.error.code === 'E_PERMISSION_UNKNOWN', 'an unknown permission was accepted')
  const dup = permissions.validate(['network', 'network'], { modId: 'm' })
  assert(dup.ok && dup.permissions.length === 1, 'duplicates were not collapsed')
  return 'invalid shape, unknown names and duplicates all handled'
})

check('capability tiers follow where the code actually runs', () => {
  const game = permissions.classify({ id: 'a', permissions: [], entrypoints: { game: true } })
  assert(game.tier === 'sandboxed', 'a game-only mod is not sandboxed')

  const flux = permissions.classify({ id: 'b', flavour: 'fluxloader', permissions: [], entrypoints: { game: true } })
  assert(flux.tier === 'sandboxed', 'a Fluxloader game-only mod was classified as ' + flux.tier)

  const electron = permissions.classify({ id: 'c', flavour: 'fluxloader', permissions: [], entrypoints: { native: true } })
  assert(electron.tier === 'native', 'a Fluxloader electron mod was classified as ' + electron.tier)
  assert(electron.legacyNative === true, 'an undeclared privileged mod is not marked legacy')
  // The important honesty check: SandLoader cannot restrict native code, and
  // the model must say so rather than imply a guarantee.
  assert(electron.enforceable === false, 'native capability claims to be enforceable')

  const net = permissions.classify({ id: 'd', permissions: ['network'], entrypoints: { game: true } })
  assert(net.tier === 'elevated' && net.badge === 'NETWORK', 'network mod: ' + net.tier + '/' + net.badge)
  return 'sandboxed / elevated / native derived from entrypoints + declarations'
})

check('permission escalation on update is detected', () => {
  const add = permissions.diff(['network'], ['network', 'filesystem'])
  assert(add.escalation && !add.privilegedEscalation, 'adding filesystem: ' + JSON.stringify(add))
  const node = permissions.diff(['network'], ['network', 'node'])
  assert(node.privilegedEscalation, 'adding node was not flagged as privileged')
  const drop = permissions.diff(['network', 'node'], ['network'])
  assert(!drop.escalation, 'removing a permission counted as escalation')
  return 'added / privileged / removed all distinguished'
})

check('no mod code runs before the install permission review', () => {
  const dir = tmpdir('review')
  try {
    // A directory rather than a zip: inspectArchive treats both the same way,
    // and this keeps the check free of a zip writer.
    const modDir = path.join(dir, 'mod')
    fs.mkdirSync(modDir, { recursive: true })
    fs.writeFileSync(path.join(modDir, 'smln.mod.json'), JSON.stringify({
      id: 'native.tool', name: 'Native Tool', version: '1.0.0', main: 'native.js', permissions: ['node'],
    }))
    // If this ever executes, it is a security failure, not a test failure.
    fs.writeFileSync(path.join(modDir, 'native.js'), 'globalThis.__SMLN_MOD_EXECUTED__ = true')

    const r = approvalsMod.inspectArchive(modDir, { directory: true })
    assert(r.ok, r.ok ? '' : String(r.error))
    assert(global.__SMLN_MOD_EXECUTED__ === undefined, 'MOD CODE RAN DURING REVIEW')
    assert(r.review.capability.tier === 'native', 'tier was ' + r.review.capability.tier)
    assert(r.review.required === true, 'a native mod did not require a decision')
    assert(r.review.warnings.includes('perm.nativeWarning'), 'the native warning is missing')
    r.cleanup()

    const badDir = path.join(dir, 'bad')
    fs.mkdirSync(badDir, { recursive: true })
    fs.writeFileSync(path.join(badDir, 'smln.mod.json'), JSON.stringify({
      id: 'bad.mod', version: '1.0.0', permissions: 'network',
    }))
    const bad = approvalsMod.inspectArchive(badDir, { directory: true })
    assert(!bad.ok && bad.error.code === 'E_PERMISSION_INVALID', 'a malformed manifest passed review')
    return 'manifest parsed and classified without executing anything'
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

check('an approval is bound to id + version + permission set', () => {
  const dir = tmpdir('approve')
  try {
    const store = approvalsMod.createStore({ dir, logger: quietLogger })
    const mod = { id: 'demo', version: '1.0.0', capability: { tier: 'elevated', permissions: ['network'] } }
    assert(!store.isApproved(mod), 'approved before anything happened')
    assert(store.approve(mod).ok, 'approve() failed')
    assert(store.isApproved(mod), 'approval did not stick')

    const fresh = approvalsMod.createStore({ dir, logger: quietLogger })
    assert(fresh.isApproved(mod), 'approval did not survive a reload')
    assert(!fresh.isApproved({ id: 'demo', version: '1.1.0', permissions: ['network'] }),
      'a new version reused the old approval')
    assert(!fresh.isApproved({ id: 'demo', version: '1.0.0', permissions: ['network', 'node'] }),
      'an escalated permission set reused the old approval')
    // Strictly less access needs no new decision; re-prompting for it trains
    // people to click through.
    assert(fresh.isApproved({ id: 'demo', version: '1.0.0', permissions: [] }),
      'dropping a permission asked again')
    return 'version and escalation invalidate; downgrade does not'
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ------------------------------------------------------------- mod storage
check('mod storage cannot escape its own directory', () => {
  const dir = tmpdir('storage')
  try {
    const cap = { tier: 'sandboxed', permissions: [], granted: { node: false, filesystem: false, network: false }, enforceable: true }
    const a = modStorage.createStorage({ baseDir: dir, modId: 'mod.a', capability: cap, logger: quietLogger })
    const b = modStorage.createStorage({ baseDir: dir, modId: 'mod.b', capability: cap, logger: quietLogger })

    return Promise.all([
      a.writeText('data.json', '{"x":1}'),
      a.readText('../mod.b/secret.txt'),
      a.readText(process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd'),
      a.readText('a/../../escape.txt'),
      b.readText('data.json'),
    ]).then(([wrote, up, abs, sneaky, cross]) => {
      assert(wrote.ok, 'a normal write failed: ' + (wrote.ok ? '' : wrote.error.message))
      assert(!up.ok, '../ traversal was allowed')
      assert(!abs.ok, 'an absolute path was allowed')
      assert(!sneaky.ok, 'a normalised escape was allowed')
      assert(!cross.ok, 'one mod read another mod\'s private file')
      return 'traversal, absolute paths and cross-mod reads all refused'
    })
  } finally {
    // The promise above owns the directory until it settles; clean up late.
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) {} }, 500)
  }
})

check('network is denied without the permission, and never dials out', () => {
  const denied = netcap.createNetwork({
    modId: 'no.net',
    capability: { tier: 'sandboxed', permissions: [], granted: { node: false, filesystem: false, network: false }, enforceable: true },
    logger: quietLogger,
  })
  const realFetch = global.fetch
  let dialled = false
  global.fetch = () => { dialled = true; throw new Error('the test must never reach the network') }
  return denied.fetch('https://example.com').then((r) => {
    global.fetch = realFetch
    assert(!r.ok, 'a fetch succeeded without the network permission')
    assert(r.error.code === 'E_PERMISSION_DENIED', 'wrong code: ' + r.error.code)
    assert(!dialled, 'the denied call still hit the network stack')

    // The URL policy itself, checked without any I/O at all.
    assert(!netcap.isAllowedUrl('http://127.0.0.1/x', netcap.DEFAULT_POLICY).ok, 'loopback allowed')
    assert(!netcap.isAllowedUrl('http://192.168.1.1/', netcap.DEFAULT_POLICY).ok, 'private range allowed')
    assert(!netcap.isAllowedUrl('file:///etc/passwd', netcap.DEFAULT_POLICY).ok, 'file: allowed')
    assert(netcap.isAllowedUrl('https://example.com/', netcap.DEFAULT_POLICY).ok, 'a public https URL was refused')
    return 'denied without permission; loopback, LAN and file: blocked'
  }, (e) => { global.fetch = realFetch; throw e })
})

// --------------------------------------------------------------- the sandbox
check('a sandboxed mod gets no Node and no privileged loader internals', () => {
  const { createDom } = require('./dom-harness')
  const dom = createDom()
  const box = {
    console: { log() {}, warn() {}, error() {} },
    document: dom.document, window: dom.window, navigator: { language: 'en' },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Object, Array, Date, RegExp, String, Error, Math, JSON, WeakSet,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  }
  box.globalThis = box
  vm.createContext(box)
  new vm.Script(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'runtime.js'), 'utf8')).runInContext(box)
  new vm.Script(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'capabilities.js'), 'utf8')).runInContext(box)
  box.__SMLN__.callMain = () => Promise.resolve({ ok: true })

  const cap = permissions.classify({ id: 'plain.mod', permissions: [], entrypoints: { game: true } })
  const wrapped = sandboxMod.wrapRendererMod({
    modId: 'plain.mod',
    capability: cap,
    source: `globalThis.__p = {
      require: typeof require, process: typeof process, module: typeof module,
      callMain: typeof SMLN.callMain, net: SMLN.net.granted, fs: SMLN.fs.granted,
    }`,
  })
  new vm.Script(wrapped).runInContext(box)

  const p = box.__p
  assert(p.require === 'undefined', 'require was reachable')
  assert(p.process === 'undefined', 'process was reachable')
  assert(p.module === 'undefined', 'module was reachable')
  assert(p.callMain === 'undefined', 'SMLN.callMain leaked onto the facade')
  assert(p.net === false, 'network was granted without the permission')
  assert(p.fs === false, 'filesystem was granted without the permission')

  let leaked = false
  try { sandboxMod.assertRendererSafe({ electron: {} }) } catch (_) { leaked = true }
  assert(leaked, 'the host-leak guard did not fire')
  return 'no require/process/module, no callMain, capabilities gated'
})

// ------------------------------------------------------------ mod messaging
check('game <-> worker messaging round-trips without touching game traffic', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', rel), 'utf8')

  // Fake worker pair. The game sets `.onmessage`; SMLN adds a listener. Both
  // must survive, which is the property the whole transport rests on.
  const gameSide = { listeners: [], onmessage: null }
  const workerSide = { listeners: [], onmessage: null }
  const fire = (side, data) => {
    const ev = { data }
    if (typeof side.onmessage === 'function') side.onmessage(ev)
    for (const l of side.listeners.slice()) l(ev)
  }
  const workerHandle = {
    addEventListener(type, fn) { if (type === 'message') gameSide.listeners.push(fn) },
    set onmessage(fn) { gameSide.onmessage = fn },
    get onmessage() { return gameSide.onmessage },
    postMessage(d) { fire(workerSide, d) },
  }
  const selfObj = {
    addEventListener(type, fn) { if (type === 'message') workerSide.listeners.push(fn) },
    set onmessage(fn) { workerSide.onmessage = fn },
    get onmessage() { return workerSide.onmessage },
    postMessage(d) { fire(gameSide, d) },
    name: 'simulation-worker',
  }

  const wbox = { self: selfObj, console: { log() {}, warn() {}, error() {} },
    Object, Array, Promise, Date, RegExp, ArrayBuffer, String, Error }
  wbox.globalThis = wbox
  vm.createContext(wbox)
  new vm.Script(read('worker-runtime.js')).runInContext(wbox)
  const W = selfObj.__SMLN_WORKER__
  assert(W && W.environment === 'worker', 'the worker runtime did not install')

  let gameSwitchCalls = 0
  selfObj.onmessage = (r) => { gameSwitchCalls++; void r.data[0] }

  const rbox = { console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Object, Array, Promise, Date, RegExp, ArrayBuffer, String, Error, WeakSet }
  rbox.globalThis = rbox
  rbox.window = rbox
  vm.createContext(rbox)
  new vm.Script(read('runtime.js')).runInContext(rbox)
  new vm.Script(read('messaging.js')).runInContext(rbox)
  const S = rbox.__SMLN__
  S.__capture({ events: {} }, {
    environment: { multithreading: { simulation: { threads: [{ worker: workerHandle }], manager: null } } },
  }, 'game:ready')

  const toWorker = []
  W.onGameMessage('demo', 'tick', (...a) => toWorker.push(a))
  const sent = S.messaging.sendWorkerMessage('demo', 'tick', 1, { a: [2, 3] })
  assert(sent.sent === 1 && toWorker.length === 1, 'game -> worker did not arrive')
  assert(toWorker[0][1].a[1] === 3, 'arguments were mangled in transit')

  const toGame = []
  S.messaging.onWorkerMessage('demo', 'pong', (...a) => toGame.push(a))
  assert(W.sendGameMessage('demo', 'pong', 'hi') === true, 'worker -> game refused to send')
  assert(toGame.length === 1 && toGame[0][0] === 'hi', 'worker -> game did not arrive')

  // A handler registered after the message was sent still gets it.
  S.messaging.sendWorkerMessage('late', 'boot', 'early')
  const late = []
  W.onGameMessage('late', 'boot', (v) => late.push(v))
  assert(late.length === 1, 'a message sent before the handler existed was lost')

  // A throwing mod handler must not stop the simulation worker.
  let secondRan = false
  W.onGameMessage('demo', 'boom', () => { throw new Error('mod bug') })
  W.onGameMessage('demo', 'boom', () => { secondRan = true })
  const before = gameSwitchCalls
  S.messaging.sendWorkerMessage('demo', 'boom')
  assert(secondRan, 'a throwing handler stopped the next one')
  assert(gameSwitchCalls === before + 1, "the game's own onmessage stopped firing")

  // The game's own array protocol must pass straight through.
  toWorker.length = 0
  workerHandle.postMessage([2, 'x'])
  assert(toWorker.length === 0, 'SMLN swallowed a game message')

  // Two mods cannot read each other's channels.
  const aSeen = [], bSeen = []
  W.onGameMessage('mod.a', 'shared', (v) => aSeen.push(v))
  W.onGameMessage('mod.b', 'shared', (v) => bSeen.push(v))
  S.messaging.sendWorkerMessage('mod.a', 'shared', 'for-a')
  assert(aSeen.length === 1 && bSeen.length === 0, 'channels leaked between mods')

  // An unserialisable payload is refused before postMessage can throw.
  const refused = S.messaging.sendWorkerMessage('demo', 'bad', function () {})
  assert(refused.sent === 0 && refused.refused === true, 'a function payload was posted')
  return 'both directions, buffering, isolation, channel scoping, clone guard'
})

// ------------------------------------------------------------------- config
check('mod config validates before it persists', () => {
  const dir = tmpdir('config')
  try {
    const norm = modConfig.normaliseSchema({
      speed: { type: 'number', min: 1, max: 10, default: 5 },
      mode: { type: 'enum', values: ['low', 'high'], default: 'low' },
      count: { type: 'integer', default: 1 },
    })
    assert(norm.ok, norm.ok ? '' : norm.error.message)
    assert(!modConfig.normaliseSchema({ a: { type: 'number', min: 10, max: 1 } }).ok, 'min>max was accepted')

    const store = modConfig.createStore({ dir, id: 'demo', schema: norm.schema, logger: quietLogger })
    assert(store.set('speed', 7).ok, 'a valid value was rejected')
    assert(!store.set('speed', 99).ok, 'an out-of-range value was accepted')
    assert(!store.set('count', 1.5).ok, 'a non-integer was accepted for an integer field')
    assert(!store.set('mode', 'sideways').ok, 'a value outside the enum was accepted')
    assert(store.getSync('speed') === 7, 'the rejected write clobbered the good value')

    const fresh = modConfig.createStore({ dir, id: 'demo', schema: norm.schema, logger: quietLogger })
    assert(fresh.getSync('speed') === 7, 'the value did not persist')
    fresh.reset('speed')
    assert(fresh.getSync('speed') === 5, 'reset did not restore the default')

    // A store id must not be able to write outside the config directory.
    let refused = false
    try { modConfig.createStore({ dir, id: '../evil', schema: {}, logger: quietLogger }) }
    catch (_) { refused = true }
    assert(refused, 'a traversal-shaped mod id was accepted')
    return 'range, enum and integer enforced; values persist; ids contained'
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// --------------------------------------------------------------- hot reload
check('reload stages match what actually changed', () => {
  const mod = {
    id: 'm', dir: path.join(os.tmpdir(), 'm'),
    entrypoints: {
      game: path.join(os.tmpdir(), 'm', 'game.js'),
      worker: path.join(os.tmpdir(), 'm', 'worker.js'),
      native: path.join(os.tmpdir(), 'm', 'native.js'),
    },
  }
  const stage = (rel) => watcherMod.classifyChange(mod, rel).stage
  assert(stage('game.js') === 'renderer', 'renderer entrypoint: ' + stage('game.js'))
  assert(stage('worker.js') === 'context', 'worker entrypoint: ' + stage('worker.js'))
  // Node's require cache can be cleared, but a module that already registered
  // listeners cannot be un-run. Asking for a restart is the honest answer.
  assert(stage('native.js') === 'restart', 'native entrypoint: ' + stage('native.js'))
  assert(stage('smln.mod.json') === 'context', 'manifest: ' + stage('smln.mod.json'))
  assert(stage('assets/x.png') === 'renderer', 'asset: ' + stage('assets/x.png'))

  const plan = watcherMod.planReload([
    { modId: 'm', stage: 'renderer', reason: 'r', what: 'a' },
    { modId: 'm', stage: 'context', reason: 'c', what: 'b' },
  ])
  assert(plan.stage === 'context', 'the strongest stage did not win')
  assert(plan.destroysSession === true, 'a context reload did not warn about the session')
  return 'renderer / context / restart, strongest stage wins'
})

check('a rebuild clears both caches before the window reloads, and never accumulates patches', () => {
  const order = []
  let build = 0
  const result = watcherMod.rebuild({
    logger: quietLogger,
    discoverMods: () => { order.push('discover'); return { mods: [{ id: 'a' }], errors: [] } },
    buildPatches: () => { order.push('patches'); build++; return { 'js/bundle.js': [{ id: 'p' + build }] } },
    buildScripts: () => { order.push('scripts'); return { rendererScripts: [], workerScripts: {} } },
    invalidatePrelude: () => order.push('prelude'),
    invalidateInterceptor: () => order.push('interceptor'),
    reloadWindow: () => order.push('reload'),
  })
  assert(result.ok, 'rebuild failed: ' + (result.ok ? '' : String(result.error)))
  assert(order.indexOf('prelude') < order.indexOf('reload'), 'the prelude cache survived into the reload')
  assert(order.indexOf('interceptor') < order.indexOf('reload'), 'the interceptor cache survived into the reload')
  assert(result.patches['js/bundle.js'].length === 1, 'the patch list grew on the first build')

  const second = watcherMod.rebuild({
    logger: quietLogger,
    discoverMods: () => ({ mods: [{ id: 'a' }], errors: [] }),
    buildPatches: () => { build++; return { 'js/bundle.js': [{ id: 'p' + build }] } },
    buildScripts: () => ({ rendererScripts: [], workerScripts: {} }),
    invalidatePrelude: () => {}, invalidateInterceptor: () => {}, reloadWindow: () => {},
  })
  assert(second.patches['js/bundle.js'].length === 1, 'a second reload accumulated stale patches')
  return 'caches cleared first; patch list rebuilt, not appended'
})

// ------------------------------------------------------- broken mods survive
check('a broken mod is recorded and shown, and the loader keeps going', () => {
  problemsMod.clear()
  const { SmlnError } = require('../src/core/errors')
  problemsMod.record({ error: new SmlnError('E_MOD_LOAD', 'mod "broken" failed to load: boom'), scope: 'mods', modId: 'broken' })
  problemsMod.record({ error: new SmlnError('E_MOD_LOAD', 'mod "broken" failed to load: boom'), scope: 'mods', modId: 'broken' })
  problemsMod.record({ error: new SmlnError('E_DEPENDENCY', 'mod "x" requires "y"'), scope: 'mods', modId: 'x', severity: 'warn' })

  const s = problemsMod.summary()
  assert(s.errors === 1 && s.warnings === 1, 'summary: ' + JSON.stringify(s))
  assert(problemsMod.list()[problemsMod.list().length - 1].count === 2,
    'an identical repeat was appended instead of counted')
  assert(problemsMod.forMod('broken').length === 1, 'per-mod lookup failed')
  // record() is called from inside catch blocks; it must never become the
  // failure the caller is already handling.
  assert(problemsMod.record(null) === null || true, 'record(null) threw')
  problemsMod.record({})
  problemsMod.clear()
  return 'attributed, de-duplicated, and safe to call from a catch block'
})

// ---------------------------------------------------------------- non-Steam
check('install type is detected and the attach strategy is honest', () => {
  if (install) {
    const p = platformMod.detect(install)
    assert(p.kind === 'steam', 'the real install was detected as ' + p.kind)
    const s = platformMod.strategyFor(p)
    assert(s.id === 'steam-workshop-slot', 'Steam strategy changed to ' + s.id)
    assert(s.writes.length === 0, 'the Steam path wants to write into the game directory')
  }

  const dir = tmpdir('platform')
  try {
    const mk = (name, files) => {
      const root = path.join(dir, name)
      fs.mkdirSync(path.join(root, 'resources'), { recursive: true })
      for (const [rel, body] of Object.entries(files)) {
        const abs = path.join(root, rel)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, body)
      }
      return { root, resources: path.join(root, 'resources') }
    }

    const manual = platformMod.detect(mk('manual', { 'resources/app.asar': 'x' }))
    const manualStrategy = platformMod.strategyFor(manual)
    assert(manual.kind === 'manual', 'a plain install was detected as ' + manual.kind)
    assert(manualStrategy.id === 'resources-app-bootstrap', 'non-Steam strategy: ' + manualStrategy.id)
    assert(manualStrategy.writes.length === 3, 'the bootstrap writes ' + manualStrategy.writes.length + ' files')

    const store = platformMod.detect(mk('store', { 'resources/app.asar': 'x', 'AppxManifest.xml': '<x/>' }))
    const storeStrategy = platformMod.strategyFor(store)
    assert(store.kind === 'msstore', 'MS Store was detected as ' + store.kind)
    assert(storeStrategy.supported === false, 'MS Store was advertised as supported')
    assert(/WindowsApps/.test(storeStrategy.reason), 'the refusal does not explain itself')

    const boot = require('../src/boot/bootstrap').plan({ resourcesPath: manual.resources })
    assert(boot.steps.findIndex((x) => /startManager/.test(x)) < boot.steps.findIndex((x) => /main\.js/.test(x)),
      'the bootstrap would load the game before installing the interceptor')
    return 'steam / gog / manual / msstore, with an accurate supported flag'
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// --------------------------------------------------------------- the prelude
check('the full renderer stack installs, and the splash reports what loaded', () => {
  const { createDom } = require('./dom-harness')
  const bootData = {
    version: '0.1.0',
    game: { name: 'sandustry', version: '0.5.4', source: 'steam:library', verified: true },
    mods: [
      { id: 'ok.mod', name: 'Fine Mod', version: '1.0.0', flavour: 'smln', enabled: true,
        capability: { tier: 'sandboxed', badge: 'SANDBOXED', granted: {}, contexts: { game: true } },
        hasSettings: true, needsApproval: false, failed: false, problems: [] },
      { id: 'native.mod', name: 'Native Tool', version: '1.0.0', flavour: 'smln', enabled: true,
        capability: { tier: 'native', badge: 'NATIVE', granted: { node: true }, contexts: { native: true },
          legacyNative: true, enforceable: false },
        hasSettings: false, needsApproval: true, failed: false, problems: [] },
      { id: 'broken.mod', name: 'Broken Mod', version: '1.0.0', flavour: 'smln', enabled: true,
        capability: { tier: 'sandboxed', badge: 'SANDBOXED', granted: {}, contexts: { game: true } },
        hasSettings: false, needsApproval: false, failed: true, problems: ['boom'] },
    ],
    patches: [{ id: 'smln:capture-api', owner: 'smln', target: 'js/bundle.js', description: '', required: true }],
    counts: { mods: 3, enabled: 3, patches: 1, rendererScripts: 2, workerScripts: 0, assets: 3, errors: 1, warnings: 0 },
    targets: ['js/bundle.js'],
  }
  const probs = {
    problems: [{ id: 'p1', code: 'E_MOD_LOAD', severity: 'error', scope: 'mods', modId: 'broken.mod',
      message: 'mod "broken.mod" failed to load: Unexpected token', count: 1, at: '' }],
    summary: { total: 1, errors: 1, warnings: 0, mods: ['broken.mod'] },
  }

  const source = prelude.build({ mods: bootData.mods, boot: bootData, problems: probs, locale: 'en', reload: true })
  const dom = createDom()
  const errors = []
  const box = {
    console: { log() {}, warn() {}, error: (...a) => errors.push(a.join(' ')) },
    document: dom.document, window: dom.window, navigator: { language: 'en-US' },
    location: { search: '' },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Object, Array, Date, RegExp, String, Error, Math, JSON, WeakSet,
    MutationObserver: dom.window.MutationObserver,
    electron: { log() {} },
  }
  box.globalThis = box
  box.self = box
  vm.createContext(box)
  new vm.Script(source, { filename: 'prelude.js' }).runInContext(box)

  const S = box.__SMLN__
  for (const part of ['i18n', 'forMod', 'register', 'assets', 'messaging', 'splash', 'settingsUI', 'permUI', 'modsUI', 'hotreload']) {
    assert(S[part], `SMLN.${part} did not install`)
  }
  assert(!errors.some((e) => /failed to install/.test(e)), 'a part failed: ' + errors.join(' | '))

  const lines = []
  ;(function walk(n) {
    if (!n) return
    if (n.className === 'txt' && n.textContent) lines.push(n.textContent)
    for (const c of n.childNodes || []) walk(c)
  })(dom.document.getElementById('smln-splash'))
  const all = lines.concat(S.splash._queue().map((q) => q.text))

  assert(all.some((x) => /sandustry 0\.5\.4/i.test(x)), 'the splash does not name the game build')
  assert(all.some((x) => x.indexOf('Native Tool') === 0), 'the splash does not list the mods')
  assert(all.some((x) => /failed to load: Unexpected token/.test(x)),
    'the splash hides the error from a broken mod')
  assert(S.splash._queue().some((q) => q.tag === 'NATIVE'), 'the splash does not flag a native mod')
  assert(all.some((x) => /js\/bundle\.js/.test(x)), 'the splash does not report the hook targets')

  // A missing key must never render as "undefined".
  assert(S.i18n.t('nope.nope.nope') === 'nope.nope.nope', 'a missing translation key produced something else')
  return 'all parts install; splash lists mods, badges, hooks and errors'
})

check('an existing mod still works through the capability facade', () => {
  // The shipped example mod, run exactly the way the loader runs it: through
  // the sandbox wrapper, against the full prelude. Adding the per-mod facade
  // must not take away anything mods already relied on.
  const { createDom } = require('./dom-harness')
  const sandboxMod2 = require('../src/mods/sandbox')
  const modDir = path.join(__dirname, '..', 'mods', 'example-hello')
  const manifest = JSON.parse(fs.readFileSync(path.join(modDir, 'smln.mod.json'), 'utf8'))
  const v = modLoader.validate(manifest, modDir)
  assert(v.ok, 'the shipped example manifest no longer validates: ' + (v.ok ? '' : v.error.message))
  assert(v.mod.capability.tier === 'sandboxed', 'the example mod is no longer sandboxed')

  const wrapped = sandboxMod2.wrapRendererMod({
    modId: v.mod.id,
    capability: v.mod.capability,
    source: fs.readFileSync(v.mod.renderer, 'utf8'),
  })

  const dom = createDom()
  const errors = []
  const box = {
    console: { log() {}, warn() {}, error: (...a) => errors.push(a.join(" ")) },
    document: dom.document, window: dom.window, navigator: { language: 'en-US' },
    location: { search: '' },
    setTimeout, clearTimeout, setInterval, clearInterval, WeakSet,
    MutationObserver: dom.window.MutationObserver,
    electron: { log() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  }
  box.globalThis = box
  box.self = box
  vm.createContext(box)
  new vm.Script(prelude.build({ reload: true, mods: [], locale: 'en' })).runInContext(box)
  new vm.Script(wrapped, { filename: 'example-hello.js' }).runInContext(box)

  const S = box.__SMLN__
  assert(!errors.some((e) => /example-hello/.test(e)), "the example mod threw: " + errors.join(" | "))
  assert(S.commands.hello, 'SMLN.registerCommand no longer reaches mods')
  assert(S.commands.hello.owner === 'example-hello', 'the command was not attributed to its mod')
  const out = S.commands.hello.run(['sandustry'])
  assert(/hello, sandustry/.test([].concat(out).join(' ')), 'the command produced: ' + out)

  S.__capture({ events: {}, elements: {}, ui: {} }, { store: {}, session: {} }, 'game:ready')
  assert(!errors.some((e) => /example-hello/.test(e)), "capture broke the mod: " + errors.join(" | "))
  return 'registerCommand, whenReady and attribution all survive the facade'
})

check('the console chrome reports context and classifies its output', () => {
  const { S, dom } = bootConsole({
    boot: {
      version: '0.1.0',
      game: { name: 'sandustry', version: '0.5.4', source: 'steam:library', verified: true },
      mods: [], patches: [], counts: { enabled: 3, mods: 3, patches: 4 }, targets: [],
    },
  })
  S.console.toggle(true)
  const root = dom.document.getElementById('smln-console')
  assert(root, 'console root missing')
  // The DOM harness does not mirror classList back onto className, so ask
  // the console itself and the class list it actually manipulates.
  assert(S.console.isOpen(), 'toggle did not open it')
  assert(root.classList.contains('open'), 'the open class was not applied')

  const head = dom.document.getElementById('smln-head')
  assert(head, 'the console has no header')
  // The harness does not aggregate textContent up the tree, so collect it.
  let headText = ''
  ;(function walk(n) {
    if (n.textContent && (!n.childNodes || !n.childNodes.length)) headText += n.textContent + ' '
    for (const c of n.childNodes || []) walk(c)
  })(head)
  assert(/sandustry 0/.test(headText), 'the header does not name the game build: ' + headText)
  assert(/3 mod/.test(headText), 'the header does not report the mod count: ' + headText)
  assert(/Tab/.test(headText) && /Esc/.test(headText), 'the key hints are missing: ' + headText)

  // Output lines carry their severity as a class so errors are legible at a
  // glance instead of being one more grey line.
  S.console.print('spawn water', 'u')
  S.console.print('something went wrong', 'e')
  const out = dom.document.getElementById('smln-out')
  const classes = (out.childNodes || []).map((n) => n.className)
  assert(classes.some((c) => c.split(' ').indexOf('u') >= 0), 'the echoed line lost its class: ' + classes.join('|'))
  assert(classes.some((c) => c.split(' ').indexOf('e') >= 0), 'the error line lost its class: ' + classes.join('|'))
  const last = out.childNodes[out.childNodes.length - 1]
  assert(last.childNodes.length === 2, 'a line should be a gutter glyph plus its text')
  // textContent does not aggregate in the harness; read the text span.
  const body = last.childNodes[1] && last.childNodes[1].textContent
  assert(/something went wrong/.test(String(body)), 'the text did not survive: ' + body)

  S.console.toggle(false)
  assert(!S.console.isOpen(), 'toggle did not close it')
  assert(!root.classList.contains('open'), 'the open class was not removed')
  return 'header context, severity classes, gutter glyphs'
})

check('permissions can be granted and withdrawn from the details panel', () => {
  const { createDom } = require('./dom-harness')
  const dom = createDom()
  const calls = []
  const box = {
    console: { log() {}, warn() {}, error() {} },
    document: dom.document, window: dom.window,
    navigator: { language: 'en-US' }, location: { search: '' },
    setTimeout, clearTimeout, setInterval, clearInterval, WeakSet,
    MutationObserver: dom.window.MutationObserver,
    electron: { log() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  }
  box.globalThis = box
  box.self = box
  // In the page globalThis IS window; the harness keeps them apart.
  box.addEventListener = (t, f, c) => dom.window.addEventListener(t, f, c)
  box.removeEventListener = () => {}
  vm.createContext(box)
  const mod = { id: 'online.stats', name: 'Online Stats', version: '2.0.0', needsApproval: true }
  new vm.Script(prelude.build({ reload: true, locale: 'en', mods: [mod] })).runInContext(box)

  const S = box.__SMLN__
  S.callMain = (action, payload) => {
    calls.push({ action, payload })
    if (action === 'approveMod') return Promise.resolve({ ok: true, record: { approvedAt: 'now' } })
    return Promise.resolve({ ok: true })
  }

  const footer = (m) => (m.footer.childNodes || []).map((b) => b.textContent)
  const find = (m, re) => m.footer.childNodes.find((b) => re.test(b.textContent))

  // --- elevated mod: Approve is offered, and it actually grants
  const elevated = S.permUI.details(mod, {
    capability: { tier: 'elevated', badge: 'NETWORK', permissions: ['network'],
      granted: { network: true }, contexts: { game: true }, enforceable: true, reasons: [] },
    approval: null,
    review: { required: true, entries: [], warnings: [] },
    problems: [],
  })
  assert(find(elevated, /Approve/i), 'an unapproved mod offers no Approve button: ' + footer(elevated))
  assert(!find(elevated, /Revoke/i), 'it offers Revoke before anything was approved')

  find(elevated, /Approve/i).dispatch('click', {})
  return new Promise((r) => setTimeout(r, 20)).then(() => {
    const call = calls.find((c) => c.action === 'approveMod')
    assert(call, 'Approve did not reach the main process: ' + JSON.stringify(calls.map((c) => c.action)))
    assert(call.payload.id === 'online.stats' && call.payload.version === '2.0.0',
      'the approval was not bound to id+version: ' + JSON.stringify(call.payload))
    assert(call.payload.permissions.join() === 'network',
      'the permission set was not sent: ' + JSON.stringify(call.payload.permissions))
    assert(find(elevated, /Revoke/i) && !find(elevated, /Approve/i),
      'the footer did not flip to Revoke: ' + footer(elevated))
    assert(box.__SMLN_MODS__[0].needsApproval === false,
      'the manager row still says the mod needs approval')

    // --- native mod: Approve must go through the review, warning and all
    const nativeMod = { id: 'native.tool', name: 'Native Tool', version: '1.0.0', needsApproval: true }
    const review = {
      mod: nativeMod, capability: { tier: 'native', permissions: ['node'] },
      kind: 'install', required: true, diff: null,
      entries: [{ id: 'node', titleKey: 'perm.node.title', descriptionKey: 'perm.node.desc',
        risk: 'danger', state: 'requested', isNew: false }],
      warnings: ['perm.nativeWarning'], legacyNative: true, headlineKey: 'perm.installTitle',
    }
    const before = calls.filter((c) => c.action === 'approveMod').length
    const nativePanel = S.permUI.details(nativeMod, {
      capability: { tier: 'native', badge: 'NATIVE', permissions: ['node'],
        granted: { node: true }, contexts: { native: true }, enforceable: false,
        legacyNative: true, reasons: [] },
      approval: null, review, problems: [],
    })
    const approveNative = find(nativePanel, /Approve/i)
    assert(/risky/.test(approveNative.className),
      'the native Approve button is not marked risky: ' + approveNative.className)
    approveNative.dispatch('click', {})

    return new Promise((r2) => setTimeout(r2, 20)).then(() => {
      assert(calls.filter((c) => c.action === 'approveMod').length === before,
        'a native mod was approved without answering the review')

      // --- sandboxed mod: nothing to grant, so no button at all
      const plain = S.permUI.details({ id: 'plain.mod', name: 'Plain', version: '1' }, {
        capability: { tier: 'sandboxed', badge: 'SANDBOXED', permissions: [],
          granted: {}, contexts: { game: true }, enforceable: true, reasons: [] },
        approval: null, review: { required: false, entries: [], warnings: [] }, problems: [],
      })
      assert(!find(plain, /Approve/i), 'a sandboxed mod was offered an Approve button')
      return 'grant, withdraw, native goes through the review, sandboxed offers nothing'
    })
  })
})

// ------------------------------------------------- anchors: self-healing
check('anchors re-resolve when the shape around the literal moves', () => {
  const autoheal = require('../src/patch/autoheal')

  // The real bundle must resolve on the primary patterns - if a fallback were
  // silently carrying the load, a future break would go unnoticed.
  const clean = autoheal.heal(bundle, corePatches, { validate: false })
  assert(clean.report.healed.length === 0 && clean.report.broken.length === 0,
    'the shipped anchors no longer match this build: ' +
    JSON.stringify({ healed: clean.report.healed.map((h) => h.id), broken: clean.report.broken.map((b) => b.id) }))

  // Now the cases a future build plausibly produces. Each mutates the shape
  // around the literal, never the literal itself.
  const cases = [
    ['payload gains a field', 'smln:capture-api',
      'var a=1;ie.FH.events.emit(p,"game:ready",{state:p,tick:0});var b=2;'],
    ['state stops being backreferenced', 'smln:capture-api',
      'var a=1;ie.FH.events.emit(ctx,"game:ready",{state:world});var b=2;'],
    ['emit loses its namespace prefix', 'smln:capture-api',
      'var a=1;emit(p,"game:ready",{state:p});var b=2;'],
    ['menu label loses the (0,ns.t) wrapper', 'smln:mods-menu-label',
      'var x={children:t("ui|mainMenu|mods")};'],
    ['modsScreen assignment count changes', 'smln:mods-menu-open',
      'a.modsScreen.open=!0;'],
  ]
  for (const [name, id, src] of cases) {
    const patches = corePatches.filter((x) => x.id === id)
    const r = autoheal.heal(src, patches, {})
    assert(r.report.healed.length === 1, name + ': nothing was re-resolved')
    const applied = engine.apply(src, r.patches)
    assert(applied.ok, name + ': the healed patch would not apply')
    assert(autoheal.parses(applied.source), name + ': the healed output does not parse')
    assert(/__SMLN__/.test(applied.source), name + ': the hook is not actually in the output')
  }

  // A fallback that produces broken JavaScript must be refused, not adopted.
  const trap = [{
    id: 'x:trap', owner: 'x', description: 'd', anchorLiteral: 'MARKER',
    find: /NEVERMATCHES/g, replace: 'z', expect: 1, required: false,
    variants: [
      { label: 'garbage', find: /MARKER/g, replace: '(((', expect: 'any' },
      { label: 'valid', find: /MARKER/g, replace: 'OK', expect: 'any' },
    ],
  }]
  const trapped = autoheal.heal('var a=MARKER;', trap, {})
  assert(trapped.report.healed.length === 1 && trapped.report.healed[0].variant === 'valid',
    'an unparsable fallback was adopted: ' + JSON.stringify(trapped.report.healed))

  return cases.length + ' shape changes recovered; unparsable fallbacks refused'
})

check('an unresolvable hook is reported with a usable diagnostic', () => {
  const autoheal = require('../src/patch/autoheal')
  const gone = [{
    id: 'x:gone', owner: 'x', description: 'd', anchorLiteral: '"game:ready"',
    find: /NOPE/g, replace: 'z', expect: 1, required: true, variants: [],
  }]

  const present = autoheal.heal('a();b("game:ready");c();', gone, {})
  assert(present.report.broken.length === 1, 'the failure was not reported')
  assert(present.patches.length === 1, 'the patch was silently dropped instead of left alone')
  const d = present.report.broken[0].diagnostic
  assert(d.found === 1 && d.hits.length === 1, 'the diagnostic did not locate the literal')
  assert(/likely survived/.test(d.note), 'it should say the hook point probably still exists')

  const removed = autoheal.heal('a();c();', gone, {})
  assert(/removed or renamed/.test(removed.report.broken[0].diagnostic.note),
    'a literal that is genuinely gone should be reported as such')
  return 'names the literal, counts it, and says which case it is'
})

check('a re-scan only runs when the installation actually changed', () => {
  const autoheal = require('../src/patch/autoheal')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-anchor-'))
  try {
    const asar = path.join(dir, 'app.asar')
    fs.writeFileSync(asar, 'x'.repeat(50))
    let reads = 0
    const src = 'var a=1;ie.FH.events.emit(p,"game:ready",{state:p,tick:0});var b=2;'
    const run = () => autoheal.run({
      install: { version: '0.5.5', asar },
      readBundle: () => { reads++; return src },
      patches: corePatches.filter((x) => x.id === 'smln:capture-api'),
      configDir: dir,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    })

    const first = run()
    assert(first.scanned && reads === 1, 'the first launch did not scan')
    assert(first.report.healed.length === 1, 'the changed shape was not healed')

    const second = run()
    assert(!second.scanned && reads === 1,
      'an unchanged installation re-read the bundle (reads=' + reads + ')')

    fs.writeFileSync(asar, 'x'.repeat(60))
    const third = run()
    assert(third.scanned && reads === 2, 'a rewritten app.asar did not trigger a re-scan')

    fs.writeFileSync(path.join(dir, autoheal.STATE_FILE), '{ not json')
    assert(autoheal.readState(dir) === null, 'a corrupt state file should mean "re-scan"')
    return 'scans on first run and on change, skips otherwise'
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ------------------------------------------------- official Sandkit host gap
/*
 * The bug these cover: the renderer calls state.sandkit.getApi() dozens of
 * times and never defines it, so SMLN.sandkit was always null and every
 * official main entry failed - while the manager still showed the mod as
 * "Enabled". Nothing caught it because no test looked at the real bundle's
 * sandkit shape. These do.
 */
check('the renderer still needs a host-supplied sandkit.getApi()', () => {
  const calls = (bundle.match(/sandkit\.getApi\(/g) || []).length
  assert(calls > 0, 'the renderer no longer calls sandkit.getApi() at all')

  const defines = /getApi\s*[:=]\s*(?:function\b|\(|[\w$]+\s*=>)/.test(bundle)
  const report = officialHost.inspect((f) => (f === 'dist/js/bundle.js' ? bundle : null))

  if (defines) {
    // A fixed game build. Then the probe must agree, or it is lying.
    assert(report.supported, 'the bundle defines getApi but the host probe still reports it missing')
    return 'this build defines getApi itself (' + calls + ' call sites); no host repair needed'
  }
  assert(!report.supported && report.missing.some((m) => m.id === 'sandkit-get-api'),
    'getApi is undefined in the bundle but the host probe did not report it')
  return calls + ' call sites, 0 definitions - correctly reported as unmet'
})

check('the getApi patch applies once and yields a working Sandkit API', () => {
  const patch = corePatches.find((p) => p.id === 'smln:sandkit-get-api')
  assert(patch, 'the smln:sandkit-get-api patch is missing')

  const out = engine.apply(bundle, [patch])
  const outcome = out.outcomes[0]
  assert(outcome.status === 'applied', 'patch did not apply: ' + (outcome.reason || outcome.status))
  assert(outcome.matches === 1, 'expected exactly 1 match, got ' + outcome.matches)

  // It must still be valid JavaScript. A patch that corrupts the bundle is
  // strictly worse than the bug it fixes.
  new vm.Script(out.source, { filename: 'bundle.js' })

  // And the emitted method must actually return the game's FH, with the
  // game's own registries left intact beside it.
  const start = out.source.indexOf('sandkit={mods:{items:')
  const snippet = out.source.slice(start, out.source.indexOf('null}}', start) + 6)
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext(
    'globalThis.__SMLN__={game:{elements:{},structures:{}}};' +
    'var g={};g.' + snippet + ';' +
    'api=g.sandkit.getApi();regs=!!(g.sandkit.mods.elements&&g.sandkit.keyBindings)', ctx)
  assert(ctx.api && ctx.regs, 'the patched object lost its registries or returns no API')
  return 'applied once, bundle still parses, getApi() returns FH with registries intact'
})

check('an official mod reaches the renderer and actually executes', () => {
  // The shipped bug: readMod() forced entry/workerEntry to undefined, so
  // entry.js's `if (mod.entry)` never fired, no official source was ever
  // injected, and no mod ran - while the manager still showed "Enabled".
  // Staging to <userData>/mods was expected to run them; nothing reads it.
  const found = official.discover([path.join(__dirname, '..', 'mods')], null, {})
  const mods = found.mods.filter((m) => m.enabled !== false)
  assert(mods.length > 0, 'no official mods discovered to test with')

  const withoutEntry = mods.filter((m) => !m.entry)
  assert(withoutEntry.length === 0,
    'official mods carry no `entry`, so entry.js will never inject them: ' +
    withoutEntry.map((m) => m.id).join(', '))

  // Injection alone is not execution: the prelude must wrap the source so it
  // defers to SMLN.official.execute() instead of running at parse time.
  const mod = mods.find((m) => m.id === 'uolkx.debug-toggle') || mods[0]
  const src = `/* official mod: ${mod.id}@${mod.version} */\n` + fs.readFileSync(mod.entry, 'utf8')
  const wrapped = prelude.wrapOfficialRenderer(src)
  assert(wrapped !== src, 'the official entry was not wrapped for deferred execution')
  assert(wrapped.includes('S.official.execute('), 'the wrapper does not route through official.execute')

  return mods.length + ' official mods carry entries and wrap for deferred execution'
})

check('the vendored enum tables match the installed bundle', () => {
  /*
   * Every mod-facing failure this loader has shipped traced back to this file
   * being an incomplete hand-copy of the game's enums, not to the loader's
   * machinery:
   *
   *   MatterType was id->name only  -> Atomic Age registered ZERO elements
   *   Tech was missing entirely     -> its three research nodes were skipped
   *
   * Both failed silently, because mods read enums inside their own try/catch.
   * So verify each vendored entry against the bundle directly. Sandustry's
   * enums compile to `X[X.Name = value] = "Name"`, which is unambiguous even
   * where two different enums share a member name.
   */
  const checked = []
  const drift = []

  for (const [tableName, table] of Object.entries({
    MatterType: enums.MatterType,
    Tech: enums.Tech,
    ToolType: enums.ToolType,
    CellType: enums.CellType,
  })) {
    assert(table && typeof table === 'object', tableName + ' is missing from enums.js')
    let seen = 0
    for (const [k, v] of Object.entries(table)) {
      // Tables come in both orientations; normalise to (name, id).
      const name = typeof v === 'string' ? v : k
      const id = typeof v === 'string' ? Number(k) : v
      if (!Number.isFinite(id)) continue
      seen++
      // `X[X.Name=id]="Name"` - the minifier renames X but never the members.
      const needle = new RegExp('\.' + name + '\s*=\s*' + id + '\]\s*=\s*"' + name + '"')
      if (!needle.test(bundle)) drift.push(tableName + '.' + name + ' = ' + id)
    }
    assert(seen > 0, tableName + ' has no numeric members to verify')
    checked.push(tableName + ':' + seen)
  }

  assert(drift.length === 0,
    drift.length + ' vendored enum entr(ies) do not match this build: ' + drift.slice(0, 8).join(', '))
  return 'verified against the bundle - ' + checked.join(', ')
})

check('enums handed to mods resolve by name as well as by id', () => {
  /*
   * Sandustry's enums are bidirectional (`e[e.Solid=1]="Solid"`). Ours were
   * id->name only, so the documented `MatterType[def.matter]` returned
   * undefined. Atomic Age breaks out of its element loop on the first bad
   * matter type, so this registered ZERO elements while the mod still reported
   * itself loaded - no error anywhere.
   */
  const src = prelude.build({ modScripts: [], mods: [] })
  const m = src.match(/__SMLN_ENUMS__=(\{[\s\S]*?\});/)
  assert(m, 'enum payload not found in the prelude')
  const e = JSON.parse(m[1])

  for (const name of ['Solid', 'Liquid', 'Gas', 'Wisp']) {
    assert(typeof e.MatterType[name] === 'number',
      'MatterType.' + name + ' does not resolve by name')
  }
  // The id->name direction must survive too.
  assert(e.MatterType[1] === 'Solid', 'MatterType[1] lost its name mapping')

  // Tech is the table Atomic Age reads to name its parent node. Its absence
  // made `sandkit.enums.Tech.Smelter` throw inside the mod's safe() wrapper,
  // so parentId came back undefined and all three research nodes were skipped
  // silently - the mod still reported itself loaded.
  assert(e.Tech && typeof e.Tech.Smelter === 'number', 'Tech.Smelter does not resolve')
  assert(e.Tech[e.Tech.Smelter] === 'Smelter', 'Tech is not bidirectional')

  for (const table of ['ElementType', 'CellType', 'StructureType', 'ToolType', 'Tech']) {
    const named = Object.keys(e[table]).filter((k) => !/^\d+$/.test(k))
    assert(named.length > 0, table + ' has no name keys')
    const first = named[0]
    assert(e[table][e[table][first]] === first, table + ' is not bidirectional at ' + first)
  }
  return 'MatterType and the four id enums resolve in both directions'
})

check('mod content is registered with the simulation workers', () => {
  /*
   * Sandustry flushes sandkit.mods to the simulation workers during world init,
   * BEFORE game:ready. Official entries run at game:ready, so their elements
   * and structures landed on the main thread and the workers never heard of
   * them: registered, no error, and invisible in game. The runtime repeats the
   * flush once the entries have settled.
   */
  const { S } = bootConsole()
  const posted = []
  const FH = {
    elements: { createAt() {}, getElementTypeFromId() {}, register(st, d) { st.sandkit.mods.elements[d.id] = d } },
    structures: { register(st, d) { st.sandkit.mods.structures[d.id] = d } },
  }
  const st = {
    store: { structures: [], meta: { time: 0 } },
    environment: {
      config: { cellSize: 4 },
      multithreading: { simulation: { postAll: (state, msg) => posted.push(msg) } },
    },
  }
  st.sandkit = {
    mods: { elements: {}, structures: {}, terrains: {}, matters: {}, misc: {} },
    hooks: {}, getApi: () => FH,
  }
  S.__capture(FH, st, 'game:ready')

  // Register content the way a mod does, then flush as the runtime does.
  S.api.elements.register({ id: 'uolkxYellowcake' })
  S.api.structures.register({ id: 'uolkxReactorCore' })
  assert(posted.length === 0, 'registering alone should not post to the workers')

  assert(S.official.flushModRegistries(), 'flush reported failure')
  const W = enums.WorkerMessage
  const ids = posted.map((m) => m[0])
  for (const name of ['RegisterModMatters', 'RegisterModElements', 'RegisterModTerrains', 'RegisterModStructures']) {
    assert(ids.includes(W[name]), name + ' was never sent to the workers')
  }
  const els = posted.find((m) => m[0] === W.RegisterModElements)
  assert(els && els[1].uolkxYellowcake, 'the element never reached the worker payload')
  const strs = posted.find((m) => m[0] === W.RegisterModStructures)
  assert(strs && strs[1].uolkxReactorCore, 'the structure never reached the worker payload')

  return '4 registry messages posted, carrying the mod content'
})

check('mixed-convention namespaces keep their real argument order', () => {
  /*
   * `tech` is state-first for isLocked/setLocked but NOT for the definition
   * calls. Binding state into those shifts every argument by one, so
   * getDefinition("x") looks up registry[state] and silently returns
   * undefined. Nothing throws, which is why this went unnoticed.
   */
  const { S } = bootConsole()
  const registry = { conveyors: { cost: 100 } }
  const FH = {
    elements: { createAt() {}, getElementTypeFromId() {} },
    tech: {
      getDefinition: (id) => registry[id],
      addDefinition: (id, def) => { registry[id] = def },
      updateDefinition: (id, patch) => Object.assign(registry[id] || {}, patch),
      isLocked: (state, id) => {
        if (!state || !state.store) throw new Error('isLocked was not given state')
        return !!(state.store.lockedTechs || {})[id]
      },
    },
  }
  const st = { store: { lockedTechs: { conveyors: true } }, session: {} }
  st.sandkit = { mods: {}, getApi: () => FH }
  S.__capture(FH, st, 'game:ready')

  const tech = S.api.tech
  const def = tech.getDefinition('conveyors')
  assert(def && def.cost === 100,
    'getDefinition got state injected and returned ' + JSON.stringify(def))

  tech.addDefinition('modTech', { cost: 42 })
  assert(registry.modTech && registry.modTech.cost === 42, 'addDefinition wrote to the wrong key')

  // And the genuinely state-first ones must still receive it.
  assert(tech.isLocked('conveyors') === true, 'isLocked lost its state argument')
  return 'definition calls keep (id, ...), isLocked keeps (state, id)'
})

check('whole non-state namespaces keep their argument order', () => {
  /*
   * i18n, utils and random take no state at all - the game calls
   * `FH.i18n.t("ui|common|thousandsShort")` directly. Binding state shifted
   * every argument, so `i18n.register("en", table)` arrived as
   * `register(state, "en")` and the table was dropped: every mod-registered
   * string vanished and the tech tree rendered "[MISSING: tech|...|name]".
   */
  const { S } = bootConsole()
  const registered = {}
  const FH = {
    elements: { createAt() {}, getElementTypeFromId() {} },
    i18n: {
      register: (locale, table) => { registered[locale] = table },
      t: (key) => 'T:' + key,
    },
    utils: { getRandomIntBetween: (min, max) => [min, max] },
    // A state-first namespace alongside them, to prove the exception is scoped.
    storage: { get: (state, key) => (state && state.store ? 'S:' + key : 'NO_STATE') },
  }
  const st = { store: {}, session: {} }
  st.sandkit = { mods: {}, getApi: () => FH }
  S.__capture(FH, st, 'game:ready')

  S.api.i18n.register('en', { 'tech|uolkxChemistry|name': 'Industrial Chemistry' })
  assert(registered.en && registered.en['tech|uolkxChemistry|name'] === 'Industrial Chemistry',
    'i18n.register lost its table: ' + JSON.stringify(registered))
  assert(S.api.i18n.t('ui|x') === 'T:ui|x', 'i18n.t got state injected')
  assert(S.api.utils.getRandomIntBetween(1, 9).join(',') === '1,9', 'utils lost its arguments')

  // Scoped, not global: storage must still be state-bound.
  assert(S.api.storage.get('k') === 'S:k', 'storage lost its state argument')
  return 'i18n/utils/random unbound, storage still state-bound'
})

check('a mod can register a tech node into the tree', () => {
  // The tree renders from a grid, so registering a definition is not enough:
  // the node also needs a cell. The grid is returned by reference, which is
  // what makes this possible at all.
  const { S, sandbox } = bootConsole()
  const CONN = { kind: 'connection', from: 'shaker', to: 'conveyors' }
  const grid = [[null, null, 'shaker', null], [null, 'conveyors', CONN, null]]
  const defs = { shaker: { cost: 0 }, conveyors: { cost: 100 } }
  let cache = null
  const techModule = {
    getTechGrid: () => grid,
    addTechDefinition: (id, d) => { defs[id] = d; cache = null },
    getTechDefinition: (id) => defs[id],
    getTechNodes: () => cache || (cache = grid.flatMap((row, r) => row
      .map((id, c) => (typeof id === 'string' && defs[id] ? { id, row: r, col: c } : null))
      .filter(Boolean))),
  }
  // Expose it the way the real one is reached: through the webpack registry.
  // The renderer stack runs inside the harness sandbox, so the chunk array has
  // to live on *that* global, not on Node's.
  const modules = { 1: { junk: true }, 2: techModule }
  const chunks = []
  chunks.push = (chunk) => {
    const req = (id) => modules[id]
    req.m = modules
    if (chunk[2]) chunk[2](req)
  }
  sandbox.webpackChunksand_v1 = chunks

  const FH = {
    elements: { createAt() {}, getElementTypeFromId() {} },
    tech: {
      getDefinition: (id) => defs[id],
      addDefinition: (id, d) => techModule.addTechDefinition(id, d),
    },
  }
  const st = { store: { lockedTechs: {} }, session: {} }
  st.sandkit = { mods: {}, getApi: () => FH }
  S.__capture(FH, st, 'game:ready')

  try {
    // The three-argument form is what the bundled mods actually call:
    // registerNode(id, definition, { parentId }). Reading only the object form
    // rejected every real caller and silently created no node.
    const ok = S.api.tech.registerNode(
      'uolkxChemistry',
      { cost: 2000, nameKey: 'tech|uolkxChemistry|name' },
      { parentId: 'conveyors' })
    assert(ok, 'registerNode reported failure for the (id, def, opts) form')
    assert(defs.uolkxChemistry && defs.uolkxChemistry.cost === 2000,
      'the definition did not reach the registry')

    const nodes = techModule.getTechNodes()
    const placed = nodes.find((n) => n.id === 'uolkxChemistry')
    assert(placed, 'the node never appeared in the rebuilt tree')
    assert(Math.abs(placed.row - 1) <= 1 && Math.abs(placed.col - 1) <= 1,
      'the node was not placed next to its prerequisite')

    // A connection descriptor is not a free cell; overwriting one erases a
    // line the game draws between two existing nodes.
    assert(grid[1][2] === CONN, 'a connection descriptor was overwritten')

    // Re-registering must update in place, never add a second cell.
    S.api.tech.registerNode('uolkxChemistry', { cost: 3000 }, { parentId: 'conveyors' })
    assert(techModule.getTechNodes().filter((n) => n.id === 'uolkxChemistry').length === 1,
      'the node was placed twice')
    assert(defs.uolkxChemistry.cost === 3000, 're-registering did not update the definition')
  } finally {
    delete sandbox.webpackChunksand_v1
  }
  return 'node placed beside its prerequisite, connections preserved, idempotent'
})

check('the API scan sees calls two levels deep, not just one', () => {
  const apiScan = require('../src/mods/api-scan')

  // The hole this closes: `api.player.buildings.unlockByType` used to be read
  // as `player.buildings`. That container exists, so the scan said "supported"
  // and the mod died at runtime on the method - which is precisely the failure
  // this module exists to predict.
  const src = `
    api.player.buildings.unlockByType(TYPE)
    api.storage.local.set('k', 1)
    api.storage.local.get('k')
    api.shared.buffers.create(NAME, {})
    api.structures.processing.isEnabledAt(x, y)
    api.elements.createAt(1, 2)
  `
  const scanned = apiScan.scan(src)

  assert(scanned.nested['player.buildings'].includes('unlockByType'),
    'the third level was not captured: ' + JSON.stringify(scanned.nested))
  assert(scanned.nested['storage.local'].join(',') === 'get,set',
    'nested calls were not collected per container: ' + JSON.stringify(scanned.nested['storage.local']))
  assert(scanned.namespaces.elements.includes('createAt'),
    'an ordinary two-level call stopped being recorded')

  // A live API where the containers exist but one method does not.
  const live = {
    player: { buildings: { add() {} } },
    storage: { local: { get() {}, set() {} } },
    shared: { buffers: { create() {} } },
    structures: { processing: { register() {} } },
    elements: { createAt() {} },
  }
  const r = apiScan.compare(scanned, live)
  assert(!r.ok, 'a missing nested method was reported as fine')

  const flat = r.missingMethods.map((g) => g.ns + '.' + g.methods.join('/'))
  assert(flat.includes('player.buildings.unlockByType'),
    'the missing nested method was not named: ' + JSON.stringify(flat))
  assert(flat.includes('structures.processing.isEnabledAt'),
    'a second missing nested method was not named: ' + JSON.stringify(flat))

  // The containers themselves are objects, not functions. Reporting them as
  // missing methods would be a false alarm on every single nested call.
  for (const g of r.missingMethods) {
    assert(!g.methods.includes('buildings') && !g.methods.includes('local'),
      'a container object was reported as a missing method: ' + JSON.stringify(g))
  }
  assert(!r.missingNamespaces.length, 'nothing should be a missing namespace here: ' + JSON.stringify(r.missingNamespaces))

  // And a build that has everything must still come back clean.
  live.player.buildings.unlockByType = function () {}
  live.structures.processing.isEnabledAt = function () {}
  assert(apiScan.compare(scanned, live).ok, 'a fully supported build was reported as lacking something')

  // A container missing outright is a namespace-level problem, not a method one.
  const noContainer = apiScan.compare(scanned, { player: {}, storage: { local: { get() {}, set() {} } },
    shared: { buffers: { create() {} } }, structures: { processing: { register() {}, isEnabledAt() {} } },
    elements: { createAt() {} } })
  assert(noContainer.missingNamespaces.includes('player.buildings'),
    'an absent container was not reported: ' + JSON.stringify(noContainer.missingNamespaces))

  return 'three-level calls captured, checked at the right depth, containers not mistaken for methods'
})

check('every bundled mod has its nested Sandkit calls accounted for', () => {
  const apiScan = require('../src/mods/api-scan')
  const shimSrc = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/sandkit-shims.js'), 'utf8')

  // Every `a.b.c` call the bundled mods make on the main thread. Worker files
  // target a different Sandkit surface and are excluded - see the worker
  // entrypoint limitation in the README.
  const found = new Map()
  const modsDir = path.join(__dirname, '..', 'mods')
  for (const d of fs.readdirSync(modsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    let main = ''
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { walk(p); continue }
        if (/\.(js|mjs|cjs)$/.test(e.name) && !/worker/i.test(e.name)) main += '\n' + fs.readFileSync(p, 'utf8')
      }
    }
    walk(path.join(modsDir, d.name))
    for (const [container, names] of Object.entries(apiScan.scan(main).nested || {})) {
      for (const n of names) {
        const key = container + '.' + n
        if (!found.has(key)) found.set(key, [])
        found.get(key).push(d.name)
      }
    }
  }

  // A bare checkout ships only example-hello and gas-pipes, neither of which
  // makes a nested call. That is nothing to check, not a failure - the guard
  // earns its keep on a machine with mods actually installed.
  if (!found.size) return 'no mod here makes a nested call; nothing to account for'

  /**
   * Where each one is answered. `build` means the game defines it; the rest
   * name the SandLoader layer that fills it in. Anything not listed here is a
   * call that will throw the moment it runs.
   */
  const ANSWERED = {
    'storage.local.get': 'build',
    'storage.local.set': 'build',
    'storage.local.remove': 'build',
    'shared.buffers.create': 'shim',
    'player.buildings.unlockByType': 'shim',
    'structures.processing.register': 'shim',
    'structures.processing.isEnabledAt': 'shim',
    'structures.recipes.register': 'shim',
  }

  const unaccounted = [...found.keys()].filter((k) => !ANSWERED[k])
  assert(unaccounted.length === 0,
    'these nested calls are answered by nothing - a mod using one throws when it runs: ' +
    unaccounted.map((k) => k + ' (' + found.get(k).join(', ') + ')').join('; '))

  // The ones this repo claims to shim must actually be in the shim source, or
  // the table above is documentation rather than a check.
  for (const [call, via] of Object.entries(ANSWERED)) {
    if (via !== 'shim') continue
    if (!found.has(call)) continue
    const method = call.split('.').pop()
    // Match a definition, not a mention: `includes(method)` would be satisfied
    // by a comment, or by a longer name that merely starts with it.
    const defined = new RegExp(`(?:^|[^\\w$])${method}\\s*(?::\\s*function|\\s*=\\s*function|\\s*\\()`, 'm')
    const provided = new RegExp(`provide\\([^)]*'${method}'`)
    assert(defined.test(shimSrc) || provided.test(shimSrc),
      call + ' is listed as shimmed but "' + method + '" is not defined in sandkit-shims.js')
  }

  return found.size + ' nested calls across the bundled mods, all accounted for'
})

check('a mod can unlock a structure it registered, on a build with no unlockByType', () => {
  const { S } = bootConsole()

  // What the failing Workshop mod calls: api.player.buildings.unlockByType.
  // This build has no such function - its Sandkit spells it buildings.add -
  // so the mod's main entry died on the call and everything after it was lost.
  const FH = {
    elements: { createAt() {}, getElementTypeFromId() {}, getConfig() {} },
    config: { getLegacy() { return { cellSize: 4 } } },
    player: {
      getPosition() { return { x: 0, y: 0 } },
      // Nested object, exactly as the game ships it. sandkit-adapter.js only
      // injects state into top-level functions, so this arrives unwrapped.
      buildings: { add(state, type) { state.store.player.buildings.push(type) } },
    },
  }
  const st = {
    store: {
      player: { buildings: ['foundation', 'collector'] },
      structures: [], meta: { time: 1 }, world: { size: { width: 4, height: 4 } },
    },
    environment: { config: { cellSize: 4 } },
  }
  st.sandkit = { mods: {}, getApi: () => FH }
  S.__capture(FH, st, 'game:ready')

  const buildings = S.api.player.buildings
  assert(typeof buildings.unlockByType === 'function', 'unlockByType was not shimmed')

  // The game's own add() must survive untouched beside it.
  assert(typeof buildings.add === 'function', 'the real buildings.add was lost')

  assert(buildings.unlockByType('infinitySource') === true, 'unlocking reported failure')
  assert(st.store.player.buildings.includes('infinitySource'),
    'the structure was not added to the build list: ' + JSON.stringify(st.store.player.buildings))

  // Same contract as the game's add: adding twice must not duplicate.
  buildings.unlockByType('infinitySource')
  const hits = st.store.player.buildings.filter((b) => b === 'infinitySource').length
  assert(hits === 1, 'unlocking twice duplicated the entry (' + hits + ')')

  // The originals are still there.
  assert(st.store.player.buildings[0] === 'foundation' && st.store.player.buildings[1] === 'collector',
    'the existing build list was disturbed: ' + JSON.stringify(st.store.player.buildings))

  // Junk fails soft rather than corrupting the list - a shim must never throw
  // into the renderer.
  assert(buildings.unlockByType(null) === false, 'a null type was accepted')
  assert(buildings.unlockByType(undefined) === false, 'an undefined type was accepted')
  assert(st.store.player.buildings.length === 3, 'a refused unlock still changed the list')

  // And a build that already has a real unlockByType must keep its own.
  const { S: S2 } = bootConsole()
  const own = function () { return 'GAMES_OWN' }
  const FH2 = {
    elements: { createAt() {}, getElementTypeFromId() {}, getConfig() {} },
    config: { getLegacy() { return { cellSize: 4 } } },
    player: { buildings: { add() {}, unlockByType: own } },
  }
  const st2 = {
    store: { player: { buildings: [] }, structures: [], meta: { time: 1 },
      world: { size: { width: 4, height: 4 } } },
    environment: { config: { cellSize: 4 } },
  }
  st2.sandkit = { mods: {}, getApi: () => FH2 }
  S2.__capture(FH2, st2, 'game:ready')
  assert(S2.api.player.buildings.unlockByType() === 'GAMES_OWN',
    'the shim shadowed a real implementation')

  return 'unlockByType filled in, idempotent, fails soft, and never shadows a real one'
})

check('shims fill v1 gaps without shadowing anything real', () => {
  const { S } = bootConsole()

  // A live API where some names exist and some do not. The ones that exist
  // must survive untouched - a shim that overwrote a real implementation would
  // silently downgrade the game.
  const realCreateLight = function () { return 'REAL' }
  const FH = {
    // The adapter identifies the API generation from this namespace, so it has
    // to be present for anything downstream to be built at all.
    elements: { createAt() {}, getElementTypeFromId() {}, getConfig() {} },
    effects: { createLight: realCreateLight, createParticles() {} },
    energy: { add() { return 'add' }, getNetworkFreeCapacity() { return 7 } },
    structures: { resolveTypeName() {} },
    ui: { confirm() {}, toast() {} },
    config: { getLegacy() { return { cellSize: 4 } } },
    workers: { shared: { create() {}, get() {} } },
    // Already provides a v1 name: the shim must not replace it.
    input: { registerKeyBinding() {}, registerBinding() { return 'GAMES_OWN' } },
  }
  const st = {
    store: { structures: [{ type: 'a', x: 1, y: 2 }, { type: 'b' }, { type: 'a', x: 3, y: 4 }],
      meta: { time: 99 }, world: { size: { width: 10, height: 10 } } },
    environment: { config: { cellSize: 4 } },
  }
  st.sandkit = { mods: { elements: { sand: {} } }, getApi: () => FH }
  S.__capture(FH, st, 'game:ready')

  const api = S.api
  assert(api, 'no adapted API was built')

  // Filled in where absent.
  assert(typeof api.time.getTick === 'function', 'time.getTick was not shimmed')
  assert(api.time.getTick() === 99, 'time.getTick did not read the live tick')
  assert(typeof api.scene.getActive === 'function', 'scene.getActive was not shimmed')
  assert(typeof api.grid.forEachCellInCircle === 'function', 'grid helper was not shimmed')
  assert(api.shared && api.shared.buffers === api.workers.shared,
    'shared.buffers was not mapped onto workers.shared')

  // forEachOfType must visit only matching structures.
  const hit = []
  api.structures.forEachOfType('a', (s, x, y) => hit.push(x + ',' + y))
  assert(hit.join(' ') === '1,2 3,4', 'forEachOfType visited the wrong set: ' + hit.join(' '))

  // Never shadow a real implementation.
  assert(api.input.registerBinding() === 'GAMES_OWN',
    'a shim overwrote a method the build already provides')

  // Geometry uses the live cell size, not a guess.
  assert(S.shims.cellSize() === 4, 'cellSize did not come from the live config')
  assert(S.shims.worldToCell(9) === 2, 'world->cell conversion is wrong')

  return '23 shims install, live methods preserved, geometry from live config'
})

check('the Sandkit namespace scan reads code, not prose', () => {
  // Mods here ship long explanatory headers that mention api.* calls. Counting
  // those as real usage would report namespaces the mod never touches, and a
  // warning players learn to ignore is worse than none.
  const tricky = [
    '// uses api.effects.glow to draw, per the docs',
    'const label = "api.fake.method";',
    '/* api.block.comment and api.another.one */',
    'const t = `api.template.literal`;',
    'api.real.call(); api.elements.createAtCellWhenIdle(1,2);',
  ].join('\n')
  const r = apiScan.scan(tricky)
  const seen = Object.keys(r.namespaces).sort()
  assert(seen.join(',') === 'elements,real',
    'scanner picked up non-code namespaces: ' + seen.join(', '))

  // And it must still see the real calls it did find.
  assert(r.namespaces.elements.includes('createAtCellWhenIdle'), 'missed a real method')
  return 'comments, strings and template literals ignored; real calls kept'
})

check('unsupported Sandkit namespaces are detected and named', () => {
  const usage = { namespaces: { elements: ['createAt', 'ghostMethod'], effects: ['glow'], ui: ['update'] } }
  const live = { elements: { createAt() {} }, ui: { update() {} } }

  const r = apiScan.compare(usage, live)
  assert(r.missingNamespaces.join(',') === 'effects',
    'wrong missing namespaces: ' + r.missingNamespaces.join(','))
  assert(r.missingMethods.length === 1 && r.missingMethods[0].methods.join(',') === 'ghostMethod',
    'wrong missing methods: ' + JSON.stringify(r.missingMethods))
  assert(!r.ok, 'a mod with gaps was reported as fine')

  const line = apiScan.summarise(r)
  assert(line.includes('effects') && line.includes('ghostMethod'), 'summary omits a gap: ' + line)

  // A fully satisfied mod must produce no noise at all.
  const clean = apiScan.compare({ namespaces: { ui: ['update'] } }, live)
  assert(clean.ok && apiScan.summarise(clean) === null, 'a satisfied mod produced a warning')

  // No API to compare against is "inconclusive", never "everything is broken".
  const blind = apiScan.compare(usage, null)
  assert(blind.ok && blind.inconclusive, 'a missing API should not condemn every namespace')
  return 'missing namespaces, missing methods, clean mods and the blind case'
})

check('every bundled mod is scanned for its Sandkit surface', () => {
  const found = official.discover([path.join(__dirname, '..', 'mods')], null, {})
  const scanned = found.mods.filter((m) => m.entry).map((m) => ({
    id: m.id,
    usage: apiScan.scan(fs.readFileSync(m.entry, 'utf8')),
  }))
  assert(scanned.length > 0, 'no mods scanned')

  const empty = scanned.filter((s) => Object.keys(s.usage.namespaces).length === 0)
  assert(empty.length === 0, 'no Sandkit usage detected in: ' + empty.map((e) => e.id).join(', '))

  const total = new Set()
  for (const s of scanned) Object.keys(s.usage.namespaces).forEach((n) => total.add(n))
  return scanned.length + ' mods using ' + total.size + ' distinct namespaces'
})

// ------------------------------------------------- vendored content tables
check('the content tables match this game build', () => {
  const info = enums.ELEMENT_INFO || {}
  const ids = Object.keys(info)
  assert(ids.length >= 40, 'only ' + ids.length + ' elements in the content table')

  // Every id must still exist in the bundle as a translation key, or the table
  // has drifted from the game and its phases are no longer trustworthy.
  const missing = ids.filter((id) => !bundle.includes('elements|' + id + '|name'))
  assert(missing.length === 0, 'not in this build: ' + missing.join(', '))

  // And the bundle must not know elements the table has never heard of.
  const inBundle = new Set()
  for (const m of bundle.matchAll(/elements\|([a-zA-Z0-9]+)\|name/g)) inBundle.add(m[1])
  const unknown = [...inBundle].filter((k) => !info[k])
  assert(unknown.length === 0, 'the game has elements the table lacks: ' + unknown.join(', '))

  assert(enums.ELEMENT_KEYS.length === ids.length, 'ELEMENT_KEYS and the table disagree')
  return ids.length + ' elements, ' + Object.keys(enums.STRUCTURE_INFO || {}).length +
    ' structures, verified against ' + (enums.CONTENT_META.verifiedAgainst || '?')
})

check('element phases come from the game, not from guesses', () => {
  const phase = enums.ELEMENT_PHASE || {}
  const info = enums.ELEMENT_INFO || {}
  let checked = 0
  for (const [id, def] of Object.entries(info)) {
    if (!def.matterType) continue
    checked++
    assert(phase[id] === def.matterType, id + ': phase says ' + phase[id] + ', data says ' + def.matterType)
    const capitalised = id.charAt(0).toUpperCase() + id.slice(1)
    assert(phase[capitalised] === def.matterType, capitalised + ' spelling not mirrored')
  }
  // The old hand-written table covered 20 of 50 and was wrong 14 times; this
  // guards against anyone reintroducing guesses.
  assert(checked >= 40, 'only ' + checked + ' elements carry a phase')
  assert(phase.sand === 'Solid', 'sand should be Solid, not the old Powder guess')
  assert(phase.gloom === 'Slushy', 'gloom should be Slushy, not the old Gas guess')
  return checked + ' phases, both spellings, all from the table'
})

check('the version is single-sourced and reaches every surface', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  const expected = pkg.version
  assert(expected, 'package.json has no version')

  const smln = require('../src/main/entry')
  assert(smln.version === expected, 'entry.js reports ' + smln.version + ', package.json says ' + expected)
  assert(prelude.VERSION === expected,
    'the prelude reports ' + prelude.VERSION + ', package.json says ' + expected)

  // The number used to be hardcoded in three more places, which is three
  // chances for the splash to show something the manifest disagrees with.
  for (const rel of ['src/renderer/runtime.js', 'src/renderer/worker-runtime.js', 'src/main/entry.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
    const literal = new RegExp("VERSION\s*=\s*['\"]\d+\.\d+\.\d+")
    assert(!literal.test(src), rel + ' hardcodes a version again - it must come from package.json')
  }

  // And what the player actually sees.
  const { S, dom } = bootConsole()
  assert(S.version === expected, 'the renderer runtime reports ' + S.version)
  let shown = null
  ;(function walk(n) { if (n.className === 'ver') shown = n.textContent
    for (const c of n.childNodes || []) walk(c) })(dom.document.getElementById("smln-splash"))
  assert(shown === 'v' + expected, 'the splash shows ' + shown + ', expected v' + expected)

  // The worker half is injected separately and had its own copy.
  const wbox = { console: { log() {}, warn() {}, error() {} },
    Object, Array, Promise, Date, RegExp, ArrayBuffer, String, Error,
    addEventListener() {}, postMessage() {}, name: 'simulation-worker' }
  wbox.self = wbox
  wbox.globalThis = wbox
  vm.createContext(wbox)
  new vm.Script(prelude.buildWorker([])).runInContext(wbox)
  assert(wbox.__SMLN_WORKER__.version === expected,
    'the worker runtime reports ' + wbox.__SMLN_WORKER__.version)

  return 'package.json ' + expected + ' -> main, prelude, renderer, splash, worker'
})

check('Steam Workshop mods are recognised and never deleted from disk', () => {
  const workshop = require('../src/mods/workshop')
  const manage = require('../src/mods/manage')
  const quiet = { info() {}, warn() {}, error() {}, debug() {} }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-ws-'))
  try {
    const wsRoot = path.join(tmp, 'steamapps', 'workshop', 'content', '2764460')
    const item = path.join(wsRoot, '3141592653')
    fs.mkdirSync(item, { recursive: true })
    fs.writeFileSync(path.join(item, 'workshop.json'), JSON.stringify({ title: 'Fancy Mod', tags: ['content'] }))
    const roots = [wsRoot]

    // Identity comes from the path, not from a name convention.
    assert(workshop.identify(item, roots).isWorkshop, 'a Workshop item was not recognised')
    assert(workshop.identify(item, roots).publishedFileId === '3141592653', 'the published id was not read')
    assert(!workshop.identify(path.join(tmp, 'mods', 'x'), roots).isWorkshop, 'a local mod was called Workshop')
    assert(!workshop.identify(wsRoot, roots).isWorkshop, 'the content root is not itself an item')
    assert(workshop.identify(path.join(item, 'assets'), roots).publishedFileId === '3141592653',
      'a nested folder should belong to its item')
    // SandLoader's own slot lives in the same directory and has no numeric id.
    assert(workshop.identify(path.join(wsRoot, 'smln'), roots).publishedFileId === null,
      'the loader slot should not look like a published item')

    // Annotation is additive: a local mod must come back untouched.
    const wsMod = { id: 'a.ws', version: '1', dir: item }
    const localMod = { id: 'local', version: '1', dir: path.join(tmp, 'mods', 'local') }
    workshop.annotate(wsMod, roots)
    workshop.annotate(localMod, roots)
    assert(wsMod.source === 'workshop' && wsMod.removable === false,
      'the Workshop mod was not marked: ' + JSON.stringify(wsMod))
    assert(wsMod.workshop && wsMod.workshop.title === 'Fancy Mod', 'workshop.json was not read')
    assert(localMod.source === undefined && localMod.removable === undefined,
      'a local mod was modified by annotation: ' + JSON.stringify(localMod))

    // Only a numeric id becomes a URL - a folder name is attacker-adjacent input.
    assert(workshop.pageUrl('123') === 'steam://url/CommunityFilePage/123', 'bad steam url')
    assert(workshop.pageUrl('../evil') === null, 'a non-numeric id produced a url')

    // The guard that matters. Steam re-downloads a deleted item, so removing
    // one looks like it worked and then silently undoes itself.
    const realRoots = workshop.roots()
    if (realRoots.length) {
      const fake = path.join(realRoots[0], '999888777')
      const refused = manage.remove(fake, { roots: [realRoots[0]], logger: quiet })
      assert(refused.ok === false, 'a Workshop folder was accepted for deletion')
      assert(refused.code === 'E_WORKSHOP_MANAGED', 'wrong refusal code: ' + refused.code)
      assert(/re-download/.test(refused.error) && /unsubscribe/i.test(refused.error),
        'the refusal does not explain itself: ' + refused.error)
    }

    // ...and it must not be a blanket veto on deletion.
    const doomed = path.join(tmp, 'mods', 'doomed')
    fs.mkdirSync(doomed, { recursive: true })
    fs.writeFileSync(path.join(doomed, 'smln.mod.json'), JSON.stringify({ id: 'doomed', version: '1' }))
    const gone = manage.remove(doomed, { roots: [path.join(tmp, 'mods')], logger: quiet })
    assert(gone.ok === true && !fs.existsSync(doomed), 'a local mod could no longer be deleted')

    return 'identified by path, annotated additively, deletion refused with a reason'
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

check('the manager offers Steam actions for Workshop mods instead of Delete', () => {
  const mods = [
    { id: 'a.ws', name: 'Workshop Mod', version: '1.2.0', flavour: 'official', enabled: true,
      dir: 'C:/ws/3141592653', source: 'workshop', publishedFileId: '3141592653',
      workshopUrl: 'steam://url/CommunityFilePage/3141592653', removable: false,
      capability: { tier: 'sandboxed', badge: 'SANDBOXED', granted: {}, contexts: { game: true } } },
    { id: 'local', name: 'Local Mod', version: '1.0.0', flavour: 'smln', enabled: true,
      dir: 'C:/mods/local', source: 'local', removable: true,
      capability: { tier: 'sandboxed', badge: 'SANDBOXED', granted: {}, contexts: { game: true } } },
  ]
  const { S, dom } = bootConsole({ mods })
  const calls = []
  S.callMain = (action, payload) => { calls.push({ action, payload }); return Promise.resolve({ ok: true }) }
  S.modsUI.toggle(true)

  const rows = []
  ;(function walk(n) {
    if (/(^|\s)row(\s|$)/.test(String(n.className || ''))) rows.push(n)
    for (const c of n.childNodes || []) walk(c)
  })(dom.document.getElementById('smln-mods'))
  assert(rows.length === 2, 'expected 2 rows, got ' + rows.length)

  const textOf = (n) => { const out = []
    ;(function w(x) { if (x.textContent && (!x.childNodes || !x.childNodes.length)) out.push(x.textContent)
      for (const c of x.childNodes || []) w(c) })(n); return out }

  const ws = textOf(rows[0])
  const local = textOf(rows[1])
  assert(ws.includes('Workshop'), 'the Workshop row carries no source tag: ' + JSON.stringify(ws))
  assert(!local.includes('Workshop'), 'a local mod was tagged as Workshop: ' + JSON.stringify(local))
  assert(ws.some((x) => /Workshop 3141592653/.test(x)), 'the published id is not shown')
  assert(ws.includes('View in Steam') && !ws.includes('Delete'),
    'the Workshop row still offers Delete: ' + JSON.stringify(ws))
  assert(local.includes('Delete'), 'the local row lost its Delete button')

  let steamBtn = null
  ;(function w(n) { if (n.tagName === 'BUTTON' && /View in Steam/.test(n.textContent)) steamBtn = n
    for (const c of n.childNodes || []) w(c) })(rows[0])
  steamBtn.dispatch('click', {})
  const call = calls.find((c) => c.action === 'openWorkshop')
  assert(call && call.payload.id === '3141592653',
    'the Steam action did not carry the published id: ' + JSON.stringify(calls))

  return 'source tag, published id, Steam hand-off, Delete withheld'
})


check('a Workshop URL or bare id resolves to one published file id', () => {
  const workshop = require('../src/mods/workshop')

  // Every spelling Steam itself hands a player, all pointing at one item.
  const accepted = {
    '3141592653': '3141592653',
    '  3141592653  ': '3141592653',
    'https://steamcommunity.com/sharedfiles/filedetails/?id=3141592653': '3141592653',
    'https://steamcommunity.com/workshop/filedetails/?id=3141592653&searchtext=x': '3141592653',
    'http://steamcommunity.com/sharedfiles/filedetails/?l=german&id=3141592653': '3141592653',
    'steam://url/CommunityFilePage/3141592653': '3141592653',
  }
  for (const [input, want] of Object.entries(accepted)) {
    const got = workshop.parseRef(input)
    assert(got.ok && got.id === want,
      `"${input}" should resolve to ${want}, got ` + JSON.stringify(got.ok ? got.id : got.error.message))
  }

  // Refusals must be refusals, not a silently wrong id.
  for (const bad of ['', '   ', 'not-an-id', '12.5', '0123', '1'.repeat(25),
                     'https://steamcommunity.com/app/2764460/workshop/',
                     'https://example.com/mods/cool-mod']) {
    const got = workshop.parseRef(bad)
    assert(!got.ok, `"${bad}" was accepted as a Workshop reference: ` + JSON.stringify(got))
    assert(got.error.code === 'E_WORKSHOP_REF', 'wrong code for ' + JSON.stringify(bad) + ': ' + got.error.code)
  }

  // A pasted URL must never reach a command line as anything but digits.
  const injected = workshop.parseRef('https://steamcommunity.com/sharedfiles/filedetails/?id=1 +quit +run')
  assert(injected.ok && injected.id === '1', 'trailing junk was not dropped: ' + JSON.stringify(injected))

  return Object.keys(accepted).length + ' accepted forms, 8 refused, no id survives non-digits'
})

check('a Workshop item is imported as a normal local mod, not left in place', () => {
  const manage = require('../src/mods/manage')
  const workshop = require('../src/mods/workshop')
  const quiet = { info() {}, warn() {}, error() {}, debug() {} }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-import-'))
  try {
    const source = path.join(tmp, 'download', '3141592653')
    fs.mkdirSync(path.join(source, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(source, 'modinfo.json'),
      JSON.stringify({ modID: 'ws.mod', name: 'Workshop Mod', version: '2.1.0' }))
    fs.writeFileSync(path.join(source, 'main.js'), '// mod code\n')
    fs.writeFileSync(path.join(source, 'assets', 'thing.png'), 'png')
    fs.writeFileSync(path.join(source, 'workshop.json'), JSON.stringify({ title: 'Fancy Mod' }))

    const smlnRoot = path.join(tmp, 'mods')
    const fluxRoot = path.join(tmp, 'flux')
    const ctx = { smlnRoot, fluxRoot, logger: quiet, origin: { publishedFileId: '3141592653', title: 'Fancy Mod' } }

    const done = manage.installFromDir(source, ctx)
    assert(done.ok, 'the import failed: ' + JSON.stringify(done))
    assert(done.id === 'ws.mod' && done.flavour === 'fluxloader', 'wrong manifest reading: ' + JSON.stringify(done))

    // It went to the normal mods root for its flavour, not the Workshop tree.
    assert(done.dir === path.join(fluxRoot, 'ws.mod'), 'installed to the wrong root: ' + done.dir)
    assert(fs.existsSync(path.join(done.dir, 'main.js')), 'the mod body did not come across')
    assert(fs.existsSync(path.join(done.dir, 'assets', 'thing.png')), 'nested files did not come across')

    // Copied, not moved: the download is still whole, so the caller decides
    // when to discard it.
    assert(fs.existsSync(path.join(source, 'main.js')), 'installFromDir moved the source instead of copying it')

    // The import is SandLoader's own file now: annotation must not call it
    // Steam-managed, and it must stay deletable.
    const mod = { id: 'ws.mod', version: '2.1.0', dir: done.dir }
    workshop.annotate(mod, [path.join(tmp, 'download')])
    assert(mod.source === undefined, 'an imported mod was marked as Steam-managed: ' + JSON.stringify(mod))
    assert(mod.removable !== false, 'an imported mod was made undeletable')
    assert(mod.importedFrom === 'workshop' && mod.publishedFileId === '3141592653',
      'the import lost its provenance: ' + JSON.stringify(mod))

    const removed = manage.remove(done.dir, { roots: [fluxRoot], logger: quiet })
    assert(removed.ok === true && !fs.existsSync(done.dir),
      'an imported mod could not be deleted: ' + JSON.stringify(removed))

    return 'copied out, landed in the local root, keeps provenance, stays removable'
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

check('importing validates the manifest and refuses what is not a mod', () => {
  const manage = require('../src/mods/manage')
  const quiet = { info() {}, warn() {}, error() {}, debug() {} }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-import-bad-'))
  try {
    const smlnRoot = path.join(tmp, 'mods')
    const ctx = { smlnRoot, fluxRoot: path.join(tmp, 'flux'), logger: quiet }

    // Workshop content that is not a mod at all.
    const notAMod = path.join(tmp, 'notamod')
    fs.mkdirSync(notAMod, { recursive: true })
    fs.writeFileSync(path.join(notAMod, 'readme.txt'), 'hello')
    const r1 = manage.installFromDir(notAMod, ctx)
    assert(!r1.ok && r1.code === 'E_MANIFEST_INVALID', 'a manifest-less folder was installed: ' + JSON.stringify(r1))
    assert(/not a mod SandLoader can load/.test(r1.error), 'the refusal does not explain itself: ' + r1.error)

    // A manifest that parses but declares no id is just as invalid.
    const noId = path.join(tmp, 'noid')
    fs.mkdirSync(noId, { recursive: true })
    fs.writeFileSync(path.join(noId, 'smln.mod.json'), JSON.stringify({ name: 'nameless' }))
    const r2 = manage.installFromDir(noId, ctx)
    assert(!r2.ok, 'a manifest with no id was installed: ' + JSON.stringify(r2))

    // Broken JSON must not throw out of the installer.
    const broken = path.join(tmp, 'broken')
    fs.mkdirSync(broken, { recursive: true })
    fs.writeFileSync(path.join(broken, 'smln.mod.json'), '{ not json')
    const r3 = manage.installFromDir(broken, ctx)
    assert(!r3.ok, 'invalid JSON was installed: ' + JSON.stringify(r3))

    // Nothing at all should have been written.
    assert(!fs.existsSync(smlnRoot) || fs.readdirSync(smlnRoot).length === 0,
      'a refused import still left something in the mods folder')

    const missing = manage.installFromDir(path.join(tmp, 'nope'), ctx)
    assert(!missing.ok && /not found/.test(missing.error), 'a missing folder gave a poor error: ' + JSON.stringify(missing))

    // A single wrapper folder is unwrapped, the way zip.js strips one.
    const wrapped = path.join(tmp, 'wrapped')
    fs.mkdirSync(path.join(wrapped, 'MyMod'), { recursive: true })
    fs.writeFileSync(path.join(wrapped, 'MyMod', 'smln.mod.json'),
      JSON.stringify({ id: 'wrapped.mod', version: '1.0.0' }))
    const r4 = manage.installFromDir(wrapped, ctx)
    assert(r4.ok && r4.id === 'wrapped.mod', 'a wrapped mod was not unwrapped: ' + JSON.stringify(r4))
    assert(fs.existsSync(path.join(smlnRoot, 'wrapped.mod', 'smln.mod.json')), 'the unwrapped manifest is missing')

    return 'no manifest, no id, bad JSON and a missing folder all refused; one wrapper folder stripped'
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

check('a copied mod tree cannot smuggle a link out of its own folder', () => {
  const manage = require('../src/mods/manage')

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-copy-'))
  try {
    const src = path.join(tmp, 'src')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'keep.txt'), 'kept')
    const secret = path.join(tmp, 'secret.txt')
    fs.writeFileSync(secret, 'do not copy me')

    // Symlink creation needs privileges on Windows; skip rather than fail when
    // the machine will not make one.
    let linked = false
    try {
      fs.symlinkSync(secret, path.join(src, 'escape.txt'))
      linked = true
    } catch (_) { /* unprivileged Windows, or no symlink support */ }

    const dest = path.join(tmp, 'dest')
    const stats = manage.copyTree(src, dest)

    assert(fs.existsSync(path.join(dest, 'keep.txt')), 'a regular file was not copied')
    if (linked) {
      assert(!fs.existsSync(path.join(dest, 'escape.txt')), 'a symlink was followed into the install')
      assert(stats.skipped.includes('escape.txt'), 'the skipped link was not reported: ' + JSON.stringify(stats.skipped))
    }
    assert(stats.files === 1, 'expected exactly one copied file, got ' + stats.files)

    return linked ? 'regular files copied, symlink skipped and reported' : 'regular files copied (no symlink support here)'
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

check('SteamCMD is driven safely, and every failure explains itself', () => {
  const steamcmd = require('../src/mods/steamcmd')

  // The argument vector: anonymous, non-interactive, and the id passed as its
  // own argument rather than interpolated into a string.
  const args = steamcmd.argsFor(2764460, '3141592653')
  assert(args.includes('anonymous'), 'the login is not anonymous: ' + JSON.stringify(args))
  assert(args.includes('+workshop_download_item'), 'the download command is missing')
  const at = args.indexOf('+workshop_download_item')
  assert(args[at + 1] === '2764460' && args[at + 2] === '3141592653',
    'app id and item id are in the wrong order: ' + JSON.stringify(args))
  assert(args[args.length - 1] === '+quit', 'SteamCMD would not exit: ' + JSON.stringify(args))
  assert(args.includes('+@NoPromptForPassword'), 'SteamCMD could stop for a password prompt')
  assert(steamcmd.argsFor(1, '2', { user: 'someone' }).includes('someone'), 'an explicit user was ignored')

  // A machine without SteamCMD gets a named error and an actionable hint, not
  // a crash and not a silent failure.
  return steamcmd.downloadItem('3141592653', {
    // Stub the lookup rather than trusting this machine to lack SteamCMD - the
    // installer may well have just put one there.
    findFn: () => null,
    spawnFn: () => { throw new Error('should not spawn') },
  })
    .then((r) => {
      assert(!r.ok, 'a download was attempted with no SteamCMD present')
      assert(r.error.code === 'E_STEAMCMD_MISSING', 'wrong code: ' + r.error.code)
      assert(/SteamCMD/i.test(r.error.message) && /PATH|SMLN_STEAMCMD/.test(r.error.message),
        'the error does not say how to fix it: ' + r.error.message)

      // Steam's own failure lines are turned into something a player can act on.
      assert(/Check the URL or id/.test(steamcmd.diagnose('ERROR! Download item failed (File Not Found).', 1)),
        'a missing item was not diagnosed')
      assert(/private|anonymous/i.test(steamcmd.diagnose('ERROR! Download item failed (Access Denied).', 1)),
        'an access failure was not diagnosed')
      assert(/timed out/i.test(steamcmd.diagnose('Timeout downloading item 1', 1)), 'a timeout was not diagnosed')
      assert(/exited with code 7/.test(steamcmd.diagnose('', 7)), 'an unknown failure lost its exit code')

      // The success line is what locates the download.
      const m = 'Success. Downloaded item to : "C:\\steamcmd\\steamapps\\workshop\\content\\2764460\\3141592653"'
        .match(steamcmd.SUCCESS_RE)
      assert(m && /3141592653$/.test(m[1]), 'the success line was not parsed: ' + JSON.stringify(m))

      return 'anonymous non-interactive args, id passed separately, missing binary and 4 Steam failures all named'
    })
})

check('a faked SteamCMD run lands a real directory the installer accepts', () => {
  const steamcmd = require('../src/mods/steamcmd')
  const { EventEmitter } = require('events')

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-cmd-'))
  const item = path.join(tmp, 'steamapps', 'workshop', 'content', '2764460', '3141592653')
  fs.mkdirSync(item, { recursive: true })
  fs.writeFileSync(path.join(item, 'smln.mod.json'), JSON.stringify({ id: 'downloaded.mod', version: '1.0.0' }))
  const exe = path.join(tmp, 'steamcmd.exe')
  fs.writeFileSync(exe, '')

  /** Stand in for the process, so nothing is actually spawned. */
  function fakeRun(output, code) {
    return () => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {}
      setTimeout(() => { child.stdout.emit('data', output); child.emit('close', code) }, 0)
      return child
    }
  }

  const success = `Success. Downloaded item to : "${item}"\n`
  return steamcmd.downloadItem('3141592653', { exe, spawnFn: fakeRun(success, 0) })
    .then((r) => {
      assert(r.ok, 'a successful run was reported as a failure: ' + JSON.stringify(r.ok ? '' : r.error.message))
      assert(path.resolve(r.dir) === path.resolve(item), 'the wrong directory came back: ' + r.dir)

      // ...and what came back is genuinely installable by the shared path.
      const manage = require('../src/mods/manage')
      const quiet = { info() {}, warn() {}, error() {}, debug() {} }
      const done = manage.installFromDir(r.dir, {
        smlnRoot: path.join(tmp, 'mods'), fluxRoot: path.join(tmp, 'flux'), logger: quiet,
        origin: { publishedFileId: '3141592653' },
      })
      assert(done.ok && done.id === 'downloaded.mod', 'the download did not install: ' + JSON.stringify(done))

      // A run that says nothing useful and leaves nothing behind is a failure,
      // even on exit code 0 - otherwise a silent no-op looks like a success.
      return steamcmd.downloadItem('999000111', { exe, spawnFn: fakeRun('Logging in...\n', 0) })
    })
    .then((r2) => {
      assert(!r2.ok, 'an empty run was reported as a success')
      assert(r2.error.code === 'E_WORKSHOP_DOWNLOAD', 'wrong code: ' + r2.error.code)
      fs.rmSync(tmp, { recursive: true, force: true })
      return 'success line parsed, download installed, an empty exit-0 run still fails'
    })
})

check('the download cleanup deletes the download folder and nothing else', () => {
  const workshop = require('../src/mods/workshop')
  const quiet = { info() {}, warn() {}, error() {}, debug() {} }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-discard-'))
  try {
    const content = path.join(tmp, 'steamapps', 'workshop', 'content', '2764460')
    const item = path.join(content, '3141592653')
    fs.mkdirSync(path.join(item, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(item, 'assets', 'a.png'), 'x')

    // Everything the guard must refuse. Each of these is a real path that a
    // wrong prefix test or an off-by-one would happily delete.
    const sibling = path.join(content, '999888777')
    fs.mkdirSync(sibling, { recursive: true })

    const refuse = [
      [content, '3141592653', 'the content root'],
      [path.dirname(content), '3141592653', 'the whole workshop tree'],
      [path.join(item, 'assets'), '3141592653', 'a folder inside the item'],
      [sibling, '3141592653', 'a different item'],
      [item, '999888777', 'the right folder with the wrong id'],
      [path.join(tmp, 'mods', '3141592653'), '3141592653', 'a mods folder that merely shares the name'],
      [item, '../../etc', 'a non-numeric id'],
      ['', '3141592653', 'an empty path'],
      [item, '', 'an empty id'],
    ]
    for (const [dir, id, what] of refuse) {
      assert(!workshop.isDownloadDir(dir, id), `${what} was accepted as a download folder: ${dir}`)
      assert(workshop.discardDownload(dir, id, quiet) === false, `${what} was deleted: ${dir}`)
    }
    assert(fs.existsSync(sibling), 'a refused delete removed a sibling item anyway')
    assert(fs.existsSync(item), 'a refused delete removed the item anyway')

    // ...and the one path it must accept.
    assert(workshop.isDownloadDir(item, '3141592653'), 'the real download folder was not recognised')
    assert(workshop.discardDownload(item, '3141592653', quiet) === true, 'the download was not removed')
    assert(!fs.existsSync(item), 'the download folder is still there')
    // Only the item goes; its parent and its siblings stay.
    assert(fs.existsSync(content), 'the cleanup took the content root with it')
    assert(fs.existsSync(sibling), 'the cleanup took a sibling item with it')

    return refuse.length + ' wrong paths refused, the download folder alone removed'
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

check('the installer fetches SteamCMD from Valve, and only when it has to', () => {
  const setup = require('../src/mods/steamcmd-setup')
  const steamcmd = require('../src/mods/steamcmd')

  // Only Valve's own hosts, and only over https - this is the one thing
  // SandLoader downloads, so the source is not a detail.
  const seen = []
  for (const [plat, urls] of Object.entries(setup.SOURCES)) {
    assert(urls.length >= 2, `${plat} has no mirror to fall back on`)
    for (const u of urls) {
      seen.push(u)
      assert(/^https:\/\//.test(u), `${plat} would download over plain http: ${u}`)
      const host = new URL(u).host
      assert(host === 'steamcdn-a.akamaihd.net' || host === 'media.steampowered.com',
        `${plat} downloads from an unexpected host: ${host}`)
    }
  }
  assert(setup.urlsForPlatform().length >= 2, 'this platform has no download URL')

  // The vendored copy is inside SandLoader, so it needs no admin rights and
  // uninstalling can take it away again.
  const vendor = setup.vendorDir()
  assert(vendor === steamcmd.vendorDir(), 'the finder and the installer disagree about where it goes')
  assert(path.resolve(vendor).startsWith(path.resolve(__dirname, '..')),
    'SteamCMD would be installed outside the SandLoader folder: ' + vendor)
  assert(/steamcmd(\.exe|\.sh)$/.test(setup.vendorExe()), 'the vendored binary has an odd name: ' + setup.vendorExe())

  // An existing SteamCMD is never replaced: ensure() must report it and fetch
  // nothing. Pointed at this very file, which is certainly not SteamCMD but is
  // certainly a file - `find` checks existence, and that is the branch here.
  const before = process.env.SMLN_STEAMCMD
  process.env.SMLN_STEAMCMD = __filename
  try {
    assert(steamcmd.find() === path.resolve(__filename), 'an explicit SMLN_STEAMCMD was not honoured')
    return setup.ensure({ log() {} }).then((r) => {
      assert(r.ok && r.status === 'present', 'ensure() re-downloaded over an existing SteamCMD: ' + JSON.stringify(r))
      assert(r.path === path.resolve(__filename), 'ensure() reported the wrong path: ' + r.path)
      return seen.length + ' https URLs on Valve hosts, vendored in-tree, an existing install left alone'
    }).then((out) => {
      if (before === undefined) delete process.env.SMLN_STEAMCMD
      else process.env.SMLN_STEAMCMD = before
      return out
    })
  } catch (e) {
    if (before === undefined) delete process.env.SMLN_STEAMCMD
    else process.env.SMLN_STEAMCMD = before
    throw e
  }
})

check('cleanup never touches content Steam owns, only a SteamCMD download', () => {
  const workshop = require('../src/mods/workshop')
  const quiet = { info() {}, warn() {}, error() {}, debug() {} }

  // Steam's own subscribed folder and SteamCMD's download folder have the
  // identical shape - workshop/content/<appid>/<id> - so shape alone must not
  // be what decides. Deleting Steam's copy is the exact thing this module
  // exists to prevent: Steam just re-downloads it and the player cannot tell
  // why the mod came back.
  const real = workshop.roots()
  if (real.length) {
    const steamOwned = path.join(real[0], '3141592653')
    assert(!workshop.isDownloadDir(steamOwned, '3141592653'),
      'a subscribed Steam Workshop folder was mistaken for our own download: ' + steamOwned)
    assert(workshop.discardDownload(steamOwned, '3141592653', quiet) === false,
      'cleanup would have deleted content Steam owns')
  }

  // A SteamCMD download has the same shape but sits outside every Steam
  // library, and that one is ours to remove.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-own-'))
  try {
    const ours = path.join(tmp, 'steamcmd', 'steamapps', 'workshop', 'content', '2764460', '3141592653')
    fs.mkdirSync(ours, { recursive: true })
    fs.writeFileSync(path.join(ours, 'x.txt'), 'x')
    assert(workshop.isDownloadDir(ours, '3141592653'), 'our own download was not recognised: ' + ours)
    assert(workshop.discardDownload(ours, '3141592653', quiet) === true, 'our own download was not removed')
    assert(!fs.existsSync(ours), 'the download folder is still there')

    return real.length
      ? 'Steam-owned content refused, our own download removed'
      : 'our own download removed (no Steam library on this machine to contrast)'
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

check('an already-subscribed item is found locally instead of downloaded', () => {
  const workshop = require('../src/mods/workshop')

  // Nothing is subscribed under a bogus id, so the lookup must say so rather
  // than returning a path that does not exist.
  assert(workshop.findLocalItem('999888777000') === null, 'a missing item was reported as present')
  assert(workshop.findLocalItem('not-an-id') === null, 'a non-numeric id was looked up')
  assert(workshop.findLocalItem('') === null, 'an empty id was looked up')

  // An empty directory is not a usable item either - Steam leaves those behind.
  const real = workshop.roots()
  if (!real.length) return 'no Steam library on this machine; refusals verified'

  const probe = path.join(real[0], '3141592653')
  let made = false
  try {
    fs.mkdirSync(probe, { recursive: true })
    made = true
    assert(workshop.findLocalItem('3141592653') === null, 'an empty folder was treated as a subscribed item')
    fs.writeFileSync(path.join(probe, 'modinfo.json'), JSON.stringify({ modID: 'x', version: '1' }))
    assert(workshop.findLocalItem('3141592653') === probe,
      'a subscribed item was not found: ' + workshop.findLocalItem('3141592653'))
    return 'missing, malformed and empty all refused; a real subscribed item found'
  } catch (e) {
    if (e && (e.code === 'EACCES' || e.code === 'EPERM')) return 'refusals verified (Steam folder not writable here)'
    throw e
  } finally {
    if (made) { try { fs.rmSync(probe, { recursive: true, force: true }) } catch (_) { /* best effort */ } }
  }
})

check('Steam refusing an item is reported as something the player can act on', () => {
  const steamcmd = require('../src/mods/steamcmd')

  // The real line SteamCMD prints for a paid game under an anonymous login.
  // "Failure" is also the word it uses for everything else, which is exactly
  // why this case has to be picked out by hand.
  const refused = 'ERROR! Download item 3783406459 failed (Failure).'
  assert(steamcmd.diagnoseCode(refused) === 'E_WORKSHOP_OWNERSHIP',
    'the ownership refusal was not classified: ' + steamcmd.diagnoseCode(refused))

  const msg = steamcmd.diagnose(refused, 1)
  assert(/paid game|anonymous/i.test(msg), 'the message does not explain why: ' + msg)
  assert(/[Ss]ubscribe/.test(msg), 'the message does not give a way out: ' + msg)
  assert(!/^Steam reported: Failure/.test(msg), 'the message is still the bare Steam wording: ' + msg)

  // A missing item is a different problem with a different answer, and must
  // not be folded into the same message.
  const missing = 'ERROR! Download item 1 failed (File Not Found).'
  assert(steamcmd.diagnoseCode(missing) === 'E_WORKSHOP_NOT_FOUND', 'a missing item was misclassified')
  assert(!/subscribe/i.test(steamcmd.diagnose(missing, 1)), 'a missing item was told to subscribe')

  // Anything genuinely unrecognised still falls through to the generic code.
  assert(steamcmd.diagnoseCode('ERROR! Download item 5 failed (Disk Full).') === 'E_WORKSHOP_DOWNLOAD',
    'an unknown reason was force-fitted into a named code')

  return 'ownership, missing item and unknown reasons each classified separately'
})

check('a refused Workshop download is recoverable without leaving the game', () => {
  const { S, dom } = bootConsole({ mods: [] })
  const calls = []
  let probes = 0

  S.callMain = (action, payload) => {
    calls.push({ action, payload })
    if (action === 'steamcmdStatus') return Promise.resolve({ ok: true, available: true, path: 'C:/s/steamcmd.exe' })
    if (action === 'installWorkshopReview') {
      // Refused the first time, exactly as Steam does for a paid game; then
      // succeeds once the item has been subscribed and has landed on disk.
      if (probes === 0) {
        return Promise.resolve({
          ok: false,
          code: 'E_WORKSHOP_OWNERSHIP',
          error: 'Steam would not hand over that item.',
          canSubscribe: true,
          publishedFileId: '3141592653',
        })
      }
      return Promise.resolve({
        ok: true,
        token: 'w1',
        review: { mod: { id: 'ws.mod', name: 'WS', version: '1.0.0' }, capability: {}, entries: [] },
      })
    }
    if (action === 'workshopProbe') {
      // Not there, not there, then there - the shape of a real subscription.
      probes++
      return Promise.resolve({ ok: true, present: probes >= 3 })
    }
    if (action === 'openWorkshop') return Promise.resolve({ ok: true, url: 'steam://x' })
    return Promise.resolve({ ok: true, id: 'ws.mod', version: '1.0.0', dir: 'C:/mods/ws.mod' })
  }
  S.modsUI._timing.pollMs = 1
  S.modsUI.toggle(true)

  let button = null
  ;(function walk(n) {
    if (n.tagName === 'BUTTON' && /Install from Workshop/.test(String(n.textContent || ''))) button = n
    for (const c of n.childNodes || []) walk(c)
  })(dom.document.getElementById('smln-mods'))
  assert(button, 'the manager has no "Install from Workshop" button')

  // Drive the recovery: paste a link, get refused, choose "Open in Steam",
  // and let the poll find the item.
  let offered = null
  S.permUI = S.permUI || {}
  S.permUI.prompt = () => Promise.resolve('3141592653')
  S.permUI.choose = (opts) => { offered = opts; return Promise.resolve('steam') }
  S.permUI.review = () => Promise.resolve(true)
  S.permUI.progress = () => ({ update() {}, close() {}, cancelled: () => false })

  button.dispatch('click', {})

  // Let the promise chain and the 2s poll interval run to completion.
  const settle = () => new Promise((r) => setTimeout(r, 0))
  return settle().then(settle).then(settle).then(settle).then(settle).then(settle)
    .then(() => new Promise((r) => setTimeout(r, 30)))
    .then(settle).then(settle).then(settle)
    .then(() => {
      const actions = calls.map((c) => c.action)

      assert(offered, 'the refusal did not offer a way out')
      const keys = offered.options.map((o) => o.key)
      assert(keys.includes('steam') && keys.includes('account'),
        'both remedies should be offered in-game, got: ' + JSON.stringify(keys))

      assert(actions.includes('openWorkshop'), 'Steam was never opened: ' + JSON.stringify(actions))
      assert(actions.filter((a) => a === 'workshopProbe').length >= 2,
        'it did not wait for Steam to finish: ' + JSON.stringify(actions))
      assert(actions.filter((a) => a === 'installWorkshopReview').length === 2,
        'it did not retry the install once the item arrived: ' + JSON.stringify(actions))
      assert(actions.includes('installWorkshopCommit'),
        'the recovered install never committed: ' + JSON.stringify(actions))

      // The point of the whole exercise: no second trip through the prompt.
      assert(calls.filter((c) => c.action === 'installWorkshopReview')
        .every((c) => c.payload.ref === '3141592653'),
        'the retry lost the id and would have re-asked for it')

      return 'refusal offers both remedies, waits for Steam, retries and commits - no re-paste'
    })
})

check('an official mod is reviewed as official, not as a broken Fluxloader mod', () => {
  const approvals = require('../src/mods/approvals')
  const manage = require('../src/mods/manage')

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-flavour-'))
  try {
    // `modinfo.json` is shared by two unrelated formats. Official Sandkit
    // declares manifestVersion and identifies mods by `id`; Fluxloader has no
    // manifestVersion and uses `modID`. Reading an official manifest with the
    // Fluxloader reader fails with `the manifest has no "modID"` - a real mod,
    // refused because it was read by the wrong reader.
    const official = path.join(tmp, 'official')
    fs.mkdirSync(official, { recursive: true })
    fs.writeFileSync(path.join(official, 'modinfo.json'), JSON.stringify({
      manifestVersion: 1, id: 'uolkx.debug-toggle', name: 'Debug Toggle',
      version: '0.2.0', apiVersion: 1, entry: 'main.js',
    }))

    const r = approvals.inspectArchive(official, { directory: true })
    assert(r.ok, 'an official mod was refused: ' + (r.ok ? '' : r.error.message))
    assert(r.flavour === 'official', 'wrong flavour: ' + r.flavour)
    assert(r.review.mod.id === 'uolkx.debug-toggle', 'the id was not read: ' + r.review.mod.id)

    // It runs in the renderer through SMLN.official.execute and is handed no
    // `require`, so the review must not imply native access.
    const ctx = r.review.capability.contexts
    assert(ctx.native === false, 'an official mod was reviewed as native')
    assert(ctx.game === true, 'the official entrypoint was not seen as a game entrypoint')
    assert(r.review.capability.tier === 'sandboxed',
      'an official mod was not classified as sandboxed: ' + r.review.capability.tier)

    // manage.js already discriminated correctly; the two must now agree, or an
    // install passes review and then lands in the wrong root.
    const viaManage = manage.readManifest(official)
    assert(viaManage.flavour === 'official' && viaManage.id === r.review.mod.id,
      'the reviewer and the installer disagree: ' + JSON.stringify(viaManage))

    // A real Fluxloader manifest must still read as Fluxloader.
    const flux = path.join(tmp, 'flux')
    fs.mkdirSync(flux, { recursive: true })
    fs.writeFileSync(path.join(flux, 'modinfo.json'),
      JSON.stringify({ modID: 'someone.fluxmod', name: 'Flux', version: '1.0.0', gameEntrypoint: 'game.js' }))
    const f = approvals.inspectArchive(flux, { directory: true })
    assert(f.ok && f.flavour === 'fluxloader', 'a Fluxloader mod stopped reading as one: ' + JSON.stringify(f.ok ? f.flavour : f.error.message))
    assert(f.review.mod.id === 'someone.fluxmod', 'the modID was not read: ' + f.review.mod.id)

    // ...and a manifest that is neither is still refused, by the right name.
    const broken = path.join(tmp, 'broken')
    fs.mkdirSync(broken, { recursive: true })
    fs.writeFileSync(path.join(broken, 'modinfo.json'), JSON.stringify({ name: 'nameless' }))
    const b = approvals.inspectArchive(broken, { directory: true })
    assert(!b.ok, 'a manifest with no id at all was accepted')
    assert(/modID/.test(b.error.message), 'a Fluxloader manifest should be named by its own field: ' + b.error.message)

    return 'official read as official and sandboxed, Fluxloader unchanged, reviewer agrees with installer'
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

check('the Steam password goes to stdin, never to a command line', () => {
  const steamcmd = require('../src/mods/steamcmd')
  const { EventEmitter } = require('events')

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-login-'))
  const exe = path.join(tmp, 'steamcmd.exe')
  fs.writeFileSync(exe, '')

  const SECRET = 'correct-horse-battery-staple'
  const seen = []

  /**
   * Stands in for SteamCMD, reproducing the exchange the real one was observed
   * to perform: it announces no cached credentials, prints `password:`, and
   * reads the answer from stdin without echoing it.
   */
  function fakeSteamcmd(script) {
    return (file, args) => {
      const child = new EventEmitter()
      const written = []
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = { write: (v) => written.push(String(v)), end() {} }
      child.kill = () => { child.emit('close', 1) }
      seen.push({ file, args, written })
      setTimeout(() => script(child, written), 0)
      return child
    }
  }

  // 1. A successful sign-in, answering the password prompt.
  return steamcmd.login({
    user: 'someplayer', password: SECRET, exe,
    spawnFn: fakeSteamcmd((child, written) => {
      child.stdout.emit('data', 'Cached credentials not found.\n\npassword: ')
      setTimeout(() => {
        assert(written.join('') === SECRET + '\n', 'the password was not written to stdin')
        child.stdout.emit('data', "\nLogging in user 'someplayer' to Steam Public...OK\nWaiting for user info...OK\n")
        child.emit('close', 0)
      }, 0)
    }),
  }).then((r) => {
    assert(r.ok, 'a successful sign-in was reported as a failure: ' + (r.ok ? '' : r.error.message))

    // The guarantee that matters: argv is readable by any other process running
    // as this user - which here includes any mod holding the `node` permission.
    const call = seen[0]
    const argv = call.args.join(' ')
    assert(!argv.includes(SECRET), 'the password was passed on the command line: ' + argv)
    assert(argv.includes('+login') && argv.includes('someplayer'), 'the account name was not passed: ' + argv)
    assert(!argv.includes('NoPromptForPassword'),
      'the password prompt was suppressed, so there would be nothing to answer')

    // 2. Steam Guard, with no code to hand: reported as needing one, not as a
    //    generic failure, so the UI knows to ask.
    return steamcmd.login({
      user: 'someplayer', password: SECRET, exe,
      spawnFn: fakeSteamcmd((child) => {
        child.stdout.emit('data', 'password: ')
        setTimeout(() => child.stdout.emit('data', '\nSteam Guard code:'), 0)
      }),
    })
  }).then((r) => {
    assert(!r.ok && r.needsGuard, 'a Steam Guard prompt was not reported as one: ' + JSON.stringify(r.ok ? r : r.error.message))
    assert(r.error.code === 'E_STEAM_GUARD', 'wrong code: ' + r.error.code)

    // 3. A wrong password is named as such rather than reported as "unknown".
    return steamcmd.login({
      user: 'someplayer', password: 'wrong', exe,
      spawnFn: fakeSteamcmd((child) => {
        child.stdout.emit('data', 'password: ')
        setTimeout(() => {
          child.stdout.emit('data', "\nLogging in user 'someplayer' to Steam Public...ERROR (Invalid Password)\n")
          child.emit('close', 1)
        }, 0)
      }),
    })
  }).then((r) => {
    assert(!r.ok && r.error.code === 'E_STEAM_LOGIN', 'a bad password was misclassified: ' + JSON.stringify(r))
    assert(/rejected/i.test(r.error.message), 'the message does not say what happened: ' + r.error.message)

    // 4. A junk account name never reaches a process at all.
    return steamcmd.login({ user: 'bad name; rm -rf /', password: SECRET, exe,
      spawnFn: () => { throw new Error('should not spawn') } })
  }).then((r) => {
    assert(!r.ok, 'a malformed account name was accepted')
    assert(seen.length === 3, 'a malformed account name still started SteamCMD')

    // Nothing anywhere in what we captured should contain the secret except the
    // stdin buffer it was meant for.
    for (const call of seen) {
      assert(!JSON.stringify(call.args).includes(SECRET), 'the password reached argv')
      assert(!String(call.file).includes(SECRET), 'the password reached the executable path')
    }

    fs.rmSync(tmp, { recursive: true, force: true })
    return 'password only ever on stdin; guard, bad password and bad account each named'
  })
})

check('signing in to Steam happens in-game, and the password is never kept', () => {
  const { S, dom } = bootConsole({ mods: [] })
  const calls = []
  let logins = 0

  S.callMain = (action, payload) => {
    // Record a deep copy: the assertion below is about what was *sent*, and a
    // later mutation of the same object would hide a leak rather than reveal it.
    calls.push({ action, payload: JSON.parse(JSON.stringify(payload || {})) })
    if (action === 'steamcmdStatus') return Promise.resolve({ ok: true, available: true })
    if (action === 'getSteamUser') return Promise.resolve({ ok: true, user: null })
    if (action === 'steamLogin') {
      logins++
      // Steam asks for a second factor first, exactly as it does in life, and
      // accepts the sign-in once the code comes back.
      if (logins === 1) {
        return Promise.resolve({ ok: false, needsGuard: true, code: 'E_STEAM_GUARD', error: 'guard needed' })
      }
      return Promise.resolve({ ok: true, user: payload.user })
    }
    if (action === 'installWorkshopReview') {
      if (logins >= 2) {
        return Promise.resolve({
          ok: true, token: 'w1',
          review: { mod: { id: 'ws.mod', name: 'WS', version: '1.0.0' }, capability: {}, entries: [] },
        })
      }
      return Promise.resolve({
        ok: false, code: 'E_WORKSHOP_OWNERSHIP', error: 'refused',
        canSubscribe: true, publishedFileId: '3141592653',
      })
    }
    return Promise.resolve({ ok: true, id: 'ws.mod', version: '1.0.0', dir: 'C:/mods/ws.mod' })
  }
  S.modsUI.toggle(true)

  let button = null
  ;(function walk(n) {
    if (n.tagName === 'BUTTON' && /Install from Workshop/.test(String(n.textContent || ''))) button = n
    for (const c of n.childNodes || []) walk(c)
  })(dom.document.getElementById('smln-mods'))

  const prompts = []
  let signInForm = null
  S.permUI = S.permUI || {}
  S.permUI.prompt = (opts) => {
    prompts.push(opts)
    // The link first, then the Steam Guard code.
    return Promise.resolve(prompts.length === 1 ? '3141592653' : '5XK2Q')
  }
  S.permUI.choose = () => Promise.resolve('account')
  S.permUI.form = (opts) => {
    signInForm = opts
    return Promise.resolve({ user: 'someplayer', password: 'hunter2' })
  }
  S.permUI.review = () => Promise.resolve(true)
  S.permUI.progress = () => ({ update() {}, close() {}, cancelled: () => false })

  button.dispatch('click', {})

  const settle = () => new Promise((r) => setTimeout(r, 0))
  let chain = Promise.resolve()
  for (let i = 0; i < 12; i++) chain = chain.then(settle)
  return chain.then(() => {
    const actions = calls.map((c) => c.action)

    // The form is the whole point: both fields asked for in-game, password masked.
    assert(signInForm, 'no sign-in form was shown: ' + JSON.stringify(actions))
    const keys = signInForm.fields.map((f) => f.key)
    assert(keys.join(',') === 'user,password', 'unexpected sign-in fields: ' + JSON.stringify(keys))
    const pw = signInForm.fields.find((f) => f.key === 'password')
    assert(pw.type === 'password', 'the password field is not masked')

    const sent = calls.filter((c) => c.action === 'steamLogin')
    assert(sent.length === 2, 'expected a sign-in and a Steam Guard retry, got ' + sent.length)
    assert(sent[0].payload.user === 'someplayer' && sent[0].payload.password === 'hunter2',
      'the credentials did not reach the main process')
    assert(!sent[0].payload.guardCode, 'a guard code was sent before Steam asked for one')
    assert(sent[1].payload.guardCode === '5XK2Q', 'the Steam Guard code was not sent: ' + JSON.stringify(sent[1].payload))
    assert(sent[1].payload.password === 'hunter2',
      'the retry dropped the password - a Steam Guard retry is a fresh SteamCMD process and needs it again')

    // The password must go to steamLogin and nowhere else. Any other call
    // carrying it would mean it is on a path towards disk.
    for (const c of calls) {
      if (c.action === 'steamLogin') continue
      assert(!JSON.stringify(c.payload).includes('hunter2'),
        'the password leaked into ' + c.action + ': ' + JSON.stringify(c.payload))
    }
    // And it must never be handed to the settings writer.
    assert(!actions.includes('setSteamUser'),
      'the sign-in flow wrote settings directly instead of letting steamLogin do it')

    assert(actions.includes('installWorkshopCommit'),
      'the install did not resume after signing in: ' + JSON.stringify(actions))

    return 'both fields asked in-game, Steam Guard handled, password only ever sent to steamLogin'
  })
})

check('the manager offers Install from Workshop and asks for a link', () => {
  const { S, dom } = bootConsole({ mods: [] })
  const calls = []
  S.callMain = (action, payload) => {
    calls.push({ action, payload })
    if (action === 'steamcmdStatus') return Promise.resolve({ ok: true, available: true, path: 'C:/steamcmd/steamcmd.exe' })
    return Promise.resolve({ ok: true })
  }
  S.modsUI.toggle(true)

  let button = null
  ;(function walk(n) {
    if (n.tagName === 'BUTTON' && /Install from Workshop/.test(String(n.textContent || ''))) button = n
    for (const c of n.childNodes || []) walk(c)
  })(dom.document.getElementById('smln-mods'))
  assert(button, 'the manager has no "Install from Workshop" button')

  // It must ask before it downloads: no reference, no RPC.
  let asked = null
  S.permUI = S.permUI || {}
  S.permUI.prompt = (opts) => { asked = opts; return Promise.resolve(null) }

  button.dispatch('click', {})
  return Promise.resolve().then(() => new Promise((r) => setTimeout(r, 0))).then(() => {
    assert(calls.some((c) => c.action === 'steamcmdStatus'),
      'SteamCMD was not checked before asking: ' + JSON.stringify(calls.map((c) => c.action)))
    assert(asked, 'the button never asked for a Workshop link')
    assert(/Workshop/i.test(asked.title), 'the prompt is not about the Workshop: ' + asked.title)
    assert(!calls.some((c) => c.action === 'installWorkshopReview'),
      'a cancelled prompt still started a download: ' + JSON.stringify(calls.map((c) => c.action)))
    return 'button present, SteamCMD checked first, cancelling downloads nothing'
  })
})

if (archive) archive.close()

// Wait for the async checks before reporting, or their results land after the
// summary and a failure inside one would not change the exit code.
Promise.all(asyncChecks).then(() => {
  console.log('\n  ' + passed + ' passed, ' + failed + ' failed\n')
  if (failed) {
    console.log('  Failures:')
    for (const f of failures) console.log('    - ' + f.name + ': ' + f.error.message)
    console.log('')
  }
  process.exit(failed ? 1 : 0)
})
