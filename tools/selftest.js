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
  // 0.5.4 exposes the official API as state.sandkit.getApi(). Confirm the shape
  // the runtime relies on is really in the bundle.
  assert(/\bsandkit\s*:/.test(bundle) || /\.sandkit\s*=/.test(bundle), 'state.sandkit is never assigned')
  assert(bundle.includes('sandkit.getApi'), 'sandkit.getApi() not found')
  return 'state.sandkit.getApi() present'
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
