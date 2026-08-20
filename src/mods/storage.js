'use strict'
/**
 * Per-mod private storage, running in the main process.
 *
 * Every mod gets a directory of its own under `<userData>/smln/mod-data/<mod-id>/`
 * and this module is the only sanctioned way into it. That directory is
 * available to *every* mod, sandboxed or native, with no permission required -
 * it is the safe alternative to `require('fs')` for ordinary persistence
 * (settings, save slots, caches), which is exactly why the "filesystem"
 * permission exists at all: it is reserved for a *wider* root than a mod's
 * own folder (see `scoped()` / `extraRoots` below), not for talking to disk
 * in the first place.
 *
 * The security core is `resolveIn`: every relative path a mod hands us is
 * rejected unless its canonical, symlink-resolved location is provably inside
 * the root it was asked to stay in. Nothing here is cached across calls -
 * every read, write, stat and list re-runs the full check, because a mod can
 * plant a symlink between one call and the next.
 *
 * What this module is *not*: a security boundary against a mod that already
 * has real Node. A "native" tier mod (an SMLN `main` entrypoint or a
 * Fluxloader `electronEntrypoint`) runs with genuine `require`/`fs`/`child_process`
 * in the main process - see RESEARCH.md section 1. Calling through this API
 * instead of raw `fs` is good citizenship for such a mod and we still apply
 * every check to calls that arrive here, but describing it as a sandbox for
 * that tier would be dishonest: it can always reach around us. The real
 * enforcement point is upstream, in whatever decides a mod gets the native
 * tier at all.
 *
 * A mod cannot reach another mod's directory through this API: `rootFor`
 * gives each mod id its own root below the shared base, and every operation
 * is contained to the root the `Storage` instance was built for. There is no
 * "list other mods" or ".." out of it.
 */

const fs = require('fs')
const path = require('path')

const { SmlnError, toSmlnError } = require('../core/errors')

/**
 * The capability object produced by `src/mods/permissions.js` (`classify`).
 * Taken as a plain input here - this module never requires permissions.js,
 * so it keeps working even while that module is still being built.
 *
 * @typedef {Object} ModCapability
 * @property {'sandboxed'|'native'|string} tier - execution tier for the mod.
 *   'native' means it already runs with real Node in the main process, so any
 *   restriction this module applies to it is advisory, not a boundary.
 * @property {string[]} [permissions] - manifest-declared permission names,
 *   verbatim (e.g. `['network']`).
 * @property {{node:boolean, filesystem:boolean, network:boolean}} granted -
 *   resolved booleans after tier and manifest permissions are combined.
 *   `granted.filesystem` is what gates `scoped()` and `extraRoots` here;
 *   `granted.node` / `granted.network` are not consulted by this module.
 * @property {boolean} [enforceable] - true when `granted` is backed by a real
 *   boundary (sandboxed tier); informational only here.
 */

/**
 * @typedef {Object} Storage
 * @property {string} root
 * @property {(rel:string, encoding?:string) => Promise<{ok:true,value:string}|{ok:false,error:SmlnError}>} readText
 * @property {(rel:string, contents:string|Buffer) => Promise<{ok:true}|{ok:false,error:SmlnError}>} writeText
 * @property {(rel:string) => Promise<{ok:true,value:any}|{ok:false,error:SmlnError}>} readJson
 * @property {(rel:string, value:any) => Promise<{ok:true}|{ok:false,error:SmlnError}>} writeJson
 * @property {(rel:string) => Promise<{ok:true,value:boolean}|{ok:false,error:SmlnError}>} exists
 * @property {(rel:string) => Promise<{ok:true,size:number,mtimeMs:number,kind:'file'|'dir'}|{ok:false,error:SmlnError}>} stat
 * @property {(rel?:string) => Promise<{ok:true,entries:string[]}|{ok:false,error:SmlnError}>} list
 * @property {(rel:string) => Promise<{ok:true}|{ok:false,error:SmlnError}>} mkdir
 * @property {(rel:string, opts?:{recursive?:boolean}) => Promise<{ok:true}|{ok:false,error:SmlnError}>} remove
 * @property {() => Promise<{ok:true,bytes:number}|{ok:false,error:SmlnError}>} usage
 * @property {(rootPath:string) => {ok:true,storage:Storage}|{ok:false,error:SmlnError}} scoped
 * @property {string[]} [extraRoots]
 * @property {Storage[]} [extra]
 */

const DEFAULT_QUOTA_BYTES = 64 * 1024 * 1024

// A mod id becomes a single path segment below the shared base directory, so
// it is validated with the same shape the loader already requires of ids
// (src/mods/loader.js ID_RE) - lowercase, no separators, nothing that could
// be read as ".." no matter how it is combined with a root.
const MOD_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/

// Reserved on Windows regardless of extension: CON, NUL.txt, com1.tar.gz, ...
const RESERVED_NAME_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i

const CONTROL_CHAR_RE = /[\x00-\x1f]/

// "C:foo" (no separator after the colon) is drive-relative, not absolute -
// path.win32.isAbsolute() correctly says false for it, so it needs its own
// rejection rather than falling out of the absolute-path check.
const DRIVE_RELATIVE_RE = /^[a-zA-Z]:(?!\/)/

const NOOP_LOGGER = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
  child() { return NOOP_LOGGER },
}

function fail(code, message, detail) {
  return { ok: false, error: new SmlnError(code, message, { detail: detail || {} }) }
}

/**
 * Compute (never create) the private root for a mod id under `baseDir`.
 * Throws rather than sanitising a hostile id into something surprising -
 * callers are expected to pass an id that already went through mod
 * discovery/validation.
 *
 * @param {string} baseDir
 * @param {string} modId
 * @returns {string}
 */
function rootFor(baseDir, modId) {
  if (typeof baseDir !== 'string' || !baseDir) {
    throw new SmlnError('E_CONFIG', 'rootFor requires a baseDir', { detail: { baseDir } })
  }
  if (typeof modId !== 'string' || !MOD_ID_RE.test(modId)) {
    throw new SmlnError('E_IO', 'refusing to build a storage root for a hostile mod id', { detail: { modId } })
  }
  if (RESERVED_NAME_RE.test(modId)) {
    throw new SmlnError('E_IO', 'mod id collides with a reserved Windows device name', { detail: { modId } })
  }
  const absBase = path.resolve(baseDir)
  const root = path.resolve(absBase, modId)
  if (root !== absBase && !root.startsWith(absBase + path.sep)) {
    throw new SmlnError('E_IO', 'mod id escapes its storage base directory', { detail: { modId } })
  }
  return root
}

/** Syntactic checks that do not touch the filesystem. `forward` uses '/' only. */
function checkSyntax(forward) {
  if (/^\/\//.test(forward)) {
    return fail('E_IO', 'UNC paths are not allowed', { path: forward })
  }
  if (path.win32.isAbsolute(forward) || path.posix.isAbsolute(forward)) {
    return fail('E_IO', 'absolute paths are not allowed', { path: forward })
  }
  if (DRIVE_RELATIVE_RE.test(forward)) {
    return fail('E_IO', 'drive-relative paths are not allowed', { path: forward })
  }
  const segments = forward.split('/').filter((s) => s.length > 0)
  for (const seg of segments) {
    if (seg === '..') return fail('E_IO', 'path traversal ("..") is not allowed', { path: forward })
    if (seg === '.') continue
    if (RESERVED_NAME_RE.test(seg)) {
      return fail('E_IO', `"${seg}" is a reserved Windows device name`, { path: forward })
    }
  }
  return { ok: true }
}

/** Walk upward from `p` until something on disk actually exists. */
function deepestExistingAncestor(p) {
  let cur = p
  for (;;) {
    try {
      if (fs.existsSync(cur)) return cur
    } catch (_) { /* treat as not existing and keep walking up */ }
    const parent = path.dirname(cur)
    if (parent === cur) return cur
    cur = parent
  }
}

/**
 * Resolve any symlinks between `resolved` and the nearest existing ancestor
 * and confirm the real location is still inside the real root. When neither
 * `root` nor any part of `resolved` exists yet there is nothing that could
 * have been symlinked, so this passes - the syntactic path.resolve() check
 * the caller already did is sufficient until something is actually created,
 * and creation always goes through this module's own `fs.mkdir`/`writeFile`.
 */
function checkRealpathContainment(absRoot, resolved) {
  try {
    const ancestor = deepestExistingAncestor(resolved)
    const ancestorIsUnderRoot = ancestor === absRoot || ancestor.startsWith(absRoot + path.sep)
    if (!ancestorIsUnderRoot) return { ok: true }

    const realRoot = fs.realpathSync(absRoot)
    const realAncestor = fs.realpathSync(ancestor)
    // Boundary with a separator, not a bare startsWith: realRoot + '-evil'
    // must never be accepted as "inside" realRoot.
    const inside = realAncestor === realRoot || realAncestor.startsWith(realRoot + path.sep)
    if (!inside) {
      return fail('E_IO', 'path escapes its root through a symlink', { resolved })
    }
    return { ok: true }
  } catch (e) {
    return fail('E_IO', 'could not verify the path stays within its root: ' + e.message, { resolved })
  }
}

/**
 * Validate a mod-supplied relative path against `root`. Re-run on every call
 * - never cache the result across operations.
 *
 * @param {string} root
 * @param {string} relative
 * @returns {{ok:true,path:string}|{ok:false,error:SmlnError}}
 */
function resolveIn(root, relative) {
  if (typeof relative !== 'string') {
    return fail('E_IO', 'path must be a string', { relative })
  }
  if (CONTROL_CHAR_RE.test(relative)) {
    return fail('E_IO', 'path contains a NUL byte or control character', { relative })
  }

  const forward = relative.replace(/\\/g, '/')
  const syntax = checkSyntax(forward)
  if (!syntax.ok) return syntax

  // A percent-encoded ".." must not survive a decode either.
  if (relative.indexOf('%') !== -1) {
    let decoded = null
    try { decoded = decodeURIComponent(relative) } catch (_) { /* not percent-encoded */ }
    if (decoded != null && decoded !== relative) {
      if (CONTROL_CHAR_RE.test(decoded)) {
        return fail('E_IO', 'percent-encoded control character in path', { relative })
      }
      const decodedSyntax = checkSyntax(decoded.replace(/\\/g, '/'))
      if (!decodedSyntax.ok) return fail('E_IO', 'percent-encoded path traversal is not allowed', { relative })
    }
  }

  const absRoot = path.resolve(root)
  const resolved = path.resolve(absRoot, forward)
  if (resolved !== absRoot && !resolved.startsWith(absRoot + path.sep)) {
    return fail('E_IO', 'path escapes its root', { relative })
  }

  const real = checkRealpathContainment(absRoot, resolved)
  if (!real.ok) return real

  return { ok: true, path: resolved }
}

function isBlankFileTarget(rel) {
  return typeof rel !== 'string' || rel.trim() === '' || rel.trim() === '.'
}

/** Recursive, best-effort directory size in bytes. Missing entries count as 0. */
async function dirSize(dir) {
  let entries
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch (_) {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += await dirSize(full)
      else if (entry.isFile()) total += (await fs.promises.stat(full)).size
    } catch (_) { /* vanished mid-walk; best effort */ }
  }
  return total
}

/**
 * Build a Storage bound to one concrete root. Used both for a mod's own
 * private directory and for any `scoped()`/`extraRoots` root granted by the
 * "filesystem" permission - the containment rules are identical either way.
 */
function makeStorage(root, ctx) {
  const { modId, capability, quotaBytes } = ctx
  const log = ctx.logger || NOOP_LOGGER
  const grantedFs = !!(capability && capability.granted && capability.granted.filesystem)

  async function checkQuota(targetPath, newBytes) {
    if (newBytes > quotaBytes) {
      return fail('E_QUOTA_EXCEEDED',
        `write of ${newBytes} byte(s) exceeds the ${quotaBytes} byte quota for "${modId}"`,
        { modId, newBytes, quotaBytes })
    }
    let existingSize = 0
    try {
      const st = await fs.promises.stat(targetPath)
      if (st.isFile()) existingSize = st.size
    } catch (_) { /* nothing there yet to subtract */ }
    const currentUsage = await dirSize(root)
    const prospective = currentUsage - existingSize + newBytes
    if (prospective > quotaBytes) {
      return fail('E_QUOTA_EXCEEDED',
        `write would bring "${modId}" to ${prospective} of ${quotaBytes} byte(s) allotted - refused, nothing was written`,
        { modId, prospective, quotaBytes })
    }
    return { ok: true }
  }

  async function readText(rel, encoding) {
    if (isBlankFileTarget(rel)) return fail('E_IO', 'no file specified', { rel })
    const r = resolveIn(root, rel)
    if (!r.ok) return r
    try {
      const value = await fs.promises.readFile(r.path, encoding || 'utf8')
      return { ok: true, value }
    } catch (e) {
      return { ok: false, error: toSmlnError(e, `readText(${modId}:${rel})`) }
    }
  }

  async function writeText(rel, contents) {
    if (isBlankFileTarget(rel)) return fail('E_IO', 'no file specified', { rel })
    if (typeof contents !== 'string' && !Buffer.isBuffer(contents)) {
      return fail('E_IO', 'contents must be a string or Buffer', { rel })
    }
    const r = resolveIn(root, rel)
    if (!r.ok) return r
    const bytes = Buffer.byteLength(contents)
    const quota = await checkQuota(r.path, bytes)
    if (!quota.ok) return quota
    try {
      await fs.promises.mkdir(path.dirname(r.path), { recursive: true })
      await fs.promises.writeFile(r.path, contents)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: toSmlnError(e, `writeText(${modId}:${rel})`) }
    }
  }

  async function readJson(rel) {
    const r = await readText(rel, 'utf8')
    if (!r.ok) return r
    try {
      return { ok: true, value: JSON.parse(r.value) }
    } catch (e) {
      return { ok: false, error: new SmlnError('E_IO', `"${rel}" is not valid JSON: ${e.message}`, { detail: { modId, rel } }) }
    }
  }

  async function writeJson(rel, value) {
    let text
    try {
      text = JSON.stringify(value, null, 2)
    } catch (e) {
      return { ok: false, error: new SmlnError('E_IO', `value for "${rel}" cannot be serialised to JSON: ${e.message}`, { detail: { modId, rel } }) }
    }
    return writeText(rel, text)
  }

  async function exists(rel) {
    const r = resolveIn(root, rel)
    if (!r.ok) return r
    try {
      await fs.promises.access(r.path)
      return { ok: true, value: true }
    } catch (e) {
      if (e && e.code === 'ENOENT') return { ok: true, value: false }
      return { ok: false, error: toSmlnError(e, `exists(${modId}:${rel})`) }
    }
  }

  async function stat(rel) {
    const r = resolveIn(root, rel == null ? '.' : rel)
    if (!r.ok) return r
    try {
      const st = await fs.promises.stat(r.path)
      return { ok: true, size: st.size, mtimeMs: st.mtimeMs, kind: st.isDirectory() ? 'dir' : 'file' }
    } catch (e) {
      return { ok: false, error: toSmlnError(e, `stat(${modId}:${rel})`) }
    }
  }

  async function list(rel) {
    const target = rel == null ? '.' : rel
    const r = resolveIn(root, target)
    if (!r.ok) return r
    try {
      const entries = await fs.promises.readdir(r.path)
      return { ok: true, entries }
    } catch (e) {
      return { ok: false, error: toSmlnError(e, `list(${modId}:${target})`) }
    }
  }

  async function mkdir(rel) {
    if (typeof rel !== 'string' || rel.trim() === '') return fail('E_IO', 'no directory specified', { rel })
    const r = resolveIn(root, rel)
    if (!r.ok) return r
    try {
      await fs.promises.mkdir(r.path, { recursive: true })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: toSmlnError(e, `mkdir(${modId}:${rel})`) }
    }
  }

  async function remove(rel, opts) {
    const options = opts || {}
    if (typeof rel !== 'string' || rel.trim() === '') return fail('E_IO', 'no path specified', { rel })
    const r = resolveIn(root, rel)
    if (!r.ok) return r
    if (r.path === root) {
      return fail('E_IO', 'refusing to remove the storage root itself - remove individual entries instead', { rel })
    }
    try {
      let st = null
      try { st = await fs.promises.lstat(r.path) } catch (_) { /* st stays null */ }
      if (!st) return fail('E_IO', `"${rel}" does not exist`, { rel })
      if (st.isDirectory() && !options.recursive) {
        const inside = await fs.promises.readdir(r.path)
        if (inside.length > 0) {
          return fail('E_IO', `"${rel}" is a non-empty directory - pass {recursive:true} to remove it`, { rel })
        }
      }
      await fs.promises.rm(r.path, { recursive: !!options.recursive, force: false })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: toSmlnError(e, `remove(${modId}:${rel})`) }
    }
  }

  async function usage() {
    try {
      const bytes = await dirSize(root)
      return { ok: true, bytes }
    } catch (e) {
      return { ok: false, error: toSmlnError(e, `usage(${modId})`) }
    }
  }

  /**
   * A Storage confined to an arbitrary root, gated by the "filesystem"
   * permission. Same containment rules as the mod's own directory - the only
   * difference is which root they are enforced against.
   */
  function scoped(rootPath) {
    if (!grantedFs) {
      return fail('E_PERMISSION_DENIED',
        `mod "${modId}" has no "filesystem" permission - declare "filesystem" in its manifest to use storage outside its own data directory`,
        { modId })
    }
    if (typeof rootPath !== 'string' || !rootPath) {
      return fail('E_IO', 'scoped() requires a root path', { modId })
    }
    return { ok: true, storage: makeStorage(path.resolve(rootPath), ctx) }
  }

  return { root, readText, writeText, readJson, writeJson, exists, stat, list, mkdir, remove, usage, scoped }
}

/**
 * @param {{baseDir:string, modId:string, capability?:ModCapability, logger?:any, quotaBytes?:number, extraRoots?:string[]}} opts
 * @returns {Storage}
 */
function createStorage(opts) {
  const o = opts || {}
  const logger = o.logger || NOOP_LOGGER
  const root = rootFor(o.baseDir, o.modId) // throws on a hostile baseDir/modId

  const ctx = {
    modId: o.modId,
    capability: o.capability,
    logger,
    quotaBytes: Number.isFinite(o.quotaBytes) && o.quotaBytes > 0 ? o.quotaBytes : DEFAULT_QUOTA_BYTES,
  }

  if (o.capability && o.capability.tier === 'native') {
    logger.debug(
      `${o.modId}: storage containment is advisory here - this mod runs with real Node in the main process ` +
      'and can reach the filesystem directly regardless of what this API refuses')
  }

  const storage = makeStorage(root, ctx)

  const grantedFs = !!(o.capability && o.capability.granted && o.capability.granted.filesystem)
  if (Array.isArray(o.extraRoots) && o.extraRoots.length && !grantedFs) {
    logger.warn(`${o.modId}: extraRoots given but no "filesystem" permission - ignoring them`)
  }
  storage.extraRoots = grantedFs && Array.isArray(o.extraRoots) ? o.extraRoots.map((r) => path.resolve(r)) : []
  storage.extra = storage.extraRoots.map((r) => makeStorage(r, ctx))

  return storage
}

module.exports = { rootFor, resolveIn, createStorage }
