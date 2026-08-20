# Fluxloader Content Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Fluxloader mods register real content on Sandustry 0.5.5 by translating corelib's registration calls onto the game's native Sandkit API, without modifying any mod or corelib.

**Architecture:** A new `src/compat/flux-content.js` intercepts corelib's content modules after its electron entrypoint runs, captures registration calls instead of letting them queue stale patches, translates each definition into 0.5.5 shape, and ships them to the renderer over the existing Fluxloader IPC bridge where `SMLN.register` hands them to Sandkit. Patches for subsystems the bridge takes over are dropped; every other corelib patch is left untouched.

**Tech Stack:** Node.js (CommonJS, no build step, no new dependencies), Electron 33 main process + Chromium renderer, existing `tools/selftest.js` harness (`check()` / `assert()`), `mcp__sandustry__*` tools for live verification.

**Spec:** `docs/superpowers/specs/2026-08-20-fluxloader-content-bridge-design.md`

## Global Constraints

- **No modification of mods or corelib.** The bridge must work against corelib 3.1.3 exactly as shipped. Mod directories are read-only.
- **No new dependencies.** The project has none beyond Node builtins; keep it that way.
- **Style:** CommonJS, 2-space indent, no semicolons at statement ends, single quotes, `'use strict'` at the top of every module. Match the surrounding files.
- **Comments explain WHY, not what.** Follow the existing tone in `src/compat/fluxloader.js`: full sentences, explaining the failure a piece of code prevents.
- **Nothing silently no-ops.** Every unsupported path must report through the problems channel with a reason. This is the project's stated policy and the whole point of this work.
- **Game version:** Sandustry 0.5.5. Matter types are read from the live enum at runtime, never hard-coded into behaviour.
- **Tests:** `node tools/selftest.js` must end `0 failed`. Tests live in `tools/selftest.js` using the existing `check(name, fn)` / `assert(cond, msg)` harness. A test must fail before its implementation exists.
- **Verified live values** (from the running game, use these exactly):
  - MatterType enum is bidirectional: `Solid:1, Liquid:2, Particle:3, Gas:4, Static:5, Slushy:6, Wisp:7, Powder:8`
  - Registry entry shape: `{nameKey:"elements|sand|name", density:150, matterType:1, metaColor:16032864}`
  - `sandkit` namespaces with registration: `elements.register`, `terrains.register`, `matters.register`, `items.register`, `structures.register`, `upgrades.register`, `tech.addDefinition`, `i18n.register`
  - **No recipe registry exists** anywhere in 0.5.5.

---

### Task 1: Matter-type and name translation

**Files:**
- Create: `src/compat/flux-translate.js`
- Test: `tools/selftest.js` (append to the fluxloader compat section, after the check named `'fluxloader target aliases normalise'`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `matterTypeToNumber(name, enumTable)` -> `{ok:true, value:number}` | `{ok:false, reason:string}`
  - `nameKeyFor(id)` -> `string` (e.g. `'Trash'` -> `'elements|trash|name'`)
  - `rgbaToMetaColor([r,g,b,a])` -> `{ok:true, value:number}` | `{ok:false, reason:string}`
  - `hslToRgba([h,s,l])` -> `{ok:true, value:[r,g,b,a]}` | `{ok:false, reason:string}`

- [ ] **Step 1: Write the failing tests**

Append to `tools/selftest.js` immediately after the `'fluxloader target aliases normalise'` check:

```js
// --------------------------------------------- fluxloader content translation
const flTranslate = require('../src/compat/flux-translate')

/** The live 0.5.5 MatterType enum, both directions, as the game exposes it. */
const LIVE_MATTER = {
  1: 'Solid', 2: 'Liquid', 3: 'Particle', 4: 'Gas',
  5: 'Static', 6: 'Slushy', 7: 'Wisp', 8: 'Powder',
  Solid: 1, Liquid: 2, Particle: 3, Gas: 4,
  Static: 5, Slushy: 6, Wisp: 7, Powder: 8,
}

check('matter type names map to the live numeric ids', () => {
  const r = flTranslate.matterTypeToNumber('Slushy', LIVE_MATTER)
  assert(r.ok, 'Slushy was rejected: ' + (r.ok ? '' : r.reason))
  assert(r.value === 6, 'Slushy mapped to ' + r.value + ', not 6')
  assert(flTranslate.matterTypeToNumber('Solid', LIVE_MATTER).value === 1, 'Solid is not 1')
  return 'Slushy -> 6, Solid -> 1'
})

check('an unmappable matter type is reported, never defaulted', () => {
  // Silently coercing to Solid would put the element in the wrong physics
  // class, which is far worse than refusing it with a reason.
  const r = flTranslate.matterTypeToNumber('Plasma', LIVE_MATTER)
  assert(!r.ok, 'an unknown matter type was accepted')
  assert(/Plasma/.test(r.reason), 'the reason does not name the bad value: ' + r.reason)
  assert(/Solid/.test(r.reason), 'the reason does not list the valid names: ' + r.reason)
  return r.reason
})

check('element name becomes the localisation key the build expects', () => {
  // 0.5.5 entries carry nameKey, not name: {nameKey:"elements|sand|name"}.
  assert(flTranslate.nameKeyFor('Trash') === 'elements|trash|name',
    'wrong key: ' + flTranslate.nameKeyFor('Trash'))
  assert(flTranslate.nameKeyFor('CompressedTrash') === 'elements|compressedTrash|name',
    'camelCase id was not preserved: ' + flTranslate.nameKeyFor('CompressedTrash'))
  return 'Trash -> elements|trash|name'
})

check('rgba colours convert to the packed metaColor integer', () => {
  const r = flTranslate.rgbaToMetaColor([88, 74, 74, 255])
  assert(r.ok, 'rejected: ' + (r.ok ? '' : r.reason))
  assert(r.value === (88 << 16) + (74 << 8) + 74, 'wrong packing: ' + r.value)
  const bad = flTranslate.rgbaToMetaColor([88, 74])
  assert(!bad.ok, 'a two-element colour was accepted')
  return 'rgba packed to ' + r.value
})

check('soil colorHSL converts to rgba', () => {
  const r = flTranslate.hslToRgba([306, 6, 37])
  assert(r.ok, 'rejected: ' + (r.ok ? '' : r.reason))
  assert(r.value.length === 4, 'expected 4 channels, got ' + r.value.length)
  assert(r.value.every((c) => c >= 0 && c <= 255), 'channel out of range: ' + r.value.join(','))
  assert(r.value[3] === 255, 'alpha should default to opaque, got ' + r.value[3])
  return 'hsl(306,6,37) -> rgba(' + r.value.join(',') + ')'
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tools/selftest.js 2>&1 | grep -E "matter type|localisation key|metaColor|colorHSL"`
Expected: every one FAILs with `Cannot find module '../src/compat/flux-translate'`.

- [ ] **Step 3: Write the implementation**

Create `src/compat/flux-translate.js`:

```js
'use strict'
/**
 * Value translation between the Fluxloader mod format and Sandustry 0.5.5.
 *
 * corelib was written against a build that spelled an element
 * `{name:"Cinder", matterType:X.Slushy}`. 0.5.5 spells the same entry
 * `{nameKey:"elements|basalt|name", matterType:6}` - a localisation key and a
 * plain number. These functions convert one to the other.
 *
 * Every function returns {ok, value} | {ok:false, reason} rather than throwing
 * or falling back to a default. A wrong matterType puts an element in the
 * wrong physics class, where it behaves subtly incorrectly forever; a refused
 * registration with a reason is recoverable.
 */

/**
 * Map a Fluxloader matter type name onto this build's numeric id.
 * @param {string} name       e.g. "Slushy"
 * @param {object} enumTable  the live bidirectional MatterType enum
 */
function matterTypeToNumber(name, enumTable) {
  const table = enumTable || {}
  if (typeof name !== 'string' || !name) {
    return { ok: false, reason: 'matterType must be a string, got ' + typeof name }
  }
  const value = table[name]
  if (typeof value === 'number') return { ok: true, value }

  // Name the valid options: the author's next action is picking one.
  const valid = Object.keys(table).filter((k) => typeof table[k] === 'number')
  return {
    ok: false,
    reason: `matterType "${name}" does not exist on this game build ` +
      `(valid: ${valid.join(', ')})`,
  }
}

/**
 * The localisation key 0.5.5 stores instead of a display name. The game
 * derives this same key from a `name` when one is passed to its own register,
 * so the two spellings agree.
 */
function nameKeyFor(id) {
  const s = String(id || '')
  return 'elements|' + (s.charAt(0).toLowerCase() + s.slice(1)) + '|name'
}

/** Pack [r,g,b,a] into the 24-bit integer the registry stores as metaColor. */
function rgbaToMetaColor(rgba) {
  if (!Array.isArray(rgba) || rgba.length < 3) {
    return { ok: false, reason: 'a colour needs at least [r, g, b]' }
  }
  const [r, g, b] = rgba
  if (![r, g, b].every((c) => typeof c === 'number' && c >= 0 && c <= 255)) {
    return { ok: false, reason: `colour channels must be 0-255, got [${rgba.join(', ')}]` }
  }
  return { ok: true, value: (Math.round(r) << 16) + (Math.round(g) << 8) + Math.round(b) }
}

/**
 * corelib declares soil colours as HSL with s/l given in percent, which is
 * what its own `colorHSL` field means. Elements everywhere else are RGBA.
 */
function hslToRgba(hsl) {
  if (!Array.isArray(hsl) || hsl.length < 3) {
    return { ok: false, reason: 'colorHSL needs [h, s, l]' }
  }
  const [h, s, l] = hsl
  if (![h, s, l].every((n) => typeof n === 'number')) {
    return { ok: false, reason: `colorHSL must be numbers, got [${hsl.join(', ')}]` }
  }
  const sN = s / 100
  const lN = l / 100
  const c = (1 - Math.abs(2 * lN - 1)) * sN
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const m = lN - c / 2
  let rgb
  if (hp < 1) rgb = [c, x, 0]
  else if (hp < 2) rgb = [x, c, 0]
  else if (hp < 3) rgb = [0, c, x]
  else if (hp < 4) rgb = [0, x, c]
  else if (hp < 5) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return { ok: true, value: rgb.map((v) => Math.round((v + m) * 255)).concat(255) }
}

module.exports = { matterTypeToNumber, nameKeyFor, rgbaToMetaColor, hslToRgba }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tools/selftest.js 2>&1 | tail -3`
Expected: `0 failed`, and the total count has risen by 5.

---

### Task 2: Element and soil definition translation

**Files:**
- Modify: `src/compat/flux-translate.js`
- Test: `tools/selftest.js` (append after Task 1's checks)

**Interfaces:**
- Consumes: `matterTypeToNumber`, `nameKeyFor`, `rgbaToMetaColor`, `hslToRgba` from Task 1.
- Produces:
  - `translateElement(config, enumTable)` -> `{ok:true, def:object}` | `{ok:false, reason:string}`
  - `translateSoil(config, enumTable)` -> `{ok:true, def:object}` | `{ok:false, reason:string}`

  The produced `def` is what `SMLN.register.element` / `.terrain` receives, so it
  carries `id`, `name`, `nameKey`, `density`, `matterType` (number), `colors`
  (RGBA array, passed through for Sandkit to install into the scheme) and
  `metaColor`.

- [ ] **Step 1: Write the failing tests**

Append to `tools/selftest.js` after the `'soil colorHSL converts to rgba'` check:

```js
check('a corelib element definition translates to a 0.5.5 definition', () => {
  // This is trashelement's real first registration, copied from its source.
  const r = flTranslate.translateElement({
    id: 'Trash',
    name: 'Trash',
    colors: [[88, 74, 74, 255], [108, 74, 74, 255]],
    density: 150,
    interactsWithHoverText: ['⬇️'],
    matterType: 'Slushy',
    addToFilterList: true,
  }, LIVE_MATTER)
  assert(r.ok, 'rejected: ' + (r.ok ? '' : r.reason))
  assert(r.def.id === 'Trash', 'id lost')
  assert(r.def.matterType === 6, 'matterType is ' + r.def.matterType + ', not the numeric 6')
  assert(r.def.nameKey === 'elements|trash|name', 'nameKey is ' + r.def.nameKey)
  assert(typeof r.def.metaColor === 'number', 'metaColor is not a number')
  assert(Array.isArray(r.def.colors) && r.def.colors.length === 2, 'colours were dropped')
  return 'Trash -> matterType 6, ' + r.def.nameKey
})

check('an element with a bad matter type is refused with a reason', () => {
  const r = flTranslate.translateElement({
    id: 'Weird', name: 'Weird', colors: [[1, 2, 3, 255]], density: 10, matterType: 'Plasma',
  }, LIVE_MATTER)
  assert(!r.ok, 'a bad matterType was accepted')
  assert(/Plasma/.test(r.reason), 'reason does not name the value: ' + r.reason)
  return r.reason
})

check('an element without an id is refused', () => {
  const r = flTranslate.translateElement({ name: 'No Id', density: 1 }, LIVE_MATTER)
  assert(!r.ok, 'an element with no id was accepted')
  assert(/id/.test(r.reason), 'reason does not mention the id: ' + r.reason)
  return r.reason
})

check('a corelib soil definition translates, including its HSL colour', () => {
  // trashelement's real soil registration.
  const r = flTranslate.translateSoil({
    id: 'TrashSoil',
    name: 'Trashsoil',
    hp: 3,
    interactsWithHoverText: ['🔨💥'],
    chanceForOutput: 0.7,
    outputElement: 'Trash',
    colorHSL: [306, 6, 37],
    onlyRocketBreakable: false,
  }, LIVE_MATTER)
  assert(r.ok, 'rejected: ' + (r.ok ? '' : r.reason))
  assert(r.def.id === 'TrashSoil', 'id lost')
  assert(Array.isArray(r.def.colors) && r.def.colors[0].length === 4,
    'colorHSL was not converted to rgba')
  assert(r.def.hp === 3, 'hp lost')
  assert(r.def.outputElement === 'Trash', 'outputElement lost')
  return 'TrashSoil -> rgba(' + r.def.colors[0].join(',') + ')'
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tools/selftest.js 2>&1 | grep -E "translates to a 0.5.5|bad matter type is refused|without an id|soil definition translates"`
Expected: all FAIL with `flTranslate.translateElement is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `src/compat/flux-translate.js`, before `module.exports`:

```js
/**
 * Convert one `corelib.elements.registerElement(config)` argument into the
 * definition `SMLN.register.element` expects.
 *
 * `colors` is passed through rather than consumed: Sandkit's own
 * `elements.register` installs `def.colors` into the session colour scheme, so
 * converting them here would do the work twice and disagree with the built-ins.
 */
function translateElement(config, enumTable) {
  const c = config || {}
  if (!c.id || typeof c.id !== 'string') {
    return { ok: false, reason: 'an element needs a string "id"' }
  }

  const matter = matterTypeToNumber(c.matterType == null ? 'Solid' : c.matterType, enumTable)
  if (!matter.ok) return { ok: false, reason: `element "${c.id}": ${matter.reason}` }

  const colors = Array.isArray(c.colors) ? c.colors : []
  const def = {
    id: c.id,
    // Passing `name` lets the game register the English fallback itself; the
    // explicit nameKey keeps the entry readable if it ever inspects it first.
    name: c.name || c.id,
    nameKey: nameKeyFor(c.id),
    density: typeof c.density === 'number' ? c.density : 100,
    matterType: matter.value,
    colors,
  }

  if (colors.length) {
    const meta = rgbaToMetaColor(colors[0])
    if (!meta.ok) return { ok: false, reason: `element "${c.id}": ${meta.reason}` }
    def.metaColor = meta.value
  }
  if (Array.isArray(c.interactsWithHoverText)) def.interactions = c.interactsWithHoverText
  if (c.addToFilterList !== undefined) def.addToFilterList = !!c.addToFilterList

  return { ok: true, def }
}

/**
 * Convert `corelib.elements.registerSoil(config)`. Soils are mineable terrain
 * that drops an element, so the output fields travel with the definition.
 */
function translateSoil(config, enumTable) {
  const c = config || {}
  if (!c.id || typeof c.id !== 'string') {
    return { ok: false, reason: 'a soil needs a string "id"' }
  }

  const def = {
    id: c.id,
    name: c.name || c.id,
    nameKey: nameKeyFor(c.id),
    hp: typeof c.hp === 'number' ? c.hp : 1,
    onlyRocketBreakable: !!c.onlyRocketBreakable,
  }

  if (Array.isArray(c.colorHSL)) {
    const rgba = hslToRgba(c.colorHSL)
    if (!rgba.ok) return { ok: false, reason: `soil "${c.id}": ${rgba.reason}` }
    def.colors = [rgba.value]
    const meta = rgbaToMetaColor(rgba.value)
    if (meta.ok) def.metaColor = meta.value
  } else if (Array.isArray(c.colors)) {
    def.colors = c.colors
  }

  if (c.outputElement) def.outputElement = c.outputElement
  if (typeof c.chanceForOutput === 'number') def.chanceForOutput = c.chanceForOutput
  if (Array.isArray(c.interactsWithHoverText)) def.interactions = c.interactsWithHoverText

  return { ok: true, def }
}
```

Update the export line to:

```js
module.exports = {
  matterTypeToNumber, nameKeyFor, rgbaToMetaColor, hslToRgba,
  translateElement, translateSoil,
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tools/selftest.js 2>&1 | tail -3`
Expected: `0 failed`, total up by 4 from Task 1.

---

### Task 3: The capture shim

**Files:**
- Create: `src/compat/flux-content.js`
- Test: `tools/selftest.js` (append after Task 2's checks)

**Interfaces:**
- Consumes: `translateElement`, `translateSoil` from Task 2.
- Produces:
  - `SUPPRESSED_PREFIXES` -> `string[]` — corelib patch-id fragments the bridge takes over.
  - `install(sandboxGlobal, opts)` -> `{ok:boolean, captured:object, reasons:string[]}`
    where `opts` is `{modId, logger, matterEnum}`. Replaces the content modules
    on `sandboxGlobal.corelib` in place. `captured` is
    `{elements:[], soils:[], unsupported:[{kind, id, reason}]}`.
  - `shouldSuppress(patchId)` -> `boolean`

- [ ] **Step 1: Write the failing tests**

Append to `tools/selftest.js`:

```js
const flContent = require('../src/compat/flux-content')

/** A stand-in for the corelib object an entrypoint publishes. */
function fakeCorelib() {
  return {
    elements: {
      registerElement(c) { this._e = (this._e || []).concat([c]); return true },
      registerSoil(c) { this._s = (this._s || []).concat([c]); return true },
    },
    recipes: {
      registerPressRecipe() { return true },
      registerShakerRecipe() { return true },
    },
  }
}

check('the bridge captures element registrations instead of patching', () => {
  const g = { corelib: fakeCorelib() }
  const r = flContent.install(g, { modId: 'corelib', logger: testLogger(), matterEnum: LIVE_MATTER })
  assert(r.ok, 'install failed')
  g.corelib.elements.registerElement({
    id: 'Trash', name: 'Trash', colors: [[88, 74, 74, 255]], density: 150, matterType: 'Slushy',
  })
  assert(r.captured.elements.length === 1, 'nothing captured')
  assert(r.captured.elements[0].def.matterType === 6, 'definition was not translated')
  return 'captured Trash with matterType 6'
})

check('a registration the build cannot support is recorded with its reason', () => {
  // 0.5.5 has no recipe registry at all. Reporting beats a silent no-op.
  const g = { corelib: fakeCorelib() }
  const r = flContent.install(g, { modId: 'corelib', logger: testLogger(), matterEnum: LIVE_MATTER })
  g.corelib.recipes.registerPressRecipe({ input: 'Trash', outputs: [['CompressedTrash', 0.65]] })
  assert(r.captured.unsupported.length === 1,
    'the recipe call was not recorded as unsupported')
  const u = r.captured.unsupported[0]
  assert(u.kind === 'recipe', 'wrong kind: ' + u.kind)
  assert(/no recipe registry/i.test(u.reason), 'reason is not explanatory: ' + u.reason)
  return u.reason
})

check('a bad definition is recorded, and never throws into the mod', () => {
  // corelib mods call these at entrypoint top level; throwing would take the
  // whole mod down instead of losing one element.
  const g = { corelib: fakeCorelib() }
  const r = flContent.install(g, { modId: 'corelib', logger: testLogger(), matterEnum: LIVE_MATTER })
  let threw = false
  try {
    g.corelib.elements.registerElement({ id: 'Bad', name: 'Bad', density: 1, matterType: 'Plasma' })
  } catch (_e) { threw = true }
  assert(!threw, 'a bad definition threw into the mod')
  assert(r.captured.unsupported.length === 1, 'the failure was not recorded')
  assert(/Plasma/.test(r.captured.unsupported[0].reason), 'reason lost the detail')
  return r.captured.unsupported[0].reason
})

check('only the patches the bridge takes over are suppressed', () => {
  // corelib has ~50 subsystems. Dropping more than the bridge replaces would
  // break the ones whose anchors still match this build.
  assert(flContent.shouldSuppress('corelib:corelib:elements:elementRegistry'),
    'an element patch was not suppressed')
  assert(flContent.shouldSuppress('corelib:corelib:elements:soilRegistry'),
    'a soil patch was not suppressed')
  assert(!flContent.shouldSuppress('corelib:corelib:colorIdFix:countdownFix'),
    'an unrelated patch was suppressed')
  assert(!flContent.shouldSuppress('corelib:corelib:blockInventory'),
    'a block patch was suppressed')
  return 'element and soil patches suppressed, others kept'
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tools/selftest.js 2>&1 | grep -E "captures element registrations|cannot support is recorded|never throws into the mod|taken over are suppressed"`
Expected: all FAIL with `Cannot find module '../src/compat/flux-content'`.

- [ ] **Step 3: Write the implementation**

Create `src/compat/flux-content.js`:

```js
'use strict'
/**
 * Routes Fluxloader content registration onto Sandustry 0.5.5's own API.
 *
 * corelib registers content by patching the game bundle. On 0.5.5 that no
 * longer works: 75 of its 92 patch anchors exist in no shipped file, because
 * the build stopped splitting into numbered chunks and the element registry
 * changed shape (`{name:"Cinder"}` became `{nameKey:"elements|basalt|name"}`
 * with a numeric matterType). Retargeting the patches would still emit entries
 * the game cannot read.
 *
 * It does not need patching. 0.5.5 ships a real registration API - Sandkit's
 * `elements.register`, `terrains.register`, `items.register`,
 * `structures.register` and friends - and SandLoader already wraps it as
 * `SMLN.register` with queuing, ownership and error isolation. So this module
 * replaces corelib's content modules with shims that capture the same calls,
 * translates each definition, and hands it to that layer instead.
 *
 * Runtime mutation of the registry object would not work: the simulation runs
 * across 18 worker threads, each with its own copy, and only the game's own
 * registration path reaches all of them.
 *
 * The mod's source is never touched, and neither is corelib's. Only the
 * objects it published are swapped, after it finished building them.
 */

const translate = require('./flux-translate')

/**
 * corelib patch ids the bridge now supplies through Sandkit. Only these are
 * dropped; every other corelib patch is left alone, so the subsystems whose
 * anchors still match this build keep working.
 */
const SUPPRESSED_PREFIXES = [
  'elements:elementRegistry',
  'elements:soilRegistry',
  'elements:filterlist',
  'elements:particleColors',
  'elements:soilsBreaksWithoutIt',
  'elements:soilsRepeated3Times',
  'elements:onlyRocketBreakable',
  'elements:noShovelHighlightForUnbreakable',
]

function shouldSuppress(patchId) {
  const id = String(patchId || '')
  return SUPPRESSED_PREFIXES.some((p) => id.includes(p))
}

/**
 * Swap corelib's content modules for capturing shims.
 *
 * @param {object} sandboxGlobal the shared mod global carrying `corelib`
 * @param {{modId:string, logger:any, matterEnum:object}} opts
 */
function install(sandboxGlobal, opts) {
  const o = opts || {}
  const log = o.logger
  const matterEnum = o.matterEnum || {}
  const corelib = sandboxGlobal && sandboxGlobal.corelib
  const captured = { elements: [], soils: [], unsupported: [] }
  const reasons = []

  if (!corelib || typeof corelib !== 'object') {
    return { ok: false, captured, reasons: ['no corelib global was published'] }
  }

  function note(kind, id, reason) {
    captured.unsupported.push({ kind, id, reason })
    log && log.warn(`${kind} "${id}" was not registered: ${reason}`)
  }

  if (corelib.elements && typeof corelib.elements === 'object') {
    // Keep the original object so anything else corelib hung on it survives;
    // only the two registration entry points are replaced.
    corelib.elements.registerElement = function registerElement(config) {
      const r = translate.translateElement(config, matterEnum)
      if (!r.ok) { note('element', (config && config.id) || '?', r.reason); return false }
      captured.elements.push({ id: r.def.id, def: r.def })
      log && log.debug(`captured element ${r.def.id}`)
      return true
    }
    corelib.elements.registerSoil = function registerSoil(config) {
      const r = translate.translateSoil(config, matterEnum)
      if (!r.ok) { note('soil', (config && config.id) || '?', r.reason); return false }
      captured.soils.push({ id: r.def.id, def: r.def })
      log && log.debug(`captured soil ${r.def.id}`)
      return true
    }
  } else {
    reasons.push('corelib published no elements module')
  }

  // Sandustry 0.5.5 has no recipe registry: `sandkit.structures.recipes` is
  // undefined, no namespace matches /recipe/i, and no module carries an
  // input/output shape. There is nothing to register into, so these are
  // recorded with the reason instead of pretending to work.
  const RECIPE_FNS = [
    'registerBasicRecipe', 'registerPressRecipe', 'registerShakerRecipe',
    'registerGrowerRecipe',
  ]
  if (corelib.recipes && typeof corelib.recipes === 'object') {
    for (const fn of RECIPE_FNS) {
      if (typeof corelib.recipes[fn] !== 'function') continue
      corelib.recipes[fn] = function suppressedRecipe(config) {
        const id = (config && (config.input || config.id)) || fn
        note('recipe', String(id),
          'this Sandustry build has no recipe registry, so recipes cannot be ' +
          'registered by any means (verified against 0.5.5)')
        return false
      }
    }
  }

  return { ok: true, captured, reasons }
}

module.exports = { install, shouldSuppress, SUPPRESSED_PREFIXES }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tools/selftest.js 2>&1 | tail -3`
Expected: `0 failed`, total up by 4 from Task 2.

---

### Task 4: Wire the shim into the loader

**Files:**
- Modify: `src/compat/fluxloader.js` (in `loadElectronEntrypoints`, at the `fl:pre-scene-loaded` emit added by the earlier fix, near line 542)
- Test: `tools/selftest.js` (append after Task 3's checks)

**Interfaces:**
- Consumes: `install`, `shouldSuppress` from Task 3.
- Produces: `loadElectronEntrypoints(mods, ctx, logger)` gains `content` on its
  return value: `{elements:[], soils:[], unsupported:[]}`. `ctx` gains an
  optional `matterEnum` (the live MatterType table; defaults to `{}`).

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`:

```js
check('corelib content is captured and its stale patches dropped', () => {
  // The end-to-end main-process behaviour: corelib and a dependent load, the
  // dependent's elements are captured for Sandkit, and the element patches
  // that no longer match this build do not reach the patch set.
  const coreDir = path.join(os.homedir(), 'AppData', 'Roaming', 'sandustry',
    'fluxloader-mods', 'corelib')
  const modDir = path.join(os.homedir(), 'AppData', 'Roaming', 'sandustry',
    'fluxloader-mods', 'trashelement')
  if (!fs.existsSync(coreDir) || !fs.existsSync(modDir)) return 'skipped - mods not installed'

  const core = flCompat.readMod(coreDir)
  const dep = flCompat.readMod(modDir)
  assert(core.ok && dep.ok, 'manifests rejected')

  const out = flCompat.loadElectronEntrypoints([core.mod, dep.mod], {
    configDir: coreDir,
    rpc: { register: () => {} },
    matterEnum: LIVE_MATTER,
  }, testLogger())
  assert(out.errors.length === 0, 'load failed: ' + (out.errors[0] && out.errors[0].message))

  const ids = out.content.elements.map((e) => e.id)
  assert(ids.includes('Trash'), 'Trash was not captured: [' + ids.join(', ') + ']')
  assert(ids.includes('CompressedTrash'), 'CompressedTrash was not captured')
  assert(out.content.soils.some((s) => s.id === 'TrashSoil'), 'TrashSoil was not captured')

  // The two recipe calls must be reported, not silently dropped.
  const recipes = out.content.unsupported.filter((u) => u.kind === 'recipe')
  assert(recipes.length >= 2, 'recipe calls were not reported: ' + recipes.length)

  // The stale element patches must not survive into the patch set.
  for (const list of Object.values(out.patches)) {
    for (const p of list) {
      assert(!flContent.shouldSuppress(p.id),
        'a superseded patch reached the patch set: ' + p.id)
    }
  }
  return `captured ${ids.length} element(s), ${out.content.soils.length} soil(s), ` +
    `${recipes.length} recipe(s) reported unavailable`
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep -E "content is captured and its stale"`
Expected: FAIL with `Cannot read properties of undefined (reading 'elements')` — `out.content` does not exist yet.

- [ ] **Step 3: Write the implementation**

In `src/compat/fluxloader.js`, add near the other requires at the top:

```js
const flContent = require('./flux-content')
```

Then replace the block that currently reads:

```js
  bus.registerEvent('fl:pre-scene-loaded')
  bus.emit('fl:pre-scene-loaded')

  return { patches, errors, events: bus }
}
```

with:

```js
  // Swap corelib's content modules for capturing shims BEFORE the deferred
  // registration event fires. corelib turns its in-memory registry into
  // patches from that event, and on this build those patches cannot match;
  // capturing the registrations instead routes them to Sandkit, which is the
  // only path that reaches all 18 simulation workers.
  const content = flContent.install(universe, {
    modId: 'corelib',
    logger: logger.child('content'),
    matterEnum: ctx.matterEnum || {},
  })
  for (const reason of content.reasons) logger.debug(`content bridge: ${reason}`)

  bus.registerEvent('fl:pre-scene-loaded')
  bus.emit('fl:pre-scene-loaded')

  // Drop only the patches the bridge now supplies. Everything else corelib
  // queued is left exactly as it was.
  let dropped = 0
  for (const target of Object.keys(patches)) {
    const before = patches[target].length
    patches[target] = patches[target].filter((p) => !flContent.shouldSuppress(p.id))
    dropped += before - patches[target].length
    if (!patches[target].length) delete patches[target]
  }
  if (dropped) {
    logger.info(`content bridge: ${dropped} superseded patch(es) dropped, ` +
      `${content.captured.elements.length} element(s) and ` +
      `${content.captured.soils.length} soil(s) captured for the game's own registry`)
  }

  return { patches, errors, events: bus, content: content.captured }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tools/selftest.js 2>&1 | tail -3`
Expected: `0 failed`.

- [ ] **Step 5: Verify no regression in the existing corelib checks**

Run: `node tools/selftest.js 2>&1 | grep -E "corelib|deferred patch"`
Expected: every corelib check still PASSes. The check named `'a mod that depends on corelib gets its content into the game'` asserts the element reaches the `elementRegistry` patch, which the bridge now supersedes — update that check to assert on `out.content.elements` instead, keeping its original intent (the dependent's element must arrive somewhere real):

```js
  // The bridge now routes elements to Sandkit rather than into a patch, so
  // assert on what actually carries them.
  const ids = out.content.elements.map((e) => e.id)
  assert(ids.includes('Trash'), 'the dependent element never reached the registry: ' + ids.join(', '))
```

---

### Task 5: Ship captured content to the renderer

**Files:**
- Modify: `src/main/entry.js` (where `loadElectronEntrypoints` is called, near line 1062)
- Modify: `src/compat/fluxloader.js` (register the IPC channel inside `loadElectronEntrypoints`)
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: `out.content` from Task 4.
- Produces: an RPC channel `smln:flux-content` returning
  `{elements:[{id, def}], soils:[{id, def}], unsupported:[{kind, id, reason}]}`.

- [ ] **Step 1: Write the failing test**

```js
check('captured content is exposed to the renderer over IPC', () => {
  // The renderer is where Sandkit lives, so the definitions have to cross the
  // process boundary. corelib already does exactly this for its own registry.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smln-content-ipc-'))
  fs.writeFileSync(path.join(dir, 'modinfo.json'), JSON.stringify({
    modID: 'corelib', version: '3.1.3', electronEntrypoint: 'entry.electron.js',
  }))
  fs.writeFileSync(path.join(dir, 'entry.electron.js'),
    'globalThis.corelib = { elements: {\n' +
    '  registerElement(c) { return true },\n' +
    '  registerSoil(c) { return true },\n' +
    '} }\n' +
    'fluxloaderAPI.events.on("fl:pre-scene-loaded", () => {\n' +
    '  corelib.elements.registerElement({ id: "Ipc", name: "Ipc",\n' +
    '    colors: [[1,2,3,255]], density: 5, matterType: "Solid" })\n' +
    '})\n')

  const r = flCompat.readMod(dir)
  assert(r.ok, 'manifest rejected')
  const channels = {}
  const out = flCompat.loadElectronEntrypoints([r.mod], {
    configDir: dir,
    rpc: { register: (ch, fn) => { channels[ch] = fn } },
    matterEnum: LIVE_MATTER,
  }, testLogger())
  assert(out.errors.length === 0, 'load failed: ' + (out.errors[0] && out.errors[0].message))

  assert(typeof channels['smln:flux-content'] === 'function',
    'the content channel was not registered: [' + Object.keys(channels).join(', ') + ']')
  const payload = channels['smln:flux-content']()
  assert(payload.elements.length === 1, 'payload carried no element')
  assert(payload.elements[0].def.matterType === 1, 'the definition was not translated')
  return 'channel returns ' + payload.elements.length + ' element(s)'
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep "exposed to the renderer"`
Expected: FAIL with `the content channel was not registered`.

- [ ] **Step 3: Write the implementation**

In `src/compat/fluxloader.js`, immediately after the `flContent.install(...)` call added in Task 4, add:

```js
  // The renderer is where Sandkit lives, so the captured definitions have to
  // cross the process boundary. corelib already crosses it the same way for
  // its own registry (corelib:getModuleRegistrations), so this reuses the
  // transport rather than inventing one.
  if (ctx.rpc && typeof ctx.rpc.register === 'function') {
    ctx.rpc.register('smln:flux-content', () => ({
      elements: content.captured.elements,
      soils: content.captured.soils,
      unsupported: content.captured.unsupported,
    }))
  }
```

Note this must come *after* `install` (so `content` exists) but the channel
closes over `content.captured`, which the shims mutate later — so registration
order is safe even though capture happens during the event emit below it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tools/selftest.js 2>&1 | tail -3`
Expected: `0 failed`.

- [ ] **Step 5: Pass the live matter enum from the main process**

In `src/main/entry.js`, find the `flCompat.loadElectronEntrypoints(flActive, {` call
(near line 1062) and add `matterEnum` to the context object:

```js
      const flLoaded = flCompat.loadElectronEntrypoints(flActive, {
        configDir: runtime.configDir,
        sendToRenderer,
        rpc: rpcRegistry,
        isApproved,
        // The renderer reads the live enum and reports it back; until it does,
        // the built-in 0.5.5 table is used so a first load still translates.
        matterEnum: runtime.matterEnum || {
          Solid: 1, Liquid: 2, Particle: 3, Gas: 4,
          Static: 5, Slushy: 6, Wisp: 7, Powder: 8,
        },
      }, logger.child('fluxloader'))
```

- [ ] **Step 6: Run the full suite**

Run: `node tools/selftest.js 2>&1 | tail -3`
Expected: `0 failed`.

---

### Task 6: Register captured content in the renderer

**Files:**
- Create: `src/renderer/flux-register.js`
- Modify: `src/renderer/prelude.js` (include the new file alongside the other renderer scripts)
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: the `smln:flux-content` channel from Task 5; `SMLN.register.as(modId)`
  from `src/renderer/registration.js`.
- Produces: an IIFE that, once `SMLN` is ready, pulls the payload and calls
  `SMLN.register.as('corelib').element(def)` / `.terrain(def)` per entry, and
  reports each `unsupported` entry through `SMLN.log`.

- [ ] **Step 1: Write the failing test**

```js
check('the renderer bridge registers captured content through SMLN', () => {
  // Runs the renderer script in a sandbox with a fake SMLN, so the wiring is
  // tested without a browser.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'flux-register.js'), 'utf8')
  const calls = { element: [], terrain: [], logs: [] }
  const SMLN = {
    log: (level, msg) => calls.logs.push(level + ': ' + msg),
    whenReady: (fn) => fn(),
    callMain: (channel) => Promise.resolve(channel === 'smln:flux-content' ? {
      elements: [{ id: 'Trash', def: { id: 'Trash', matterType: 6 } }],
      soils: [{ id: 'TrashSoil', def: { id: 'TrashSoil' } }],
      unsupported: [{ kind: 'recipe', id: 'Trash', reason: 'no recipe registry' }],
    } : null),
    register: {
      as: () => ({
        element: (def) => { calls.element.push(def); return Promise.resolve({}) },
        terrain: (def) => { calls.terrain.push(def); return Promise.resolve({}) },
      }),
    },
  }
  const sandbox = { globalThis: null, __SMLN__: SMLN, console }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(src, { filename: 'flux-register.js' }).runInContext(sandbox)

  return new Promise((resolve) => setTimeout(() => {
    assert(calls.element.length === 1, 'no element registered: ' + calls.element.length)
    assert(calls.element[0].id === 'Trash', 'wrong element: ' + calls.element[0].id)
    assert(calls.terrain.length === 1, 'no soil registered')
    assert(calls.logs.some((l) => /recipe/i.test(l)), 'the unsupported recipe was not reported')
    resolve('registered 1 element, 1 soil, reported 1 unsupported')
  }, 20))
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep "renderer bridge registers"`
Expected: FAIL with `ENOENT ... flux-register.js`.

- [ ] **Step 3: Write the implementation**

Create `src/renderer/flux-register.js`:

```js
/* eslint-env browser */
'use strict'
/**
 * Registers Fluxloader mod content with the running game.
 *
 * The main process captured what corelib's mods registered and translated it
 * into 0.5.5 shape (see src/compat/flux-content.js). Sandkit lives here in the
 * renderer, so this is where the definitions are actually handed over -
 * through SMLN.register, which already queues until the game is ready,
 * attributes failures to a mod and isolates one bad definition from the rest.
 */
;(function installFluxContentBridge(global) {
  var SMLN = global.__SMLN__
  if (!SMLN || !SMLN.register || SMLN.__fluxContentInstalled) return
  SMLN.__fluxContentInstalled = true

  SMLN.whenReady(function () {
    if (typeof SMLN.callMain !== 'function') return
    SMLN.callMain('smln:flux-content').then(function (payload) {
      if (!payload) return
      var api = SMLN.register.as('corelib')
      var elements = payload.elements || []
      var soils = payload.soils || []
      var unsupported = payload.unsupported || []

      for (var i = 0; i < elements.length; i++) {
        (function (entry) {
          api.element(entry.def).then(function () {
            SMLN.log('info', 'fluxloader element registered: ' + entry.id)
          }, function (e) {
            SMLN.log('error', 'fluxloader element "' + entry.id + '" failed: ' +
              ((e && e.message) || e))
          })
        })(elements[i])
      }

      // Soils are mineable terrain in Sandustry's model.
      for (var j = 0; j < soils.length; j++) {
        (function (entry) {
          api.terrain(entry.def).then(function () {
            SMLN.log('info', 'fluxloader soil registered: ' + entry.id)
          }, function (e) {
            SMLN.log('error', 'fluxloader soil "' + entry.id + '" failed: ' +
              ((e && e.message) || e))
          })
        })(soils[j])
      }

      // Say what could not be done and why, rather than leaving the player to
      // discover the missing content in-game.
      for (var k = 0; k < unsupported.length; k++) {
        var u = unsupported[k]
        SMLN.log('warn', 'fluxloader ' + u.kind + ' "' + u.id + '" was not registered: ' + u.reason)
      }
    }, function (e) {
      SMLN.log('error', 'fluxloader content bridge failed: ' + ((e && e.message) || e))
    })
  })
})(typeof globalThis !== 'undefined' ? globalThis : self)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tools/selftest.js 2>&1 | tail -3`
Expected: `0 failed`.

- [ ] **Step 5: Include the script in the renderer bundle**

In `src/renderer/prelude.js` the ordered list is the `PARTS` array at line 49.
Add `'flux-register.js'` **after** `'sandkit-adapter.js'` — it needs
`SMLN.register` (from `registration.js`) and the Sandkit surface the adapter
builds, and `SMLN.callMain` which `capabilities.js` installs earlier in the
list:

```js
  'registration.js',
  'messaging.js',
  'sandkit-adapter.js',
  // After sandkit-adapter.js: the bridge hands captured Fluxloader content to
  // SMLN.register, which calls through the Sandkit surface that file builds.
  'flux-register.js',
```

Run: `node tools/selftest.js 2>&1 | tail -3`
Expected: `0 failed`.

---

### Task 7: Live verification and documentation

**Files:**
- Modify: `README.md` (the Fluxloader compatibility section, near the existing
  "Limitations and what's not built yet" list around line 789)

**Interfaces:**
- Consumes: everything above.
- Produces: no code. A verified running game and accurate docs.

- [ ] **Step 1: Run the full suite one final time**

Run: `node tools/selftest.js 2>&1 | tail -5`
Expected: `0 failed`. Record the total count.

- [ ] **Step 2: Restart the game so the main process picks up the new code**

A mod reload re-runs entrypoints but does not re-`require` SandLoader's own
source, so the running Electron main process keeps the old modules. The game
must be fully restarted.

Ask the user to restart Sandustry (do not kill it without asking), then:

Run: `mcp__sandustry__sandustry_status`
Expected: `renderer.ready: true`.

- [ ] **Step 3: Confirm the loader captured the content**

Run: `mcp__sandustry__read_sandloader_log_tail` with `maxBytes: 20000`
Expected: a line reading
`content bridge: N superseded patch(es) dropped, 2 element(s) and 1 soil(s) captured`.

- [ ] **Step 4: Confirm the content reached the live game**

Run `mcp__sandustry__renderer_eval` with:

```js
return (() => {
  const wp = globalThis.__SMLN__.webpack;
  const hits = wp.find(m => m && typeof m === 'object' && Object.values(m).some(v =>
    v && typeof v === 'object' && Object.values(v).slice(0, 5).some(x =>
      x && typeof x === 'object' && ('nameKey' in x) && ('matterType' in x))));
  const mod = Array.isArray(hits) ? hits[0] : hits;
  const reg = mod.m5;
  const state = globalThis.__SMLN__.getState();
  const mods = state && state.sandkit && state.sandkit.mods && state.sandkit.mods.elements;
  return {
    builtinCount: Object.keys(reg).length,
    modElements: mods ? Object.keys(mods) : null,
    hasTrash: !!(mods && mods.Trash),
    hasCompressedTrash: !!(mods && mods.CompressedTrash),
  };
})();
```

Expected: `hasTrash: true`, `hasCompressedTrash: true`, and `modElements`
listing them.

- [ ] **Step 5: Confirm no new errors**

Run: `mcp__sandustry__get_console_logs` with `level: "error"`, `limit: 50`
Expected: no errors relating to the bridge, corelib or element registration.

Run: `mcp__sandustry__get_sandloader_problems`
Expected: the two pre-existing `fluxloaderVersion` warnings, plus recipe
entries reported as unavailable with their reason. No new errors.

- [ ] **Step 6: Update the README**

In the Fluxloader compatibility section, add:

```markdown
**Fluxloader content bridge**

Fluxloader mods register content through corelib, which does it by patching the
game bundle. On Sandustry 0.5.5 that no longer works: 75 of corelib 3.1.3's 92
patch anchors exist in no shipped file. The build stopped splitting into
numbered chunks (`js/336.bundle.js` and friends are never requested), and the
element registry changed shape - `{name:"Cinder", matterType:X.Slushy}` became
`{nameKey:"elements|basalt|name", matterType:6}`.

SandLoader now bridges it instead. corelib's `registerElement` and
`registerSoil` are intercepted, each definition is translated into 0.5.5 shape,
and the result goes to Sandkit's own `elements.register` / `terrains.register`
by way of `SMLN.register`. The mod is not modified, corelib is not modified,
and the eight corelib patches the bridge supersedes are dropped while its other
~84 are left untouched.

This also fixes the reason nothing registered at all: corelib defers every
patch to `fl:pre-scene-loaded`, and SandLoader never emitted that event, so
mods loaded cleanly and registered nothing. The event now fires after
entrypoints load and before patches are harvested.

**Recipes remain unavailable.** Sandustry 0.5.5 has no recipe registry -
`sandkit.structures.recipes` is undefined, no namespace among the 79 matches
`/recipe/i`, and no module carries an input/output shape. A mod's recipe calls
are reported with that reason rather than silently doing nothing.
```

- [ ] **Step 7: Final check**

Run: `node tools/selftest.js 2>&1 | tail -3`
Expected: `0 failed`.

---

## Self-Review

**Spec coverage:**
- Problem 1 (event never fired) — already fixed before this plan; Task 4 keeps
  the emit and Task 7 documents it.
- Problem 2 (patches do not match) — Tasks 1-6.
- Translation table — Tasks 1 and 2, every row covered.
- Architecture / interception point — Task 4.
- Electron to renderer marshalling — Tasks 5 and 6.
- Suppressing stale patches — Task 4 (`shouldSuppress`).
- Diagnostics (option 2) — Task 3 records `unsupported`; Task 6 reports it;
  Task 7 verifies it in the live problems channel.
- Recipes cannot work — Task 3 suppresses with a reason, Task 4 asserts they
  are reported, Task 7 documents it.
- Testing (unit, integration, live MCP) — Tasks 1-3 unit, 4-6 integration,
  Task 7 live.

**Deferred from the spec's scope table, deliberately:** items, structures,
blocks, tech and upgrades have confirmed 0.5.5 targets
(`items.register`, `structures.register`, `tech.addDefinition`,
`upgrades.register`) but no mod in this install exercises them. The bridge's
shape — capture, translate, hand to `SMLN.register` — extends to each by adding
a translator and a shim, following Tasks 2 and 3 exactly. Building them now
would mean shipping untested translations for shapes no available mod produces.
Elements, soils and recipe reporting are what trashelement and corelib actually
use, so they are what this plan delivers working end to end.

**Placeholder scan:** none. Every step carries real code or an exact command.

**Type consistency:** `translateElement`/`translateSoil` return `{ok, def}` and
are consumed that way in Task 3. `install` returns `{ok, captured, reasons}`,
consumed that way in Tasks 4 and 5. `captured` is
`{elements, soils, unsupported}` throughout. The `smln:flux-content` payload
keys match between Task 5 and Task 6. `shouldSuppress` takes a patch id string
in both Task 3 and Task 4.
