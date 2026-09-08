# Worker Sandkit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `workerEntry` mods a real handle on the simulation worker's Sandkit, and translate the corelib worker calls the bundled mods actually make onto the game's own worker API.

**Architecture:** A patch publishes the worker's module-local state onto `self.__SMLN_WORKER__` — the object the worker runtime already installs. The runtime then exposes `state`, `sandkit` and `game`, plus a deferral for mods that load before the capture and a safe wrapper over the game's own event and interceptor tables. A separate injected shim publishes `fluxloaderAPI` and a translated `corelib`, because corelib's own worker half cannot run.

**Tech Stack:** Node ≥18, CommonJS on the loader side; ES5-style worker scripts (`var`, no arrow functions in injected code, matching `worker-runtime.js`). No dependencies.

**Spec:** `docs/superpowers/specs/2026-09-08-worker-sandkit-design.md`

## Global Constraints

- Node ≥18, CommonJS, **no new dependencies**.
- **Injected worker code is ES5-flavoured**: `var`, `function`, no arrow functions, no `const`/`let`, no template literals — match the existing `src/renderer/worker-runtime.js` exactly. It is concatenated into a bundle that must parse in every worker.
- **Nothing may take down a worker.** The simulation runs across 18 threads; a throw that escapes a mod handler stops the game. Every mod-supplied function is called inside `try`.
- The capture patch is `required: false`. A build whose shape moves costs worker mods their API, never the player their game.
- **Baseline before this plan: 189 passed, 3 failed** (`node tools/selftest.js`). The three are the two host-ABI checks and `player.inventory.addFromId`, all out of scope and expected to stay red. Never report a green suite.
- Commit only the files a task names; `mod-creator/` is untracked and must never be committed. Never `git add -A`.
- Commit messages are plain imperative sentences, no `feat:`/`chore:` prefixes, ending with:

  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

### Measured facts this plan rests on

- `dist/js/simulation-worker.js` builds the full Sandkit; the state is named `ue` in the shipped build and the pattern reads that name rather than assuming it.
- `dist/js/utility-worker.js` contains **no** `sandkit:{` construction; `dist/js/manager-worker.js` builds a minimal one (worker messaging only). Neither is a target here.
- The game dispatches worker events as `var n = list[i]; try { n.fn(state, payload) } catch (e) {}` — entries are objects carrying `.fn`.
- The worker API has the methods the shim needs: `createAt`, `removeAt`, `replaceAt`, `getElementTypeAtPos`, `getInfoAtPos`, `move`, `getElementIdFromType`, `getElementTypeFromId`, `getName`.
- `src/main/entry.js:1249` routes every core patch to the renderer bundle with `addPatches(BUNDLE, corePatches)`. Worker patches need their own route.

---

### Task 1: The capture patch, and a route for it

**Files:**
- Modify: `src/patch/core-patches.js` (add `workerPatches`, extend `module.exports`)
- Modify: `src/main/entry.js:1249` (route the new array to the simulation worker)
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `workerPatches` — an array of patch objects in the same shape as `corePatches`, exported from `src/patch/core-patches.js`. After this task, `self.__SMLN_WORKER__.state` exists in the simulation worker at runtime.

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`, after the check named `the getApi anchor covers a registry assigned from an identifier`:

```js
check('the worker capture patch anchors on the simulation worker only', () => {
  const { workerPatches } = require('../src/patch/core-patches')
  assert(Array.isArray(workerPatches) && workerPatches.length,
    'core-patches exports no workerPatches')
  const patch = workerPatches.find((p) => p.id === 'smln:capture-worker-state')
  assert(patch, 'the worker capture patch is missing')
  assert(patch.required === false,
    'the worker patch must not be required - a shape change may not cost the player the game')

  const sim = archive.readText('dist/js/simulation-worker.js')
  const out = engine.apply(sim, [patch])
  assert(out.outcomes[0].status === 'applied',
    'did not match the simulation worker: ' + (out.outcomes[0].reason || out.outcomes[0].status))
  assert(out.outcomes[0].matches === 1, 'expected 1 match, got ' + out.outcomes[0].matches)
  assert(/__SMLN_WORKER__/.test(out.source), 'the patch applied but published nothing')
  new vm.Script(out.source, { filename: 'simulation-worker.js' })

  // The other two build no full Sandkit. Asserting no match here is what makes
  // a future build that starts constructing one visible instead of silently
  // half-supported.
  for (const other of ['dist/js/utility-worker.js', 'dist/js/manager-worker.js']) {
    const res = engine.apply(archive.readText(other), [patch])
    assert(res.outcomes[0].matches === 0,
      other + ' unexpectedly matched the capture anchor - re-check the design')
  }
  return 'one match in the simulation worker, none in the other two, still parses'
})

check('the worker capture patch is routed to the worker, not the bundle', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'entry.js'), 'utf8')
  assert(/addPatches\(SIM_WORKER,\s*workerPatches\)/.test(src),
    'workerPatches are not routed to the simulation worker')
  assert(/workerPatches/.test(src.split('require(')[0] + src),
    'entry.js does not import workerPatches')
  return 'routed to SIM_WORKER'
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep -E "worker capture patch"`
Expected: two FAIL lines — `core-patches exports no workerPatches`.

- [ ] **Step 3: Write minimal implementation**

In `src/patch/core-patches.js`, add above `module.exports`:

```js
/**
 * Patches for the simulation worker.
 *
 * Kept separate from corePatches because those are all routed to the renderer
 * bundle by src/main/entry.js; these go to js/simulation-worker.js.
 */
const workerPatches = [
  {
    id: 'smln:capture-worker-state',
    owner: 'smln',
    description: "Publish the simulation worker's state so worker mods can reach its Sandkit",
    anchorLiteral: 'workerEventTriggerCounts:{}',
    /*
     * The worker builds a complete Sandkit of its own - getApi, the event and
     * interceptor tables, workerLocal - but the state holding it is
     * module-local, so an injected script cannot see it. That is the whole of
     * `ReferenceError: sandkit is not defined`; the API was always there.
     *
     * Anchored on the tail of the Sandkit literal plus the statement that
     * follows it, because that statement names the state. In the shipped build
     * it is `ue`; the name is read out of the match, since minified names are
     * regenerated every release and shapes are not.
     */
    find: /(sandkit:\{getApi:\(\)=>[\w$.]+,[^]{0,400}?workerEventTriggerCounts:\{\}\}\}),(\w+)\.session\.mainSensorCache/g,
    replace: (...args) => {
      const [, literal, state] = args
      return `${literal},(globalThis.__SMLN_WORKER__=globalThis.__SMLN_WORKER__||{}).state=${state},` +
        `${state}.session.mainSensorCache`
    },
    expect: 1,
    // Worker mods losing their API is a bad day; a worker that will not parse
    // is a game that will not run. This one always yields.
    required: false,
  },
]
```

Extend the export line:

```js
module.exports = { corePatches, workerPatches, GLOBAL, captureCall }
```

In `src/main/entry.js`, change the import at line 56:

```js
const { corePatches, workerPatches } = require('../patch/core-patches')
```

and add the route beside line 1249:

```js
  addPatches(BUNDLE, corePatches)
  addPatches(SIM_WORKER, workerPatches)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/selftest.js > /tmp/w1.txt 2>&1; grep -E "worker capture patch" /tmp/w1.txt; grep -E "passed, .* failed" /tmp/w1.txt`
Expected: two PASS lines; summary **191 passed, 3 failed**.

- [ ] **Step 5: Commit**

```bash
git add src/patch/core-patches.js src/main/entry.js tools/selftest.js
git commit -m "Publish the simulation worker's state so mods can reach its Sandkit"
```

---

### Task 2: The runtime hands the Sandkit to mods

**Files:**
- Modify: `src/renderer/worker-runtime.js` (the `self.__SMLN_WORKER__` object near line 232)
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: `self.__SMLN_WORKER__.state`, written by Task 1's patch.
- Produces, on `self.__SMLN_WORKER__`: `sandkit()`, `game()`, `whenWorkerReady(fn)`. `state` stays the plain property the patch assigns.

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`:

```js
check('the worker runtime hands mods the captured Sandkit', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'worker-runtime.js'), 'utf8')
  const sandbox = { self: null, console, setTimeout, clearTimeout }
  sandbox.self = sandbox
  vm.createContext(sandbox)
  new vm.Script(src, { filename: 'worker-runtime.js' }).runInContext(sandbox)
  const SMLN = sandbox.__SMLN_WORKER__
  assert(SMLN, 'the runtime did not install')
  assert(typeof SMLN.whenWorkerReady === 'function', 'no whenWorkerReady')
  assert(SMLN.sandkit() === undefined || SMLN.sandkit() === null,
    'sandkit() must be empty before the capture')

  // A mod loads before the game code, so the deferral has to survive that.
  let seen = null
  SMLN.whenWorkerReady(function (state) { seen = state })
  assert(seen === null, 'whenWorkerReady fired before the state existed')

  // The patch assigns this once the game's worker module evaluates.
  const fakeApi = { elements: {} }
  SMLN.state = { sandkit: { getApi: function () { return fakeApi }, workerEvents: {} } }

  return new Promise((resolve, reject) => setTimeout(() => {
    try {
      assert(seen === SMLN.state, 'whenWorkerReady never fired after the capture')
      assert(SMLN.sandkit() === SMLN.state.sandkit, 'sandkit() does not return the captured one')
      assert(SMLN.game() === fakeApi, 'game() does not return getApi()')
      resolve('deferred until capture, then state, sandkit and game all resolve')
    } catch (e) { reject(e) }
  }, 80))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep "hands mods the captured Sandkit"`
Expected: FAIL — `no whenWorkerReady`.

- [ ] **Step 3: Write minimal implementation**

In `src/renderer/worker-runtime.js`, add above the `self.__SMLN_WORKER__ = {` assignment:

```js
  /*
   * The state arrives later than we do.
   *
   * The interceptor prepends this runtime and then each worker mod, so both
   * run before a single line of the game's worker code - which is what
   * publishes the state (see smln:capture-worker-state). A mod asking for the
   * Sandkit at its own top level would always find nothing, so it asks through
   * whenWorkerReady instead and is called once the capture has happened.
   */
  var READY_POLL_MS = 10
  var READY_TIMEOUT_MS = 5000
  var readyWaiting = []
  var readyPolling = false
  var readyGaveUp = false

  function currentState() {
    return self.__SMLN_WORKER__ ? self.__SMLN_WORKER__.state : undefined
  }

  function currentSandkit() {
    var s = currentState()
    return s ? s.sandkit : undefined
  }

  function currentApi() {
    var sk = currentSandkit()
    if (!sk || typeof sk.getApi !== 'function') return null
    try { return sk.getApi() } catch (e) {
      log('error', 'the worker Sandkit refused getApi(): ' + (e && e.message))
      return null
    }
  }

  function drainReady(state) {
    var waiting = readyWaiting
    readyWaiting = []
    for (var i = 0; i < waiting.length; i++) {
      // A mod that throws here must not stop the mods queued behind it.
      try { waiting[i](state) } catch (e) {
        log('error', 'a whenWorkerReady handler threw: ' + (e && e.message))
      }
    }
  }

  function pollReady(deadline) {
    readyPolling = true
    var state = currentState()
    if (state) { readyPolling = false; drainReady(state); return }
    if (Date.now() > deadline) {
      readyPolling = false
      readyGaveUp = true
      log('warn', 'the worker state was never published - worker mods get messaging only ' +
        '(smln:capture-worker-state did not apply on this build)')
      readyWaiting = []
      return
    }
    setTimeout(function () { pollReady(deadline) }, READY_POLL_MS)
  }

  function whenWorkerReady(fn) {
    if (typeof fn !== 'function') return
    var state = currentState()
    if (state) {
      try { fn(state) } catch (e) {
        log('error', 'a whenWorkerReady handler threw: ' + (e && e.message))
      }
      return
    }
    if (readyGaveUp) return
    readyWaiting.push(fn)
    if (!readyPolling) setTimeout(function () { pollReady(Date.now() + READY_TIMEOUT_MS) }, 0)
  }
```

and add three entries to the exposed object, beside `log: log`:

```js
    sandkit: currentSandkit,
    game: currentApi,
    whenWorkerReady: whenWorkerReady,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/selftest.js 2>&1 | grep "hands mods the captured Sandkit"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/worker-runtime.js tools/selftest.js
git commit -m "Hand worker mods the Sandkit once the game has published it"
```

---

### Task 3: A safe way to hook the game's worker events

**Files:**
- Modify: `src/renderer/worker-runtime.js`
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: `whenWorkerReady`, `currentSandkit` from Task 2.
- Produces, on `self.__SMLN_WORKER__`: `worker.onEvent(modID, name, fn)`, `worker.onInterceptor(modID, name, fn)`, `worker.registrations()`, `worker.releaseMod(modID)`. Handlers are pushed as `{fn: wrapped}` because that is the shape the game's dispatcher reads.

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`:

```js
check('worker event handlers are attributed, isolated and reclaimable', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'worker-runtime.js'), 'utf8')
  const logs = []
  const fakeConsole = { log: (m) => logs.push(String(m)), info: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)) }
  const sandbox = { self: null, console: fakeConsole, setTimeout, clearTimeout }
  sandbox.self = sandbox
  vm.createContext(sandbox)
  new vm.Script(src, { filename: 'worker-runtime.js' }).runInContext(sandbox)
  const SMLN = sandbox.__SMLN_WORKER__

  const sandkit = { getApi: () => ({}), workerEvents: {}, workerInterceptors: {} }
  SMLN.state = { sandkit }

  const seen = []
  assert(SMLN.worker.onEvent('good', 'tick', (st, p) => seen.push(p)) === true,
    'onEvent refused a registration after the capture')
  assert(SMLN.worker.onEvent('bad', 'tick', () => { throw new Error('boom') }) === true,
    'onEvent refused the second registration')

  // The game dispatches exactly this way: entries carry .fn, called (state, payload).
  const list = sandkit.workerEvents.tick
  assert(Array.isArray(list) && list.length === 2, 'handlers did not reach workerEvents')
  for (const entry of list) entry.fn(SMLN.state, 'payload')
  assert(seen.length === 1 && seen[0] === 'payload', 'the good handler did not run')
  assert(logs.some((l) => /bad/.test(l) && /boom/.test(l)),
    'the throwing handler was not reported against its mod: ' + JSON.stringify(logs))

  assert(SMLN.worker.registrations().length === 2, 'registrations() does not list both')
  SMLN.worker.releaseMod('bad')
  assert(sandkit.workerEvents.tick.length === 1, 'releaseMod did not remove the handler')
  assert(SMLN.worker.registrations().length === 1, 'registrations() still lists the released mod')

  // Interceptors go in their own table.
  SMLN.worker.onInterceptor('good', 'place', () => {})
  assert(Array.isArray(sandkit.workerInterceptors.place) &&
    sandkit.workerInterceptors.place.length === 1, 'the interceptor did not register')
  return 'two handlers registered, a throw isolated and attributed, one reclaimed'
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep "attributed, isolated and reclaimable"`
Expected: FAIL — `Cannot read properties of undefined (reading 'onEvent')`.

- [ ] **Step 3: Write minimal implementation**

In `src/renderer/worker-runtime.js`, add below the `whenWorkerReady` block from Task 2:

```js
  /** Every handler this runtime put into the game's tables, so it can take them back. */
  var workerRegistrations = []

  /*
   * The game dispatches with `var n = list[i]; try { n.fn(state, payload) }
   * catch (e) {}` - entries are objects carrying `.fn`. It already swallows
   * throws, but silently: a mod would break the simulation with no trace of
   * which one. Wrapping the handler here is what attaches a name to the
   * failure.
   */
  function addWorkerHandler(table, modID, name, fn, kind) {
    var sk = currentSandkit()
    if (!sk) {
      log('warn', 'mod "' + modID + '" asked for a worker ' + kind + ' before the state existed; ' +
        'wrap the call in SMLN.whenWorkerReady()')
      return false
    }
    if (typeof fn !== 'function') return false
    var bucket = sk[table] || (sk[table] = {})
    var list = bucket[name] || (bucket[name] = [])
    var entry = {
      fn: function (state, payload) {
        try { return fn(state, payload) } catch (e) {
          log('error', 'worker ' + kind + ' "' + name + '" from mod "' + modID + '" threw: ' +
            (e && e.message))
        }
      },
    }
    list.push(entry)
    workerRegistrations.push({ modID: modID, name: name, kind: kind, table: table, entry: entry })
    return true
  }

  function releaseMod(modID) {
    var kept = []
    for (var i = 0; i < workerRegistrations.length; i++) {
      var r = workerRegistrations[i]
      if (r.modID !== modID) { kept.push(r); continue }
      var sk = currentSandkit()
      var list = sk && sk[r.table] ? sk[r.table][r.name] : null
      if (!list) continue
      var at = list.indexOf(r.entry)
      if (at !== -1) list.splice(at, 1)
    }
    workerRegistrations = kept
  }

  var workerApi = {
    onEvent: function (modID, name, fn) {
      return addWorkerHandler('workerEvents', modID, name, fn, 'event')
    },
    onInterceptor: function (modID, name, fn) {
      return addWorkerHandler('workerInterceptors', modID, name, fn, 'interceptor')
    },
    registrations: function () {
      var out = []
      for (var i = 0; i < workerRegistrations.length; i++) {
        out.push({
          modID: workerRegistrations[i].modID,
          name: workerRegistrations[i].name,
          kind: workerRegistrations[i].kind,
        })
      }
      return out
    },
    releaseMod: releaseMod,
  }
```

and expose it beside the Task 2 entries:

```js
    worker: workerApi,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/selftest.js 2>&1 | grep "attributed, isolated and reclaimable"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/worker-runtime.js tools/selftest.js
git commit -m "Let worker mods hook the game's event tables without risking the tick"
```

---

### Task 4: The corelib translation shim

**Files:**
- Create: `src/renderer/worker-compat.js`
- Modify: `src/renderer/prelude.js` (`buildWorker`, lines 211-225)
- Modify: `src/main/entry.js:1136-1144` (skip corelib's worker entry)
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: `self.__SMLN_WORKER__.whenWorkerReady`, `.game()`, `.log()` from Tasks 2-3.
- Produces, in every worker: the globals `fluxloaderAPI` and `corelib`. `corelib.utils.getParticleNameFromNumber(type)`, `corelib.utils.getCellAtPos(x, y)`, `corelib.simulation.setCell(x, y, type)`, `corelib.simulation.moveCell(fromX, fromY, toX, toY)`, `corelib.simulation.createParticle(x, y, type)`. `SMLN.unsupported()` lists what was asked for and refused.

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`:

```js
check('the worker shim translates corelib calls onto the game API', () => {
  const runtime = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'worker-runtime.js'), 'utf8')
  const compat = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'worker-compat.js'), 'utf8')
  const sandbox = { self: null, console, setTimeout, clearTimeout }
  sandbox.self = sandbox
  vm.createContext(sandbox)
  new vm.Script(runtime, { filename: 'worker-runtime.js' }).runInContext(sandbox)
  new vm.Script(compat, { filename: 'worker-compat.js' }).runInContext(sandbox)

  const calls = []
  const api = {
    elements: {
      createAt: (st, x, y, t) => { calls.push(['createAt', x, y, t]); return true },
      removeAt: (st, x, y) => { calls.push(['removeAt', x, y]); return true },
      move: (st, fx, fy, tx, ty) => { calls.push(['move', fx, fy, tx, ty]); return true },
      getInfoAtPos: (st, x, y) => ({ elementType: 4, x, y }),
      getElementIdFromType: (st, t) => (t === 4 ? 'wetSand' : null),
    },
  }
  sandbox.__SMLN_WORKER__.state = { sandkit: { getApi: () => api, workerEvents: {} } }

  return new Promise((resolve, reject) => setTimeout(() => {
    try {
      assert(sandbox.corelib, 'no corelib global was published')
      assert(sandbox.fluxloaderAPI, 'no fluxloaderAPI global was published')

      assert(sandbox.corelib.utils.getParticleNameFromNumber(4) === 'wetSand',
        'the element name did not translate')
      assert(sandbox.corelib.utils.getCellAtPos(3, 5).elementType === 4,
        'getCellAtPos did not translate')

      sandbox.corelib.simulation.setCell(1, 2, 7)
      assert(calls.some((c) => c[0] === 'createAt' && c[3] === 7),
        'setCell did not reach createAt: ' + JSON.stringify(calls))
      // Type 0 is "empty" in corelib's vocabulary, which is a removal here.
      sandbox.corelib.simulation.setCell(1, 2, 0)
      assert(calls.some((c) => c[0] === 'removeAt'), 'setCell(…,0) did not remove')

      sandbox.corelib.simulation.moveCell(1, 2, 3, 4)
      assert(calls.some((c) => c[0] === 'move'), 'moveCell did not translate')

      // refinement assigns into blockRecipes, so it has to exist.
      assert(sandbox.corelib.blockRecipes !== undefined, 'blockRecipes must exist to be assignable')

      // A call the game refuses is reported, never a silent no-op.
      api.elements.move = () => { throw new Error('nope') }
      assert(sandbox.corelib.simulation.moveCell(0, 0, 1, 1) === false,
        'a refused call did not report failure')
      const unsupported = sandbox.__SMLN_WORKER__.unsupported()
      assert(unsupported.some((u) => /moveCell/.test(u.call)),
        'the refused call was not recorded: ' + JSON.stringify(unsupported))

      // fluxloaderAPI.events must tolerate the shapes the mods use.
      let fired = 0
      sandbox.fluxloaderAPI.events.registerEvent('cl:raw-api-setup')
      sandbox.fluxloaderAPI.events.on('cl:raw-api-setup', () => { fired++ })
      sandbox.fluxloaderAPI.events.tryTrigger('cl:raw-api-setup')
      assert(fired === 1, 'the event did not fire')
      sandbox.fluxloaderAPI.events.tryTrigger('never-registered')
      resolve('corelib calls translated, events delivered, gaps reported')
    } catch (e) { reject(e) }
  }, 80))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep "shim translates corelib calls"`
Expected: FAIL — `ENOENT` on `worker-compat.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/renderer/worker-compat.js`:

```js
/* eslint-env worker */
'use strict'
/**
 * What Fluxloader worker mods actually reach for.
 *
 * They do not call Sandkit. `refinement/entry.worker.js` calls
 * `corelib.utils.getParticleNameFromNumber`, `corelib.simulation.setCell` and
 * `fluxloaderAPI.events.on` - and corelib builds that surface out of
 * `exposed.raw`, which two patches fill by capturing ~250 minified identifiers
 * by name. The one the worker half reads targets js/336.bundle.js, a chunk
 * 0.5.6 no longer emits, so `raw` is never populated and every call fails.
 *
 * corelib's own entry.worker.js is therefore not run at all: it would die on
 * its first line touching exposed.raw. This publishes the `corelib` global
 * itself, with the methods reimplemented against the game's own worker API -
 * the same decision the renderer bridge made when 75 of 92 anchors went stale.
 *
 * Anything without an equivalent is recorded and readable through
 * SMLN.unsupported(), so a player sees which mod wanted what instead of
 * meeting a silent no-op.
 */
;(function installWorkerCompat(self) {
  var SMLN = self.__SMLN_WORKER__
  if (!SMLN || self.corelib) return

  var unsupported = []
  function note(what, why) {
    unsupported.push({ call: what, reason: why })
    SMLN.log('warn', 'worker compat: ' + what + ' - ' + why)
  }

  function api() {
    var a = SMLN.game()
    if (!a) note('corelib', 'the worker API is not available yet')
    return a
  }

  var events = Object.create(null)

  var fluxloaderAPI = {
    events: {
      registerEvent: function (name) { if (!events[name]) events[name] = [] },
      on: function (name, fn) {
        if (typeof fn !== 'function') return
        ;(events[name] || (events[name] = [])).push(fn)
      },
      off: function (name, fn) {
        var list = events[name]
        if (!list) return
        var at = list.indexOf(fn)
        if (at !== -1) list.splice(at, 1)
      },
      trigger: function (name, payload) { return fire(name, payload, false) },
      tryTrigger: function (name, payload) { return fire(name, payload, true) },
      isEventRegistered: function (name) { return !!events[name] },
    },
  }

  function fire(name, payload, tolerant) {
    var list = events[name]
    if (!list) {
      if (!tolerant) note('fluxloaderAPI.events.trigger("' + name + '")', 'no such event is registered')
      return false
    }
    for (var i = 0; i < list.length; i++) {
      // One listener must not take the worker down, nor the listeners after it.
      try { list[i](payload) } catch (e) {
        SMLN.log('error', 'worker event "' + name + '" listener threw: ' + (e && e.message))
      }
    }
    return true
  }

  var corelib = {
    // refinement assigns into this; it has no equivalent in the game's API, so
    // it exists to be assignable and is reported when something reads it.
    blockRecipes: {},

    utils: {
      getParticleNameFromNumber: function (type) {
        var a = api()
        if (!a || !a.elements || typeof a.elements.getElementIdFromType !== 'function') return null
        try { return a.elements.getElementIdFromType(SMLN.state, type) } catch (e) { return null }
      },
      getCellAtPos: function (x, y) {
        var a = api()
        if (!a || !a.elements || typeof a.elements.getInfoAtPos !== 'function') return null
        try { return a.elements.getInfoAtPos(SMLN.state, x, y) } catch (e) { return null }
      },
    },

    simulation: {
      /*
       * corelib's setCell(x, y, type) means "put this element here", and type 0
       * means empty. The game splits that into createAt and removeAt.
       */
      setCell: function (x, y, type) {
        var a = api()
        if (!a || !a.elements) return false
        try {
          if (!type) return !!a.elements.removeAt(SMLN.state, x, y)
          return !!a.elements.createAt(SMLN.state, x, y, type)
        } catch (e) {
          note('corelib.simulation.setCell', (e && e.message) || 'the game refused the call')
          return false
        }
      },
      moveCell: function (fromX, fromY, toX, toY) {
        var a = api()
        if (!a || !a.elements || typeof a.elements.move !== 'function') return false
        try { return !!a.elements.move(SMLN.state, fromX, fromY, toX, toY) } catch (e) {
          note('corelib.simulation.moveCell', (e && e.message) || 'the game refused the call')
          return false
        }
      },
      createParticle: function (x, y, type) {
        var a = api()
        if (!a || !a.elements || typeof a.elements.createAt !== 'function') return false
        try { return !!a.elements.createAt(SMLN.state, x, y, type) } catch (e) {
          note('corelib.simulation.createParticle', (e && e.message) || 'the game refused the call')
          return false
        }
      },
    },
  }

  self.fluxloaderAPI = fluxloaderAPI
  self.corelib = corelib
  SMLN.unsupported = function () { return unsupported.slice() }

  // The API only answers once the game has published its state, so the event
  // corelib's dependents wait on is fired then and not before.
  SMLN.whenWorkerReady(function () {
    fire('cl:raw-api-setup', undefined, true)
  })
})(typeof self !== 'undefined' ? self : this)
```

In `src/renderer/prelude.js`, inject it right after the runtime inside `buildWorker`, so the globals exist before any mod source runs:

```js
  for (const file of ['worker-runtime.js', 'worker-compat.js']) {
    try {
      chunks.push(';try{\n' + fs.readFileSync(path.join(__dirname, file), 'utf8') +
        '\n}catch(e){console.error("[SMLN] ' + file + ' failed to install:",e)}')
    } catch (e) {
      chunks.push('/* ' + file + ' unavailable: ' + (e.code || e.message) + ' */')
    }
  }
```

replacing the single `worker-runtime.js` block at lines 214-219.

- [ ] **Step 4: Stop corelib's own worker entry from clobbering the shim**

`corelib/entry.worker.js` ends with `globalThis.corelib = new CoreLib()`. Mod
sources are appended after this shim, so leaving it to run would replace the
translated surface with the broken one - and it would then fail on
`exposed.raw` anyway.

In `src/main/entry.js`, in the Fluxloader worker-entry block at lines 1136-1144,
skip it and say so:

```js
        if (mod.entrypoints.worker) {
          if (mod.id === 'corelib') {
            /*
             * corelib's worker half builds its API from exposed.raw, filled by
             * a patch against js/336.bundle.js - a chunk this build no longer
             * emits. Running it would fail on its first call and, worse, its
             * last line replaces globalThis.corelib with the broken object,
             * taking the translated surface with it. See
             * src/renderer/worker-compat.js.
             */
            logger.info('fluxloader: corelib worker entry skipped - SandLoader supplies the ' +
              'translated worker surface instead')
          } else {
            try {
              runtime.workerScripts[SIM_WORKER].push(
                flCompat.wrapEntrypoint(mod, 'worker', fs.readFileSync(mod.entrypoints.worker, 'utf8')))
            } catch (e) {
              note(new SmlnError('E_MOD_LOAD', `fluxloader mod "${mod.id}": ${e.message}`, { detail: { mod: mod.id } }),
                'fluxloader', mod.id)
            }
          }
        }
```

Add to the check written in Step 1, before its `resolve(...)`:

```js
      const entrySrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'entry.js'), 'utf8')
      assert(/corelib worker entry skipped/.test(entrySrc),
        "corelib's worker entry is still injected and would clobber the shim")
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node tools/selftest.js > /tmp/w4.txt 2>&1; grep "shim translates corelib calls" /tmp/w4.txt; grep -E "passed, .* failed" /tmp/w4.txt`
Expected: PASS; summary **194 passed, 3 failed**.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/worker-compat.js src/renderer/prelude.js src/main/entry.js tools/selftest.js
git commit -m "Translate the corelib worker calls that mods actually make"
```

---

### Task 5: Say what worker mods now get

**Files:**
- Modify: `README.md` (the `Worker entrypoints do not get a Sandkit API yet` bullet, around line 817)
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`:

```js
check('the README describes the worker API that now exists', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')
  assert(!/there is no worker-side `sandkit` for it to call/.test(readme),
    'the README still says there is no worker-side sandkit')
  assert(/whenWorkerReady/.test(readme), 'the README does not name the entry point mods use')
  assert(/utility worker|simulation worker/i.test(readme),
    'the README does not say which worker gains the API')
  return 'worker limitation rewritten'
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep "describes the worker API"`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

In `README.md`, replace the whole `- **Worker entrypoints do not get a Sandkit API yet.** …` bullet with:

```markdown
- **Worker entrypoints get the simulation worker's Sandkit.** The worker builds
  a full one — `getApi()`, the event and interceptor tables — but the state
  holding it is module-local, so an injected script could not see it. SandLoader
  publishes it and hands it over through `SMLN.whenWorkerReady(fn)`, which waits
  because mod code runs before the game's worker code does. `SMLN.worker.onEvent`
  and `SMLN.worker.onInterceptor` register handlers that are attributed to their
  mod and cannot take a simulation tick down. Only the **simulation worker**
  builds a Sandkit; a `workerEntry` running in the utility worker still gets
  messaging and nothing more.
- **Fluxloader worker mods are translated, not run.** They call corelib, and
  corelib's worker API is built from `exposed.raw` — filled by a patch against
  `js/336.bundle.js`, a chunk Sandustry 0.5.6 no longer emits. Nothing can
  revive that, so SandLoader publishes `corelib` and `fluxloaderAPI` itself, with
  the calls the bundled mods make reimplemented against the game's worker API.
  What has no equivalent is reported rather than silently doing nothing.
```

- [ ] **Step 4: Run the whole suite**

Run: `node tools/selftest.js > /tmp/w5.txt 2>&1; grep "describes the worker API" /tmp/w5.txt; grep -E "passed, .* failed" /tmp/w5.txt; sed -n '/Failures:/,$p' /tmp/w5.txt`
Expected: PASS; **195 passed, 3 failed**, and the three are the two host-ABI checks and `player.inventory.addFromId`.

- [ ] **Step 5: Commit**

```bash
git add README.md tools/selftest.js
git commit -m "Say what worker mods get now that they get something"
```

---

## Final verification

- [ ] Run: `node tools/selftest.js 2>&1 | tail -8`
  Expected: **195 passed, 3 failed**, the three being the known out-of-scope ones.
- [ ] Run: `node tools/e2e-attach.js --run`
  Expected: `PASSED` — the attach still installs, loads and reverts cleanly.
- [ ] In the running game, with `corelib` and `refinement` enabled: install the attach, launch through Steam, and read the newest log under `%APPDATA%/sandustry/smln/logs`. Expected: no `ReferenceError: sandkit is not defined`, and any refused call named with its mod. Then `node install.js --uninstall`.
- [ ] Confirm `git status` shows no stray files and nothing left in the game directory.
