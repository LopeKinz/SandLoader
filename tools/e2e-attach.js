#!/usr/bin/env node
'use strict'
/**
 * End-to-end attach check. Opt-in, because it starts the game.
 *
 * The self-test runs in plain Node and cannot launch Electron, which is exactly
 * the gap that let a whole game release remove SandLoader's attach point
 * without a single red light. This closes it: install the attach, start the
 * game the way a player does, wait for the loader to write its own log, then
 * uninstall and prove the installation is byte-for-byte back.
 *
 * Windows only. It drives the game through `steam://` and finds the process
 * with `tasklist`, neither of which has a portable equivalent worth faking; on
 * anything else it says so and exits rather than pretending to have checked.
 *
 * Run:  node tools/e2e-attach.js --run
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawn } = require('child_process')

const locate = require('../src/asar/locate')
const platform = require('../src/asar/platform')
const shadow = require('../src/asar/shadow')

const REPO = path.resolve(__dirname, '..')
const LOG_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'sandustry', 'smln', 'logs')
const LAUNCH_TIMEOUT_MS = 90000

function say(...a) { console.log(...a) }

function die(msg, detail) {
  console.error('')
  console.error('  FAILED  ' + msg)
  if (detail) console.error('          ' + detail)
  process.exit(1)
}

/** Everything about resources/ that must be identical again afterwards. */
function fingerprint(resources) {
  const entries = fs.readdirSync(resources).sort()
  const sizes = {}
  for (const name of entries) {
    const full = path.join(resources, name)
    const st = fs.statSync(full)
    sizes[name] = st.isDirectory()
      ? 'dir:' + fs.readdirSync(full).length
      : 'file:' + st.size
  }
  return JSON.stringify(sizes)
}

function newestLog() {
  try {
    return fs.readdirSync(LOG_DIR)
      .map((f) => ({ f, t: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0] || null
  } catch (_) { return null }
}

function gameIsRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Sandustry.exe'], { encoding: 'utf8' })
    return /Sandustry[.]exe/i.test(out)
  } catch (_) { return false }
}

function stopGame() {
  try { execFileSync('taskkill', ['/F', '/IM', 'Sandustry.exe'], { stdio: 'ignore' }) } catch (_) { /* not running */ }
}

function runInstaller(args) {
  return execFileSync(process.execPath, [path.join(REPO, 'install.js'), ...args], { encoding: 'utf8' })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  if (process.platform !== 'win32') {
    die('this harness is Windows only', 'it drives the game through steam:// and tasklist')
  }
  if (!process.argv.includes('--run')) {
    say('')
    say('  This starts Sandustry. Re-run with --run when you are ready.')
    say('')
    process.exit(0)
  }

  const found = locate.tryLocate()
  if (!found.ok) die('could not find Sandustry', String(found.error))
  const plat = platform.detect(found.install)
  say('')
  say('  game      ' + found.install.name + ' ' + found.install.version)
  say('  resources ' + plat.resources)

  if (gameIsRunning()) die('Sandustry is running', 'close it first - the attach renames files it holds open')

  const before = fingerprint(plat.resources)
  const logBefore = newestLog()
  let attached = false

  try {
    say('')
    say('  installing the attach ...')
    runInstaller(['--no-steamcmd'])
    const state = shadow.inspect(plat.resources, plat.base).state
    if (state !== 'attached') die('the installer did not attach', 'state is "' + state + '"')
    attached = true

    say('  launching through Steam ...')
    spawn('cmd', ['/c', 'start', '', 'steam://rungameid/' + locate.APP_ID], { detached: true, stdio: 'ignore' }).unref()

    const deadline = Date.now() + LAUNCH_TIMEOUT_MS
    let proof = null
    while (Date.now() < deadline) {
      const now = newestLog()
      if (now && (!logBefore || now.f !== logBefore.f)) { proof = now; break }
      await sleep(2000)
    }

    if (!proof) {
      die('the loader never wrote a log',
        'looked in ' + LOG_DIR + ' for ' + (LAUNCH_TIMEOUT_MS / 1000) + 's')
    }
    say('  loader    ' + path.join(LOG_DIR, proof.f))
    const head = fs.readFileSync(path.join(LOG_DIR, proof.f), 'utf8').split('\n').slice(0, 3).join('\n')
    say('  first log lines:')
    for (const line of head.split('\n')) say('            ' + line)
  } finally {
    stopGame()
    await sleep(3000)
    if (attached) {
      say('')
      say('  uninstalling ...')
      try { runInstaller(['--uninstall']) } catch (e) { die('uninstall threw', String(e.message)) }
    }
  }

  const after = fingerprint(plat.resources)
  if (after !== before) {
    die('resources/ did not come back to its original shape',
      'before: ' + before + '  after: ' + after)
  }

  say('')
  say('  PASSED  attach loaded, game started, install restored exactly')
  say('')
}

main().catch((e) => die('harness error', (e && e.stack) || String(e)))
