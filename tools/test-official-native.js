#!/usr/bin/env node
'use strict'
/** Regression tests for official Sandkit lifecycle bridging. */

const fs = require('fs')
const os = require('os')
const path = require('path')

const bridge = require('../src/mods/official-native')
const official = require('../src/mods/official')
const manage = require('../src/mods/manage')

function assert(value, message) {
  if (!value) throw new Error(message)
}

function writeMod(dir, id) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'modinfo.json'), JSON.stringify({
    manifestVersion: 1,
    id,
    name: 'Native bridge fixture',
    version: '1.0.0',
    apiVersion: 1,
    entry: 'main.js',
    workerEntry: 'worker.js',
  }))
  fs.writeFileSync(path.join(dir, 'main.js'), 'const api = sandkit.api;')
  fs.writeFileSync(path.join(dir, 'worker.js'), 'const api = sandkit.api;')
  fs.writeFileSync(path.join(dir, 'sprite.png'), 'v1')
  fs.writeFileSync(path.join(dir, 'workshop.json'), '{"itemId":"123"}')
}

function testBridge() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-native-bridge-'))
  try {
    const userData = path.join(root, 'user')
    const source = path.join(root, 'source')
    writeMod(source, 'fixture.native-bridge')
    const mod = { id: 'fixture.native-bridge', version: '1.0.0', dir: source, enabled: true }

    let r = bridge.sync([mod], { userData })
    assert(r.errors.length === 0, 'initial bridge sync failed: ' + r.errors.map((e) => e.message).join('; '))
    assert(r.staged.length === 1, 'initial bridge sync did not stage the mod')

    const dest = path.join(userData, 'mods', bridge.stageName(mod.id))
    assert(fs.existsSync(path.join(dest, 'main.js')), 'staged main.js is missing')
    assert(fs.existsSync(path.join(dest, 'worker.js')), 'staged worker.js is missing')
    assert(!fs.existsSync(path.join(dest, 'workshop.json')), 'staged local copy retained workshop.json')

    r = bridge.sync([mod], { userData })
    assert(r.reused.length === 1 && r.staged.length === 0, 'unchanged stage was recopied')

    fs.writeFileSync(path.join(source, 'sprite.png'), 'asset changed and longer')
    r = bridge.sync([mod], { userData })
    assert(r.staged.length === 1, 'asset-only source change did not refresh native stage')

    fs.mkdirSync(path.join(userData, 'smln', 'config'), { recursive: true })
    fs.writeFileSync(path.join(userData, 'smln', 'config', 'mods.json'), JSON.stringify({ [mod.id]: false }))
    r = bridge.sync([mod], { userData })
    assert(r.removed.includes(mod.id), 'disabling the mod did not remove its native stage')
    assert(!fs.existsSync(dest), 'disabled native stage still exists')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function testOfficialDiscoveryShape() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-official-shape-'))
  try {
    writeMod(root, 'fixture.shape')
    const r = official.readMod(root)
    assert(r.ok, 'official fixture was rejected')
    // `entry` and `workerEntry` drive execution: entry.js injects them through
    // the prelude, wrapped in SMLN.official.execute().
    //
    // They were once forced to undefined, on the theory that the native bridge
    // staging into <userData>/mods would run them instead. It does not.
    // Sandustry has no loader of its own for local mods - it delegates to
    // whatever occupies the Workshop slot, which is SandLoader. So forcing them
    // off meant staging reported success, the manager showed "Enabled", and
    // nothing ever ran: the "enabled but not loaded" bug.
    //
    // This check used to assert they were undefined, and stayed red from the
    // day that bug was fixed. It now pins the contract that replaced it.
    assert(r.mod.entry && r.mod.entry.endsWith('main.js'),
      'official main entry is not set, so nothing will execute the mod')
    assert(r.mod.workerEntry && r.mod.workerEntry.endsWith('worker.js'),
      'official worker entry is not set, so its worker half will not run')
    assert(r.mod.nativeEntry && r.mod.nativeEntry.endsWith('main.js'), 'native main entry path was not retained')
    assert(r.mod.nativeWorkerEntry && r.mod.nativeWorkerEntry.endsWith('worker.js'), 'native worker path was not retained')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function testZipManifestDetection() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-manifest-detect-'))
  try {
    fs.writeFileSync(path.join(root, 'modinfo.json'), JSON.stringify({
      manifestVersion: 1,
      id: 'fixture.official-zip',
      version: '1.0.0',
    }))
    const manifest = manage.readManifest(root)
    assert(manifest && manifest.flavour === 'official', 'official modinfo.json was not recognised by ZIP installer')
    assert(manifest.id === 'fixture.official-zip', 'official ZIP id came from the wrong field')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

try {
  testBridge()
  testOfficialDiscoveryShape()
  testZipManifestDetection()
  console.log('PASS official Sandkit native bridge regression tests')
} catch (e) {
  console.error('FAIL official Sandkit native bridge regression tests:', e.message)
  process.exit(1)
}
