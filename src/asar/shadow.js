'use strict'
/**
 * The shadow attach: taking over the name Electron looks at first.
 *
 * Electron searches resources/ for 'app.asar', then 'app', then
 * 'default_app.asar' - documented under the onlyLoadAppFromAsar fuse, and
 * measured against this build. The first name wins, and with that fuse off
 * (it is off in this build) it does not have to be an archive: a directory of
 * that name is loaded like any other application package.
 *
 * So the original archive is renamed aside and a directory takes its place.
 * Its .unpacked sibling has to move with it, because Electron derives
 * X.asar.unpacked from X.asar - leaving it behind costs the game its native
 * modules, which on Steam means steamworks.js and no Steam at all.
 *
 * Nothing here writes into a file that already existed. Two paths are renamed,
 * and renaming them back is the uninstall.
 *
 * This module owns RECEIPT. platform.js re-exports it and bootstrap.js reads
 * it from here; the constant must not be spelled out a second time anywhere.
 * The dependency runs one way only - shadow.js must never require platform.js,
 * which requires this file.
 */

const fs = require('fs')
const path = require('path')

/** Inserted before `.asar` so the suffix Electron keys on survives. */
const SUFFIX = '.smln-original'

/** Marks a directory in the slot as ours, and records where the original went. */
const RECEIPT = '.smln-bootstrap.json'

function exists(p) {
  try { return fs.existsSync(p) } catch (_) { return false }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch (_) { return false }
}

/**
 * Every path the attach touches, for a given archive base name ('app' or
 * 'game'). `slot` is also where the live archive sits before an attach: taking
 * that name over is the whole mechanism.
 *
 * @param {string} resources
 * @param {string} base
 */
function derive(resources, base) {
  const parked = path.join(resources, base + SUFFIX + '.asar')
  return {
    slot: path.join(resources, base + '.asar'),
    parked,
    parkedUnpacked: parked + '.unpacked',
    liveUnpacked: path.join(resources, base + '.asar.unpacked'),
    receipt: path.join(resources, base + '.asar', RECEIPT),
  }
}

/**
 * What is actually on disk right now.
 *
 *   clean        untouched install, ready to attach
 *   attached     our directory in the slot, original parked beside it
 *   broken       our directory is there but the original is gone (update/verify)
 *   orphaned     a real archive is back in the slot and our original lingers
 *   parked-only  original parked, nothing in the slot - a half-applied attach
 *   foreign      a directory in the slot that is not ours
 *
 * @param {string} resources
 * @param {string} base
 */
function inspect(resources, base) {
  const paths = derive(resources, base)
  const slotIsDir = isDir(paths.slot)
  const slotExists = exists(paths.slot)
  const parkedExists = exists(paths.parked)
  const ours = slotIsDir && exists(paths.receipt)

  let state
  if (ours && parkedExists) state = 'attached'
  else if (ours && !parkedExists) state = 'broken'
  else if (slotIsDir) state = 'foreign'
  else if (slotExists && parkedExists) state = 'orphaned'
  else if (!slotExists && parkedExists) state = 'parked-only'
  else state = 'clean'

  return { state, paths }
}

/**
 * Undo a list of recorded steps, newest first. Each entry is a thunk; a
 * throwing one is swallowed, because rollback runs while something has already
 * gone wrong and the remaining steps still matter.
 */
function rollback(steps) {
  for (let i = steps.length - 1; i >= 0; i--) {
    try { steps[i]() } catch (_) { /* keep undoing the rest */ }
  }
}

/**
 * Take over the slot. Refuses anything but a clean install, and undoes every
 * step it took if a later one fails - a half-applied attach is the one outcome
 * that leaves the player without a game.
 *
 * @param {string} resources
 * @param {string} base
 * @param {Record<string,string>} files Written into the new directory.
 * @returns {{ok:boolean, paths:object, error?:Error}}
 */
function apply(resources, base, files) {
  const { state, paths } = inspect(resources, base)
  if (state !== 'clean') {
    return { ok: false, paths, error: new Error('refusing to attach: the install is "' + state + '", not clean') }
  }

  const undo = []
  try {
    fs.renameSync(paths.slot, paths.parked)
    undo.push(() => fs.renameSync(paths.parked, paths.slot))

    if (exists(paths.liveUnpacked)) {
      fs.renameSync(paths.liveUnpacked, paths.parkedUnpacked)
      undo.push(() => fs.renameSync(paths.parkedUnpacked, paths.liveUnpacked))
    }

    fs.mkdirSync(paths.slot)
    undo.push(() => fs.rmSync(paths.slot, { recursive: true, force: true }))

    for (const name of Object.keys(files)) {
      fs.writeFileSync(path.join(paths.slot, name), files[name])
    }

    return { ok: true, paths }
  } catch (e) {
    rollback(undo)
    return { ok: false, paths, error: e }
  }
}

/**
 * Put the install back. The receipt is the permission slip: without it the
 * directory in the slot belongs to something else and is not ours to delete.
 *
 * The original is checked before the directory is removed, so the window in
 * which the slot holds neither is as short as two syscalls.
 *
 * @param {string} resources
 * @param {string} base
 * @returns {{ok:boolean, error?:Error}}
 */
function revert(resources, base) {
  const { state, paths } = inspect(resources, base)

  if (state === 'foreign') {
    return { ok: false, error: new Error(paths.slot + ' has no SandLoader receipt - refusing to delete it') }
  }
  if (state === 'clean') return { ok: true }
  if (state === 'broken') {
    return { ok: false, error: new Error('the original archive is gone; run "node install.js --repair"') }
  }

  try {
    if (isDir(paths.slot)) fs.rmSync(paths.slot, { recursive: true, force: true })
    if (exists(paths.parked)) fs.renameSync(paths.parked, paths.slot)
    if (exists(paths.parkedUnpacked)) fs.renameSync(paths.parkedUnpacked, paths.liveUnpacked)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e }
  }
}

module.exports = { derive, inspect, apply, revert, SUFFIX, RECEIPT }
