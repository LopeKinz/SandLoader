'use strict'
/**
 * Steam Workshop items, as a distinct kind of installed mod.
 *
 * Workshop content is already discovered - `entry.js` puts the Workshop
 * directory in the scan roots, so a subscribed item with a `modinfo.json` is
 * loaded like any other mod. What was missing is that nothing *knew* it came
 * from the Workshop, and that difference matters for one reason above all:
 *
 *   **A Workshop item must never be deleted from disk.** Steam owns that
 *   folder. Removing it does not unsubscribe you - Steam simply re-downloads
 *   the item on its next sync, so the "delete" appears to work, the mod comes
 *   back, and the player has no idea why. Worse, deleting mid-sync can leave
 *   Steam's manifest disagreeing with the disk.
 *
 * So Workshop items get their own affordances: disable them (SandLoader's own
 * state, which Steam cannot undo) or open the item's page to unsubscribe. The
 * delete button is not offered, and `manage.remove()` refuses the path even if
 * something asks for it anyway.
 *
 * Layout, per the official mod format: each subscribed item lives in
 * `steamapps/workshop/content/<appid>/<publishedFileId>/`, where the folder
 * name is the numeric id Steam assigned at publish time.
 */

const fs = require('fs')
const path = require('path')

const locate = require('../asar/locate')
const { SmlnError } = require('../core/errors')

/** Optional metadata the official mod format ships alongside modinfo.json. */
const WORKSHOP_MANIFEST = 'workshop.json'
const PREVIEW_NAMES = ['preview.png', 'preview.jpg', 'preview.jpeg']

/** A Workshop folder is named after the published file id: digits only. */
const PUBLISHED_ID_RE = /^\d+$/

/**
 * Every Workshop content root on this machine. Normally one, but a player with
 * several Steam libraries can have the app installed in one and the Workshop
 * content in another.
 * @returns {string[]}
 */
function roots() {
  const out = []
  const primary = locate.workshopDir()
  if (primary) out.push(path.resolve(primary))
  for (const lib of locate.steamLibraries()) {
    const dir = path.join(lib, 'workshop', 'content', String(locate.APP_ID))
    const resolved = path.resolve(dir)
    if (!out.includes(resolved)) out.push(resolved)
  }
  return out
}

/**
 * Is this directory a Steam Workshop item, and which one?
 *
 * Deliberately structural rather than name-based: the answer is "its path sits
 * directly under a Workshop content root", which is the thing that actually
 * makes Steam the owner.
 *
 * @param {string} dir
 * @param {string[]} [workshopRoots] pass the cached roots to avoid re-scanning
 * @returns {{isWorkshop:boolean, publishedFileId:string|null, root:string|null}}
 */
function identify(dir, workshopRoots) {
  const miss = { isWorkshop: false, publishedFileId: null, root: null }
  if (!dir) return miss
  const target = path.resolve(dir)
  const list = workshopRoots || roots()

  for (const root of list) {
    if (target === root) continue
    if (!target.startsWith(root + path.sep)) continue
    // Only the immediate child is the item; a nested folder inside one is part
    // of that item, not a separate mod.
    const rest = target.slice(root.length + 1).split(path.sep)
    const first = rest[0]
    return {
      isWorkshop: true,
      publishedFileId: PUBLISHED_ID_RE.test(first) ? first : null,
      root,
    }
  }
  return miss
}

/**
 * Read the optional `workshop.json` an author ships with an item.
 *
 * Everything in it is untrusted display text, so only known fields are lifted
 * out and each is type-checked. A malformed file yields nothing rather than
 * failing the mod - the mod itself is described by its own manifest.
 *
 * @param {string} dir
 * @returns {{title?:string, description?:string, tags?:string[], visibility?:string}|null}
 */
function readMeta(dir) {
  const file = path.join(dir, WORKSHOP_MANIFEST)
  try {
    if (!fs.existsSync(file)) return null
    const json = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!json || typeof json !== 'object') return null
    const out = {}
    if (typeof json.title === 'string') out.title = json.title
    if (typeof json.description === 'string') out.description = json.description
    if (typeof json.visibility === 'string') out.visibility = json.visibility
    if (Array.isArray(json.tags)) out.tags = json.tags.filter((t) => typeof t === 'string')
    return Object.keys(out).length ? out : null
  } catch (_) {
    return null
  }
}

/** The item's preview image, if it ships one. */
function previewOf(dir) {
  for (const name of PREVIEW_NAMES) {
    const p = path.join(dir, name)
    try { if (fs.existsSync(p)) return p } catch (_) { /* unreadable is "absent" */ }
  }
  return null
}

/**
 * When Steam last wrote to the item. Useful in the manager because a Workshop
 * mod can change under you without anything in SandLoader being touched.
 */
function updatedAt(dir) {
  try {
    return new Date(fs.statSync(dir).mtimeMs).toISOString()
  } catch (_) {
    return null
  }
}

/** `steam://` opens the Steam client directly; the https form is the fallback. */
function pageUrl(publishedFileId, opts = {}) {
  if (!publishedFileId || !PUBLISHED_ID_RE.test(String(publishedFileId))) return null
  return opts.web
    ? `https://steamcommunity.com/sharedfiles/filedetails/?id=${publishedFileId}`
    : `steam://url/CommunityFilePage/${publishedFileId}`
}

/** The app's Workshop hub, for "browse more mods". */
function hubUrl(opts = {}) {
  return opts.web
    ? `https://steamcommunity.com/app/${locate.APP_ID}/workshop/`
    : `steam://url/SteamWorkshopPage/${locate.APP_ID}`
}

/**
 * Attach Workshop provenance to a discovered mod, in place.
 *
 * Returns the same mod so it can be used in a map. Mods outside a Workshop
 * root are left completely untouched - `source` stays undefined and every
 * caller's existing behaviour is unchanged.
 *
 * @param {any} mod
 * @param {string[]} [workshopRoots]
 */
function annotate(mod, workshopRoots) {
  if (!mod || !mod.dir) return mod
  const found = identify(mod.dir, workshopRoots)
  if (!found.isWorkshop) {
    // Not Steam-managed, but it may still be a copy imported from the Workshop.
    // That provenance is worth showing, and it is all that is added: the mod
    // keeps `source` undefined and stays removable, because this copy is
    // SandLoader's own file and deleting it does exactly what it looks like.
    const origin = readOrigin(mod.dir)
    if (origin) {
      mod.importedFrom = 'workshop'
      mod.publishedFileId = origin.publishedFileId
      mod.workshopUrl = pageUrl(origin.publishedFileId)
      mod.workshopWebUrl = pageUrl(origin.publishedFileId, { web: true })
      if (origin.importedAt) mod.workshopImportedAt = origin.importedAt
    }
    return mod
  }

  mod.source = 'workshop'
  mod.publishedFileId = found.publishedFileId
  mod.workshopUrl = pageUrl(found.publishedFileId)
  mod.workshopWebUrl = pageUrl(found.publishedFileId, { web: true })
  mod.workshopUpdatedAt = updatedAt(mod.dir)
  // Steam owns the folder; deleting it is futile and confusing. The manager
  // hides its delete button on the strength of this flag, and manage.remove()
  // refuses the path independently so the RPC cannot be talked into it.
  mod.removable = false

  const meta = readMeta(mod.dir)
  if (meta) mod.workshop = meta
  const preview = previewOf(mod.dir)
  if (preview) mod.previewPath = preview

  return mod
}

/** Annotate a whole list. */
function annotateAll(mods) {
  const list = roots()
  for (const mod of mods || []) annotate(mod, list)
  return mods
}

/** Is this path inside a Workshop content root? Used by the delete guard. */
function isWorkshopPath(dir) {
  return identify(dir).isWorkshop
}

// ------------------------------------------------- installing from an id/URL

/**
 * A published file id is a 64-bit Steam id. Longer than that is not a truncated
 * id, it is something else pasted into the box.
 */
const MAX_ID_DIGITS = 20

/**
 * Turn whatever the player pasted into a published file id.
 *
 * Steam spells the same item several ways and players copy whichever one is in
 * front of them, so all of the common forms are accepted:
 *
 *   3141592653
 *   https://steamcommunity.com/sharedfiles/filedetails/?id=3141592653
 *   https://steamcommunity.com/workshop/filedetails/?id=3141592653&searchtext=x
 *   steam://url/CommunityFilePage/3141592653
 *
 * The URL is never fetched - it is only read for its id, and the id is then
 * checked to be digits before it goes anywhere near a command line. Anything
 * else is refused by name rather than silently coerced, because installing the
 * wrong mod is worse than a clear error.
 *
 * @param {string} input
 * @returns {{ok:true, id:string}|{ok:false, error:SmlnError}}
 */
function parseRef(input) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) {
    return { ok: false, error: new SmlnError('E_WORKSHOP_REF', 'enter a Workshop URL or id') }
  }

  // A bare id: the common case, and the only one needing no parsing.
  if (PUBLISHED_ID_RE.test(raw)) {
    if (raw.length > MAX_ID_DIGITS) {
      return { ok: false, error: new SmlnError('E_WORKSHOP_REF', `"${raw}" is too long to be a Workshop id`) }
    }
    // Steam never issues 0, and leading zeros are a sign of a mangled paste.
    if (/^0/.test(raw)) {
      return { ok: false, error: new SmlnError('E_WORKSHOP_REF', `"${raw}" is not a valid Workshop id`) }
    }
    return { ok: true, id: raw }
  }

  const fromQuery = raw.match(/[?&]id=(\d+)/i)
  if (fromQuery) return parseRef(fromQuery[1])

  const fromSteamProto = raw.match(/^steam:\/\/url\/CommunityFilePage\/(\d+)/i)
  if (fromSteamProto) return parseRef(fromSteamProto[1])

  // Some share links end in the id with no query string at all.
  const fromPath = raw.match(/^https?:\/\/[^\s]*\/(\d+)\/?$/i)
  if (fromPath) return parseRef(fromPath[1])

  if (/^https?:\/\//i.test(raw) || /^steam:\/\//i.test(raw)) {
    return {
      ok: false,
      error: new SmlnError('E_WORKSHOP_REF',
        'that link has no Workshop item id in it - open the mod\'s Workshop page and copy the URL from ' +
        'the address bar, or paste just the number after "?id=".'),
    }
  }

  return {
    ok: false,
    error: new SmlnError('E_WORKSHOP_REF',
      `"${raw.slice(0, 80)}" is neither a Workshop id nor a Workshop URL`),
  }
}

/**
 * Is this exactly a Workshop download folder for the given item?
 *
 * Structural, like `identify`, but stricter: the path must end in precisely
 * `workshop/content/<appid>/<publishedFileId>` with nothing after it. That
 * "nothing after it" is the important half - it is what stops a parent
 * directory, a sibling, or a subfolder from matching.
 *
 * Exists to gate a recursive delete, so it answers "no" to anything it is not
 * certain about.
 *
 * @param {string} dir @param {string|number} publishedFileId
 */
function isDownloadDir(dir, publishedFileId) {
  if (!dir || !publishedFileId) return false
  const id = String(publishedFileId)
  if (!PUBLISHED_ID_RE.test(id)) return false

  const target = path.resolve(dir)
  const parts = target.split(path.sep).map((s) => s.toLowerCase())
  const at = parts.lastIndexOf('content')
  const shaped = at > 0 &&
    parts[at - 1] === 'workshop' &&
    parts[at + 1] === String(locate.APP_ID) &&
    parts[at + 2] === id &&
    parts.length === at + 3
  if (!shaped) return false

  // SteamCMD's tree and Steam's own have exactly the same shape, so the shape
  // alone is not enough to tell them apart - and the difference matters
  // completely. Steam's copy is subscribed content it owns and re-downloads;
  // deleting it is the thing this whole module exists to prevent. Only a
  // directory outside every Steam Workshop root is ours to remove.
  return !identify(target).isWorkshop
}

/**
 * Is this item already on disk, because Steam has it subscribed?
 *
 * Checked before any download is attempted. Sandustry is a paid game, so an
 * anonymous SteamCMD login cannot fetch its Workshop items at all - but a
 * player who owns it and subscribed in Steam already has the files locally,
 * and importing those needs no download, no login and no SteamCMD.
 *
 * Returns the directory Steam owns. The caller must copy out of it and must
 * never delete it; `isDownloadDir` refuses this path for exactly that reason.
 *
 * @param {string|number} publishedFileId
 * @returns {string|null}
 */
function findLocalItem(publishedFileId) {
  const id = String(publishedFileId || '')
  if (!PUBLISHED_ID_RE.test(id)) return null
  for (const root of roots()) {
    const dir = path.join(root, id)
    try {
      if (fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length) return dir
    } catch (_) { /* not in this library */ }
  }
  return null
}

/**
 * Delete a SteamCMD download once it has been copied out (or refused).
 *
 * Leaving it would defeat the point of importing: SteamCMD's tree is its own to
 * re-sync, so a copy left there is a second, invisible version of the mod that
 * can change without SandLoader knowing.
 *
 * The guard is the whole function. A directory that is not unmistakably a
 * download folder for this exact item is left completely alone - a leftover
 * download is untidy, deleting the wrong folder is not recoverable.
 *
 * @param {string} dir @param {string|number} publishedFileId @param {any} [logger]
 * @returns {boolean} whether anything was removed
 */
function discardDownload(dir, publishedFileId, logger) {
  const say = logger || { info() {}, warn() {} }
  if (!isDownloadDir(dir, publishedFileId)) {
    say.warn(`not removing ${dir}: it is not a Workshop download folder for ${publishedFileId}`)
    return false
  }
  try {
    fs.rmSync(path.resolve(dir), { recursive: true, force: true })
    say.info(`removed the SteamCMD download at ${dir}`)
    return true
  } catch (e) {
    // The mod is already installed by this point; a leftover download is
    // untidy, not a failure worth putting in front of the player.
    say.warn(`could not remove the SteamCMD download: ${e.message}`)
    return false
  }
}

/**
 * Provenance for an item that was imported out of the Workshop and now lives in
 * the normal mods folder.
 *
 * Written next to the mod, read back by `annotate`. It exists so the manager
 * can still say where a mod came from and offer its Workshop page, without the
 * mod pretending to be Steam-managed: an imported copy is SandLoader's own file
 * and stays fully removable, which is the whole point of importing it.
 */
const ORIGIN_FILE = '.smln-workshop.json'

/** @param {string} dir @param {{publishedFileId:string, title?:string}} info */
function writeOrigin(dir, info) {
  try {
    const body = {
      publishedFileId: String(info.publishedFileId),
      appId: Number(locate.APP_ID),
      importedAt: new Date().toISOString(),
      source: 'steamcmd',
    }
    if (info.title) body.title = String(info.title)
    fs.writeFileSync(path.join(dir, ORIGIN_FILE), JSON.stringify(body, null, 2) + '\n')
    return true
  } catch (_) {
    // Losing the breadcrumb is cosmetic; the mod itself installed fine.
    return false
  }
}

/** Read it back. Untrusted like every other on-disk manifest: fields are checked. */
function readOrigin(dir) {
  try {
    const file = path.join(dir, ORIGIN_FILE)
    if (!fs.existsSync(file)) return null
    const json = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!json || typeof json !== 'object') return null
    const id = String(json.publishedFileId || '')
    if (!PUBLISHED_ID_RE.test(id)) return null
    const out = { publishedFileId: id }
    if (typeof json.importedAt === 'string') out.importedAt = json.importedAt
    if (typeof json.title === 'string') out.title = json.title
    return out
  } catch (_) {
    return null
  }
}

module.exports = {
  roots, identify, annotate, annotateAll, isWorkshopPath,
  readMeta, previewOf, updatedAt, pageUrl, hubUrl,
  parseRef, writeOrigin, readOrigin, isDownloadDir, discardDownload, findLocalItem,
  WORKSHOP_MANIFEST, PUBLISHED_ID_RE, ORIGIN_FILE,
}
