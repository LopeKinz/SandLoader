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
const { SmlnError, toSmlnError } = require('../core/errors')

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
 * The same ceilings zip.js enforces on an archive, applied to a directory tree.
 * A folder from the Workshop is untrusted input in exactly the way an archive
 * is, so it gets the same limits rather than a more trusting second path.
 */
const MAX_ENTRIES = 5000
const MAX_TOTAL_BYTES = 512 * 1024 * 1024

/**
 * Copy a mod directory into staging, safely.
 *
 * Symlinks are skipped rather than followed or recreated: a link inside a
 * downloaded mod is either useless (it points at the downloader's machine) or
 * an attempt to reach outside the mod folder, and neither is worth supporting.
 * Anything that is not a regular file or directory is skipped for the same
 * reason.
 *
 * @param {string} srcDir @param {string} destDir
 * @returns {{files:number, bytes:number, skipped:string[]}}
 */
function copyTree(srcDir, destDir) {
  const stats = { files: 0, bytes: 0, skipped: [] }

  function walk(from, to, relative) {
    // `withFileTypes` reports links as links, so a symlink is never stat'd
    // through and never followed.
    const entries = fs.readdirSync(from, { withFileTypes: true })
    fs.mkdirSync(to, { recursive: true })

    for (const entry of entries) {
      const rel = relative ? relative + '/' + entry.name : entry.name
      const src = path.join(from, entry.name)
      const dest = path.join(to, entry.name)

      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
        stats.skipped.push(rel)
        continue
      }
      // A name that would climb out of the destination is refused outright.
      if (entry.name === '.' || entry.name === '..' || entry.name.includes('\0')) {
        stats.skipped.push(rel)
        continue
      }

      if (entry.isDirectory()) {
        walk(src, dest, rel)
        continue
      }

      if (stats.files >= MAX_ENTRIES) {
        throw new SmlnError('E_IO', `the mod has more than ${MAX_ENTRIES} files, refusing`)
      }
      const size = fs.statSync(src).size
      if (stats.bytes + size > MAX_TOTAL_BYTES) {
        throw new SmlnError('E_IO',
          `the mod expands past ${Math.round(MAX_TOTAL_BYTES / 1048576)} MiB, refusing`)
      }
      fs.copyFileSync(src, dest)
      stats.files++
      stats.bytes += size
    }
  }

  walk(srcDir, destDir, '')
  return stats
}

/**
 * If a directory holds no manifest but wraps exactly one folder that does,
 * treat that folder as the mod.
 *
 * Mirrors the single-top-level-directory strip zip.js already does, because
 * Workshop items are packaged with the same inconsistency archives are.
 */
function descendToManifest(dir) {
  if (readManifest(dir)) return dir
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return dir }
  const dirs = entries.filter((e) => e.isDirectory())
  if (dirs.length !== 1) return dir
  const inner = path.join(dir, dirs[0].name)
  return readManifest(inner) ? inner : dir
}

/**
 * The half of installation that is the same however the mod arrived: validate
 * the manifest, pick the root, replace atomically.
 *
 * `staging` must be a directory this function owns - it is moved, not copied,
 * and is gone afterwards on success.
 *
 * @param {string} staging
 * @param {{smlnRoot:string, fluxRoot:string, logger:any}} ctx
 */
function installStaged(staging, ctx) {
  const { logger } = ctx

  const manifest = readManifest(staging)
  if (!manifest) {
    return {
      ok: false,
      code: 'E_MANIFEST_INVALID',
      error: `no valid ${SMLN_MANIFEST} or ${FLUX_MANIFEST} found`,
    }
  }

  const root = manifest.flavour === 'fluxloader' ? ctx.fluxRoot : ctx.smlnRoot
  fs.mkdirSync(root, { recursive: true })
  const dest = path.join(root, manifest.id)

  const replaced = fs.existsSync(dest)
  if (replaced && !rmrf(dest)) {
    return { ok: false, error: `could not replace the existing "${manifest.id}" - is the game holding a file open?` }
  }

  try {
    fs.renameSync(staging, dest)
  } catch (e) {
    // Staging lives in the OS temp dir, which is often a different volume from
    // userData; rename cannot cross one, so fall back to a copy.
    if (e.code !== 'EXDEV') throw e
    copyTree(staging, dest)
    rmrf(staging)
  }

  logger.info(`installed ${manifest.id}@${manifest.version} (${manifest.flavour}) into ${dest}`)
  return { ok: true, id: manifest.id, flavour: manifest.flavour, version: manifest.version, dir: dest, replaced }
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

    if (!readManifest(staging)) {
      return {
        ok: false,
        error: `no valid ${SMLN_MANIFEST} or ${FLUX_MANIFEST} found in the archive`,
      }
    }

    const installed = installStaged(staging, ctx)
    if (installed.ok) staging = null
    return installed
  } catch (e) {
    const err = toSmlnError(e, 'install')
    logger.error(String(err))
    return { ok: false, error: err.message }
  } finally {
    if (staging) rmrf(staging)
  }
}

/**
 * Install a mod from a directory - the shape a Workshop download arrives in.
 *
 * The source is copied, never moved, and never installed in place. That matters
 * most for SteamCMD: its download folder belongs to SteamCMD, which will happily
 * overwrite or re-sync it, so a mod left sitting there would silently change
 * under the player. Copying it out makes the installed mod an ordinary local
 * mod - SandLoader's own file, fully removable, with no Steam involvement after
 * this point.
 *
 * Staging still applies for the same reason it does for archives: the manifest
 * is validated on the copy before anything lands in the mods folder, so a mod
 * that fails validation leaves nothing behind.
 *
 * @param {string} srcDir
 * @param {{smlnRoot:string, fluxRoot:string, logger:any,
 *          origin?:{publishedFileId:string, title?:string}}} ctx
 * @returns {{ok:true, id:string, flavour:string, dir:string, replaced:boolean}|{ok:false, error:string}}
 */
function installFromDir(srcDir, ctx) {
  const { logger } = ctx
  let staging = null
  try {
    if (!fs.existsSync(srcDir)) return { ok: false, error: 'folder not found: ' + srcDir }
    if (!fs.statSync(srcDir).isDirectory()) return { ok: false, error: 'not a folder: ' + srcDir }

    // Validate before copying: a folder with no manifest is not a mod, and
    // there is no reason to copy a few hundred files to find that out.
    const source = descendToManifest(path.resolve(srcDir))
    if (!readManifest(source)) {
      return {
        ok: false,
        code: 'E_MANIFEST_INVALID',
        error: `that Workshop item has no ${SMLN_MANIFEST} or ${FLUX_MANIFEST}, so it is not a mod ` +
          'SandLoader can load. It may be a mod for a different loader, or content of another kind.',
      }
    }

    staging = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-import-'))
    const copied = copyTree(source, staging)
    logger.info(`copied ${copied.files} file(s) from ${source}`)
    if (copied.skipped.length) {
      logger.warn(`skipped ${copied.skipped.length} non-regular entr(ies): ${copied.skipped.slice(0, 5).join(', ')}`)
    }

    if (ctx.origin) workshop.writeOrigin(staging, ctx.origin)

    const installed = installStaged(staging, ctx)
    if (installed.ok) staging = null
    return installed
  } catch (e) {
    const err = toSmlnError(e, 'import')
    logger.error(String(err))
    return { ok: false, code: err.code, error: err.message }
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

module.exports = {
  installFromZip, installFromDir, remove, readManifest,
  copyTree, descendToManifest,
  SMLN_MANIFEST, FLUX_MANIFEST,
}
