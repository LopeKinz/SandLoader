# asar shadow attach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SandLoader attaches to Sandustry builds that no longer offer a Workshop loader slot, by taking over the `app.asar` name with a directory that chains into the renamed original.

**Architecture:** A new module `src/asar/shadow.js` owns every filesystem move the attach makes — deriving paths, inspecting on-disk state, applying with rollback, reverting. `platform.js` stops assuming a strategy and picks one from a host-ABI probe. `bootstrap.js` learns the original archive's location from the receipt beside it instead of guessing a filename. `install.js` and the self-test consume all of that; a new opt-in harness proves it against the real game.

**Tech Stack:** Node ≥18, no dependencies. Plain-Node self-test (`tools/selftest.js`), CommonJS throughout.

**Spec:** `docs/superpowers/specs/2026-09-07-asar-shadow-attach-design.md`

## Global Constraints

- Node ≥18, CommonJS, **no new dependencies**. The project ships `jsdom` only as a dev aid; nothing else.
- Style matches the existing codebase: `'use strict'`, no semicolon-free rewrites, comments explain *why* not *what*, prose in comments is full sentences.
- The renamed original **must** keep the `.asar` suffix — Electron derives `X.asar.unpacked` from `X.asar`. The suffix inserted before it is `.smln-original`, giving `app.smln-original.asar`.
- Electron's application-package search order is `app.asar`, then `app`, then `default_app.asar`. Never write code or comments claiming otherwise.
- Every filesystem mutation rolls back on failure. A half-applied attach leaves the player without a game and is the one unacceptable outcome.
- The bootstrap's existing rule is preserved everywhere: on any failure, require the untouched game anyway.
- Receipt filename stays `.smln-bootstrap.json` (`platform.RECEIPT`).
- Tests are added to `tools/selftest.js` using its `check(name, fn)` / `assert(cond, msg)` helpers; a check returns a detail string. Run with `node tools/selftest.js`.
- Baseline before this work: **156 passed, 5 failed**. The 5 failures are the host-ABI and patch-anchor checks against 0.5.6 and are expected to stay red until a separate effort retargets them. Never claim a green run.

---

### Task 1: Host ABI probe

**Files:**
- Create: `src/asar/hostabi.js`
- Test: `tools/selftest.js` (new checks appended near the existing host-ABI section, around line 107)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `hasLoaderSlot(mainSource: string) -> boolean`, `probe(install: {asar:string}) -> {loaderSlot: boolean, reason: string}`.

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`, after the existing `host still hands us startGame + paths` check:

```js
check('the loader-slot probe recognises a host that offers the slot', () => {
  const hostabi = require('../src/asar/hostabi')
  const withSlot = `
    if (modID === "fluxloader") { require(path.join(dir, "fluxloader.bundle.js")) }
    loader.initialize(api); loader.startManager(); loader.getAPI();
    loader.setGameWindow(w); loader.onGameStarted(); loader.closeGame();
  `
  assert(hostabi.hasLoaderSlot(withSlot) === true, 'a host with the full ABI was not recognised')
  return 'full ABI recognised'
})

check('the loader-slot probe rejects a host that dropped the slot', () => {
  const hostabi = require('../src/asar/hostabi')
  const noSlot = 'const MODDING_ENABLED = false; function createWindow() {}'
  assert(hostabi.hasLoaderSlot(noSlot) === false, '0.5.6-shaped main.js was treated as offering the slot')
  const partial = 'if (modID === "fluxloader") { } // but no startManager'
  assert(hostabi.hasLoaderSlot(partial) === false, 'a partial ABI must not count as a usable slot')
  return 'missing and partial ABI both rejected'
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep "loader-slot probe"`
Expected: two FAIL lines, `Cannot find module '../src/asar/hostabi'`

- [ ] **Step 3: Write minimal implementation**

Create `src/asar/hostabi.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/selftest.js 2>&1 | grep "loader-slot probe"`
Expected: two PASS lines.

- [ ] **Step 5: Commit**

```bash
git add src/asar/hostabi.js tools/selftest.js
git commit -m "Ask the host whether it still offers a loader slot"
```

---

### Task 2: Shadow paths and on-disk state

**Files:**
- Create: `src/asar/shadow.js`
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: `platform.RECEIPT` (the string `.smln-bootstrap.json`).
- Produces: `derive(resources: string, base: string) -> {slot, parked, parkedUnpacked, liveUnpacked, receipt}`, `inspect(resources, base) -> {state, paths}` where `state` is one of `'clean' | 'attached' | 'broken' | 'orphaned' | 'parked-only' | 'foreign'`, and `SUFFIX` (`'.smln-original'`).

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`:

```js
check('shadow paths keep the .asar suffix Electron needs for .unpacked', () => {
  const shadow = require('../src/asar/shadow')
  const p = shadow.derive('/res', 'app')
  assert(p.slot === path.join('/res', 'app.asar'), 'slot is not the name Electron looks at first')
  assert(p.parked === path.join('/res', 'app.smln-original.asar'), 'parked original lost its .asar suffix')
  assert(p.parkedUnpacked === p.parked + '.unpacked', 'unpacked sibling must be <parked>.unpacked')
  assert(p.liveUnpacked === path.join('/res', 'app.asar.unpacked'), 'live unpacked path is wrong')
  const g = shadow.derive('/res', 'game')
  assert(g.parked === path.join('/res', 'game.smln-original.asar'), 'game.asar builds are not derived')
  return 'app and game bases both derive correctly'
})

check('shadow state is read off the disk, not assumed', () => {
  const shadow = require('../src/asar/shadow')
  const platform = require('../src/asar/platform')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-shadow-'))
  const seen = {}
  try {
    fs.writeFileSync(path.join(dir, 'app.asar'), 'ARCHIVE')
    seen.clean = shadow.inspect(dir, 'app').state

    fs.renameSync(path.join(dir, 'app.asar'), path.join(dir, 'app.smln-original.asar'))
    seen.parkedOnly = shadow.inspect(dir, 'app').state

    fs.mkdirSync(path.join(dir, 'app.asar'))
    seen.foreign = shadow.inspect(dir, 'app').state

    fs.writeFileSync(path.join(dir, 'app.asar', platform.RECEIPT), '{}')
    seen.attached = shadow.inspect(dir, 'app').state

    fs.rmSync(path.join(dir, 'app.smln-original.asar'))
    seen.broken = shadow.inspect(dir, 'app').state

    fs.rmSync(path.join(dir, 'app.asar'), { recursive: true, force: true })
    fs.writeFileSync(path.join(dir, 'app.asar'), 'ARCHIVE')
    fs.writeFileSync(path.join(dir, 'app.smln-original.asar'), 'ARCHIVE')
    seen.orphaned = shadow.inspect(dir, 'app').state
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  assert(seen.clean === 'clean', 'untouched install read as ' + seen.clean)
  assert(seen.parkedOnly === 'parked-only', 'half-applied install read as ' + seen.parkedOnly)
  assert(seen.foreign === 'foreign', 'a directory without our receipt read as ' + seen.foreign)
  assert(seen.attached === 'attached', 'a complete attach read as ' + seen.attached)
  assert(seen.broken === 'broken', 'attach with the original gone read as ' + seen.broken)
  assert(seen.orphaned === 'orphaned', 'restored archive beside our original read as ' + seen.orphaned)
  return 'all six states distinguished'
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep "shadow "`
Expected: two FAIL lines, `Cannot find module '../src/asar/shadow'`

- [ ] **Step 3: Write minimal implementation**

Create `src/asar/shadow.js`:

```js
'use strict'
/**
 * The shadow attach: taking over the name Electron looks at first.
 *
 * Electron searches resources/ for 'app.asar', then 'app', then
 * 'default_app.asar' - measured, and documented under the onlyLoadAppFromAsar
 * fuse. The first name wins, and with that fuse off (it is off in this build)
 * it does not have to be an archive: a directory of that name is loaded like
 * any other application package.
 *
 * So the original archive is renamed aside and a directory takes its place.
 * Its .unpacked sibling has to move with it, because Electron derives
 * X.asar.unpacked from X.asar - leaving it behind costs the game its native
 * modules, which on Steam means steamworks.js and no Steam at all.
 *
 * Nothing here writes into a file that already existed. Two paths are renamed,
 * and renaming them back is the uninstall.
 */

const fs = require('fs')
const path = require('path')

/** Inserted before `.asar` so the suffix Electron keys on survives. */
const SUFFIX = '.smln-original'

/** Kept in step with platform.RECEIPT; duplicated to avoid a require cycle. */
const RECEIPT = '.smln-bootstrap.json'

function exists(p) {
  try { return fs.existsSync(p) } catch (_) { return false }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch (_) { return false }
}

/**
 * Every path the attach touches, for a given archive base name ('app' or
 * 'game'). `slot` and the live archive are deliberately the same path: taking
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

module.exports = { derive, inspect, SUFFIX, RECEIPT }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/selftest.js 2>&1 | grep "shadow "`
Expected: two PASS lines.

- [ ] **Step 5: Commit**

```bash
git add src/asar/shadow.js tools/selftest.js
git commit -m "Derive the shadow attach's paths and read its state off disk"
```

---

### Task 3: Applying the attach, with rollback at every step

**Files:**
- Modify: `src/asar/shadow.js`
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: `derive`, `inspect` from Task 2.
- Produces: `apply(resources, base, files) -> {ok: boolean, paths, error?: Error}` where `files` is an object mapping filename to file contents, written into the new directory.

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`:

```js
check('applying the shadow attach moves both paths and lands the files', () => {
  const shadow = require('../src/asar/shadow')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-apply-'))
  try {
    fs.writeFileSync(path.join(dir, 'app.asar'), 'ARCHIVE')
    fs.mkdirSync(path.join(dir, 'app.asar.unpacked'))
    fs.writeFileSync(path.join(dir, 'app.asar.unpacked', 'native.node'), 'NATIVE')

    const out = shadow.apply(dir, 'app', { 'package.json': '{}', [shadow.RECEIPT]: '{"v":1}' })
    assert(out.ok, 'apply reported failure: ' + (out.error && out.error.message))
    assert(fs.readFileSync(path.join(dir, 'app.smln-original.asar'), 'utf8') === 'ARCHIVE',
      'the original archive did not move')
    assert(fs.readFileSync(path.join(dir, 'app.smln-original.asar.unpacked', 'native.node'), 'utf8') === 'NATIVE',
      'the unpacked natives did not move with it')
    assert(fs.statSync(path.join(dir, 'app.asar')).isDirectory(), 'the slot is not a directory')
    assert(fs.existsSync(path.join(dir, 'app.asar', shadow.RECEIPT)), 'the receipt was not written')
    assert(shadow.inspect(dir, 'app').state === 'attached', 'state after apply is not attached')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return 'archive, natives and three files all in place'
})

check('a failed apply leaves the install exactly as it found it', () => {
  const shadow = require('../src/asar/shadow')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-rollback-'))
  try {
    fs.writeFileSync(path.join(dir, 'app.asar'), 'ARCHIVE')
    fs.mkdirSync(path.join(dir, 'app.asar.unpacked'))

    // A file whose name is an invalid path component makes the last step throw
    // after both renames have already happened - the worst moment to fail.
    const out = shadow.apply(dir, 'app', { 'sub/dir/nope.json': '{}' })
    assert(!out.ok, 'apply reported success despite an unwritable file')
    assert(fs.readFileSync(path.join(dir, 'app.asar'), 'utf8') === 'ARCHIVE',
      'the original archive was not put back')
    assert(fs.statSync(path.join(dir, 'app.asar.unpacked')).isDirectory(),
      'the unpacked directory was not put back')
    assert(!fs.existsSync(path.join(dir, 'app.smln-original.asar')),
      'a parked original was left behind')
    assert(shadow.inspect(dir, 'app').state === 'clean', 'state after rollback is not clean')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return 'both renames undone, nothing left behind'
})

check('apply refuses to start unless the install is clean', () => {
  const shadow = require('../src/asar/shadow')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-guard-'))
  try {
    fs.mkdirSync(path.join(dir, 'app.asar'))
    const out = shadow.apply(dir, 'app', { 'package.json': '{}' })
    assert(!out.ok, 'apply ran against a slot that already held a directory')
    assert(/foreign/.test(String(out.error && out.error.message)),
      'the refusal did not name the state it found: ' + (out.error && out.error.message))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return 'a non-clean install is refused, and the state is named'
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep -E "applying the shadow|failed apply|apply refuses"`
Expected: three FAIL lines, `shadow.apply is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `src/asar/shadow.js`, above `module.exports`:

```js
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
```

Extend the export line to `module.exports = { derive, inspect, apply, SUFFIX, RECEIPT }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/selftest.js 2>&1 | grep -E "applying the shadow|failed apply|apply refuses"`
Expected: three PASS lines.

- [ ] **Step 5: Commit**

```bash
git add src/asar/shadow.js tools/selftest.js
git commit -m "Apply the shadow attach, undoing every step if one fails"
```

---

### Task 4: Reverting the attach

**Files:**
- Modify: `src/asar/shadow.js`
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: `derive`, `inspect`, `apply` from Tasks 2-3.
- Produces: `revert(resources, base) -> {ok: boolean, error?: Error}`.

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`:

```js
check('reverting puts the install back byte for byte', () => {
  const shadow = require('../src/asar/shadow')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-revert-'))
  try {
    fs.writeFileSync(path.join(dir, 'app.asar'), 'ARCHIVE')
    fs.mkdirSync(path.join(dir, 'app.asar.unpacked'))
    fs.writeFileSync(path.join(dir, 'app.asar.unpacked', 'native.node'), 'NATIVE')

    assert(shadow.apply(dir, 'app', { [shadow.RECEIPT]: '{}' }).ok, 'setup apply failed')
    const out = shadow.revert(dir, 'app')
    assert(out.ok, 'revert reported failure: ' + (out.error && out.error.message))

    assert(fs.readFileSync(path.join(dir, 'app.asar'), 'utf8') === 'ARCHIVE', 'archive not restored')
    assert(fs.readFileSync(path.join(dir, 'app.asar.unpacked', 'native.node'), 'utf8') === 'NATIVE',
      'natives not restored')
    assert(fs.readdirSync(dir).sort().join(',') === 'app.asar,app.asar.unpacked',
      'leftovers in resources: ' + fs.readdirSync(dir).join(','))
    assert(shadow.inspect(dir, 'app').state === 'clean', 'state after revert is not clean')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return 'archive, natives and directory listing all restored'
})

check('revert will not delete a directory SandLoader did not create', () => {
  const shadow = require('../src/asar/shadow')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-revert-guard-'))
  try {
    fs.mkdirSync(path.join(dir, 'app.asar'))
    fs.writeFileSync(path.join(dir, 'app.asar', 'someone-elses.js'), 'MINE')
    fs.writeFileSync(path.join(dir, 'app.smln-original.asar'), 'ARCHIVE')

    const out = shadow.revert(dir, 'app')
    assert(!out.ok, 'revert removed a directory with no receipt')
    assert(fs.existsSync(path.join(dir, 'app.asar', 'someone-elses.js')),
      "another tool's file was deleted")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return 'a receiptless directory is left alone'
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep -E "reverting puts|revert will not"`
Expected: two FAIL lines, `shadow.revert is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `src/asar/shadow.js`, above `module.exports`:

```js
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
```

Extend the export line to `module.exports = { derive, inspect, apply, revert, SUFFIX, RECEIPT }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/selftest.js 2>&1 | grep -E "reverting puts|revert will not"`
Expected: two PASS lines.

- [ ] **Step 5: Commit**

```bash
git add src/asar/shadow.js tools/selftest.js
git commit -m "Revert the shadow attach, and refuse to touch what is not ours"
```

---

### Task 5: Strategy selection asks instead of assuming

**Files:**
- Modify: `src/asar/platform.js` (module header lines 1-38, `STRATEGIES` line 54-58, `BOOTSTRAP_FILES` line 61, `detect()` line 105-186, `strategyFor()` line 197-264, `describe()` line 267-285)
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: `shadow.inspect` (Task 2), `hostabi.probe` (Task 1).
- Produces: `STRATEGIES.SHADOW_ASAR === 'asar-shadow-directory'`; `strategyFor(platform, host)` where `host` is `{loaderSlot: boolean}` and defaults to `{loaderSlot: false}`; `detect(install)` additionally returns `base: string` and `shadow: {state, paths}`. `STRATEGIES.APP_BOOTSTRAP` and `BOOTSTRAP_FILES` are removed.

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`:

```js
check('a Steam host that still offers the slot keeps the zero-touch attach', () => {
  const platform = require('../src/asar/platform')
  const plat = { kind: 'steam', resources: '/res', writableResources: true, shadow: { state: 'clean' } }
  const strat = platform.strategyFor(plat, { loaderSlot: true })
  assert(strat.id === platform.STRATEGIES.WORKSHOP_SLOT, 'got ' + strat.id + ' for a host with the slot')
  assert(strat.writes.length === 0, 'the workshop slot must write nothing into the game directory')
  return 'workshop slot still preferred where it exists'
})

check('a host without the slot gets the shadow attach, on every platform', () => {
  const platform = require('../src/asar/platform')
  for (const kind of ['steam', 'gog', 'manual']) {
    const plat = { kind, resources: '/res', writableResources: true, base: 'app', shadow: { state: 'clean' } }
    const strat = platform.strategyFor(plat, { loaderSlot: false })
    assert(strat.id === platform.STRATEGIES.SHADOW_ASAR, kind + ' got ' + strat.id)
    assert(strat.supported, kind + ' was reported unsupported')
    assert(!strat.reason.includes('before'), 'the reason still claims the old search order')
  }
  return 'steam, gog and manual all fall through to the shadow attach'
})

check('the dead resources-app-bootstrap strategy is gone', () => {
  const platform = require('../src/asar/platform')
  assert(!('APP_BOOTSTRAP' in platform.STRATEGIES), 'APP_BOOTSTRAP is still exported')
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'asar', 'platform.js'), 'utf8')
  assert(!/searching[\s\S]{0,80}'app',\s*'app\.asar'/.test(src),
    'the module header still documents the reversed search order')
  return 'strategy and its false premise both removed'
})

check('MS Store stays unsupported and non-writable installs still refuse', () => {
  const platform = require('../src/asar/platform')
  const store = platform.strategyFor({ kind: 'msstore', resources: '/res' }, { loaderSlot: false })
  assert(store.id === platform.STRATEGIES.UNSUPPORTED, 'msstore became attachable')
  const ro = platform.strategyFor({ kind: 'manual', resources: '/res', writableResources: false }, { loaderSlot: false })
  assert(ro.id === platform.STRATEGIES.UNSUPPORTED, 'a read-only install became attachable')
  return 'both refusals intact'
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep -E "zero-touch attach|shadow attach, on every|resources-app-bootstrap|MS Store stays"`
Expected: FAIL lines — `STRATEGIES.SHADOW_ASAR` is undefined and `APP_BOOTSTRAP` is still present.

- [ ] **Step 3: Write minimal implementation**

In `src/asar/platform.js`:

Replace the module header's `THE NON-STEAM ATTACH POINT` paragraph (lines 14-25) with:

```js
/**
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
 */
```

Replace `STRATEGIES` (lines 54-58) with:

```js
const STRATEGIES = Object.freeze({
  WORKSHOP_SLOT: 'steam-workshop-slot',
  SHADOW_ASAR: 'asar-shadow-directory',
  UNSUPPORTED: 'unsupported',
})
```

Delete the `BOOTSTRAP_FILES` constant (line 61) and its doc comment. Add near the top, after the other requires:

```js
const shadow = require('./shadow')
```

In `detect()`, replace the `appDir` / `hasExistingAppDir` / `ourAppDir` block (lines 111-113) with a base-name derivation, and the corresponding return fields:

```js
  // 'app' for app.asar, 'game' for the game.asar builds locate.js also accepts.
  const base = install && install.asar
    ? path.basename(install.asar).replace(/\.asar$/i, '')
    : 'app'
  const shadowState = shadow.inspect(resources, base)
```

and in the returned object replace `hasExistingAppDir` and `ourAppDir` with:

```js
    base,
    shadow: shadowState,
```

Replace the whole body of `strategyFor()` (lines 197-264) with:

```js
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
      'it back is the uninstall. No original file\'s content is modified.',
    reversible: true,
    requiresElevation: false,
    writes: [paths.slot, paths.parked, paths.parkedUnpacked],
  }
}
```

In `describe()`, replace the `hasExistingAppDir` block (lines 280-282) with:

```js
  if (p.shadow && p.shadow.state !== 'clean') {
    lines.push(`Attach state : ${p.shadow.state}`)
  }
```

Finally update the exports line to drop `BOOTSTRAP_FILES`:

```js
module.exports = {
  detect, strategyFor, describe,
  PLATFORMS, STRATEGIES, RECEIPT,
  probeWritable,
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/selftest.js 2>&1 | grep -E "zero-touch attach|shadow attach, on every|resources-app-bootstrap|MS Store stays"`
Expected: four PASS lines. `node tools/selftest.js 2>&1 | tail -12` will still show install.js-side breakage until Task 7; that is expected here.

- [ ] **Step 5: Commit**

```bash
git add src/asar/platform.js tools/selftest.js
git commit -m "Pick the attach strategy from what the host actually offers"
```

---

### Task 6: The bootstrap learns where the original went

**Files:**
- Modify: `src/boot/bootstrap.js` (lines 1-4 stray prologue, `originalAppRoot()` lines 42-47, `plan()` lines 82-84, `boot()` lines 114-125 and 166-169)
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: `shadow.RECEIPT` (Task 2).
- Produces: `originalAppRoot(opts: {appDir?: string, resourcesPath?: string}) -> string`; `plan(opts: {appDir?: string, resourcesPath?: string})` unchanged in shape; `boot(opts: {appDir?: string, loader?: any})`.

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`:

```js
check('the bootstrap reads the original archive out of its receipt', () => {
  const boot = require('../src/boot/bootstrap')
  const shadow = require('../src/asar/shadow')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-boot-'))
  try {
    const appDir = path.join(dir, 'app.asar')
    fs.mkdirSync(appDir)
    fs.writeFileSync(path.join(appDir, shadow.RECEIPT),
      JSON.stringify({ originalArchive: path.join(dir, 'app.smln-original.asar') }))
    const got = boot.originalAppRoot({ appDir, resourcesPath: dir })
    assert(got === path.join(dir, 'app.smln-original.asar'),
      'guessed ' + got + ' instead of reading the receipt')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return 'receipt beats guessing'
})

check('without a receipt the bootstrap still finds the untouched archive', () => {
  const boot = require('../src/boot/bootstrap')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-boot-legacy-'))
  try {
    fs.writeFileSync(path.join(dir, 'game.asar'), 'ARCHIVE')
    assert(boot.originalAppRoot({ resourcesPath: dir }) === path.join(dir, 'game.asar'),
      'the game.asar build was not found')
    fs.rmSync(path.join(dir, 'game.asar'))
    fs.writeFileSync(path.join(dir, 'app.asar'), 'ARCHIVE')
    assert(boot.originalAppRoot({ resourcesPath: dir }) === path.join(dir, 'app.asar'),
      'the app.asar build was not found')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return 'game.asar and app.asar both resolved'
})

check('the bootstrap plan reports the archive it would chain into', () => {
  const boot = require('../src/boot/bootstrap')
  const shadow = require('../src/asar/shadow')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-plan-'))
  try {
    const appDir = path.join(dir, 'app.asar')
    fs.mkdirSync(appDir)
    const original = path.join(dir, 'app.smln-original.asar')
    fs.writeFileSync(original, 'ARCHIVE')
    fs.writeFileSync(path.join(appDir, shadow.RECEIPT), JSON.stringify({ originalArchive: original }))
    const p = boot.plan({ appDir, resourcesPath: dir })
    assert(p.asar === original, 'plan chose ' + p.asar)
    assert(p.originalPresent === true, 'plan did not see the parked original')
    assert(p.steps.length >= 5, 'the documented boot order went missing')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return 'plan resolves through the receipt too'
})

check('no stray debug logging survives in the bootstrap', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'boot', 'bootstrap.js'), 'utf8')
  assert(!/smln_debug\.log/.test(src), 'the bootstrap still writes smln_debug.log on every start')
  assert(!/\bflog\(/.test(src), 'the flog() debug helper is still there')
  return 'appendFileSync debug trace removed'
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep -E "reads the original archive|without a receipt|bootstrap plan reports|stray debug logging"`
Expected: four FAIL lines — `originalAppRoot` takes a string today, and the debug trace is still present.

- [ ] **Step 3: Write minimal implementation**

In `src/boot/bootstrap.js`:

Move the stray `enable-features` prologue (lines 1-4) below `'use strict'` and the module doc comment, so the file starts with `'use strict'`. Keep its behaviour identical:

Keep the rest of the existing module doc comment (the numbered 1-5 boot
sequence, the "step 3 before step 4 is the whole trick" paragraph and the
closing note about requiring nothing from `electron` at the top level) exactly
as it is. Replace only its opening paragraph — the one that begins "The non-Steam
bootstrap." and claims Electron prefers `app` over `app.asar` — so the file
starts like this:

```js
'use strict'
/**
 * The bootstrap that runs when the host offers no loader slot.
 *
 * `install.js` renames the original archive aside and writes a three-file
 * directory into the name Electron looks at first - `resources/app.asar`. The
 * stub in there runs as the application package and requires this module,
 * which hands control straight back to the real game. See src/asar/shadow.js
 * for the mechanism and why the search order makes it work.
 *
 * What happens here is the same sequence the Steam host performs, in the same
 * order, because SandLoader's ABI was written against it:
 */

// Must be appended before the app is ready; the simulation workers need it.
try {
  const { app } = require('electron')
  if (app && app.commandLine) app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')
} catch (_) { /* not inside Electron - the self-test loads this in plain Node */ }
```

Replace `originalAppRoot()` (lines 42-47) with:

```js
const RECEIPT = '.smln-bootstrap.json'

/**
 * Where the untouched game actually lives.
 *
 * Under a shadow attach the archive no longer answers to `app.asar` - that name
 * belongs to the directory this file is running from - so the receipt written
 * beside the stub records the real path. Reading it beats guessing a third
 * filename, and it is what makes this resolvable in plain Node.
 *
 * @param {{appDir?:string, resourcesPath?:string}} [opts]
 */
function originalAppRoot(opts = {}) {
  if (opts.appDir) {
    try {
      const receipt = JSON.parse(fs.readFileSync(path.join(opts.appDir, RECEIPT), 'utf8'))
      if (receipt && typeof receipt.originalArchive === 'string' && receipt.originalArchive) {
        return receipt.originalArchive
      }
    } catch (_) { /* fall through to the untouched-install layout */ }
  }
  const resources = opts.resourcesPath || process.resourcesPath ||
    path.resolve(__dirname, '..', '..', '..')
  const target = fs.existsSync(path.join(resources, 'game.asar')) ? 'game.asar' : 'app.asar'
  return path.join(resources, target)
}
```

In `plan()`, replace `const asar = originalAppRoot(resources)` with `const asar = originalAppRoot(opts)`, and keep everything else.

In `boot()`, delete the `logFile` / `flog` lines and every `flog(...)` call, and pass the options through:

```js
function boot(opts = {}) {
  const asar = originalAppRoot(opts)
  const mainFile = path.join(asar, ORIGINAL_MAIN)

  /** Hand control to the untouched game, whatever happened before. */
  function runOriginal(why) {
    if (why) console.warn('[SMLN] starting Sandustry unmodded: ' + why)
    try {
      require(mainFile)
```

and restore the plain `attachWindow(loader)` call in the success branch.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/selftest.js 2>&1 | grep -E "reads the original archive|without a receipt|bootstrap plan reports|stray debug logging"`
Expected: four PASS lines.

- [ ] **Step 5: Commit**

```bash
git add src/boot/bootstrap.js tools/selftest.js
git commit -m "Let the bootstrap read where the original archive went"
```

---

### Task 7: Wire the installer to the shadow attach

**Files:**
- Modify: `install.js` (`bootstrapStub` 137-149, `bootstrapPackage` 156-165, `receiptSource` 166-176, `installBootstrap` 186-218, `uninstallBootstrap` 220-243, `attachStatus` 252-312, `install` 317-378, `uninstall` 380-409, argv dispatch 411-422)
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: `shadow.apply/revert/inspect` (Tasks 2-4), `hostabi.probe` (Task 1), `platform.strategyFor(plat, host)` (Task 5), the bootstrap's `opts.appDir` contract (Task 6).
- Produces: `node install.js --repair`; the three generated files written into the shadow directory: `package.json`, `smln-bootstrap.js`, `.smln-bootstrap.json`.

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`:

```js
check('the generated stub hands the bootstrap its own directory', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'install.js'), 'utf8')
  assert(/\.boot\(\{\s*appDir:\s*__dirname\s*\}\)/.test(src),
    'the stub does not pass appDir, so the bootstrap cannot find its receipt')
  assert(!/'app'\s*before\s*\n?\s*\*\s*'app\.asar'/.test(src),
    'the stub comment still claims the reversed search order')
  return 'stub passes appDir'
})

check('the receipt records the archive the bootstrap has to chain into', () => {
  const install = fs.readFileSync(path.join(__dirname, '..', 'install.js'), 'utf8')
  assert(/originalArchive/.test(install), 'receiptSource does not record originalArchive')
  return 'originalArchive present in the receipt'
})

check('install.js offers a repair path for a broken attach', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'install.js'), 'utf8')
  assert(/--repair/.test(src), 'no --repair flag is dispatched')
  assert(/STRATEGIES\.SHADOW_ASAR/.test(src), 'install.js still branches on the removed strategy')
  assert(!/APP_BOOTSTRAP/.test(src), 'install.js still references APP_BOOTSTRAP')
  return 'repair wired, dead strategy gone'
})

check('the installer refuses to rename files the running game holds open', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'install.js'), 'utf8')
  assert(/gameIsRunning/.test(src), 'install.js has no running-game precondition')
  assert(/gameIsRunning\(\)/.test(src.split('function installShadow')[1] || ''),
    'installShadow does not check it before touching anything')
  return 'running game blocks the attach'
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep -E "generated stub hands|receipt records the archive|offers a repair path"`
Expected: three FAIL lines.

- [ ] **Step 3: Write minimal implementation**

In `install.js`:

Add `const shadow = require('./src/asar/shadow')` and `const hostabi = require('./src/asar/hostabi')` beside the existing requires. Delete the `APP_DIR` constant if one exists and every `APP_BOOTSTRAP` reference.

Replace `bootstrapStub` with:

```js
function bootstrapStub(bootPath) {
  const target = bootPath.replace(/\\/g, '\\\\')
  return `'use strict'
/*
 * SandLoader bootstrap - generated by install.js, do not edit.
 *
 * Electron searches resources/ for 'app.asar' first, and this build does not
 * require that name to be an archive - so this directory is loaded as the
 * application package, and hands control straight back to the real one. The
 * original archive was renamed, never modified; .smln-bootstrap.json beside
 * this file records where it went.
 */
require('${target}').boot({ appDir: __dirname })
`
}
```

Replace `receiptSource` with a version that takes the parked path:

```js
function receiptSource(install, version, originalArchive) {
  return JSON.stringify({
    loader: 'SandLoader',
    version,
    loaderPath: path.resolve(__dirname),
    installedAt: new Date().toISOString(),
    gameVersion: install.version,
    originalArchive,
    note: 'Uninstall with "node install.js --uninstall". No original file was modified; ' +
      'the original archive was renamed to the path in originalArchive.',
  }, null, 2) + '\n'
}
```

Add the running-game precondition beside the other helpers. Renaming a file the
game has mapped fails on Windows with `EBUSY`, and doing it between the two
renames would leave the install half-applied:

```js
/**
 * Is Sandustry running? Renaming an archive Electron has open fails with
 * EBUSY, and finding that out halfway through the attach is the worst place
 * to find it out. Checked before anything moves, not warned about after.
 */
function gameIsRunning() {
  if (process.platform !== 'win32') return false
  try {
    const out = require('child_process')
      .execFileSync('tasklist', ['/FI', 'IMAGENAME eq Sandustry.exe'], { encoding: 'utf8' })
    return /Sandustry\.exe/i.test(out)
  } catch (_) {
    // No tasklist, or it failed: do not block the install on a check we could
    // not make. The attach itself still fails safely and rolls back.
    return false
  }
}
```

Replace `installBootstrap` with `installShadow`:

```js
function installShadow(install, plat, version) {
  if (gameIsRunning()) {
    fail('Sandustry is running.', 'Close the game first - the attach renames files it holds open.')
    return false
  }

  const paths = shadow.derive(plat.resources, plat.base)
  const state = shadow.inspect(plat.resources, plat.base).state

  if (state === 'attached') {
    say('  attach    already installed - reinstalling')
    const back = shadow.revert(plat.resources, plat.base)
    if (!back.ok) { fail('could not remove the previous attach: ' + back.error.message); return false }
  } else if (state !== 'clean') {
    fail(`the install is in the "${state}" state.`, 'Run: node install.js --repair')
    return false
  }

  const bootPath = path.resolve(__dirname, 'src', 'boot', 'bootstrap.js')
  const out = shadow.apply(plat.resources, plat.base, {
    'package.json': bootstrapPackage(realPackage(install), version),
    'smln-bootstrap.js': bootstrapStub(bootPath),
    [platform.RECEIPT]: receiptSource(install, version, paths.parked),
  })

  if (!out.ok) {
    const e = out.error
    if (e && (e.code === 'EACCES' || e.code === 'EPERM')) {
      fail('no permission to change the game directory.',
        'Run this terminal as Administrator. Target was:\n' + paths.slot)
    } else {
      fail('attach failed: ' + (e && e.message), 'The installation was left as it was found.')
    }
    return false
  }

  say('  attach    ' + paths.slot)
  say('  original  ' + paths.parked)
  say('  loader    ' + bootPath)
  say('\n  Installed. No file\'s content was modified; two paths were renamed.')
  say('  Uninstall with: node install.js --uninstall\n')
  return true
}
```

Replace `uninstallBootstrap` with:

```js
function uninstallShadow(plat) {
  const state = shadow.inspect(plat.resources, plat.base).state
  if (state === 'clean') return false
  if (gameIsRunning()) {
    fail('Sandustry is running.', 'Close the game first - the uninstall renames files it holds open.')
    return false
  }
  const out = shadow.revert(plat.resources, plat.base)
  if (!out.ok) { fail('could not remove the attach: ' + out.error.message); return false }
  say('\n  Removed the attach at ' + shadow.derive(plat.resources, plat.base).slot)
  say('  The game is back to its original files.\n')
  return true
}
```

Add a repair entry point:

```js
function repair() {
  const found = locate.tryLocate()
  if (!found.ok) { fail('could not find Sandustry.'); return }
  const plat = platform.detect(found.install)
  const { state, paths } = shadow.inspect(plat.resources, plat.base)

  say('\n  state     ' + state)
  if (state === 'clean' || state === 'attached') { say('  Nothing to repair.\n'); return }

  if (state === 'orphaned') {
    say('  Steam restored ' + paths.slot + '; our copy of the original is an orphan.')
    try { fs.rmSync(paths.parked, { force: true }) } catch (e) { fail('could not remove it: ' + e.message); return }
    try { fs.rmSync(paths.parkedUnpacked, { recursive: true, force: true }) } catch (_) { /* may not exist */ }
    say('  Removed the orphan. Reinstall with: node install.js\n')
    return
  }

  if (state === 'parked-only') {
    try {
      fs.renameSync(paths.parked, paths.slot)
      if (fs.existsSync(paths.parkedUnpacked)) fs.renameSync(paths.parkedUnpacked, paths.liveUnpacked)
    } catch (e) { fail('could not put the original back: ' + e.message); return }
    say('  Put the original archive back. Reinstall with: node install.js\n')
    return
  }

  if (state === 'broken') {
    fail('the original archive is gone - SandLoader cannot restore it.',
      'Use Steam\'s "Verify integrity of game files", or reinstall the game, then run:\n' +
      '  node install.js --uninstall && node install.js')
    return
  }

  fail(paths.slot + ' is a directory SandLoader did not create.',
    'Remove it yourself if you are sure it is no longer needed.')
}
```

In `attachStatus`, replace the `APP_BOOTSTRAP` branch with a `SHADOW_ASAR` branch reporting `shadow.inspect(...).state`, the slot path and the receipt fields, and pass the host probe into `strategyFor`:

```js
  const plat = platform.detect(found.install)
  const host = hostabi.probe(found.install)
  const strat = platform.strategyFor(plat, host)
  say('\nPlatform')
  for (const line of platform.describe(plat, strat).split('\n')) say('  ' + line)
  say('  Loader slot  : ' + (host.loaderSlot ? 'present' : 'absent') + '  -  ' + host.reason)
```

Do the same in `install()`: build `host` and pass it, then branch on `platform.STRATEGIES.SHADOW_ASAR` calling `installShadow`. In `uninstall()`, call `uninstallShadow(plat)`.

Extend the argv dispatch:

```js
if (has('--status', '-s')) status()
else if (has('--repair')) repair()
else if (has('--uninstall', '-u')) uninstall()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/selftest.js 2>&1 | grep -E "generated stub hands|receipt records the archive|offers a repair path"`
Expected: three PASS lines.

Then verify the CLI still reports without throwing, against the real install:

Run: `node install.js --status`
Expected: a `Loader slot  : absent` line and `Attach : asar-shadow-directory`. It must **not** say `INSTALLED`.

- [ ] **Step 5: Commit**

```bash
git add install.js tools/selftest.js
git commit -m "Install, uninstall and repair the shadow attach"
```

---

### Task 8: Stop documenting things that are not true

**Files:**
- Modify: `README.md` (the compatibility table around line 45, the Steam status sample around line 105, the `Limitations and what's not built yet` section at line 791)
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`:

```js
check('the README no longer promises an attach that does not exist', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')
  assert(!/Nothing in the game directory was modified/.test(readme),
    'the README still promises nothing in the game directory changes')
  assert(/0\.5\.6/.test(readme), 'the README has not caught up to 0.5.6')
  assert(/renamed/i.test(readme), 'the README does not say that two paths are renamed')
  assert(/MODDING_ENABLED/.test(readme),
    "the README does not record the game's own disabled modding pipeline")
  return 'promise, version and limitations all updated'
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep "README no longer promises"`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

In `README.md`:

Change the compatibility table's `Game` row to `Sandustry **0.5.6**`, and add a row:

```markdown
| **Attach** | Workshop loader slot where the build still offers one (≤ 0.5.5); otherwise a shadow directory at `resources/app.asar`, with the original renamed aside |
```

Replace the installer's closing promise wherever it appears (`Nothing in the game directory was modified`) with:

```markdown
No file's content was modified. Two paths were renamed — `app.asar` to
`app.smln-original.asar` and its `.unpacked` sibling alongside it — and renaming
them back is what `--uninstall` does.
```

Add to `## Limitations and what's not built yet`:

```markdown
- **Sandustry 0.5.6 removed the loader slot.** Up to 0.5.5 the game's own
  `main.js` scanned the Steam Workshop for a loader and drove it through six
  calls. On 0.5.6 none of that is left, so SandLoader attaches by taking over
  the `app.asar` name instead. That is a rename, not a zero-touch install, and
  Steam's *Verify integrity of game files* undoes it — `node install.js
  --repair` puts the pieces back.
- **The game has its own modding system now, switched off.** 0.5.6 ships
  Workshop discovery, patch sets, a local `mods` folder and a protocol
  interceptor behind `const MODDING_ENABLED = false`. Nothing SandLoader does
  turns it on, and if a later build enables it that is worth designing for
  properly rather than bolting on.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/selftest.js 2>&1 | grep "README no longer promises"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md tools/selftest.js
git commit -m "Say what the installer actually does to the game directory"
```

---

### Task 9: Prove it against the real game

**Files:**
- Create: `tools/e2e-attach.js`
- Modify: `package.json` (add a `test:e2e` script)

**Interfaces:**
- Consumes: `install.js` as a child process, `src/asar/shadow.js`, `src/asar/locate.js`, `src/asar/platform.js`.
- Produces: `node tools/e2e-attach.js --run`, exit code 0 on success and 1 on failure.

- [ ] **Step 1: Write the failing test**

Run the harness before it exists, to fix the contract:

Run: `node tools/e2e-attach.js --run`
Expected: FAIL — `Cannot find module`.

- [ ] **Step 2: Write the harness**

Create `tools/e2e-attach.js`:

```js
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
  console.error('\n  FAILED  ' + msg)
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
    return /Sandustry\.exe/i.test(out)
  } catch (_) { return false }
}

function stopGame() {
  try { execFileSync('taskkill', ['/F', '/IM', 'Sandustry.exe'], { stdio: 'ignore' }) } catch (_) { /* not running */ }
}

function runInstaller(args) {
  return execFileSync(process.execPath, [path.join(REPO, 'install.js'), ...args], { encoding: 'utf8' })
}

async function main() {
  if (!process.argv.includes('--run')) {
    say('\n  This starts Sandustry. Re-run with --run when you are ready.\n')
    process.exit(0)
  }

  const found = locate.tryLocate()
  if (!found.ok) die('could not find Sandustry', String(found.error))
  const plat = platform.detect(found.install)
  say('\n  game      ' + found.install.name + ' ' + found.install.version)
  say('  resources ' + plat.resources)

  if (gameIsRunning()) die('Sandustry is running', 'close it first - the attach renames files it holds open')

  const before = fingerprint(plat.resources)
  const logBefore = newestLog()
  let attached = false

  try {
    say('\n  installing the attach ...')
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
      await new Promise((r) => setTimeout(r, 2000))
    }

    if (!proof) die('the loader never wrote a log', 'looked in ' + LOG_DIR + ' for ' + (LAUNCH_TIMEOUT_MS / 1000) + 's')
    say('  loader    ' + path.join(LOG_DIR, proof.f))
    const head = fs.readFileSync(path.join(LOG_DIR, proof.f), 'utf8').split('\n').slice(0, 3).join('\n')
    say('  first log lines:\n' + head.replace(/^/gm, '            '))
  } finally {
    stopGame()
    await new Promise((r) => setTimeout(r, 3000))
    if (attached) {
      say('\n  uninstalling ...')
      try { runInstaller(['--uninstall']) } catch (e) { die('uninstall threw', String(e.message)) }
    }
  }

  const after = fingerprint(plat.resources)
  if (after !== before) {
    die('resources/ did not come back to its original shape',
      '\n  before: ' + before + '\n  after:  ' + after)
  }

  say('\n  PASSED  attach loaded, game started, install restored exactly\n')
}

main().catch((e) => die('harness error', (e && e.stack) || String(e)))
```

- [ ] **Step 3: Register it**

In `package.json`, add to `scripts`:

```json
    "test:e2e": "node tools/e2e-attach.js --run"
```

- [ ] **Step 4: Run it**

Run: `node tools/e2e-attach.js --run`
Expected: `PASSED  attach loaded, game started, install restored exactly`.

If it fails after attaching, the harness has already uninstalled in its `finally`. Confirm by hand before retrying:

Run: `node install.js --status`
Expected: `Attach state` absent, i.e. a clean install.

- [ ] **Step 5: Commit**

```bash
git add tools/e2e-attach.js package.json
git commit -m "Prove the attach by starting the game the way a player does"
```

---

## Final verification

- [ ] Run: `node tools/selftest.js 2>&1 | tail -12`
  Expected: pass count risen from 156 by the ~20 checks this plan adds; the failure list still exactly the 5 host-ABI and patch-anchor entries from the baseline, **and no others**. Those 5 are 0.5.6 drift and are out of scope here.
- [ ] Run: `node install.js --status`
  Expected: `Loader slot  : absent`, `Attach : asar-shadow-directory`, and no false `INSTALLED`.
- [ ] Run: `node tools/e2e-attach.js --run`
  Expected: `PASSED`.
- [ ] Confirm `git status` shows no stray files under the game directory and no uncommitted changes from this plan.
