'use strict'
/**
 * Which build of Sandustry is this, and can SandLoader attach to it?
 *
 * THE LOADER SLOT, WHERE IT STILL EXISTS
 *
 * Up to Sandustry 0.5.5 the game loaded a mod loader itself: `main.js` scanned
 * the Workshop content folder for a `modinfo.json` declaring
 * `modID: "fluxloader"` and required the bundle next to it. That is the slot
 * SandLoader occupies, and it needs no changes to the installation at all - so
 * it is still preferred wherever it is found. The scan opened with
 * `if (PLATFORM_NAME !== 'steam') return null;`, which is why that attach was
 * Steam-only.
 *
 * 0.5.6 removed all of it: no scan, and none of the six calls the host used to
 * make into a loader. Whether the slot exists is therefore a question to ask
 * the build, not a property of the store it came from - see src/asar/hostabi.js.
 *
 * THE ATTACH POINT WHEN THERE IS NO SLOT
 *
 * Electron resolves its application package by searching, under
 * `process.resourcesPath`, the names `app.asar`, `app` and `default_app.asar`
 * in that order - documented under the `onlyLoadAppFromAsar` fuse, and measured
 * against this build. `app.asar` comes FIRST. An added `resources/app/`
 * directory is therefore never reached while an archive sits beside it, which
 * is why the old `resources-app-bootstrap` strategy never worked and has been
 * removed rather than repaired.
 *
 * With `onlyLoadAppFromAsar` off - it is off in this build - the winning name
 * does not have to be an archive. So SandLoader renames the original aside and
 * puts a directory of that name in its place. See src/asar/shadow.js.
 *
 * Being straight about the trade-off, because it is a real one:
 *
 *   - Two paths are RENAMED. No original file's content is modified, and
 *     renaming them back is the uninstall - but the directory is no longer
 *     byte-identical to a fresh install.
 *   - Steam's "verify integrity of game files" restores the archive and leaves
 *     our copy orphaned. That is detected and reported, not prevented.
 *   - It needs write permission there. Under Program Files that means running
 *     the installer elevated.
 *
 * MS Store and Game Pass are NOT supported and cannot be. The package lives
 * under `WindowsApps`, whose ACLs deny writes even to an administrator, and
 * the package is signature-verified - there is no additive file we are allowed
 * to place and no non-destructive attach point to use. Saying "unsupported" is
 * the honest answer; the alternative would be modifying game files.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const shadow = require('./shadow')

const PLATFORMS = Object.freeze({
  STEAM: 'steam',
  GOG: 'gog',
  MSSTORE: 'msstore',
  GAMEPASS: 'gamepass',
  MANUAL: 'manual',
  UNKNOWN: 'unknown',
})

const STRATEGIES = Object.freeze({
  WORKSHOP_SLOT: 'steam-workshop-slot',
  SHADOW_ASAR: 'asar-shadow-directory',
  UNSUPPORTED: 'unsupported',
})

/** Owned by src/asar/shadow.js; re-exported so callers keep one import. */
const RECEIPT = shadow.RECEIPT

function exists(p) {
  try { return fs.existsSync(p) } catch (_) { return false }
}

/**
 * Can we create files in `dir`? Tested by doing it, not by inspecting the
 * path: a read-only mount, an ACL and a missing directory all present very
 * differently and only the attempt tells the truth.
 */
function probeWritable(dir) {
  if (!exists(dir)) return false
  const probe = path.join(dir, '.smln-write-probe-' + process.pid + '-' + Date.now())
  try {
    fs.writeFileSync(probe, 'probe')
    fs.unlinkSync(probe)
    return true
  } catch (_) {
    try { fs.unlinkSync(probe) } catch (_e) { /* nothing to clean up */ }
    return false
  }
}

/** Case-insensitive "does any entry match" for a directory listing. */
function anyMatching(dir, re) {
  try { return fs.readdirSync(dir).filter((f) => re.test(f)) } catch (_) { return [] }
}

/**
 * @typedef {Object} Platform
 * @property {string} kind
 * @property {'certain'|'likely'|'guess'} confidence
 * @property {string[]} evidence
 * @property {string} root
 * @property {string} resources
 * @property {boolean} writableResources
 * @property {string} base             Archive base name: 'app' or 'game'.
 * @property {{state:string, paths:object}} shadow   From src/asar/shadow.js.
 * @property {string|null} platformNameInHost
 */

/**
 * @param {{root:string, resources?:string, asar?:string}} install
 * @returns {Platform}
 */
function detect(install) {
  const root = install && install.root ? path.resolve(install.root) : ''
  const resources = (install && install.resources) || path.join(root, 'resources')
  const evidence = []

  // 'app' for app.asar, 'game' for the game.asar builds locate.js also accepts.
  const base = install && install.asar
    ? path.basename(install.asar).replace(/\.asar$/i, '')
    : 'app'
  const shadowState = shadow.inspect(resources, base)

  let kind = PLATFORMS.UNKNOWN
  let confidence = 'guess'
  let platformNameInHost = null

  // --- MS Store / Game Pass. Checked first: it is the one that must never be
  //     mistaken for something writable.
  const inWindowsApps = /[\\/]WindowsApps[\\/]/i.test(root)
  const appx = ['AppxManifest.xml', 'AppxBlockMap.xml', 'AppxSignature.p7x']
    .filter((f) => exists(path.join(root, f)))
  if (inWindowsApps || appx.length) {
    if (inWindowsApps) evidence.push('installed under WindowsApps')
    for (const f of appx) evidence.push(f + ' beside the executable')
    kind = PLATFORMS.MSSTORE
    confidence = inWindowsApps && appx.length ? 'certain' : 'likely'
    platformNameInHost = 'msstore'
    // Game Pass and a bought MS Store copy are the same package on disk. There
    // is no evidence here that separates them, so we do not guess: the attach
    // answer is identical either way.
  }

  // --- Steam
  if (kind === PLATFORMS.UNKNOWN) {
    const steamMarkers = ['steam_appid.txt', 'installscript.vdf']
      .filter((f) => exists(path.join(resources, f)))
    const inSteamApps = /[\\/]steamapps[\\/]common[\\/]/i.test(root)
    if (steamMarkers.length || inSteamApps) {
      for (const f of steamMarkers) evidence.push('resources/' + f)
      if (inSteamApps) evidence.push('installed under steamapps/common')
      kind = PLATFORMS.STEAM
      // Both kinds of evidence together is conclusive; either alone is strong
      // but not proof - a copied folder keeps the marker files.
      confidence = steamMarkers.length && inSteamApps ? 'certain' : 'likely'
      platformNameInHost = 'steam'
    }
  }

  // --- GOG
  if (kind === PLATFORMS.UNKNOWN) {
    const gog = anyMatching(root, /^goggame-.*\.(info|hashdb|dll|ico)$/i)
    if (gog.length) {
      evidence.push(...gog.slice(0, 3).map((f) => f + ' beside the executable'))
      kind = PLATFORMS.GOG
      confidence = 'certain'
    } else if (exists(path.join(root, 'unins000.exe')) && /[\\/]GOG ?Games?[\\/]/i.test(root)) {
      evidence.push('unins000.exe in a GOG Games directory')
      kind = PLATFORMS.GOG
      confidence = 'likely'
    }
  }

  // --- anything else that is a real install
  if (kind === PLATFORMS.UNKNOWN && exists(path.join(resources, 'app.asar'))) {
    evidence.push('resources/app.asar with no store markers')
    kind = PLATFORMS.MANUAL
    confidence = 'likely'
  }

  return {
    kind,
    confidence,
    evidence,
    root,
    resources,
    writableResources: probeWritable(resources),
    base,
    shadow: shadowState,
    platformNameInHost,
  }
}

/**
 * @typedef {Object} Strategy
 * @property {string} id
 * @property {boolean} supported
 * @property {string} reason
 * @property {boolean} reversible
 * @property {boolean} requiresElevation
 * @property {string[]} writes
 */

/**
 * @param {Platform} platform
 * @param {{loaderSlot:boolean}} [host] From src/asar/hostabi.js. Absent is
 *   treated as "no slot", which routes to the attach that does not need one.
 * @returns {Strategy}
 */
function strategyFor(platform, host) {
  const p = platform || {}
  const loaderSlot = !!(host && host.loaderSlot)

  // MS Store first: it is the one that must never be mistaken for writable.
  if (p.kind === PLATFORMS.MSSTORE || p.kind === PLATFORMS.GAMEPASS) {
    return {
      id: STRATEGIES.UNSUPPORTED,
      supported: false,
      reason: 'Microsoft Store and Game Pass builds install under WindowsApps, which denies writes ' +
        'even to an administrator and verifies the package signature. There is no file SandLoader ' +
        'is allowed to add or rename, so there is no way in. Modifying the package would break the ' +
        'signature and is not an option.',
      reversible: false,
      requiresElevation: false,
      writes: [],
    }
  }

  // The slot changes nothing on disk, so it wins wherever it still exists.
  if (p.kind === PLATFORMS.STEAM && loaderSlot) {
    return {
      id: STRATEGIES.WORKSHOP_SLOT,
      supported: true,
      reason: "the game's own main.js scans the Steam Workshop for a loader and requires it; " +
        'SandLoader occupies that slot and changes nothing on disk',
      reversible: true,
      requiresElevation: false,
      writes: [],
    }
  }

  if (!p.writableResources) {
    return {
      id: STRATEGIES.UNSUPPORTED,
      supported: false,
      reason: `SandLoader cannot write to ${p.resources || 'the resources directory'}. ` +
        'Run the installer with administrator rights, or move the game somewhere writable.',
      reversible: true,
      requiresElevation: true,
      writes: [],
    }
  }

  const state = (p.shadow && p.shadow.state) || 'clean'
  if (state === 'foreign') {
    return {
      id: STRATEGIES.UNSUPPORTED,
      supported: false,
      reason: `${(p.shadow && p.shadow.paths.slot) || 'the app.asar slot'} is a directory that ` +
        'SandLoader did not create. Something else is attached here, and overwriting it would ' +
        'break whatever that is. Remove it first if you are sure it is no longer needed.',
      reversible: true,
      requiresElevation: false,
      writes: [],
    }
  }

  const paths = (p.shadow && p.shadow.paths) || shadow.derive(p.resources || '', p.base || 'app')
  return {
    id: STRATEGIES.SHADOW_ASAR,
    supported: true,
    reason: 'Electron searches resources/ for app.asar first, and this build does not require it ' +
      'to be an archive. The original is renamed aside and a directory takes its place; renaming ' +
      "it back is the uninstall. No original file's content is modified.",
    reversible: true,
    requiresElevation: false,
    writes: [paths.slot, paths.parked, paths.parkedUnpacked],
  }
}

/** A paragraph for `install.js --status` and the loader log. */
function describe(platform, strategy) {
  const p = platform || {}
  const s = strategy || strategyFor(p)
  const lines = []
  lines.push(`Installation : ${p.kind}${p.confidence ? ` (${p.confidence})` : ''}`)
  if (p.root) lines.push(`Location     : ${p.root}`)
  if (p.evidence && p.evidence.length) lines.push(`Evidence     : ${p.evidence.join(', ')}`)
  lines.push(`Attach       : ${s.id}${s.supported ? '' : '  - NOT SUPPORTED'}`)
  lines.push(`Why          : ${s.reason}`)
  if (s.writes.length) {
    lines.push('Would create :')
    for (const w of s.writes) lines.push(`               ${w}`)
  }
  if (p.shadow && p.shadow.state !== 'clean') {
    lines.push(`Attach state : ${p.shadow.state}`)
  }
  lines.push(`Writable     : ${p.writableResources ? 'yes' : 'no'}`)
  return lines.join('\n')
}

module.exports = {
  detect, strategyFor, describe,
  PLATFORMS, STRATEGIES, RECEIPT,
  probeWritable,
}
