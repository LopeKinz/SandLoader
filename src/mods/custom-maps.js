'use strict'
/**
 * Map mods, and the pipeline Sandustry already had.
 *
 * The loader used to read a map mod's blueprints and then drop them, on the
 * grounds that loading needed game-side support that was not exposed. It is
 * exposed: `preload.js` offers customMaps save/load/list/delete, the handlers
 * are registered outside the MODDING_ENABLED branch, and the renderer builds a
 * world from six PNG layers named terrain, lights, lightsMeta, sensors,
 * authorization and wall. A `.custommap` is that JSON, and the game lists the
 * folder itself.
 *
 * So this module does the one thing that was missing: turn a mod's PNGs into
 * that file, and put it where the game looks.
 */

const fs = require('fs')
const path = require('path')

/** The six fields the renderer reads, in the order it reads them. */
const LAYERS = ['terrain', 'lights', 'lightsMeta', 'sensors', 'authorization', 'wall']

/** Everything this module writes starts here, and only these may be removed. */
const PREFIX = 'smln.'
const EXT = '.custommap'

/** The game truncates a map file name at 200 characters, and the extension counts. */
const MAX_ID = 180

/**
 * Width and height from a PNG's IHDR, or null if it is not a PNG.
 *
 * Reading the header by hand keeps the dependency list empty. Nothing here
 * decodes pixels - the game does that, and the only thing worth checking
 * before handing it a file is that the layers describe the same world.
 */
function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < signature.length; i++) {
    if (buffer[i] !== signature[i]) return null
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/**
 * Build the document the game reads, from a mod's blueprints.
 *
 * @param {{modId:string, name?:string, seed?:string, params?:object,
 *          blueprints:Record<string,string>}} mapSpec
 * @returns {{ok:true, id:string, file:string, doc:object, fileText:string}|{ok:false, reason:string}}
 */
function assemble(mapSpec) {
  const spec = mapSpec || {}
  const modId = String(spec.modId || '').trim()
  if (!modId) return { ok: false, reason: 'the map has no mod id' }
  const blueprints = spec.blueprints || {}

  // The game's own loader awaits all six at once and has no undefined-guard,
  // so a missing layer does not degrade - the whole map fails to load. A
  // blank stand-in would be guessing what an invented layer means to the
  // game, so a partial set is refused instead of padded.
  const missing = LAYERS.filter((layer) => !blueprints[layer])
  if (missing.length) {
    return { ok: false, reason: `a map needs all six layers; missing: ${missing.join(', ')}` }
  }

  const doc = {}
  let size = null
  for (const layer of LAYERS) {
    const file = blueprints[layer]

    let buffer
    try {
      buffer = fs.readFileSync(file)
    } catch (e) {
      return { ok: false, reason: `${layer}: ${(e && e.message) || 'could not be read'}` }
    }

    const dims = pngSize(buffer)
    if (!dims) return { ok: false, reason: `${layer}: ${path.basename(file)} is not a PNG` }
    if (!size) size = dims
    else if (dims.width !== size.width || dims.height !== size.height) {
      return {
        ok: false,
        reason: `${layer} has dimensions ${dims.width}x${dims.height} but terrain is ` +
          `${size.width}x${size.height}; every layer must describe the same world`,
      }
    }

    // The game sizes its canvas from width/height before drawing the image,
    // not from the PNG itself, so the dimensions have to travel alongside
    // the pixels rather than only inside them.
    doc[layer] = { width: dims.width, height: dims.height, dataUrl: 'data:image/png;base64,' + buffer.toString('base64') }
  }

  // The id doubles as the file name and as what the game shows and boots with,
  // so the mod is visible in the browser and two mods cannot collide. One mod
  // yields one map: a .custommap carries all six layers at once.
  const id = PREFIX + modId

  doc.id = id
  doc.name = typeof spec.name === 'string' && spec.name ? spec.name : modId
  doc.seed = typeof spec.seed === 'string' ? spec.seed : ''
  doc.params = spec.params && typeof spec.params === 'object'
    ? spec.params
    : { width: size.width, height: size.height }
  doc.version = 1
  doc.createdAt = new Date().toISOString()

  return { ok: true, id, file: id + EXT, doc, fileText: serialise(doc) }
}

/**
 * The two lines the game reads, from a finished document.
 *
 * The game's own save routine writes metadata on the first line and the full
 * document on the second, and its two readers split on that exact boundary -
 * so a single-JSON file loads far enough to appear in the browser, then fails
 * the moment it is opened.
 *
 * Every path that writes a `.custommap` from scratch goes through here, so the
 * editor and the mod installer cannot drift into two spellings of the same
 * format.
 *
 * @param {object} doc  the six layers plus id, name, seed, createdAt, version, params
 * @returns {string}
 */
function serialise(doc) {
  const metadata = {
    id: doc.id, name: doc.name, seed: doc.seed,
    createdAt: doc.createdAt, version: doc.version, params: doc.params,
  }
  return JSON.stringify(metadata) + '\n' + JSON.stringify(doc)
}

/** Is this a file this module wrote? Nothing else may ever be deleted. */
function ours(fileName) {
  return fileName.indexOf(PREFIX) === 0 && fileName.slice(-EXT.length) === EXT
}

/**
 * Bring the folder in line with the map mods that are enabled right now.
 *
 * Writes each one's map, and removes the maps of mods that are no longer here.
 * The player's own files are not ours to touch, so the only things considered
 * for removal are names this module could have produced - checked by prefix and
 * extension, not by guessing.
 *
 * @param {string} mapsDir  `<userData>/custom_maps`
 * @param {Array<object>} specs  one mapSpec per enabled map mod
 */
function sync(mapsDir, specs) {
  const installed = []
  const removed = []
  const failed = []
  const keep = Object.create(null)

  try {
    fs.mkdirSync(mapsDir, { recursive: true })
  } catch (e) {
    return { installed, removed, failed: [{ modId: null, reason: 'could not create ' + mapsDir + ': ' + e.message }] }
  }

  for (const spec of specs || []) {
    const built = assemble(spec)
    if (!built.ok) {
      failed.push({ modId: (spec && spec.modId) || null, reason: built.reason })
      continue
    }
    try {
      fs.writeFileSync(path.join(mapsDir, built.file), built.fileText)
      keep[built.file.toLowerCase()] = true
      installed.push(built.file)
    } catch (e) {
      failed.push({ modId: spec.modId, reason: 'could not write ' + built.file + ': ' + e.message })
    }
  }

  let entries = []
  try { entries = fs.readdirSync(mapsDir) } catch (_e) { entries = [] }
  for (const name of entries) {
    if (!ours(name) || keep[name.toLowerCase()]) continue
    try {
      fs.rmSync(path.join(mapsDir, name), { force: true })
      removed.push(name)
    } catch (_e) { /* a map we cannot remove is not worth failing the load over */ }
  }

  return { installed, removed, failed }
}

/**
 * Read a `.custommap` far enough to know the game can open it.
 *
 * The two-line split and the per-layer shape are the two things that make a
 * file load or fail, and neither is visible from the file name - so a picked
 * file is checked here rather than discovered broken at world start.
 *
 * @returns {{ok:true, meta:object, doc:object}|{ok:false, reason:string}}
 */
function inspect(fileText) {
  if (typeof fileText !== 'string' || !fileText.trim()) return { ok: false, reason: 'the file is empty' }
  const cut = fileText.indexOf('\n')
  if (cut === -1) return { ok: false, reason: 'a map file has two lines: metadata, then the document' }

  let meta
  let doc
  try {
    meta = JSON.parse(fileText.slice(0, cut))
    doc = JSON.parse(fileText.slice(cut + 1))
  } catch (e) {
    return { ok: false, reason: 'this is not a map file: ' + e.message }
  }
  if (!meta || typeof meta !== 'object' || !doc || typeof doc !== 'object') {
    return { ok: false, reason: 'this is not a map file' }
  }

  // The game's own Custom Maps list renders `params.width` and `params.height`
  // without a guard, so a file missing them passes every check here and then
  // takes that screen down. `id` is checked for the same reason the importer
  // rewrites it: the game opens a map by asking for `<id>.custommap`.
  if (typeof meta.id !== 'string' || !meta.id) {
    return { ok: false, reason: 'this map has no id, so the game cannot open it' }
  }
  if (!meta.params || typeof meta.params !== 'object' ||
      !meta.params.width || !meta.params.height) {
    return { ok: false, reason: 'this map has no size in its metadata; the game reads it unguarded and would crash' }
  }

  const missing = LAYERS.filter((layer) => {
    const l = doc[layer]
    return !l || typeof l !== 'object' || typeof l.dataUrl !== 'string' || !l.width || !l.height
  })
  if (missing.length) {
    return { ok: false, reason: 'a map needs all six layers; missing or malformed: ' + missing.join(', ') }
  }

  return { ok: true, meta, doc }
}

/**
 * Install a `.custommap` the player picked from disk.
 *
 * Two things are deliberate. An imported map never carries PREFIX, because
 * that prefix marks a file SandLoader wrote for a mod and may prune - an
 * imported map must outlive a mod it never came from. And the id inside the
 * file is rewritten to match the file name, because the game opens a map by
 * asking for `<id>.custommap`: a file whose name and id disagree lists
 * perfectly and then fails the moment it is started.
 *
 * @param {string} mapsDir  `<userData>/custom_maps`
 * @param {string} srcPath  the file the player picked
 * @returns {{ok:true, id:string, name:string, file:string}|{ok:false, reason:string}}
 */
function importFile(mapsDir, srcPath) {
  let fileText
  try {
    fileText = fs.readFileSync(srcPath, 'utf8')
  } catch (e) {
    return { ok: false, reason: 'could not read that file: ' + e.message }
  }

  const seen = inspect(fileText)
  if (!seen.ok) return seen

  const safe = mapId(path.basename(String(srcPath)), 'imported-map')

  try {
    fs.mkdirSync(mapsDir, { recursive: true })
  } catch (e) {
    return { ok: false, reason: 'could not open the maps folder: ' + e.message }
  }

  let id = safe
  for (let n = 2; fs.existsSync(path.join(mapsDir, id + EXT)); n++) id = safe + '-' + n

  const meta = { ...seen.meta, id }
  const doc = { ...seen.doc, id }
  const name = typeof meta.name === 'string' && meta.name ? meta.name : id
  meta.name = name
  doc.name = name

  const file = id + EXT
  try {
    fs.writeFileSync(path.join(mapsDir, file), JSON.stringify(meta) + '\n' + JSON.stringify(doc))
  } catch (e) {
    return { ok: false, reason: 'could not write into the maps folder: ' + e.message }
  }

  return { ok: true, id, name, file }
}

/**
 * Turn any proposed name into an id the game can open and we may not prune.
 *
 * One rule, used by both the importer and the editor's save, because the two
 * failure modes it avoids are not obvious enough to re-derive:
 *
 *   - The id doubles as the file name (`<id>.custommap`), so anything outside
 *     the safe set is folded to a dash.
 *   - PREFIX marks a file `sync()` may delete. An imported or authored map is
 *     not a mod's map and must survive that mod being removed, so a leading
 *     prefix is stripped, and the result is re-checked with `ours()` itself -
 *     "smln" alone would otherwise become smln.custommap and get pruned.
 *   - The game truncates a map file name at 200 characters when it looks one
 *     up, so a longer name imports, lists, and then fails to open.
 *
 * @param {string} raw  a file name, a map id, or an author's title
 * @param {string} fallback  used when nothing usable survives
 * @returns {string}
 */
function mapId(raw, fallback) {
  const base = String(raw || '')
  const stem = base.slice(-EXT.length) === EXT ? base.slice(0, -EXT.length) : base
  let safe = stem.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').replace(/[-.]+$/, '')
  while (safe.indexOf(PREFIX) === 0) safe = safe.slice(PREFIX.length)
  if (!safe) safe = fallback
  if (safe.length > MAX_ID) safe = safe.slice(0, MAX_ID).replace(/[-.]+$/, '') || fallback
  while (ours(safe + EXT)) safe = 'map-' + safe
  return safe
}

/**
 * Write a map the in-game editor authored.
 *
 * The editor hands over the six layers already encoded, because that is the
 * shape a canvas produces (`toDataURL`) and the shape the game reads - there
 * is no PNG file on disk in between. Everything else is the same contract
 * `assemble` honours, through the same serialiser.
 *
 * Sizes are checked against each PNG's own IHDR rather than trusted: the game
 * sizes each layer's canvas from the recorded width/height and then draws the
 * image at 0,0 without scaling, so a disagreement is not an error anywhere -
 * it is a silently clipped or transparently padded world.
 *
 * A save with an `id` overwrites that map, because editing a map and saving it
 * somewhere else is not editing. A save without one derives an id from the
 * name and steps aside from any file already there.
 *
 * @param {string} mapsDir  `<userData>/custom_maps`
 * @param {{id?:string|null, name?:string, seed?:string, params?:object,
 *          createdAt?:string,
 *          layers:Record<string,{width:number,height:number,dataUrl:string}>}} spec
 * @returns {{ok:true, id:string, name:string, file:string}|{ok:false, reason:string}}
 */
function saveDocument(mapsDir, spec) {
  const s = spec || {}
  const layers = s.layers && typeof s.layers === 'object' ? s.layers : {}
  const HEAD = 'data:image/png;base64,'

  const missing = LAYERS.filter((layer) => {
    const l = layers[layer]
    return !l || typeof l !== 'object' || typeof l.dataUrl !== 'string' || !l.width || !l.height
  })
  if (missing.length) {
    return { ok: false, reason: 'a map needs all six layers; missing or malformed: ' + missing.join(', ') }
  }

  const doc = {}
  let size = null
  for (const layer of LAYERS) {
    const l = layers[layer]
    const width = Math.trunc(l.width)
    const height = Math.trunc(l.height)
    if (!(width > 0) || !(height > 0)) return { ok: false, reason: `${layer} has no size` }
    if (l.dataUrl.slice(0, HEAD.length) !== HEAD) {
      return { ok: false, reason: `${layer} is not a PNG data URL` }
    }
    const dims = pngSize(Buffer.from(l.dataUrl.slice(HEAD.length), 'base64'))
    if (!dims) return { ok: false, reason: `${layer} is not a PNG` }
    if (dims.width !== width || dims.height !== height) {
      return {
        ok: false,
        reason: `${layer} says it is ${width}x${height} but its image is ${dims.width}x${dims.height}`,
      }
    }
    if (!size) size = dims
    else if (dims.width !== size.width || dims.height !== size.height) {
      return {
        ok: false,
        reason: `${layer} has dimensions ${dims.width}x${dims.height} but terrain is ` +
          `${size.width}x${size.height}; every layer must describe the same world`,
      }
    }
    doc[layer] = { width, height, dataUrl: l.dataUrl }
  }

  try {
    fs.mkdirSync(mapsDir, { recursive: true })
  } catch (e) {
    return { ok: false, reason: 'could not open the maps folder: ' + e.message }
  }

  const named = typeof s.name === 'string' && s.name.trim() ? s.name.trim() : ''
  let id
  if (s.id) {
    id = mapId(s.id, 'untitled-map')
  } else {
    const stem = mapId(named || 'untitled-map', 'untitled-map')
    id = stem
    for (let n = 2; fs.existsSync(path.join(mapsDir, id + EXT)); n++) id = stem + '-' + n
  }

  doc.id = id
  doc.name = named || id
  doc.seed = typeof s.seed === 'string' ? s.seed : ''
  // The pixels are the only size the game reads; params is metadata the
  // browser shows, so it is made to agree with them rather than believed.
  doc.params = Object.assign({}, s.params && typeof s.params === 'object' ? s.params : null,
    { width: size.width, height: size.height })
  doc.version = 1
  doc.createdAt = typeof s.createdAt === 'string' && s.createdAt ? s.createdAt : new Date().toISOString()

  const file = id + EXT
  try {
    fs.writeFileSync(path.join(mapsDir, file), serialise(doc))
  } catch (e) {
    return { ok: false, reason: 'could not write into the maps folder: ' + e.message }
  }

  return { ok: true, id, name: doc.name, file }
}

module.exports = {
  assemble, sync, importFile, inspect, pngSize, serialise, mapId, saveDocument,
  LAYERS, PREFIX, EXT,
}
