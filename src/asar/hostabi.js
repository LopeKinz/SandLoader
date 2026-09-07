'use strict'
/**
 * Does this build still offer the loader slot SandLoader was written against?
 *
 * Until 0.5.5 the game's own main.js scanned the Steam Workshop for a
 * modinfo.json declaring modID "fluxloader" and required the bundle beside it,
 * then drove the loader through six calls. 0.5.6 removed all of it. Asking
 * instead of assuming is what keeps install.js from reporting a healthy
 * install against a host that will never call us.
 */

const reader = require('./reader')

/** The six calls the host makes into a loader, plus the scan that finds one. */
const ABI_CALLS = ['initialize', 'startManager', 'getAPI', 'setGameWindow', 'onGameStarted', 'closeGame']

/**
 * @param {string} mainSource The host's main.js, as text.
 * @returns {boolean} True only when the whole slot is present.
 */
function hasLoaderSlot(mainSource) {
  const src = String(mainSource || '')
  if (!/modID\s*===\s*['"]fluxloader['"]/.test(src)) return false
  if (!/fluxloader\.bundle\.js/.test(src)) return false
  return ABI_CALLS.every((fn) => src.includes(fn))
}

/**
 * Read the host's main.js out of the archive and report on it. Never throws:
 * an unreadable archive is reported as "no slot", which is the safe answer -
 * it sends the installer down the attach path that does not depend on one.
 *
 * @param {{asar:string}} install
 * @returns {{loaderSlot:boolean, reason:string}}
 */
function probe(install) {
  const asar = install && install.asar
  if (!asar) return { loaderSlot: false, reason: 'no archive path to read' }
  let archive = null
  try {
    archive = reader.open(asar)
    if (!archive.has('main.js')) return { loaderSlot: false, reason: 'the archive has no main.js' }
    const ok = hasLoaderSlot(archive.readText('main.js'))
    return {
      loaderSlot: ok,
      reason: ok
        ? "the host's main.js still scans for a loader and drives it"
        : "the host's main.js no longer scans for a loader",
    }
  } catch (e) {
    return { loaderSlot: false, reason: 'could not read the archive: ' + (e && e.message) }
  } finally {
    try { archive && archive.close() } catch (_) { /* closing a failed open */ }
  }
}

module.exports = { hasLoaderSlot, probe, ABI_CALLS }
