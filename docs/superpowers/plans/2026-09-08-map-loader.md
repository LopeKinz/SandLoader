# Map Loader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a map mod's maps appear in Sandustry's own custom-map browser and start, and unlock that browser.

**Architecture:** A new module `src/mods/custom-maps.js` turns a map mod's blueprint PNGs into the `.custommap` file the game already knows how to read, installs it under a prefixed name into `<userData>/custom_maps`, and prunes the ones it wrote for mods that are gone. A one-match core patch flips the compiled-in flag that hides the browser screen. `entry.js` calls the module where it currently only warns.

**Tech Stack:** Node ≥18, CommonJS, no dependencies. Plain-Node self-test (`tools/selftest.js`).

**Spec:** `docs/superpowers/specs/2026-09-08-map-loader-design.md`

## Global Constraints

- Node ≥18, CommonJS, **no new dependencies**. PNG dimensions are read from the IHDR header by hand; do not add an image library.
- **Never delete a file SandLoader did not write.** Only `smln.<modId>.custommap` under `<userData>/custom_maps` may be removed, and only when its mod is gone or disabled. Everything else in that folder is the player's.
- Nothing may abort the load: a bad blueprint is reported per mod through `note(error, scope, modId, severity)` and the other maps still install.
- **Baseline before this plan: 196 passed, 3 failed** (`node tools/selftest.js`). The three are the two host-ABI checks and `player.inventory.addFromId`, all out of scope and expected to stay red. Never report a green suite.
- Do not read, copy or adapt anything from `mods/uolkx.map-studio`. It is a git-ignored third-party mod carrying no licence. Every fact about the game below was taken from the shipped bundle.
- Commit only the files a task names; `mod-creator/` is untracked and must never be committed. Never `git add -A`.
- Commit messages are plain imperative sentences, no `feat:`/`chore:` prefixes, ending with:

  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

### Measured facts this plan rests on

- A `.custommap` is JSON. The renderer reads six layer fields:
  `terrain`, `lights`, `lightsMeta`, `sensors`, `authorization`, `wall`, plus
  `seed`, `createdAt`, `version` and `params`.
- The game lists that folder itself (`custom-map-list`), loads by id
  (`custom-map-load`) and starts by navigating to `custom_map=<id>`.
- The browser screen is hidden by a literal compiled into `dist/js/bundle.js`:
  `mods:{showSubscribedMods:!1},customMaps:{showCustomMaps:!1},procgen:{...}`
- `src/mods/official.js:127` already produces `mod.map = { ...json.map, blueprints: { key: absolutePath } }`.
- `src/main/entry.js:1226` currently warns and does nothing.
- `hostPaths.userData` is where `custom_maps` lives, reached the same way
  `modRoots()` reaches `smln-mods` at `src/main/entry.js:131`.

---

### Task 1: Assemble a .custommap from blueprints

**Files:**
- Create: `src/mods/custom-maps.js`
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `assemble(mapSpec) -> {ok:true, id, file, doc} | {ok:false, reason}`, where `mapSpec` is a mod's `mod.map` object (`{blueprints:{layer:absPath}, seed?, params?, name?}`) plus a `modId`. One mod yields exactly one map, because a `.custommap` carries all six layers. `pngSize(buffer) -> {width, height} | null`. `LAYERS` is the ordered list of the six field names, `REQUIRED_LAYERS` the ones that must be present.

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`, after the check named `the README describes the worker API that now exists`:

```js
check('a map mod blueprint set becomes a .custommap the game could read', () => {
  const maps = require('../src/mods/custom-maps')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-map-'))
  try {
    // A 2x2 PNG, written by hand so the test needs no image library. The IHDR
    // carries the dimensions the validator reads.
    const png = makeTinyPng(2, 2)
    const other = makeTinyPng(2, 2)
    fs.writeFileSync(path.join(dir, 'terrain.png'), png)
    fs.writeFileSync(path.join(dir, 'wall.png'), other)

    const r = maps.assemble({
      modId: 'demo.maps',
      name: 'Demo World',
      seed: 'abc',
      params: { width: 2, height: 2 },
      blueprints: {
        terrain: path.join(dir, 'terrain.png'),
        wall: path.join(dir, 'wall.png'),
      },
    })
    assert(r.ok, 'assemble failed: ' + r.reason)
    assert(r.id === 'smln.demo.maps', 'unexpected id: ' + r.id)
    assert(r.file === 'smln.demo.maps.custommap', 'unexpected file: ' + r.file)
    assert(/^data:image\/png;base64,/.test(r.doc.terrain), 'terrain is not a data URL')
    assert(/^data:image\/png;base64,/.test(r.doc.wall), 'wall is not a data URL')
    assert(r.doc.lights === null, 'an absent layer must be null, not undefined')
    assert(r.doc.seed === 'abc' && r.doc.params.width === 2, 'seed and params did not travel')
    assert(typeof r.doc.createdAt === 'string' && r.doc.version, 'metadata is missing')
    assert(r.doc.name === 'Demo World', 'the name did not travel')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return 'six fields, data URLs, metadata and a collision-proof id'
})

check('a blueprint set the game would reject is refused with a reason', () => {
  const maps = require('../src/mods/custom-maps')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-map-bad-'))
  try {
    fs.writeFileSync(path.join(dir, 'terrain.png'), makeTinyPng(4, 4))
    fs.writeFileSync(path.join(dir, 'wall.png'), makeTinyPng(2, 2))
    fs.writeFileSync(path.join(dir, 'junk.png'), Buffer.from('not a png at all'))

    const noTerrain = maps.assemble({ modId: 'm', blueprints: { wall: path.join(dir, 'wall.png') } })
    assert(!noTerrain.ok && /terrain/i.test(noTerrain.reason),
      'a map with no terrain was accepted: ' + JSON.stringify(noTerrain))

    const mismatched = maps.assemble({
      modId: 'm',
      blueprints: { terrain: path.join(dir, 'terrain.png'), wall: path.join(dir, 'wall.png') },
    })
    assert(!mismatched.ok && /dimension|size/i.test(mismatched.reason),
      'layers of different sizes were accepted: ' + JSON.stringify(mismatched))

    const notPng = maps.assemble({ modId: 'm', blueprints: { terrain: path.join(dir, 'junk.png') } })
    assert(!notPng.ok && /png/i.test(notPng.reason), 'a non-PNG was accepted')

    const missing = maps.assemble({ modId: 'm', blueprints: { terrain: path.join(dir, 'nope.png') } })
    assert(!missing.ok, 'a missing file was accepted')

    assert(maps.pngSize(Buffer.from('nope')) === null, 'pngSize accepted rubbish')
    assert(maps.pngSize(makeTinyPng(7, 9)).width === 7, 'pngSize read the wrong width')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return 'missing terrain, mismatched sizes, non-PNG and missing file all refused'
})
```

and add this helper beside the other test helpers near the top of `tools/selftest.js`, after the `assert` definition:

```js
/**
 * A minimal but structurally valid PNG, so map tests need no image library.
 * Only the signature and the IHDR matter here - the loader reads dimensions
 * from IHDR and never decodes the pixels.
 */
function makeTinyPng(width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4)
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr[16] = 8    // bit depth
  ihdr[17] = 6    // colour type: RGBA
  return Buffer.concat([sig, ihdr])
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep -E "becomes a .custommap|refused with a reason"`
Expected: two FAIL lines, `Cannot find module '../src/mods/custom-maps'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/mods/custom-maps.js`:

```js
'use strict'
/**
 * Map mods, and the pipeline Sandustry already had.
 *
 * The loader used to read a map mod's blueprints and then drop them, on the
 * grounds that loading needed game-side support that was not exposed. It is
 * exposed: `preload.js` offers customMaps save/load/list/delete, the handlers
 * are registered outside the MODDING_ENABLED branch, and the renderer builds a
 * world from six PNG layers named terrain, lights, lightsMeta, sensors,
 * authorization and wall. A `.custommap` is that JSON, and the game lists the
 * folder itself.
 *
 * So this module does the one thing that was missing: turn a mod's PNGs into
 * that file, and put it where the game looks.
 */

const fs = require('fs')
const path = require('path')

/** The six fields the renderer reads, in the order it reads them. */
const LAYERS = ['terrain', 'lights', 'lightsMeta', 'sensors', 'authorization', 'wall']

/** Without terrain there is no world; the rest may be blank. */
const REQUIRED_LAYERS = ['terrain']

/** Everything this module writes starts here, and only these may be removed. */
const PREFIX = 'smln.'
const EXT = '.custommap'

/**
 * Width and height from a PNG's IHDR, or null if it is not a PNG.
 *
 * Reading the header by hand keeps the dependency list empty. Nothing here
 * decodes pixels - the game does that, and the only thing worth checking
 * before handing it a file is that the layers describe the same world.
 */
function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < signature.length; i++) {
    if (buffer[i] !== signature[i]) return null
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/**
 * Build the document the game reads, from a mod's blueprints.
 *
 * @param {{modId:string, name?:string, seed?:string, params?:object,
 *          blueprints:Record<string,string>}} mapSpec
 * @returns {{ok:true, id:string, file:string, doc:object}|{ok:false, reason:string}}
 */
function assemble(mapSpec) {
  const spec = mapSpec || {}
  const modId = String(spec.modId || '').trim()
  if (!modId) return { ok: false, reason: 'the map has no mod id' }
  const blueprints = spec.blueprints || {}

  for (const required of REQUIRED_LAYERS) {
    if (!blueprints[required]) {
      return { ok: false, reason: `no "${required}" blueprint - a map needs one` }
    }
  }

  const doc = {}
  let size = null
  for (const layer of LAYERS) {
    const file = blueprints[layer]
    if (!file) { doc[layer] = null; continue }

    let buffer
    try {
      buffer = fs.readFileSync(file)
    } catch (e) {
      return { ok: false, reason: `${layer}: ${(e && e.message) || 'could not be read'}` }
    }

    const dims = pngSize(buffer)
    if (!dims) return { ok: false, reason: `${layer}: ${path.basename(file)} is not a PNG` }
    if (!size) size = dims
    else if (dims.width !== size.width || dims.height !== size.height) {
      return {
        ok: false,
        reason: `${layer} is ${dims.width}x${dims.height} but terrain is ` +
          `${size.width}x${size.height}; every layer describes the same world`,
      }
    }

    doc[layer] = 'data:image/png;base64,' + buffer.toString('base64')
  }

  // The id doubles as the file name and as what the game shows and boots with,
  // so the mod is visible in the browser and two mods cannot collide. One mod
  // yields one map: a .custommap carries all six layers at once.
  const id = PREFIX + modId

  doc.id = id
  doc.name = typeof spec.name === 'string' && spec.name ? spec.name : modId
  doc.seed = typeof spec.seed === 'string' ? spec.seed : ''
  doc.params = spec.params && typeof spec.params === 'object'
    ? spec.params
    : { width: size.width, height: size.height }
  doc.version = 1
  doc.createdAt = new Date().toISOString()

  return { ok: true, id, file: id + EXT, doc }
}

module.exports = { assemble, pngSize, LAYERS, REQUIRED_LAYERS, PREFIX, EXT }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/selftest.js 2>&1 | grep -E "becomes a .custommap|refused with a reason"`
Expected: two PASS lines.

- [ ] **Step 5: Commit**

```bash
git add src/mods/custom-maps.js tools/selftest.js
git commit -m "Turn a map mod's blueprints into the file the game already reads"
```

---

### Task 2: Install the maps, and prune only our own

**Files:**
- Modify: `src/mods/custom-maps.js`
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: `assemble`, `PREFIX`, `EXT` from Task 1.
- Produces: `sync(mapsDir, specs) -> {installed:string[], removed:string[], failed:Array<{modId,reason}>}`. `specs` is the list of `mapSpec` objects for currently enabled map mods; anything previously written for a mod not in that list is removed.

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`:

```js
check('installing maps writes ours and never removes the player\'s', () => {
  const maps = require('../src/mods/custom-maps')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-mapsync-'))
  const mapsDir = path.join(root, 'custom_maps')
  const bp = path.join(root, 'bp')
  fs.mkdirSync(mapsDir, { recursive: true })
  fs.mkdirSync(bp, { recursive: true })
  try {
    fs.writeFileSync(path.join(bp, 'terrain.png'), makeTinyPng(2, 2))
    const spec = (modId) => ({ modId, blueprints: { terrain: path.join(bp, 'terrain.png') } })

    // Files that are not ours, including one deliberately close to our prefix.
    fs.writeFileSync(path.join(mapsDir, 'my-world.custommap'), '{}')
    fs.writeFileSync(path.join(mapsDir, 'smlnx.not-ours.custommap'), '{}')

    const first = maps.sync(mapsDir, [spec('alpha'), spec('beta')])
    assert(first.installed.length === 2, 'expected two installs, got ' + first.installed.length)
    assert(fs.existsSync(path.join(mapsDir, 'smln.alpha.custommap')), 'alpha was not written')
    const written = JSON.parse(fs.readFileSync(path.join(mapsDir, 'smln.beta.custommap'), 'utf8'))
    assert(/^data:image\/png;base64,/.test(written.terrain), 'the written file has no terrain layer')

    // beta is gone now: its map goes, alpha stays, the player's files stay.
    const second = maps.sync(mapsDir, [spec('alpha')])
    assert(second.removed.length === 1 && /beta/.test(second.removed[0]),
      'beta was not pruned: ' + JSON.stringify(second.removed))
    assert(fs.existsSync(path.join(mapsDir, 'smln.alpha.custommap')), 'alpha was pruned too')
    assert(fs.existsSync(path.join(mapsDir, 'my-world.custommap')), "the player's map was deleted")
    assert(fs.existsSync(path.join(mapsDir, 'smlnx.not-ours.custommap')),
      'a file that merely looks like ours was deleted')

    // A bad spec is reported and does not stop the good one.
    const third = maps.sync(mapsDir, [spec('alpha'), { modId: 'broken', blueprints: {} }])
    assert(third.failed.length === 1 && third.failed[0].modId === 'broken',
      'the broken map was not reported: ' + JSON.stringify(third.failed))
    assert(third.installed.length === 1, 'the good map did not install alongside the bad one')

    // With nothing enabled, everything of ours goes and nothing else does.
    const fourth = maps.sync(mapsDir, [])
    assert(fourth.removed.length === 1, 'the last of ours was not pruned')
    const left = fs.readdirSync(mapsDir).sort()
    assert(left.join(',') === 'my-world.custommap,smlnx.not-ours.custommap',
      'the folder was left as: ' + left.join(','))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  return 'installed, pruned by owner, and the player\'s files untouched throughout'
})

check('sync creates the maps folder when the game has not yet', () => {
  const maps = require('../src/mods/custom-maps')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-mapdir-'))
  try {
    const mapsDir = path.join(root, 'custom_maps')
    const bp = path.join(root, 'terrain.png')
    fs.writeFileSync(bp, makeTinyPng(2, 2))
    const out = maps.sync(mapsDir, [{ modId: 'alpha', blueprints: { terrain: bp } }])
    assert(out.installed.length === 1, 'nothing installed into a fresh folder')
    assert(fs.existsSync(path.join(mapsDir, 'smln.alpha.custommap')), 'the file is missing')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  return 'a missing custom_maps folder is created rather than an error'
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep -E "installing maps writes ours|creates the maps folder"`
Expected: two FAIL lines, `maps.sync is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/mods/custom-maps.js`, above `module.exports`:

```js
/** Is this a file this module wrote? Nothing else may ever be deleted. */
function ours(fileName) {
  return fileName.indexOf(PREFIX) === 0 && fileName.slice(-EXT.length) === EXT
}

/**
 * Bring the folder in line with the map mods that are enabled right now.
 *
 * Writes each one's map, and removes the maps of mods that are no longer here.
 * The player's own files are not ours to touch, so the only things considered
 * for removal are names this module could have produced - checked by prefix and
 * extension, not by guessing.
 *
 * @param {string} mapsDir  `<userData>/custom_maps`
 * @param {Array<object>} specs  one mapSpec per enabled map mod
 */
function sync(mapsDir, specs) {
  const installed = []
  const removed = []
  const failed = []
  const keep = Object.create(null)

  try {
    fs.mkdirSync(mapsDir, { recursive: true })
  } catch (e) {
    return { installed, removed, failed: [{ modId: null, reason: 'could not create ' + mapsDir + ': ' + e.message }] }
  }

  for (const spec of specs || []) {
    const built = assemble(spec)
    if (!built.ok) {
      failed.push({ modId: (spec && spec.modId) || null, reason: built.reason })
      continue
    }
    try {
      fs.writeFileSync(path.join(mapsDir, built.file), JSON.stringify(built.doc))
      keep[built.file] = true
      installed.push(built.file)
    } catch (e) {
      failed.push({ modId: spec.modId, reason: 'could not write ' + built.file + ': ' + e.message })
    }
  }

  let entries = []
  try { entries = fs.readdirSync(mapsDir) } catch (_e) { entries = [] }
  for (const name of entries) {
    if (!ours(name) || keep[name]) continue
    try {
      fs.rmSync(path.join(mapsDir, name), { force: true })
      removed.push(name)
    } catch (_e) { /* a map we cannot remove is not worth failing the load over */ }
  }

  return { installed, removed, failed }
}
```

and extend the export line:

```js
module.exports = { assemble, sync, pngSize, LAYERS, REQUIRED_LAYERS, PREFIX, EXT }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/selftest.js 2>&1 | grep -E "installing maps writes ours|creates the maps folder"`
Expected: two PASS lines.

- [ ] **Step 5: Commit**

```bash
git add src/mods/custom-maps.js tools/selftest.js
git commit -m "Install a mod's maps, and remove only the ones we wrote"
```

---

### Task 3: Unlock the game's own map browser

**Files:**
- Modify: `src/patch/core-patches.js` (append to `corePatches`)
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: nothing.
- Produces: a patch with id `smln:unlock-custom-maps-screen` in `corePatches`.

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`:

```js
check('the custom maps browser is unlocked, and only that flag is touched', () => {
  const patch = corePatches.find((p) => p.id === 'smln:unlock-custom-maps-screen')
  assert(patch, 'the unlock patch is missing')
  assert(patch.required === false,
    'the unlock patch must not be required - losing a screen may not cost the game')

  const out = engine.apply(bundle, [patch])
  assert(out.outcomes[0].status === 'applied',
    'did not match the shipped bundle: ' + (out.outcomes[0].reason || out.outcomes[0].status))
  assert(out.outcomes[0].matches === 1, 'expected exactly 1 match, got ' + out.outcomes[0].matches)
  assert(/customMaps:\{showCustomMaps:!0\}/.test(out.source), 'the flag was not turned on')

  // The sibling flag governs the mods screen and is none of our business.
  assert(/mods:\{showSubscribedMods:!1\}/.test(out.source),
    'the neighbouring mods-screen flag was changed too')
  new vm.Script(out.source, { filename: 'bundle.js' })
  return 'one flag flipped, its neighbour untouched, bundle still parses'
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep "custom maps browser is unlocked"`
Expected: FAIL — `the unlock patch is missing`.

- [ ] **Step 3: Write minimal implementation**

In `src/patch/core-patches.js`, add a new entry at the end of the `corePatches` array:

```js
  {
    id: 'smln:unlock-custom-maps-screen',
    owner: 'smln',
    description: "Show Sandustry's own custom maps browser, which ships switched off",
    anchorLiteral: 'showCustomMaps',
    /*
     * The screen is finished - CustomMapsScreen in the UI enum, 42 references,
     * its own localisation down to "No custom maps saved." - and hidden behind
     * a boolean compiled into the bundle:
     *
     *   mods:{showSubscribedMods:!1},customMaps:{showCustomMaps:!1},procgen:{...}
     *
     * Only this one is flipped. The neighbouring flag governs the mods screen,
     * which SandLoader has its own UI for and no business overriding.
     */
    find: /customMaps:\{showCustomMaps:!1\}/g,
    replace: () => 'customMaps:{showCustomMaps:!0}',
    expect: 1,
    // A build that reshapes the config costs the browser screen, nothing more.
    required: false,
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/selftest.js 2>&1 | grep "custom maps browser is unlocked"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/patch/core-patches.js tools/selftest.js
git commit -m "Show the custom maps browser Sandustry ships switched off"
```

---

### Task 4: Wire it into the loader

**Files:**
- Modify: `src/main/entry.js` (the refusal at line 1226, and one call site after the mod loop)
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: `sync` from Task 2.
- Produces: map mods install their maps on every load; failures are reported through `note`.

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`:

```js
check('the loader installs map mods instead of refusing them', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'entry.js'), 'utf8')
  assert(!/map blueprints need game-side support and are not loaded yet/.test(src),
    'entry.js still refuses map mods with a reason that is no longer true')
  assert(/require\('\.\.\/mods\/custom-maps'\)|customMaps\.sync\(/.test(src),
    'entry.js never calls the map installer')
  assert(/custom_maps/.test(src), 'entry.js does not name the folder the game reads')
  return 'the refusal is gone and the installer is wired in'
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep "installs map mods instead of refusing"`
Expected: FAIL — the refusal string is still there.

- [ ] **Step 3: Write minimal implementation**

In `src/main/entry.js`, add the require beside the other `src/mods` requires:

```js
const customMaps = require('../mods/custom-maps')
```

Replace the refusal at lines 1226-1228:

```js
        if (mod.map) {
          logger.warn(`${mod.id} is a map mod; map blueprints need game-side support and are not loaded yet`)
        }
```

with a collection step, since the install happens once for all of them:

```js
        if (mod.map) {
          mapSpecs.push({
            modId: mod.id,
            name: mod.name,
            seed: mod.map.seed,
            params: mod.map.params,
            blueprints: mod.map.blueprints || {},
          })
        }
```

Declare `mapSpecs` beside the other per-assemble collections at the top of `assemble()`:

```js
  /* Map mods, installed together after the loop so pruning sees the full set. */
  const mapSpecs = []
```

And after the official-mod loop that contained the refusal, install them:

```js
  /*
   * Map mods, at last.
   *
   * The blueprints were always read and always dropped, because "loading them
   * needs game-side support that is not exposed". It is exposed: the game lists
   * <userData>/custom_maps itself, loads a .custommap by id and starts it by
   * navigating to custom_map=<id>. So the maps are written there, and the ones
   * belonging to mods that are gone are removed - only ever the files this
   * loader wrote.
   */
  // `hostPaths` is already bound at the top of assemble(), the same value
  // modRoots() is given.
  if (hostPaths && hostPaths.userData) {
    const mapsDir = path.join(hostPaths.userData, 'custom_maps')
    const outcome = customMaps.sync(mapsDir, mapSpecs)
    for (const bad of outcome.failed) {
      note(new SmlnError('E_MOD_LOAD', `map mod "${bad.modId}": ${bad.reason}`,
        { detail: { mod: bad.modId } }), 'map', bad.modId, 'warn')
    }
    if (outcome.installed.length || outcome.removed.length) {
      logger.info(`custom maps: ${outcome.installed.length} installed, ` +
        `${outcome.removed.length} removed (${mapsDir})`)
    }
  } else if (mapSpecs.length) {
    logger.warn('map mods found but the host gave no userData path, so there is nowhere to install them')
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/selftest.js > /tmp/m4.txt 2>&1; grep "installs map mods instead of refusing" /tmp/m4.txt; grep -E "passed, .* failed" /tmp/m4.txt`
Expected: PASS; summary **202 passed, 3 failed**.

- [ ] **Step 5: Commit**

```bash
git add src/main/entry.js tools/selftest.js
git commit -m "Install map mods rather than reporting them as impossible"
```

---

### Task 5: Retire the limitation

**Files:**
- Modify: `README.md` (the `Map mods.` bullet, around line 831)
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`:

```js
check('the README stops calling map loading unavailable', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')
  assert(!/loading\s+them needs game-side support that is not exposed/.test(readme),
    'the README still says map loading needs support that is not exposed')
  assert(/custom_maps/.test(readme), 'the README does not say where maps go')
  assert(/browser|Custom Maps/i.test(readme), "the README does not mention the game's map browser")
  return 'map mods documented as working'
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep "stops calling map loading unavailable"`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

In `README.md`, replace the `- **Map mods.** …` bullet with:

```markdown
- **Map mods work, through the game's own pipeline.** A map mod's blueprint
  PNGs are assembled into a `.custommap` — the six layers Sandustry reads:
  terrain, lights, lightsMeta, sensors, authorization and wall — and written to
  `custom_maps` in your user data, where the game lists them itself. SandLoader
  also switches on Sandustry's Custom Maps browser, which ships finished but
  hidden. Maps belonging to a mod you removed are cleaned up; a map you made
  yourself is never touched, because only files SandLoader wrote are ever
  deleted.
```

- [ ] **Step 4: Run the whole suite**

Run: `node tools/selftest.js > /tmp/m5.txt 2>&1; grep "stops calling map loading" /tmp/m5.txt; grep -E "passed, .* failed" /tmp/m5.txt; sed -n '/Failures:/,$p' /tmp/m5.txt`
Expected: PASS; **203 passed, 3 failed**, and the three are the two host-ABI checks and `player.inventory.addFromId`.

- [ ] **Step 5: Commit**

```bash
git add README.md tools/selftest.js
git commit -m "Say that map mods load, because now they do"
```

---

## Final verification

- [ ] Run: `node tools/selftest.js 2>&1 | tail -8`
  Expected: **203 passed, 3 failed**, the three being the known out-of-scope ones.
- [ ] Run: `node tools/e2e-attach.js --run`
  Expected: `PASSED`.
- [ ] Confirm `git status` shows no stray files.
