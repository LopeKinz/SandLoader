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
  if (!found.isWorkshop) return mod

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

module.exports = {
  roots, identify, annotate, annotateAll, isWorkshopPath,
  readMeta, previewOf, updatedAt, pageUrl, hubUrl,
  WORKSHOP_MANIFEST, PUBLISHED_ID_RE,
}
