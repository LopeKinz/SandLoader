'use strict'
/**
 * Which build of Sandustry is this, and can SandLoader attach to it?
 *
 * On Steam the game loads a mod loader itself: `main.js` scans the Workshop
 * content folder for a `modinfo.json` declaring `modID: "fluxloader"` and
 * requires the bundle next to it. That is the slot SandLoader occupies, and it
 * needs no changes to the installation at all.
 *
 * That scan opens with `if (PLATFORM_NAME !== 'steam') return null;` - verified
 * in the shipped main.js. On every non-Steam build the slot is never even
 * looked at, which is the whole reason SandLoader has been Steam-only.
 *
 * THE NON-STEAM ATTACH POINT
 *
 * Electron resolves its application package by searching, under
 * `process.resourcesPath`, the names `['app', 'app.asar', 'default_app.asar']`
 * in that order. `app` comes first. So creating a *new* `resources/app/`
 * directory takes priority over the untouched `app.asar` beside it - and does
 * so without modifying, overwriting, truncating or deleting a single original
 * file. Uninstalling is deleting the directory we added.
 *
 * Being straight about the trade-off, because it is a real one:
 *
 *   - It writes NEW files INSIDE the installation directory. Nothing original
 *     is touched, but the folder is no longer byte-identical to a fresh
 *     install, and a launcher that verifies file *counts* would notice.
 *   - It needs write permission there. Under Program Files that means running
 *     the installer elevated.
 *   - Afterwards `app.getAppPath()` reports `<resources>/app` rather than
 *     `<resources>/app.asar`. The bootstrap keeps `name` and `version` right,
 *     but code reading the path itself will see the new one.
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
  APP_BOOTSTRAP: 'resources-app-bootstrap',
  UNSUPPORTED: 'unsupported',
})

/** Files the bootstrap adds, relative to `<resources>/app`. */
const BOOTSTRAP_FILES = Object.freeze(['package.json', 'smln-bootstrap.js', '.smln-bootstrap.json'])
const RECEIPT = '.smln-bootstrap.json'

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
 * @property {boolean} hasExistingAppDir
 * @property {boolean} ourAppDir       The existing app dir is one we installed.
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

  const appDir = path.join(resources, 'app')
  const hasExistingAppDir = exists(appDir)
  const ourAppDir = hasExistingAppDir && exists(path.join(appDir, RECEIPT))

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
    hasExistingAppDir,
    ourAppDir,
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

/** @param {Platform} platform @returns {Strategy} */
function strategyFor(platform) {
  const p = platform || {}
  const appDir = p.resources ? path.join(p.resources, 'app') : ''

  if (p.kind === PLATFORMS.STEAM) {
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

  if (p.kind === PLATFORMS.MSSTORE || p.kind === PLATFORMS.GAMEPASS) {
    return {
      id: STRATEGIES.UNSUPPORTED,
      supported: false,
      reason: 'Microsoft Store and Game Pass builds install under WindowsApps, which denies writes ' +
        'even to an administrator and verifies the package signature. There is no file SandLoader ' +
        'is allowed to add, and the game never scans for a loader on this platform - so there is no ' +
        'non-destructive way in. Modifying the package would break the signature and is not an option.',
      reversible: false,
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

  if (p.hasExistingAppDir && !p.ourAppDir) {
    return {
      id: STRATEGIES.UNSUPPORTED,
      supported: false,
      reason: `${appDir} already exists and was not created by SandLoader. ` +
        'Refusing to touch it - something else is already attached here, and overwriting it ' +
        'would break whatever that is.',
      reversible: true,
      requiresElevation: false,
      writes: [],
    }
  }

  return {
    id: STRATEGIES.APP_BOOTSTRAP,
    supported: true,
    reason: "Electron searches resources/ for 'app' before 'app.asar', so an added app/ directory " +
      'loads first. No original file is modified; uninstalling deletes the directory again.',
    reversible: true,
    // Program Files needs elevation, but writableResources already proved we
    // can write, so by the time we get here the question is settled.
    requiresElevation: false,
    writes: BOOTSTRAP_FILES.map((f) => path.join(appDir, f)),
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
  if (p.hasExistingAppDir) {
    lines.push(`Existing app/: ${p.ourAppDir ? 'installed by SandLoader' : 'present, NOT ours'}`)
  }
  lines.push(`Writable     : ${p.writableResources ? 'yes' : 'no'}`)
  return lines.join('\n')
}

module.exports = {
  detect, strategyFor, describe,
  PLATFORMS, STRATEGIES, BOOTSTRAP_FILES, RECEIPT,
  probeWritable,
}
