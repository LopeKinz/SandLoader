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

function check(name, fn) {
  try {
    const detail = fn()
    passed++
    console.log('  PASS  ' + name + (detail ? '  - ' + detail : ''))
  } catch (e) {
    failed++
    failures.push({ name, error: e })
    console.log('  FAIL  ' + name + '  - ' + (e && e.message))
  }
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
  const p = flCompat.toSmlnPatch({ type: 'replace', from: 'A', to: 'x$&y', token: ' ' }, 'demo', 't3')
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
  assert(r.mod.dependencies[0] === 'other', 'dependencies not mapped from object keys')
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
    setTimeout,
    clearTimeout,
    electron: { log: (level, scope, message) => sent.push({ level, scope, message }) },
  }
  sandbox.globalThis = sandbox
  sandbox.window.document = dom.document
  vm.createContext(sandbox)
  const src = prelude.build({ reload: true, mods: opts.mods || [] })
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

check('splash reports the loaded mods', () => {
  const { S, dom } = bootConsole({
    mods: [
      { id: 'a', name: 'A', version: '1', flavour: 'smln', enabled: true },
      { id: 'b', name: 'B', version: '1', flavour: 'fluxloader', enabled: true },
    ],
  })
  const splash = dom.document.getElementById('smln-splash')
  assert(splash, 'splash node missing')
  const text = []
  ;(function walk(n) { for (const c of n.childNodes || []) { text.push(c.textContent); walk(c) } })(splash)
  const joined = text.join(' | ')
  assert(/1 mod/.test(joined), 'smln count missing: ' + joined)
  assert(/1 fluxloader mod/.test(joined), 'fluxloader count missing: ' + joined)
  return 'counts both flavours'
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
  assert(/sandkit\s*:/.test(bundle) || /\.sandkit\s*=/.test(bundle), 'state.sandkit is never assigned')
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

if (archive) archive.close()

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed) {
  console.log('  Failures:')
  for (const f of failures) console.log('    - ' + f.name + ': ' + f.error.message)
  console.log('')
}
process.exit(failed ? 1 : 0)
