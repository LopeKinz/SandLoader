'use strict'
/**
 * Finding the Sandustry installation, without guessing.
 *
 * Order of trust, most reliable first:
 *   1. SANDUSTRY_DIR / SMLN_GAME_DIR - an explicit answer beats any search.
 *   2. Running inside Electron - `process.resourcesPath` is already correct.
 *   3. Every Steam library on the machine, read out of libraryfolders.vdf
 *      rather than assuming the default drive.
 *   4. A short list of conventional install paths, as a last resort.
 *
 * A candidate only counts once the archive parses *and* declares itself to be
 * Sandustry. Finding a file called app.asar proves nothing; plenty of Electron
 * games ship one.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

const reader = require('./reader')
const { SmlnError } = require('../core/errors')

const APP_ID = 2764460

/**
 * @typedef {Object} GameInstall
 * @property {string} root        Directory containing the executable.
 * @property {string} resources   <root>/resources
 * @property {string} asar        <root>/resources/app.asar
 * @property {string} distDir     Where the renderer loads its files from.
 * @property {string} version     From the archive's package.json.
 * @property {string} name
 * @property {string} source      Which strategy found it.
 */

function steamRoots() {
  const roots = []
  if (process.platform === 'win32') {
    for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'C:\\', 'D:\\']) {
      if (base) roots.push(path.join(base, 'Steam'))
    }
    roots.push('C:\\Steam', 'D:\\Steam')
  } else if (process.platform === 'darwin') {
    roots.push(path.join(os.homedir(), 'Library/Application Support/Steam'))
  } else {
    roots.push(
      path.join(os.homedir(), '.steam/steam'),
      path.join(os.homedir(), '.local/share/Steam'),
      path.join(os.homedir(), '.var/app/com.valvesoftware.Steam/data/Steam')
    )
  }
  return roots.filter((r) => {
    try { return fs.existsSync(r) } catch (_) { return false }
  })
}

/**
 * Steam stores extra library locations in a VDF file. Parsing it properly
 * needs no dependency: we only want the "path" values.
 * @returns {string[]} steamapps directories
 */
function steamLibraries() {
  const libs = []
  for (const root of steamRoots()) {
    const steamapps = path.join(root, 'steamapps')
    if (fs.existsSync(steamapps)) libs.push(steamapps)
    for (const vdf of [
      path.join(steamapps, 'libraryfolders.vdf'),
      path.join(root, 'config', 'libraryfolders.vdf'),
    ]) {
      try {
        if (!fs.existsSync(vdf)) continue
        const text = fs.readFileSync(vdf, 'utf8')
        for (const m of text.matchAll(/"path"\s*"([^"]+)"/g)) {
          const p = path.join(m[1].replace(/\\\\/g, '\\'), 'steamapps')
          if (fs.existsSync(p) && !libs.includes(p)) libs.push(p)
        }
      } catch (_) { /* unreadable library file is not fatal */ }
    }
  }
  return libs
}

/** Candidate game directories, in descending order of confidence. */
function candidates() {
  const out = []
  const push = (dir, source) => {
    if (dir && !out.some((c) => c.dir === dir)) out.push({ dir, source })
  }

  for (const env of ['SANDUSTRY_DIR', 'SMLN_GAME_DIR']) {
    if (process.env[env]) push(path.resolve(process.env[env]), `env:${env}`)
  }

  // Inside Electron, resourcesPath points at <game>/resources.
  if (process.versions && process.versions.electron && process.resourcesPath) {
    push(path.dirname(process.resourcesPath), 'electron:resourcesPath')
  }

  for (const lib of steamLibraries()) {
    push(path.join(lib, 'common', 'Sandustry'), 'steam:library')
  }

  if (process.platform === 'win32') {
    push('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Sandustry', 'conventional')
    push('C:\\Program Files\\Sandustry', 'conventional')
    push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Sandustry'), 'conventional')
  } else if (process.platform === 'darwin') {
    push('/Applications/Sandustry.app/Contents', 'conventional')
  } else {
    push(path.join(os.homedir(), '.local/share/Sandustry'), 'conventional')
  }

  return out
}

/**
 * Validate one directory. Returns null when it is not a Sandustry install.
 * @param {string} dir @param {string} source @returns {GameInstall|null}
 */
function inspect(dir, source) {
  try {
    const resources = path.join(dir, "resources")
    for (const name of ["game.asar", "app.asar"]) {
      const asar = path.join(resources, name)
      const previous = process.noAsar
      process.noAsar = true
      let present
      try {
        present = fs.existsSync(asar)
      } finally {
        process.noAsar = previous
      }
      if (!present || !reader.looksLikeAsar(asar)) continue

      let archive
      try {
        archive = reader.open(asar)
      } catch (_) {
        continue
      }

      try {
        if (!archive.has("package.json")) continue
        const pkg = archive.readJson("package.json")
        if (!pkg || String(pkg.name).toLowerCase() !== "sandustry") continue
        if (!archive.has("dist/index.html")) continue

        return {
          root: dir,
          resources,
          asar,
          distDir: path.join(asar, "dist"),
          version: String(pkg.version || "unknown"),
          name: String(pkg.name),
          source,
        }
      } finally {
        archive.close()
      }
    }
    return null
  } catch (_) {
    return null
  }
}

/**
 * Find the installation.
 * @param {{dir?:string}} [opts] Explicit directory to check first.
 * @returns {GameInstall}
 * @throws {SmlnError} E_GAME_NOT_FOUND with every path that was tried.
 */
function locate(opts = {}) {
  const tried = []
  const list = opts.dir ? [{ dir: path.resolve(opts.dir), source: 'explicit' }, ...candidates()] : candidates()
  for (const c of list) {
    const found = inspect(c.dir, c.source)
    tried.push(c.dir)
    if (found) return found
  }
  throw new SmlnError('E_GAME_NOT_FOUND', 'could not find a Sandustry installation', {
    detail: { tried, hint: 'set SANDUSTRY_DIR to the folder containing Sandustry.exe' },
  })
}

/** Non-throwing variant. */
function tryLocate(opts) {
  try { return { ok: true, install: locate(opts) } }
  catch (e) { return { ok: false, error: e } }
}

/** Steam Workshop content directory for Sandustry, if Steam is present. */
function workshopDir() {
  for (const lib of steamLibraries()) {
    const p = path.join(lib, 'workshop', 'content', String(APP_ID))
    if (fs.existsSync(path.dirname(p))) return p
  }
  return null
}

module.exports = { locate, tryLocate, inspect, candidates, steamLibraries, workshopDir, APP_ID }
