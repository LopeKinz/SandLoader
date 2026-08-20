'use strict'
/**
 * Fetching SteamCMD at install time, so "Install from Workshop" works out of
 * the box.
 *
 * The alternative was telling every player to go and install SteamCMD by hand
 * before the Workshop button does anything, which is a poor first run for a
 * feature whose whole point is "paste a link". So the loader's installer offers
 * to fetch it once.
 *
 * Three rules shape this file:
 *
 *   1. **It is optional and it is visible.** This is the only thing SandLoader
 *      downloads. The installer prints the URL before fetching, `--no-steamcmd`
 *      skips it, and a failed download is a warning - the loader itself still
 *      installs and everything except the Workshop button works.
 *   2. **It never installs what is already there.** A player who has SteamCMD
 *      on PATH keeps theirs; nothing is downloaded and nothing is overwritten.
 *   3. **No new dependencies.** The Windows build ships as a .zip, which
 *      src/mods/zip.js already reads - the same hardened reader mod archives go
 *      through. The macOS and Linux builds ship as .tar.gz, which every one of
 *      those machines can already unpack with the `tar` in its PATH.
 *
 * It lands in `vendor/steamcmd` inside SandLoader's own folder rather than
 * somewhere global: it needs no administrator rights there, it cannot collide
 * with a SteamCMD the player installed themselves, and `install.js --uninstall`
 * can take it away again.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const https = require('https')
const { spawn } = require('child_process')

const zip = require('./zip')
const steamcmd = require('./steamcmd')
const { SmlnError } = require('../core/errors')

/** Valve's documented download locations, with their published mirror second. */
const SOURCES = {
  win32: [
    'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip',
    'https://media.steampowered.com/client/installer/steamcmd.zip',
  ],
  darwin: [
    'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_osx.tar.gz',
    'https://media.steampowered.com/client/installer/steamcmd_osx.tar.gz',
  ],
  linux: [
    'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz',
    'https://media.steampowered.com/client/installer/steamcmd_linux.tar.gz',
  ],
}

/** The bootstrap archive is ~2 MB; anything near this ceiling is not it. */
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 120 * 1000
const MAX_REDIRECTS = 5

/** Where a SandLoader-managed copy lives; steamcmd.js looks here too. */
const vendorDir = steamcmd.vendorDir

/** The executable inside it, whether or not it exists yet. */
function vendorExe() {
  return path.join(vendorDir(), process.platform === 'win32' ? 'steamcmd.exe' : 'steamcmd.sh')
}

function urlsForPlatform() {
  return SOURCES[process.platform] || SOURCES.linux
}

/** Is this platform one Valve publishes SteamCMD for? */
function supported() {
  return !!SOURCES[process.platform] || process.platform === 'linux'
}

/**
 * Download to a file, following redirects.
 *
 * Only https, and only to a host we asked for - a redirect is followed, but the
 * scheme is re-checked each hop so a 302 cannot walk the download down to plain
 * http.
 */
function download(url, destFile, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    if (!/^https:\/\//i.test(url)) {
      reject(new SmlnError('E_IO', `refusing to download over a non-https URL: ${url}`))
      return
    }

    const request = https.get(url, { timeout: DOWNLOAD_TIMEOUT_MS }, (res) => {
      const code = res.statusCode || 0

      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume()
        if (redirectsLeft <= 0) {
          reject(new SmlnError('E_IO', 'too many redirects while downloading SteamCMD'))
          return
        }
        const next = new URL(res.headers.location, url).toString()
        resolve(download(next, destFile, redirectsLeft - 1))
        return
      }

      if (code !== 200) {
        res.resume()
        reject(new SmlnError('E_IO', `SteamCMD download failed: HTTP ${code}`))
        return
      }

      let bytes = 0
      const out = fs.createWriteStream(destFile)

      res.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > MAX_DOWNLOAD_BYTES) {
          request.destroy()
          out.destroy()
          reject(new SmlnError('E_IO', 'the SteamCMD download is implausibly large - refusing'))
        }
      })
      res.pipe(out)
      out.on('error', reject)
      out.on('finish', () => resolve({ bytes }))
    })

    request.on('timeout', () => {
      request.destroy()
      reject(new SmlnError('E_IO', 'the SteamCMD download timed out'))
    })
    request.on('error', (e) => reject(new SmlnError('E_IO', `could not reach Valve: ${e.message}`, { cause: e })))
  })
}

/**
 * Unpack the tarball with the system `tar`.
 *
 * macOS and every mainstream Linux ship one, and shelling out to it beats
 * carrying a tar reader SandLoader would otherwise never need. Windows takes
 * the .zip path instead and never gets here.
 */
function untar(archive, destDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archive, '-C', destDir], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    if (child.stderr) child.stderr.on('data', (c) => { stderr += String(c) })
    child.on('error', (e) => reject(new SmlnError('E_IO',
      `could not run tar to unpack SteamCMD: ${e.message}`, { cause: e })))
    child.on('close', (code) => {
      if (code === 0) resolve(true)
      else reject(new SmlnError('E_IO', `tar failed to unpack SteamCMD (exit ${code}): ${stderr.trim()}`))
    })
  })
}

/**
 * Make sure SteamCMD is available, downloading it if it is not.
 *
 * Resolves a report rather than throwing: the caller is an installer whose main
 * job already succeeded, and a missing downloader must not turn that into a
 * failed install.
 *
 * @param {{force?:boolean, log?:(msg:string)=>void}} [opts]
 * @returns {Promise<{ok:boolean, status:'present'|'installed'|'unsupported'|'failed',
 *                    path?:string, error?:string, url?:string}>}
 */
async function ensure(opts = {}) {
  const log = opts.log || (() => {})

  // Rule 2: someone else's SteamCMD is theirs, and it already works.
  const existing = steamcmd.find()
  if (existing && !opts.force) {
    return { ok: true, status: 'present', path: existing }
  }

  if (!supported()) {
    return { ok: false, status: 'unsupported', error: `Valve does not publish SteamCMD for ${process.platform}` }
  }

  const dir = vendorDir()
  const urls = urlsForPlatform()
  let staging = null
  let lastError = null

  for (const url of urls) {
    try {
      log('  fetching  ' + url)
      staging = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-steamcmd-'))
      const archive = path.join(staging, path.basename(new URL(url).pathname))
      const { bytes } = await download(url, archive)
      log('  got       ' + Math.round(bytes / 1024) + ' KiB')

      // Unpack into staging first, so a broken archive cannot leave a
      // half-written vendor directory behind.
      const unpacked = path.join(staging, 'out')
      fs.mkdirSync(unpacked, { recursive: true })

      if (archive.endsWith('.zip')) {
        const result = zip.extract(archive, unpacked)
        if (result.skipped.length) {
          throw new SmlnError('E_IO', 'the SteamCMD archive contains unsafe paths - refused')
        }
      } else {
        await untar(archive, unpacked)
      }

      fs.rmSync(dir, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(dir), { recursive: true })
      try {
        fs.renameSync(unpacked, dir)
      } catch (e) {
        // The temp dir is often on another volume; rename cannot cross one.
        if (e.code !== 'EXDEV') throw e
        fs.cpSync(unpacked, dir, { recursive: true })
      }

      const exe = vendorExe()
      if (!fs.existsSync(exe)) {
        throw new SmlnError('E_IO', `the archive did not contain ${path.basename(exe)}`)
      }
      if (process.platform !== 'win32') {
        // The tarball carries the mode, but not through every extraction path.
        try { fs.chmodSync(exe, 0o755) } catch (_) { /* best effort */ }
        for (const name of ['linux32/steamcmd', 'linux64/steamcmd', 'osx32/steamcmd']) {
          const p = path.join(dir, name)
          try { if (fs.existsSync(p)) fs.chmodSync(p, 0o755) } catch (_) { /* best effort */ }
        }
      }

      return { ok: true, status: 'installed', path: exe, url }
    } catch (e) {
      lastError = e
      log('  failed    ' + e.message)
      // Try the mirror before giving up.
    } finally {
      if (staging) { try { fs.rmSync(staging, { recursive: true, force: true }) } catch (_) { /* ignored */ } }
      staging = null
    }
  }

  return {
    ok: false,
    status: 'failed',
    error: (lastError && lastError.message) || 'unknown error',
  }
}

/** Remove a SandLoader-managed copy. A SteamCMD the player installed is left alone. */
function remove() {
  const dir = vendorDir()
  try {
    if (!fs.existsSync(dir)) return false
    fs.rmSync(dir, { recursive: true, force: true })
    return true
  } catch (_) {
    return false
  }
}

module.exports = { ensure, remove, vendorDir, vendorExe, supported, urlsForPlatform, SOURCES }
