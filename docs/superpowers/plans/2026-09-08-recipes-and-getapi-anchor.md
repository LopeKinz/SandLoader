# getApi anchor and real recipes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore `state.sandkit.getApi()` on Sandustry 0.5.6, then let Fluxloader mods register real recipes into the registry 0.5.6 added.

**Architecture:** One new patch variant anchors on the *assignment* of the sandkit object instead of on an object literal, which is what 0.5.6 stopped emitting. Recipes then flow the way every other content kind already does: `flux-content.js` (main process) captures and shape-translates, `flux-register.js` (renderer) resolves element names against the live API and calls `SMLN.register.as(mod).recipe(kind, def)`.

**Tech Stack:** Node ≥18, CommonJS, no dependencies. Plain-Node self-test (`tools/selftest.js`).

**Spec:** `docs/superpowers/specs/2026-09-08-recipes-and-getapi-anchor-design.md`

## Global Constraints

- Node ≥18, CommonJS, **no new dependencies**.
- Style matches the codebase: `'use strict'`, comments explain *why*, full sentences.
- **Baseline before this plan: 180 passed, 5 failed.** Task 1 turns two of those five green (`anchors re-resolve when the shape around the literal moves`, `the getApi patch applies once and yields a working Sandkit API`). The other three — the two host-ABI checks and `player.inventory.addFromId` — are out of scope and stay red. Never report a fully green suite.
- Element **names** stay strings until the renderer. `flux-content.js` runs in the main process and has no live game API; only `flux-register.js` can resolve a name a mod registered this run.
- Name→number lookup is `enums.ElementByName` (`src/game/enums.js:243`), **not** `ElementType`, which is number→name.
- Nothing may abort the load. A rejected recipe is recorded through the existing unsupported-content channel and reported in the mod UI.
- Commit only the files a task names. `mod-creator/` is untracked and must never be committed. Never `git add -A`.
- Commit messages are plain imperative sentences, no `feat:`/`chore:` prefixes, ending with:

  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

### The registry's exact shapes (read out of the 0.5.6 bundle)

`api.structures.recipes.register(state, kind, def)` — state-first. Validators:

| category array | def the game stores | notes |
|---|---|---|
| `contacts` | `{inputA, inputB, outputA, outputB, orientation}` | inputs required; outputs may be `null`; `orientation` is `"any"` (default) or `"stacked"`; deduped by unordered input pair |
| `shakers` | `{input, outputsAbove, outputsBelow}` | **plural** `outputsAbove`/`outputsBelow`, both optional lists |
| `kineticPresses` | `{input, minimumDownwardVelocity, outputs}` | `minimumDownwardVelocity` is **required**, finite and ≥ 0 |
| `growers` | `{input, output, chance}` | `chance` defaults to 1, must be 0–1 |

Output list entries are `{elementType, chance}`. The registry throws on: no outputs, a `chance` outside 0–1, chances summing above 1, and `"Sandkit must be initialized before registering recipes."`

Confirmed kind strings in the bundle: `"shaker"`, `"kineticPress"`, `"condenser"`, `"steamDryer"`, `"synthesizer"`, `"snowmaker"`, `"smelter"`. **`"contact"` and `"grower"` appear as no literal** — Task 4 confirms them against the running game rather than guessing.

---

### Task 1: The third anchor variant

**Files:**
- Modify: `src/patch/core-patches.js` (the `variants` array of the `smln:sandkit-get-api` patch, around line 241-253)
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks import. It makes `state.sandkit.getApi()` exist, without which Tasks 3-5 cannot be verified in game.

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`, after the check named `no stray debug logging survives in the bootstrap`:

```js
check('the getApi anchor covers a registry assigned from an identifier', () => {
  const { corePatches } = require('../src/patch/core-patches')
  const patch = corePatches.find((p) => p.id === 'smln:sandkit-get-api')
  assert(patch, 'the getApi patch is gone')

  // 0.5.6 builds the object first and assigns the identifier.
  const shape056 = 'E.jsonConfigs=x,M.sandkit=E,function(e){}'
  const outcomes = engine.verify(shape056, [patch])
  assert(outcomes.every((o) => o.status !== 'failed'),
    'the 0.5.6 assignment shape still does not match: ' + JSON.stringify(outcomes))

  // and the 0.5.5 literal shape must keep working.
  const shape055 = 'g.sandkit={mods:{elements:{},keyBindings:{}}},x=1'
  const old = engine.verify(shape055, [patch])
  assert(old.every((o) => o.status !== 'failed'),
    'the object-literal shape broke: ' + JSON.stringify(old))
  return 'identifier assignment and object literal both anchored'
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep "assigned from an identifier"`
Expected: FAIL — the 0.5.6 assignment shape does not match.

- [ ] **Step 3: Write minimal implementation**

In `src/patch/core-patches.js`, add a second entry to the `variants` array of the `smln:sandkit-get-api` patch, after the existing `registry object with a different field set` variant:

```js
      {
        /*
         * 0.5.6 stopped assigning an object literal. It builds the registry
         * first and assigns the identifier:
         *
         *   …keyBindings:{}});E.jsonConfigs=x,M.sandkit=E,…
         *
         * Both patterns above require a literal, so neither matched and the
         * game's own 45 getApi call sites were left pointing at undefined.
         * Anchor on the assignment instead and append to whatever was
         * assigned - how the object got built stops mattering.
         *
         * `getApi||` leaves a build that starts defining its own alone.
         */
        label: 'registry assigned from an identifier',
        find: /sandkit=([A-Za-z_$][\w$]*)(?=[,;])/g,
        replace: (...args) => {
          const [, id] = args
          return `sandkit=${id},${id}.getApi=${id}.getApi||function(){` +
            `var g=globalThis.${GLOBAL};` +
            `return (g&&g.game)||(g&&g.state&&g.state.FH)||null}`
        },
        expect: 'any',
      },
```

- [ ] **Step 4: Run the test and the two checks this is meant to fix**

Run: `node tools/selftest.js > /tmp/t1.txt 2>&1; grep -E "assigned from an identifier|anchors re-resolve|getApi patch applies" /tmp/t1.txt; grep -E "passed, .* failed" /tmp/t1.txt`

Expected: all three named checks PASS, and the summary reads **183 passed, 3 failed**. The three remaining failures must be exactly the two host-ABI checks and `player.inventory.addFromId`.

- [ ] **Step 5: Commit**

```bash
git add src/patch/core-patches.js tools/selftest.js
git commit -m "Anchor getApi on the assignment, not on the literal 0.5.6 stopped emitting"
```

---

### Task 2: translateRecipe

**Files:**
- Modify: `src/compat/flux-translate.js` (add the function, extend `module.exports` at the end)
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `translateRecipe(fn, config) -> {ok:true, kind, def} | {ok:false, reason}`.
  `fn` is one of corelib's four method names. `kind` is the **plural registry array name** (`'contacts'`, `'shakers'`, `'kineticPresses'`, `'growers'`) — Task 4 maps that to the singular string the game's `register()` wants. `def` carries element **names as strings**; the renderer resolves them.

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`:

```js
check('corelib recipe shapes translate onto the 0.5.6 categories', () => {
  const t = require('../src/compat/flux-translate')

  const basic = t.translateRecipe('registerBasicRecipe',
    { inputTop: 'Sand', inputBottom: 'Water', outputTop: 'WetSand', outputBottom: 'WetSand' })
  assert(basic.ok, 'basic failed: ' + basic.reason)
  assert(basic.kind === 'contacts', 'basic went to ' + basic.kind)
  assert(basic.def.inputA === 'Sand' && basic.def.inputB === 'Water', 'contact inputs are wrong')
  assert(basic.def.outputA === 'WetSand' && basic.def.outputB === 'WetSand', 'contact outputs are wrong')
  assert(basic.def.orientation === 'stacked', 'Top/Bottom is positional and must map to stacked')

  // A basic recipe may omit outputBottom; the game accepts null, not undefined.
  const oneOut = t.translateRecipe('registerBasicRecipe',
    { inputTop: 'Spore', inputBottom: 'Water', outputTop: 'WetSpore' })
  assert(oneOut.ok && oneOut.def.outputB === null, 'a missing output must become null')

  const press = t.translateRecipe('registerPressRecipe',
    { input: 'BurntSlag', outputs: [['Spore', 1], ['Gold', 0.25]] })
  assert(press.ok, 'press failed: ' + press.reason)
  assert(press.kind === 'kineticPresses', 'press went to ' + press.kind)
  assert(press.def.minimumDownwardVelocity === 0, 'the required velocity field is missing')
  assert(press.def.outputs.length === 2, 'press outputs were dropped')
  assert(press.def.outputs[1].name === 'Gold' && press.def.outputs[1].chance === 0.25,
    'output pairs did not become {name, chance}')

  const grower = t.translateRecipe('registerGrowerRecipe', { input: 'WetSpore', output: 'Seed' })
  assert(grower.ok && grower.kind === 'growers', 'grower failed: ' + grower.reason)
  assert(grower.def.chance === 1, 'grower chance must default to 1')

  const shaker = t.translateRecipe('registerShakerRecipe',
    { input: 'WetSand', outputAbove: [['Slag', 1]], outputBelow: [['Gold', 0.25]] })
  assert(shaker.ok && shaker.kind === 'shakers', 'shaker failed: ' + shaker.reason)
  assert(Array.isArray(shaker.def.outputsAbove) && shaker.def.outputsAbove[0].name === 'Slag',
    'the game spells it outputsAbove, plural')
  assert(shaker.def.outputsBelow[0].chance === 0.25, 'outputsBelow lost its chance')

  return 'contacts, kineticPresses, growers and shakers all translated'
})

check('a recipe the game would reject is refused before it gets there', () => {
  const t = require('../src/compat/flux-translate')
  assert(!t.translateRecipe('registerBasicRecipe', { inputTop: 'Sand' }).ok,
    'a contact with no second input was accepted')
  assert(!t.translateRecipe('registerPressRecipe', { input: 'X', outputs: [] }).ok,
    'a press with no outputs was accepted')
  assert(!t.translateRecipe('registerPressRecipe', { input: 'X', outputs: [['Gold', 2]] }).ok,
    'a chance above 1 was accepted')
  assert(!t.translateRecipe('registerGrowerRecipe', { input: 'X' }).ok,
    'a grower with no output was accepted')
  assert(!t.translateRecipe('registerConveyorBeltIgnores', 'Water').ok,
    'an allow-list call was mistaken for a recipe')
  return 'five invalid shapes refused with reasons'
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep -E "corelib recipe shapes|would reject is refused"`
Expected: two FAIL lines, `t.translateRecipe is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/compat/flux-translate.js`, above `module.exports`:

```js
/**
 * corelib's four recipe methods, and the registry array each one belongs in.
 * The five categories 0.5.6 also has - condensers, steamDryers, synthesizers,
 * snowmakers, smelters - have no corelib equivalent and are reachable only
 * through SMLN.register.recipe() directly.
 */
const RECIPE_KIND_BY_FN = {
  registerBasicRecipe: 'contacts',
  registerPressRecipe: 'kineticPresses',
  registerShakerRecipe: 'shakers',
  registerGrowerRecipe: 'growers',
}

/** A recipe's element fields stay names here; only the renderer can resolve them. */
function elementName(value) {
  return typeof value === 'string' && value ? value : null
}

/**
 * `[["Spore", 1], ["Gold", 0.25]]` -> `[{name:'Spore', chance:1}, …]`.
 * Returns null with a reason rather than handing the registry something it
 * would throw on - the game validates chances itself, and its throw would
 * arrive without the mod's name attached.
 */
function outputList(pairs, field) {
  if (pairs === undefined || pairs === null) return { ok: true, list: [] }
  if (!Array.isArray(pairs)) return { ok: false, reason: `${field} must be an array` }
  const list = []
  let total = 0
  for (const pair of pairs) {
    const name = elementName(Array.isArray(pair) ? pair[0] : pair && pair.name)
    const chance = Array.isArray(pair) ? pair[1] : pair && pair.chance
    if (!name) return { ok: false, reason: `${field} has an entry with no element name` }
    const c = chance === undefined ? 1 : chance
    if (typeof c !== 'number' || !isFinite(c) || c < 0 || c > 1) {
      return { ok: false, reason: `${field}["${name}"].chance must be between 0 and 1, got ${c}` }
    }
    total += c
    list.push({ name, chance: c })
  }
  if (total > 1 + 1e-9) {
    return { ok: false, reason: `${field} chances total ${total}, which is more than 1` }
  }
  return { ok: true, list }
}

/**
 * Translate one corelib recipe call into the shape 0.5.6's registry stores.
 *
 * Element fields stay strings: this runs in the main process, where the live
 * game API - the only thing that knows the type number of an element a mod
 * registered this run - does not exist. src/renderer/flux-register.js resolves
 * them.
 *
 * @param {string} fn One of corelib's four recipe method names.
 * @param {object} config The config corelib was called with.
 * @returns {{ok:true, kind:string, def:object}|{ok:false, reason:string}}
 */
function translateRecipe(fn, config) {
  const kind = RECIPE_KIND_BY_FN[fn]
  if (!kind) return { ok: false, reason: `${fn} is not a recipe registration` }
  const c = config || {}

  if (kind === 'contacts') {
    // corelib's Top/Bottom is positional, so the contact is a stacked one.
    const inputA = elementName(c.inputTop)
    const inputB = elementName(c.inputBottom)
    if (!inputA || !inputB) {
      return { ok: false, reason: 'a contact recipe needs both inputTop and inputBottom' }
    }
    return {
      ok: true,
      kind,
      def: {
        inputA,
        inputB,
        outputA: elementName(c.outputTop),
        outputB: elementName(c.outputBottom),
        orientation: 'stacked',
      },
    }
  }

  const input = elementName(c.input)
  if (!input) return { ok: false, reason: `a ${kind} recipe needs an input element name` }

  if (kind === 'growers') {
    const output = elementName(c.output)
    if (!output) return { ok: false, reason: 'a grower recipe needs an output element name' }
    const chance = c.chance === undefined ? 1 : c.chance
    if (typeof chance !== 'number' || !isFinite(chance) || chance < 0 || chance > 1) {
      return { ok: false, reason: `grower chance must be between 0 and 1, got ${chance}` }
    }
    return { ok: true, kind, def: { input, output, chance } }
  }

  if (kind === 'kineticPresses') {
    const outputs = outputList(c.outputs, 'outputs')
    if (!outputs.ok) return { ok: false, reason: outputs.reason }
    if (!outputs.list.length) return { ok: false, reason: 'a press recipe needs at least one output' }
    // The game requires this field and corelib has no equivalent. Zero is the
    // permissive value: any downward velocity qualifies, which is what a
    // corelib press meant when it did not talk about velocity at all.
    const velocity = typeof c.minimumDownwardVelocity === 'number' && c.minimumDownwardVelocity >= 0
      ? c.minimumDownwardVelocity
      : 0
    return { ok: true, kind, def: { input, minimumDownwardVelocity: velocity, outputs: outputs.list } }
  }

  // shakers - note the game spells these plural, corelib does not.
  const above = outputList(c.outputAbove, 'outputAbove')
  if (!above.ok) return { ok: false, reason: above.reason }
  const below = outputList(c.outputBelow, 'outputBelow')
  if (!below.ok) return { ok: false, reason: below.reason }
  if (!above.list.length && !below.list.length) {
    return { ok: false, reason: 'a shaker recipe needs at least one output' }
  }
  return { ok: true, kind, def: { input, outputsAbove: above.list, outputsBelow: below.list } }
}
```

Extend the export block at the end of the file:

```js
module.exports = {
  toVariants,
  matterTypeToNumber, nameKeyFor, rgbaToMetaColor, hslToRgba,
  translateElement, translateSoil,
  translateBlock, translateTech, translateUpgrade,
  translateRecipe, RECIPE_KIND_BY_FN,
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/selftest.js 2>&1 | grep -E "corelib recipe shapes|would reject is refused"`
Expected: two PASS lines.

- [ ] **Step 5: Commit**

```bash
git add src/compat/flux-translate.js tools/selftest.js
git commit -m "Translate corelib's four recipe shapes onto the 0.5.6 categories"
```

---

### Task 3: Capture recipes instead of suppressing them

**Files:**
- Modify: `src/compat/flux-content.js` (the `captured` object at line 69; the recipe suppression block at lines 228-259)
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: `translateRecipe(fn, config)` and `RECIPE_KIND_BY_FN` from Task 2.
- Produces: `captured.recipes`, an array of `{id, kind, def}` where `kind` is the plural registry array name and `def` carries element names.

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`:

```js
check('corelib recipe calls are captured instead of being suppressed', () => {
  const fluxContent = require('../src/compat/flux-content')
  const calls = []
  const corelib = {
    recipes: {
      registerBasicRecipe(config) { calls.push(config); return 'original' },
      registerPressRecipe() { return 'original' },
      registerShakerRecipe() { return 'original' },
      registerGrowerRecipe() { return 'original' },
      registerConveyorBeltIgnores() { return 'original' },
    },
  }
  const out = fluxContent.install(corelib, {})
  assert(out && out.ok, 'install failed')
  assert(Array.isArray(out.captured.recipes), 'captured.recipes is missing')

  corelib.recipes.registerBasicRecipe(
    { inputTop: 'Sand', inputBottom: 'Water', outputTop: 'WetSand' })
  assert(out.captured.recipes.length === 1,
    'the recipe was not captured, got ' + out.captured.recipes.length)
  const got = out.captured.recipes[0]
  assert(got.kind === 'contacts', 'captured as ' + got.kind)
  assert(got.def.inputA === 'Sand', 'the captured def is wrong')

  // An invalid recipe is reported, not captured, and never throws at the mod.
  corelib.recipes.registerGrowerRecipe({ input: 'WetSpore' })
  assert(out.captured.recipes.length === 1, 'an invalid recipe was captured anyway')
  assert(out.captured.unsupported.some((u) => u.kind === 'recipe'),
    'the invalid recipe was not reported')

  // Allow-lists are not recipes and stay unsupported.
  corelib.recipes.registerConveyorBeltIgnores('Water')
  assert(out.captured.recipes.length === 1, 'an allow-list call was captured as a recipe')
  return 'valid captured, invalid reported, allow-lists untouched'
})
```

Note: `install(corelib, opts)` is the existing export; if its signature in the file differs, call it exactly as the other install tests in this file already do.

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep "captured instead of being suppressed"`
Expected: FAIL — `captured.recipes is missing`.

- [ ] **Step 3: Write minimal implementation**

In `src/compat/flux-content.js`, add `recipes` to the captured collection at line 69:

```js
  const captured = { elements: [], soils: [], blocks: [], tech: [], upgrades: [], recipes: [], unsupported: [] }
```

The file already has `const translate = require('./flux-translate')` at line 27; use that binding. Do not add a second import.

Replace the whole suppression block — the comment beginning `// Sandustry 0.5.5 has no recipe registry`, the `RECIPE_FNS` constant, and the `if (corelib.recipes …)` loop that installs `suppressedRecipe` — with:

```js
  /*
   * 0.5.6 added the recipe registry 0.5.5 did not have: nine machine
   * categories with a state-first register(). corelib's four methods are
   * intercepted and translated here; the renderer resolves the element names
   * and does the registering, because only it can see elements a mod added
   * this run.
   *
   * corelib's own constructor seeds about nine recipes the game already
   * implements natively. They are forwarded like any other - see the spec for
   * why, and for what it costs.
   */
  const RECIPE_FNS = [
    'registerBasicRecipe', 'registerPressRecipe', 'registerShakerRecipe',
    'registerGrowerRecipe',
  ]
  // Same rule as safeId above: this reads config.input/config.id, either of
  // which may be a throwing getter, so it must not be able to throw itself.
  function safeRecipeId(config, fallback) {
    try {
      return String((config && (config.input || config.inputTop || config.id)) || fallback)
    } catch (_e) {
      return fallback
    }
  }

  if (corelib.recipes && typeof corelib.recipes === 'object') {
    for (const fn of RECIPE_FNS) {
      if (typeof corelib.recipes[fn] !== 'function') continue
      corelib.recipes[fn] = function capturedRecipe(config) {
        let id = fn
        try {
          id = safeRecipeId(config, fn)
          const r = translate.translateRecipe(fn, config)
          if (r.ok) captured.recipes.push({ id, kind: r.kind, def: r.def })
          else note('recipe', id, r.reason)
        } catch (e) {
          note('recipe', id, `reading the recipe definition threw: ${e && e.message}`)
        }
        // corelib reads the return value only for its own bookkeeping, and a
        // throw here would take down the mod that called it.
        return false
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/selftest.js 2>&1 | grep "captured instead of being suppressed"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/compat/flux-content.js tools/selftest.js
git commit -m "Capture corelib recipes now that 0.5.6 has somewhere to put them"
```

---

### Task 4: Resolve names and register in the renderer

**Files:**
- Modify: `src/compat/flux-content.js` (add the vanilla name table to the payload)
- Modify: `src/renderer/flux-register.js` (the registration body, around lines 38-140)
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: `captured.recipes` from Task 3 (`{id, kind, def}`, plural kind, element names as strings).
- Produces: nothing later tasks import.

**How names get resolved.** `flux-register.js` is an IIFE run in the renderer: it cannot `require` anything, and there is no `SMLN.enums`. So the vanilla name table travels in the payload from the main process, where `src/game/enums.js` *is* requireable, and the renderer merges it with the mod elements registered moments earlier in the same pass. No live-API method name has to be guessed.

**The one unknown, settled empirically.** The bundle carries the literals `"shaker"`, `"kineticPress"`, `"condenser"`, `"steamDryer"`, `"synthesizer"`, `"snowmaker"` and `"smelter"`, but **no `"contact"` and no `"grower"`**. Step 6 confirms those two against the running game instead of assuming them.

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`. This follows the existing sandbox check named `the renderer bridge registers captured content through SMLN` (around line 4883), which runs the real renderer script under `vm` with a fake `SMLN`. Recipes are tested the same way — through the payload, not by reaching inside the module:

```js
check('captured recipes reach the game with their element names resolved', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'flux-register.js'), 'utf8')
  const calls = { recipes: [], logs: [] }
  const SMLN = {
    log: (level, msg) => calls.logs.push(level + ': ' + msg),
    whenReady: (fn) => fn(),
    sandkit: { structures: { recipes: { register: () => true } } },
    callMain: (channel) => Promise.resolve(channel === 'smln:flux-content' ? {
      ok: true,
      value: {
        elements: [],
        soils: [],
        // Vanilla names the main process resolved out of src/game/enums.js.
        elementTypes: { Sand: 1, Water: 3, WetSand: 4 },
        recipes: [
          { id: 'Sand', kind: 'contacts', def: {
            inputA: 'Sand', inputB: 'Water', outputA: 'WetSand', outputB: null,
            orientation: 'stacked' } },
          { id: 'Ghost', kind: 'growers', def: {
            input: 'Nonexistent', output: 'WetSand', chance: 1 } },
        ],
        unsupported: [],
      },
    } : null),
    register: {
      as: () => ({
        element: () => Promise.resolve({}),
        terrain: () => Promise.resolve({}),
        recipe: (kind, def) => { calls.recipes.push({ kind, def }); return Promise.resolve({}) },
      }),
    },
  }
  const sandbox = { globalThis: null, __SMLN__: SMLN, console }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(src, { filename: 'flux-register.js' }).runInContext(sandbox)

  return new Promise((resolve, reject) => setTimeout(() => {
    try {
      assert(calls.recipes.length === 1,
        'expected exactly the resolvable recipe, got ' + calls.recipes.length)
      const r = calls.recipes[0]
      assert(r.kind === 'contact', 'register() wants the singular kind, got ' + r.kind)
      assert(r.def.inputA === 1 && r.def.inputB === 3, 'inputs were not resolved to numbers')
      assert(r.def.outputA === 4, 'the output was not resolved')
      assert(r.def.outputB === null, 'a null output must stay null, never undefined')
      assert(r.def.orientation === 'stacked', 'non-element fields must survive untouched')
      assert(calls.logs.some((l) => /Ghost|Nonexistent/.test(l)),
        'the unresolvable recipe was not reported: ' + JSON.stringify(calls.logs))
      resolve('one recipe registered with numbers, one refused and reported')
    } catch (e) { reject(e) }
  }, 60))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep "recipes reach the game with their element names"`
Expected: FAIL — `expected exactly the resolvable recipe, got 0`; the renderer does not handle recipes yet.

- [ ] **Step 3: Send the vanilla name table with the payload**

In `src/compat/flux-content.js`, require the enum tables beside the existing requires at the top of the file:

```js
const enums = require('../game/enums')
```

and extend the value `install()` returns, replacing its final `return`:

```js
  /*
   * The renderer resolves recipe element names, but it is an IIFE with no
   * require() and no enum tables of its own. The vanilla name-to-number map is
   * small and static, so it rides along with the payload; the renderer merges
   * it with the mod elements registered in the same pass.
   */
  return { ok: true, captured, reasons, elementTypes: enums.ElementByName }
```

If the payload the renderer receives is assembled elsewhere from `captured`, add `elementTypes` at that point instead, so the renderer sees `payload.elementTypes`.

- [ ] **Step 4: Register the recipes in the renderer**

In `src/renderer/flux-register.js`, add these helpers inside the IIFE, above the `SMLN.whenReady(...)` call:

```js
  /** The registry stores plural arrays; register() takes the singular kind. */
  var SINGULAR_KIND = {
    contacts: 'contact',
    shakers: 'shaker',
    kineticPresses: 'kineticPress',
    growers: 'grower',
  }

  /** Element-valued fields, by the names the game's registry uses. */
  var RECIPE_SCALAR_FIELDS = ['inputA', 'inputB', 'outputA', 'outputB', 'input', 'output']
  var RECIPE_LIST_FIELDS = ['outputs', 'outputsAbove', 'outputsBelow']

  /**
   * Turn a translated recipe's element names into type numbers.
   *
   * An unresolvable name fails the whole recipe. Handing the registry
   * `elementType: undefined` would store a recipe that silently never fires,
   * which is worse for the player than being told it was skipped.
   *
   * @param {object} def
   * @param {(name:string)=>number|undefined} resolve
   * @returns {{ok:true, def:object}|{ok:false, reason:string}}
   */
  function resolveRecipeElements(def, resolve) {
    var out = {}
    for (var key in def) {
      if (Object.prototype.hasOwnProperty.call(def, key)) out[key] = def[key]
    }

    for (var i = 0; i < RECIPE_SCALAR_FIELDS.length; i++) {
      var f = RECIPE_SCALAR_FIELDS[i]
      if (!(f in out)) continue
      if (out[f] === null || out[f] === undefined) { out[f] = null; continue }
      var n = resolve(out[f])
      if (typeof n !== 'number') {
        return { ok: false, reason: 'no element is named "' + out[f] + '" (field ' + f + ')' }
      }
      out[f] = n
    }

    for (var j = 0; j < RECIPE_LIST_FIELDS.length; j++) {
      var lf = RECIPE_LIST_FIELDS[j]
      if (!Array.isArray(out[lf])) continue
      var list = []
      for (var k = 0; k < out[lf].length; k++) {
        var entry = out[lf][k]
        var t = resolve(entry.name)
        if (typeof t !== 'number') {
          return { ok: false, reason: 'no element is named "' + entry.name + '" (in ' + lf + ')' }
        }
        list.push({ elementType: t, chance: entry.chance })
      }
      out[lf] = list
    }

    return { ok: true, def: out }
  }
```

Then, in the registration body, after elements and soils have been registered and before the unsupported reporting, add:

```js
      /*
       * Recipes come last: they name elements, and a corelib recipe usually
       * names a corelib element that had to be registered first. The lookup is
       * the vanilla table the main process sent, overlaid with the mod elements
       * the game gave a type number to in this same pass.
       */
      var recipes = payload.recipes || []
      if (recipes.length) {
        var names = {}
        var vanilla = payload.elementTypes || {}
        for (var vn in vanilla) {
          if (Object.prototype.hasOwnProperty.call(vanilla, vn)) names[vn] = vanilla[vn]
        }
        var modElements = (SMLN.sandkit && SMLN.sandkit.mods && SMLN.sandkit.mods.elements) || {}
        for (var mn in modElements) {
          if (!Object.prototype.hasOwnProperty.call(modElements, mn)) continue
          var me = modElements[mn]
          var mt = me && (me.elementType || (me.element && me.element.elementType))
          if (typeof mt === 'number') names[mn] = mt
        }
        var resolveName = function (name) { return names[name] }

        var live = SMLN.sandkit && SMLN.sandkit.structures && SMLN.sandkit.structures.recipes
        if (!live || typeof live.register !== 'function') {
          SMLN.log('warn', 'fluxloader: ' + recipes.length + ' recipe(s) were not registered - ' +
            'this build has no recipe registry (it arrived in Sandustry 0.5.6)')
        } else {
          for (var ri = 0; ri < recipes.length; ri++) {
            var rec = recipes[ri]
            var resolved = resolveRecipeElements(rec.def, resolveName)
            if (!resolved.ok) {
              SMLN.log('warn', 'fluxloader recipe "' + rec.id + '" was not registered: ' +
                resolved.reason)
              continue
            }
            try {
              api.recipe(SINGULAR_KIND[rec.kind] || rec.kind, resolved.def)
            } catch (e) {
              SMLN.log('warn', 'fluxloader recipe "' + rec.id + '" was rejected by the game: ' +
                ((e && e.message) || e))
            }
          }
        }
      }
```

Finally, at the unsupported reporting near line 138, drop the sentence claiming the build has no recipe registry, so the comment stops contradicting what now works:

```js
      // Say what could not be done and why, rather than leaving the player to
      // discover the missing content in-game.
```

- [ ] **Step 5: Run the test**

Run: `node tools/selftest.js > /tmp/t4.txt 2>&1; grep "recipes reach the game with their element names" /tmp/t4.txt; grep -E "passed, .* failed" /tmp/t4.txt`
Expected: PASS, and the summary shows 3 failures — the same three as after Task 1.

- [ ] **Step 6: Confirm the two unknown kind strings against the running game**

```bash
node install.js --no-steamcmd
cmd /c start "" "steam://rungameid/2764460"
```

With the game up, open its console (`^` or F1) and run:

```
SMLN.register.as('probe').recipe('contact', {inputA:1, inputB:3, outputA:4, outputB:null, orientation:'stacked'})
SMLN.register.as('probe').recipe('grower', {input:15, output:16, chance:1})
```

Expected: neither throws. If one throws naming an unknown kind, try the plural form (`contacts` / `growers`), note which the game accepted, and correct `SINGULAR_KIND` to match. Then close the game and:

```bash
node install.js --uninstall
```

- [ ] **Step 7: Commit**

```bash
git add src/compat/flux-content.js src/renderer/flux-register.js tools/selftest.js
git commit -m "Register Fluxloader recipes, with element names resolved to type numbers"
```


---

### Task 5: Stop documenting recipes as impossible

**Files:**
- Modify: `README.md` (the `Recipes.` bullet in `## Limitations and what's not built yet`, around line 793)
- Modify: `src/renderer/sandkit-shims.js` (the comment at lines 866-878; behaviour unchanged)
- Test: `tools/selftest.js`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Append to `tools/selftest.js`:

```js
check('the README no longer calls recipes impossible', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')
  assert(!/has no recipe registry at all/.test(readme),
    'the README still says the game has no recipe registry at all')
  assert(/recipe/i.test(readme), 'recipes vanished from the README entirely')
  assert(/kineticPress|contacts|nine machine categories/i.test(readme),
    'the README does not say what the 0.5.6 registry offers')
  return 'the recipe limitation reflects 0.5.6'
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/selftest.js 2>&1 | grep "no longer calls recipes impossible"`
Expected: FAIL — the old sentence is still there.

- [ ] **Step 3: Write minimal implementation**

In `README.md`, replace the whole `- **Recipes.** …` bullet with:

```markdown
- **Recipes work on 0.5.6, and only there.** Sandustry 0.5.6 added a recipe
  registry with nine machine categories — contacts, shakers, kineticPresses,
  growers, condensers, steamDryers, synthesizers, snowmakers and smelters.
  `SMLN.register.recipe()` registers into it, and corelib's four recipe kinds
  are translated onto the first four. On 0.5.5 and earlier there is no registry
  at all, and `register.recipe()` says so rather than pretending. corelib seeds
  about nine recipes the game already implements natively; those are forwarded
  too, so those reactions exist twice and a weighted output can shift.
```

In `src/renderer/sandkit-shims.js`, replace the comment block at lines 866-878 that asserts the build has no recipe registry with one that says why the shim is still there:

```js
    // --- structures.recipes: a stand-in for builds older than 0.5.6.
    /*
     * 0.5.6 ships a real registry and this whole branch stands down - the
     * `!api.structures.recipes` guard below is what does it. On 0.5.5 and
     * earlier there is nothing to register into, so the table exists only so
     * that a mod calling register() gets a definite answer instead of a
     * TypeError. Nothing reads it; the vanilla machines' inputs are hardcoded.
     */
```

Leave the code under it exactly as it is.

- [ ] **Step 4: Run the whole suite**

Run: `node tools/selftest.js > /tmp/t5.txt 2>&1; grep "no longer calls recipes impossible" /tmp/t5.txt; grep -E "passed, .* failed" /tmp/t5.txt; sed -n '/Failures:/,$p' /tmp/t5.txt`

Expected: PASS, and exactly three failures — the two host-ABI checks and `player.inventory.addFromId`.

- [ ] **Step 5: Commit**

```bash
git add README.md src/renderer/sandkit-shims.js tools/selftest.js
git commit -m "Say that recipes work on 0.5.6, because now they do"
```

---

## Final verification

- [ ] Run: `node tools/selftest.js 2>&1 | tail -8`
  Expected: **188 passed, 3 failed**. The three are the two host-ABI checks and `player.inventory.addFromId`; the two getApi checks that were red before Task 1 are green.
- [ ] Run: `node tools/e2e-attach.js --run`
  Expected: `PASSED` — the attach still installs, loads and reverts cleanly.
- [ ] Confirm `git status` shows no stray files and nothing left in the game directory.
