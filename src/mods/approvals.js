'use strict'
/**
 * Permission approvals: what the user agreed to, and when to ask again.
 *
 * An approval is bound to three things together - mod id, version, and the
 * exact permission set. Any one of them changing invalidates it, which is the
 * whole point: agreeing that version 1.0.0 of a mod may use the network is not
 * agreeing that version 1.1.0 may also read your disk.
 *
 * Two rules keep it from becoming a nag box:
 *
 *   - An unchanged id/version/permission-set combination is never asked about
 *     again. A prompt the user cannot avoid is a prompt they stop reading.
 *   - Dropping a permission reuses the existing approval. Someone who agreed
 *     to network+filesystem has already agreed to network alone; asking again
 *     for strictly less access teaches people to click through.
 *
 * Review happens before extraction lands anywhere, and before a single line of
 * mod code is required, evaluated or executed - `inspectArchive` reads the
 * manifest straight out of the ZIP's central directory and parses it as JSON.
 * That ordering is the security property; the dialog is only how it is shown.
 *
 * Finally, honestly: an approval records a decision. It does not make a native
 * mod safe. A mod granted `node` runs with this process's full privileges no
 * matter what this file says, and the warning text says so.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const zip = require('./zip')
const permissions = require('./permissions')
const { SmlnError, toSmlnError } = require('../core/errors')

const FILE = 'approvals.json'
const FORMAT_VERSION = 1

const SMLN_MANIFEST = 'smln.mod.json'
const FLUX_MANIFEST = 'modinfo.json'

/**
 * @typedef {Object} ApprovalRecord
 * @property {string} id
 * @property {string} version
 * @property {string[]} permissions
 * @property {string} key
 * @property {string} tier
 * @property {string} approvedAt
 * @property {boolean} [acknowledgedLegacyNative]
 */

// --------------------------------------------------------------- the store

/**
 * @param {{dir:string, logger:any}} opts
 */
function createStore(opts) {
  const dir = opts.dir
  const logger = opts.logger || { info() {}, warn() {}, error() {}, debug() {} }
  const file = path.join(dir, FILE)
  /** @type {Record<string, ApprovalRecord>|null} */
  let cache = null

  function load() {
    if (cache) return cache
    cache = Object.create(null)
    try {
      if (!fs.existsSync(file)) return cache
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const table = parsed && typeof parsed === 'object' ? parsed.approvals : null
      if (table && typeof table === 'object') {
        for (const [id, rec] of Object.entries(table)) {
          if (rec && typeof rec === 'object' && typeof rec.version === 'string') {
            cache[id] = {
              id,
              version: rec.version,
              permissions: Array.isArray(rec.permissions) ? rec.permissions.slice() : [],
              key: typeof rec.key === 'string' ? rec.key : '',
              tier: typeof rec.tier === 'string' ? rec.tier : 'sandboxed',
              approvedAt: typeof rec.approvedAt === 'string' ? rec.approvedAt : '',
              acknowledgedLegacyNative: rec.acknowledgedLegacyNative === true,
            }
          }
        }
      }
    } catch (e) {
      // Falling back to "nothing approved" is the safe direction: the user is
      // asked again rather than a mod running on an approval we cannot read.
      // The file is left alone - it may be recoverable, and it is theirs.
      logger.warn(`${FILE} is unreadable, treating every mod as unapproved: ${e.message}`)
    }
    return cache
  }

  function save() {
    const data = { version: FORMAT_VERSION, approvals: {} }
    for (const [id, rec] of Object.entries(load())) data.approvals[id] = rec
    const tmp = file + '.tmp'
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
      // Rename rather than write-in-place: a crash mid-write must not leave a
      // truncated approvals file, which would silently revoke everything.
      fs.renameSync(tmp, file)
      return true
    } catch (e) {
      try { fs.unlinkSync(tmp) } catch (_) { /* best effort */ }
      logger.error(`could not save ${FILE}: ${e.message}`)
      return false
    }
  }

  function approvalFor(modId) {
    return load()[modId] || null
  }

  function isApproved(modOrId, version, perms) {
    const mod = typeof modOrId === 'string' ? null : modOrId
    const id = mod ? mod.id : modOrId
    const v = mod ? mod.version : version
    const p = mod
      ? (mod.capability ? mod.capability.permissions : mod.permissions) || []
      : perms || []

    const record = approvalFor(id)
    if (!record) return false
    if (record.version !== v) return false

    // Exact match, or strictly fewer permissions than were approved.
    const delta = permissions.diff(record.permissions, p)
    return !delta.escalation
  }

  function approve(mod, capability) {
    try {
      const cap = capability || mod.capability ||
        permissions.classify({ id: mod.id, version: mod.version, permissions: mod.permissions || [] })
      const perms = cap.permissions || []
      const record = {
        id: mod.id,
        version: String(mod.version),
        permissions: perms.slice(),
        key: permissions.approvalKey(mod.id, mod.version, perms),
        tier: cap.tier,
        approvedAt: new Date().toISOString(),
      }
      if (cap.legacyNative) record.acknowledgedLegacyNative = true
      load()[mod.id] = record
      if (!save()) {
        return { ok: false, error: new SmlnError('E_IO', `could not persist the approval for "${mod.id}"`) }
      }
      logger.info(`approved ${mod.id}@${mod.version} (${cap.tier}: ${perms.join(', ') || 'no permissions'})`)
      return { ok: true, record }
    } catch (e) {
      return { ok: false, error: toSmlnError(e, 'approve') }
    }
  }

  function revoke(modId) {
    const table = load()
    if (!table[modId]) return false
    delete table[modId]
    save()
    logger.info(`revoked the approval for "${modId}"`)
    return true
  }

  return {
    file,
    isApproved,
    approvalFor,
    approve,
    revoke,
    all() { return Object.values(load()) },
    pending(mods) {
      const out = []
      for (const mod of mods || []) {
        const review = reviewFor(modInfoOf(mod), approvalFor(mod.id))
        if (review.required) out.push({ mod, review })
      }
      return out
    },
    reload() { cache = null; return load() },
  }
}

/** Normalise a discovered mod (SMLN or Fluxloader) into reviewFor's input. */
function modInfoOf(mod) {
  const ep = mod.entrypoints || {}
  return {
    id: mod.id,
    name: mod.name || mod.id,
    version: mod.version,
    flavour: mod.flavour || 'smln',
    permissions: mod.permissions || [],
    entrypoints: {
      native: !!(ep.native || ep.electron || mod.main),
      game: !!(ep.game || mod.renderer),
      worker: !!(ep.worker || mod.worker),
    },
  }
}

// --------------------------------------------------------------- the review

/**
 * Build the object the install / update dialog renders.
 *
 * All user-facing text is an i18n key, never an English sentence: this runs in
 * the main process and the string is rendered in whatever language the player
 * chose. See src/renderer/locales.js for the catalogue.
 *
 * @param {{id:string,name?:string,version:string,flavour?:string,permissions?:string[],entrypoints?:any}} info
 * @param {ApprovalRecord|null} previous
 */
function reviewFor(info, previous) {
  const capability = permissions.classify({
    id: info.id,
    version: info.version,
    flavour: info.flavour || 'smln',
    permissions: info.permissions || [],
    entrypoints: info.entrypoints || {},
  })

  const requested = capability.permissions
  const delta = previous ? permissions.diff(previous.permissions, requested) : null

  let kind
  if (!previous) kind = 'install'
  else if (previous.version !== info.version) kind = 'update'
  else if (delta && delta.escalation) kind = 'update'
  else kind = 'unchanged'

  const entries = []
  const pseudo = [
    { id: 'game', on: !!(info.entrypoints && info.entrypoints.game) },
    { id: 'worker', on: !!(info.entrypoints && info.entrypoints.worker) },
  ]
  for (const p of pseudo) {
    const d = permissions.describe(p.id)
    entries.push({
      id: p.id,
      title: d ? d.title : p.id,
      titleKey: d ? d.titleKey : `perm.${p.id}.title`,
      description: d ? d.description : '',
      descriptionKey: d ? d.descriptionKey : `perm.${p.id}.desc`,
      risk: 'info',
      state: p.on ? 'granted' : 'not-requested',
      isNew: false,
    })
  }
  for (const name of ['filesystem', 'network', 'node']) {
    const d = permissions.describe(name)
    const asked = requested.includes(name)
    entries.push({
      id: name,
      title: d ? d.title : name,
      titleKey: d ? d.titleKey : `perm.${name}.title`,
      description: d ? d.description : '',
      descriptionKey: d ? d.descriptionKey : `perm.${name}.desc`,
      risk: d ? d.risk : 'warn',
      state: asked ? 'requested' : 'not-requested',
      isNew: !!(delta && delta.added.includes(name)),
    })
  }

  const warnings = []
  if (capability.tier === permissions.TIERS.NATIVE) warnings.push('perm.nativeWarning')
  if (capability.legacyNative) warnings.push('perm.legacyNative')
  if (!capability.enforceable) warnings.push('perm.notEnforceable')

  // Anything native always needs a human, every time it changes. Otherwise a
  // decision is only needed when the mod is asking for more than last time.
  let required
  if (capability.tier === permissions.TIERS.NATIVE) {
    required = !previous || previous.version !== info.version ||
      (delta ? delta.escalation : true)
  } else if (!previous) {
    required = requested.length > 0
  } else {
    required = !!(delta && delta.escalation)
  }

  return {
    mod: { id: info.id, name: info.name || info.id, version: info.version, flavour: info.flavour || 'smln' },
    capability,
    kind,
    required,
    diff: delta,
    entries,
    warnings,
    legacyNative: capability.legacyNative,
    headlineKey: kind === 'update' && delta && delta.escalation ? 'perm.change' : 'perm.installTitle',
  }
}

// ------------------------------------------------------------- the archive

/**
 * Which format a `modinfo.json` is.
 *
 * The filename is shared by two unrelated formats: official Sandkit declares
 * `manifestVersion` and identifies mods by `id`, Fluxloader has no
 * `manifestVersion` and uses `modID`. Assuming Fluxloader made every official
 * mod fail to install with `the manifest has no "modID"` - a real manifest,
 * read by the wrong reader.
 *
 * src/mods/manage.js discriminates on exactly this field, and so does
 * src/mods/official.js `isOfficial`. This is the same test, kept in one place
 * here so the ZIP and directory paths cannot drift apart.
 */
function flavourOfModinfo(json) {
  return json && json.manifestVersion != null ? 'official' : 'fluxloader'
}

/** Pull one manifest out of a ZIP without unpacking or running anything. */
function manifestFromZip(zipPath) {
  for (const name of [SMLN_MANIFEST, FLUX_MANIFEST]) {
    let buf
    try { buf = zip.readFile(zipPath, name) } catch (e) { return { error: toSmlnError(e, 'read archive') } }
    if (!buf) continue
    try {
      // JSON.parse only. Nothing in the archive is required, evaluated or run.
      const json = JSON.parse(buf.toString('utf8'))
      return { flavour: name === SMLN_MANIFEST ? 'smln' : flavourOfModinfo(json), json }
    } catch (e) {
      return { error: new SmlnError('E_MANIFEST_INVALID', `${name} in the archive is not valid JSON: ${e.message}`) }
    }
  }
  return { error: new SmlnError('E_MANIFEST_INVALID', `no ${SMLN_MANIFEST} or ${FLUX_MANIFEST} in the archive`) }
}

/** Read a manifest from an unpacked directory; same rules, no execution. */
function manifestFromDir(dir) {
  for (const name of [SMLN_MANIFEST, FLUX_MANIFEST]) {
    const p = path.join(dir, name)
    if (!fs.existsSync(p)) continue
    try {
      const json = JSON.parse(fs.readFileSync(p, 'utf8'))
      return { flavour: name === SMLN_MANIFEST ? 'smln' : flavourOfModinfo(json), json }
    } catch (e) {
      return { error: new SmlnError('E_MANIFEST_INVALID', `${name} is not valid JSON: ${e.message}`) }
    }
  }
  return { error: new SmlnError('E_MANIFEST_INVALID', `no ${SMLN_MANIFEST} or ${FLUX_MANIFEST} found`) }
}

/** Turn a raw manifest into reviewFor's input, for any of the three flavours. */
function infoFromManifest(json, flavour) {
  if (flavour === 'official') {
    // Official mods run inside the renderer and the workers, through
    // SMLN.official.execute - see src/mods/official.js. They are handed no
    // `require`, so `native` is false and the review must not imply otherwise.
    // `entry` is the game-context entrypoint; `workerEntry` the worker one.
    return {
      id: json.id,
      name: json.name || json.id,
      version: String(json.version || '0.0.0'),
      flavour: 'official',
      rawPermissions: json.permissions,
      entrypoints: {
        native: false,
        game: !!json.entry,
        worker: !!json.workerEntry,
      },
    }
  }
  if (flavour === 'fluxloader') {
    return {
      id: json.modID,
      name: json.name || json.modID,
      version: String(json.version || '0.0.0'),
      flavour: 'fluxloader',
      rawPermissions: json.permissions,
      entrypoints: {
        native: !!json.electronEntrypoint,
        game: !!json.gameEntrypoint,
        worker: !!json.workerEntrypoint,
      },
    }
  }
  const ep = json.entrypoints || {}
  return {
    id: json.id,
    name: json.name || json.id,
    version: String(json.version || '0.0.0'),
    flavour: 'smln',
    rawPermissions: json.permissions,
    entrypoints: {
      native: !!(ep.native || json.main),
      game: !!(ep.game || json.renderer),
      worker: !!ep.worker,
    },
  }
}

/**
 * Review a mod archive (or an unpacked directory) before installing it.
 *
 * Returns `{ok:true, review, source}`. Nothing is written and nothing is
 * extracted: the manifest is read from the archive's central directory, so
 * there is no staging directory to clean up and no window in which unpacked
 * mod code exists on disk unapproved. `cleanup()` is present and is a no-op,
 * so a caller written against a staging-based version still works.
 *
 * @param {string} target        a .zip path, or a directory when opts.directory
 * @param {{directory?:boolean, previous?:ApprovalRecord|null}} [opts]
 */
function inspectArchive(target, opts = {}) {
  try {
    if (!fs.existsSync(target)) {
      return { ok: false, error: new SmlnError('E_IO', `not found: ${target}`) }
    }
    const isDir = opts.directory || fs.statSync(target).isDirectory()
    const found = isDir ? manifestFromDir(target) : manifestFromZip(target)
    if (found.error) return { ok: false, error: found.error }

    const info = infoFromManifest(found.json, found.flavour)
    if (typeof info.id !== 'string' || !info.id) {
      return {
        ok: false,
        error: new SmlnError('E_MANIFEST_INVALID',
          found.flavour === 'fluxloader' ? 'the manifest has no "modID"' : 'the manifest has no "id"'),
      }
    }

    // Permissions are validated here, before anything is written anywhere. A
    // manifest declaring `"permissions": "network"` or an unknown capability
    // never reaches the mods folder at all.
    const checked = permissions.validate(info.rawPermissions, { modId: info.id, source: target })
    if (!checked.ok) return { ok: false, error: checked.error }
    info.permissions = checked.permissions

    return {
      ok: true,
      review: reviewFor(info, opts.previous || null),
      source: target,
      flavour: found.flavour,
      manifest: found.json,
      cleanup() { /* nothing was extracted; kept so callers can always call it */ },
    }
  } catch (e) {
    return { ok: false, error: toSmlnError(e, 'inspect') }
  }
}

module.exports = {
  createStore,
  inspectArchive,
  reviewFor,
  modInfoOf,
  infoFromManifest,
  FILE,
  FORMAT_VERSION,
}
