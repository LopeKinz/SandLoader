#!/usr/bin/env node
'use strict'
/**
 * Regression tests for exporting a custom map back out of SandLoader.
 *
 * SandLoader could import a `.custommap`, install one from a mod, edit one and
 * play one, and had no way to get one out - so a map built in the editor could
 * only be shared by someone who knew where the game's user-data folder was.
 * This covers the half of that loop that can be tested without a person at a
 * file dialog:
 *
 *   - the file name offered to the save dialog, which is the only part of the
 *     feature a player has to live with afterwards;
 *   - every refusal, each of which must happen *before* the dialog opens, so
 *     nobody is asked where to put a file that was never going to be written;
 *   - and that what lands on disk is byte-for-byte what was already there,
 *     because re-serialising would produce a file that is only probably the
 *     same, and the person who finds out otherwise is not the one exporting.
 *
 * `dialog.showSaveDialog` itself is not exercised - Electron is not present in
 * a plain-node run. It is stubbed, and by default the stub throws: a test that
 * expects a refusal proves the dialog was never reached, rather than merely
 * assuming it.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const customMaps = require('../src/mods/custom-maps')
const { encodePng } = require('./dom-harness')
const prelude = require('../src/renderer/prelude')

function assert(value, message) {
  if (!value) throw new Error(message)
}

// --------------------------------------------------------------- the stub
/*
 * `require('electron')` is resolved to a cache entry we own, so the export
 * action can be driven end to end. Installed before src/main/entry.js is
 * required, though it would work either way: entry.js reaches for electron
 * inside the action, not at load.
 */
const ELECTRON = path.join(__dirname, '.electron-stub')
let onSaveDialog = () => {
  throw new Error('the save dialog was opened for something that should have been refused first')
}
const resolveFilename = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return ELECTRON
  return resolveFilename.call(this, request, ...rest)
}
require.cache[ELECTRON] = {
  id: ELECTRON,
  filename: ELECTRON,
  loaded: true,
  exports: { dialog: { showSaveDialog: (parent, options) => Promise.resolve(onSaveDialog(options)) } },
}

const entry = require('../src/main/entry')

// -------------------------------------------------------------- fixtures
function quietLogger() {
  const noop = () => {}
  const logger = { info: noop, warn: noop, error: noop, debug: noop }
  logger.child = () => logger
  return logger
}

/** Point the loader at a throwaway userData and run the export action. */
function exportMap(userData, id) {
  entry._runtime.logger = quietLogger()
  entry._runtime.host = { paths: { userData } }
  entry._runtime.gameWindow = null
  return entry._handleRpc({ action: 'exportCustomMap', payload: { id } })
}

/** One layer of a tiny but genuine PNG - `saveDocument` reads the IHDR back. */
function tinyLayers(width, height) {
  const pixels = Buffer.alloc(width * height * 4, 0x40)
  const dataUrl = 'data:image/png;base64,' + encodePng(width, height, pixels).toString('base64')
  const out = {}
  for (const layer of customMaps.LAYERS) out[layer] = { width, height, dataUrl }
  return out
}

/** A real map on disk, written by the same serialiser the editor's save uses. */
function writeMap(mapsDir, name) {
  const saved = customMaps.saveDocument(mapsDir, { name, layers: tinyLayers(4, 3) })
  assert(saved.ok, 'the fixture map could not be written: ' + saved.reason)
  return saved
}

function tempRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'smln-map-export-' + tag + '-'))
}

// ----------------------------------------------------------------- tests
function testFileNameDerivation() {
  const name = entry._exportFileName
  assert(typeof name === 'function', 'entry.js does not export _exportFileName')
  const EXT = customMaps.EXT

  // The plain case: a person's name for their map, kept as they wrote it.
  assert(name('My World') === 'My World' + EXT, 'a plain name was mangled: ' + name('My World'))
  assert(name('Höhle') === 'Höhle' + EXT, 'a non-ASCII name was mangled: ' + name('Höhle'))

  // The `smln.` marker says SandLoader wrote this for a mod and may prune it.
  // A copy the player owns must not carry an invitation to delete it.
  assert(name('smln.arena') === 'arena' + EXT, 'the smln. marker survived: ' + name('smln.arena'))
  assert(name('smln.smln.arena') === 'arena' + EXT, 'a doubled marker survived: ' + name('smln.smln.arena'))
  assert(name('Cosmology smln.x') === 'Cosmology smln.x' + EXT,
    'the marker was stripped from the middle of a name: ' + name('Cosmology smln.x'))

  // Characters no Windows file name may hold, and `/` which no file name may.
  const messy = name('Cave/Slice: "final"? <v2>')
  assert(!/[<>:"/\\|?*]/.test(messy), 'an illegal character survived: ' + messy)
  assert(/Cave/.test(messy) && /final/.test(messy), 'the name was destroyed rather than cleaned: ' + messy)

  // Windows drops a trailing dot or space and then cannot find the file.
  for (const raw of ['trailing.', 'trailing ', ' . leading', 'both . ']) {
    const out = name(raw)
    const stem = out.slice(0, -EXT.length)
    assert(!/[.\s]$/.test(stem) && !/^[.\s]/.test(stem),
      'a leading or trailing dot/space survived for ' + JSON.stringify(raw) + ': ' + JSON.stringify(out))
  }

  // A name that is only punctuation leaves nothing to call the file.
  for (const raw of ['...', '???', '   ', '', null, undefined]) {
    const out = name(raw)
    assert(out === 'custom-map' + EXT,
      'nothing-but-punctuation did not fall back: ' + JSON.stringify(raw) + ' -> ' + out)
  }
  // Punctuation that is legal is still the player's chosen name, so it stays.
  assert(name('!!!') === '!!!' + EXT, 'a legal punctuation name was replaced: ' + name('!!!'))

  // Device names are reserved on Windows at every extension.
  for (const raw of ['con', 'NUL', 'com1', 'LPT9', 'aux.map']) {
    const out = name(raw)
    assert(/^map-/.test(out), 'a reserved device name was used as-is: ' + raw + ' -> ' + out)
  }

  // A single path component tops out at 255 bytes on the filesystems this
  // runs on, and the copy may still go into a deep folder or a zip.
  const long = name('W'.repeat(4000))
  assert(long.length < 200, 'a very long name produced a ' + long.length + '-character file name')
  assert(long.slice(-EXT.length) === EXT, 'the extension was truncated away: ' + long)
  // Cutting UTF-16 in half can leave a lone surrogate, which is not a
  // character any filesystem will store.
  const surrogates = name('\u{1F5FA}'.repeat(500))
  assert(!/[\uD800-\uDFFF]/.test(surrogates.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')),
    'a lone surrogate survived the length cap')

  // Never a path, never a doubled extension, always something to click.
  for (const raw of ['a/b/c', '..', '../../etc/passwd', 'world' + EXT, 'x'.repeat(300)]) {
    const out = name(raw)
    assert(out.indexOf('/') === -1 && out.indexOf('\\') === -1, 'a separator survived: ' + raw + ' -> ' + out)
    assert(out.slice(-EXT.length) === EXT && out.length > EXT.length, 'not a usable file name: ' + out)
    assert(out.indexOf(EXT + EXT) === -1, 'the extension was doubled: ' + out)
  }
}

function testRefusalsHappenBeforeTheDialog() {
  const root = tempRoot('refuse')
  const mapsDir = path.join(root, 'custom_maps')
  fs.mkdirSync(mapsDir, { recursive: true })

  // The stub throws if it is called, so every case here also proves the
  // player was never asked where to save something unsaveable.
  fs.writeFileSync(path.join(mapsDir, 'broken.custommap'), 'this is not a map file at all')
  fs.writeFileSync(path.join(mapsDir, 'halfway.custommap'),
    JSON.stringify({ id: 'halfway', name: 'Halfway', params: { width: 4, height: 3 } }) + '\n' +
    JSON.stringify({ id: 'halfway', terrain: { width: 4, height: 3, dataUrl: 'data:image/png;base64,AA==' } }))
  // A directory wearing a map's name: readable-in-principle, unreadable in fact.
  fs.mkdirSync(path.join(mapsDir, 'folder.custommap'))

  const good = writeMap(mapsDir, 'Fine')

  return Promise.all([
    exportMap(root, 'broken'),
    exportMap(root, 'halfway'),
    exportMap(root, 'folder'),
    exportMap(root, 'ghost'),
    exportMap(root, ''),
    exportMap(root, path.join('..', '..', 'somewhere-else')),
    // The control: a map that is fine gets as far as the dialog, which proves
    // the stub is wired and that the silence of every case above is the code
    // refusing early rather than the stub failing to fire.
    entry._handleRpc({ action: 'exportCustomMap', payload: { id: good.id } })
      .then((r) => r, (e) => e),
  ]).then(([broken, halfway, folder, ghost, empty, escape, control]) => {
    assert(control instanceof Error && /save dialog was opened/.test(control.message),
      'a perfectly good map did not reach the save dialog, so nothing above proves anything: ' +
      JSON.stringify(control))

    for (const [what, r] of [['broken', broken], ['halfway', halfway], ['folder', folder],
      ['ghost', ghost], ['empty', empty], ['escape', escape]]) {
      assert(r && r.ok === false, what + ' was not refused: ' + JSON.stringify(r))
      assert(!r.cancelled, what + ' was reported as a cancelled dialog')
      assert(typeof r.reason === 'string' && r.reason.length > 10,
        what + ' was refused without saying why: ' + JSON.stringify(r))
    }

    // Four outcomes, four readings. A player who cannot tell "it is gone" from
    // "it is broken" from "I cancelled" has been told nothing.
    assert(/would not load/.test(broken.reason), 'a corrupt file did not read as unloadable: ' + broken.reason)
    assert(/six layers/.test(halfway.reason),
      'a map missing layers did not carry the inspector\'s own reason: ' + halfway.reason)
    assert(/no map called "ghost"/.test(ghost.reason), 'a missing map did not read as missing: ' + ghost.reason)
    assert(/could not be read/.test(folder.reason), 'an unreadable file did not read as unreadable: ' + folder.reason)
    assert(ghost.reason !== folder.reason && folder.reason !== broken.reason,
      'missing, unreadable and broken all read the same')
    assert(/not the name of a map/.test(escape.reason),
      'an id that climbs out of the maps folder was not refused as such: ' + escape.reason)

    // Nothing was written anywhere in the process.
    assert(fs.readdirSync(mapsDir).sort().join(',') ===
      ['broken.custommap', 'folder.custommap', 'halfway.custommap', good.file].sort().join(','),
      'a refused export left something behind in the maps folder')
    fs.rmSync(root, { recursive: true, force: true })
  }, (e) => {
    fs.rmSync(root, { recursive: true, force: true })
    throw e
  })
}

function testExportedBytesAreTheBytesOnDisk() {
  const root = tempRoot('bytes')
  const mapsDir = path.join(root, 'custom_maps')
  const out = path.join(root, 'out')
  fs.mkdirSync(out, { recursive: true })
  fs.mkdirSync(mapsDir, { recursive: true })

  /*
   * Deliberately not written by `custom-maps.serialise()`. A file that
   * function produced would survive being re-serialised unchanged, so it
   * cannot tell a copy from a rebuild - and the files most worth exporting are
   * the ones it did not write: the game's own saves, a map that came in
   * through the importer, one somebody edited by hand. This one is valid and
   * loads, and differs from canonical form in three ways that a rebuild would
   * quietly erase: the metadata keys are in another order, the document holds
   * a field this loader has never heard of, and the file ends with a newline.
   */
  const name = 'Ravine: the "deep" one/2'
  const stem = 'ravine'
  const layers = tinyLayers(4, 3)
  const common = { id: stem, name, seed: 'xyz', createdAt: '2024-03-04T05:06:07.000Z', version: 1 }
  const text =
    JSON.stringify({ version: 1, params: { width: 4, height: 3 }, name, id: stem, seed: 'xyz',
      createdAt: common.createdAt }) + '\n' +
    JSON.stringify(Object.assign({}, layers, common,
      { params: { width: 4, height: 3 }, authoredBy: 'a tool this loader has never heard of' })) + '\n'
  fs.writeFileSync(path.join(mapsDir, stem + customMaps.EXT), text)

  const saved = { id: stem, file: stem + customMaps.EXT }
  const source = fs.readFileSync(path.join(mapsDir, saved.file))
  assert(customMaps.inspect(source.toString('utf8')).ok, 'the fixture map does not load, so it proves nothing')
  assert(Buffer.compare(source, Buffer.from(customMaps.serialise(
    JSON.parse(text.slice(text.indexOf('\n') + 1))))) !== 0,
    'the fixture is already in canonical form, so a rebuild would pass this test')

  let offered = null
  const dest = path.join(out, 'chosen-by-the-player.custommap')
  onSaveDialog = (options) => {
    offered = options
    return { canceled: false, filePath: dest }
  }

  return exportMap(root, saved.id).then((r) => {
    assert(r && r.ok === true, 'a good map did not export: ' + JSON.stringify(r))
    assert(r.file === dest, 'the export went somewhere other than where the dialog said: ' + r.file)

    const copied = fs.readFileSync(dest)
    assert(Buffer.compare(source, copied) === 0,
      'the exported file is not byte-identical: ' + source.length + ' bytes in, ' + copied.length + ' out')

    // The dialog was asked for the right thing: a name derived from the map's
    // own display name, and its own overwrite confirmation left in place.
    assert(offered && offered.defaultPath === entry._exportFileName(name),
      'the dialog was offered ' + JSON.stringify(offered && offered.defaultPath))
    assert(path.basename(offered.defaultPath) === offered.defaultPath,
      'the default name is a path, so it could point outside the folder the player picks')
    assert((offered.properties || []).indexOf('showOverwriteConfirmation') !== -1,
      'the dialog was told not to confirm overwriting')

    // And the source is untouched: an export is a copy, not a move.
    assert(Buffer.compare(fs.readFileSync(path.join(mapsDir, saved.file)), source) === 0,
      'exporting changed the map it exported')
  }).then(() => {
    fs.rmSync(root, { recursive: true, force: true })
    onSaveDialog = () => { throw new Error('the save dialog was opened unexpectedly') }
  }, (e) => {
    fs.rmSync(root, { recursive: true, force: true })
    onSaveDialog = () => { throw new Error('the save dialog was opened unexpectedly') }
    throw e
  })
}

function testCancelAndFailedWriteReadDifferently() {
  const root = tempRoot('outcome')
  const mapsDir = path.join(root, 'custom_maps')
  const saved = writeMap(mapsDir, 'Outcomes')

  onSaveDialog = () => ({ canceled: true, filePath: undefined })
  return exportMap(root, saved.id).then((cancelled) => {
    assert(cancelled && cancelled.ok === false && cancelled.cancelled === true,
      'a cancelled dialog is not reported as a cancellation: ' + JSON.stringify(cancelled))
    assert(cancelled.reason == null,
      'a cancellation carries a failure reason, so it would read as an error: ' + cancelled.reason)

    // A folder cannot be overwritten by a file, which is as close to "the
    // write failed" as this can portably get.
    const wall = path.join(root, 'a-directory.custommap')
    fs.mkdirSync(wall)
    onSaveDialog = () => ({ canceled: false, filePath: wall })
    return exportMap(root, saved.id)
  }).then((failed) => {
    assert(failed && failed.ok === false, 'a failed write reported success: ' + JSON.stringify(failed))
    assert(!failed.cancelled, 'a failed write was reported as a cancellation')
    assert(/could not be written/.test(failed.reason || ''),
      'a failed write did not say the write failed: ' + failed.reason)
    assert(/a-directory\.custommap/.test(failed.reason),
      'a failed write did not name the file it could not write: ' + failed.reason)
  }).then(() => {
    fs.rmSync(root, { recursive: true, force: true })
    onSaveDialog = () => { throw new Error('the save dialog was opened unexpectedly') }
  }, (e) => {
    fs.rmSync(root, { recursive: true, force: true })
    onSaveDialog = () => { throw new Error('the save dialog was opened unexpectedly') }
    throw e
  })
}

function testEveryExportStringIsTranslated() {
  // tx() falls back to an English literal when a key is missing, so a key with
  // no locale entry is invisible in development and permanent for everyone
  // playing in another language. That has shipped repeatedly here.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'mapsui.js'), 'utf8')
  const locales = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'locales.js'), 'utf8')

  const asked = new Set()
  const call = /\btx\(\s*'(maps\.export[\w.]*|maps\.exported)'\s*[,)]/g
  let m
  while ((m = call.exec(src))) asked.add(m[1])
  assert(asked.size >= 4, 'found ' + asked.size + ' export strings - the scan is broken, not the code')

  const missing = []
  for (const key of asked) {
    const rows = locales.split('\n').filter((l) => l.includes("'" + key + "'"))
    if (rows.length < 2) missing.push(key + ' (in ' + rows.length + ' locale(s))')
  }
  assert(!missing.length, 'these would show English to every other language: ' + missing.join(', '))
}

function testTheButtonFollowsTheSelection() {
  const vm = require('vm')
  const { createDom } = require('./dom-harness')

  function boot(maps, locale) {
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
      MutationObserver: dom.window.MutationObserver,
      electron: {
        log() {},
        customMaps: {
          list: () => Promise.resolve(maps),
          load: () => Promise.resolve({ terrain: { width: 4, height: 3, dataUrl: 'data:image/png;base64,AA==' } }),
        },
      },
    }
    sandbox.globalThis = sandbox
    sandbox.self = sandbox
    sandbox.window.document = dom.document
    vm.createContext(sandbox)
    new vm.Script(prelude.build({ reload: true, mods: [], locale: locale || 'en' }), { filename: 'prelude.js' })
      .runInContext(sandbox)
    sandbox.__SMLN__.mapsUI.toggle(true)
    return dom
  }

  function findExport(dom) {
    let found = null
    ;(function walk(node) {
      if ((node.className || '').split(/\s+/).indexOf('export') !== -1) found = node
      for (const child of node.childNodes || []) walk(child)
    })(dom.document.getElementById('smln-maps'))
    return found
  }

  const withMaps = boot([{ id: 'ravine', name: 'Ravine', params: { width: 4, height: 3 } }])
  const withNone = boot([], 'de')

  return new Promise((resolve, reject) => setTimeout(() => {
    try {
      const enabled = findExport(withMaps)
      assert(enabled, 'the maps overlay footer has no Export button')
      assert(enabled.disabled === false,
        'Export is still disabled with a map selected')

      const disabled = findExport(withNone)
      assert(disabled, 'the Export button is missing when there are no maps')
      assert(disabled.disabled === true, 'Export is live with nothing selected, so it acts on nothing')
      // Booted in German: proof the label goes through the catalogue rather
      // than through tx()'s English fallback.
      assert(disabled.textContent === 'Karte exportieren ...',
        'the Export label did not come from the locale: ' + JSON.stringify(disabled.textContent))
      resolve()
    } catch (e) { reject(e) }
  }, 30))
}

Promise.resolve()
  .then(testFileNameDerivation)
  .then(testRefusalsHappenBeforeTheDialog)
  .then(testExportedBytesAreTheBytesOnDisk)
  .then(testCancelAndFailedWriteReadDifferently)
  .then(testEveryExportStringIsTranslated)
  .then(testTheButtonFollowsTheSelection)
  .then(() => {
    console.log('PASS custom map export regression tests')
  }, (e) => {
    console.error('FAIL custom map export regression tests:', (e && e.stack) || e)
    process.exit(1)
  })
