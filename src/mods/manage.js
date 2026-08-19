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
const workshop = require('./workshop')
const { toSmlnError } = require('../core/errors')

const SMLN_MANIFEST = 'smln.mod.json'
const FLUX_MANIFEST = 'modinfo.json'

/** Read whichever manifest an unpacked directory carries. */
function readManifest(dir) {
  const smlnPath = path.join(dir, SMLN_MANIFEST)
  if (fs.existsSync(smlnPath)) {
    try {
      const json = JSON.parse(fs.readFileSync(smlnPath, 'utf8'))
      if (typeof json.id === 'string' && json.id) {
        return {
          id: json.id,
          flavour: 'smln',
          version: String(json.version || '0.0.0'),
          name: json.name || json.id,
          json,
        }
      }
      return null
    } catch (_) {
      return null
    }
  }

  const modinfoPath = path.join(dir, FLUX_MANIFEST)
  if (!fs.existsSync(modinfoPath)) return null
  try {
    const json = JSON.parse(fs.readFileSync(modinfoPath, 'utf8'))

    // `modinfo.json` is shared by two unrelated formats. Official Sandkit uses
    // manifestVersion + id; Fluxloader uses modID. Test the discriminator
    // before choosing the id field so a valid official ZIP is not rejected as
    // "missing modID".
    if (json && json.manifestVersion != null) {
      if (typeof json.id !== 'string' || !json.id) return null
      return {
        id: json.id,
        flavour: 'official',
        version: String(json.version || '0.0.0'),
        name: json.name || json.id,
        json,
      }
    }

    if (typeof json.modID === 'string' && json.modID) {
      return {
        id: json.modID,
        flavour: 'fluxloader',
        version: String(json.version || '0.0.0'),
        name: json.name || json.modID,
        json,
      }
    }
    return null
  } catch (_) {
    return null
  }
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); return true } catch (_) { return false }
}

/**
 * Install a mod from a .zip.
 *
 * Official Sandkit mods intentionally live in SandLoader's normal local root,
 * not directly in <userData>/mods. src/mods/official-native.js mirrors only
 * enabled official mods into the native folder at boot, which keeps
 * SandLoader's enable/disable switch authoritative and makes removal safe.
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

    // Steam owns Workshop folders. Deleting one does not unsubscribe you: Steam
    // re-downloads the item on its next sync, so the mod reappears and nobody
    // can explain why. Checked here rather than only in the UI, so the RPC
    // cannot be talked into it either.
    if (workshop.isWorkshopPath(target)) {
      logger.warn(`refused to delete ${target}: Steam Workshop content is managed by Steam`)
      return {
        ok: false,
        code: 'E_WORKSHOP_MANAGED',
        error: 'that mod comes from the Steam Workshop - deleting the folder would only make Steam ' +
          're-download it. Disable it here, or unsubscribe in Steam.',
      }
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
