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
 * @returns {{ok:true, id:string, file:string, doc:object}|{ok:false, reason:string}}
 */
function assemble(mapSpec) {
  const spec = mapSpec || {}
  const modId = String(spec.modId || '').trim()
  if (!modId) return { ok: false, reason: 'the map has no mod id' }
  const blueprints = spec.blueprints || {}

  // Without terrain there is no world; the rest may be blank.
  if (!blueprints.terrain) return { ok: false, reason: 'no "terrain" blueprint - a map needs one' }

  const doc = {}
  let size = null
  for (const layer of LAYERS) {
    const file = blueprints[layer]
    if (!file) { doc[layer] = null; continue }

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

    doc[layer] = 'data:image/png;base64,' + buffer.toString('base64')
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

  return { ok: true, id, file: id + EXT, doc }
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
      fs.writeFileSync(path.join(mapsDir, built.file), JSON.stringify(built.doc))
      keep[built.file] = true
      installed.push(built.file)
    } catch (e) {
      failed.push({ modId: spec.modId, reason: 'could not write ' + built.file + ': ' + e.message })
    }
  }

  let entries = []
  try { entries = fs.readdirSync(mapsDir) } catch (_e) { entries = [] }
  for (const name of entries) {
    if (!ours(name) || keep[name]) continue
    try {
      fs.rmSync(path.join(mapsDir, name), { force: true })
      removed.push(name)
    } catch (_e) { /* a map we cannot remove is not worth failing the load over */ }
  }

  return { installed, removed, failed }
}

module.exports = { assemble, sync, pngSize, LAYERS, PREFIX, EXT }
