'use strict'
/**
 * Which pieces of the official Sandkit contract does the running setup provide?
 *
 * Sandustry ships no local-mod loader of its own: main.js finds a Steam
 * Workshop item declaring `modID: "fluxloader"`, requires its bundle, and hands
 * over. SandLoader *is* that host - install.js writes the slot shim - so
 * "does the game load mods" is the wrong question. SandLoader loads them.
 *
 * The question that actually matters is what the host still owes the renderer.
 * The game builds `state.sandkit` itself, just before "game:ready":
 *
 *   g.sandkit = {mods:{items,projectiles,misc,elements,matters,structures,
 *                      triggers,terrains}, graphics,events,hooks,keyBindings}
 *
 * - registries only, with no `getApi`. Yet the renderer bundle *calls*
 * `state.sandkit.getApi()` 44 times and never defines it; only the simulation
 * worker does (`getApi:()=>FH`). Supplying it is the host's job, and SandLoader
 * was not doing it. That is why runtime.js logged `sandkit: unavailable`, why
 * SMLN.sandkit stayed null, and why every official main entry died on
 * "the game Sandkit API is unavailable on this build" - silently, because the
 * manager reads its own config for the badge and never asks whether the mod ran.
 *
 * This module only reports. The repair is the `smln:sandkit-get-api` patch in
 * src/patch/core-patches.js; the report is what the manager surfaces so an
 * unrunnable mod stops presenting itself as enabled when that patch is absent
 * or fails to apply.
 *
 * Probes read the *shipped* bundle, so a gap SandLoader repairs at patch time
 * still reports as missing here. That is deliberate - it is what makes a failed
 * patch visible. Callers distinguish the two cases with `repairedBy`.
 */

const fs = require('fs')
const path = require('path')

/** Field the game's own Fluxloader lookup keys on. */
const FLUXLOADER_MOD_ID = 'fluxloader'

/**
 * Each probe answers one question about the installed build. `test` receives
 * the decoded source and returns true when the capability is present.
 *
 * The patterns are matched against the *shipped* text, so they are written
 * against minified-and-unminified alike: main.js ships readable, the renderer
 * bundle does not.
 */
const PROBES = [
  {
    id: 'sandkit-get-api',
    file: 'dist/js/bundle.js',
    requirement: 'the renderer bundle defines state.sandkit.getApi()',
    consequence:
      'official main entries cannot obtain the Sandkit API; SMLN.sandkit stays ' +
      'null and every official renderer entry fails at startup',
    // Definition, not call site. The bundle calls getApi() dozens of times
    // without ever defining it, so searching for the bare name matches only
    // callers and would report the capability as present.
    //
    // A false "present" here is the expensive direction: it would suppress the
    // warning and restore exactly the silent failure this module exists to end.
    test: (src) => /getApi\s*[:=]\s*(?:function\b|\(|[\w$]+\s*=>)/.test(src),
    // Supplied by our own renderer patch rather than by the game.
    repairedBy: 'smln:sandkit-get-api',
  },
]

/**
 * Is Fluxloader - the only mod host this build actually supports - installed?
 *
 * Mirrors main.js: scan the Steam Workshop content folder for this app id and
 * look for a modinfo.json declaring modID "fluxloader". Returns null when the
 * question cannot be answered (no Workshop folder, non-Steam install) so the
 * caller can distinguish "absent" from "unknown".
 *
 * @returns {{present:boolean, path:string|null}|null}
 */
function findFluxloader(workshopPath) {
  if (!workshopPath) return null
  let folders
  try {
    if (!fs.existsSync(workshopPath)) return null
    folders = fs.readdirSync(workshopPath)
  } catch (_) {
    return null
  }

  for (const folder of folders) {
    const modPath = path.join(workshopPath, folder)
    const manifest = path.join(modPath, 'modinfo.json')
    try {
      if (!fs.existsSync(manifest)) continue
      const info = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      if (info && info.modID === FLUXLOADER_MOD_ID) return { present: true, path: modPath }
    } catch (_) { /* unreadable or invalid manifest: same as absent */ }
  }
  return { present: false, path: null }
}

/**
 * Inspect the installed game and report which official-mod requirements it
 * meets.
 *
 * @param {(file:string)=>string|null} readFile  dist-relative source reader
 * @param {{workshopPath?:string|null}} [opts]
 * @returns {{supported:boolean, missing:Array, checked:string[], fluxloader:object|null, unreadable:string[]}}
 */
function inspect(readFile, opts = {}) {
  const missing = []
  const checked = []
  const unreadable = []

  for (const probe of PROBES) {
    let src = null
    try { src = readFile(probe.file) }
    catch (_) { src = null }

    if (typeof src !== 'string' || !src) {
      // A file we cannot read is not evidence of absence. Say so rather than
      // reporting a capability as missing on the strength of an I/O failure.
      unreadable.push(probe.file)
      continue
    }

    checked.push(probe.id)
    if (!probe.test(src)) {
      missing.push({
        id: probe.id,
        file: probe.file,
        requirement: probe.requirement,
        consequence: probe.consequence,
        // Carried through so callers can tell "the game does not do this, and
        // we fix it" apart from "nothing fixes this".
        repairedBy: probe.repairedBy || null,
      })
    }
  }

  return {
    supported: missing.length === 0 && unreadable.length === 0,
    missing,
    checked,
    unreadable,
    fluxloader: findFluxloader(opts.workshopPath),
  }
}

/**
 * One human-readable paragraph for the log and the manager's problem list.
 * Written for a player, not a maintainer: it says what will not happen and why,
 * and names the one thing that would change the outcome.
 */
function explain(report) {
  if (!report) return 'official Sandkit support was not checked'
  if (report.supported) return 'official Sandkit mods can run on this build'

  const lines = []
  lines.push(
    'official Sandkit mods cannot run as installed ' +
    `(${report.missing.length} requirement(s) unmet)`
  )
  for (const m of report.missing) {
    lines.push(`  - ${m.requirement}: no. ${m.consequence}`)
    if (m.repairedBy) lines.push(`    SandLoader supplies this via patch "${m.repairedBy}"; it did not apply.`)
  }

  // The host slot is SandLoader's own; say so plainly rather than pointing a
  // player at a Fluxloader install they neither have nor need.
  if (report.fluxloader && !report.fluxloader.present) {
    lines.push(
      '  No mod host is registered in the Steam Workshop slot. Run `npm run install-loader` ' +
      'so Sandustry hands control to SandLoader at startup.'
    )
  }
  if (report.unreadable.length) {
    lines.push(`  could not read: ${report.unreadable.join(', ')} (result is inconclusive)`)
  }
  return lines.join('\n')
}

module.exports = {
  inspect,
  explain,
  findFluxloader,
  PROBES,
  FLUXLOADER_MOD_ID,
}
