'use strict'
/**
 * Driving SteamCMD, so Workshop items can be fetched without the Steam client.
 *
 * SteamCMD is Valve's headless downloader. It is the right tool here for one
 * reason: `+login anonymous +workshop_download_item` needs no running Steam,
 * no logged-in user and no game ownership check for public items, which is
 * exactly the situation a player installing a mod from a URL is in.
 *
 * Nothing in this file is a dependency SandLoader ships. SteamCMD is located
 * if the machine already has it and reported as missing if it does not - a
 * missing downloader is a normal, explainable state, not a crash.
 *
 * Where the download lands: SteamCMD ignores `+force_install_dir` for Workshop
 * content and always writes to
 *   <steamcmd root>/steamapps/workshop/content/<appid>/<publishedFileId>/
 * It also prints that path on success. The printed path wins - it is the only
 * authoritative answer when a machine has an unusual layout - and the computed
 * path is the fallback.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const { SmlnError } = require('../core/errors')

/** SteamCMD can genuinely take minutes on a large item or a cold login. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

/** Keep only the tail of SteamCMD's chatter for error messages. */
const MAX_LOG_CHARS = 8000

const BIN_NAMES = process.platform === 'win32'
  ? ['steamcmd.exe']
  : ['steamcmd', 'steamcmd.sh']

/** How long a sign-in may take, including a Steam Guard round trip. */
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000

/** Steam account names are conservative; this also gates a command argument. */
const ACCOUNT_RE = /^[A-Za-z0-9_.-]{2,64}$/

/** The several ways SteamCMD asks for a second factor. */
const GUARD_RE = /Steam ?Guard|Two-factor|two factor|authenticator code/i

/**
 * A named account that SteamCMD has never signed in as. It cannot prompt for
 * the password during a download - the prompt is suppressed on purpose so a
 * download can never hang - so it stops with this instead.
 */
const NEEDS_LOGIN_RE = /No cached credentials.*NoPromptForPassword|Cached credentials not found/i

/** `Success. Downloaded item to : "<path>"` - quoted, and the spacing varies. */
const SUCCESS_RE = /Success\.\s*Downloaded item to\s*:\s*"([^"]+)"/i

/**
 * Where a copy fetched by `install.js` lives.
 *
 * Defined here rather than in steamcmd-setup.js so that module can depend on
 * this one without the two requiring each other: locating SteamCMD must work
 * even if the setup half is never loaded.
 */
function vendorDir() {
  return path.resolve(__dirname, '..', '..', 'vendor', 'steamcmd')
}

function isFile(p) {
  try { return fs.statSync(p).isFile() } catch (_) { return false }
}

/** Conventional install locations, by platform. */
function candidateDirs() {
  const out = []
  const home = os.homedir()
  if (process.platform === 'win32') {
    for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'C:\\', 'D:\\']) {
      if (base) out.push(path.join(base, 'steamcmd'), path.join(base, 'SteamCMD'))
    }
    out.push('C:\\steamcmd', 'D:\\steamcmd')
  } else if (process.platform === 'darwin') {
    out.push(
      path.join(home, 'steamcmd'),
      path.join(home, 'Library/Application Support/steamcmd'),
      '/usr/local/bin', '/opt/homebrew/bin'
    )
  } else {
    out.push(
      path.join(home, 'steamcmd'),
      path.join(home, '.steam/steamcmd'),
      path.join(home, '.local/share/Steam/steamcmd'),
      '/usr/games', '/usr/bin', '/usr/local/bin', '/opt/steamcmd'
    )
  }
  return out
}

/** Walk PATH by hand; `which`/`where` is another process and another failure mode. */
function fromPathEnv() {
  const raw = process.env.PATH || ''
  if (!raw) return null
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue
    for (const name of BIN_NAMES) {
      const p = path.join(dir, name)
      if (isFile(p)) return p
    }
  }
  return null
}

/**
 * Find the SteamCMD executable.
 *
 * Order of trust: an explicit env var, then PATH, then the conventional
 * locations - the same "an explicit answer beats any search" shape locate.js
 * uses for the game itself.
 *
 * @returns {string|null} absolute path, or null when SteamCMD is not installed
 */
function find() {
  for (const key of ['SMLN_STEAMCMD', 'STEAMCMD_PATH', 'STEAMCMD']) {
    const v = process.env[key]
    if (v && isFile(v)) return path.resolve(v)
  }

  // A copy the installer fetched. Checked before PATH because it is the one
  // SandLoader knows the shape of, but after the env vars - an explicit answer
  // still wins, including "use mine instead of yours".
  for (const name of BIN_NAMES) {
    const p = path.join(vendorDir(), name)
    if (isFile(p)) return p
  }

  const onPath = fromPathEnv()
  if (onPath) return path.resolve(onPath)

  for (const dir of candidateDirs()) {
    for (const name of BIN_NAMES) {
      const p = path.join(dir, name)
      if (isFile(p)) return path.resolve(p)
    }
  }
  return null
}

/** Where to point a player who has not got it. */
function installHint() {
  if (process.platform === 'win32') {
    return 'Download SteamCMD from https://developer.valvesoftware.com/wiki/SteamCMD, unzip it, ' +
      'and either put steamcmd.exe on your PATH or set SMLN_STEAMCMD to its full path.'
  }
  if (process.platform === 'darwin') {
    return 'Install SteamCMD (brew install --cask steamcmd, or the tarball from ' +
      'https://developer.valvesoftware.com/wiki/SteamCMD), then set SMLN_STEAMCMD if it is not on your PATH.'
  }
  return 'Install SteamCMD (apt install steamcmd, or the tarball from ' +
    'https://developer.valvesoftware.com/wiki/SteamCMD), then set SMLN_STEAMCMD if it is not on your PATH.'
}

/**
 * Is SteamCMD usable on this machine?
 * @returns {{available:boolean, path:string|null, hint:string|null}}
 */
function status() {
  const exe = find()
  return {
    available: !!exe,
    path: exe,
    hint: exe ? null : installHint(),
  }
}

/**
 * The directory SteamCMD would write a given item to.
 *
 * The executable normally sits at the root of its own installation, so the
 * content tree is a sibling of the binary. Used only as a fallback when the
 * success line could not be parsed.
 */
function expectedDir(exePath, appId, publishedFileId) {
  return path.join(
    path.dirname(exePath), 'steamapps', 'workshop', 'content',
    String(appId), String(publishedFileId)
  )
}

/**
 * The argument vector. Split out so the self-test can assert on it without
 * spawning anything.
 *
 * `+login anonymous` unless SMLN_STEAM_USER names an account - that variable is
 * for the case where an app refuses anonymous Workshop downloads, and it relies
 * on SteamCMD's own cached credentials. No password is ever read, stored or
 * passed by SandLoader.
 */
function argsFor(appId, publishedFileId, opts = {}) {
  const user = opts.user || process.env.SMLN_STEAM_USER || 'anonymous'
  return [
    '+@ShutdownOnFailedCommand', '1',
    '+@NoPromptForPassword', '1',
    '+login', user,
    '+workshop_download_item', String(appId), String(publishedFileId),
    '+quit',
  ]
}

/**
 * Signing in.
 *
 * Sandustry is a paid game, so Steam will not serve its Workshop items to the
 * anonymous account. Downloading one without subscribing therefore needs a real
 * Steam login - which SteamCMD performs, not SandLoader. All this does is drive
 * SteamCMD's own prompts.
 *
 * **The password is never stored, never logged and never passed as an argument.**
 * It goes to SteamCMD's stdin and nowhere else:
 *
 *   - argv would be readable by any other process running as this user, which
 *     on this machine includes any mod holding the `node` permission. stdin is
 *     not. (Verified against SteamCMD directly: given `+login <user>` with a
 *     pipe on stdin, it prints `password:` and reads the line, and it does not
 *     echo what it reads - so the captured output stays safe to log.)
 *   - nothing here writes it to disk. SteamCMD caches its *own* session
 *     afterwards, which is what makes later downloads work with only a name.
 *
 * @param {{user:string, password?:string, guardCode?:string, exe?:string,
 *          timeoutMs?:number, logger?:any, spawnFn?:Function, findFn?:Function}} opts
 * @returns {Promise<{ok:true, cached:boolean}|{ok:false, error:SmlnError, needsGuard?:boolean}>}
 */
function login(opts = {}) {
  const user = String(opts.user || '').trim()
  const logger = opts.logger || null
  const exe = opts.exe || (opts.findFn || find)()

  if (!ACCOUNT_RE.test(user)) {
    return Promise.resolve({
      ok: false,
      error: new SmlnError('E_STEAM_LOGIN', 'that does not look like a Steam account name'),
    })
  }
  if (!exe) {
    return Promise.resolve({
      ok: false,
      error: new SmlnError('E_STEAMCMD_MISSING', 'SteamCMD was not found. ' + installHint()),
    })
  }

  // No +@NoPromptForPassword here: the prompt is the thing being answered.
  const args = ['+login', user, '+quit']
  const timeoutMs = Number(opts.timeoutMs || LOGIN_TIMEOUT_MS)
  const launch = opts.spawnFn || spawn

  if (logger) logger.info(`steamcmd: signing in as "${user}"`)

  return new Promise((resolve) => {
    let child
    try {
      child = launch(exe, args, {
        cwd: path.dirname(exe),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (e) {
      resolve({ ok: false, error: new SmlnError('E_STEAMCMD_FAILED', `could not run SteamCMD: ${e.message}`, { cause: e }) })
      return
    }

    let log = ''
    let settled = false
    let timer = null
    let needsGuard = false

    function send(value) {
      try { child.stdin.write(value + '\n') } catch (_) { /* it may have closed */ }
    }

    // Answer up front rather than waiting to see the prompt.
    //
    // SteamCMD writes `password: ` without a newline and then blocks reading
    // stdin. Through a pipe that prompt can sit unflushed in its buffer, so
    // waiting for it before replying deadlocks: it waits for input, we wait for
    // output, and the whole thing sits there until the timeout. Writing
    // immediately is also exactly what `echo <pass> | steamcmd +login <user>`
    // does, which is the invocation this was verified against.
    send(opts.password || '')
    if (opts.guardCode) send(opts.guardCode)
    try { child.stdin.end() } catch (_) { /* already gone */ }

    function finish(result) {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try { child.stdin.end() } catch (_) { /* already gone */ }
      resolve(result)
    }

    function absorb(chunk) {
      const text = String(chunk)
      log = (log + text).slice(-MAX_LOG_CHARS)
      if (GUARD_RE.test(log)) needsGuard = true
    }

    if (child.stdout) child.stdout.on('data', absorb)
    if (child.stderr) child.stderr.on('data', absorb)

    timer = setTimeout(() => {
      try { child.kill() } catch (_) { /* already gone */ }
      finish({
        ok: false,
        error: new SmlnError('E_STEAM_LOGIN', `SteamCMD did not finish signing in within ${Math.round(timeoutMs / 1000)}s`),
      })
    }, timeoutMs)

    child.on('error', (e) => {
      finish({ ok: false, error: new SmlnError('E_STEAMCMD_FAILED', `could not run SteamCMD: ${e.message}`, { cause: e }) })
    })

    child.on('close', () => {
      // The password is not echoed, so the log is safe to keep - but strip it
      // defensively anyway in case a future SteamCMD ever does echo one.
      const safe = opts.password ? log.split(opts.password).join('***') : log

      if (/Logged in OK|Waiting for user info\.\.\.OK/i.test(safe) && !/ERROR/i.test(safe)) {
        if (logger) logger.info(`steamcmd: signed in as "${user}"`)
        finish({ ok: true, cached: /Cached credentials found/i.test(safe) })
        return
      }
      if (needsGuard && !opts.guardCode) {
        finish({
          ok: false,
          needsGuard: true,
          error: new SmlnError('E_STEAM_GUARD', 'Steam sent a Steam Guard code - enter it to finish signing in'),
        })
        return
      }
      if (/Invalid Password|Login Failure/i.test(safe)) {
        finish({
          ok: false,
          error: new SmlnError('E_STEAM_LOGIN', 'Steam rejected that account name or password'),
        })
        return
      }
      if (/RateLimitExceeded|Rate Limit/i.test(safe)) {
        finish({
          ok: false,
          error: new SmlnError('E_STEAM_LOGIN', 'Steam is rate-limiting sign-in attempts - wait a few minutes and try again'),
        })
        return
      }
      if (GUARD_RE.test(safe)) {
        finish({
          ok: false,
          needsGuard: true,
          error: new SmlnError('E_STEAM_GUARD', 'Steam sent a Steam Guard code - enter it to finish signing in'),
        })
        return
      }
      finish({
        ok: false,
        error: new SmlnError('E_STEAM_LOGIN', 'SteamCMD could not sign in', { detail: { log: safe } }),
      })
    })
  })
}

/**
 * Which error code a failed run deserves.
 *
 * Split from the message so the UI can branch on the ownership case - that one
 * has a specific way out (subscribe in Steam), and an error the player can act
 * on beats an error they can only read.
 */
function diagnoseCode(log) {
  const text = String(log || '')
  // A named account with no cached SteamCMD session. Not a download problem at
  // all - the sign-in has simply not happened yet, and saying so lets the UI
  // offer the sign-in rather than a download error the player cannot act on.
  if (NEEDS_LOGIN_RE.test(text)) return 'E_STEAM_LOGIN'
  const failed = text.match(/failed\s*\(([^)]*)\)/i)
  if (failed) {
    const reason = failed[1]
    if (/File Not Found|Invalid/i.test(reason)) return 'E_WORKSHOP_NOT_FOUND'
    if (/^\s*Failure\s*$/i.test(reason) || /Access Denied|No Subscription/i.test(reason)) {
      return 'E_WORKSHOP_OWNERSHIP'
    }
  }
  return 'E_WORKSHOP_DOWNLOAD'
}

/** Classify a failed run into something a player can act on. */
function diagnose(log, code) {
  const text = String(log || '')
  if (NEEDS_LOGIN_RE.test(text)) {
    return 'SteamCMD is set to use a Steam account but has not signed in to it yet. ' +
      'Sign in once and the download will work from then on.'
  }
  if (/Timeout downloading item/i.test(text)) {
    return 'Steam timed out downloading the item. It may be very large, or Steam may be busy - try again.'
  }
  const failed = text.match(/failed\s*\(([^)]*)\)/i)
  if (failed) {
    const reason = failed[1]
    if (/File Not Found|Invalid/i.test(reason)) {
      return 'Steam does not have a Workshop item with that id for Sandustry. Check the URL or id.'
    }
    // The ownership wall, and by far the most common failure here. Sandustry
    // is a paid game, so the anonymous account SteamCMD logs in as does not own
    // it and Steam refuses the download - with a bare "Failure", the same word
    // it uses for everything else, which is why this is worth naming.
    // "File Not Found" means the item does not exist; "Failure" on an item that
    // does exist means we were not allowed to have it.
    if (/^\s*Failure\s*$/i.test(reason) || /Access Denied|No Subscription/i.test(reason)) {
      return 'Steam would not hand over that item. Sandustry is a paid game, so the anonymous ' +
        'login SteamCMD uses is not allowed to download its Workshop items. Subscribe to the item ' +
        'in Steam and install it here again - SandLoader will import the copy Steam downloads. ' +
        'Alternatively, set SMLN_STEAM_USER to a Steam account that owns Sandustry and has logged ' +
        'in to SteamCMD at least once.'
    }
    return 'Steam reported: ' + reason
  }
  if (/Login Failure|Invalid Password|Two-factor|FAILED login/i.test(text)) {
    return 'SteamCMD could not log in. Anonymous login was refused; set SMLN_STEAM_USER to an account ' +
      'that has already logged in to SteamCMD once.'
  }
  if (/Steam Console Client|Loading Steam API/i.test(text)) {
    return 'SteamCMD ran but did not report a downloaded item (exit code ' + code + ').'
  }
  return 'SteamCMD exited with code ' + code + '.'
}

/**
 * Download one Workshop item.
 *
 * Resolves `{ok:true, dir}` with the directory SteamCMD wrote, which is inside
 * SteamCMD's own tree and is the caller's to copy out of - see
 * `manage.installFromDir`. Never throws; every failure comes back as
 * `{ok:false, error:SmlnError}` so the RPC layer can report it verbatim.
 *
 * `findFn` and `spawnFn` are seams for the self-test: locating SteamCMD and
 * running it are the two things it cannot do for real, and injecting them means
 * the "no SteamCMD installed" path is testable on a machine that does have it.
 *
 * @param {string|number} publishedFileId digits only; validated by the caller
 * @param {{appId?:string|number, exe?:string, timeoutMs?:number, logger?:any,
 *          onProgress?:(line:string)=>void, spawnFn?:Function, findFn?:Function,
 *          user?:string}} [opts]
 * @returns {Promise<{ok:true, dir:string, log:string}|{ok:false, error:SmlnError}>}
 */
function downloadItem(publishedFileId, opts = {}) {
  const appId = opts.appId || require('../asar/locate').APP_ID
  const logger = opts.logger || null
  const exe = opts.exe || (opts.findFn || find)()

  if (!exe) {
    return Promise.resolve({
      ok: false,
      error: new SmlnError('E_STEAMCMD_MISSING',
        'SteamCMD was not found on this machine. ' + installHint(),
        { detail: { hint: installHint() } }),
    })
  }

  const args = argsFor(appId, publishedFileId, opts)
  const timeoutMs = Number(opts.timeoutMs || process.env.SMLN_STEAMCMD_TIMEOUT || DEFAULT_TIMEOUT_MS)
  const launch = opts.spawnFn || spawn

  if (logger) logger.info(`steamcmd: downloading workshop item ${publishedFileId} for app ${appId}`)

  return new Promise((resolve) => {
    let child
    try {
      // No shell: the argument vector is passed through untouched, so nothing
      // in a URL a player pasted can ever be interpreted as a command.
      child = launch(exe, args, {
        cwd: path.dirname(exe),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      resolve({
        ok: false,
        error: new SmlnError('E_STEAMCMD_FAILED', `could not run SteamCMD: ${e.message}`, { cause: e }),
      })
      return
    }

    let log = ''
    let settled = false
    let timer = null

    function absorb(chunk) {
      const text = String(chunk)
      log = (log + text).slice(-MAX_LOG_CHARS)
      if (opts.onProgress) {
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim()
          // Reporting progress must never be able to break the download.
          if (trimmed) { try { opts.onProgress(trimmed) } catch (_) { /* ignored */ } }
        }
      }
    }

    function finish(result) {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    if (child.stdout) child.stdout.on('data', absorb)
    if (child.stderr) child.stderr.on('data', absorb)

    timer = setTimeout(() => {
      try { child.kill() } catch (_) { /* it may already be gone */ }
      finish({
        ok: false,
        error: new SmlnError('E_STEAMCMD_FAILED',
          `SteamCMD did not finish within ${Math.round(timeoutMs / 1000)}s - giving up`,
          { detail: { log } }),
      })
    }, timeoutMs)

    child.on('error', (e) => {
      finish({
        ok: false,
        error: new SmlnError('E_STEAMCMD_FAILED', `could not run SteamCMD: ${e.message}`, { cause: e }),
      })
    })

    child.on('close', (code) => {
      const printed = log.match(SUCCESS_RE)
      const dir = printed ? printed[1] : expectedDir(exe, appId, publishedFileId)

      // The success line is the authority, but a zero exit with the item
      // already on disk is just as good: SteamCMD skips an up-to-date item
      // without re-printing the line.
      let exists = false
      try { exists = fs.statSync(dir).isDirectory() } catch (_) { exists = false }

      if ((printed || code === 0) && exists) {
        if (logger) logger.info(`steamcmd: item ${publishedFileId} is at ${dir}`)
        finish({ ok: true, dir: path.resolve(dir), log })
        return
      }

      finish({
        ok: false,
        error: new SmlnError(diagnoseCode(log), diagnose(log, code), { detail: { log, exitCode: code } }),
      })
    })
  })
}

module.exports = {
  find, status, installHint, downloadItem, login, expectedDir, argsFor, diagnose, diagnoseCode,
  vendorDir, ACCOUNT_RE,
  DEFAULT_TIMEOUT_MS, SUCCESS_RE,
}
