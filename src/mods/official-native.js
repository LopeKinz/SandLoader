'use strict'
/**
 * Bridge SandLoader-managed official Sandkit mods into Sandustry's own loader.
 *
 * The official runtime is lifecycle-sensitive: main entries must run during
 * world initialisation and worker entries need Sandustry's worker-only Sandkit
 * surface. Prepending either source to bundle.js / worker bundles cannot
 * reproduce that contract reliably.
 *
 * Instead we maintain ordinary, real directory copies under the game's native
 * local-mod folder (<userData>/mods). Sandustry discovers those copies itself,
 * compiles main.js/worker.js with its own `new Function("__sandkit", ...)`
 * wrapper and executes them at the exact native lifecycle points.
 *
 * Copies are used deliberately rather than symlinks. Sandustry realpaths a
 * manifest and checks that it remains inside candidate.folder; a symlinked mod
 * can therefore be rejected as `manifest_outside_folder`.
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const { SmlnError } = require('../core/errors')

const MANIFEST = 'modinfo.json'
const STAGE_MARKER = '.sandloader-native-stage.json'
const STAGE_PREFIX = '__sandloader__'
const WORKSHOP_META = 'workshop.json'

function resolveUserData() {
  try {
    const electron = require('electron')
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      const value = electron.app.getPath('userData')
      if (value) return path.resolve(value)
    }
  } catch (_) { /* self-test / plain Node */ }
  return null
}

function nativeRoot(userData) {
  return userData ? path.join(path.resolve(userData), 'mods') : null
}

function inside(child, parent) {
  const c = path.resolve(child)
  const p = path.resolve(parent)
  return c === p || c.startsWith(p + path.sep)
}

function stageName(id) {
  const safe = String(id).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'mod'
  const suffix = crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 8)
  return STAGE_PREFIX + safe + '-' + suffix
}

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch (_) {
    return fallback
  }
}

function loaderStates(userData) {
  if (!userData) return {}
  return readJson(path.join(userData, 'smln', 'config', 'mods.json'), {})
}

function isEnabled(mod, states) {
  if (Object.prototype.hasOwnProperty.call(states, mod.id)) return states[mod.id] !== false
  return mod.enabled !== false
}

function nativeManifestId(dir) {
  const json = readJson(path.join(dir, MANIFEST), null)
  if (!json || json.manifestVersion == null || typeof json.id !== 'string' || !json.id) return null
  return json.id
}

function ownedStage(dir) {
  const marker = readJson(path.join(dir, STAGE_MARKER), null)
  if (!marker || marker.owner !== 'SandLoader' || typeof marker.id !== 'string') return null
  return marker
}

function existingNativeIds(root) {
  const ids = new Map()
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch (_) { return ids }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const dir = path.join(root, ent.name)
    if (ownedStage(dir)) continue
    const id = nativeManifestId(dir)
    if (id && !ids.has(id)) ids.set(id, dir)
  }
  return ids
}

/**
 * Fast content fingerprint: relative path + type + size + mtime for every file.
 * It avoids hashing large PNGs on every launch while still noticing ordinary
 * Workshop/local edits, including asset-only changes.
 */
function fingerprint(dir) {
  const hash = crypto.createHash('sha256')

  function walk(abs, rel) {
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const ent of entries) {
      if (ent.name === STAGE_MARKER) continue
      const child = path.join(abs, ent.name)
      const childRel = rel ? path.join(rel, ent.name) : ent.name
      const stat = fs.lstatSync(child)
      if (stat.isSymbolicLink()) {
        // The native loader rejects realpath escapes anyway. Make the staging
        // failure explicit instead of copying a surprising target.
        throw new Error(`symbolic link is not supported in official mod staging: ${childRel}`)
      }
      hash.update(childRel.replace(/\\/g, '/') + '\0')
      if (stat.isDirectory()) {
        hash.update('d\0')
        walk(child, childRel)
      } else if (stat.isFile()) {
        hash.update(`f\0${stat.size}\0${Math.floor(stat.mtimeMs)}\0`)
      }
    }
  }

  walk(path.resolve(dir), '')
  return hash.digest('hex')
}

function copyMod(source, dest, marker) {
  const parent = path.dirname(dest)
  fs.mkdirSync(parent, { recursive: true })
  const tmp = path.join(parent, '.' + path.basename(dest) + '.tmp-' + process.pid + '-' + Date.now().toString(36))
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.cpSync(source, tmp, {
      recursive: true,
      force: true,
      filter(src) {
        const base = path.basename(src)
        // A staged Workshop item must be a plain local mod. Keeping
        // workshop.json can make the local-publisher UI mistake the copy for a
        // user-owned Workshop source tree.
        return base !== STAGE_MARKER && base !== WORKSHOP_META
      },
    })
    fs.writeFileSync(path.join(tmp, STAGE_MARKER), JSON.stringify(marker, null, 2))

    // Build the complete replacement first. If copying fails, the last known
    // good stage remains untouched.
    fs.rmSync(dest, { recursive: true, force: true })
    fs.renameSync(tmp, dest)
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true })
    throw e
  }
}

/**
 * Synchronise all discovered official mods into Sandustry's native local-mod
 * directory. Persisted SandLoader enable/disable choices are read here because
 * entry.js applies them immediately *after* official.discover() returns; the
 * native copies need to exist before the game starts, not after game:ready.
 *
 * @returns {{root:string|null,staged:string[],reused:string[],removed:string[],skipped:string[],errors:SmlnError[]}}
 */
function sync(mods, opts = {}) {
  const logger = opts.logger
  const userData = opts.userData || resolveUserData()
  const root = nativeRoot(userData)
  const result = { root, staged: [], reused: [], removed: [], skipped: [], errors: [] }
  if (!root) {
    result.errors.push(new SmlnError(
      'E_MOD_LOAD',
      'official Sandkit native bridge could not resolve Electron userData; official entries were not staged'
    ))
    return result
  }

  try { fs.mkdirSync(root, { recursive: true }) }
  catch (e) {
    result.errors.push(new SmlnError('E_IO', `could not create Sandustry native mods folder ${root}: ${e.message}`))
    return result
  }

  const states = loaderStates(userData)
  const active = (mods || []).filter((m) => m && m.id && m.dir && isEnabled(m, states))
  const desired = new Map(active.map((m) => [m.id, m]))
  const nativeIds = existingNativeIds(root)

  // Remove only directories carrying our marker. User-owned local mods are
  // never touched, even if their folder happens to share our prefix.
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch (_) { /* already reported above */ }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const dir = path.join(root, ent.name)
    const marker = ownedStage(dir)
    if (!marker) continue
    if (!desired.has(marker.id)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
        result.removed.push(marker.id)
      } catch (e) {
        result.errors.push(new SmlnError('E_IO', `could not remove stale native stage for "${marker.id}": ${e.message}`,
          { detail: { mod: marker.id } }))
      }
    }
  }

  for (const mod of active) {
    // If the source itself is already an ordinary native local mod there is
    // nothing to bridge. Also never create a second local copy over a
    // user-owned native mod with the same id.
    if (inside(mod.dir, root)) {
      result.skipped.push(mod.id)
      continue
    }
    const nativeConflict = nativeIds.get(mod.id)
    if (nativeConflict) {
      result.skipped.push(mod.id)
      logger && logger.warn(
        `official mod ${mod.id}: native local copy already exists at ${nativeConflict}; ` +
        'SandLoader will not overwrite it'
      )
      continue
    }

    const dest = path.join(root, stageName(mod.id))
    let fp
    try { fp = fingerprint(mod.dir) }
    catch (e) {
      result.errors.push(new SmlnError('E_MOD_LOAD', `official mod "${mod.id}" cannot be staged: ${e.message}`,
        { detail: { mod: mod.id } }))
      continue
    }

    const previous = ownedStage(dest)
    if (previous && previous.source === path.resolve(mod.dir) && previous.fingerprint === fp) {
      result.reused.push(mod.id)
      continue
    }

    try {
      copyMod(mod.dir, dest, {
        owner: 'SandLoader',
        id: mod.id,
        version: String(mod.version || '0.0.0'),
        source: path.resolve(mod.dir),
        fingerprint: fp,
      })
      result.staged.push(mod.id)
      logger && logger.info(`official mod ${mod.id}: staged for Sandustry's native Sandkit loader`)
    } catch (e) {
      result.errors.push(new SmlnError('E_MOD_LOAD', `official mod "${mod.id}" native staging failed: ${e.message}`,
        { detail: { mod: mod.id } }))
    }
  }

  if (logger && (result.staged.length || result.reused.length || result.removed.length)) {
    logger.info(
      `native Sandkit bridge: ${result.staged.length} staged, ${result.reused.length} unchanged, ` +
      `${result.removed.length} stale removed`
    )
  }
  return result
}

module.exports = {
  sync,
  resolveUserData,
  nativeRoot,
  stageName,
  fingerprint,
  existingNativeIds,
  STAGE_MARKER,
  STAGE_PREFIX,
}
