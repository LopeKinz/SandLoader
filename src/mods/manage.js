'use strict'
/**
 * Installing, removing and revealing mods.
 *
 * All of it runs in the main process, driven by the in-game manager. Two rules
 * shape the code:
 *
 *   1. An archive is untrusted input. It must declare a valid manifest before
 *      anything is written, and it is unpacked to a temporary directory first
 *      so a broken archive cannot leave a half-installed mod behind.
 *   2. Deletion only ever touches a directory that is genuinely inside a known
 *      mods root and genuinely looks like a mod. A path that fails either check
 *      is refused, not "cleaned up".
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const zip = require('./zip')
const { SmlnError, toSmlnError } = require('../core/errors')

const SMLN_MANIFEST = 'smln.mod.json'
const FLUX_MANIFEST = 'modinfo.json'

/** Read whichever manifest an unpacked directory carries. */
function readManifest(dir) {
  for (const [file, flavour] of [[SMLN_MANIFEST, 'smln'], [FLUX_MANIFEST, 'fluxloader']]) {
    const p = path.join(dir, file)
    if (!fs.existsSync(p)) continue
    try {
      const json = JSON.parse(fs.readFileSync(p, 'utf8'))
      const id = flavour === 'smln' ? json.id : json.modID
      if (typeof id === 'string' && id) {
        return { id, flavour, version: String(json.version || '0.0.0'), name: json.name || id, json }
      }
      return null
    } catch (_) {
      return null
    }
  }
  return null
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); return true } catch (_) { return false }
}

/**
 * Install a mod from a .zip.
 *
 * @param {string} zipPath
 * @param {{smlnRoot:string, fluxRoot:string, logger:any}} ctx
 * @returns {{ok:true, id:string, flavour:string, dir:string, replaced:boolean}|{ok:false, error:string}}
 */
function installFromZip(zipPath, ctx) {
  const { logger } = ctx
  let staging = null
  try {
    if (!fs.existsSync(zipPath)) return { ok: false, error: 'file not found: ' + zipPath }

    staging = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-install-'))
    const result = zip.extract(zipPath, staging)
    logger.info(`unpacked ${result.files} file(s) from ${path.basename(zipPath)}`)
    if (result.skipped.length) {
      // Refuse outright: an archive containing traversal paths is not a mod
      // someone packaged carelessly, it is one built to escape.
      logger.error(`archive contains unsafe paths: ${result.skipped.slice(0, 5).join(', ')}`)
      return { ok: false, error: 'archive contains paths that escape the mod folder - refused' }
    }

    const manifest = readManifest(staging)
    if (!manifest) {
      return {
        ok: false,
        error: `no valid ${SMLN_MANIFEST} or ${FLUX_MANIFEST} found in the archive`,
      }
    }

    const root = manifest.flavour === 'fluxloader' ? ctx.fluxRoot : ctx.smlnRoot
    fs.mkdirSync(root, { recursive: true })
    const dest = path.join(root, manifest.id)

    const replaced = fs.existsSync(dest)
    if (replaced && !rmrf(dest)) {
      return { ok: false, error: `could not replace the existing "${manifest.id}" - is the game holding a file open?` }
    }

    fs.renameSync(staging, dest)
    staging = null
    logger.info(`installed ${manifest.id}@${manifest.version} (${manifest.flavour}) into ${dest}`)
    return { ok: true, id: manifest.id, flavour: manifest.flavour, version: manifest.version, dir: dest, replaced }
  } catch (e) {
    const err = toSmlnError(e, 'install')
    logger.error(String(err))
    return { ok: false, error: err.message }
  } finally {
    if (staging) rmrf(staging)
  }
}

/**
 * Remove an installed mod.
 *
 * `roots` is the whitelist: a directory outside all of them is never touched,
 * however the request was phrased.
 *
 * @param {string} dir
 * @param {{roots:string[], logger:any}} ctx
 */
function remove(dir, ctx) {
  const { logger } = ctx
  try {
    if (!dir) return { ok: false, error: 'no directory given' }
    const target = path.resolve(dir)

    const inside = ctx.roots.some((root) => {
      const r = path.resolve(root)
      return target !== r && target.startsWith(r + path.sep)
    })
    if (!inside) {
      logger.error(`refused to delete ${target}: outside every known mods folder`)
      return { ok: false, error: 'that folder is not inside a mods directory - refused' }
    }
    if (!readManifest(target)) {
      logger.error(`refused to delete ${target}: no mod manifest`)
      return { ok: false, error: 'that folder does not contain a mod manifest - refused' }
    }
    if (!rmrf(target)) return { ok: false, error: 'could not remove the folder - a file may be in use' }

    logger.info(`removed mod at ${target}`)
    return { ok: true, dir: target }
  } catch (e) {
    const err = toSmlnError(e, 'remove')
    logger.error(String(err))
    return { ok: false, error: err.message }
  }
}

module.exports = { installFromZip, remove, readManifest, SMLN_MANIFEST, FLUX_MANIFEST }
