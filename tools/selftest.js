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
/*
 * How many times an async check may look before it gives up.
 *
 * A budget, not a wall-clock deadline. `check()` does not await an async check:
 * it collects the promise and keeps running every synchronous check after it,
 * and some of those compile megabytes of bundle inside `vm`. So the event loop
 * stays blocked while a deadline measured in milliseconds runs out, and the
 * check fails for something that happened nowhere near it. That is exactly how
 * the worker-runtime check started failing: nothing in it changed, the suite
 * simply grew past four seconds of synchronous work.
 *
 * Counting polls measures the thing worth measuring - did the code under test
 * get its chance and not take it - because a poll only happens when the loop is
 * free to run one.
 */
const POLL_BUDGET = 200


/**
 * A minimal but structurally valid PNG, so map tests need no image library.
 * Only the signature and the IHDR matter here - the loader reads dimensions
 * from IHDR and never decodes the pixels.
 */
function makeTinyPng(width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4)
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr[16] = 8    // bit depth
  ihdr[17] = 6    // colour type: RGBA
  return Buffer.concat([sig, ihdr])
}

/** A logger that satisfies the compat layer's interface without printing. */
function testLogger() {
  const noop = () => {}
  const l = { debug: noop, info: noop, warn: noop, error: noop }
  l.child = () => l
  return l
}

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

check('the loader-slot probe recognises a host that offers the slot', () => {
  const hostabi = require('../src/asar/hostabi')
  const withSlot = `
    if (modID === "fluxloader") { require(path.join(dir, "fluxloader.bundle.js")) }
    loader.initialize(api); loader.startManager(); loader.getAPI();
    loader.setGameWindow(w); loader.onGameStarted(); loader.closeGame();
  `
  assert(hostabi.hasLoaderSlot(withSlot) === true, 'a host with the full ABI was not recognised')
  return 'full ABI recognised'
})

check('the loader-slot probe rejects a host that dropped the slot', () => {
  const hostabi = require('../src/asar/hostabi')
  const noSlot = 'const MODDING_ENABLED = false; function createWindow() {}'
  assert(hostabi.hasLoaderSlot(noSlot) === false, '0.5.6-shaped main.js was treated as offering the slot')
  const partial = 'if (modID === "fluxloader") { } // but no startManager'
  assert(hostabi.hasLoaderSlot(partial) === false, 'a partial ABI must not count as a usable slot')
  return 'missing and partial ABI both rejected'
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

check('the maps-menu-open patch rewrites both assignment sites and still parses', () => {
  // Synthetic stand-in for the two real call sites (onActivate and the inner
  // onClick) - the same shape smln:mods-menu-open handles for the Mods
  // button, and required to resolve the same way: both rewritten, routed
  // through SMLN.mapsUI, and still valid JavaScript afterward.
  const patch = corePatches.find((p) => p.id === 'smln:maps-menu-open')
  assert(patch, 'smln:maps-menu-open is missing from corePatches')
  const src = 'a.customMapsScreen.open=!0,x();b.customMapsScreen.open=!0,y();'
  const result = engine.apply(src, [patch])
  assert(result.ok, result.error ? String(result.error) : 'apply failed')
  const sites = result.source.match(/customMapsScreen\.open=/g) || []
  assert(sites.length === 2, `expected 2 rewritten sites, found ${sites.length}: ${result.source}`)
  assert(/mapsUI/.test(result.source), 'the rewrite does not route through SMLN.mapsUI: ' + result.source)
  new vm.Script(result.source, { filename: 'maps-menu-open.js' })
  return 'both sites rewritten, routed through mapsUI, still parses'
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
check('one mod\'s stale patches cannot break the bundle or veto anyone else', () => {
  // corelib's patches assume each other: colorIdFix rewrites buffer sizing in
  // one patch and that buffer's readers in the next. On a game build where
  // only half still match, applying that half leaves the bundle internally
  // inconsistent - the game boots to a black screen. Aborting the file instead
  // would drop SandLoader's own patches. So a mod's patches for a file are one
  // atomic group: all of them land, or none do, and no other mod is affected.
  const source = 'KEEP_ME alpha BETA gamma'
  const stale = flCompat.toSmlnPatch({ type: 'replace', from: 'alpha', to: 'ALPHA' }, 'moda', 'p1')
  const alsoStale = flCompat.toSmlnPatch(
    { type: 'replace', from: 'NOT_PRESENT', to: 'x' }, 'moda', 'p2')
  const other = flCompat.toSmlnPatch({ type: 'replace', from: 'gamma', to: 'GAMMA' }, 'modb', 'p1')
  const own = { id: 'smln:keep', owner: 'smln', description: 'loader patch',
    find: 'KEEP_ME', replace: 'KEPT', expect: 'any', required: true }

  const r = engine.apply(source, [stale, alsoStale, other, own], { logger: testLogger() })
  assert(r.ok, 'the file was aborted by a third-party mod: ' + (r.error && r.error.message))

  // moda's half-matching pair must land as a unit - meaning not at all.
  assert(!r.source.includes('ALPHA'),
    'a mod applied half of its patches, leaving the file inconsistent: ' + r.source)
  // modb is independent and still matches, so it applies.
  assert(r.source.includes('GAMMA'), 'an unrelated mod lost its patch: ' + r.source)
  // SandLoader's own patch must never be collateral damage.
  assert(r.source.includes('KEPT'), 'the loader lost its own patch: ' + r.source)
  return 'stale group skipped whole, other mod and loader unaffected'
})

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

// --------------------------------------------- fluxloader content translation
const flTranslate = require('../src/compat/flux-translate')

/** The live 0.5.5 MatterType enum, both directions, as the game exposes it. */
const LIVE_MATTER = {
  1: 'Solid', 2: 'Liquid', 3: 'Particle', 4: 'Gas',
  5: 'Static', 6: 'Slushy', 7: 'Wisp', 8: 'Powder',
  Solid: 1, Liquid: 2, Particle: 3, Gas: 4,
  Static: 5, Slushy: 6, Wisp: 7, Powder: 8,
}

check('matter type names map to the live numeric ids', () => {
  const r = flTranslate.matterTypeToNumber('Slushy', LIVE_MATTER)
  assert(r.ok, 'Slushy was rejected: ' + (r.ok ? '' : r.reason))
  assert(r.value === 6, 'Slushy mapped to ' + r.value + ', not 6')
  assert(flTranslate.matterTypeToNumber('Solid', LIVE_MATTER).value === 1, 'Solid is not 1')
  return 'Slushy -> 6, Solid -> 1'
})

check('an unmappable matter type is reported, never defaulted', () => {
  // Silently coercing to Solid would put the element in the wrong physics
  // class, which is far worse than refusing it with a reason.
  const r = flTranslate.matterTypeToNumber('Plasma', LIVE_MATTER)
  assert(!r.ok, 'an unknown matter type was accepted')
  assert(/Plasma/.test(r.reason), 'the reason does not name the bad value: ' + r.reason)
  assert(/Solid/.test(r.reason), 'the reason does not list the valid names: ' + r.reason)
  return r.reason
})

check('element name becomes the localisation key the build expects', () => {
  // 0.5.5 entries carry nameKey, not name: {nameKey:"elements|sand|name"}.
  assert(flTranslate.nameKeyFor('Trash') === 'elements|trash|name',
    'wrong key: ' + flTranslate.nameKeyFor('Trash'))
  assert(flTranslate.nameKeyFor('CompressedTrash') === 'elements|compressedTrash|name',
    'camelCase id was not preserved: ' + flTranslate.nameKeyFor('CompressedTrash'))
  return 'Trash -> elements|trash|name'
})

check('rgba colours convert to the packed metaColor integer', () => {
  const r = flTranslate.rgbaToMetaColor([88, 74, 74, 255])
  assert(r.ok, 'rejected: ' + (r.ok ? '' : r.reason))
  assert(r.value === (88 << 16) + (74 << 8) + 74, 'wrong packing: ' + r.value)
  const bad = flTranslate.rgbaToMetaColor([88, 74])
  assert(!bad.ok, 'a two-element colour was accepted')
  return 'rgba packed to ' + r.value
})

check('soil colorHSL converts to rgba', () => {
  const r = flTranslate.hslToRgba([306, 6, 37])
  assert(r.ok, 'rejected: ' + (r.ok ? '' : r.reason))
  assert(r.value.length === 4, 'expected 4 channels, got ' + r.value.length)
  assert(r.value.every((c) => c >= 0 && c <= 255), 'channel out of range: ' + r.value.join(','))
  assert(r.value[3] === 255, 'alpha should default to opaque, got ' + r.value[3])
  return 'hsl(306,6,37) -> rgba(' + r.value.join(',') + ')'
})

check('a corelib element definition translates to a 0.5.5 definition', () => {
  // This is trashelement's real first registration, copied from its source.
  const r = flTranslate.translateElement({
    id: 'Trash',
    name: 'Trash',
    colors: [[88, 74, 74, 255], [108, 74, 74, 255]],
    density: 150,
    interactsWithHoverText: ['⬇️'],
    matterType: 'Slushy',
    addToFilterList: true,
  }, LIVE_MATTER)
  assert(r.ok, 'rejected: ' + (r.ok ? '' : r.reason))
  assert(r.def.id === 'Trash', 'id lost')
  assert(r.def.matterType === 6, 'matterType is ' + r.def.matterType + ', not the numeric 6')
  assert(r.def.nameKey === 'elements|trash|name', 'nameKey is ' + r.def.nameKey)
  assert(typeof r.def.metaColor === 'number', 'metaColor is not a number')
  // Colours are stored the way the game stores them: {variants: [[r,g,b,a]]}.
  assert(r.def.colors && r.def.colors.variants.length === 2, 'colours were dropped')
  return 'Trash -> matterType 6, ' + r.def.nameKey
})

check('element colours use the shape the renderer actually reads', () => {
  // The game stores colours as {variants: [[r,g,b,a], ...]} and its draw path
  // indexes .variants directly. Sandkit's installer is a bare assignment, so a
  // flat Fluxloader array is stored as-is and spawning the element throws
  // "Cannot read properties of undefined (reading '3')" - registered but
  // unusable, which is worse than not registered.
  const r = flTranslate.translateElement({
    id: 'Trash', name: 'Trash', colors: [[88, 74, 74, 255], [108, 74, 74, 255]],
    density: 150, matterType: 'Slushy',
  }, LIVE_MATTER)
  assert(r.ok, 'rejected: ' + (r.ok ? '' : r.reason))
  assert(!Array.isArray(r.def.colors), 'colours were left as a bare array')
  assert(Array.isArray(r.def.colors.variants), 'colours have no .variants')
  assert(r.def.colors.variants.length === 2, 'a colour variant was lost')
  assert(r.def.metaColor === (88 << 16) + (74 << 8) + 74,
    'metaColor no longer derives from the first colour: ' + r.def.metaColor)

  // A mod that already uses the wrapped shape must not be double-wrapped.
  const already = flTranslate.translateElement({
    id: 'Pre', name: 'Pre', colors: { variants: [[1, 2, 3, 255]] },
    density: 10, matterType: 'Solid',
  }, LIVE_MATTER)
  assert(already.ok, 'wrapped input rejected: ' + (already.ok ? '' : already.reason))
  assert(Array.isArray(already.def.colors.variants), 'wrapped input lost its variants')
  assert(!already.def.colors.variants[0].variants, 'colours were double-wrapped')

  // Soils land in the same scheme and need the same shape.
  const soil = flTranslate.translateSoil({
    id: 'TrashSoil', name: 'Trashsoil', colorHSL: [306, 6, 37], outputElement: 'Trash',
  }, LIVE_MATTER)
  assert(soil.ok, 'soil rejected: ' + (soil.ok ? '' : soil.reason))
  assert(soil.def.colors && Array.isArray(soil.def.colors.variants),
    'soil colours are not in variants shape')
  return 'colours wrapped as {variants}, no double-wrapping, soils too'
})

check('an element with a bad matter type is refused with a reason', () => {
  const r = flTranslate.translateElement({
    id: 'Weird', name: 'Weird', colors: [[1, 2, 3, 255]], density: 10, matterType: 'Plasma',
  }, LIVE_MATTER)
  assert(!r.ok, 'a bad matterType was accepted')
  assert(/Plasma/.test(r.reason), 'reason does not name the value: ' + r.reason)
  return r.reason
})

check('an element without an id is refused', () => {
  const r = flTranslate.translateElement({ name: 'No Id', density: 1 }, LIVE_MATTER)
  assert(!r.ok, 'an element with no id was accepted')
  assert(/id/.test(r.reason), 'reason does not mention the id: ' + r.reason)
  return r.reason
})

check('a corelib soil definition translates, including its HSL colour', () => {
  // trashelement's real soil registration.
  const r = flTranslate.translateSoil({
    id: 'TrashSoil',
    name: 'Trashsoil',
    hp: 3,
    interactsWithHoverText: ['🔨💥'],
    chanceForOutput: 0.7,
    outputElement: 'Trash',
    colorHSL: [306, 6, 37],
    onlyRocketBreakable: false,
  }, LIVE_MATTER)
  assert(r.ok, 'rejected: ' + (r.ok ? '' : r.reason))
  assert(r.def.id === 'TrashSoil', 'id lost')
  assert(r.def.colors && Array.isArray(r.def.colors.variants) &&
    r.def.colors.variants[0].length === 4, 'colorHSL was not converted to rgba')
  assert(r.def.hp === 3, 'hp lost')
  assert(r.def.outputElement === 'Trash', 'outputElement lost')
  return 'TrashSoil -> rgba(' + r.def.colors.variants[0].join(',') + ')'
})

check('corelib recipe shapes translate onto the 0.5.6 categories', () => {
  const basic = flTranslate.translateRecipe('registerBasicRecipe',
    { inputTop: 'Sand', inputBottom: 'Water', outputTop: 'WetSand', outputBottom: 'WetSand' })
  assert(basic.ok, 'basic failed: ' + basic.reason)
  assert(basic.kind === 'contacts', 'basic went to ' + basic.kind)
  assert(basic.def.inputA === 'Sand' && basic.def.inputB === 'Water', 'contact inputs are wrong')
  assert(basic.def.outputA === 'WetSand' && basic.def.outputB === 'WetSand', 'contact outputs are wrong')
  assert(basic.def.orientation === 'stacked', 'Top/Bottom is positional and must map to stacked')

  // A basic recipe may omit outputBottom; the game accepts null, not undefined.
  const oneOut = flTranslate.translateRecipe('registerBasicRecipe',
    { inputTop: 'Spore', inputBottom: 'Water', outputTop: 'WetSpore' })
  assert(oneOut.ok && oneOut.def.outputB === null, 'a missing output must become null')

  const press = flTranslate.translateRecipe('registerPressRecipe',
    { input: 'BurntSlag', outputs: [['Spore', 0.5], ['Gold', 0.25]] })
  assert(press.ok, 'press failed: ' + press.reason)
  assert(press.kind === 'kineticPresses', 'press went to ' + press.kind)
  assert(press.def.minimumDownwardVelocity === 0, 'the required velocity field is missing')
  assert(press.def.outputs.length === 2, 'press outputs were dropped')
  assert(press.def.outputs[1].name === 'Gold' && press.def.outputs[1].chance === 0.25,
    'output pairs did not become {name, chance}')

  const grower = flTranslate.translateRecipe('registerGrowerRecipe',
    { input: 'WetSpore', output: 'Seed' })
  assert(grower.ok && grower.kind === 'growers', 'grower failed: ' + grower.reason)
  assert(grower.def.chance === 1, 'grower chance must default to 1')

  const shaker = flTranslate.translateRecipe('registerShakerRecipe',
    { input: 'WetSand', outputAbove: [['Slag', 1]], outputBelow: [['Gold', 0.25]] })
  assert(shaker.ok && shaker.kind === 'shakers', 'shaker failed: ' + shaker.reason)
  assert(Array.isArray(shaker.def.outputsAbove) && shaker.def.outputsAbove[0].name === 'Slag',
    'the game spells it outputsAbove, plural')
  assert(shaker.def.outputsBelow[0].chance === 0.25, 'outputsBelow lost its chance')

  return 'contacts, kineticPresses, growers and shakers all translated'
})

check('a recipe the game would reject is refused before it gets there', () => {
  assert(!flTranslate.translateRecipe('registerBasicRecipe', { inputTop: 'Sand' }).ok,
    'a contact with no second input was accepted')
  assert(!flTranslate.translateRecipe('registerPressRecipe', { input: 'X', outputs: [['Gold', 2]] }).ok,
    'a chance above 1 was accepted')
  assert(!flTranslate.translateRecipe('registerGrowerRecipe', { input: 'X' }).ok,
    'a grower with no output was accepted')
  assert(!flTranslate.translateRecipe('registerGrowerRecipe',
    { input: 'X', output: 'Y', chance: 1.5 }).ok,
    'a grower chance above 1 was accepted')
  assert(!flTranslate.translateRecipe('registerConveyorBeltIgnores', 'Water').ok,
    'an allow-list call was mistaken for a recipe')
  return 'five invalid shapes refused with reasons'
})

check('the translation is no stricter about outputs than the game is', () => {
  // Sandustry keeps two output validators. The strict one - at least one
  // output, chances totalling no more than 1 - guards only the five categories
  // corelib cannot reach. Shakers and presses take the lenient one, and being
  // strict here refused recipes the game accepts: trashelement's real shaker
  // declares 1.49 across outputAbove and the game is content with it.
  const shaker = flTranslate.translateRecipe('registerShakerRecipe',
    { input: 'Trash', outputAbove: [['Slag', 0.99], ['Gold', 0.5]] })
  assert(shaker.ok, 'a shaker totalling more than 1 was refused: ' + shaker.reason)
  assert(shaker.def.outputsAbove.length === 2, 'the outputs were not carried over')

  const press = flTranslate.translateRecipe('registerPressRecipe', { input: 'X', outputs: [] })
  assert(press.ok, 'an empty press output list was refused: ' + press.reason)
  return 'totals above 1 and empty lists both pass, as the game allows'
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

check('a library mod can include its own module files', () => {
  // corelib and the mods built on it split their code across modules/*.js and
  // pull them in with includeVMScript at entrypoint scope. Without it the very
  // first line of such a mod throws ReferenceError and the game never starts.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-inc-'))
  fs.mkdirSync(path.join(dir, 'modules'))
  fs.writeFileSync(path.join(dir, 'modinfo.json'), JSON.stringify({
    modID: 'libmod', version: '1.0.0', electronEntrypoint: 'entry.electron.js',
  }))
  fs.writeFileSync(path.join(dir, 'modules', 'thing.js'),
    'class ThingModule { hello() { return "from-module" } }')
  fs.writeFileSync(path.join(dir, 'entry.electron.js'),
    'includeVMScript("modules/thing.js");\n' +
    'log("debug", "libmod", "loaded");\n' +
    'globalThis.result = new ThingModule().hello();\n' +
    'module.exports = { probe: () => globalThis.result }')
  const r = flCompat.readMod(dir)
  assert(r.ok, 'read failed')
  const out = flCompat.loadElectronEntrypoints([r.mod], { configDir: dir }, testLogger())
  assert(out.errors.length === 0, 'entrypoint threw: ' + (out.errors[0] && out.errors[0].message))
  fs.rmSync(dir, { recursive: true, force: true })
  return 'includeVMScript + log available at entrypoint scope'
})

check('mods can declare and fire their own events', () => {
  // registerEvent/trigger/tryTrigger are how library mods expose extension
  // points to the mods that depend on them. trigger on an unregistered name is
  // a programming error and must say so; tryTrigger is the tolerant variant.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-evt-'))
  fs.writeFileSync(path.join(dir, 'modinfo.json'), JSON.stringify({
    modID: 'evtmod', version: '1.0.0', electronEntrypoint: 'entry.electron.js',
  }))
  fs.writeFileSync(path.join(dir, 'entry.electron.js'),
    'fluxloaderAPI.events.registerEvent("cl:ready");\n' +
    'globalThis.seen = [];\n' +
    'fluxloaderAPI.events.on("cl:ready", (v) => globalThis.seen.push(v));\n' +
    'fluxloaderAPI.events.trigger("cl:ready", 1);\n' +
    'fluxloaderAPI.events.tryTrigger("cl:never-registered", 2);\n' +
    'globalThis.threw = false;\n' +
    'try { fluxloaderAPI.events.trigger("cl:never-registered", 3) }\n' +
    'catch (e) { globalThis.threw = true }')
  const r = flCompat.readMod(dir)
  const out = flCompat.loadElectronEntrypoints([r.mod], { configDir: dir }, testLogger())
  assert(out.errors.length === 0, 'entrypoint threw: ' + (out.errors[0] && out.errors[0].message))
  fs.rmSync(dir, { recursive: true, force: true })
  return 'registerEvent, trigger, tryTrigger'
})

check('the shim exposes events and game state to game and worker code', () => {
  // Worker code reaches for gameInstanceState; game code for gameInstance.state.
  // Both must exist before the mod's first frame or corelib's helpers throw.
  for (const env of ['game', 'worker']) {
    const src = flCompat.environmentShim({ id: 'demo', configSchema: {} }, env)
    const sandbox = { console: { log() {}, error() {} }, self: {} }
    sandbox.globalThis = sandbox
    vm.createContext(sandbox)
    new vm.Script(src, { filename: 'shim-' + env + '.js' }).runInContext(sandbox)
    const api = sandbox.fluxloaderAPI
    assert(typeof api.events.registerEvent === 'function', env + ': no registerEvent')
    assert(typeof api.events.trigger === 'function', env + ': no trigger')
    assert(typeof api.events.tryTrigger === 'function', env + ': no tryTrigger')
    assert('gameInstanceState' in api, env + ': no gameInstanceState')
    assert(api.gameInstance && 'state' in api.gameInstance, env + ': no gameInstance.state')
  }
  return 'events + gameInstance.state in both environments'
})

check('a library mod publishes globals its dependents can see', () => {
  // Fluxloader runs every electron entrypoint in ONE shared global scope, which
  // is how a library mod exports an API: corelib sets globalThis.corelib and
  // the mods that depend on it call corelib.elements.registerElement(...) at
  // top level. Giving each mod a private globalThis silently breaks every
  // library-and-dependent pair - the dependent throws "corelib is not defined".
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-shared-'))
  const libDir = path.join(root, 'lib')
  const useDir = path.join(root, 'user')
  fs.mkdirSync(libDir); fs.mkdirSync(useDir)
  fs.writeFileSync(path.join(libDir, 'modinfo.json'), JSON.stringify({
    modID: 'lib', version: '1.0.0', electronEntrypoint: 'entry.electron.js',
  }))
  fs.writeFileSync(path.join(libDir, 'entry.electron.js'),
    'globalThis.lib = { hits: [], add(x) { this.hits.push(x) } };')
  fs.writeFileSync(path.join(useDir, 'modinfo.json'), JSON.stringify({
    modID: 'user', version: '1.0.0', dependencies: { lib: '^1.0.0' },
    electronEntrypoint: 'entry.electron.js',
  }))
  // Bare global, exactly how trashelement calls corelib.
  fs.writeFileSync(path.join(useDir, 'entry.electron.js'), 'lib.add("registered");')
  const lib = flCompat.readMod(libDir)
  const user = flCompat.readMod(useDir)
  assert(lib.ok && user.ok, 'manifests rejected')
  const out = flCompat.loadElectronEntrypoints(
    [lib.mod, user.mod], { configDir: root }, testLogger())
  assert(out.errors.length === 0, 'dependent failed: ' + (out.errors[0] && out.errors[0].message))
  fs.rmSync(root, { recursive: true, force: true })
  return 'dependent reached the library global'
})

check('fluxloader mods load dependencies before dependents', () => {
  // Discovery walks directories, so without an explicit sort the load order is
  // whatever readdir returned. A dependent that sorts before its library then
  // runs first and cannot see it - a bug that hides whenever the names happen
  // to be alphabetically favourable, as "corelib" < "trashelement" is.
  const mods = [
    { id: 'aaa', version: '1.0.0', enabled: true, priority: 100,
      dependencies: [{ id: 'zzz', range: '^1.0.0', optional: false }], dependencyIds: ['zzz'] },
    { id: 'zzz', version: '1.0.0', enabled: true, priority: 100,
      dependencies: [], dependencyIds: [] },
  ]
  const r = modLoader.resolveOrder(mods)
  const ids = r.order.map((m) => m.id)
  assert(ids.indexOf('zzz') < ids.indexOf('aaa'),
    'dependency did not sort before dependent: ' + ids.join(', '))
  return ids.join(' -> ')
})

check('a mod that depends on corelib gets its content into the game', () => {
  // The failure this guards against: trashelement calls the bare global
  // `corelib.elements.registerElement(...)`, so it needs corelib's global to
  // survive into its scope, corelib's own patches to stay attributed to
  // corelib, and its elements to end up in the text patched into the bundle.
  const coreDir = path.join(__dirname, '..', 'mods', 'corelib')
  const modDir = path.join(__dirname, '..', 'mods', 'trashelement')
  if (!fs.existsSync(coreDir) || !fs.existsSync(modDir)) return 'skipped - mods not installed'
  const core = flCompat.readMod(coreDir)
  const dep = flCompat.readMod(modDir)
  assert(core.ok && dep.ok, 'manifests rejected')
  const handlers = {}
  const out = flCompat.loadElectronEntrypoints([core.mod, dep.mod], {
    configDir: coreDir, rpc: { register: (ch, fn) => { handlers[ch] = fn } },
  }, testLogger())
  assert(out.errors.length === 0, 'load failed: ' + (out.errors[0] && out.errors[0].message))

  // Deliberately NOT emitting fl:pre-scene-loaded here. This test used to fire
  // it by hand, which is what let the real bug through: corelib registers no
  // patches from its entrypoint and defers all of them to that event, and
  // nothing in SandLoader ever emitted it. The test emitted it, so the test
  // passed while every Fluxloader mod silently registered no content at all.
  // loadElectronEntrypoints now fires it before returning, exactly as the
  // production path in src/main/entry.js needs, so the harvest below sees the
  // same patch set the loader will.

  // corelib's patches must stay corelib's. They are queued from a deferred
  // callback, so a shared-but-mutable fluxloaderAPI filed them all under
  // whichever mod loaded last.
  for (const file of Object.keys(out.patches)) {
    for (const p of out.patches[file]) {
      assert(p.owner === 'corelib', `patch ${p.id} attributed to ${p.owner}, not corelib`)
    }
  }

  // The dependent's element must reach somewhere real. It used to be asserted
  // against corelib's `elements:elementRegistry` patch, but that patch is one
  // the content bridge now supersedes - it is written for a game build this
  // one is not, so on 0.5.5 it is dropped and the element travels through the
  // bridge to the game's own registry instead. The intent of the check is
  // unchanged: a mod that registers content via corelib must not lose it.
  const captured = out.content.elements.map((e) => e.id)
  assert(captured.includes('Trash'),
    'the dependent element never reached the registry: [' + captured.join(', ') + ']')
  return 'globals shared, patches attributed to corelib, element captured for the game registry'
})

check('deferred patch registration is triggered by the loader, not the caller', () => {
  // A mod may register nothing while its entrypoint runs and queue everything
  // from an event instead - which is what corelib does, and what every mod
  // built on it inherits. The loader owes those mods the event; if it never
  // fires, they load without error and register nothing, and the game ships
  // unpatched. This asserts on a synthetic mod so it keeps testing the loader
  // even when corelib is not installed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-deferred-'))
  fs.writeFileSync(path.join(dir, 'modinfo.json'), JSON.stringify({
    modID: 'deferred', version: '1.0.0', electronEntrypoint: 'entry.electron.js',
  }))
  // Nothing is queued at load time - only a listener is registered.
  fs.writeFileSync(path.join(dir, 'entry.electron.js'),
    'fluxloaderAPI.events.on("fl:pre-scene-loaded", () => {\n' +
    '  fluxloaderAPI.setPatch("js/bundle.js", "deferred:late", {\n' +
    '    type: "replace", from: "ANCHOR", to: "PATCHED" })\n' +
    '})\n')

  const r = flCompat.readMod(dir)
  assert(r.ok, 'synthetic manifest rejected: ' + (r.ok ? '' : r.error.message))
  const out = flCompat.loadElectronEntrypoints([r.mod], {
    configDir: dir, rpc: { register: () => {} },
  }, testLogger())
  assert(out.errors.length === 0, 'load failed: ' + (out.errors[0] && out.errors[0].message))

  // The patch set is read exactly as src/main/entry.js reads it: straight off
  // the return value, with no event emitted by this test.
  const list = out.patches['js/bundle.js'] || []
  assert(list.length === 1,
    `a mod that defers registration to fl:pre-scene-loaded queued ${list.length} patch(es), not 1 ` +
    '- the loader did not fire the event before returning its patches')
  assert(list[0].id === 'deferred:deferred:late', 'wrong patch id: ' + list[0].id)
  assert(out.events.isEventRegistered('fl:pre-scene-loaded'),
    'fl:pre-scene-loaded fired without being declared, so trigger() on it would throw')
  return 'deferred patch queued without the caller emitting the event'
})

check('corelib loads and registers its patches end to end', () => {
  // corelib is the dependency most Fluxloader mods build on, and it exercises
  // nearly all of the compat surface at once: includeVMScript, the bare log(),
  // registerEvent/trigger, setPatch/setMappedPatch and getModsPath. If this
  // regresses, every mod that depends on corelib stops loading with it.
  const dir = path.join(__dirname, '..', 'mods', 'corelib')
  if (!fs.existsSync(dir)) return 'skipped - corelib not installed'
  const r = flCompat.readMod(dir)
  assert(r.ok, 'corelib manifest rejected')
  const out = flCompat.loadElectronEntrypoints(
    [r.mod], { configDir: dir }, testLogger())
  assert(out.errors.length === 0, 'corelib failed to load: ' + (out.errors[0] && out.errors[0].message))
  // Patches are queued from the scene hook, not at load, so fire it.
  out.events.emit('fl:pre-scene-loaded')
  const files = Object.keys(out.patches)
  let total = 0
  for (const f of files) total += out.patches[f].length
  assert(files.length > 0 && total > 0, 'corelib registered no patches')
  // corelib declares this and triggers it at the end of applyPatches; if the
  // module chain died halfway the event would never have been registered.
  assert(out.events.isEventRegistered('cl:patches-applied'), 'corelib did not finish applying patches')
  return `${total} patches across ${files.length} bundle(s)`
})

check('a mod entrypoint may use top-level await', () => {
  // corelib ends on `await corelib.init()`. Wrapped in a non-async function
  // that is a SyntaxError, which takes down the whole concatenated bundle -
  // every other mod in it included, not just the one that used await.
  for (const env of ['game', 'worker']) {
    const src = flCompat.wrapEntrypoint(
      { id: 'demo', version: '1.0.0', configSchema: {} }, env,
      'await Promise.resolve(1);')
    new vm.Script(src, { filename: 'await-' + env + '.js' })
  }
  return 'top-level await parses in game and worker wrappers'
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

check('a mod row carries its security class in the margin', () => {
  // The badge text is the precise statement, but it sits mid-row among other
  // chips. The tier is also the row's left edge, so "this mod can do anything
  // your account can" is legible while scanning the list - before reading a
  // single name.
  const { S, dom } = bootConsole({
    mods: [
      { id: 'plain', name: 'Plain', version: '1', enabled: true, capability: { badge: 'SANDBOXED' } },
      { id: 'net', name: 'Networked', version: '1', enabled: true, capability: { badge: 'NETWORK' } },
      { id: 'nat', name: 'Native Tool', version: '1', enabled: false, capability: { badge: 'NATIVE' } },
    ],
  })
  S.modsUI.toggle(true)
  const panel = dom.document.getElementById('smln-mods')
  const rows = []
  ;(function walk(n) {
    for (const c of n.childNodes || []) {
      if ((c.className || '').split(/\s+/).includes('row')) rows.push(c)
      walk(c)
    }
  })(panel)
  assert(rows.length === 3, 'expected 3 rows, got ' + rows.length)

  const cls = rows.map((r) => r.className)
  assert(!/native|elevated/.test(cls[0]), 'a sandboxed mod was flagged: ' + cls[0])
  assert(/elevated/.test(cls[1]), 'a network mod has no elevated edge: ' + cls[1])
  assert(/native/.test(cls[2]), 'a native mod has no native edge: ' + cls[2])
  assert(/off/.test(cls[2]), 'a disabled mod is not marked as off: ' + cls[2])

  // The edge is a modifier, not a replacement - the badge must still be there.
  const text = []
  ;(function walk(n) {
    if (n.textContent) text.push(n.textContent)
    for (const c of n.childNodes || []) walk(c)
  })(rows[2])
  assert(text.some((x) => /NATIVE/i.test(x)), 'the native badge text is gone: ' + text.join('|'))

  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'modsui.js'), 'utf8')
  assert(/#smln-mods \.row\.native\{border-left-color:#f87171/.test(src),
    'the native row edge is not styled red')
  return 'tier reads from the margin; badge text kept'
})

check('maps overlay lists maps, flags mod-installed ones, and previews only the selection', () => {
  // list() reads only the metadata line of each .custommap file and is cheap;
  // load() carries the six full-resolution PNG layers and is not, so it must
  // only ever be called for whichever map is actually selected - never
  // eagerly for the whole list.
  const { S, dom, sandbox } = bootConsole()
  const loads = []
  sandbox.electron.customMaps = {
    list: () => Promise.resolve([
      { id: 'smln.arena', name: 'Mod Arena', seed: 'abc', createdAt: '2024-01-01T00:00:00.000Z',
        version: 1, params: { width: 64, height: 32 } },
      { id: 'player-world', name: 'My World', seed: '', createdAt: '2024-02-02T00:00:00.000Z',
        version: 1, params: { width: 128, height: 96 } },
    ]),
    load: (id) => {
      loads.push(id)
      return Promise.resolve({ terrain: { width: 4, height: 4, dataUrl: 'data:image/png;base64,AA==' } })
    },
  }

  S.mapsUI.toggle(true)
  return new Promise((resolve, reject) => setTimeout(() => {
    try {
      const panel = dom.document.getElementById('smln-maps')
      assert(panel, 'maps overlay node missing')
      const rows = []
      ;(function walk(n) {
        for (const c of n.childNodes || []) {
          if ((c.className || '').split(/\s+/).includes('row')) rows.push(c)
          walk(c)
        }
      })(panel)
      assert(rows.length === 2, 'expected 2 rows, got ' + rows.length)
      assert(/(^|\s)mod(\s|$)/.test(rows[0].className),
        'the smln.-prefixed map was not flagged as coming from a mod: ' + rows[0].className)
      assert(!/(^|\s)mod(\s|$)/.test(rows[1].className),
        "the player's own map was flagged as a mod map: " + rows[1].className)

      assert(loads.length === 1 && loads[0] === 'smln.arena',
        'expected exactly one preview load, for the selected map only: ' + JSON.stringify(loads))
      resolve('lists both maps, flags the mod-installed one, previews only the selection')
    } catch (e) { reject(e) }
  }, 20))
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

check('a transformed file is served with its own content type, not always JavaScript', () => {
  // A patched index.html served as "application/javascript" makes Chromium
  // render the markup as source text instead of parsing it - the game boots to
  // a black screen full of HTML. Every patch target used to be a script, so the
  // hardcoded type was invisible until a Fluxloader mod patched index.html.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'interceptor.js'), 'utf8')
  assert(!/'application\/javascript; charset=utf-8'/.test(src),
    'the interceptor still hardcodes a JavaScript content type for transformed files')

  // And the table it must consult instead has to know about markup.
  const mod = require('../src/main/interceptor')
  const mimeFor = mod.mimeFor || mod.__mimeFor
  if (typeof mimeFor === 'function') {
    assert(mimeFor('dist/index.html') === 'text/html',
      'index.html did not resolve to text/html: ' + mimeFor('dist/index.html'))
    assert(/javascript/.test(mimeFor('dist/js/bundle.js')),
      'bundle.js no longer resolves to a JavaScript type')
  }
  return 'transformed files keep their own MIME type'
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
    // Which attach is right depends on the build, not on the store: the slot
    // existed up to 0.5.5 and is gone in 0.5.6. Assert the strategy the host
    // probe implies, so this check keeps telling the truth across updates.
    const host = require('../src/asar/hostabi').probe(install)
    const s = platformMod.strategyFor(p, host)
    if (host.loaderSlot) {
      assert(s.id === 'steam-workshop-slot', 'a host with the slot got ' + s.id)
      assert(s.writes.length === 0, 'the Steam path wants to write into the game directory')
    } else {
      assert(s.id === 'asar-shadow-directory', 'a host without the slot got ' + s.id)
      assert(s.writes.length === 3, 'the shadow attach touches ' + s.writes.length + ' paths')
    }
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
    const manualStrategy = platformMod.strategyFor(manual, { loaderSlot: false })
    assert(manual.kind === 'manual', 'a plain install was detected as ' + manual.kind)
    assert(manualStrategy.id === 'asar-shadow-directory', 'non-Steam strategy: ' + manualStrategy.id)
    assert(manualStrategy.writes.length === 3, 'the shadow attach touches ' + manualStrategy.writes.length + ' paths')

    const store = platformMod.detect(mk('store', { 'resources/app.asar': 'x', 'AppxManifest.xml': '<x/>' }))
    const storeStrategy = platformMod.strategyFor(store, { loaderSlot: false })
    assert(store.kind === 'msstore', 'MS Store was detected as ' + store.kind)
    assert(storeStrategy.supported === false, 'MS Store was advertised as supported')
    assert(/WindowsApps/.test(storeStrategy.reason), 'the refusal does not explain itself')

    const boot = require('../src/boot/bootstrap').plan({ resourcesPath: manual.resources })
    assert(boot.steps.findIndex((x) => /startManager/.test(x)) < boot.steps.findIndex((x) => /main\.js/.test(x)),
      'the bootstrap would load the game before installing the interceptor')
    return 'steam / gog / manual / msstore, with an accurate supported flag'
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

check('shadow paths keep the .asar suffix Electron needs for .unpacked', () => {
  const shadow = require('../src/asar/shadow')
  const p = shadow.derive('/res', 'app')
  assert(p.slot === path.join('/res', 'app.asar'), 'slot is not the name Electron looks at first')
  assert(p.parked === path.join('/res', 'app.smln-original.asar'), 'parked original lost its .asar suffix')
  assert(p.parkedUnpacked === p.parked + '.unpacked', 'unpacked sibling must be <parked>.unpacked')
  assert(p.liveUnpacked === path.join('/res', 'app.asar.unpacked'), 'live unpacked path is wrong')
  const g = shadow.derive('/res', 'game')
  assert(g.parked === path.join('/res', 'game.smln-original.asar'), 'game.asar builds are not derived')
  return 'app and game bases both derive correctly'
})

check('shadow state is read off the disk, not assumed', () => {
  const shadow = require('../src/asar/shadow')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-shadow-'))
  const seen = {}
  try {
    fs.writeFileSync(path.join(dir, 'app.asar'), 'ARCHIVE')
    seen.clean = shadow.inspect(dir, 'app').state

    fs.renameSync(path.join(dir, 'app.asar'), path.join(dir, 'app.smln-original.asar'))
    seen.parkedOnly = shadow.inspect(dir, 'app').state

    fs.mkdirSync(path.join(dir, 'app.asar'))
    seen.foreign = shadow.inspect(dir, 'app').state

    fs.writeFileSync(path.join(dir, 'app.asar', shadow.RECEIPT), '{}')
    seen.attached = shadow.inspect(dir, 'app').state

    fs.rmSync(path.join(dir, 'app.smln-original.asar'))
    seen.broken = shadow.inspect(dir, 'app').state

    fs.rmSync(path.join(dir, 'app.asar'), { recursive: true, force: true })
    fs.writeFileSync(path.join(dir, 'app.asar'), 'ARCHIVE')
    fs.writeFileSync(path.join(dir, 'app.smln-original.asar'), 'ARCHIVE')
    seen.orphaned = shadow.inspect(dir, 'app').state
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  assert(seen.clean === 'clean', 'untouched install read as ' + seen.clean)
  assert(seen.parkedOnly === 'parked-only', 'half-applied install read as ' + seen.parkedOnly)
  assert(seen.foreign === 'foreign', 'a directory without our receipt read as ' + seen.foreign)
  assert(seen.attached === 'attached', 'a complete attach read as ' + seen.attached)
  assert(seen.broken === 'broken', 'attach with the original gone read as ' + seen.broken)
  assert(seen.orphaned === 'orphaned', 'restored archive beside our original read as ' + seen.orphaned)
  return 'all six states distinguished'
})

check('applying the shadow attach moves both paths and lands the files', () => {
  const shadow = require('../src/asar/shadow')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-apply-'))
  try {
    fs.writeFileSync(path.join(dir, 'app.asar'), 'ARCHIVE')
    fs.mkdirSync(path.join(dir, 'app.asar.unpacked'))
    fs.writeFileSync(path.join(dir, 'app.asar.unpacked', 'native.node'), 'NATIVE')

    const out = shadow.apply(dir, 'app', { 'package.json': '{}', [shadow.RECEIPT]: '{"v":1}' })
    assert(out.ok, 'apply reported failure: ' + (out.error && out.error.message))
    assert(fs.readFileSync(path.join(dir, 'app.smln-original.asar'), 'utf8') === 'ARCHIVE',
      'the original archive did not move')
    assert(fs.readFileSync(path.join(dir, 'app.smln-original.asar.unpacked', 'native.node'), 'utf8') === 'NATIVE',
      'the unpacked natives did not move with it')
    assert(fs.statSync(path.join(dir, 'app.asar')).isDirectory(), 'the slot is not a directory')
    assert(fs.existsSync(path.join(dir, 'app.asar', shadow.RECEIPT)), 'the receipt was not written')
    assert(shadow.inspect(dir, 'app').state === 'attached', 'state after apply is not attached')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return 'archive, natives and three files all in place'
})

check('a failed apply leaves the install exactly as it found it', () => {
  const shadow = require('../src/asar/shadow')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-rollback-'))
  try {
    fs.writeFileSync(path.join(dir, 'app.asar'), 'ARCHIVE')
    fs.mkdirSync(path.join(dir, 'app.asar.unpacked'))

    // A file whose name is an invalid path component makes the last step throw
    // after both renames have already happened - the worst moment to fail.
    const out = shadow.apply(dir, 'app', { 'sub/dir/nope.json': '{}' })
    assert(!out.ok, 'apply reported success despite an unwritable file')
    assert(fs.readFileSync(path.join(dir, 'app.asar'), 'utf8') === 'ARCHIVE',
      'the original archive was not put back')
    assert(fs.statSync(path.join(dir, 'app.asar.unpacked')).isDirectory(),
      'the unpacked directory was not put back')
    assert(!fs.existsSync(path.join(dir, 'app.smln-original.asar')),
      'a parked original was left behind')
    assert(shadow.inspect(dir, 'app').state === 'clean', 'state after rollback is not clean')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return 'both renames undone, nothing left behind'
})

check('apply refuses to start unless the install is clean', () => {
  const shadow = require('../src/asar/shadow')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-guard-'))
  try {
    fs.mkdirSync(path.join(dir, 'app.asar'))
    const out = shadow.apply(dir, 'app', { 'package.json': '{}' })
    assert(!out.ok, 'apply ran against a slot that already held a directory')
    assert(/foreign/.test(String(out.error && out.error.message)),
      'the refusal did not name the state it found: ' + (out.error && out.error.message))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return 'a non-clean install is refused, and the state is named'
})

check('reverting puts the install back byte for byte', () => {
  const shadow = require('../src/asar/shadow')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-revert-'))
  try {
    fs.writeFileSync(path.join(dir, 'app.asar'), 'ARCHIVE')
    fs.mkdirSync(path.join(dir, 'app.asar.unpacked'))
    fs.writeFileSync(path.join(dir, 'app.asar.unpacked', 'native.node'), 'NATIVE')

    assert(shadow.apply(dir, 'app', { [shadow.RECEIPT]: '{}' }).ok, 'setup apply failed')
    const out = shadow.revert(dir, 'app')
    assert(out.ok, 'revert reported failure: ' + (out.error && out.error.message))

    assert(fs.readFileSync(path.join(dir, 'app.asar'), 'utf8') === 'ARCHIVE', 'archive not restored')
    assert(fs.readFileSync(path.join(dir, 'app.asar.unpacked', 'native.node'), 'utf8') === 'NATIVE',
      'natives not restored')
    assert(fs.readdirSync(dir).sort().join(',') === 'app.asar,app.asar.unpacked',
      'leftovers in resources: ' + fs.readdirSync(dir).join(','))
    assert(shadow.inspect(dir, 'app').state === 'clean', 'state after revert is not clean')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return 'archive, natives and directory listing all restored'
})

check('revert will not delete a directory SandLoader did not create', () => {
  const shadow = require('../src/asar/shadow')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-revert-guard-'))
  try {
    fs.mkdirSync(path.join(dir, 'app.asar'))
    fs.writeFileSync(path.join(dir, 'app.asar', 'someone-elses.js'), 'MINE')
    fs.writeFileSync(path.join(dir, 'app.smln-original.asar'), 'ARCHIVE')

    const out = shadow.revert(dir, 'app')
    assert(!out.ok, 'revert removed a directory with no receipt')
    assert(fs.existsSync(path.join(dir, 'app.asar', 'someone-elses.js')),
      "another tool's file was deleted")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return 'a receiptless directory is left alone'
})

check('a Steam host that still offers the slot keeps the zero-touch attach', () => {
  const platform = require('../src/asar/platform')
  const plat = { kind: 'steam', resources: '/res', writableResources: true, shadow: { state: 'clean' } }
  const strat = platform.strategyFor(plat, { loaderSlot: true })
  assert(strat.id === platform.STRATEGIES.WORKSHOP_SLOT, 'got ' + strat.id + ' for a host with the slot')
  assert(strat.writes.length === 0, 'the workshop slot must write nothing into the game directory')
  return 'workshop slot still preferred where it exists'
})

check('a host without the slot gets the shadow attach, on every platform', () => {
  const platform = require('../src/asar/platform')
  for (const kind of ['steam', 'gog', 'manual']) {
    const plat = { kind, resources: '/res', writableResources: true, base: 'app', shadow: { state: 'clean' } }
    const strat = platform.strategyFor(plat, { loaderSlot: false })
    assert(strat.id === platform.STRATEGIES.SHADOW_ASAR, kind + ' got ' + strat.id)
    assert(strat.supported, kind + ' was reported unsupported')
    assert(!strat.reason.includes('before'), 'the reason still claims the old search order')
  }
  return 'steam, gog and manual all fall through to the shadow attach'
})

check('the dead resources-app-bootstrap strategy is gone', () => {
  const platform = require('../src/asar/platform')
  assert(!('APP_BOOTSTRAP' in platform.STRATEGIES), 'APP_BOOTSTRAP is still exported')
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'asar', 'platform.js'), 'utf8')
  assert(!/searching[\s\S]{0,80}'app',\s*'app\.asar'/.test(src),
    'the module header still documents the reversed search order')
  return 'strategy and its false premise both removed'
})

check('MS Store stays unsupported and non-writable installs still refuse', () => {
  const platform = require('../src/asar/platform')
  const store = platform.strategyFor({ kind: 'msstore', resources: '/res' }, { loaderSlot: false })
  assert(store.id === platform.STRATEGIES.UNSUPPORTED, 'msstore became attachable')
  const ro = platform.strategyFor({ kind: 'manual', resources: '/res', writableResources: false }, { loaderSlot: false })
  assert(ro.id === platform.STRATEGIES.UNSUPPORTED, 'a read-only install became attachable')
  return 'both refusals intact'
})

check('the bootstrap reads the original archive out of its receipt', () => {
  const boot = require('../src/boot/bootstrap')
  const shadow = require('../src/asar/shadow')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-boot-'))
  try {
    const appDir = path.join(dir, 'app.asar')
    fs.mkdirSync(appDir)
    fs.writeFileSync(path.join(appDir, shadow.RECEIPT),
      JSON.stringify({ originalArchive: path.join(dir, 'app.smln-original.asar') }))
    const got = boot.originalAppRoot({ appDir, resourcesPath: dir })
    assert(got === path.join(dir, 'app.smln-original.asar'),
      'guessed ' + got + ' instead of reading the receipt')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return 'receipt beats guessing'
})

check('without a receipt the bootstrap still finds the untouched archive', () => {
  const boot = require('../src/boot/bootstrap')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-boot-legacy-'))
  try {
    fs.writeFileSync(path.join(dir, 'game.asar'), 'ARCHIVE')
    assert(boot.originalAppRoot({ resourcesPath: dir }) === path.join(dir, 'game.asar'),
      'the game.asar build was not found')
    fs.rmSync(path.join(dir, 'game.asar'))
    fs.writeFileSync(path.join(dir, 'app.asar'), 'ARCHIVE')
    assert(boot.originalAppRoot({ resourcesPath: dir }) === path.join(dir, 'app.asar'),
      'the app.asar build was not found')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return 'game.asar and app.asar both resolved'
})

check('the bootstrap plan reports the archive it would chain into', () => {
  const boot = require('../src/boot/bootstrap')
  const shadow = require('../src/asar/shadow')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-plan-'))
  try {
    const appDir = path.join(dir, 'app.asar')
    fs.mkdirSync(appDir)
    const original = path.join(dir, 'app.smln-original.asar')
    fs.writeFileSync(original, 'ARCHIVE')
    fs.writeFileSync(path.join(appDir, shadow.RECEIPT), JSON.stringify({ originalArchive: original }))
    const p = boot.plan({ appDir, resourcesPath: dir })
    assert(p.asar === original, 'plan chose ' + p.asar)
    assert(p.originalPresent === true, 'plan did not see the parked original')
    assert(p.steps.length >= 5, 'the documented boot order went missing')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return 'plan resolves through the receipt too'
})

check('no stray debug logging survives in the bootstrap', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'boot', 'bootstrap.js'), 'utf8')
  assert(!/smln_debug\.log/.test(src), 'the bootstrap still writes smln_debug.log on every start')
  assert(!/\bflog\(/.test(src), 'the flog() debug helper is still there')
  return 'appendFileSync debug trace removed'
})

check('the getApi anchor covers a registry assigned from an identifier', () => {
  const patch = corePatches.find((p) => p.id === 'smln:sandkit-get-api')
  assert(patch, 'the getApi patch is gone')

  // 0.5.6 stopped assigning an object literal: it builds the registry first
  // and assigns the identifier. `verify` alone would not catch a miss here,
  // because the variants carry expect:'any' and zero matches passes that - so
  // apply it and look at what actually came out.
  const shape056 = 'var M={};var E={mods:{elements:{}}};E.jsonConfigs=1,M.sandkit=E,f();'
  const out = engine.apply(shape056, [patch])
  assert(out.outcomes[0].status === 'applied',
    'the 0.5.6 assignment shape did not match: ' + (out.outcomes[0].reason || out.outcomes[0].status))
  assert(/getApi/.test(out.source), 'the patch applied but emitted no getApi')

  // It has to stay valid JavaScript, and getApi has to be reachable where the
  // game looks for it - on the object that ended up at state.sandkit.
  const sandbox = { globalThis: null, f: function () {} }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(out.source + ';globalThis.__probe=M.sandkit').runInContext(sandbox)
  assert(typeof sandbox.__probe.getApi === 'function',
    'state.sandkit.getApi is not a function after patching')

  // and the 0.5.5 literal shape must keep working.
  const shape055 = 'var g={};g.sandkit={mods:{elements:{},keyBindings:{}}},x=1;'
  const old = engine.apply(shape055, [patch])
  assert(old.outcomes[0].status === 'applied',
    'the object-literal shape broke: ' + (old.outcomes[0].reason || old.outcomes[0].status))
  assert(/getApi/.test(old.source), 'the literal shape applied but emitted no getApi')

  return 'identifier assignment and object literal both patched, getApi callable'
})

check('the worker capture patch anchors on the simulation worker only', () => {
  const { workerPatches } = require('../src/patch/core-patches')
  assert(Array.isArray(workerPatches) && workerPatches.length,
    'core-patches exports no workerPatches')
  const patch = workerPatches.find((p) => p.id === 'smln:capture-worker-state')
  assert(patch, 'the worker capture patch is missing')
  assert(patch.required === false,
    'the worker patch must not be required - a shape change may not cost the player the game')

  const sim = archive.readText('dist/js/simulation-worker.js')
  const out = engine.apply(sim, [patch])
  assert(out.outcomes[0].status === 'applied',
    'did not match the simulation worker: ' + (out.outcomes[0].reason || out.outcomes[0].status))
  assert(out.outcomes[0].matches === 1, 'expected 1 match, got ' + out.outcomes[0].matches)
  assert(/__SMLN_WORKER__/.test(out.source), 'the patch applied but published nothing')
  new vm.Script(out.source, { filename: 'simulation-worker.js' })

  // The other two build no full Sandkit. Asserting no match here is what makes
  // a future build that starts constructing one visible instead of silently
  // half-supported.
  for (const other of ['dist/js/utility-worker.js', 'dist/js/manager-worker.js']) {
    const res = engine.apply(archive.readText(other), [patch])
    assert(res.outcomes[0].matches === 0,
      other + ' unexpectedly matched the capture anchor - re-check the design')
  }
  return 'one match in the simulation worker, none in the other two, still parses'
})

check('the worker capture patch is routed to the worker, not the bundle', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'entry.js'), 'utf8')
  assert(/addPatches\(SIM_WORKER,\s*workerPatches\)/.test(src),
    'workerPatches are not routed to the simulation worker')
  assert(/workerPatches/.test(src), 'entry.js does not import workerPatches')
  return 'routed to SIM_WORKER'
})

check('the worker runtime hands mods the captured Sandkit', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'worker-runtime.js'), 'utf8')
  const sandbox = {
    self: null, console, setTimeout, clearTimeout, Date,
    // The runtime listens for game messages on install; a worker global has
    // these and a bare vm context does not.
    addEventListener() {}, removeEventListener() {}, postMessage() {},
  }
  sandbox.self = sandbox
  vm.createContext(sandbox)
  new vm.Script(src, { filename: 'worker-runtime.js' }).runInContext(sandbox)
  const SMLN = sandbox.__SMLN_WORKER__
  assert(SMLN, 'the runtime did not install')
  assert(typeof SMLN.whenWorkerReady === 'function', 'no whenWorkerReady')
  assert(!SMLN.sandkit(), 'sandkit() must be empty before the capture')

  // A mod loads before the game's worker code, so the deferral has to survive
  // being asked first.
  let seen = null
  SMLN.whenWorkerReady(function (state) { seen = state })
  assert(seen === null, 'whenWorkerReady fired before the state existed')

  // What smln:capture-worker-state assigns once the game's module evaluates.
  const fakeApi = { elements: {} }
  SMLN.state = { sandkit: { getApi: function () { return fakeApi }, workerEvents: {} } }

  return new Promise((resolve, reject) => {
    let polls = POLL_BUDGET
    const tick = () => {
      if (seen === null && polls-- > 0) return setTimeout(tick, 20)
      try {
        assert(seen === SMLN.state, 'whenWorkerReady never fired after the capture')
        assert(SMLN.sandkit() === SMLN.state.sandkit, 'sandkit() does not return the captured one')
        assert(SMLN.game() === fakeApi, 'game() does not return getApi()')
        resolve('deferred until capture, then state, sandkit and game all resolve')
      } catch (e) { reject(e) }
    }
    tick()
  })
})

check('worker event handlers are attributed, isolated and reclaimable', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'worker-runtime.js'), 'utf8')
  const logs = []
  const record = (m) => logs.push(String(m))
  const sandbox = {
    self: null, setTimeout, clearTimeout, Date,
    console: { log: record, info: record, warn: record, error: record },
    addEventListener() {}, removeEventListener() {}, postMessage() {},
  }
  sandbox.self = sandbox
  vm.createContext(sandbox)
  new vm.Script(src, { filename: 'worker-runtime.js' }).runInContext(sandbox)
  const SMLN = sandbox.__SMLN_WORKER__

  const sandkit = { getApi: () => ({}), workerEvents: {}, workerInterceptors: {} }
  SMLN.state = { sandkit }

  const seen = []
  assert(SMLN.worker.onEvent('good', 'tick', (st, p) => seen.push(p)) === true,
    'onEvent refused a registration after the capture')
  assert(SMLN.worker.onEvent('bad', 'tick', () => { throw new Error('boom') }) === true,
    'onEvent refused the second registration')

  // The game dispatches exactly this way: entries carry .fn, called (state, payload).
  const list = sandkit.workerEvents.tick
  assert(Array.isArray(list) && list.length === 2, 'handlers did not reach workerEvents')
  for (const entry of list) entry.fn(SMLN.state, 'payload')
  assert(seen.length === 1 && seen[0] === 'payload', 'the good handler did not run')
  assert(logs.some((l) => /bad/.test(l) && /boom/.test(l)),
    'the throwing handler was not reported against its mod: ' + JSON.stringify(logs))

  assert(SMLN.worker.registrations().length === 2, 'registrations() does not list both')
  SMLN.worker.releaseMod('bad')
  assert(sandkit.workerEvents.tick.length === 1, 'releaseMod did not remove the handler')
  assert(SMLN.worker.registrations().length === 1, 'registrations() still lists the released mod')

  SMLN.worker.onInterceptor('good', 'place', () => {})
  assert(Array.isArray(sandkit.workerInterceptors.place) &&
    sandkit.workerInterceptors.place.length === 1, 'the interceptor did not register')
  return 'two handlers registered, a throw isolated and attributed, one reclaimed'
})

check('the worker shim translates corelib calls onto the game API', () => {
  const runtime = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'worker-runtime.js'), 'utf8')
  const compat = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'worker-compat.js'), 'utf8')
  const sandbox = {
    self: null, console, setTimeout, clearTimeout, Date,
    addEventListener() {}, removeEventListener() {}, postMessage() {},
  }
  sandbox.self = sandbox
  vm.createContext(sandbox)
  new vm.Script(runtime, { filename: 'worker-runtime.js' }).runInContext(sandbox)
  new vm.Script(compat, { filename: 'worker-compat.js' }).runInContext(sandbox)

  const calls = []
  const api = {
    elements: {
      createAt: (st, x, y, t) => { calls.push(['createAt', x, y, t]); return true },
      removeAt: (st, x, y) => { calls.push(['removeAt', x, y]); return true },
      move: (st, fx, fy, tx, ty) => { calls.push(['move', fx, fy, tx, ty]); return true },
      getInfoAtPos: (st, x, y) => ({ elementType: 4, x, y }),
      getElementIdFromType: (st, t) => (t === 4 ? 'wetSand' : null),
    },
  }
  sandbox.__SMLN_WORKER__.state = { sandkit: { getApi: () => api, workerEvents: {} } }

  return new Promise((resolve, reject) => {
    let polls = POLL_BUDGET
    const tick = () => {
      if (!sandbox.corelib && polls-- > 0) return setTimeout(tick, 20)
      try {
        assert(sandbox.corelib, 'no corelib global was published')
        assert(sandbox.fluxloaderAPI, 'no fluxloaderAPI global was published')

        assert(sandbox.corelib.utils.getParticleNameFromNumber(4) === 'wetSand',
          'the element name did not translate')
        assert(sandbox.corelib.utils.getCellAtPos(3, 5).elementType === 4,
          'getCellAtPos did not translate')

        sandbox.corelib.simulation.setCell(1, 2, 7)
        assert(calls.some((c) => c[0] === 'createAt' && c[3] === 7),
          'setCell did not reach createAt: ' + JSON.stringify(calls))
        // Type 0 is "empty" in corelib's vocabulary, which is a removal here.
        sandbox.corelib.simulation.setCell(1, 2, 0)
        assert(calls.some((c) => c[0] === 'removeAt'), 'setCell(..., 0) did not remove')

        sandbox.corelib.simulation.moveCell(1, 2, 3, 4)
        assert(calls.some((c) => c[0] === 'move'), 'moveCell did not translate')

        // refinement assigns into blockRecipes, so it has to exist.
        assert(sandbox.corelib.blockRecipes !== undefined, 'blockRecipes must exist to be assignable')

        // A call the game refuses is reported, never a silent no-op.
        api.elements.move = () => { throw new Error('nope') }
        assert(sandbox.corelib.simulation.moveCell(0, 0, 1, 1) === false,
          'a refused call did not report failure')
        const unsupported = sandbox.__SMLN_WORKER__.unsupported()
        assert(unsupported.some((u) => /moveCell/.test(u.call)),
          'the refused call was not recorded: ' + JSON.stringify(unsupported))

        // fluxloaderAPI.events must tolerate the shapes the mods use.
        let fired = 0
        sandbox.fluxloaderAPI.events.registerEvent('cl:custom')
        sandbox.fluxloaderAPI.events.on('cl:custom', () => { fired++ })
        sandbox.fluxloaderAPI.events.tryTrigger('cl:custom')
        assert(fired === 1, 'the event did not fire')
        sandbox.fluxloaderAPI.events.tryTrigger('never-registered')

        const entrySrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'entry.js'), 'utf8')
        assert(/corelib worker entry skipped/.test(entrySrc),
          "corelib's worker entry is still injected and would clobber the shim")
        resolve('corelib calls translated, events delivered, refusals recorded')
      } catch (e) { reject(e) }
    }
    tick()
  })
})

check('the generated stub hands the bootstrap its own directory', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'install.js'), 'utf8')
  assert(/\.boot\(\{\s*appDir:\s*__dirname\s*\}\)/.test(src),
    'the stub does not pass appDir, so the bootstrap cannot find its receipt')
  return 'stub passes appDir'
})

check('the receipt records the archive the bootstrap has to chain into', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'install.js'), 'utf8')
  assert(/originalArchive/.test(src), 'receiptSource does not record originalArchive')
  return 'originalArchive present in the receipt'
})

check('install.js offers a repair path and has dropped the dead strategy', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'install.js'), 'utf8')
  assert(/--repair/.test(src), 'no --repair flag is dispatched')
  assert(/STRATEGIES\.SHADOW_ASAR/.test(src), 'install.js still branches on the removed strategy')
  assert(!/APP_BOOTSTRAP/.test(src), 'install.js still references APP_BOOTSTRAP')
  return 'repair wired, dead strategy gone'
})

check('the installer refuses to rename files the running game holds open', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'install.js'), 'utf8')
  assert(/function gameIsRunning/.test(src), 'install.js has no running-game precondition')
  const body = src.split('function installShadow')[1] || ''
  assert(/gameIsRunning\(\)/.test(body), 'installShadow does not check it before touching anything')
  return 'running game blocks the attach'
})

check('the README no longer promises an attach that does not exist', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')
  assert(!/Nothing in the game directory was modified/.test(readme),
    'the README still promises nothing in the game directory changes')
  assert(/0\.5\.6/.test(readme), 'the README has not caught up to 0.5.6')
  assert(/renamed/i.test(readme), 'the README does not say that two paths are renamed')
  assert(/MODDING_ENABLED/.test(readme),
    "the README does not record the game's own disabled modding pipeline")
  return 'promise, version and limitations all updated'
})

check('the README no longer calls recipes impossible', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')
  assert(!/has no recipe registry at all/.test(readme),
    'the README still says the game has no recipe registry at all')
  assert(/kineticPresses|nine machine categories/i.test(readme),
    'the README does not say what the 0.5.6 registry offers')
  // The trade-off the forwarding decision costs must not go unmentioned.
  assert(/exist twice|weighted output/i.test(readme),
    'the README does not admit that corelib seeds duplicate vanilla reactions')
  return 'the recipe limitation reflects 0.5.6, trade-off included'
})

check('the README describes the worker API that now exists', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')
  assert(!/there is no\s+worker-side `sandkit` for it to call/.test(readme),
    'the README still says there is no worker-side sandkit')
  assert(/whenWorkerReady/.test(readme), 'the README does not name the entry point mods use')
  assert(/utility worker/i.test(readme),
    'the README does not say which worker misses out')
  assert(/336\.bundle\.js/.test(readme),
    'the README does not say why corelib\'s worker half cannot be run')
  return 'worker limitation rewritten, with the reason corelib is replaced'
})

check('a map mod blueprint set becomes a .custommap the game could read', () => {
  const maps = require('../src/mods/custom-maps')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-map-'))
  try {
    // A 2x2 PNG, written by hand so the test needs no image library. The IHDR
    // carries the dimensions the validator reads. All six layers are
    // mandatory, so the happy path needs all six, same size.
    const blueprints = {}
    for (const layer of maps.LAYERS) {
      const file = path.join(dir, layer + '.png')
      fs.writeFileSync(file, makeTinyPng(2, 2))
      blueprints[layer] = file
    }

    const r = maps.assemble({
      modId: 'demo.maps',
      name: 'Demo World',
      seed: 'abc',
      params: { width: 2, height: 2 },
      blueprints,
    })
    assert(r.ok, 'assemble failed: ' + r.reason)
    assert(r.id === 'smln.demo.maps', 'unexpected id: ' + r.id)
    assert(r.file === 'smln.demo.maps.custommap', 'unexpected file: ' + r.file)
    assert(/^data:image\/png;base64,/.test(r.doc.terrain.dataUrl) &&
      r.doc.terrain.width === 2 && r.doc.terrain.height === 2,
      'terrain is not {width, height, dataUrl}')
    assert(/^data:image\/png;base64,/.test(r.doc.wall.dataUrl), 'wall is not a data URL')
    assert(r.doc.seed === 'abc' && r.doc.params.width === 2, 'seed and params did not travel')
    assert(typeof r.doc.createdAt === 'string' && r.doc.version, 'metadata is missing')
    assert(r.doc.name === 'Demo World', 'the name did not travel')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return 'six fields, per-layer dimensions, metadata and a collision-proof id'
})

check('a blueprint set the game would reject is refused with a reason', () => {
  const maps = require('../src/mods/custom-maps')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-map-bad-'))
  try {
    fs.writeFileSync(path.join(dir, 'terrain.png'), makeTinyPng(4, 4))
    fs.writeFileSync(path.join(dir, 'wall.png'), makeTinyPng(2, 2))
    fs.writeFileSync(path.join(dir, 'junk.png'), Buffer.from('not a png at all'))
    // The other four layers, valid and matching terrain's size, so each case
    // below misbehaves in exactly the one way it is testing.
    const rest = {}
    for (const layer of ['lights', 'lightsMeta', 'sensors', 'authorization']) {
      const file = path.join(dir, layer + '.png')
      fs.writeFileSync(file, makeTinyPng(4, 4))
      rest[layer] = file
    }

    const noTerrain = maps.assemble({ modId: 'm', blueprints: { ...rest, wall: path.join(dir, 'wall.png') } })
    assert(!noTerrain.ok && /terrain/i.test(noTerrain.reason),
      'a map with no terrain was accepted: ' + JSON.stringify(noTerrain))

    // All six are mandatory - the game's loader throws on any missing one
    // rather than skipping it, so a partial set is refused, never padded.
    const partial = maps.assemble({
      modId: 'm',
      blueprints: { terrain: path.join(dir, 'terrain.png'), wall: path.join(dir, 'wall.png') },
    })
    assert(!partial.ok && /lights/i.test(partial.reason) && /sensors/i.test(partial.reason),
      'a map missing layers was accepted, or did not name them: ' + JSON.stringify(partial))

    const mismatched = maps.assemble({
      modId: 'm',
      blueprints: { ...rest, terrain: path.join(dir, 'terrain.png'), wall: path.join(dir, 'wall.png') },
    })
    assert(!mismatched.ok && /dimension|size/i.test(mismatched.reason),
      'layers of different sizes were accepted: ' + JSON.stringify(mismatched))

    const notPng = maps.assemble({
      modId: 'm',
      blueprints: { ...rest, terrain: path.join(dir, 'junk.png'), wall: path.join(dir, 'wall.png') },
    })
    assert(!notPng.ok && /png/i.test(notPng.reason), 'a non-PNG was accepted')

    const missing = maps.assemble({
      modId: 'm',
      blueprints: { ...rest, terrain: path.join(dir, 'nope.png'), wall: path.join(dir, 'wall.png') },
    })
    assert(!missing.ok, 'a missing file was accepted')

    assert(maps.pngSize(Buffer.from('nope')) === null, 'pngSize accepted rubbish')
    assert(maps.pngSize(makeTinyPng(7, 9)).width === 7, 'pngSize read the wrong width')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return 'missing layers (all six, or just some), mismatched sizes, non-PNG and missing file all refused'
})

check('the loader answers the file-patching question the game asks', () => {
  // Without this the game takes its "no file patching" branch and builds its
  // workers from webpack chunk URLs, which no interceptor can see - so the
  // worker runtime is never injected and the capture patch never applies.
  const entry = require('../src/main/entry')
  assert(typeof entry._answerFilePatchingQuery === 'function',
    'entry.js does not export _answerFilePatchingQuery')

  const listeners = {}
  const fakeIpc = {
    removeAllListeners(channel) { delete listeners[channel] },
    on(channel, fn) { listeners[channel] = fn },
  }

  let active = false
  entry._answerFilePatchingQuery(fakeIpc, () => active)
  const handler = listeners['is-file-patching-active-sync']
  assert(typeof handler === 'function', 'no handler was registered on the channel')

  // Asked while the interceptor is not up, the honest answer is no.
  let event = {}
  handler(event)
  assert(event.returnValue === false, 'answered yes with no interceptor: ' + event.returnValue)

  // The predicate is read when the renderer asks, not when we register - the
  // interceptor is installed on app-ready, which is after this runs.
  active = true
  event = {}
  handler(event)
  assert(event.returnValue === true, 'answered no with the interceptor up: ' + event.returnValue)

  // The game registers its own handler, wired to MODDING_ENABLED, which is
  // false. Ours only wins if that one is gone.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'entry.js'), 'utf8')
  assert(/removeAllListeners\(\s*FILE_PATCHING_CHANNEL\s*\)/.test(src),
    "the game's own handler is not removed, so its false would win")
  return 'answers false without an interceptor, true with one, and displaces the game handler'
})

check('the install stays findable while SandLoader is attached to it', () => {
  // Regression: with the attach in place, resources/app.asar is our directory,
  // so every archive check rejected it and locate() returned "not found" - which
  // made the loader invisible to its own uninstaller. Caught by tools/e2e-attach.js.
  const shadow = require('../src/asar/shadow')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-locate-'))
  try {
    const slot = path.join(dir, 'app.asar')
    const parked = path.join(dir, 'app.smln-original.asar')
    fs.mkdirSync(slot)
    fs.writeFileSync(parked, 'ARCHIVE')
    fs.writeFileSync(path.join(slot, shadow.RECEIPT), JSON.stringify({ originalArchive: parked }))
    assert(locate.resolveThroughShadow(slot) === parked,
      'the receipt was not followed to the parked original')

    // A plain archive is passed straight through, untouched.
    assert(locate.resolveThroughShadow(parked) === parked, 'a real archive was redirected')

    // Somebody else's directory is not ours to follow.
    const foreign = path.join(dir, 'other.asar')
    fs.mkdirSync(foreign)
    assert(locate.resolveThroughShadow(foreign) === null, 'a receiptless directory was followed anyway')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return 'attached, untouched and foreign all resolved correctly'
})

check('the archive base survives the rename the attach performs', () => {
  const platformMod2 = require('../src/asar/platform')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-base-'))
  try {
    fs.mkdirSync(path.join(dir, 'resources'))
    const parked = path.join(dir, 'resources', 'app.smln-original.asar')
    fs.writeFileSync(parked, 'ARCHIVE')
    const p = platformMod2.detect({ root: dir, resources: path.join(dir, 'resources'), asar: parked })
    assert(p.base === 'app', 'base derived as "' + p.base + '" from the parked original')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return 'app.smln-original.asar still yields base "app"'
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

check('the completion rail never covers the console output', () => {
  // The suggestion list used to be `position:absolute;bottom:100%` - a popup
  // floating over the log, hiding the very output you were reading to decide
  // what to type. It is now a sibling column: it takes width from the output
  // instead of covering it, so no line is ever occluded.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'console.js'), 'utf8')
  const rail = src.slice(src.indexOf("'#smln-sugg{"), src.indexOf("].join('')"))
  assert(!/#smln-sugg\{[^']*position:absolute/.test(rail),
    'the completion rail is absolutely positioned again - it will overlay the output')
  assert(!/#smln-sugg\{[^']*bottom:100%/.test(rail),
    'the completion rail is anchored over the log again')

  const { S, dom } = bootConsole()
  S.console.toggle(true)
  const body = dom.document.getElementById('smln-body')
  assert(body, 'the console has no body row to lay output and rail out in')
  const kids = (body.childNodes || []).map((n) => n.id)
  assert(kids.indexOf('smln-out') >= 0 && kids.indexOf('smln-sugg') >= 0,
    'output and rail are not siblings: ' + kids.join(','))

  // With suggestions showing, every printed line must still be in the tree.
  S.console.print('a line worth reading', 'n')
  S.console.suggest('spa', 3)
  const sugg = dom.document.getElementById('smln-sugg')
  const rows = []
  ;(function walk(n) {
    for (const c of n.childNodes || []) {
      if ((c.className || '').split(/\s+/).includes('s')) rows.push(c)
      walk(c)
    }
  })(sugg)
  assert(rows.length, 'the rail showed nothing for a known command prefix')

  const out = dom.document.getElementById('smln-out')
  const texts = []
  ;(function walk(n) {
    if (n.textContent) texts.push(n.textContent)
    for (const c of n.childNodes || []) walk(c)
  })(out)
  assert(texts.some((x) => /a line worth reading/.test(x)),
    'the output line vanished while the rail was open')
  return 'rail is a sibling column; output stays whole while completing'
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
  //
  // Which snippet to lift depends on the shape the build emitted: up to 0.5.5
  // the registry is an object literal assigned to `sandkit`, and getApi goes
  // inside it. 0.5.6 assigns an identifier and getApi is appended beside the
  // assignment - there is no literal to slice out, and slicing for one anyway
  // is how this check started handing vm a fragment beginning at index -1.
  const ctx = {}
  vm.createContext(ctx)
  const preamble = 'globalThis.__SMLN__={game:{elements:{},structures:{}}};'
  const literalStart = out.source.indexOf('sandkit={mods:{items:')
  if (literalStart !== -1) {
    const snippet = out.source.slice(literalStart, out.source.indexOf('null}}', literalStart) + 6)
    vm.runInContext(preamble + 'var g={};g.' + snippet + ';' +
      'api=g.sandkit.getApi();regs=!!(g.sandkit.mods.elements&&g.sandkit.keyBindings)', ctx)
  } else {
    // The identifier form appends only a property, so the registries cannot be
    // disturbed by construction; what has to be proved is that the emitted
    // method is real and returns the API.
    const emitted = out.source.match(/([A-Za-z_$][\w$]*)\.getApi=\1\.getApi\|\|(function\(\)\{[^]*?\|\|null\})/)
    assert(emitted, 'the identifier form emitted no recognisable getApi')
    vm.runInContext(preamble +
      'var E={mods:{elements:{}},keyBindings:{}};var g={};' +
      'g.sandkit=E,E.getApi=E.getApi||' + emitted[2] + ';' +
      'api=g.sandkit.getApi();regs=!!(g.sandkit.mods.elements&&g.sandkit.keyBindings)', ctx)
  }
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

check('SMLN.register automatically flushes renderer content to workers', () => {
  const { S } = bootConsole()
  const posted = []
  const FH = {
    elements: { register(st, def) { st.sandkit.mods.elements[def.id] = def; return { elementType: 91 } } },
  }
  const st = {
    store: { structures: [], meta: { time: 0 } },
    environment: {
      config: { cellSize: 4 },
      multithreading: { simulation: { postAll: (state, msg) => posted.push(msg) } },
    },
    sandkit: { mods: { elements: {}, structures: {}, terrains: {}, matters: {}, misc: {} } },
  }
  S.__capture(FH, st, 'game:ready')

  return S.register.as('creator-selftest').element({ id: 'creator-element' }).then(() =>
    new Promise((resolve, reject) => setTimeout(() => {
      try {
        const message = posted.find((entry) => entry[0] === enums.WorkerMessage.RegisterModElements)
        assert(message, 'no automatic RegisterModElements message was posted')
        assert(message[1]['creator-element'], 'the automatic worker payload omitted the renderer element')
        resolve('renderer registration reached the simulation workers')
      } catch (e) { reject(e) }
    }, 80))
  )
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

const flContent = require('../src/compat/flux-content')

/** A stand-in for the corelib object an entrypoint publishes. */
function fakeCorelib() {
  return {
    elements: {
      registerElement(c) { this._e = (this._e || []).concat([c]); return true },
      registerSoil(c) { this._s = (this._s || []).concat([c]); return true },
    },
    recipes: {
      registerPressRecipe() { return true },
      registerShakerRecipe() { return true },
    },
  }
}

check('the bridge captures element registrations instead of patching', () => {
  const g = { corelib: fakeCorelib() }
  const r = flContent.install(g, { modId: 'corelib', logger: testLogger(), matterEnum: LIVE_MATTER })
  assert(r.ok, 'install failed')
  g.corelib.elements.registerElement({
    id: 'Trash', name: 'Trash', colors: [[88, 74, 74, 255]], density: 150, matterType: 'Slushy',
  })
  assert(r.captured.elements.length === 1, 'nothing captured')
  assert(r.captured.elements[0].def.matterType === 6, 'definition was not translated')
  return 'captured Trash with matterType 6'
})

check('a registration the build cannot support is recorded with its reason', () => {
  // A recipe the registry would refuse is reported, not silently dropped.
  // 0.5.6 added the registry, so an unregisterable recipe is now one the game
  // itself would reject - here an output chance outside 0 to 1.
  const g = { corelib: fakeCorelib() }
  const r = flContent.install(g, { modId: 'corelib', logger: testLogger(), matterEnum: LIVE_MATTER })
  g.corelib.recipes.registerPressRecipe({ input: 'Trash', outputs: [['CompressedTrash', 4]] })
  assert(r.captured.unsupported.length === 1,
    'the invalid recipe was not recorded as unsupported')
  const u = r.captured.unsupported[0]
  assert(u.kind === 'recipe', 'wrong kind: ' + u.kind)
  assert(/chance/i.test(u.reason), 'reason is not explanatory: ' + u.reason)
  return u.reason
})

check('corelib recipe calls are captured now that 0.5.6 has a registry', () => {
  const g = { corelib: fakeCorelib() }
  const r = flContent.install(g, { modId: 'corelib', logger: testLogger(), matterEnum: LIVE_MATTER })
  assert(Array.isArray(r.captured.recipes), 'captured.recipes is missing')

  g.corelib.recipes.registerPressRecipe({ input: 'Trash', outputs: [['CompressedTrash', 0.65]] })
  assert(r.captured.recipes.length === 1,
    'the recipe was not captured, got ' + r.captured.recipes.length)
  const got = r.captured.recipes[0]
  assert(got.kind === 'kineticPresses', 'captured as ' + got.kind)
  assert(got.def.input === 'Trash', 'the captured def is wrong')
  assert(got.def.outputs[0].name === 'CompressedTrash', 'the outputs were lost')

  // Allow-lists are not recipes and must not be captured as one.
  g.corelib.recipes.registerShakerRecipe({ input: 'Trash', outputAbove: [['Gold', 0.1]] })
  assert(r.captured.recipes.length === 2, 'the shaker recipe was not captured')
  assert(r.captured.recipes[1].kind === 'shakers', 'shaker captured as ' + r.captured.recipes[1].kind)

  // And a corelib call must never throw back into the mod.
  let threw = false
  try { g.corelib.recipes.registerPressRecipe(null) } catch (_e) { threw = true }
  assert(!threw, 'a malformed recipe threw into the mod')
  return 'press and shaker captured, malformed one reported without throwing'
})

check('a bad definition is recorded, and never throws into the mod', () => {
  // corelib mods call these at entrypoint top level; throwing would take the
  // whole mod down instead of losing one element.
  const g = { corelib: fakeCorelib() }
  const r = flContent.install(g, { modId: 'corelib', logger: testLogger(), matterEnum: LIVE_MATTER })
  let threw = false
  try {
    g.corelib.elements.registerElement({ id: 'Bad', name: 'Bad', density: 1, matterType: 'Plasma' })
  } catch (_e) { threw = true }
  assert(!threw, 'a bad definition threw into the mod')
  assert(r.captured.unsupported.length === 1, 'the failure was not recorded')
  assert(/Plasma/.test(r.captured.unsupported[0].reason), 'reason lost the detail')
  return r.captured.unsupported[0].reason
})

check('a throwing id getter is recorded, and never throws into the mod', () => {
  // A malformed config (missing/wrong-typed id) is handled by translate's own
  // validation. This is the sharper case: reading `id` itself throws, which
  // happens before translate ever gets a chance to validate anything.
  const g = { corelib: fakeCorelib() }
  const r = flContent.install(g, { modId: 'corelib', logger: testLogger(), matterEnum: LIVE_MATTER })
  const evil = {}
  Object.defineProperty(evil, 'id', { get() { throw new Error('boom') } })
  let threw = false
  try {
    g.corelib.elements.registerElement(evil)
  } catch (_e) { threw = true }
  assert(!threw, 'a throwing id getter escaped the shim')
  assert(r.captured.unsupported.length === 1, 'the failure was not recorded')
  assert(r.captured.unsupported[0].kind === 'element', 'wrong kind: ' + r.captured.unsupported[0].kind)
  return r.captured.unsupported[0].reason
})

check('a throwing config getter in a recipe call never throws into the mod', () => {
  // Same exposure in the recipe shim: it reads config.input / config.id
  // directly before note() ever runs.
  const g = { corelib: fakeCorelib() }
  const r = flContent.install(g, { modId: 'corelib', logger: testLogger(), matterEnum: LIVE_MATTER })
  const evil = {}
  Object.defineProperty(evil, 'input', { get() { throw new Error('boom') } })
  let threw = false
  try {
    g.corelib.recipes.registerPressRecipe(evil)
  } catch (_e) { threw = true }
  assert(!threw, 'a throwing config getter escaped the recipe shim')
  assert(r.captured.unsupported.length === 1, 'the failure was not recorded')
  assert(r.captured.unsupported[0].kind === 'recipe', 'wrong kind: ' + r.captured.unsupported[0].kind)
  return r.captured.unsupported[0].reason
})

check('only the patches the bridge takes over are suppressed', () => {
  // corelib has ~50 subsystems. Dropping more than the bridge replaces would
  // break the ones whose anchors still match this build.
  assert(flContent.shouldSuppress('corelib:corelib:elements:elementRegistry'),
    'an element patch was not suppressed')
  assert(flContent.shouldSuppress('corelib:corelib:elements:soilRegistry'),
    'a soil patch was not suppressed')
  assert(!flContent.shouldSuppress('corelib:corelib:colorIdFix:countdownFix'),
    'an unrelated patch was suppressed')

  // Blocks, tech and upgrades are bridged too, so their DEFINITION patches are
  // superseded and must go.
  assert(flContent.shouldSuppress('corelib:corelib:blockInventory'),
    'a block definition patch was not suppressed')
  assert(flContent.shouldSuppress('corelib:corelib:blockTypeDefinitions'),
    'a block definition patch was not suppressed')
  assert(flContent.shouldSuppress('corelib:corelib:tech:definitions'),
    'a tech definition patch was not suppressed')
  assert(flContent.shouldSuppress('corelib:corelib:upgradeDefinitions'),
    'an upgrade definition patch was not suppressed')

  // ...but only the definitions. corelib's UI patches for those same
  // subsystems are what draw the config menus and tech-tree connectors, and
  // the bridge does not replace them - dropping those would trade missing
  // content for a broken interface.
  assert(!flContent.shouldSuppress('corelib:corelib:blockConfigMenu'),
    'a block UI patch was suppressed')
  assert(!flContent.shouldSuppress('corelib:corelib:techUI-addConnectors'),
    'a tech UI patch was suppressed')
  assert(!flContent.shouldSuppress('corelib:corelib:upgradeUpdating'),
    'an upgrade UI patch was suppressed')
  return 'definition patches suppressed for all five content types, UI patches kept'
})

check('an "optional:" dependency prefix does not make a mod required', () => {
  // Fluxloader marks soft dependencies as "optional:^1.1.4". Reading the
  // prefix as part of the range made it both unparsable and required, so
  // refinement was dropped entirely for "bigger-grabber", a mod it works
  // perfectly well without.
  const dir = tmpdir('flux-optional-dep')
  fs.mkdirSync(path.join(dir, 'refiner'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'refiner', 'modinfo.json'), JSON.stringify({
    modID: 'refiner', name: 'Refiner', version: '1.0.0',
    dependencies: { corelib: '^3.0.1', 'bigger-grabber': 'optional:^1.1.4' },
  }))
  const found = flCompat.discover([dir])
  const mod = (found.mods || found).find((m) => m.id === 'refiner')
  assert(mod, 'the mod was not discovered')

  const hard = mod.dependencies.find((d) => d.id === 'corelib')
  const soft = mod.dependencies.find((d) => d.id === 'bigger-grabber')
  assert(hard && hard.optional === false, 'a plain dependency became optional')
  assert(soft && soft.optional === true, 'the "optional:" prefix was not honoured')
  // The prefix must come off the range too, or it never parses as semver.
  assert(soft.range === '^1.1.4', 'the prefix was left in the range: ' + soft.range)
  return 'optional: parsed off the range and flagged, plain dependencies untouched'
})

check('a config schema accepts array values', () => {
  // autosplitter declares {"type":"array","default":[1,2]}. Rejecting the
  // type threw away its whole config and left it running on an empty one.
  const explicit = modConfig.normaliseSchema({ splits: { type: 'array', default: [1, 2] } })
  assert(explicit.ok, 'an explicit array type was rejected: ' +
    (explicit.error && explicit.error.message))
  assert(JSON.stringify(explicit.schema.splits.default) === '[1,2]',
    'the default was not preserved')

  // With no declared type, an array default has to infer 'array' - it used to
  // fall through to 'string' and fail.
  const inferred = modConfig.normaliseSchema({ splits: { default: [2, 5, 7] } })
  assert(inferred.ok && inferred.schema.splits.type === 'array',
    'an array default did not infer the array type')

  // An array spec with no default gets a FRESH array each time; one shared
  // instance would let one mod's push be seen by every other.
  const a = modConfig.normaliseSchema({ k: { type: 'array' } })
  const b = modConfig.normaliseSchema({ k: { type: 'array' } })
  a.schema.k.default.push('x')
  assert(b.schema.k.default.length === 0, 'array defaults share one instance')

  // enum resolution must be unaffected: it also keys off an array field.
  const en = modConfig.normaliseSchema({ k: { values: ['a', 'b'] } })
  assert(en.ok && en.schema.k.type === 'enum', 'enum inference broke')
  return 'array accepted explicitly and by inference, defaults not shared, enum intact'
})

check('getEnabledMods answers to both shapes mods use', () => {
  // Two contracts exist in the wild and both are load-bearing: skinloader and
  // custommaploader call Object.values(...), refinement calls .filter(...)
  // directly. Returning either alone breaks the other.
  const dir = tmpdir('flux-enabled-mods')
  for (const id of ['alpha', 'beta']) {
    fs.mkdirSync(path.join(dir, id), { recursive: true })
    fs.writeFileSync(path.join(dir, id, 'modinfo.json'), JSON.stringify({
      modID: id, name: id, version: '1.0.0', tags: ['map'],
    }))
  }
  const found = flCompat.discover([dir])
  const loaded = flCompat.loadElectronEntrypoints(found.mods || found, {
    configDir: dir, rpc: { register() {} }, sendToRenderer() {},
  }, quietLogger)
  assert(loaded, 'the mods did not load')

  // No entrypoints here, so reach the API the same way a mod would: through
  // a mod that has one.
  fs.mkdirSync(path.join(dir, 'probe'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'probe', 'modinfo.json'), JSON.stringify({
    modID: 'probe', name: 'probe', version: '1.0.0',
    electronEntrypoint: 'entry.electron.js',
  }))
  // Reported through a file rather than a global: the entrypoint runs in its
  // own vm context, whose globalThis is the shared mod universe, not this one.
  const out = path.join(dir, 'probe.json')
  fs.writeFileSync(path.join(dir, 'probe', 'entry.electron.js'),
    'const all = fluxloaderAPI.getEnabledMods()\n' +
    'require("fs").writeFileSync(' + JSON.stringify(out) + ', JSON.stringify({\n' +
    '  byKey: Object.keys(all).length,\n' +
    '  byValues: Object.values(all).length,\n' +
    '  filtered: all.filter(function (m) { return m.info.modID === "alpha" }).length,\n' +
    '  length: all.length,\n' +
    '}))\n')
  const second = flCompat.discover([dir])
  flCompat.loadElectronEntrypoints(second.mods || second, {
    configDir: dir, rpc: { register() {} }, sendToRenderer() {},
  }, quietLogger)

  assert(fs.existsSync(out), 'the probe entrypoint did not run')
  const probe = JSON.parse(fs.readFileSync(out, 'utf8'))
  // Object.keys/values must see ONLY the mods - the array methods are added
  // non-enumerably, or every consumer counting entries would be wrong.
  assert(probe.byKey === probe.byValues,
    `keys (${probe.byKey}) and values (${probe.byValues}) disagree`)
  assert(probe.byKey === 3, 'expected 3 mods, saw ' + probe.byKey)
  assert(probe.filtered === 1, '.filter() did not find alpha: ' + probe.filtered)
  assert(probe.length === 3, '.length was wrong: ' + probe.length)
  return 'keyed for Object.values, iterable for .filter, methods non-enumerable'
})

check('blocks, tech nodes and upgrades translate into the shapes 0.5.5 takes', () => {
  // The inputs are the exact payloads the portals mod passes to corelib,
  // captured from a real load - not invented shapes that only prove the
  // translator agrees with itself.
  const block = flTranslate.translateBlock({
    sourceMod: 'portals', id: 'Portal', name: 'Portal',
    description: 'An interdimensional portal.',
    shape: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
    imagePath: 'Portal', angles: [0], singleBuild: true,
    hasConfigMenu: true, hasHoverUI: true, animationInterval: 200,
  })
  assert(block.ok, 'the portals block was rejected: ' + block.reason)
  assert(block.def.size.width === 4 && block.def.size.height === 4,
    'size was not derived from the shape grid')
  // Structures have their own i18n namespace; the game's own entries read
  // `structures|conveyor|name`. Filing one under `elements|` shows the raw key
  // on the hover tooltip.
  assert(block.def.nameKey === 'structures|portal|name',
    'wrong nameKey namespace: ' + block.def.nameKey)
  assert(!flTranslate.translateBlock({ id: 'X' }).ok,
    'a block with no shape should be rejected, not sized 0x0')

  const tech = flTranslate.translateTech({
    id: 'portals', name: 'Portals', description: 'd', cost: 20000,
    unlocks: { structures: ['d.Portal'] }, parent: 'Drones1',
  })
  assert(tech.ok, 'the portals tech node was rejected: ' + tech.reason)
  // corelib says `parent`; the tech shim reads `requires`, an array.
  assert(JSON.stringify(tech.def.requires) === '["Drones1"]',
    'parent was not mapped onto requires: ' + JSON.stringify(tech.def.requires))
  // "d.Portal" carries the bundle's minified namespace because corelib used to
  // splice that string into the source. Nothing evaluates it here, so the
  // prefix has to come off or the id matches no registered structure.
  assert(tech.def.unlocks.structures[0] === 'Portal',
    'the minified namespace was not stripped: ' + tech.def.unlocks.structures[0])

  const tab = flTranslate.translateUpgrade('tab', {
    id: 'portals', name: 'Portals', requirement: { tech: 'portals' },
  })
  assert(tab.ok && tab.def.kind === 'tab', 'the upgrade tab was rejected')
  assert(tab.def.requiresTech === 'portals',
    'the tech gate was dropped: ' + JSON.stringify(tab.def))
  const upgrade = flTranslate.translateUpgrade('upgrade', {
    tabID: 'portals', categoryID: 'portals', id: 'count',
    name: 'Portal Count', maxLevel: 7, costs: [5000, 7000],
  })
  assert(upgrade.ok && upgrade.def.tabID === 'portals' &&
    upgrade.def.categoryID === 'portals',
  'the upgrade lost its tab/category nesting')
  return 'real portals payloads translate, with the namespace prefix stripped'
})

check('the renderer bridge registers captured content through SMLN', () => {
  // Runs the real renderer script in a sandbox with a fake SMLN, so the wiring
  // is tested without a browser. The shapes here match the live game: verified
  // that SMLN.register.as(id) yields .element/.terrain and that callMain and
  // whenReady exist.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'flux-register.js'), 'utf8')
  const calls = { element: [], terrain: [], logs: [] }
  const SMLN = {
    log: (level, msg) => calls.logs.push(level + ': ' + msg),
    whenReady: (fn) => fn(),
    // The real callMain wraps a handler's return value in an {ok, value}
    // envelope - verified against the live game. A fake that returns the bare
    // payload lets a renderer that forgets to unwrap pass here and register
    // nothing in production, which is exactly what happened.
    callMain: (channel) => Promise.resolve(channel === 'smln:flux-content' ? {
      ok: true,
      value: {
        elements: [{ id: 'Trash', def: { id: 'Trash', matterType: 6 } }],
        soils: [{ id: 'TrashSoil', def: { id: 'TrashSoil' } }],
        unsupported: [{ kind: 'recipe', id: 'Trash', reason: 'no recipe registry on this build' }],
      },
    } : null),
    register: {
      as: () => ({
        element: (def) => { calls.element.push(def); return Promise.resolve({}) },
        terrain: (def) => { calls.terrain.push(def); return Promise.resolve({}) },
      }),
    },
  }
  const sandbox = { globalThis: null, __SMLN__: SMLN, console }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(src, { filename: 'flux-register.js' }).runInContext(sandbox)

  return new Promise((resolve, reject) => setTimeout(() => {
    try {
      assert(calls.element.length === 1, 'no element registered: ' + calls.element.length)
      assert(calls.element[0].id === 'Trash', 'wrong element: ' + calls.element[0].id)
      assert(calls.terrain.length === 1, 'no soil registered: ' + calls.terrain.length)
      assert(calls.logs.some((l) => /recipe/i.test(l)),
        'the unsupported recipe was not reported: ' + JSON.stringify(calls.logs))
      resolve('registered 1 element, 1 soil, reported 1 unsupported')
    } catch (e) { reject(e) }
  }, 20))
})

check('captured recipes reach the game with their element names resolved', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'flux-register.js'), 'utf8')
  const calls = { recipes: [], logs: [] }
  const SMLN = {
    log: (level, msg) => calls.logs.push(level + ': ' + msg),
    whenReady: (fn) => fn(),
    // The live registry has to be present, or the bridge correctly refuses.
    // sandkit.mods.elements stays empty on purpose. In the real game the mod
    // elements were not findable there, so the resolver has to work from the
    // type number the registration itself returned - and only after it has.
    state: { fake: true },
    sandkit: {
      structures: { recipes: { register: () => true } },
      mods: { elements: {} },
      // The live lookup, as the game exposes it: ids are camelCase with a
      // lowercase first letter, and an unknown id throws rather than returning
      // undefined. `copper` is deliberately absent from elementTypes below, so
      // only this path can resolve it.
      elements: {
        getElementTypeFromId(state, id) {
          const table = { sand: 1, water: 3, wetSand: 4, copper: 36, gold: 7 }
          if (!state || !Object.prototype.hasOwnProperty.call(table, id)) {
            throw new Error("Element with id '" + id + "' not found")
          }
          return table[id]
        },
      },
    },
    callMain: (channel) => Promise.resolve(channel === 'smln:flux-content' ? {
      ok: true,
      value: {
        elements: [{ id: 'CompressedTrash', def: { id: 'CompressedTrash' } }],
        soils: [],
        // enums.ElementByName is keyed lowercase; the resolver must normalise.
        elementTypes: { sand: 1, water: 3, wetsand: 4 },
        recipes: [
          { id: 'Sand', kind: 'contacts', def: {
            inputA: 'Sand', inputB: 'Water', outputA: 'WetSand', outputB: null,
            orientation: 'stacked' } },
          { id: 'Trash', kind: 'kineticPresses', def: {
            input: 'Sand', minimumDownwardVelocity: 0,
            outputs: [{ name: 'CompressedTrash', chance: 0.65 }] } },
          { id: 'Ghost', kind: 'growers', def: {
            input: 'Nonexistent', output: 'WetSand', chance: 1 } },
          // Copper is in neither the shipped table nor this run's mod
          // elements. Only the live lookup knows it, and corelib writes it
          // capitalised while the game's id is lowercase-first.
          { id: 'Wire', kind: 'shakers', def: {
            input: 'Copper', outputsAbove: [{ name: 'Gold', chance: 0.5 }], outputsBelow: [] } },
        ],
        unsupported: [],
      },
    } : null),
    register: {
      as: () => ({
        // Registering is asynchronous, and only afterwards does the game know
        // the element's type number.
        element: () => new Promise((res) => setTimeout(() => res({ elementType: 91 }), 10)),
        terrain: () => Promise.resolve({}),
        recipe: (kind, def) => { calls.recipes.push({ kind, def }); return Promise.resolve({}) },
      }),
    },
  }
  const sandbox = { globalThis: null, __SMLN__: SMLN, console, Promise, setTimeout }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(src, { filename: 'flux-register.js' }).runInContext(sandbox)

  // Wait for the outcome rather than for a fixed delay: the registration runs
  // behind the element promises, and a heavy check elsewhere in this suite can
  // starve a fixed timer long enough to make this look like a failure.
  return new Promise((resolve, reject) => {
    let polls = POLL_BUDGET
    const tick = () => {
      if (calls.recipes.length < 2 && calls.logs.length < 2 && polls-- > 0) {
        return setTimeout(tick, 20)
      }
      try {
      // The contact never reaches the game: this build has no machine id for
      // one, so it is reported instead of attempted.
      assert(calls.recipes.length === 2,
        'expected the press and the shaker, got ' + calls.recipes.length)
      assert(calls.logs.some((l) => /contacts recipes|nothing to register/.test(l)),
        'the contact recipe was not reported: ' + JSON.stringify(calls.logs))

      // Copper is resolvable only through the live lookup, and only after the
      // capitalised name corelib wrote is retried with a lowercase first letter.
      const shaker = calls.recipes.find((r) => r.kind === 'shaker')
      assert(shaker, 'the shaker naming a live-only element was not registered')
      assert(shaker.def.input === 36, 'Copper did not resolve through the live lookup')
      assert(shaker.def.outputsAbove[0].elementType === 7, 'Gold did not resolve')

      const press = calls.recipes.find((r) => r.kind === 'kineticPress')
      assert(press, 'the press was not registered')
      assert(press.def.outputs[0].elementType === 91,
        'a mod element registered this run was not resolved: ' + JSON.stringify(press.def.outputs))
      assert(press.def.outputs[0].chance === 0.65, 'the chance was lost')

      assert(calls.logs.some((l) => /Ghost|Nonexistent/.test(l)),
        'the unresolvable recipe was not reported: ' + JSON.stringify(calls.logs))
      resolve('press and live-only shaker registered; contact and unresolvable name reported')
      } catch (e) { reject(e) }
    }
    tick()
  })
})

check('captured content is exposed to the renderer over IPC', () => {
  // Sandkit lives in the renderer, so the definitions captured in the main
  // process have to cross the boundary. corelib already crosses it the same
  // way for its own registry (corelib:getModuleRegistrations), so this reuses
  // the transport rather than inventing one.
  // Two mods, as in reality: the library publishes the API, the dependent
  // calls it. corelib does not register its own content, so a single mod that
  // both defines and calls registerElement in one file would register before
  // the shim is installed - which is not how any real mod pair behaves.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-content-ipc-'))
  const dir = path.join(root, 'corelib')
  const useDir = path.join(root, 'user')
  fs.mkdirSync(dir); fs.mkdirSync(useDir)
  fs.writeFileSync(path.join(dir, 'modinfo.json'), JSON.stringify({
    modID: 'corelib', version: '3.1.3', electronEntrypoint: 'entry.electron.js',
  }))
  fs.writeFileSync(path.join(dir, 'entry.electron.js'),
    'globalThis.corelib = { elements: {\n' +
    '  registerElement(c) { return true },\n' +
    '  registerSoil(c) { return true },\n' +
    '} }\n')
  fs.writeFileSync(path.join(useDir, 'modinfo.json'), JSON.stringify({
    modID: 'user', version: '1.0.0', dependencies: { corelib: '^3.0.0' },
    electronEntrypoint: 'entry.electron.js',
  }))
  fs.writeFileSync(path.join(useDir, 'entry.electron.js'),
    'corelib.elements.registerElement({ id: "Ipc", name: "Ipc",\n' +
    '  colors: [[1,2,3,255]], density: 5, matterType: "Solid" })\n')

  const r = flCompat.readMod(dir)
  const user = flCompat.readMod(useDir)
  assert(r.ok && user.ok, 'manifest rejected')
  const channels = {}
  const out = flCompat.loadElectronEntrypoints([r.mod, user.mod], {
    configDir: dir,
    rpc: { register: (ch, fn) => { channels[ch] = fn } },
  }, testLogger())
  assert(out.errors.length === 0, 'load failed: ' + (out.errors[0] && out.errors[0].message))

  assert(typeof channels['smln:flux-content'] === 'function',
    'the content channel was not registered: [' + Object.keys(channels).join(', ') + ']')
  const payload = channels['smln:flux-content']()
  assert(payload.elements.length === 1, 'payload carried no element')
  assert(payload.elements[0].def.matterType === 1,
    'the definition was not translated: ' + payload.elements[0].def.matterType)
  assert(Array.isArray(payload.soils), 'soils missing from the payload')
  assert(Array.isArray(payload.unsupported), 'unsupported missing from the payload')
  fs.rmSync(root, { recursive: true, force: true })
  return 'channel returns ' + payload.elements.length + ' element(s)'
})

check('the loader supplies a real matter table, not an empty one', () => {
  // The bug this guards: the loader passed `ctx.matterEnum` through from a
  // runtime slot nothing ever populated, so production translated every
  // element against {} and rejected all of them with
  // `matterType "Slushy" does not exist (valid: )` - while still dropping
  // corelib's patches, which is the worst of both worlds. The table has to
  // come from somewhere real, and it has to map names to numbers.
  const table = flCompat.matterEnum()
  assert(table && typeof table === 'object', 'no matter table')
  assert(table.Solid === 1, 'Solid is not 1: ' + table.Solid)
  assert(table.Slushy === 6, 'Slushy is not 6: ' + table.Slushy)
  assert(table.Powder === 8, 'Powder is not 8: ' + table.Powder)
  // The numeric direction must survive too - the game's own table is keyed
  // that way and callers may read either.
  assert(table[6] === 'Slushy', 'the numeric direction was lost: ' + table[6])
  return 'name->number and number->name both present'
})

check('a mod that registers content gets it captured, with a working matter table', () => {
  // End-to-end through the loader's own default context - no matterEnum
  // supplied by the caller, exactly as src/main/entry.js invokes it. If the
  // loader does not source its own table, every element is rejected here.
  const coreDir = path.join(os.homedir(), 'AppData', 'Roaming', 'sandustry',
    'fluxloader-mods', 'corelib')
  const modDir = path.join(os.homedir(), 'AppData', 'Roaming', 'sandustry',
    'fluxloader-mods', 'trashelement')
  if (!fs.existsSync(coreDir) || !fs.existsSync(modDir)) return 'skipped - mods not installed'

  const core = flCompat.readMod(coreDir)
  const dep = flCompat.readMod(modDir)
  assert(core.ok && dep.ok, 'manifests rejected')

  const out = flCompat.loadElectronEntrypoints([core.mod, dep.mod], {
    configDir: coreDir, rpc: { register: () => {} },
  }, testLogger())
  assert(out.errors.length === 0, 'load failed: ' + (out.errors[0] && out.errors[0].message))

  const ids = out.content.elements.map((e) => e.id)
  assert(ids.includes('Trash'),
    'Trash was not captured (matter table empty?): [' + ids.join(', ') + '] ' +
    JSON.stringify(out.content.unsupported.map((u) => u.reason).slice(0, 2)))
  assert(ids.includes('CompressedTrash'), 'CompressedTrash was not captured')
  assert(out.content.soils.some((s) => s.id === 'TrashSoil'), 'TrashSoil was not captured')

  // 0.5.6 has a recipe registry, so a valid recipe is captured for the renderer
  // to register; only one the registry would refuse is reported. Either way it
  // is accounted for - the failure this guards against is silent loss.
  const captured = out.content.recipes || []
  const reported = out.content.unsupported.filter((u) => u.kind === 'recipe')
  assert(captured.length + reported.length >= 2,
    'recipe calls were neither captured nor reported: ' +
    captured.length + ' captured, ' + reported.length + ' reported')
  for (const rec of captured) {
    assert(typeof rec.kind === 'string' && rec.def,
      'a captured recipe carries no kind or def: ' + JSON.stringify(rec))
  }

  // And the superseded patches must not reach the patch set.
  for (const list of Object.values(out.patches)) {
    for (const p of list) {
      assert(!flContent.shouldSuppress(p.id), 'a superseded patch survived: ' + p.id)
    }
  }
  return `captured ${ids.length} element(s), ${out.content.soils.length} soil(s), ` +
    `${captured.length} recipe(s) captured and ${reported.length} reported`
})

check('installing maps writes ours and never removes the player\'s', () => {
  const maps = require('../src/mods/custom-maps')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-mapsync-'))
  const mapsDir = path.join(root, 'custom_maps')
  const bp = path.join(root, 'bp')
  fs.mkdirSync(mapsDir, { recursive: true })
  fs.mkdirSync(bp, { recursive: true })
  try {
    const terrainPng = path.join(bp, 'terrain.png')
    fs.writeFileSync(terrainPng, makeTinyPng(2, 2))
    // All six layers are mandatory; the same PNG stands in for all of them,
    // since sync() only cares that they exist and share one size.
    const spec = (modId) => {
      const blueprints = {}
      for (const layer of maps.LAYERS) blueprints[layer] = terrainPng
      return { modId, blueprints }
    }

    // Files that are not ours, including one deliberately close to our prefix.
    fs.writeFileSync(path.join(mapsDir, 'my-world.custommap'), '{}')
    fs.writeFileSync(path.join(mapsDir, 'smlnx.not-ours.custommap'), '{}')

    const first = maps.sync(mapsDir, [spec('alpha'), spec('beta')])
    assert(first.installed.length === 2, 'expected two installs, got ' + first.installed.length)
    assert(fs.existsSync(path.join(mapsDir, 'smln.alpha.custommap')), 'alpha was not written')
    const writtenLines = fs.readFileSync(path.join(mapsDir, 'smln.beta.custommap'), 'utf8').split('\n')
    const written = JSON.parse(writtenLines[1])
    assert(/^data:image\/png;base64,/.test(written.terrain.dataUrl), 'the written file has no terrain layer')

    // beta is gone now: its map goes, alpha stays, the player's files stay.
    const second = maps.sync(mapsDir, [spec('alpha')])
    assert(second.removed.length === 1 && /beta/.test(second.removed[0]),
      'beta was not pruned: ' + JSON.stringify(second.removed))
    assert(fs.existsSync(path.join(mapsDir, 'smln.alpha.custommap')), 'alpha was pruned too')
    assert(fs.existsSync(path.join(mapsDir, 'my-world.custommap')), "the player's map was deleted")
    assert(fs.existsSync(path.join(mapsDir, 'smlnx.not-ours.custommap')),
      'a file that merely looks like ours was deleted')

    // A bad spec is reported and does not stop the good one.
    const third = maps.sync(mapsDir, [spec('alpha'), { modId: 'broken', blueprints: {} }])
    assert(third.failed.length === 1 && third.failed[0].modId === 'broken',
      'the broken map was not reported: ' + JSON.stringify(third.failed))
    assert(third.installed.length === 1, 'the good map did not install alongside the bad one')

    // With nothing enabled, everything of ours goes and nothing else does.
    const fourth = maps.sync(mapsDir, [])
    assert(fourth.removed.length === 1, 'the last of ours was not pruned')
    const left = fs.readdirSync(mapsDir).sort()
    assert(left.join(',') === 'my-world.custommap,smlnx.not-ours.custommap',
      'the folder was left as: ' + left.join(','))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  return 'installed, pruned by owner, and the player\'s files untouched throughout'
})

check('sync creates the maps folder when the game has not yet', () => {
  const maps = require('../src/mods/custom-maps')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-mapdir-'))
  try {
    const mapsDir = path.join(root, 'custom_maps')
    const bp = path.join(root, 'terrain.png')
    fs.writeFileSync(bp, makeTinyPng(2, 2))
    const blueprints = {}
    for (const layer of maps.LAYERS) blueprints[layer] = bp
    const out = maps.sync(mapsDir, [{ modId: 'alpha', blueprints }])
    assert(out.installed.length === 1, 'nothing installed into a fresh folder')
    assert(fs.existsSync(path.join(mapsDir, 'smln.alpha.custommap')), 'the file is missing')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  return 'a missing custom_maps folder is created rather than an error'
})

check('a written .custommap is the two-line format the game reads', () => {
  const maps = require('../src/mods/custom-maps')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-mapformat-'))
  const mapsDir = path.join(root, 'custom_maps')
  const bp = path.join(root, 'terrain.png')
  try {
    fs.writeFileSync(bp, makeTinyPng(2, 2))
    const blueprints = {}
    for (const layer of maps.LAYERS) blueprints[layer] = bp
    maps.sync(mapsDir, [{ modId: 'demo', seed: 'xyz', blueprints }])

    const lines = fs.readFileSync(path.join(mapsDir, 'smln.demo.custommap'), 'utf8').split('\n')
    assert(lines.length === 2, 'expected exactly two lines, got ' + lines.length)

    const metadata = JSON.parse(lines[0])
    assert(metadata.id === 'smln.demo' && metadata.seed === 'xyz', "line 0 is not the map's metadata")
    assert(!('terrain' in metadata), 'line 0 carries layer data - the whole point of the split is that it does not')

    const doc = JSON.parse(lines[1])
    assert(doc.terrain && doc.terrain.dataUrl, 'line 1 is not the full document')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  return 'metadata on line one, full document on line two, exactly like the game writes it'
})

check('the loader installs map mods instead of refusing them', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'entry.js'), 'utf8')
  assert(!/map blueprints need game-side support and are not loaded yet/.test(src),
    'entry.js still refuses map mods with a reason that is no longer true')
  assert(/require\('\.\.\/mods\/custom-maps'\)|customMaps\.sync\(/.test(src),
    'entry.js never calls the map installer')
  assert(/custom_maps/.test(src), 'entry.js does not name the folder the game reads')
  return 'the refusal is gone and the installer is wired in'
})

check('the README stops calling map loading unavailable', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')
  assert(!/loading\s+them needs game-side support that is not exposed/.test(readme),
    'the README still says map loading needs support that is not exposed')
  assert(/custom_maps/.test(readme), 'the README does not say where maps go')
  assert(/browser|Custom Maps/i.test(readme), "the README does not mention the game's map browser")
  return 'map mods documented as working'
})

// --------------------------------------------------------------- map editor
/** Six layers of the requested size, as the editor hands them to the save. */
function editorLayers(maps, width, height, sizes) {
  const out = {}
  for (const layer of maps.LAYERS) {
    const w = (sizes && sizes[layer] && sizes[layer].width) || width
    const h = (sizes && sizes[layer] && sizes[layer].height) || height
    out[layer] = {
      width: (sizes && sizes[layer] && sizes[layer].declared)
        ? sizes[layer].declared.width : w,
      height: (sizes && sizes[layer] && sizes[layer].declared)
        ? sizes[layer].declared.height : h,
      dataUrl: 'data:image/png;base64,' + makeTinyPng(w, h).toString('base64'),
    }
  }
  return out
}

check('a mod install and an editor save go through one serialiser', () => {
  // The editor could have grown its own two-line writer. If it ever does, the
  // two files drift and only one of them is the format the game reads - so
  // the check is that the bytes agree, not that both "look right".
  const maps = require('../src/mods/custom-maps')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-onewriter-'))
  const mapsDir = path.join(root, 'custom_maps')
  const bp = path.join(root, 'layer.png')
  try {
    fs.writeFileSync(bp, makeTinyPng(8, 6))
    const blueprints = {}
    for (const layer of maps.LAYERS) blueprints[layer] = bp
    const built = maps.assemble({ modId: 'demo', name: 'Demo', seed: 's', blueprints })
    assert(built.ok, built.reason)
    assert(built.fileText === maps.serialise(built.doc),
      'assemble no longer writes what serialise writes')

    const saved = maps.saveDocument(mapsDir, {
      id: null, name: 'Demo', seed: 's', layers: editorLayers(maps, 8, 6),
    })
    assert(saved.ok, saved.reason)
    const text = fs.readFileSync(path.join(mapsDir, saved.file), 'utf8')
    assert(text.split('\n').length === 2, 'the editor wrote something other than two lines')
    assert(JSON.stringify(Object.keys(JSON.parse(text.split('\n')[0]))) ===
      JSON.stringify(Object.keys(JSON.parse(built.fileText.split('\n')[0]))),
      'the two writers disagree about the metadata line')

    // The importer's own rules are the closest thing to the game's reader.
    const seen = maps.inspect(text)
    assert(seen.ok, 'the editor wrote a file the importer refuses: ' + seen.reason)
    assert(seen.meta.params.width === 8 && seen.meta.params.height === 6,
      'params does not carry the pixel size the game renders unguarded')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  return 'same serialiser, same metadata line, and the result passes inspect()'
})

check('an authored map is never written under a name the loader may prune', () => {
  // PREFIX marks a file sync() deletes when its mod goes away. A map somebody
  // drew is not a mod's map, and losing it on the next launch would be the
  // worst possible bug in an editor.
  const maps = require('../src/mods/custom-maps')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-mapsave-'))
  const mapsDir = path.join(root, 'custom_maps')
  try {
    const layers = editorLayers(maps, 4, 4)
    for (const attempt of ['smln.sneaky', 'smln.smln.sneaky', 'smln']) {
      const r = maps.saveDocument(mapsDir, { id: attempt, layers })
      assert(r.ok, r.reason)
      assert(r.file.indexOf(maps.PREFIX) !== 0,
        `"${attempt}" was written as ${r.file}, which the pruner would delete`)
      assert(JSON.parse(fs.readFileSync(path.join(mapsDir, r.file), 'utf8').split('\n')[0]).id === r.id,
        'the id inside the file disagrees with its name, so the game cannot open it')
    }
    assert(maps.mapId('smln.x', 'fallback') === 'x', 'mapId does not strip the prefix')
    assert(maps.mapId('', 'fallback') === 'fallback', 'mapId has no fallback')
    assert(maps.mapId('My Great Map', 'x') === 'My-Great-Map', 'mapId mangles a plain name')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  return 'the prefix is stripped, and the id inside always matches the file name'
})

check('a save refuses the shapes that load as a silently broken world', () => {
  const maps = require('../src/mods/custom-maps')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-mapguard-'))
  const mapsDir = path.join(root, 'custom_maps')
  try {
    const short = editorLayers(maps, 4, 4)
    delete short.wall
    assert(!maps.saveDocument(mapsDir, { id: 'a', layers: short }).ok,
      'a five-layer map was accepted; the game needs all six or it fails to load')

    // The game sizes each layer's canvas from the recorded numbers and draws
    // the PNG at 0,0 without scaling, so a disagreement is not an error - it
    // is a clipped or transparently padded world.
    const lying = editorLayers(maps, 4, 4)
    lying.terrain = { width: 8, height: 8, dataUrl: lying.terrain.dataUrl }
    assert(!maps.saveDocument(mapsDir, { id: 'b', layers: lying }).ok,
      'a layer whose size disagrees with its own PNG was accepted')

    const ragged = editorLayers(maps, 4, 4, { lights: { width: 8, height: 8 } })
    assert(!maps.saveDocument(mapsDir, { id: 'c', layers: ragged }).ok,
      'layers describing two different worlds were accepted')

    const notPng = editorLayers(maps, 4, 4)
    notPng.sensors = { width: 4, height: 4, dataUrl: 'data:image/jpeg;base64,AAAA' }
    assert(!maps.saveDocument(mapsDir, { id: 'd', layers: notPng }).ok,
      'a layer that is not a PNG was accepted')

    assert(!fs.existsSync(mapsDir) || fs.readdirSync(mapsDir).length === 0,
      'a refused save still wrote a file')

    // Editing a map saves over it; a new map steps aside from what is there.
    const layers = editorLayers(maps, 4, 4)
    const first = maps.saveDocument(mapsDir, { id: 'keeper', layers })
    const again = maps.saveDocument(mapsDir, { id: 'keeper', layers })
    assert(first.file === again.file, 'editing a map wrote a second file instead of saving over it')
    const fresh1 = maps.saveDocument(mapsDir, { id: null, name: 'Fresh', layers })
    const fresh2 = maps.saveDocument(mapsDir, { id: null, name: 'Fresh', layers })
    assert(fresh1.id === 'Fresh' && fresh2.id === 'Fresh-2',
      'a new map overwrote an existing one: ' + fresh1.id + ', ' + fresh2.id)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  return 'six layers, agreeing sizes, real PNGs; edits overwrite and new maps do not'
})

check('undo is bounded by bytes rather than by step count', () => {
  // A 1920x1080 layer is ~8 MB as ImageData. Bounding by step count would be a
  // quarter of a gigabyte on a big map and nothing at all on a small one, so
  // the rule under test is the eviction, not the number.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'mapeditor.js'), 'utf8')
  const from = src.indexOf('// --- undo:begin')
  const to = src.indexOf('// --- undo:end')
  assert(from > 0 && to > from, 'the undo region markers are gone from mapeditor.js')

  const sandbox = {}
  vm.createContext(sandbox)
  new vm.Script(src.slice(from, to) +
    ';globalThis.__undo = { UndoStack: UndoStack, BUDGET: UNDO_BUDGET, TILE: UNDO_TILE }',
  { filename: 'mapeditor-undo.js' }).runInContext(sandbox)
  const api = sandbox.__undo

  const budget = 64 * 1024
  const stack = new api.UndoStack(budget)
  const tile = () => ({ image: { data: new Uint8ClampedArray(api.TILE * api.TILE * 4) } })
  for (let i = 0; i < 200; i++) stack.push({ layer: 'terrain', tiles: [tile(), tile()] })
  assert(stack.bytes <= budget, 'the stack grew to ' + stack.bytes + ' bytes past a ' + budget + ' budget')
  assert(stack.depth() > 0 && stack.depth() < 200,
    'nothing was evicted, or everything was: depth ' + stack.depth())

  // A stroke too big for the whole budget still leaves something to undo.
  const tight = new api.UndoStack(16)
  tight.push({ layer: 'terrain', tiles: [tile()] })
  assert(tight.depth() === 1, 'an oversized stroke evicted itself and cannot be taken back')

  assert(api.BUDGET >= 16 * 1024 * 1024 && api.BUDGET <= 256 * 1024 * 1024,
    'the shipped budget is not in the tens of megabytes: ' + api.BUDGET)
  return 'oldest evicted past ' + Math.round(api.BUDGET / (1024 * 1024)) + ' MB, one step always kept'
})

/**
 * The renderer stack in a VM, with a canvas and an Image.
 *
 * Separate from bootConsole() because the editor is the only part that needs
 * real pixels, and the harness's PNG codec is not something every other check
 * should have to carry.
 */
function bootEditor(opts = {}) {
  const { createDom } = require('./dom-harness')
  const dom = createDom()
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: dom.document,
    window: dom.window,
    navigator: { language: 'en-US' },
    location: { search: '' },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    WeakSet,
    Image: dom.Image,
    MutationObserver: dom.window.MutationObserver,
    electron: { log() {}, customMaps: opts.customMaps || null },
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  sandbox.window.document = dom.document
  vm.createContext(sandbox)
  const src = prelude.build({ reload: true, mods: [], locale: 'en' })
  new vm.Script(src, { filename: 'prelude.js' }).runInContext(sandbox)
  return { sandbox, dom, S: sandbox.__SMLN__ }
}

/** First descendant carrying this class, the way a querySelector would find it. */
function findByClass(root, className) {
  const found = []
  ;(function walk(node) {
    for (const child of node.childNodes || []) {
      if ((child.className || '').split(/\s+/).includes(className)) found.push(child)
      walk(child)
    }
  })(root)
  return found[0] || null
}

check('a painted map survives being saved and read back off disk', () => {
  // The test that matters most: a document is created at a requested size,
  // painted, written as six PNGs, read back from the file, and re-encoded.
  // Every step the format actually goes through is exercised - decode, canvas,
  // encode - so a defect in any of them shows up as pixels that changed.
  const maps = require('../src/mods/custom-maps')
  const harness = require('./dom-harness')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-roundtrip-'))
  const mapsDir = path.join(root, 'custom_maps')
  // Just over the floor the fixed spawn imposes (158 x 201). Below it the
  // editor raises the size rather than creating a map the player starts
  // outside of, so a smaller number here would not be the size that came back.
  const WIDTH = 160
  const HEIGHT = 204

  const { S, dom, sandbox } = bootEditor()
  sandbox.electron.customMaps = {
    load: (id) => Promise.resolve(
      JSON.parse(fs.readFileSync(path.join(mapsDir, id + '.custommap'), 'utf8').split('\n')[1])),
  }
  const calls = []
  S.callMain = (action, payload) => {
    calls.push(action)
    if (action !== 'saveCustomMap') return Promise.resolve({ ok: false, reason: 'unexpected ' + action })
    // The real main-process handler, minus Electron: the same function
    // src/main/entry.js calls, against a real folder.
    return Promise.resolve(maps.saveDocument(mapsDir, payload))
  }

  assert(S.mapEditor && typeof S.mapEditor.open === 'function', 'the editor did not install')
  assert(!S.mapEditor.isOpen(), 'the editor was open before anything opened it')

  const decoded = (text, layer) => harness.decodePng(
    Buffer.from(JSON.parse(text.split('\n')[1])[layer].dataUrl.split(',')[1], 'base64'))
  /** A save is a round trip through the main process; let it land. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  return S.mapEditor.open(null, { width: WIDTH, height: HEIGHT, name: 'Round Trip' }).then(() => {
    assert(S.mapEditor.isOpen(), 'open() did not open the editor')
    const overlay = dom.document.getElementById('smln-mapedit')
    assert(overlay, 'the editor overlay is not in the document')
    const view = findByClass(overlay, 'view')
    const save = findByClass(overlay, 'save')
    assert(view && save, 'the editor has no canvas or no save button')

    // The map is fitted and centred, so the middle of the view is the middle
    // of the map whatever the nominal size of the harness's box.
    const cx = harness.NOMINAL.width / 2
    const cy = harness.NOMINAL.height / 2
    view.dispatch('mousedown', harness.mouseEvent('mousedown', { clientX: cx, clientY: cy }))
    view.dispatch('mousemove', harness.mouseEvent('mousemove', { clientX: cx + 20, clientY: cy }))
    dom.window.emit('mouseup', {})

    save.dispatch('click', { type: 'click' })
    assert(calls.length === 1 && calls[0] === 'saveCustomMap',
      'Save did not reach the main process: ' + JSON.stringify(calls))
    return settle()
  }).then(() => {
    const files = fs.readdirSync(mapsDir)
    assert(files.length === 1, 'expected one map file, got ' + JSON.stringify(files))
    const firstText = fs.readFileSync(path.join(mapsDir, files[0]), 'utf8')
    const seen = maps.inspect(firstText)
    assert(seen.ok, 'the editor wrote a file the importer refuses: ' + seen.reason)
    assert(seen.meta.params.width === WIDTH && seen.meta.params.height === HEIGHT,
      'the saved size is not the size that was asked for: ' + JSON.stringify(seen.meta.params))

    const painted = decoded(firstText, 'terrain')
    assert(painted.width === WIDTH && painted.height === HEIGHT,
      'the terrain PNG is ' + painted.width + 'x' + painted.height)
    // A blank document's terrain is air, not transparency - alpha 0 is Fog -
    // so "was anything painted" is "is anything not air", not "is anything
    // opaque". Every pixel being opaque is itself the rule, and is asserted.
    const air = require('../src/game/terrain-palette').DEFAULT_EMPTY.rgb
    let inked = 0
    for (let i = 0; i < painted.data.length; i += 4) {
      assert(painted.data[i + 3] === 255,
        'a terrain pixel came back see-through at byte ' + i + ', which the game reads as fog')
      if (painted.data[i] !== air[0] || painted.data[i + 1] !== air[1] ||
          painted.data[i + 2] !== air[2]) inked++
    }
    assert(inked > 0, 'nothing was painted, so the round trip would be trivially true')

    // The five other layers are written blank and that is deliberate: they are
    // deny-lists and decoration, and a blank one means "nothing here".
    for (const layer of ['lights', 'lightsMeta', 'sensors', 'authorization', 'wall']) {
      const l = decoded(firstText, layer)
      assert(l.width === WIDTH && l.height === HEIGHT, layer + ' is the wrong size')
    }

    return S.mapEditor.open(seen.meta.id).then(() => {
      const overlay2 = dom.document.getElementById('smln-mapedit')
      findByClass(overlay2, 'save').dispatch('click', { type: 'click' })
      return settle()
    }).then(() => {
      const secondText = fs.readFileSync(path.join(mapsDir, files[0]), 'utf8')
      assert(fs.readdirSync(mapsDir).length === 1,
        'saving an edited map made a second file instead of saving over it')

      for (const layer of maps.LAYERS) {
        const before = decoded(firstText, layer)
        const after = decoded(secondText, layer)
        assert(before.width === after.width && before.height === after.height,
          layer + ' changed size across the round trip')
        for (let i = 0; i < before.data.length; i++) {
          assert(before.data[i] === after.data[i],
            layer + ' changed at byte ' + i + ': ' + before.data[i] + ' became ' + after.data[i])
        }
      }
      S.mapEditor.close()
      assert(!S.mapEditor.isOpen(), 'close() left the editor open')
      return inked + ' painted pixels and all six layers came back identical at ' + WIDTH + 'x' + HEIGHT
    })
  }).then(
    (detail) => { fs.rmSync(root, { recursive: true, force: true }); return detail },
    (e) => { fs.rmSync(root, { recursive: true, force: true }); throw e })
})

check('the editor is reachable, and still names no colour of its own', () => {
  const editorSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'mapeditor.js'), 'utf8')
  const mapsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'mapsui.js'), 'utf8')

  assert(prelude.PARTS.includes('mapeditor.js'), 'mapeditor.js is not in the injected prelude')
  assert(/maps\.newMap/.test(mapsSrc) && /maps\.edit/.test(mapsSrc),
    'the maps overlay offers neither New map nor Edit')

  // Nearest-neighbour twice over: the CSS covers the browser scaling the
  // canvas element, the flag covers drawImage scaling the pixels.
  assert(/image-rendering:pixelated/.test(editorSrc), 'the view canvas is not pixelated')
  assert(/imageSmoothingEnabled = false/.test(editorSrc), 'the drawing context smooths')

  // The palette seam is closed - the table landed and the editor reads it -
  // but the rule the seam existed to enforce did not go away with it: this
  // file may not hold an opinion about what a colour means. Every colour it
  // paints comes out of terrain-palette.js, and a hard-coded triple or a
  // colour-keyed table here would be a second, unreviewed palette.
  assert(/__SMLN_TERRAIN_PALETTE__/.test(editorSrc),
    'the editor no longer reads the palette module')
  assert(!/PLACEHOLDER_INK/.test(editorSrc),
    'the placeholder ink is still here, so the palette was never actually wired up')
  assert(!/\[\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*255\s*\]/.test(editorSrc),
    'the editor hard-codes an opaque colour instead of taking one from the palette')
  assert(!/['"]\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}['"]\s*:/.test(editorSrc),
    'the editor carries a colour-keyed table, which is the palette it was told not to invent')
  // Prose may describe the rules; a string or a key naming a material would be
  // the editor claiming to know what a colour means, which it still does not.
  assert(!/['"](stone|bedrock|dirt|sand|grass|water|lava)['"]/i.test(editorSrc) &&
    !/\b(stone|bedrock|dirt|grass|lava|sandium)\s*:/i.test(editorSrc),
    'the editor names a material, which is the defect the palette split exists to prevent')
  return 'registered, reachable, nearest-neighbour, and every colour still comes from the table'
})

// ----------------------------------------------------- map editor transforms
// Pure, DOM-free canvas transforms (src/renderer/mapeditor-transform.js) that
// the map editor uses to resize, crop, mirror and shift a document's six
// layers together. Required inline, right where it is used, rather than
// added to the require block above: several other checks are landing in this
// file at the same time, and this keeps the whole contribution to one edit at
// the end of the file instead of two edits in two places.
const mapTransform = require('../src/renderer/mapeditor-transform')

/** An 8x8 buffer whose pixel (x, y) is [x*10, y*10, 1, 255] - distinguishable
 * enough that a transform's exact output pixel proves which source pixel
 * (or which fill) ended up where. */
function makeTransformFixture() {
  const w = 8, h = 8
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      data[o] = x * 10; data[o + 1] = y * 10; data[o + 2] = 1; data[o + 3] = 255
    }
  }
  return { data, width: w, height: h }
}
function transformPixel(buf, x, y) {
  const o = (y * buf.width + x) * 4
  return [buf.data[o], buf.data[o + 1], buf.data[o + 2], buf.data[o + 3]]
}
function samePixel(a, b) { return a.length === 4 && b.length === 4 && a.every((v, i) => v === b[i]) }
function pixelStr(p) { return '[' + p.join(',') + ']' }
function throwsError(fn) {
  try { fn(); return null } catch (e) { return e.message }
}

const FILL = [9, 8, 7, 6]

check('resize grows and shrinks anchored to top-left', () => {
  const buf = makeTransformFixture()
  const before = Array.from(buf.data)

  const grown = mapTransform.resize(buf, 12, 10, 'top-left', FILL)
  assert(grown.width === 12 && grown.height === 10, `grown to ${grown.width}x${grown.height}`)
  assert(samePixel(transformPixel(grown, 0, 0), transformPixel(buf, 0, 0)),
    'top-left origin should stay put on growth: ' + pixelStr(transformPixel(grown, 0, 0)))
  assert(samePixel(transformPixel(grown, 7, 7), transformPixel(buf, 7, 7)),
    'existing content should be untouched: ' + pixelStr(transformPixel(grown, 7, 7)))
  assert(samePixel(transformPixel(grown, 11, 9), FILL),
    'new area should be filled: ' + pixelStr(transformPixel(grown, 11, 9)))
  assert(JSON.stringify(Array.from(buf.data)) === JSON.stringify(before), 'input mutated by resize (grow)')

  const shrunk = mapTransform.resize(buf, 4, 5, 'top-left', FILL)
  assert(shrunk.width === 4 && shrunk.height === 5, `shrunk to ${shrunk.width}x${shrunk.height}`)
  assert(samePixel(transformPixel(shrunk, 0, 0), transformPixel(buf, 0, 0)),
    'top-left origin should stay anchored on shrink')
  assert(samePixel(transformPixel(shrunk, 3, 4), transformPixel(buf, 3, 4)),
    'shrink should keep the top-left rect, not some other rect')
  assert(JSON.stringify(Array.from(buf.data)) === JSON.stringify(before), 'input mutated by resize (shrink)')
  return 'top-left anchor pins content on both growth and shrink'
})

check('resize grows and shrinks anchored to center', () => {
  const buf = makeTransformFixture()

  const grown = mapTransform.resize(buf, 12, 12, 'center', FILL)
  assert(samePixel(transformPixel(grown, 0, 0), FILL), 'corner should be fill after centered growth')
  assert(samePixel(transformPixel(grown, 2, 2), transformPixel(buf, 0, 0)),
    'origin should land 2 cells in after a 4-cell centered grow')
  assert(samePixel(transformPixel(grown, 9, 9), transformPixel(buf, 7, 7)),
    'far corner should land at the mirrored offset')

  const shrunk = mapTransform.resize(buf, 4, 4, 'center', FILL)
  assert(samePixel(transformPixel(shrunk, 0, 0), transformPixel(buf, 2, 2)),
    'centered shrink should keep the middle rect: ' + pixelStr(transformPixel(shrunk, 0, 0)))
  assert(samePixel(transformPixel(shrunk, 3, 3), transformPixel(buf, 5, 5)),
    'centered shrink far corner: ' + pixelStr(transformPixel(shrunk, 3, 3)))
  return 'center anchor keeps content centred through growth and shrink'
})

check('resize grows and shrinks anchored to bottom-right', () => {
  const buf = makeTransformFixture()

  const grown = mapTransform.resize(buf, 12, 10, 'bottom-right', FILL)
  assert(samePixel(transformPixel(grown, 11, 9), transformPixel(buf, 7, 7)),
    'bottom-right corner should stay pinned on growth')
  assert(samePixel(transformPixel(grown, 0, 0), FILL), 'new area should be at the top-left, filled')

  const shrunk = mapTransform.resize(buf, 4, 5, 'bottom-right', FILL)
  assert(samePixel(transformPixel(shrunk, 3, 4), transformPixel(buf, 7, 7)),
    'bottom-right corner should stay pinned on shrink')
  assert(samePixel(transformPixel(shrunk, 0, 0), transformPixel(buf, 4, 3)),
    'shrink should crop from the top-left, keeping the bottom-right rect')
  return 'bottom-right anchor pins the far corner through growth and shrink'
})

check('resize can grow one axis while shrinking the other', () => {
  const buf = makeTransformFixture()
  const out = mapTransform.resize(buf, 12, 4, 'top-right', FILL)
  assert(out.width === 12 && out.height === 4, `expected 12x4, got ${out.width}x${out.height}`)
  assert(samePixel(transformPixel(out, 4, 0), transformPixel(buf, 0, 0)),
    'width grew, so top-right keeps the source right-aligned: ' + pixelStr(transformPixel(out, 4, 0)))
  assert(samePixel(transformPixel(out, 11, 3), transformPixel(buf, 7, 3)),
    'far edge of the widened, shortened result')
  assert(samePixel(transformPixel(out, 0, 0), FILL), 'the widened side should be filled')
  return 'width grew and height shrank in the same call, independently'
})

check('resize requires fillRgba and rejects zero or negative dimensions', () => {
  const buf = makeTransformFixture()
  assert(throwsError(() => mapTransform.resize(buf, 10, 10, 'center')) !== null,
    'resize without fillRgba should throw')
  assert(throwsError(() => mapTransform.resize(buf, 10, 10, 'center', [1, 1, 1, 1])) === null,
    'resize with a valid fillRgba should not throw')
  const zeroMsg = throwsError(() => mapTransform.resize(buf, 0, 8, 'center', [1, 1, 1, 1]))
  assert(zeroMsg && zeroMsg.indexOf('0') !== -1, 'zero width should throw naming 0: ' + zeroMsg)
  const negMsg = throwsError(() => mapTransform.resize(buf, 8, -3, 'center', [1, 1, 1, 1]))
  assert(negMsg && negMsg.indexOf('-3') !== -1, 'negative height should throw naming -3: ' + negMsg)
  return 'missing fill, zero size and negative size are all rejected with a value-naming message'
})

check('crop reads inside, partly outside, and wholly outside the source', () => {
  const buf = makeTransformFixture()
  const before = Array.from(buf.data)

  const inside = mapTransform.crop(buf, 2, 2, 3, 3)
  assert(inside.width === 3 && inside.height === 3, `inside crop is ${inside.width}x${inside.height}`)
  assert(samePixel(transformPixel(inside, 0, 0), transformPixel(buf, 2, 2)), 'inside crop origin')
  assert(samePixel(transformPixel(inside, 2, 2), transformPixel(buf, 4, 4)), 'inside crop far corner')

  const partly = mapTransform.crop(buf, -2, -2, 5, 5)
  assert(samePixel(transformPixel(partly, 0, 0), [0, 0, 0, 0]),
    'the part outside the source should be transparent black: ' + pixelStr(transformPixel(partly, 0, 0)))
  assert(samePixel(transformPixel(partly, 2, 2), transformPixel(buf, 0, 0)),
    'the part inside the source should line up with it')
  assert(samePixel(transformPixel(partly, 4, 4), transformPixel(buf, 2, 2)), 'partly-outside far corner')

  const outside = mapTransform.crop(buf, 100, 100, 4, 4)
  for (let y = 0; y < outside.height; y++) {
    for (let x = 0; x < outside.width; x++) {
      assert(samePixel(transformPixel(outside, x, y), [0, 0, 0, 0]),
        `wholly-outside crop should be all transparent black, got ${pixelStr(transformPixel(outside, x, y))} at ${x},${y}`)
    }
  }

  assert(JSON.stringify(Array.from(buf.data)) === JSON.stringify(before), 'input mutated by crop')
  assert(throwsError(() => mapTransform.crop(buf, 0, 0, 0, 5)) !== null, 'crop with zero width should throw')
  assert(throwsError(() => mapTransform.crop(buf, 0, 0, 5, -1)) !== null, 'crop with negative height should throw')
  return 'inside, partly-outside and wholly-outside crops all landed correctly, no mutation'
})

check('mirrorX and mirrorY are each their own inverse', () => {
  const buf = makeTransformFixture()
  const before = Array.from(buf.data)

  const flippedX = mapTransform.mirrorX(buf)
  assert(!samePixel(transformPixel(flippedX, 0, 0), transformPixel(buf, 0, 0)) ||
    transformPixel(buf, 0, 0)[0] === transformPixel(buf, 7, 0)[0],
    'a single mirrorX should actually change something on a non-symmetric fixture')
  assert(samePixel(transformPixel(flippedX, 0, 0), transformPixel(buf, 7, 0)), 'mirrorX should flip columns')
  const backX = mapTransform.mirrorX(flippedX)
  assert(JSON.stringify(Array.from(backX.data)) === JSON.stringify(Array.from(buf.data)),
    'mirrorX twice should be the identity')

  const flippedY = mapTransform.mirrorY(buf)
  assert(samePixel(transformPixel(flippedY, 0, 0), transformPixel(buf, 0, 7)), 'mirrorY should flip rows')
  const backY = mapTransform.mirrorY(flippedY)
  assert(JSON.stringify(Array.from(backY.data)) === JSON.stringify(Array.from(buf.data)),
    'mirrorY twice should be the identity')

  assert(JSON.stringify(Array.from(buf.data)) === JSON.stringify(before), 'input mutated by mirrorX/mirrorY')
  return 'mirroring twice on either axis restores the original exactly'
})

check('shift moves content in both directions and discards what falls off the edge', () => {
  const buf = makeTransformFixture()
  const before = Array.from(buf.data)

  const right = mapTransform.shift(buf, 2, 3, FILL)
  assert(samePixel(transformPixel(right, 2, 3), transformPixel(buf, 0, 0)), 'shift should move the origin')
  assert(samePixel(transformPixel(right, 7, 7), transformPixel(buf, 5, 4)), 'shift should move the far corner')
  assert(samePixel(transformPixel(right, 0, 0), FILL), 'vacated space should be filled')
  assert(JSON.stringify(Array.from(buf.data)) === JSON.stringify(before), 'input mutated by shift')

  const left = mapTransform.shift(buf, -3, -2, FILL)
  assert(samePixel(transformPixel(left, 0, 0), transformPixel(buf, 3, 2)), 'negative shift should move content back')
  assert(samePixel(transformPixel(left, 7, 7), FILL), 'space vacated by a negative shift should be filled')

  const overshoot = mapTransform.shift(buf, 100, 100, FILL)
  let allFill = true
  for (let y = 0; y < overshoot.height && allFill; y++) {
    for (let x = 0; x < overshoot.width && allFill; x++) {
      if (!samePixel(transformPixel(overshoot, x, y), FILL)) allFill = false
    }
  }
  assert(allFill, 'a shift larger than the buffer should leave nothing but fill')

  assert(throwsError(() => mapTransform.shift(buf, 1, 1)) !== null, 'shift without fillRgba should throw')
  return 'shift moves content both ways, discards overflow, and a large-enough shift is all fill'
})

// -------------------------------------------------------- mission/story SDK
/**
 * The mission SDK in a VM, against fakes of the two tables the real game
 * carries - never against the live game, which only the controller can start.
 *
 * Both fakes are shaped from the measurements in
 * .superpowers/sdd/missions-investigation.md: the objectives definition table
 * (`qs`, reached through webpack module 92659, not frozen, extensible) with
 * the game's own completer transcribed from the bundle, and the story-step
 * list, which hands back the same array reference on every call. The SDK
 * reaches both exactly as it does in the game - through SMLN.webpack - so the
 * bridge is under test too, not stubbed out.
 */
function bootStory(opts = {}) {
  const env = { state: null, logs: [], completions: [] }

  const qs = Object.assign({
    research_hover: {
      titleKey: 'objectives|researchHover|title',
      descriptionKey: 'objectives|researchHover|description',
      nextObjectives: ['research_flamethrower'],
      check: (s) => !!s,
    },
    find_fluxite: {
      titleKey: 'objectives|findFluxite|title',
      descriptionKey: 'objectives|findFluxite|description',
    },
  }, opts.extraObjectives || {})

  /** The live active list, wherever the current state keeps it. */
  function active() {
    const o = env.state && env.state.store && env.state.store.objectives
    return (o && o.active) || []
  }

  // The game's own completer, transcribed from the bundle: it refuses an id
  // that is not a key of the table, and an id that is not in the active list.
  function EM(state, id) {
    const n = active().find((e) => e.id === id)
    if (!n || n.completed) return false
    const a = qs[id]
    if (!a) return false
    n.completed = true
    n.completedAt = Date.now()
    for (const next of a.nextObjectives || []) {
      if (!active().some((e) => e.id === next)) active().push({ id: next, completed: false })
    }
    return true
  }

  const objectivesModule = {
    qs,
    EM,
    Ku: 5000,
    bS: (state) => {
      for (const r of active().slice()) {
        const o = qs[r.id]
        if (!r.completed && o && o.check && o.check(state)) EM(state, r.id)
      }
    },
    Rp: (state, id) => {
      if (qs[id] && !active().some((e) => e.id === id)) active().push({ id, completed: false })
    },
    J_: (state, id) => {
      const i = active().findIndex((e) => e.id === id)
      if (i >= 0) active().splice(i, 1)
    },
  }

  /*
   * The story-step half of the fake.
   *
   * getSteps() hands back the same array reference every call, and setSteps()
   * replaces it - which is what a world load looks like, because the game
   * calls setSteps from its own `mods:initialized` handler every time. The
   * three helpers that matter are transcribed from the bundle: DA (start a
   * step, which refuses one already done or already current and evaluates a
   * custom check straight away), LA (complete one - the chain is array order
   * and nothing else) and BA (re-evaluate the current step's custom check),
   * plus the one event subscription whose whole body is a call to BA.
   */
  const vanillaStep = (id, objective) => ({
    id,
    messages: [{ text: { key: 'story|steps|' + id + '|message1' }, showObjective: true }],
    objective,
  })
  const vanillaSteps = () => [
    vanillaStep('reach_factory_tier_2', { type: 'factoryLevel', target: 2 }),
    vanillaStep('investigate_anomaly', { type: 'waypoint', radius: 600 }),
    vanillaStep('resume_factory_expansion', { type: 'factoryLevel', target: 4 }),
  ]
  let stepList = vanillaSteps()

  const bag = () => {
    const st = env.state.store
    st.mods = st.mods || {}
    return st.mods.storyProgression || (st.mods.storyProgression = {})
  }
  const doneList = () => {
    const b = bag()
    return Array.isArray(b.completedSteps) ? b.completedSteps : (b.completedSteps = [])
  }
  const isDone = (id) => doneList().indexOf(id) >= 0
  const stepById = (id) => stepList.find((s) => s.id === id)
  const currentStep = () => {
    const id = bag().currentStep
    return (id && stepById(id)) || null
  }

  // BA
  function evaluateCurrent() {
    const c = currentStep()
    if (!c || isDone(c.id)) return
    const o = c.objective
    if (o && o.type === 'custom' && typeof o.check === 'function' && o.check(env.state)) {
      completeStep(c.id)
    }
  }
  // DA
  function startStep(id) {
    const b = bag()
    if (isDone(id) || b.currentStep === id) return
    const s = stepById(id)
    if (!s) return
    b.currentStep = s.id
    env.started.push(s.id)
    evaluateCurrent()
  }
  // LA
  function completeStep(id) {
    const b = bag()
    const done = doneList()
    if (done.indexOf(id) < 0) done.push(id)
    const i = stepList.findIndex((s) => s.id === id)
    if (i >= 0 && i < stepList.length - 1) {
      const next = stepList[i + 1]
      if (next.messages && next.messages.length) {
        if (!isDone(next.id)) env.shown.push(next.id)
      } else startStep(next.id)
    } else b.currentStep = null
  }

  const i18n = {}
  const handlers = {}
  const progression = {
    getSteps: () => stepList,
    setSteps: (a) => { stepList = a },
    isStepCompleted: (state, id) => isDone(id),
    getCurrentStep: () => currentStep(),
    // The public gate, verbatim: the domain, the id, and membership of the
    // private table - which is the whole reason the SDK writes into it.
    complete: (state, sel) => {
      if (!sel || sel.domain !== 'objective' || typeof sel.id !== 'string') return false
      env.completions.push(sel.id)
      return Object.prototype.hasOwnProperty.call(qs, sel.id) && EM(state, sel.id)
    },
  }
  const sandkitApi = {
    i18n: {
      register: (locale, table) => { i18n[locale] = Object.assign(i18n[locale] || {}, table) },
      getLocale: () => 'en',
    },
    progression,
  }
  const FH = {
    ui: { update: () => {} },
    events: {
      on: (state, name, fn) => { (handlers[name] || (handlers[name] = [])).push(fn) },
      emit: (state, name, payload) => {
        env.emitted.push(name)
        for (const fn of (handlers[name] || []).slice()) fn(state, payload)
      },
    },
    storage: { ensure: (state, key) => { const m = state.store.mods || (state.store.mods = {}); return m[key] || (m[key] = {}) } },
    progression,
  }
  // The story mod's own subscription. Its whole body in the shipped bundle is
  // `BA(e)` plus a UI refresh, and it is the only listener this event has.
  FH.events.on(null, 'auralite:productionChanged', () => { evaluateCurrent() })

  const modules = { 92659: objectivesModule }
  const req = (id) => {
    const m = modules[String(id)]
    if (!m) throw new Error('no module ' + id)
    return m
  }
  req.m = modules

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    // The game's chunk array: pushing a chunk hands the callback the real
    // __webpack_require__, which is how src/renderer/webpack-bridge.js gets in.
    webpackChunksand_v1: { push(chunk) { if (chunk && typeof chunk[2] === 'function') chunk[2](req) } },
    __SMLN_MODS__: opts.mods || [],
    // What the main process reports about its own patch anchors, injected by
    // the prelude. A build where the speaker patch did not resolve says so
    // here, which is how the SDK can refuse at once rather than on a timeout.
    __SMLN_BOOT__: opts.brokenSpeakerPatch
      ? { anchors: { holding: 0, healed: [], broken: [{ id: 'smln:story-speakers', required: false }] } }
      : null,
    electron: { log: (level, scope, message) => env.logs.push(level + ': ' + message) },
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  vm.createContext(sandbox)
  for (const part of ['runtime.js', 'capabilities.js', 'webpack-bridge.js', 'story-sdk.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', part), 'utf8')
    new vm.Script(src, { filename: part }).runInContext(sandbox)
  }

  const S = sandbox.__SMLN__
  env.S = S
  env.qs = qs
  env.i18n = i18n
  env.active = active
  env.started = []
  env.shown = []
  env.emitted = []
  Object.defineProperty(env, 'steps', { get: () => stepList })
  env.vanillaStepCount = stepList.length
  env.bag = () => bag()
  /** The game's own setSteps at world load: the array is rebuilt from scratch. */
  env.resetSteps = () => { progression.setSteps(vanillaSteps()) }
  /** The player finished a beat; the chain advances. */
  env.completeStep = (id) => completeStep(id)
  /** The player dismissed the box, which is what starts the step. */
  env.dismiss = (id) => startStep(id)
  /** The game's tutorial:completed handler: show the first uncompleted step. */
  env.tutorialCompleted = () => {
    const done = doneList()
    const first = stepList.find((s) => !done.includes(s.id))
    if (first) env.shown.push(first.id)
    return first ? first.id : null
  }
  /*
   * What src/patch/core-patches.js leaves behind: one shared table on the
   * global, with the game's own two entries assigned on top of it. Absent
   * unless asked for, so a test can run against a build where the patch is
   * not there.
   */
  env.speakerTable = () => S.storySpeakers || null
  if (opts.speakerTable !== false) {
    Object.assign(S.storySpeakers || (S.storySpeakers = {}), {
      zoe: { portrait: 'img/cool_cat2.png', labelKey: 'story|speaker|zoe', borderColor: '#ffe700', labelColor: '#ffe700' },
      pri: { portrait: 'img/archon.png', labelKey: 'story|speaker|pri', borderColor: '#ffe700', labelColor: '#ffe700' },
    })
  }
  // The asset resolver registration.js installs, stubbed to its contract so a
  // portrait path can be exercised without dragging that whole part in.
  if (opts.assets !== false) {
    S.assets = { forMod: (id) => ({ tryUrl: (rel) => 'smln-mods/' + id + '/' + rel }) }
  }
  /** A world load: a fresh store, and the capture the game's patch performs. */
  env.load = (store, phase) => {
    env.state = { store, sandkit: { getApi: () => sandkitApi } }
    S.__capture(FH, env.state, phase || 'game:started')
    return env.state
  }
  env.load(opts.store || { objectives: { active: [] } }, 'game:ready')
  return env
}

check('mission ids are namespaced per mod, and vanilla ids stay bare', () => {
  const env = bootStory({ mods: [{ id: 'my.mod', enabled: true }] })
  const story = env.S.forMod('my.mod').story
  assert(story, 'SMLN.forMod(id).story is missing')
  const vanilla = env.qs.find_fluxite

  const ok = story.objective({
    id: 'find_fluxite',
    title: 'Find fluxite',
    description: 'Locate a vein in the deep layer',
    next: ['find_fluxite', 'refine'],
  })
  assert(ok === true, 'the objective was refused')

  const def = env.qs['my.mod:find_fluxite']
  assert(def, 'nothing landed in the table under the namespaced id')
  assert(env.qs.find_fluxite === vanilla, "the game's own entry was overwritten")

  // A bare vanilla id still means the game's; a bare unknown id means the
  // registering mod's. That split is what makes cross-mod references honest.
  assert(def.nextObjectives[0] === 'find_fluxite',
    'a bare vanilla id was namespaced: ' + def.nextObjectives[0])
  assert(def.nextObjectives[1] === 'my.mod:refine',
    'a bare mod id was not namespaced: ' + def.nextObjectives[1])

  // The predicate deliberately stays out of the game's table: the shipped
  // evaluator does not catch, so a throw there would land in game code.
  assert(!def.check, "the mod's predicate was written into the game's own table")
  assert(env.i18n.en[def.titleKey] === 'Find fluxite', 'the title never reached i18n')

  // A definition missing the one thing it is for must be refused by name
  // rather than half-registered, and a refusal must leave the step list alone.
  assert(story.speaker('kira', { name: 'KIRA' }) === false, 'a speaker with no portrait was accepted')
  assert(story.step({ id: 'intro' }) === false, 'a step with no messages was accepted')
  assert(env.steps.length === env.vanillaStepCount, 'a refused step reached the story-step table')

  // A chain naming something nobody registered would sit in the active list as
  // a raw id forever, uncompletable, so it is reported rather than left to be
  // discovered in-game.
  env.S.__story.tick()
  const dangling = env.logs.find((l) => /chains to "my\.mod:refine"/.test(l))
  assert(dangling && /my\.mod/.test(dangling),
    'a chain to an id nothing registered was not reported: ' + env.logs.join(' | '))

  env.S.__story.stop()
  return 'registered as my.mod:find_fluxite; vanilla entry and step list untouched; dangling chain reported'
})

check('an objective that would collide with a key SandLoader did not create is refused', () => {
  const env = bootStory({
    mods: [{ id: 'my.mod', enabled: true }],
    // A key that was already in the table when the SDK first read it. In the
    // shipped build every such key is the game's; the rule is the same either
    // way - a key we did not create is not ours to overwrite.
    extraObjectives: { 'my.mod:taken': { titleKey: 'someone else|title' } },
  })
  const story = env.S.forMod('my.mod').story
  const before = env.qs['my.mod:taken']

  assert(story.objective({ id: 'taken', title: 'Mine now' }) === false,
    'the SDK overwrote a key it did not create')
  assert(env.qs['my.mod:taken'] === before, 'the existing entry was replaced anyway')
  assert(env.logs.some((l) => /E_STORY_VANILLA_ID/.test(l)),
    'the refusal was not named: ' + env.logs.join(' | '))

  // A mod may not write its own namespace separator either - that is the one
  // way it could aim at another mod's ids, or at a vanilla one.
  assert(story.objective({ id: 'other.mod:goal', title: 'Theirs' }) === false,
    'a mod was allowed to register into another namespace')
  assert(env.logs.some((l) => /E_STORY_BAD_ID/.test(l)), 'the bad id was not named')
  assert(!env.qs['other.mod:goal'], 'the foreign id landed in the table')

  env.S.__story.stop()
  return 'a pre-existing key and a hand-written namespace are both refused by name'
})

check('an objective whose required mod is absent or disabled is not registered', () => {
  const env = bootStory({
    mods: [
      { id: 'my.mod', enabled: true },
      { id: 'gas-pipes', enabled: false },
      { id: 'ready-mod', enabled: true },
    ],
  })
  const story = env.S.forMod('my.mod').story

  assert(story.objective({ id: 'a', title: 'A', requires: ['ghost-mod'] }) === false,
    'an objective requiring a mod that is not installed was registered')
  assert(story.objective({ id: 'b', title: 'B', requires: ['gas-pipes'] }) === false,
    'an objective requiring a disabled mod was registered')
  assert(story.objective({ id: 'c', title: 'C', requires: ['ready-mod'] }) === true,
    'a satisfied dependency was refused')

  assert(!env.qs['my.mod:a'] && !env.qs['my.mod:b'], 'a refused objective reached the table')
  assert(env.qs['my.mod:c'], 'the satisfied one is missing')

  // Both mods have to be named, or the player is told a mission is broken
  // without being told what to install.
  const absent = env.logs.find((l) => /ghost-mod/.test(l))
  const disabled = env.logs.find((l) => /gas-pipes/.test(l))
  assert(absent && /my\.mod/.test(absent) && /not installed/.test(absent),
    'the missing dependency was not reported with both mods: ' + absent)
  assert(disabled && /my\.mod/.test(disabled) && /disabled/.test(disabled),
    'the disabled dependency was not reported with both mods: ' + disabled)

  env.S.__story.stop()
  return 'absent and disabled both refused, naming the mod and the requirement'
})

check('the SDK ticks its own predicates and completes through the game\'s own gate', () => {
  const env = bootStory({ mods: [{ id: 'my.mod', enabled: true }] })
  const story = env.S.forMod('my.mod').story
  let fluxite = 0
  story.objective({ id: 'find-fluxite', title: 'Find fluxite', check: () => fluxite > 0 })

  env.S.__story.tick()
  const row = env.active().find((e) => e.id === 'my.mod:find-fluxite')
  assert(row, 'the objective was never added to the active list, so nothing can show or complete it')
  assert(story.isComplete('find-fluxite') === false, 'complete before the predicate was true')

  fluxite = 1
  env.S.__story.tick()
  assert(story.isComplete('find-fluxite') === true, 'the tick did not complete the objective')
  assert(row.completed === true, "the game's own completion was not driven")
  assert(env.completions.indexOf('my.mod:find-fluxite') >= 0,
    'the public progression.complete gate was bypassed')
  const saved = env.state.store[env.S.__story.storeKey]
  assert(saved && saved.completed['my.mod:find-fluxite'],
    'nothing was written to the saved half of the state')

  // Bounded cadence, not per frame.
  assert(env.S.__story.tickMs >= 250, 'the tick interval is ' + env.S.__story.tickMs + 'ms')

  env.S.__story.stop()
  return 'predicate ticked, completed through progression.complete, recorded in the save'
})

check('a predicate that throws is switched off by name, and never takes another mod down', () => {
  const env = bootStory({
    mods: [{ id: 'bad.mod', enabled: true }, { id: 'good.mod', enabled: true }],
  })
  const bad = env.S.forMod('bad.mod').story
  const good = env.S.forMod('good.mod').story
  bad.objective({ id: 'boom', title: 'Boom', check: () => { throw new Error('predicate exploded') } })
  good.objective({ id: 'fine', title: 'Fine', check: () => true })

  // The tick itself must not throw, however many times the bad one does.
  for (let i = 0; i < 5; i++) env.S.__story.tick()

  assert(good.isComplete('fine') === true, "one mod's broken predicate stopped another mod's")
  const entry = env.S.__story.entries().find((e) => e.fullId === 'bad.mod:boom')
  assert(entry && entry.disabled, 'the throwing predicate was never switched off')
  assert(entry.throws === env.S.__story.maxThrows,
    'expected ' + env.S.__story.maxThrows + ' attempts, got ' + entry.throws)
  assert(bad.isComplete('boom') === false, 'a throwing predicate completed something')

  const named = env.logs.find((l) => /switched off/.test(l))
  assert(named && /bad\.mod/.test(named) && /predicate exploded/.test(named),
    'the failure was not reported with its mod id and its reason: ' + named)

  env.S.__story.stop()
  return 'disabled after ' + entry.throws + ' throws, reported with its mod id, neighbours unaffected'
})

check('a completed objective survives a world reload, and does not leak into another save', () => {
  const env = bootStory({ mods: [{ id: 'my.mod', enabled: true }] })
  const story = env.S.forMod('my.mod').story
  let done = true
  story.objective({ id: 'find-fluxite', title: 'Find fluxite', check: () => done })
  env.S.__story.tick()
  assert(story.isComplete('find-fluxite') === true, 'it never completed in the first place')

  // The save is `state.store`, written wholesale - so a JSON round trip is
  // exactly what the completion has to survive.
  const save = JSON.parse(JSON.stringify(env.state.store))
  // World load, as the game does it: every completed entry is filtered out of
  // the active list and nothing anywhere remembers it was ever finished.
  save.objectives.active = save.objectives.active.filter((e) => !e.completed)
  done = false
  env.load(save)
  env.S.__story.tick()

  assert(story.isComplete('find-fluxite') === true,
    'the completion did not survive the reload')
  assert(!env.active().some((e) => e.id === 'my.mod:find-fluxite'),
    'a finished objective was pushed back into the active list as unfinished')

  // A different world is a different set. Carrying one save's completions into
  // another would hand the player missions they never did.
  env.load({ objectives: { active: [] } })
  env.S.__story.tick()
  assert(story.isComplete('find-fluxite') === false,
    "one save's completions leaked into another")

  env.S.__story.stop()
  return 'restored from the save before the first evaluation, and scoped to that save'
})

check('a mission event is namespaced by its emitter and any mod can hear it', () => {
  const env = bootStory({
    mods: [{ id: 'reactor.mod', enabled: true }, { id: 'mission.pack', enabled: true }],
  })
  const reactor = env.S.forMod('reactor.mod').story
  const pack = env.S.forMod('mission.pack').story
  const heard = []
  pack.on('reactor.mod:reactor-online', (p) => heard.push(p))

  reactor.emit('reactor-online', { power: 42 })
  assert(heard.length === 1 && heard[0].power === 42,
    'the listener never heard the namespaced event: ' + JSON.stringify(heard))

  // Nothing is listening for the unqualified name, which is the point: the
  // emitter cannot collide with another mod's event of the same name.
  const bare = []
  env.S.on('reactor-online', (p) => bare.push(p))
  reactor.emit('reactor-online', {})
  assert(bare.length === 0, 'the event was published without its namespace')
  assert(heard.length === 2, 'the second emit was lost')

  // The subscription goes through the facade, so it is reclaimed with its mod.
  env.S.__disposeMod('mission.pack')
  reactor.emit('reactor-online', {})
  assert(heard.length === 2, 'the listener outlived the mod that made it')

  env.S.__story.stop()
  return 'published as reactor.mod:reactor-online, heard cross-mod, dropped on unload'
})

check('unloading a mod takes its objectives out of the game\'s table and out of the active list', () => {
  const env = bootStory({ mods: [{ id: 'my.mod', enabled: true }] })
  const story = env.S.forMod('my.mod').story
  story.objective({ id: 'find-fluxite', title: 'Find fluxite', check: () => false })
  env.S.__story.tick()
  assert(env.qs['my.mod:find-fluxite'], 'it never registered')
  assert(env.active().some((e) => e.id === 'my.mod:find-fluxite'), 'it never became active')

  env.S.__disposeMod('my.mod')

  assert(!env.qs['my.mod:find-fluxite'], "the mod's definition stayed in the game's table")
  // An id left in a save whose mod is gone is permanent: the game refuses to
  // complete an id its table no longer defines, so the row can never clear.
  assert(!env.active().some((e) => e.id === 'my.mod:find-fluxite'),
    'an orphan id was left in the active list of the save')
  assert(env.qs.find_fluxite && env.qs.research_hover, 'disposal took a vanilla entry with it')
  assert(env.S.__story.entries().length === 0, 'the SDK still thinks it owns something')

  env.S.__story.stop()
  return 'definition and active row both removed, vanilla table intact'
})

// ------------------------------------------------------ story: the patch
check('the speaker patch gives the portrait table one identity, and the bundle still parses', () => {
  const patch = corePatches.find((p) => p.id === 'smln:story-speakers')
  assert(patch, 'smln:story-speakers is missing from corePatches')
  assert(patch.required === false,
    'the speaker patch is required, so a build that reshapes one literal would refuse to start')

  // Against the real shipped bundle: the anchor has to resolve exactly once,
  // because a pattern that became ambiguous would rewrite several places.
  const outcome = engine.verify(bundle, [patch])[0]
  assert(outcome.matches === 1, `the anchor matched ${outcome.matches} times, not 1`)

  // And against the real declaration, in a VM, because "it parses" is not the
  // property that matters here - sharing the object is. The excerpt is the
  // shipped `const mN={...};` lifted out of the bundle by its own anchor.
  const at = bundle.indexOf('labelKey:"story|speaker|zoe"')
  const start = bundle.lastIndexOf('const ', at)
  const end = bundle.indexOf(';', at) + 1
  const original = bundle.slice(start, end)
  assert(/^const [A-Za-z_$][\w$]*=\{/.test(original), 'the excerpt is not the declaration: ' + original)

  const result = engine.apply(original, [patch])
  assert(result.ok, result.error ? String(result.error) : 'apply failed')
  const name = original.slice(6, original.indexOf('='))
  const box = { __SMLN__: { alreadyHere: true } }
  vm.createContext(box)
  new vm.Script(result.source + `;globalThis.__probe=${name};`, { filename: 'speakers.js' }).runInContext(box)

  assert(box.__SMLN__.alreadyHere === true, 'the patch replaced the runtime object instead of using it')
  const shared = box.__SMLN__.storySpeakers
  assert(shared && box.__probe === shared,
    'the module const and the global table are not the same object, so a mod could never write into it')
  assert(shared.zoe && shared.zoe.portrait === 'img/cool_cat2.png',
    "the game's own speakers did not survive the rewrite")
  assert(shared.pri && shared.pri.labelKey === 'story|speaker|pri', 'PRI did not survive the rewrite')

  // A mod that registered before this line ran must not be wiped by it, and
  // must not be able to have deleted ZOE either.
  const box2 = { __SMLN__: { storySpeakers: { 'my.mod:kira': { portrait: 'k.png' } } } }
  vm.createContext(box2)
  new vm.Script(result.source, { filename: 'speakers.js' }).runInContext(box2)
  assert(box2.__SMLN__.storySpeakers['my.mod:kira'], 'an early registration was wiped by the vanilla assign')
  assert(box2.__SMLN__.storySpeakers.zoe, 'ZOE is missing after an early registration')

  return `anchor matched once in ${(bundle.length / 1048576).toFixed(2)} MiB; module const and SMLN.storySpeakers are one object`
})

// ---------------------------------------------------------- story: speakers
check('a speaker is namespaced, keeps the game\'s two, and refuses when the patch is absent', () => {
  const env = bootStory({ mods: [{ id: 'my.mod', enabled: true }] })
  const story = env.S.forMod('my.mod').story
  const png = 'data:image/png;base64,iVBORw0KGgo='

  assert(story.speaker('kira', { name: 'KIRA', portrait: png, color: '#8ec5ff' }) === true,
    'the speaker was refused')
  const table = env.speakerTable()
  const entry = table['my.mod:kira']
  assert(entry, 'nothing landed in the portrait table under the namespaced id')
  assert(entry.portrait === png, 'a data URL was not passed through: ' + entry.portrait)
  assert(entry.borderColor === '#8ec5ff' && entry.labelColor === '#8ec5ff', 'the colour was dropped')
  assert(env.i18n.en[entry.labelKey] === 'KIRA', 'the name never reached i18n')
  assert(table.zoe && table.pri, "the game's own speakers were disturbed")

  // A mod-relative path goes through the same asset resolver every other mod
  // file does, rather than being pasted into an <img src> untouched.
  assert(story.speaker('rell', { name: 'RELL', portrait: 'assets/rell.png' }) === true, 'a path portrait was refused')
  assert(table['my.mod:rell'].portrait === 'smln-mods/my.mod/assets/rell.png',
    'the portrait path was not resolved through the mod asset resolver: ' + table['my.mod:rell'].portrait)

  // No portrait is the one thing a speaker cannot do without.
  assert(story.speaker('ghost', { name: 'GHOST' }) === false, 'a speaker with no portrait was registered')
  assert(env.logs.some((l) => /E_STORY_NO_PORTRAIT/.test(l)), 'the refusal was not named')

  env.S.__story.stop()

  // The build where the patch did not apply. An unregistered speaker is drawn
  // as ZOE with no error anywhere, so registering one here would be the exact
  // silent failure the SDK exists to prevent.
  const broken = bootStory({
    mods: [{ id: 'my.mod', enabled: true }],
    speakerTable: false,
    brokenSpeakerPatch: true,
  })
  const bs = broken.S.forMod('my.mod').story
  assert(bs.speaker('kira', { name: 'KIRA', portrait: png }) === false,
    'a speaker was registered on a build with no portrait table')
  assert(broken.S.__story.speakers().length === 0, 'the SDK thinks it registered a speaker anyway')
  const named = broken.logs.find((l) => /E_STORY_NO_SPEAKER_TABLE/.test(l))
  assert(named && /smln:story-speakers/.test(named) && /ZOE/.test(named),
    'the refusal did not name the patch and what the silence would have looked like: ' + named)
  broken.S.__story.stop()

  return 'registered as my.mod:kira with its own portrait and colour; refused by name where the patch is absent'
})

check('a speaker no one registered is reported rather than quietly drawn as ZOE', () => {
  const env = bootStory({ mods: [{ id: 'my.mod', enabled: true }] })
  const story = env.S.forMod('my.mod').story
  story.step({
    id: 'intro',
    messages: [
      { text: 'The readings are wrong.', speaker: 'zoe' },
      { text: 'They are not.', speaker: 'nobody' },
    ],
  })
  env.S.__story.tick()

  const step = env.steps.find((s) => s.id === 'my.mod:intro')
  assert(step, 'the step never landed')
  // A bare vanilla speaker still means the game's own and cannot be shadowed;
  // a bare unknown one is this mod's namespace, which is where it would have
  // been had the mod registered it.
  assert(step.messages[0].speaker === 'zoe', 'a vanilla speaker was namespaced: ' + step.messages[0].speaker)
  assert(step.messages[1].speaker === 'my.mod:nobody', 'a mod speaker was not namespaced')

  const warned = env.logs.find((l) => /names speaker "my\.mod:nobody"/.test(l))
  assert(warned && /ZOE/.test(warned), 'an unregistered speaker was not reported: ' + env.logs.join(' | '))

  env.S.__story.stop()
  return 'vanilla speaker left bare, mod speaker namespaced, the unregistered one reported'
})

// ------------------------------------------------------------- story: steps
check('a step is inserted where after names it, and the chain still leads through it', () => {
  const env = bootStory({ mods: [{ id: 'my.mod', enabled: true }] })
  const story = env.S.forMod('my.mod').story
  const before = env.steps.map((s) => s.id)

  assert(story.step({
    id: 'intro',
    after: 'reach_factory_tier_2',
    messages: [
      { text: 'The readings are wrong.', speaker: 'zoe' },
      { text: 'They are not.', speaker: 'zoe', style: { color: '#88aaff', italic: true } },
    ],
  }) === true, 'the step was refused')

  const ids = env.steps.map((s) => s.id)
  assert(ids[1] === 'my.mod:intro', 'the step is not directly after the one it named: ' + ids.join(','))
  assert(ids[0] === before[0] && ids[2] === before[1] && ids[3] === before[2],
    'insertion reordered the game\'s own steps: ' + ids.join(','))

  const step = env.steps[1]
  // The game's own message vocabulary, not a parallel one: a literal became a
  // registered key in the shape the game's resolver understands, and the style
  // went through untouched.
  assert(step.messages[0].text && step.messages[0].text.key, 'the message text is not a translatable reference')
  assert(env.i18n.en[step.messages[0].text.key] === 'The readings are wrong.', 'the literal never reached i18n')
  assert(step.messages[1].style.color === '#88aaff', 'the style was rewritten')
  assert(step.messages[1].showObjective === true,
    'no message shows the objective, so the step could never become current')

  // Chaining is array order and nothing else, so the proof is that the game's
  // own completion of the previous step arrives at ours, and ours arrives at
  // the one that used to follow.
  env.completeStep('reach_factory_tier_2')
  assert(env.shown[env.shown.length - 1] === 'my.mod:intro',
    'completing the previous step did not lead into the mod\'s: ' + env.shown.join(','))
  env.dismiss('my.mod:intro')
  env.S.__story.tick()
  assert(env.bag().completedSteps.indexOf('my.mod:intro') >= 0, 'the beat never completed')
  assert(env.shown[env.shown.length - 1] === 'investigate_anomaly',
    'the chain did not lead out of the mod\'s step into the next vanilla one: ' + env.shown.join(','))

  env.S.__story.stop()
  return 'inserted at index 1; the chain runs reach_factory_tier_2 -> my.mod:intro -> investigate_anomaly'
})

check('a step waits for an after that has not registered yet, and gives up by name if it never does', () => {
  const env = bootStory({
    mods: [{ id: 'late.mod', enabled: true }, { id: 'early.mod', enabled: true }],
  })
  const early = env.S.forMod('early.mod').story
  const late = env.S.forMod('late.mod').story

  // Declared before the thing it is ordered against. Load order is not
  // something a mod author can control, so it must not decide the outcome.
  assert(early.step({
    id: 'reply', after: 'late.mod:opening', messages: [{ text: 'Understood.' }],
  }) === true, 'a step naming an unregistered step was refused outright')
  assert(!env.steps.some((s) => s.id === 'early.mod:reply'), 'it was inserted before its anchor existed')
  assert(env.S.__story.pendingSteps() === 1, 'it is not waiting for anything')

  assert(late.step({
    id: 'opening', after: 'reach_factory_tier_2', messages: [{ text: 'Listen.' }],
  }) === true, 'the anchor step was refused')

  const ids = env.steps.map((s) => s.id)
  assert(ids[1] === 'late.mod:opening' && ids[2] === 'early.mod:reply',
    'the waiting step did not land after the anchor that finally arrived: ' + ids.join(','))
  assert(env.S.__story.pendingSteps() === 0, 'something is still waiting')

  // A reference nothing ever registers is reported once, by name, and the beat
  // is put at the end rather than silently thrown away.
  assert(early.step({
    id: 'orphan', after: 'never.mod:ghost', messages: [{ text: 'Hello?' }],
  }) === true, 'a step naming a missing mod was refused outright')
  for (let i = 0; i < env.S.__story.deferTicks + 4; i++) env.S.__story.tick()

  // The SDK's own log line, not the copy `report` also files as a problem.
  const complaints = env.logs.filter((l) => /^warn: story /.test(l) && /never\.mod:ghost/.test(l))
  assert(complaints.length === 1,
    'a reference that never registers was reported ' + complaints.length + ' times, not once')
  assert(/early\.mod/.test(complaints[0]) && /end of the story/.test(complaints[0]),
    'the report does not name the mod and where the step went: ' + complaints[0])
  const after = env.steps.map((s) => s.id)
  assert(after[after.length - 1] === 'early.mod:orphan', 'the orphan step was dropped: ' + after.join(','))

  env.S.__story.stop()
  return 'inserted when its anchor arrived; a reference that never arrived reported once and appended'
})

check('a mod\'s beat does not play twice across a world reload', () => {
  const env = bootStory({ mods: [{ id: 'my.mod', enabled: true }] })
  const story = env.S.forMod('my.mod').story
  let ready = false
  story.step({
    id: 'intro',
    after: 'reach_factory_tier_2',
    messages: [{ text: 'The readings are wrong.', speaker: 'zoe' }],
    completeWhen: () => ready,
  })

  env.completeStep('reach_factory_tier_2')
  env.dismiss('my.mod:intro')
  env.S.__story.tick()
  assert(story.isStepComplete('intro') === false, 'it completed before its condition was true')

  ready = true
  env.S.__story.tick()
  assert(env.emitted.indexOf(env.S.__story.nudgeEvent) >= 0,
    "the SDK did not drive the game's own evaluator")
  assert(story.isStepComplete('intro') === true, 'the tick did not complete the step')
  assert(env.bag().completedSteps.indexOf('my.mod:intro') >= 0,
    "the game's own record does not know the step is done")
  const saved = env.state.store[env.S.__story.storeKey]
  assert(saved && saved.steps && saved.steps['my.mod:intro'], 'nothing was written to the saved half')

  const playedOnce = env.shown.filter((id) => id === 'my.mod:intro').length
  assert(playedOnce === 1, 'the beat was shown ' + playedOnce + ' times before the reload')

  // The reload, as the game does it: the store is written wholesale, and the
  // game's own mods:initialized handler rebuilds the step array from its
  // private literal - which does not contain the mod's entry.
  const save = JSON.parse(JSON.stringify(env.state.store))
  env.resetSteps()
  ready = false
  env.load(save)
  env.S.__story.tick()

  assert(env.steps.map((s) => s.id)[1] === 'my.mod:intro',
    'the step was not put back after setSteps rebuilt the array: ' + env.steps.map((s) => s.id).join(','))
  assert(story.isStepComplete('intro') === true, 'the completion did not survive the reload')
  env.tutorialCompleted()
  assert(env.shown.filter((id) => id === 'my.mod:intro').length === 1,
    'the beat played again after the reload')
  assert(env.shown[env.shown.length - 1] === 'investigate_anomaly',
    'the story resumed at the wrong step: ' + env.shown.join(','))

  // A different world is a different story.
  env.load({ objectives: { active: [] } })
  env.S.__story.tick()
  assert(story.isStepComplete('intro') === false, "one save's beats leaked into another")

  env.S.__story.stop()
  return 'completed through the game\'s own path, restored after the reload, and never shown twice'
})

check('unloading a mod takes its steps and speakers out and heals the chain behind them', () => {
  const env = bootStory({ mods: [{ id: 'my.mod', enabled: true }] })
  const story = env.S.forMod('my.mod').story
  story.speaker('kira', { name: 'KIRA', portrait: 'data:image/png;base64,iVBORw0KGgo=' })
  story.step({
    id: 'intro',
    after: 'reach_factory_tier_2',
    messages: [{ text: 'The readings are wrong.', speaker: 'kira' }],
  })
  env.S.__story.tick()
  assert(env.steps.map((s) => s.id)[1] === 'my.mod:intro', 'it never landed')
  assert(env.speakerTable()['my.mod:kira'], 'the speaker never landed')
  const vanilla = env.steps.filter((s) => !s.id.startsWith('my.mod:')).map((s) => s.id)

  env.S.__disposeMod('my.mod')

  assert(!env.steps.some((s) => s.id === 'my.mod:intro'), "the mod's step stayed in the game's list")
  assert(!env.speakerTable()['my.mod:kira'], "the mod's speaker stayed in the portrait table")
  assert(env.speakerTable().zoe && env.speakerTable().pri, 'disposal took a vanilla speaker with it')
  assert(env.steps.map((s) => s.id).join(',') === vanilla.join(','),
    'the vanilla chain did not close back up: ' + env.steps.map((s) => s.id).join(','))
  assert(env.S.__story.steps().length === 0 && env.S.__story.speakers().length === 0,
    'the SDK still thinks it owns something')

  // Taking the step out has to leave the chain running straight past where it
  // was, or every beat after it is unreachable.
  env.completeStep('reach_factory_tier_2')
  assert(env.shown[env.shown.length - 1] === 'investigate_anomaly',
    'the chain was left broken where the step used to be: ' + env.shown.join(','))

  env.S.__story.stop()
  return 'step and speaker both removed, vanilla speakers intact, the chain closed back up'
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

// ------------------------------------------------- map editor: validation
//
// Every one of these rules exists because the failure it catches is invisible
// until someone plays the map. A blueprint can assemble, list and preview
// perfectly and still open onto a hollow world - that has already happened
// here once. These checks are the difference between the editor drawing a PNG
// and the editor knowing what the PNG means.

let mapValidate = null
check('the map validator loads against the real terrain palette', () => {
  mapValidate = require('../src/renderer/mapeditor-validate')
  const pal = require('../src/game/terrain-palette')
  assert(typeof mapValidate.spawnCell === 'function', 'spawnCell is missing')
  assert(typeof mapValidate.validate === 'function', 'validate is missing')
  assert(Object.keys(mapValidate).length === 2,
    'the module exports more than spawnCell and validate: ' + Object.keys(mapValidate).join(', '))
  assert(pal.byRgb(102, 102, 102), 'the palette does not know the fog colour')
  assert(pal.DEFAULT_SOLID && pal.DEFAULT_EMPTY, 'the palette has no default solid/empty')
  return 'two exports, palette reachable'
})

/** An RGBA buffer shaped the way ImageData hands one over. */
function mvBuf(w, h, rgba) {
  const data = new Uint8ClampedArray(w * h * 4)
  if (rgba) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = rgba[0]; data[i + 1] = rgba[1]; data[i + 2] = rgba[2]; data[i + 3] = rgba[3]
    }
  }
  return { data, width: w, height: h }
}

function mvPut(b, x, y, rgba) {
  const i = (y * b.width + x) * 4
  b.data[i] = rgba[0]; b.data[i + 1] = rgba[1]; b.data[i + 2] = rgba[2]; b.data[i + 3] = rgba[3]
}

function mvRect(b, x0, y0, x1, y1, rgba) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mvPut(b, x, y, rgba)
}

const MV_AIR = [153, 0, 0, 255]     // the only air colour with no side effects
const MV_ROCK = [170, 170, 170, 255] // the most reliably resolved solid
const MV_FOG = [102, 102, 102, 255]  // the colour that produced the hollow map
const MV_BROKEN = [240, 220, 120, 255] // throws while loading

/**
 * A map that plays: open air down to a rock floor, the spawn cell clear, all
 * six layers the same size, and the size it advertises matching its pixels.
 * 480 wide so the spawn lands at column 318, and 224 tall so row 200 exists.
 */
function mvCleanDoc() {
  const w = 480
  const h = 224
  const terrain = mvBuf(w, h, MV_AIR)
  mvRect(terrain, 0, 208, w - 1, h - 1, MV_ROCK)
  return {
    params: { width: w, height: h },
    layers: {
      terrain,
      lights: mvBuf(w, h, null),
      lightsMeta: mvBuf(w, h, null),
      sensors: mvBuf(w, h, null),
      authorization: mvBuf(w, h, null),
      wall: mvBuf(w, h, null),
    },
  }
}

/** The codes a document produces, sorted, so a check can compare a whole set. */
function mvCodes(doc) {
  return mapValidate.validate(doc).problems.map((p) => p.code).sort()
}

/** The single problem carrying a code, or null. */
function mvOne(doc, code) {
  const hits = mapValidate.validate(doc).problems.filter((p) => p.code === code)
  assert(hits.length <= 1, 'expected at most one ' + code + ', got ' + hits.length)
  return hits[0] || null
}

check('the spawn cell comes off the game\'s own formula, and a finished map is quiet', () => {
  // x = (width / 2) * 4 + 315 world pixels, y = 200 * 4, at 4 world pixels per
  // cell. For 480 that is (240 * 4 + 315) / 4 = 1275 / 4 = 318.75, floored to
  // column 318; the row is a literal 200 whatever the map's height.
  const at480 = mapValidate.spawnCell(480)
  assert(at480.x === 318 && at480.y === 200,
    'a 480-wide map spawns at ' + at480.x + ',' + at480.y + ' - expected 318,200')
  assert(mapValidate.spawnCell(3840).x === 1998, 'the game\'s own 3840 map moved')
  assert(mapValidate.spawnCell(64).x === 110,
    'the offset is a fixed +78.75 cells, so a narrow map spawns outside itself')
  assert(mapValidate.spawnCell(0).y === 200 && mapValidate.spawnCell(-5).y === 200,
    'spawnCell threw or drifted on a nonsense width')

  const clean = mvCleanDoc()
  const problems = mapValidate.validate(clean).problems
  assert(problems.length === 0,
    'a playable map was flagged: ' + problems.map((p) => p.code + ' (' + p.message + ')').join('; '))
  return '480 wide spawns at 318,200; a playable map reports nothing'
})

check('a map whose layers disagree about the world size is refused', () => {
  const doc = mvCleanDoc()
  doc.layers.lights = mvBuf(100, 60, null)
  doc.layers.wall = mvBuf(480, 225, null)
  const hits = mapValidate.validate(doc).problems.filter((p) => p.code === 'layer-size-mismatch')
  assert(hits.length === 2, 'expected both mismatched layers, got ' + hits.length)
  assert(hits.every((p) => p.severity === 'error'), 'a silently corrupted world is only a warning')
  // The layer has to be named, because "a layer" is not something an author
  // can act on - the grids are filled using the source image's own width as
  // the stride, so the wrong one smears diagonally with no error in game.
  const named = hits.map((p) => p.layer).sort().join(',')
  assert(named === 'lights,wall', 'the problems name ' + named + ' instead of the two bad layers')
  assert(/lights/.test(hits[0].message) && /480x224/.test(hits[0].message),
    'the message does not say which layer or what size it should be')

  // A layer that is simply absent is not a size disagreement: the editor
  // synthesises the five non-terrain layers, and blank ones make a sane world.
  const missing = mvCleanDoc()
  delete missing.layers.sensors
  assert(mvCodes(missing).length === 0, 'an absent layer was reported as the wrong size')
  return 'both bad layers named as errors; an absent layer is not one'
})

check('terrain that cannot survive being loaded is refused, and says what breaks', () => {
  // Alpha below 255 is not air. It resolves to Fog: solid on load, and then
  // the whole connected mass dissolves at the first pick swing.
  const thin = mvCleanDoc()
  mvPut(thin.layers.terrain, 5, 6, [153, 0, 0, 254])
  mvPut(thin.layers.terrain, 9, 9, [0, 0, 0, 0])
  const alpha = mvOne(thin, 'terrain-transparent')
  assert(alpha && alpha.severity === 'error', 'a see-through terrain pixel was not an error')
  assert(alpha.at.x === 5 && alpha.at.y === 6,
    'reported the first bad pixel as ' + alpha.at.x + ',' + alpha.at.y + ' instead of 5,6')
  assert(/\b2\b/.test(alpha.message), 'the count of bad pixels is missing: ' + alpha.message)
  assert(/fog/i.test(alpha.message) && !/\binvalid\b/i.test(alpha.message),
    'the message does not say it becomes fog: ' + alpha.message)
  assert(mvOne(mvCleanDoc(), 'terrain-transparent') === null,
    'fully opaque terrain was reported as see-through')

  // 240,220,120 throws inside the loader. The player never sees the map: the
  // game swallows the error and drops them into a random world instead.
  const broke = mvCleanDoc()
  mvPut(broke.layers.terrain, 12, 13, MV_BROKEN)
  mvPut(broke.layers.terrain, 14, 13, MV_BROKEN)
  const bad = mvOne(broke, 'terrain-broken-colour')
  assert(bad && bad.severity === 'error', 'a colour that crashes the load was not an error')
  assert(bad.at.x === 12 && bad.at.y === 13, 'the first bad pixel was not located')
  assert(/240,220,120/.test(bad.message), 'the message does not name the colour: ' + bad.message)
  assert(/\b2 places\b/.test(bad.message), 'the message does not count them: ' + bad.message)
  assert(mvOne(mvCleanDoc(), 'terrain-broken-colour') === null,
    'a map of ordinary colours was accused of holding a broken one')
  return 'see-through pixels and 240,220,120 both refused, each located and counted'
})

check('a wall layer with more colours than the game can hold is refused', () => {
  // The wall palette runs 1..254; colour 255 onward is funnelled into slot 254,
  // so those parts of the backdrop come out the wrong colour in game.
  const room = mvCleanDoc()
  for (let i = 0; i < 254; i++) mvPut(room.layers.wall, i, 0, [i, 0, 0, 255])
  assert(mvOne(room, 'wall-colour-limit') === null,
    'exactly 254 wall colours - the most that fit - was reported as too many')

  const over = mvCleanDoc()
  for (let i = 0; i < 255; i++) mvPut(over.layers.wall, i, 0, [i, 0, 0, 255])
  const hit = mvOne(over, 'wall-colour-limit')
  assert(hit && hit.severity === 'error', '255 wall colours was not reported')
  assert(/\b255\b/.test(hit.message) && /\b254\b/.test(hit.message),
    'the message reports neither the count nor the limit: ' + hit.message)

  // Alpha is part of a wall colour's identity, but a fully see-through pixel is
  // skipped entirely and costs no palette slot - so a blank wall is free.
  const alpha = mvCleanDoc()
  for (let i = 0; i < 254; i++) mvPut(alpha.layers.wall, i, 0, [i, 0, 0, 255])
  mvPut(alpha.layers.wall, 0, 1, [0, 0, 0, 254])
  assert(mvOne(alpha, 'wall-colour-limit'),
    'two pixels differing only in alpha were counted as one wall colour')
  return '254 fits, 255 does not, and alpha counts toward the identity'
})

check('a map that lies about its size, or has none, is refused', () => {
  // params.width/height is read unguarded by the game's own Custom Maps list,
  // so a missing one takes down the whole list, not just this map.
  const none = mvCleanDoc()
  delete none.params
  const missing = mvOne(none, 'params-size')
  assert(missing && missing.severity === 'error', 'a map with no recorded size was accepted')
  assert(/480x224/.test(missing.message), 'the message does not say what the size should be')

  const half = mvCleanDoc()
  half.params = { width: 480 }
  assert(mvOne(half, 'params-size'), 'a params with no height was accepted')

  const lying = mvCleanDoc()
  lying.params = { width: 100, height: 100 }
  const wrong = mvOne(lying, 'params-size')
  assert(wrong && /100x100/.test(wrong.message) && /480x224/.test(wrong.message),
    'the message does not contrast what it claims with what it is')
  assert(mvOne(mvCleanDoc(), 'params-size') === null, 'an honest size was reported as wrong')

  // Roughly 16383 cells per axis: past that the shared mouse position, a
  // Uint16 of world pixels, wraps around.
  const huge = mvCleanDoc()
  huge.layers.terrain = { data: new Uint8ClampedArray(4), width: 20000, height: 300 }
  const big = mapValidate.validate(huge).problems.filter((p) => p.code === 'map-size')
  assert(big.length === 1 && big[0].severity === 'error',
    'a 20000-cell axis produced ' + big.length + ' size problems')
  assert(/16,383/.test(big[0].message), 'the message does not give the real limit')

  const empty = mvCleanDoc()
  empty.layers.terrain = { data: new Uint8ClampedArray(0), width: 0, height: 0 }
  const zero = mapValidate.validate(empty).problems
  assert(zero.filter((p) => p.code === 'map-size').length === 2, 'a 0x0 map was not refused twice')
  // A map with no size at all cannot also be told its layers are the wrong
  // size or that its params disagree - that is noise on top of the one thing
  // that has to be fixed first.
  assert(zero.every((p) => p.code === 'map-size'),
    'a sizeless map also produced ' + zero.map((p) => p.code).join(', '))

  assert(mvCodes({ params: { width: 8, height: 8 }, layers: {} }).join() === 'terrain-missing',
    'a document with no terrain layer was not reported')
  assert(mapValidate.validate(null).problems.length === 1, 'validate(null) did not survive')
  return 'missing, half-missing, lying, oversized, zero and absent all named'
})

check('a map that will play badly is warned about, not blocked', () => {
  // Spawn is unconditional: the player is dropped at the formula's cell with
  // no search for open space, then shoved upward until clear. Survivable, so
  // this is a warning - the design says so explicitly.
  const buried = mvCleanDoc()
  mvPut(buried.layers.terrain, 318, 200, MV_ROCK)
  const spawn = mvOne(buried, 'spawn-blocked')
  assert(spawn && spawn.severity === 'warning', 'the spawn rule blocked the save instead of warning')
  assert(spawn.at.x === 318 && spawn.at.y === 200, 'the warning points at the wrong cell')
  assert(/upward/i.test(spawn.message), 'the message never says the player is pushed upward')
  assert(mvOne(mvCleanDoc(), 'spawn-blocked') === null, 'a clear spawn was reported as buried')

  // Fog: one pick swing dissolves the whole connected mass, so the size of
  // that mass is what separates a deliberate pocket from an accident.
  const foggy = mvCleanDoc()
  mvRect(foggy.layers.terrain, 10, 10, 19, 19, MV_FOG)  // 100 cells, all connected
  mvPut(foggy.layers.terrain, 40, 40, MV_FOG)           // 1 cell on its own
  const fog = mvOne(foggy, 'terrain-fog')
  assert(fog && fog.severity === 'warning', 'fog in the terrain was not warned about')
  assert(fog.at.x === 10 && fog.at.y === 10, 'the warning does not point at the first fog cell')
  assert(/101/.test(fog.message), 'the total number of fog cells is missing: ' + fog.message)
  assert(/100/.test(fog.message), 'the largest connected patch is missing: ' + fog.message)
  assert(mvOne(mvCleanDoc(), 'terrain-fog') === null, 'a fog-free map was accused of holding fog')

  // 51,51,51 is a different colour that resolves to the same sealed-pocket
  // material, and carries exactly the same trap.
  const alias = mvCleanDoc()
  mvRect(alias.layers.terrain, 0, 0, 4, 4, [51, 51, 51, 255])
  assert(mvOne(alias, 'terrain-fog'), 'only one of the fog colours is recognised as fog')
  return 'spawn and fog both warn, both located, and fog counts its connected mass'
})

check('a map nobody has finished drawing is warned about', () => {
  const solid = mvCleanDoc()
  solid.layers.terrain = mvBuf(480, 224, MV_ROCK)
  const brick = mvOne(solid, 'terrain-unfinished')
  assert(brick && brick.severity === 'warning', 'a map of solid rock edge to edge was not flagged')
  assert(/170,170,170/.test(brick.message), 'the warning does not say what the one colour is')

  const air = mvCleanDoc()
  air.layers.terrain = mvBuf(480, 224, MV_AIR)
  assert(mvOne(air, 'terrain-unfinished'), 'a map of nothing but air was not flagged')

  // Not one colour, but still nothing to stand on: water and fog are not floor.
  const wet = mvCleanDoc()
  wet.layers.terrain = mvBuf(480, 224, MV_AIR)
  mvRect(wet.layers.terrain, 0, 210, 479, 223, [0, 0, 255, 255])
  const nothing = mvOne(wet, 'terrain-unfinished')
  assert(nothing && /solid/i.test(nothing.message),
    'a map whose only floor is water was not flagged as having nothing solid')

  assert(mvOne(mvCleanDoc(), 'terrain-unfinished') === null,
    'a drawn map was called unfinished')
  return 'all-one-colour and nothing-solid both warn; a drawn map does not'
})

check('no fog colour can be mistaken for open air while scanning the palette', () => {
  const palette = require('../src/game/terrain-palette')
  // The fog family fits no bucket cleanly: it collides on load, then the first
  // dig anywhere in a connected mass converts all of it. It is grouped by what
  // it leaves behind, so someone scanning the empty group for a cave would
  // otherwise reach for it - the collision has to be in the label, not only in
  // the note. The three real air colours and the two real water colours must
  // not carry that warning, or it stops meaning anything.
  const trueAir = ['#ffffff', '#ff0000', '#990000']
  const trueWater = ['#0000ff', '#6600ff']
  let fog = 0
  for (const e of palette.TERRAIN) {
    if (e.kind !== 'empty' && e.kind !== 'fluid') continue
    if (trueAir.includes(e.hex) || trueWater.includes(e.hex)) {
      assert(!/blocks/i.test(e.label), e.hex + ' is real open air or real water but its label says it blocks')
      continue
    }
    fog++
    assert(/blocks until dug/i.test(e.label),
      e.hex + ' is grouped as ' + e.kind + ' but its label does not say it blocks until dug: "' + e.label + '"')
    assert(e.note.length > 0, e.hex + ' is a fog colour with no note explaining what happens when it is dug')
  }
  assert(fog === 10, 'expected 10 fog-family rows, found ' + fog)
  assert(trueAir.length + trueWater.length + fog === 15, 'the empty and fluid groups no longer add up')

  // The colour that produced the hollow test map, by name.
  const hollow = palette.byRgb(102, 102, 102)
  assert(hollow && hollow.kind === 'empty', '102,102,102 is no longer grouped by what it leaves behind')
  assert(/black rock/i.test(hollow.label), '102,102,102 no longer warns that it renders as black rock')
  assert(/blocks until dug/i.test(hollow.label), '102,102,102 no longer warns that it blocks')
  return '10 fog rows all say "blocks until dug"; the 3 air and 2 water colours do not'
})

// ------------------------------------------------- map editor drawing tools
/**
 * A pixel buffer of one colour, in the shape ImageData has: RGBA bytes,
 * row-major, four per pixel.
 *
 * Built by hand, at a size small enough to reason about, because the whole
 * reason the drawing tools are DOM-free is so these checks can assert on
 * pixels rather than on what a canvas appeared to look like.
 */
function pixBuf(width, height, rgba) {
  const data = new Uint8ClampedArray(width * height * 4)
  if (rgba) {
    for (let i = 0; i < width * height; i++) {
      data[i * 4] = rgba[0]
      data[i * 4 + 1] = rgba[1]
      data[i * 4 + 2] = rgba[2]
      data[i * 4 + 3] = rgba[3]
    }
  }
  return { data, width, height }
}

function pixAt(buf, x, y) {
  const i = (y * buf.width + x) * 4
  return [buf.data[i], buf.data[i + 1], buf.data[i + 2], buf.data[i + 3]]
}

function pixPut(buf, x, y, rgba) {
  const i = (y * buf.width + x) * 4
  buf.data[i] = rgba[0]
  buf.data[i + 1] = rgba[1]
  buf.data[i + 2] = rgba[2]
  buf.data[i + 3] = rgba[3]
}

/** How many pixels hold exactly this colour. */
function pixCount(buf, rgba) {
  let n = 0
  for (let i = 0; i < buf.width * buf.height; i++) {
    if (buf.data[i * 4] === rgba[0] && buf.data[i * 4 + 1] === rgba[1] &&
        buf.data[i * 4 + 2] === rgba[2] && buf.data[i * 4 + 3] === rgba[3]) n++
  }
  return n
}

/** A dirty rectangle as a string, so a failure says which one it got. */
function rectStr(r) {
  return r ? r.x + ',' + r.y + ' ' + r.w + 'x' + r.h : 'null'
}

/**
 * The bounding box of the pixels that actually differ, found the slow and
 * obvious way.
 *
 * This is the answer every tool's reported rectangle is measured against. The
 * caller repaints from that rectangle and records undo from it, so one pixel
 * too wide is not a rounding convenience - it is undo restoring ground the
 * stroke never touched.
 */
function changedBox(before, buf) {
  let x0 = null
  let y0 = 0
  let x1 = 0
  let y1 = 0
  for (let y = 0; y < buf.height; y++) {
    for (let x = 0; x < buf.width; x++) {
      const i = (y * buf.width + x) * 4
      if (before[i] === buf.data[i] && before[i + 1] === buf.data[i + 1] &&
          before[i + 2] === buf.data[i + 2] && before[i + 3] === buf.data[i + 3]) continue
      if (x0 === null) { x0 = x1 = x; y0 = y1 = y; continue }
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x0 === null ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

check('a size 1 brush paints one pixel, and a dab clips at the edge', () => {
  const draw = require('../src/renderer/mapeditor-tools')
  for (const name of ['brush', 'line', 'rectangle', 'fill', 'pick', 'eraser']) {
    assert(typeof draw[name] === 'function', 'the tools module no longer exports ' + name)
  }
  const ground = [10, 20, 30, 255]
  const ink = [170, 170, 170, 255]

  // The classic defect in a pixel editor: a "1 pixel" brush whose radius
  // rounds up and lays down 2x2. Nobody notices until a map has been drawn
  // with it, so it is asserted rather than looked at.
  const buf = pixBuf(16, 16, ground)
  const one = draw.brush(buf, 5, 5, 1, ink)
  assert(pixCount(buf, ink) === 1, 'a size 1 brush painted ' + pixCount(buf, ink) + ' pixels')
  assert(rectStr(one) === '5,5 1x1', 'size 1 reported ' + rectStr(one))
  assert(draw.brush(buf, 5, 5, 1, ink) === null,
    'repainting a pixel with the colour it already had was reported as a change')

  // Off the edge in every direction, and half over two of them. None of these
  // may throw: a drag that leaves the window is an ordinary event.
  assert(draw.brush(pixBuf(16, 16, ground), -5, -5, 2, ink) === null,
    'a dab entirely outside the buffer painted something')
  assert(draw.brush(pixBuf(16, 16, ground), 99, 4, 8, ink) === null,
    'a dab past the right edge painted something')
  const corner = draw.brush(pixBuf(16, 16, ground), 15, 15, 4, ink)
  assert(rectStr(corner) === '14,14 2x2', 'a dab over the bottom-right corner gave ' + rectStr(corner))
  const origin = draw.brush(pixBuf(16, 16, ground), 0, 0, 8, ink)
  assert(rectStr(origin) === '0,0 5x5', 'a dab over the top-left corner gave ' + rectStr(origin))

  // Sizes 2, 4 and 8 are the toolbar's other buttons; each must cover exactly
  // its own area when it lands clear of the edges.
  for (const size of [2, 4, 8]) {
    const b = pixBuf(32, 32, ground)
    draw.brush(b, 16, 16, size, ink)
    assert(pixCount(b, ink) === size * size,
      'a size ' + size + ' brush painted ' + pixCount(b, ink) + ' pixels, not ' + (size * size))
  }
  return 'one pixel at size 1, size squared above it, clipped at every edge'
})

check('a dragged line has no gaps, at a shallow angle or a steep one', () => {
  const draw = require('../src/renderer/mapeditor-tools')
  const ground = [0, 0, 0, 255]
  const ink = [153, 0, 0, 255]

  // "No gaps" for an 8-connected line means exactly one pixel per step of the
  // major axis, and never a jump of more than one along the minor. Stepping
  // along the vector and rounding - the obvious wrong implementation - drops
  // pixels and leaves a dotted diagonal on a fast drag.
  const shallow = pixBuf(16, 16, ground)
  const sr = draw.line(shallow, 0, 0, 15, 7, 1, ink)
  let prev = null
  for (let x = 0; x < 16; x++) {
    const rows = []
    for (let y = 0; y < 16; y++) if (pixAt(shallow, x, y)[0] === ink[0]) rows.push(y)
    assert(rows.length === 1, 'column ' + x + ' holds ' + rows.length + ' pixels of the line, not one')
    if (prev !== null) {
      assert(Math.abs(rows[0] - prev) <= 1, 'the line jumped from row ' + prev + ' to ' + rows[0])
    }
    prev = rows[0]
  }
  assert(rectStr(sr) === '0,0 16x8', 'the shallow line reported ' + rectStr(sr))

  const steep = pixBuf(16, 16, ground)
  const tr = draw.line(steep, 0, 0, 7, 15, 1, ink)
  prev = null
  for (let y = 0; y < 16; y++) {
    const cols = []
    for (let x = 0; x < 16; x++) if (pixAt(steep, x, y)[0] === ink[0]) cols.push(x)
    assert(cols.length === 1, 'row ' + y + ' holds ' + cols.length + ' pixels of the line, not one')
    if (prev !== null) {
      assert(Math.abs(cols[0] - prev) <= 1, 'the line jumped from column ' + prev + ' to ' + cols[0])
    }
    prev = cols[0]
  }
  assert(rectStr(tr) === '0,0 8x16', 'the steep line reported ' + rectStr(tr))
  assert(pixAt(steep, 0, 0)[0] === ink[0] && pixAt(steep, 7, 15)[0] === ink[0],
    'a line that does not include both of its own endpoints')

  // A drag that begins off the canvas draws the part that is on it, and one
  // that never touches the canvas draws nothing at all.
  const half = pixBuf(16, 16, ground)
  assert(rectStr(draw.line(half, -20, 8, 8, 8, 1, ink)) === '0,8 9x1',
    'a stroke starting outside the buffer was not clipped to it')
  assert(draw.line(pixBuf(16, 16, ground), -50, -50, -10, -10, 1, ink) === null,
    'a stroke entirely outside the buffer changed something')
  assert(rectStr(draw.line(pixBuf(16, 16, ground), 3, 3, 3, 3, 1, ink)) === '3,3 1x1',
    'a zero-length drag did not leave a single dab')
  return 'one pixel per major step, no jump over one, clipped at both ends'
})

check('a rectangle is an outline or a fill, and stays inside its own corners', () => {
  const draw = require('../src/renderer/mapeditor-tools')
  const ground = [0, 0, 0, 255]
  const ink = [170, 170, 170, 255]

  // Corners in the wrong order, because a drag can go up and to the left.
  const outline = pixBuf(16, 16, ground)
  const outlineRect = draw.rectangle(outline, 6, 4, 1, 1, ink, false)
  assert(rectStr(outlineRect) === '1,1 6x4', 'the outline reported ' + rectStr(outlineRect))
  assert(pixCount(outline, ink) === 2 * 6 + 2 * 4 - 4,
    'the outline is ' + pixCount(outline, ink) + ' pixels, not a 6x4 perimeter')
  assert(pixAt(outline, 3, 2)[0] === ground[0], 'the outline painted its own interior')
  assert(pixAt(outline, 1, 1)[0] === ink[0] && pixAt(outline, 6, 4)[0] === ink[0],
    'the outline is missing a corner')

  const solid = pixBuf(16, 16, ground)
  const solidRect = draw.rectangle(solid, 1, 1, 6, 4, ink, true)
  assert(rectStr(solidRect) === '1,1 6x4', 'the filled rectangle reported ' + rectStr(solidRect))
  assert(pixCount(solid, ink) === 24, 'the fill is ' + pixCount(solid, ink) + ' pixels, not 6x4')
  assert(pixAt(solid, 0, 1)[0] === ground[0] && pixAt(solid, 7, 4)[0] === ground[0],
    'the fill spilled past its own corners')

  const off = draw.rectangle(pixBuf(16, 16, ground), -4, -4, 2, 2, ink, true)
  assert(rectStr(off) === '0,0 3x3', 'a rectangle hanging off the corner gave ' + rectStr(off))
  assert(draw.rectangle(pixBuf(16, 16, ground), 20, 20, 40, 40, ink, false) === null,
    'a rectangle entirely outside the buffer changed something')
  assert(rectStr(draw.rectangle(pixBuf(16, 16, ground), 7, 7, 7, 7, ink, false)) === '7,7 1x1',
    'a one-pixel rectangle is not one pixel')
  return 'perimeter and area both exact, corners in any order, clipped at the edge'
})

check('flood fill stops at a one-pixel diagonal, and survives a big buffer', () => {
  const draw = require('../src/renderer/mapeditor-tools')
  const ground = [0, 0, 0, 255]
  const wall = [170, 170, 170, 255]
  const ink = [153, 0, 0, 255]

  // A one-pixel-thick diagonal is only 8-connected, so a fill that walked
  // diagonal neighbours would step straight through it. In this game that is
  // paint escaping a cave wall an author drew on purpose.
  const buf = pixBuf(16, 16, ground)
  for (let i = 0; i < 16; i++) pixPut(buf, i, i, wall)
  const r = draw.fill(buf, 15, 0, ink)
  assert(rectStr(r) === '1,0 15x15', 'the fill reported ' + rectStr(r))
  assert(pixCount(buf, ink) === 120,
    'the fill covered ' + pixCount(buf, ink) + ' pixels, not the 120 above the line')
  assert(pixCount(buf, ground) === 120,
    'the fill leaked past the diagonal: ' + pixCount(buf, ground) + ' pixels left below it')
  assert(pixCount(buf, wall) === 16, 'the fill ate the barrier it was supposed to stop at')

  // Filling with the colour already there has nothing to do - and no way to
  // terminate if it tried, since a filled pixel would still match the seed.
  assert(draw.fill(buf, 15, 0, ink) === null, 'filling with the colour already there was not a no-op')
  assert(draw.fill(buf, -1, 0, ink) === null && draw.fill(buf, 0, 99, ink) === null,
    'a fill seeded outside the buffer did something')

  // Exact match, no tolerance: one channel apart is a different material, and
  // smearing two palette entries into one is how a map becomes unplayable.
  const near = pixBuf(8, 8, [10, 10, 10, 255])
  pixPut(near, 0, 0, [10, 10, 11, 255])
  draw.fill(near, 4, 4, ink)
  assert(pixAt(near, 0, 0)[2] === 11, 'the fill swallowed a colour one channel away')

  // 4000x4000 is a size the editor has to survive. A recursive fill dies here
  // rather than in front of an author; an explicit stack does not.
  const big = pixBuf(4000, 4000, ground)
  const started = Date.now()
  const whole = draw.fill(big, 0, 0, ink)
  const took = Date.now() - started
  assert(rectStr(whole) === '0,0 4000x4000', 'the big fill reported ' + rectStr(whole))
  assert(pixAt(big, 3999, 3999).join(',') === ink.join(','),
    'the far corner of the big fill was never reached')
  assert(pixAt(big, 0, 3999).join(',') === ink.join(','),
    'the bottom-left of the big fill was never reached')
  return '4-connected, exact, and 16 million pixels filled in ' + took + ' ms'
})

check('a drawing tool reports exactly the pixels it changed, and the eraser never writes air', () => {
  const draw = require('../src/renderer/mapeditor-tools')
  const ground = [0, 0, 0, 255]
  const ink = [170, 170, 170, 255]
  const empty = [153, 0, 0, 255]

  // Each tool's rectangle is compared against the pixels that actually differ,
  // not against the geometry it was asked for. Those two diverge whenever a
  // stroke is clipped by an edge or lands on ground that already holds the
  // colour, which is exactly when an over-wide rectangle would go unnoticed.
  const cases = [
    ['brush', (b) => draw.brush(b, 5, 5, 3, ink)],
    ['a clipped brush', (b) => draw.brush(b, 0, 0, 8, ink)],
    ['line', (b) => draw.line(b, 2, 14, 13, 3, 2, ink)],
    ['a clipped line', (b) => draw.line(b, -6, 12, 9, 2, 4, ink)],
    ['a rectangle outline', (b) => draw.rectangle(b, 2, 2, 12, 9, ink, false)],
    ['a filled rectangle', (b) => draw.rectangle(b, 2, 2, 12, 9, ink, true)],
    ['fill', (b) => draw.fill(b, 8, 8, ink)],
    ['eraser', (b) => draw.eraser(b, 9, 9, 4, empty)],
  ]
  for (const [name, run] of cases) {
    const buf = pixBuf(16, 16, ground)
    const before = Uint8ClampedArray.from(buf.data)
    const got = run(buf)
    const want = changedBox(before, buf)
    assert(rectStr(got) === rectStr(want),
      name + ' reported ' + rectStr(got) + ' but changed ' + rectStr(want))
  }

  // Ground that already holds the colour is not a change, and the rectangle
  // has to shrink to the part that is.
  const partial = pixBuf(16, 16, ground)
  draw.rectangle(partial, 0, 0, 15, 0, ink, true)
  const shrunk = draw.brush(partial, 1, 1, 4, ink)
  assert(rectStr(shrunk) === '0,1 4x3',
    'a dab overlapping ground it did not change reported ' + rectStr(shrunk))

  // The eyedropper reads a colour back, and has nothing to say off the edge.
  assert(draw.pick(partial, 0, 0).join(',') === ink.join(','), 'pick read the wrong colour')
  assert(draw.pick(partial, 0, 5).join(',') === ground.join(','), 'pick read the wrong colour')
  for (const [x, y] of [[-1, 0], [0, -1], [16, 0], [0, 16], [99, 99]]) {
    assert(draw.pick(partial, x, y) === null, 'pick at ' + x + ',' + y + ' was not out of bounds')
  }

  // Alpha 0 is not air in this game: a fully transparent terrain pixel
  // resolves to Fog, which collides, floods the whole connected mass when it
  // is broken, and leaves no element behind. So the eraser writes the colour
  // the caller says means empty, and refuses to write nothing at all.
  const air = pixBuf(8, 8, ground)
  assert(rectStr(draw.eraser(air, 4, 4, 1, empty)) === '4,4 1x1',
    'the eraser did not write the colour it was handed')
  assert(pixAt(air, 4, 4).join(',') === empty.join(','),
    'the eraser wrote ' + pixAt(air, 4, 4).join(',') + ' instead of the caller colour')
  assert(draw.eraser(air, 2, 2, 1, [0, 0, 0, 0]) === null, 'the eraser wrote a fully transparent pixel')
  assert(pixAt(air, 2, 2)[3] === 255, 'the eraser cleared alpha anyway')
  assert(draw.eraser(air, 3, 3, 1, null) === null, 'the eraser invented a colour when given none')
  return 'every rectangle is the true bounding box; the eraser writes the caller colour or nothing'
})

// --- Terrain palette -------------------------------------------------------
//
// The data behind the map editor's colour picker. A wrong classification here
// ships unplayable maps to every author, so these checks are about the table
// being internally coherent and matching the bundle investigation, not about
// it being large.
//
// Placed after the summary runner only because several agents append here at
// once; every check below is synchronous, so it still runs before the runner's
// microtask fires.

check('every terrain palette entry is well formed and its hex agrees with its rgb', () => {
  const palette = require('../src/game/terrain-palette')
  assert(Array.isArray(palette.TERRAIN) && palette.TERRAIN.length > 0, 'TERRAIN is not a populated array')
  for (const e of palette.TERRAIN) {
    const where = e && e.hex ? e.hex : JSON.stringify(e)
    assert(Array.isArray(e.rgb) && e.rgb.length === 3, 'rgb is not a triple: ' + where)
    for (const v of e.rgb) {
      assert(Number.isInteger(v) && v >= 0 && v <= 255, 'channel out of range in ' + where + ': ' + v)
    }
    const expected = '#' + e.rgb.map((v) => v.toString(16).padStart(2, '0')).join('')
    assert(e.hex === expected, 'hex disagrees with rgb: ' + where + ' should be ' + expected)
    assert(palette.KINDS.includes(e.kind), 'unknown kind on ' + where + ': ' + e.kind)
    assert(typeof e.label === 'string' && e.label.length > 0, 'no label on ' + where)
    assert(typeof e.note === 'string', 'note is not a string on ' + where)
    assert(e.cellType === null || Number.isInteger(e.cellType), 'cellType is neither null nor an integer on ' + where)
    // No pass-through terrain type exists, so nothing may be sold as one.
    assert(!/background/i.test(e.label), 'an entry is labelled as background: ' + where)
  }
  return palette.TERRAIN.length + ' entries, all with an rgb triple and a matching hex'
})

check('no two terrain palette entries claim the same colour', () => {
  const palette = require('../src/game/terrain-palette')
  const seen = new Map()
  for (const e of palette.TERRAIN) {
    assert(!seen.has(e.hex), 'duplicate hex ' + e.hex + ': "' + seen.get(e.hex) + '" and "' + e.label + '"')
    seen.set(e.hex, e.label)
  }
  return seen.size + ' distinct colours'
})

check('a palette colour can be looked up by hex in either spelling and by rgb', () => {
  const palette = require('../src/game/terrain-palette')
  const stone = palette.byHex('#aaaaaa')
  assert(stone && stone.cellType === 23, '#aaaaaa did not resolve to Stone')
  assert(palette.byHex('aaaaaa') === stone, 'the unprefixed spelling gave a different answer')
  assert(palette.byHex('#AAAAAA') === stone, 'the uppercase spelling gave a different answer')
  assert(palette.byHex('AaAaAa') === stone, 'the mixed-case unprefixed spelling gave a different answer')
  assert(palette.byRgb(170, 170, 170) === stone, 'byRgb gave a different answer to byHex')

  // Every entry must be reachable both ways, or the picker can show a swatch
  // the eyedropper cannot then find.
  for (const e of palette.TERRAIN) {
    assert(palette.byHex(e.hex) === e, 'byHex could not find ' + e.hex)
    assert(palette.byRgb(e.rgb[0], e.rgb[1], e.rgb[2]) === e, 'byRgb could not find ' + e.hex)
  }

  // A miss is meaningful: the game silently leaves an unrecognised colour Empty.
  assert(palette.byHex('#010203') === null, 'an unknown colour resolved to something')
  assert(palette.byHex('#abc') === null, 'a short hex was accepted')
  assert(palette.byHex('nothex') === null, 'a non-hex string was accepted')
  assert(palette.byHex(null) === null, 'null was accepted')
  assert(palette.byRgb(256, 0, 0) === null, 'an out-of-range channel was accepted')
  assert(palette.byRgb(1.5, 0, 0) === null, 'a fractional channel was accepted')
  return 'both spellings, both cases, and every entry reachable by hex and by rgb'
})

check('the editor is offered every palette colour except the ones that break a map', () => {
  const palette = require('../src/game/terrain-palette')
  const offered = palette.paintable()
  const broken = palette.TERRAIN.filter((e) => e.kind === 'broken')
  assert(broken.length > 0, 'no broken rows are recorded at all')

  // Two filters, and each has to be exactly itself. Nothing may be withheld
  // except a broken row and a row whose outcome is already on offer: every
  // distinct non-broken label appears once, and every offered row is a real
  // table row rather than something paintable() built.
  const safe = palette.TERRAIN.filter((e) => e.kind !== 'broken')
  const labels = new Set(safe.map((e) => e.label))
  assert(offered.length === labels.size,
    'paintable() offers ' + offered.length + ' rows for ' + labels.size + ' distinct outcomes')
  const shown = new Set()
  for (const e of offered) {
    assert(palette.TERRAIN.includes(e), 'paintable() invented a row: ' + JSON.stringify(e))
    assert(!shown.has(e.label), 'two offered rows share a label: "' + e.label + '"')
    shown.add(e.label)
  }
  for (const label of labels) {
    assert(shown.has(label), 'no colour is offered for "' + label + '"')
  }
  // The rows it withheld are still recognised, which is the whole trade: the
  // picker gets shorter, the reader of somebody else's map does not get blinder.
  for (const e of safe) {
    assert(palette.byRgb(e.rgb[0], e.rgb[1], e.rgb[2]) === e,
      'a de-duplicated colour is no longer recognised: ' + e.hex)
    assert(shown.has(e.label), e.hex + ' resolves to an outcome nothing offers')
  }
  // The seven the format spells more than one way, by name, because collapsing
  // them is the point and a table that stopped duplicating would make this
  // check vacuous.
  const doubled = ['#99ffff', '#4400ff', '#333333', '#9966ff', '#eed975',
    '#fedc00', '#141414', '#add8e6']
  for (const hex of doubled) {
    const dup = palette.byHex(hex)
    assert(dup, hex + ' is gone from the table, so a map containing it is unreadable')
    assert(!offered.includes(dup), hex + ' is offered beside the colour it duplicates')
    assert(offered.some((e) => e.label === dup.label),
      hex + ' was dropped without its outcome staying on offer')
  }

  for (const e of offered) assert(e.kind !== 'broken', 'a broken colour is on offer: ' + e.hex)
  for (const e of broken) {
    assert(!offered.includes(e), 'a broken colour is on offer: ' + e.hex)
    assert(e.note.length > 0, 'a broken colour carries no warning: ' + e.hex)
    // It stays in TERRAIN so an existing map containing it can be flagged.
    assert(palette.byHex(e.hex) === e, 'a broken colour cannot be recognised in an existing map: ' + e.hex)
  }
  // The colour that throws on load, by name, because blacklisting it is the point.
  const thrower = palette.byRgb(240, 220, 120)
  assert(thrower && thrower.kind === 'broken', '240,220,120 is not recorded as broken')
  return offered.length + ' offered for ' + labels.size + ' outcomes, ' + broken.length +
    ' broken and ' + (safe.length - offered.length) + ' duplicate withheld but still recognised'
})

check('the palette classification counts match the bundle investigation', () => {
  const palette = require('../src/game/terrain-palette')
  const counts = { solid: 0, empty: 0, fluid: 0, broken: 0 }
  for (const e of palette.TERRAIN) counts[e.kind]++

  // The investigation counts 50 rows: solid 32, empty 9, fluid 7, broken 2.
  // Two of those are not colours and cannot carry an rgb, so they are not rows
  // here: alpha 0 (a rule in the resolver's default arm, yielding Fog - carried
  // as a warning on #000000) and any unrecognised RGB (which is what a null
  // lookup means). The remaining 48 colour rows are asserted exactly.
  assert(counts.solid === 32, 'solid count is ' + counts.solid + ', expected 32')
  assert(counts.empty === 8, 'empty count is ' + counts.empty + ', expected 8 (9 less the alpha-0 rule)')
  assert(counts.fluid === 7, 'fluid count is ' + counts.fluid + ', expected 7')
  assert(counts.broken === 1, 'broken count is ' + counts.broken + ', expected 1 (2 less the unrecognised-colour case)')
  assert(palette.TERRAIN.length === 48, 'total is ' + palette.TERRAIN.length + ', expected 48')

  // Nothing pass-through exists: the kinds are exactly these four, in this order.
  assert(palette.KINDS.join(',') === 'solid,empty,fluid,broken', 'KINDS drifted: ' + palette.KINDS.join(','))
  return 'solid 32, empty 8, fluid 7, broken 1 across 48 colours'
})

check('the palette defaults are the two colours a new map can rely on', () => {
  const palette = require('../src/game/terrain-palette')
  const solid = palette.DEFAULT_SOLID
  assert(solid && solid.hex === '#000000', 'DEFAULT_SOLID is not 0,0,0: ' + (solid && solid.hex))
  assert(solid.kind === 'solid', 'DEFAULT_SOLID is not classified solid')
  assert(solid.cellType === 2, 'DEFAULT_SOLID is not Dirt (CellType 2): ' + solid.cellType)
  assert(palette.TERRAIN.includes(solid), 'DEFAULT_SOLID is not one of the table rows')
  // Dirt and a transparent pixel are one bit apart, and transparent yields Fog.
  assert(/opaque/i.test(solid.note), 'DEFAULT_SOLID does not warn that the pixel must be opaque')

  const empty = palette.DEFAULT_EMPTY
  assert(empty && empty.hex === '#990000', 'DEFAULT_EMPTY is not 153,0,0: ' + (empty && empty.hex))
  assert(empty.kind === 'empty', 'DEFAULT_EMPTY is not classified empty')
  assert(empty.cellType === 0, 'DEFAULT_EMPTY is not Empty (CellType 0): ' + empty.cellType)
  assert(palette.TERRAIN.includes(empty), 'DEFAULT_EMPTY is not one of the table rows')
  // It is the only air colour with no side effects; white also sets the horizon.
  assert(empty.note === '', 'DEFAULT_EMPTY carries a caveat, so it is no longer the side-effect-free eraser')
  const white = palette.byRgb(255, 255, 255)
  assert(white && white !== empty && /horizon/i.test(white.note), '255,255,255 does not record its horizon side effect')
  return 'DEFAULT_SOLID is Dirt at #000000, DEFAULT_EMPTY is #990000 with no side effects'
})

check('a map too small for the game\'s fixed spawn is refused, not just warned about', () => {
  // The spawn constant does not scale with the map: x = width/2 + 78.75 cells,
  // y = 200, always. So a small map does not merely bury the player, it puts
  // them outside the world - which the shove-upward rescue cannot fix. That
  // makes it an error, unlike a blocked spawn, which is survivable.
  const sized = (w, h) => ({
    params: { width: w, height: h },
    layers: {
      terrain: mvBuf(w, h, MV_AIR),
      lights: mvBuf(w, h, null),
      lightsMeta: mvBuf(w, h, null),
      sensors: mvBuf(w, h, null),
      authorization: mvBuf(w, h, null),
      wall: mvBuf(w, h, null),
    },
  })

  const narrow = mvOne(sized(100, 220), 'spawn-outside')
  assert(narrow, 'a 100-wide map put the player off the map and was not reported')
  assert(narrow.severity === 'error', 'spawning outside the world was only a warning')
  assert(/bigger/i.test(narrow.message), 'the message never tells the author to make it bigger')

  assert(mvOne(sized(160, 150), 'spawn-outside'),
    'a map shorter than the fixed spawn depth was not reported')

  // 158 x 201 is the floor the formula implies; one cell under it in either
  // direction has to fail, and the floor itself has to pass.
  assert(mvOne(sized(157, 201), 'spawn-outside'), '157 wide should be one cell too narrow')
  assert(mvOne(sized(158, 200), 'spawn-outside'), '200 tall should be one cell too short')
  assert(mvOne(sized(158, 201), 'spawn-outside') === null,
    'the smallest map the spawn formula allows was rejected')
  assert(mvOne(sized(240, 240), 'spawn-outside') === null,
    'a comfortably sized map was rejected')

  return 'below 158 x 201 the fixed spawn falls outside the world, and that is an error'
})

check('a mod problem raised in the renderer reaches the loader\'s problems list', () => {
  // The problems list is built in main and published to the renderer as a
  // one-way snapshot, so before this action a mission SDK refusing a mod's
  // content could only reach the log - invisible to the player it is for.
  const problems = require('../src/core/problems')
  const entry = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'entry.js'), 'utf8')
  assert(/case 'reportProblem'/.test(entry), 'the renderer has no way to file a problem')

  problems.clear()
  const before = problems.summary().total

  const err = new Error('mission pack needs gas-pipes, which is not installed')
  err.code = 'E_STORY'
  problems.record({ error: err, scope: 'story', modId: 'my.mod', severity: 'warn' })

  const after = problems.list()
  assert(after.length === before + 1, 'the problem was not recorded')
  const p = after[after.length - 1]
  assert(p.modId === 'my.mod', 'the problem lost the mod it came from')
  assert(p.severity === 'warn', 'a warning was filed as an error')
  assert(/gas-pipes/.test(p.message), 'the message did not survive')

  // Recording the same refusal twice must not grow the list, or a mod that
  // retries every tick would push everything else out of a capped list.
  problems.record({ error: err, scope: 'story', modId: 'my.mod', severity: 'warn' })
  assert(problems.list().length === before + 1, 'a repeated problem was filed twice')

  problems.clear()
  return 'renderer problems are recorded, attributed to their mod, and de-duplicated'
})

check('the story SDK files its refusals as problems, not only as log lines', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'story-sdk.js'), 'utf8')
  const from = src.indexOf('function report(level, modId, msg)')
  assert(from > 0, 'the SDK no longer has a single reporting chokepoint')
  const body = src.slice(from, from + 900)
  assert(/callMain\('reportProblem'/.test(body), 'warnings and errors never reach the problems panel')
  assert(/level !== 'warn' && level !== 'error'/.test(body),
    'info-level chatter would be filed as problems')
  assert(/catch/.test(body), 'a failed report could take the SDK down with it')
  return 'warn and error reach the panel, info does not, and a failure to file is survivable'
})

// ------------------------------------------------- the map editor's interface
// The four modules above are proven as functions; these prove the editor is
// actually wired to them, which is a separate thing and the one that decides
// what a person can do. They drive the real overlay through tools/dom-harness.js
// - real DOM events, real canvas pixels, real PNGs - because "the button
// exists" is not the same claim as "clicking it writes the right colour".

/** Every descendant of a node, in document order. */
function mapUiNodes(root) {
  const out = []
  ;(function walk(node) {
    for (const child of node.childNodes || []) { out.push(child); walk(child) }
  })(root)
  return out
}

function mapUiByText(nodes, text) {
  return nodes.find((e) => e.textContent === text) || null
}

function mapUiByClass(nodes, cls) {
  return nodes.filter((e) => mapUiHasClass(e, cls))
}

/**
 * Read the class off the attribute rather than off classList.
 *
 * The harness's classList only knows what add/toggle put in it, and the editor
 * sets these particular classes by assigning className - so asking classList
 * would answer "no" to every one of them and quietly pass every assertion.
 */
function mapUiHasClass(el, cls) {
  return (el.className || '').split(/\s+/).includes(cls)
}

/**
 * The six layer canvases, in the order the editor created them - which is the
 * order the game reads them in. The view canvas is excluded by its class, not
 * by its size, because a map the size of the harness's nominal box would
 * otherwise be indistinguishable from it.
 */
function mapUiLayers(dom, width, height) {
  return dom.document._all.filter((e) => e.tagName === 'CANVAS' &&
    !e.className && e.width === width && e.height === height)
}

/**
 * The canvas the editor derives from the terrain layer for the view: the same
 * pixels with the air colours turned into an absence. Never one of the six,
 * never saved, and marked with a class of its own so neither this helper nor
 * anything else can confuse it with the map.
 */
function mapUiShown(dom) {
  return dom.document._all.find((e) => e.tagName === 'CANVAS' && e.className === 'shown') || null
}

function mapUiPixel(canvas, x, y) {
  const d = canvas._data()
  const i = (y * d.width + x) * 4
  return [d.pixels[i], d.pixels[i + 1], d.pixels[i + 2], d.pixels[i + 3]]
}

/** A point in the middle of the stage, which fit-view puts in the middle of the map. */
function mapUiCentre(harness) {
  return { clientX: harness.NOMINAL.width / 2, clientY: harness.NOMINAL.height / 2 }
}

/** A map size just above the editor's own floor. */
const MAPUI_W = 176
const MAPUI_H = 216

check('the prelude carries the four map modules into the renderer', () => {
  // They are plain CommonJS - the self-test and the main process require the
  // same files - so the renderer needs a module/require shim rather than a
  // second copy of each. If that shim breaks, every feature below fails in the
  // game while every unit test here still passes, which is the failure mode
  // worth a check of its own.
  const wanted = [
    '__SMLN_TERRAIN_PALETTE__', '__SMLN_MAPEDITOR_TOOLS__',
    '__SMLN_MAPEDITOR_VALIDATE__', '__SMLN_MAPEDITOR_TRANSFORM__',
  ]
  for (const name of wanted) {
    assert(prelude.MODULES.some((m) => m.global === name), name + ' is not in prelude.MODULES')
  }
  const { sandbox } = bootEditor()
  const pal = sandbox.__SMLN_TERRAIN_PALETTE__
  const tools = sandbox.__SMLN_MAPEDITOR_TOOLS__
  const validate = sandbox.__SMLN_MAPEDITOR_VALIDATE__
  const transform = sandbox.__SMLN_MAPEDITOR_TRANSFORM__
  assert(pal && typeof pal.paintable === 'function', 'the palette did not reach the renderer')
  assert(tools && typeof tools.eraser === 'function', 'the drawing tools did not reach the renderer')
  assert(validate && typeof validate.validate === 'function', 'the validator did not reach the renderer')
  assert(transform && typeof transform.resize === 'function', 'the transforms did not reach the renderer')

  // mapeditor-validate.js requires the palette by path. That require is served
  // by the shim, so the renderer's validator and its picker read one table.
  assert(pal.paintable().length === require('../src/game/terrain-palette').paintable().length,
    'the renderer palette and the Node palette disagree about how many colours are offered')
  assert(validate.spawnCell(480).x === 318, 'the renderer validator lost the spawn formula')
  return 'all four install, and the validator resolves its require of the palette'
})

check('the palette picker offers exactly the paintable colours, and no broken one', () => {
  // The whole reason the palette module exists is that an author must not be
  // able to pick a colour without knowing what the player gets. That means two
  // things at once: everything safe is reachable, and the colours that make the
  // game abandon the map are not offered at all.
  const pal = require('../src/game/terrain-palette')
  const { S, dom } = bootEditor()

  return S.mapEditor.open(null, { width: MAPUI_W, height: MAPUI_H, name: 'Palette' }).then(() => {
    const overlay = dom.document.getElementById('smln-mapedit')
    const swatches = mapUiByClass(mapUiNodes(overlay), 'swatch')
    const offered = pal.paintable()

    assert(swatches.length === offered.length,
      'the picker shows ' + swatches.length + ' colours for ' + offered.length + ' paintable ones')
    const shown = swatches.map((b) => b.getAttribute('data-hex'))
    const broken = pal.TERRAIN.filter((e) => e.kind === 'broken')
    assert(broken.length > 0, 'the table has no broken colour, so this check proves nothing')
    for (const bad of broken) {
      assert(shown.indexOf(bad.hex) === -1,
        'the picker offers ' + bad.hex + ', which stops the map loading at all')
    }
    for (const entry of offered) {
      assert(shown.indexOf(entry.hex) >= 0, entry.hex + ' is paintable but is not offered')
    }

    // Grouped in the table's own order, so the buckets a reader scans are the
    // buckets the table classified.
    const order = shown.map((hex) => pal.byHex(hex).kind)
    let at = 0
    for (const kind of pal.KINDS) {
      while (at < order.length && order[at] === kind) at++
    }
    assert(at === order.length,
      'the picker interleaves the palette groups instead of showing them in KINDS order')

    // The note is what turns "Solid rock" into "Solid rock, but the starting
    // shovel does nothing to it", so it has to be reachable from the button.
    for (const b of swatches) {
      const entry = pal.byHex(b.getAttribute('data-hex'))
      const title = b.getAttribute('title') || ''
      assert(title.indexOf(entry.label) >= 0, entry.hex + ' does not show its own label')
      if (entry.note) {
        assert(title.indexOf(entry.note) >= 0, entry.hex + ' hides its note, which is the warning')
      }
      // The fog rows say "blocks until dug" in the label on purpose. Shortening
      // one is how an author reaches for fog believing it is rock.
      if (/blocks until dug/.test(entry.label)) {
        assert(title.indexOf('blocks until dug') >= 0,
          entry.hex + ' lost the "blocks until dug" warning out of its label')
      }
    }
    assert(swatches.some((b) => /blocks until dug/.test(
      pal.byHex(b.getAttribute('data-hex')).label)),
    'no fog colour is offered, so the label rule was never exercised')

    // The current colour has to be readable without hovering anything.
    const current = mapUiByClass(mapUiNodes(overlay), 'current')[0]
    assert(current, 'there is no current-colour readout')
    assert(mapUiNodes(current).some((e) => e.textContent === pal.DEFAULT_SOLID.label),
      'the current colour does not name itself')
    return swatches.length + ' offered, ' + broken.length + ' withheld, notes and fog labels intact'
  })
})

check('erasing writes the palette empty colour, never transparency', () => {
  // Alpha 0 is not air in this game - it resolves to Fog, which collides,
  // floods when broken and leaves nothing behind. An eraser that cleared to
  // transparent would fill a map with the worst material in it, and the map
  // would look perfect in every preview.
  const harness = require('./dom-harness')
  const pal = require('../src/game/terrain-palette')
  const { S, dom } = bootEditor()
  const air = pal.DEFAULT_EMPTY.rgb
  const dirt = pal.DEFAULT_SOLID.rgb

  return S.mapEditor.open(null, { width: MAPUI_W, height: MAPUI_H, name: 'Eraser' }).then(() => {
    const overlay = dom.document.getElementById('smln-mapedit')
    const nodes = mapUiNodes(overlay)
    const view = mapUiByClass(nodes, 'view')[0]
    const terrain = mapUiLayers(dom, MAPUI_W, MAPUI_H)[0]
    const centre = mapUiCentre(harness)

    // A blank document is air, not transparency, for the same reason.
    const start = terrain._data().pixels
    for (let i = 3; i < start.length; i += 4) {
      assert(start[i] === 255, 'a blank map starts see-through, which the game reads as fog')
    }
    assert(mapUiPixel(terrain, 4, 4).join(',') === air.concat(255).join(','),
      'a blank map does not start as the palette empty colour')

    view.dispatch('mousedown', harness.mouseEvent('mousedown', centre))
    dom.window.emit('mouseup', {})

    // Find what the brush wrote, rather than recomputing the editor's geometry.
    const d = terrain._data()
    let painted = null
    for (let y = 0; y < d.height && !painted; y++) {
      for (let x = 0; x < d.width; x++) {
        const i = (y * d.width + x) * 4
        if (d.pixels[i] !== air[0] || d.pixels[i + 1] !== air[1] || d.pixels[i + 2] !== air[2]) {
          painted = { x, y }
          break
        }
      }
    }
    assert(painted, 'the brush painted nothing, so there is nothing to erase')
    assert(mapUiPixel(terrain, painted.x, painted.y).join(',') === dirt.concat(255).join(','),
      'the brush did not paint the palette default: ' + mapUiPixel(terrain, painted.x, painted.y))

    mapUiByText(nodes, 'Eraser').dispatch('click', { type: 'click' })
    view.dispatch('mousedown', harness.mouseEvent('mousedown', centre))
    dom.window.emit('mouseup', {})

    const erased = mapUiPixel(terrain, painted.x, painted.y)
    assert(erased[3] === 255, 'the eraser wrote alpha ' + erased[3] + ', and alpha 0 is fog')
    assert(erased.join(',') === air.concat(255).join(','),
      'the eraser wrote ' + erased + ' instead of the palette empty colour ' + air)

    // Nothing anywhere may be see-through after an erase, either.
    const after = terrain._data().pixels
    for (let i = 3; i < after.length; i += 4) {
      assert(after[i] === 255, 'erasing left a see-through pixel somewhere in the terrain layer')
    }
    return 'erased to ' + air.join(',') + ' at full opacity, with no transparent pixel anywhere'
  })
})

check('a save is blocked by an error and allowed by a warning', () => {
  // The distinction is the whole point of the panel: an error is something the
  // player never gets past, a warning is something they merely notice. Blocking
  // on both would teach authors to ignore the block.
  const harness = require('./dom-harness')
  const mapValidate = require('../src/renderer/mapeditor-validate')
  const { S, dom, sandbox } = bootEditor()

  // A map whose terrain is entirely see-through: the game turns every one of
  // those pixels into sealed fog. It is an error, and the map still opens in
  // the editor so it can be fixed.
  const clear = new Uint8ClampedArray(MAPUI_W * MAPUI_H * 4)
  const url = 'data:image/png;base64,' +
    harness.encodePng(MAPUI_W, MAPUI_H, clear).toString('base64')
  const layer = { width: MAPUI_W, height: MAPUI_H, dataUrl: url }
  sandbox.electron.customMaps = {
    load: () => Promise.resolve({
      id: 'broken', name: 'See-through', params: { width: MAPUI_W, height: MAPUI_H },
      terrain: layer, lights: layer, lightsMeta: layer,
      sensors: layer, authorization: layer, wall: layer,
    }),
  }
  const calls = []
  S.callMain = (action) => {
    calls.push(action)
    return Promise.resolve({ ok: true, id: 'saved', file: 'saved.custommap' })
  }

  // What the module itself says about exactly these pixels - the panel has to
  // show that sentence, not a summary of it.
  const buffer = () => ({
    data: new Uint8ClampedArray(MAPUI_W * MAPUI_H * 4), width: MAPUI_W, height: MAPUI_H,
  })
  const expected = mapValidate.validate({
    params: { width: MAPUI_W, height: MAPUI_H },
    layers: {
      terrain: buffer(), lights: buffer(), lightsMeta: buffer(),
      sensors: buffer(), authorization: buffer(), wall: buffer(),
    },
  }).problems
  const expectedErrors = expected.filter((p) => p.severity === 'error')
  const expectedWarnings = expected.filter((p) => p.severity !== 'error')
  assert(expectedErrors.length > 0 && expectedWarnings.length > 0,
    'the fixture does not produce both an error and a warning, so it proves neither half')

  return S.mapEditor.open('broken').then(() => {
    const overlay = dom.document.getElementById('smln-mapedit')
    const nodes = mapUiNodes(overlay)
    const note = mapUiByClass(nodes, 'note')[0]
    const save = mapUiByClass(nodes, 'save')[0]

    save.dispatch('click', { type: 'click' })
    assert(calls.length === 0,
      'the map was saved despite ' + expectedErrors.length + ' error(s): ' + JSON.stringify(calls))
    assert(/not saved/i.test(note.textContent),
      'nothing said the save was refused: "' + note.textContent + '"')
    assert(/error/i.test(note.textContent) && /warning/i.test(note.textContent),
      'the refusal does not say which of the two blocks a save: "' + note.textContent + '"')

    // Verbatim, because the module wrote these for a person holding a brush.
    const shown = mapUiByClass(mapUiNodes(overlay), 'problem')
    assert(shown.length === expected.length,
      'the panel lists ' + shown.length + ' problems for ' + expected.length)
    for (const p of expected) {
      assert(shown.some((b) => b.textContent === p.message),
        'the panel paraphrased or dropped: ' + p.code)
    }
    // Severity has to be readable off each row, not only from its position.
    for (const p of expectedErrors) {
      assert(mapUiHasClass(shown.find((b) => b.textContent === p.message), 'error'),
        p.code + ' is not marked as an error')
    }
    for (const p of expectedWarnings) {
      assert(mapUiHasClass(shown.find((b) => b.textContent === p.message), 'warning'),
        p.code + ' is not marked as a warning')
    }

    // A problem that carries a position takes the view there. "0, 0" in a
    // message is only useful if the author can get to 0, 0.
    const located = expected.find((p) => p.at)
    assert(located, 'no problem in this fixture carries a position')
    const view = mapUiByClass(nodes, 'view')[0]
    const framed = Array.from(view._data().pixels)
    mapUiByText(mapUiNodes(overlay), located.message).dispatch('click', { type: 'click' })
    const moved = view._data().pixels
    assert(framed.some((v, i) => v !== moved[i]),
      'clicking a problem at ' + located.at.x + ', ' + located.at.y + ' did not move the view')

    // Now the other half: a map with warnings and no errors saves.
    const second = bootEditor()
    const calls2 = []
    second.S.callMain = (action) => {
      calls2.push(action)
      return Promise.resolve({ ok: true, id: 'ok', file: 'ok.custommap' })
    }
    return second.S.mapEditor.open(null, { width: MAPUI_W, height: MAPUI_H, name: 'Air' })
      .then(() => {
        const o2 = second.dom.document.getElementById('smln-mapedit')
        // Untouched, a new map is air from edge to edge - nothing solid to
        // stand on. That is a warning, and warnings do not block.
        mapUiByText(mapUiNodes(o2), 'Check map').dispatch('click', { type: 'click' })
        const shown2 = mapUiByClass(mapUiNodes(o2), 'problem')
        assert(shown2.length > 0, 'a blank map reported nothing, so nothing is being checked')
        for (const b of shown2) {
          assert(!mapUiHasClass(b, 'error'), 'a blank map reports an error: ' + b.textContent)
        }
        mapUiByClass(mapUiNodes(o2), 'save')[0].dispatch('click', { type: 'click' })
        assert(calls2.length === 1 && calls2[0] === 'saveCustomMap',
          'a map with only warnings was not saved: ' + JSON.stringify(calls2))
        return new Promise((resolve) => setTimeout(resolve, 0)).then(() =>
          expectedErrors.length + ' error(s) blocked a save; ' + shown2.length +
          ' warning(s) did not')
      })
  })
})

check('a transform runs on all six layers at once, as one undo step', () => {
  // The game fills its grids using each image's own width as the stride, so a
  // layer left at the old size does not fail - it smears what was drawn on it
  // diagonally across the world and says nothing. That makes "all six, or
  // none" the property worth asserting, not "the terrain layer resized".
  const harness = require('./dom-harness')
  const pal = require('../src/game/terrain-palette')
  const { S, dom } = bootEditor()
  const air = pal.DEFAULT_EMPTY.rgb

  return S.mapEditor.open(null, { width: MAPUI_W, height: MAPUI_H, name: 'Shape' }).then(() => {
    const overlay = dom.document.getElementById('smln-mapedit')
    const layers = mapUiLayers(dom, MAPUI_W, MAPUI_H)
    assert(layers.length === 6, 'expected six layer canvases, found ' + layers.length)

    // Something asymmetric to follow through the transform.
    const view = mapUiByClass(mapUiNodes(overlay), 'view')[0]
    view.dispatch('mousedown', harness.mouseEvent('mousedown', mapUiCentre(harness)))
    dom.window.emit('mouseup', {})
    const before = Array.from(layers[0]._data().pixels)

    const grown = { w: MAPUI_W + 40, h: MAPUI_H + 30 }
    mapUiByText(mapUiNodes(overlay), 'Resize...').dispatch('click', { type: 'click' })
    const inputs = mapUiNodes(overlay).filter((e) => e.tagName === 'INPUT' && e.className !== 'name')
    assert(inputs.length === 2, 'the resize dialog does not ask for a width and a height')
    inputs[0].value = String(grown.w)
    inputs[1].value = String(grown.h)
    const anchor = mapUiNodes(overlay).find((e) => e.getAttribute && e.getAttribute('title') === 'top-left')
    assert(anchor, 'the resize dialog has no anchor picker')
    anchor.dispatch('click', { type: 'click' })
    mapUiByText(mapUiNodes(overlay), 'Resize').dispatch('click', { type: 'click' })

    for (const canvas of layers) {
      assert(canvas.width === grown.w && canvas.height === grown.h,
        'a layer stayed ' + canvas.width + 'x' + canvas.height + ' while the map became ' +
        grown.w + 'x' + grown.h)
    }
    assert(mapUiByClass(mapUiNodes(overlay), 'dims')[0].textContent === grown.w + '×' + grown.h,
      'the header still advertises the old size')

    // New terrain is air, because a transparent terrain pixel is fog. New space
    // in the other five is nothing at all, which is what they mean by empty.
    assert(mapUiPixel(layers[0], grown.w - 2, 2).join(',') === air.concat(255).join(','),
      'the terrain layer grew into see-through pixels, which the game reads as fog')
    for (let i = 1; i < layers.length; i++) {
      assert(mapUiPixel(layers[i], grown.w - 2, 2)[3] === 0,
        'a non-terrain layer grew into opaque pixels instead of nothing')
    }

    // One step, not six.
    const undoBtn = mapUiByText(mapUiNodes(overlay), 'Undo')
    assert(!undoBtn.disabled, 'the resize left nothing to undo')
    undoBtn.dispatch('click', { type: 'click' })
    for (const canvas of layers) {
      assert(canvas.width === MAPUI_W && canvas.height === MAPUI_H,
        'undoing the resize left a layer at ' + canvas.width + 'x' + canvas.height)
    }
    const restored = layers[0]._data().pixels
    assert(restored.length === before.length, 'the terrain layer came back a different size')
    for (let i = 0; i < before.length; i++) {
      assert(restored[i] === before[i], 'undoing the resize changed terrain at byte ' + i)
    }
    // Two edits went in - one dab and one resize - so exactly one undo is left.
    // A resize that had recorded a step per layer would leave five.
    assert(!undoBtn.disabled, 'the dab before the resize is no longer undoable')
    undoBtn.dispatch('click', { type: 'click' })
    assert(undoBtn.disabled, 'one resize cost more than one undo step')
    // Put the dab back, so the mirror below has something asymmetric to move.
    mapUiByText(mapUiNodes(overlay), 'Redo').dispatch('click', { type: 'click' })

    // Mirroring keeps the size and moves the pixels, on every layer.
    mapUiByText(mapUiNodes(overlay), 'Mirror ⇄').dispatch('click', { type: 'click' })
    for (const canvas of layers) {
      assert(canvas.width === MAPUI_W && canvas.height === MAPUI_H,
        'mirroring changed a layer size to ' + canvas.width + 'x' + canvas.height)
    }
    const mirrored = layers[0]._data().pixels
    for (let y = 0; y < MAPUI_H; y++) {
      for (let x = 0; x < MAPUI_W; x++) {
        const src = (y * MAPUI_W + x) * 4
        const dst = (y * MAPUI_W + (MAPUI_W - 1 - x)) * 4
        assert(mirrored[dst] === before[src] && mirrored[dst + 3] === before[src + 3],
          'the mirror did not move terrain at ' + x + ', ' + y)
      }
    }
    return 'resize and mirror both ran on six layers of equal size, each in one undo step'
  })
})

// ------------------------------------------- the editor's controls, after
// the toolbar was cut from three rows to one
//
// The redesign moved two things and hid five, and each of those moves is a way
// for a control to quietly stop being reachable. These pin where the controls
// went and that they still say what they said - not what they look like, which
// is not a thing a test should have an opinion about.

/** The button carrying exactly this text, ignoring captions that share it. */
function mapUiButton(nodes, text) {
  return nodes.find((e) => e.tagName === 'BUTTON' && e.textContent === text) || null
}

check('every drawing control is still on the toolbar, and the layers moved to the rail', () => {
  const { S, dom } = bootEditor()

  return S.mapEditor.open(null, { width: MAPUI_W, height: MAPUI_H, name: 'Controls' }).then(() => {
    const overlay = dom.document.getElementById('smln-mapedit')
    const tools = mapUiByClass(mapUiNodes(overlay), 'tools')[0]
    const rail = mapUiByClass(mapUiNodes(overlay), 'rail')[0]
    assert(tools && rail, 'the toolbar or the rail is gone from the editor')
    const inTools = mapUiNodes(tools)
    const inRail = mapUiNodes(rail)

    // Every one of these words was written for a mapmaker holding a brush.
    // "Box outline" is not "Outline" and "Eyedropper" is not "Pick": a label
    // that shrank to fit a layout is a label that stopped saying what it does.
    for (const label of ['Brush', 'Eraser', 'Fill', 'Line', 'Box', 'Box outline',
      'Eyedropper', 'Select']) {
      assert(mapUiButton(inTools, label), 'the ' + label + ' tool is not on the toolbar')
    }
    for (const size of ['1', '2', '4', '8']) {
      assert(mapUiButton(inTools, size), 'brush size ' + size + ' is not on the toolbar')
    }
    for (const label of ['Pan', 'Undo', 'Redo', '-', '+', '1:1', 'Fit', 'Check map']) {
      assert(mapUiButton(inTools, label), label + ' is not on the toolbar')
    }

    // Choosing a layer is a mode you set and leave, so it is not in the row a
    // hand is in mid-stroke any more. Where it went is the claim worth
    // pinning, because "still in the document somewhere" is not the same as
    // "somewhere a person will find it".
    for (const label of ['Terrain', 'Lights', 'Light tuning', 'Artifact markers',
      'Zones', 'Backdrop']) {
      const pick = mapUiButton(inRail, label)
      assert(pick, 'the ' + label + ' layer is not in the rail')
      assert(!mapUiButton(inTools, label), label + ' is still in the toolbar as well')

      // Its visibility rides with its name rather than trailing behind it as a
      // loose dot that belongs to whichever row you guess.
      const eyes = (pick.parentNode.childNodes || []).filter((e) => mapUiHasClass(e, 'eye'))
      assert(eyes.length === 1,
        label + ' carries ' + eyes.length + ' visibility toggles instead of one')
      assert(eyes[0].textContent === '◉', label + ' does not start out visible')
    }

    const eyeOf = (label) => mapUiButton(inRail, label).parentNode.childNodes
      .filter((e) => mapUiHasClass(e, 'eye'))[0]
    eyeOf('Lights').dispatch('click', { type: 'click' })
    assert(eyeOf('Lights').textContent === '◌', 'hiding a layer did not change its own toggle')
    assert(eyeOf('Terrain').textContent === '◉', 'hiding one layer hid another one too')
    assert(eyeOf('Lights').getAttribute('aria-pressed') === 'false',
      'a hidden layer does not say so anywhere but in its glyph')

    // Selecting a layer shows it, because painting into a hidden layer is
    // painting into nothing you can see.
    mapUiButton(inRail, 'Lights').dispatch('click', { type: 'click' })
    assert(eyeOf('Lights').textContent === '◉', 'choosing a hidden layer left it hidden')
    return 'twenty toolbar controls where they were, six layers in the rail with their own toggles'
  })
})

check('the five document operations are still reachable behind the one control', () => {
  // Resize, crop, mirror and shift are used once or twice in a map's life and
  // each one moves every pixel of all six layers, so they went behind one
  // control rather than sitting beside Brush at the same size. Hiding
  // something is the easiest way to lose it: this is the check that it is
  // still there, still does the work, and can still be got out of.
  const harness = require('./dom-harness')
  const { S, dom } = bootEditor()

  return S.mapEditor.open(null, { width: MAPUI_W, height: MAPUI_H, name: 'Ops' }).then(() => {
    const overlay = dom.document.getElementById('smln-mapedit')
    const nodes = mapUiNodes(overlay)
    const trigger = mapUiByClass(nodes, 'shapeBtn')[0]
    const menu = mapUiByClass(nodes, 'shapeMenu')[0]
    assert(trigger && menu, 'the document-operations control is gone')
    assert(trigger.textContent === 'Shape',
      'the control lost its label: ' + JSON.stringify(trigger.textContent))

    const held = menu.childNodes.map((e) => e.textContent)
    for (const label of ['Resize...', 'Crop', 'Mirror ⇄', 'Mirror ⇅', 'Shift...']) {
      assert(held.indexOf(label) >= 0,
        label + ' is not behind the Shape control: ' + JSON.stringify(held))
    }
    assert(held.length === 5,
      'something else moved in beside the document operations: ' + JSON.stringify(held))

    // Shut until it is asked for, and it says which it is where a screen
    // reader can hear it rather than only in how it is drawn.
    assert(!menu.classList.contains('open'), 'the menu is open before anything opened it')
    assert(trigger.getAttribute('aria-expanded') === 'false',
      'a shut menu claims to be open')
    trigger.dispatch('click', { type: 'click' })
    assert(menu.classList.contains('open'), 'the Shape control does not open its menu')
    assert(trigger.getAttribute('aria-expanded') === 'true',
      'an open menu does not say it is open')

    // And they still operate. Mirror is the one that needs no dialog, so it is
    // the one that proves the wiring survived the move in a single click.
    const layers = mapUiLayers(dom, MAPUI_W, MAPUI_H)
    const view = mapUiByClass(nodes, 'view')[0]
    view.dispatch('mousedown', harness.mouseEvent('mousedown', mapUiCentre(harness)))
    dom.window.emit('mouseup', {})
    const before = Array.from(layers[0]._data().pixels)

    menu.childNodes.find((e) => e.textContent === 'Mirror ⇄').dispatch('click', { type: 'click' })
    const after = layers[0]._data().pixels
    for (let y = 0; y < MAPUI_H; y++) {
      for (let x = 0; x < MAPUI_W; x++) {
        const src = (y * MAPUI_W + x) * 4
        const dst = (y * MAPUI_W + (MAPUI_W - 1 - x)) * 4
        assert(after[dst] === before[src] && after[dst + 3] === before[src + 3],
          'mirroring from the menu did not move terrain at ' + x + ', ' + y)
      }
    }
    assert(!menu.classList.contains('open'), 'the menu stayed open after an operation ran')

    // A menu that can only be left by choosing something out of it is a trap,
    // and Escape must not take the whole editor with it.
    trigger.dispatch('click', { type: 'click' })
    assert(menu.classList.contains('open'), 'the menu did not open a second time')
    dom.window.key({ key: 'Escape' })
    assert(!menu.classList.contains('open'), 'Escape left the menu open')
    assert(S.mapEditor.isOpen(), 'Escape closed the whole editor instead of the menu on top of it')
    return 'five operations behind one control, still mirroring, and dismissable without leaving'
  })
})

check('undo restores exactly the rectangle a tool reported dirty', () => {
  // mapeditor-tools.js returns a rectangle bounding exactly the bytes it
  // changed, and the editor's contract is to repaint and record from that and
  // nothing wider. An over-wide rectangle is not a rounding convenience: it
  // makes undo restore pixels the stroke never owned, which is a silent way to
  // lose the work of two strokes ago.
  const harness = require('./dom-harness')
  const draw = require('../src/renderer/mapeditor-tools')
  const pal = require('../src/game/terrain-palette')
  const { S, dom } = bootEditor()
  const dirt = pal.DEFAULT_SOLID.rgb.concat(255)

  return S.mapEditor.open(null, { width: MAPUI_W, height: MAPUI_H, name: 'Undo' }).then(() => {
    const overlay = dom.document.getElementById('smln-mapedit')
    const nodes = mapUiNodes(overlay)
    const view = mapUiByClass(nodes, 'view')[0]
    const terrain = mapUiLayers(dom, MAPUI_W, MAPUI_H)[0]
    const centre = mapUiCentre(harness)
    const before = Array.from(terrain._data().pixels)

    // A box, because its dirty rectangle is a shape this test can name.
    mapUiByText(nodes, 'Box').dispatch('click', { type: 'click' })
    view.dispatch('mousedown', harness.mouseEvent('mousedown', centre))
    view.dispatch('mousemove', harness.mouseEvent('mousemove',
      { clientX: centre.clientX + 24, clientY: centre.clientY + 18 }))
    dom.window.emit('mouseup', {})

    // What actually changed on the canvas.
    const after = terrain._data().pixels
    let x0 = MAPUI_W; let y0 = MAPUI_H; let x1 = -1; let y1 = -1
    for (let y = 0; y < MAPUI_H; y++) {
      for (let x = 0; x < MAPUI_W; x++) {
        const i = (y * MAPUI_W + x) * 4
        if (after[i] === before[i] && after[i + 1] === before[i + 1] &&
            after[i + 2] === before[i + 2] && after[i + 3] === before[i + 3]) continue
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
    assert(x1 >= x0 && y1 >= y0, 'the box tool changed nothing')
    const changed = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
    assert(changed.w * changed.h < MAPUI_W * MAPUI_H,
      'the box repainted the whole layer, so no dirty rectangle is being honoured')

    // The module, run again over the original pixels with those corners, has to
    // report the same rectangle and produce the same bytes. That is the editor
    // applying the tool's own answer rather than an approximation of it.
    const replay = { data: new Uint8ClampedArray(before), width: MAPUI_W, height: MAPUI_H }
    const rect = draw.rectangle(replay, changed.x, changed.y,
      changed.x + changed.w - 1, changed.y + changed.h - 1, dirt, true)
    assert(rect && rect.x === changed.x && rect.y === changed.y &&
      rect.w === changed.w && rect.h === changed.h,
    'the editor changed ' + JSON.stringify(changed) + ' where the tool reports ' +
      JSON.stringify(rect))
    for (let i = 0; i < replay.data.length; i++) {
      assert(replay.data[i] === after[i], 'the editor and the tool disagree about byte ' + i)
    }

    // And undo puts every one of those bytes back, and touches nothing else.
    mapUiByText(nodes, 'Undo').dispatch('click', { type: 'click' })
    const back = terrain._data().pixels
    for (let i = 0; i < before.length; i++) {
      assert(back[i] === before[i],
        'undo left byte ' + i + ' at ' + back[i] + ' instead of ' + before[i])
    }

    // The same again for a dragged brush stroke, which is many operations and
    // still one undo step.
    mapUiByText(nodes, 'Brush').dispatch('click', { type: 'click' })
    view.dispatch('mousedown', harness.mouseEvent('mousedown', centre))
    view.dispatch('mousemove', harness.mouseEvent('mousemove',
      { clientX: centre.clientX + 30, clientY: centre.clientY + 6 }))
    view.dispatch('mousemove', harness.mouseEvent('mousemove',
      { clientX: centre.clientX + 10, clientY: centre.clientY + 20 }))
    dom.window.emit('mouseup', {})
    const dragged = Array.from(terrain._data().pixels)
    let moved = 0
    for (let i = 0; i < before.length; i += 4) if (dragged[i] !== before[i]) moved++
    assert(moved > 0, 'the dragged stroke painted nothing')

    const undoBtn = mapUiByText(nodes, 'Undo')
    undoBtn.dispatch('click', { type: 'click' })
    const back2 = terrain._data().pixels
    for (let i = 0; i < before.length; i++) {
      assert(back2[i] === before[i], 'undoing a drag left byte ' + i + ' changed')
    }
    assert(undoBtn.disabled, 'a single drag cost more than one undo step')

    // Redo puts it back, so undo is not a one-way door.
    mapUiByText(nodes, 'Redo').dispatch('click', { type: 'click' })
    const again = terrain._data().pixels
    for (let i = 0; i < before.length; i++) {
      assert(again[i] === dragged[i], 'redo did not restore the stroke at byte ' + i)
    }
    return changed.w + 'x' + changed.h + ' reported and restored exactly; a ' + moved +
      '-cell drag is one step, and redo brings it back'
  })
})

check('a new map is never made at a size the fixed spawn falls outside of', () => {
  // Below 158 x 201 the spawn is not merely buried, it is off the map - and the
  // shove-upward rescue cannot help someone who was never inside the world. So
  // the size is raised and the reason is said, rather than rounded in silence.
  const mapsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'mapsui.js'), 'utf8')
  const { S, dom } = bootEditor()
  const limits = S.mapEditor.limits()

  assert(limits.minWidth === 158 && limits.minHeight === 201,
    'the editor floor is ' + limits.minWidth + ' x ' + limits.minHeight + ', not 158 x 201')
  assert(/spot/.test(limits.reason) && /158/.test(limits.reason) && /201/.test(limits.reason),
    'the reason does not explain the fixed spawn: "' + limits.reason + '"')

  // The maps overlay asks the editor rather than keeping its own copy. Prose
  // may quote the number; code holding it would be a second thing to be wrong,
  // so the comments come out before that half is checked.
  const mapsCode = mapsSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert(/limits\.minWidth/.test(mapsCode) && /limits\.minHeight/.test(mapsCode),
    'the maps overlay does not ask the editor for its floor')
  assert(!/\b158\b|\b201\b/.test(mapsCode),
    'the maps overlay hard-codes the floor, which is a second number to be wrong')

  return S.mapEditor.open(null, { width: 40, height: 40, name: 'Tiny' }).then(() => {
    const overlay = dom.document.getElementById('smln-mapedit')
    const layers = mapUiLayers(dom, limits.minWidth, limits.minHeight)
    assert(layers.length === 6,
      'a 40x40 map was created anyway: found ' + layers.length + ' layers at the floor size')
    const note = mapUiByClass(mapUiNodes(overlay), 'note')[0]
    assert(/158/.test(note.textContent) && /spot/.test(note.textContent),
      'the size was raised without saying why: "' + note.textContent + '"')

    // And the map that comes out of it is one the validator will let through.
    const mapValidate = require('../src/renderer/mapeditor-validate')
    const buffers = {}
    const names = ['terrain', 'lights', 'lightsMeta', 'sensors', 'authorization', 'wall']
    names.forEach((name, i) => {
      const d = layers[i]._data()
      buffers[name] = { data: d.pixels, width: d.width, height: d.height }
    })
    const problems = mapValidate.validate({
      params: { width: limits.minWidth, height: limits.minHeight },
      layers: buffers,
    }).problems
    const errors = problems.filter((p) => p.severity === 'error')
    assert(errors.length === 0,
      'a map the editor just created cannot be saved: ' + errors.map((e) => e.code).join(', '))
    return 'raised to ' + limits.minWidth + ' x ' + limits.minHeight +
      ', the reason said out loud, and no error left in it'
  })
})

check('the spawn marker is drawn over the map at every zoom, and never into it', () => {
  // The spawn is fixed and unconditional - the game does not look for open
  // space - so an author who cannot see where it is cannot avoid burying it.
  // It has to be visible over every layer and at any zoom, and it must never be
  // painted into a layer, because then it would be a cell of the world.
  const { S, dom } = bootEditor()
  const mapValidate = require('../src/renderer/mapeditor-validate')
  const spawn = mapValidate.spawnCell(MAPUI_W)

  /** The bounding box of view-canvas pixels a test can pick out by hand. */
  const boxOf = (canvas, keep) => {
    const d = canvas._data()
    let x0 = d.width; let y0 = d.height; let x1 = -1; let y1 = -1
    for (let y = 0; y < d.height; y++) {
      for (let x = 0; x < d.width; x++) {
        const i = (y * d.width + x) * 4
        if (!keep(d.pixels[i], d.pixels[i + 1], d.pixels[i + 2], d.pixels[i + 3])) continue
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
    return x1 < x0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
  }

  return S.mapEditor.open(null, { width: MAPUI_W, height: MAPUI_H, name: 'Spawn' }).then(() => {
    const overlay = dom.document.getElementById('smln-mapedit')
    const nodes = mapUiNodes(overlay)
    const view = mapUiByClass(nodes, 'view')[0]
    const layers = mapUiLayers(dom, MAPUI_W, MAPUI_H)
    const harness = require('./dom-harness')

    // Flood the map with something first. A blank document is air from edge to
    // edge, and the view draws air as an absence, so an untouched map is not
    // drawn at all - which is correct, and leaves this check nothing to measure
    // the marker against. One fill gives it back a drawn rectangle.
    mapUiByText(nodes, 'Fill').dispatch('click', { type: 'click' })
    view.dispatch('mousedown', harness.mouseEvent('mousedown', mapUiCentre(harness)))
    dom.window.emit('mouseup', {})

    // The marker's own translucency is what picks it out of the map behind it:
    // nothing an author can paint is anything but fully opaque.
    const isMarker = (r, g, b, a) => a > 0 && a < 255
    const drawn = (r, g, b, a) => a > 0

    for (const zoom of ['Fit', '1:1']) {
      mapUiByText(nodes, zoom).dispatch('click', { type: 'click' })
      const map = boxOf(view, drawn)
      const marker = boxOf(view, isMarker)
      assert(map, 'at ' + zoom + ' the map is not drawn at all')
      assert(marker, 'at ' + zoom + ' there is no spawn marker anywhere on the view')

      // Where the marker sits inside the drawn map has to be where the spawn
      // cell sits inside the map, at whatever scale the map is drawn.
      const scale = map.w / MAPUI_W
      const wantX = map.x + spawn.x * scale
      const wantY = map.y + spawn.y * scale
      assert(Math.abs(marker.x - wantX) <= 1.5 && Math.abs(marker.y - wantY) <= 1.5,
        'at ' + zoom + ' the marker is at ' + marker.x + ', ' + marker.y +
        ' where the spawn cell is drawn at ' + Math.round(wantX) + ', ' + Math.round(wantY))
      assert(marker.w <= Math.ceil(scale) + 2 && marker.h <= Math.ceil(scale) + 2,
        'at ' + zoom + ' the marker covers ' + marker.w + 'x' + marker.h +
        ' cells rather than the one the player lands in')
    }

    // And it is decoration on the view, not a pixel of the world: no layer may
    // hold anything but the opaque colours the palette offers.
    for (const canvas of layers) {
      const stray = boxOf(canvas, isMarker)
      assert(!stray, 'the spawn marker was painted into a layer at ' +
        JSON.stringify(stray) + ', where it would become part of the map')
    }
    return 'marked at ' + spawn.x + ', ' + spawn.y + ' at both zooms, and in no layer'
  })
})

// ------------------------------------------- the view draws meaning, not keys
// A terrain colour is a storage key. 153,0,0 is how the format spells "open
// air", so a document with nothing painted on it is a layer full of dark red
// bytes - and an editor that drew those bytes showed a mapmaker a solid red
// wall and called it a new map. These prove the two halves that have to hold
// at once: the view shows an absence, and the file still holds the colour.

check('a new map draws as empty space and still saves the air colour', () => {
  const harness = require('./dom-harness')
  const pal = require('../src/game/terrain-palette')
  const air = pal.DEFAULT_EMPTY.rgb
  const { S, dom } = bootEditor()
  let saved = null
  S.callMain = (action, payload) => {
    if (action === 'saveCustomMap') saved = payload
    return Promise.resolve({ ok: true, id: 'blank', file: 'blank.custommap' })
  }

  return S.mapEditor.open(null, { width: MAPUI_W, height: MAPUI_H, name: 'Blank' }).then(() => {
    const overlay = dom.document.getElementById('smln-mapedit')
    const nodes = mapUiNodes(overlay)
    const view = mapUiByClass(nodes, 'view')[0]
    const terrain = mapUiLayers(dom, MAPUI_W, MAPUI_H)[0]

    // The layer is what the game reads, and it is air from edge to edge.
    const stored = terrain._data().pixels
    for (let i = 0; i < stored.length; i += 4) {
      assert(stored[i] === air[0] && stored[i + 1] === air[1] && stored[i + 2] === air[2] &&
        stored[i + 3] === 255, 'the blank terrain layer is not the palette air colour at byte ' + i)
    }

    // The view is what the author reads, and it shows nothing. The only thing
    // drawn on it is the spawn marker, which is translucent on purpose; an
    // opaque pixel anywhere would be the map being painted onto the screen.
    const seen = view._data().pixels
    let opaque = 0
    for (let i = 0; i < seen.length; i += 4) {
      if (seen[i + 3] === 255) opaque++
      assert(!(seen[i + 3] > 0 && seen[i] === air[0] && seen[i + 1] === air[1] &&
        seen[i + 2] === air[2]), 'the air colour itself was drawn to the view at byte ' + i)
    }
    assert(opaque === 0, opaque + ' view pixels are opaque, so a blank map is still drawn as a wall')

    // And the canvas it derives that from is the layer with the air taken out,
    // never the layer itself.
    const shown = mapUiShown(dom)
    assert(shown, 'the editor draws the terrain layer straight to the view')
    assert(shown !== terrain, 'the derived canvas is the terrain layer itself')
    assert(shown.width === MAPUI_W && shown.height === MAPUI_H,
      'the derived canvas is ' + shown.width + 'x' + shown.height)
    const derived = shown._data().pixels
    for (let i = 3; i < derived.length; i += 4) {
      assert(derived[i] === 0, 'an air cell is still drawn at byte ' + (i - 3))
    }

    mapUiByClass(nodes, 'save')[0].dispatch('click', { type: 'click' })
    return new Promise((resolve) => setTimeout(resolve, 0))
  }).then(() => {
    assert(saved && saved.layers && saved.layers.terrain, 'the blank map was never saved')
    const png = harness.decodePng(
      Buffer.from(saved.layers.terrain.dataUrl.split(',')[1], 'base64'))
    for (let i = 0; i < png.data.length; i += 4) {
      assert(png.data[i] === air[0] && png.data[i + 1] === air[1] &&
        png.data[i + 2] === air[2] && png.data[i + 3] === 255,
      'the saved terrain is not the air colour at byte ' + i + ': ' +
        [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]].join(','))
    }
    return 'nothing drawn, nothing opaque, and ' + air.join(',') + ' at full opacity in the file'
  })
})

check('painting and then erasing puts the view back to showing nothing', () => {
  const harness = require('./dom-harness')
  const pal = require('../src/game/terrain-palette')
  const air = pal.DEFAULT_EMPTY.rgb
  const dirt = pal.DEFAULT_SOLID.rgb
  const { S, dom } = bootEditor()

  const opaqueCount = (canvas) => {
    const d = canvas._data()
    let n = 0
    for (let i = 3; i < d.pixels.length; i += 4) if (d.pixels[i] === 255) n++
    return n
  }

  /** Where the brush landed, found in the layer rather than by redoing geometry. */
  const firstInked = (canvas) => {
    const d = canvas._data()
    for (let y = 0; y < d.height; y++) {
      for (let x = 0; x < d.width; x++) {
        const i = (y * d.width + x) * 4
        if (d.pixels[i] !== air[0] || d.pixels[i + 1] !== air[1] || d.pixels[i + 2] !== air[2]) {
          return { x, y }
        }
      }
    }
    return null
  }

  return S.mapEditor.open(null, { width: MAPUI_W, height: MAPUI_H, name: 'There and back' })
    .then(() => {
      const overlay = dom.document.getElementById('smln-mapedit')
      const nodes = mapUiNodes(overlay)
      const view = mapUiByClass(nodes, 'view')[0]
      const terrain = mapUiLayers(dom, MAPUI_W, MAPUI_H)[0]
      const centre = mapUiCentre(harness)
      assert(opaqueCount(view) === 0,
        'the view was already drawing something before anything was painted')

      view.dispatch('mousedown', harness.mouseEvent('mousedown', centre))
      dom.window.emit('mouseup', {})

      const at = firstInked(terrain)
      assert(at, 'the brush painted nothing, so there is nothing to erase')
      assert(mapUiPixel(terrain, at.x, at.y).join(',') === dirt.concat(255).join(','),
        'the brush wrote ' + mapUiPixel(terrain, at.x, at.y) + ' rather than the palette default')
      const painted = opaqueCount(view)
      assert(painted > 0, 'a painted cell is not drawn to the view at all')
      assert(mapUiPixel(mapUiShown(dom), at.x, at.y)[3] === 255,
        'the painted cell is see-through in the derived canvas')

      mapUiByText(nodes, 'Eraser').dispatch('click', { type: 'click' })
      view.dispatch('mousedown', harness.mouseEvent('mousedown', centre))
      dom.window.emit('mouseup', {})

      // The buffer keeps the colour; the view goes back to showing nothing.
      assert(mapUiPixel(terrain, at.x, at.y).join(',') === air.concat(255).join(','),
        'the eraser wrote ' + mapUiPixel(terrain, at.x, at.y) + ' instead of the air colour')
      assert(mapUiPixel(mapUiShown(dom), at.x, at.y)[3] === 0,
        'the erased cell is still drawn in the derived canvas')
      assert(opaqueCount(view) === 0,
        opaqueCount(view) + ' view pixels are still opaque after erasing')

      // Undo brings the paint back on screen as well as in the buffer - the
      // derived canvas has to follow history, not only strokes.
      mapUiByText(nodes, 'Undo').dispatch('click', { type: 'click' })
      assert(mapUiPixel(terrain, at.x, at.y).join(',') === dirt.concat(255).join(','),
        'undoing the erase did not put the colour back')
      assert(opaqueCount(view) === painted,
        'undoing the erase left the view showing ' + opaqueCount(view) + ' of ' + painted + ' cells')
      return 'painted ' + painted + ' view pixels, erased back to none, and undo restored them'
    })
})

check('the view is re-derived only over the rectangle a tool reported dirty', () => {
  // The derived canvas exists so a large map does not pay for a full pass on
  // every mouse move. That is only true if a stroke touches its own rectangle
  // and nothing else, so this leaves a mark where the editor already believes
  // it knows the answer, and checks the mark survives.
  const harness = require('./dom-harness')
  const pal = require('../src/game/terrain-palette')
  const air = pal.DEFAULT_EMPTY.rgb
  const { S, dom } = bootEditor()

  return S.mapEditor.open(null, { width: MAPUI_W, height: MAPUI_H, name: 'Dirty rect' })
    .then(() => {
      const overlay = dom.document.getElementById('smln-mapedit')
      const nodes = mapUiNodes(overlay)
      const view = mapUiByClass(nodes, 'view')[0]
      const terrain = mapUiLayers(dom, MAPUI_W, MAPUI_H)[0]
      const shown = mapUiShown(dom)
      assert(shown, 'there is no derived canvas to keep clean')

      const ctx = shown.getContext('2d')
      const mark = ctx.createImageData(1, 1)
      mark.data[0] = 1; mark.data[1] = 2; mark.data[2] = 3; mark.data[3] = 255
      const stamp = () => ctx.putImageData(mark, 1, 1)
      stamp()

      view.dispatch('mousedown', harness.mouseEvent('mousedown', mapUiCentre(harness)))
      dom.window.emit('mouseup', {})

      assert(mapUiPixel(shown, 1, 1).join(',') === '1,2,3,255',
        'a dab redrew the far corner of the derived canvas, so no dirty rectangle is honoured')
      assert(mapUiPixel(terrain, 1, 1).join(',') === air.concat(255).join(','),
        'the mark leaked into the terrain layer, so this check proves nothing about the view')

      // The dab's own cell did get redone, or "only that rect" would be true
      // of an editor that redrew nothing at all.
      const d = terrain._data()
      let at = null
      for (let y = 0; y < d.height && !at; y++) {
        for (let x = 0; x < d.width; x++) {
          const i = (y * d.width + x) * 4
          if (d.pixels[i] !== air[0] || d.pixels[i + 1] !== air[1] || d.pixels[i + 2] !== air[2]) {
            at = { x, y }
            break
          }
        }
      }
      assert(at && mapUiPixel(shown, at.x, at.y)[3] === 255,
        'the cell the dab wrote was not re-derived')

      // And the mark is erasable: a transform invalidates the whole canvas, so
      // the survival above is a dirty rectangle being honoured rather than a
      // canvas nothing ever writes to.
      stamp()
      mapUiByText(nodes, 'Mirror ⇄').dispatch('click', { type: 'click' })
      assert(mapUiPixel(shown, 1, 1).join(',') !== '1,2,3,255',
        'a transform left the derived canvas stale, so the map on screen is not the map')
      return 'a dab left the far corner untouched; a transform rebuilt all of it'
    })
})
