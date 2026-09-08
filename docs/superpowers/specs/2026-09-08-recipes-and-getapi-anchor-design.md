# getApi anchor, and recipes that actually register

**Date:** 2026-09-08
**Status:** approved, not yet implemented
**Game:** Sandustry 0.5.6 (Steam, Electron 33.2.1)
**Goal:** Restore the single entry point every mod goes through on 0.5.6, and
turn `register.recipe()` from a documented impossibility into a working call.

## Problem

### 1. The mod API is dead on 0.5.6

The renderer builds its Sandkit object as registries only and then calls
`state.sandkit.getApi()` without ever defining it — 45 call sites in the shipped
`dist/js/bundle.js` (44 on 0.5.5). The method is a field the mod host is
expected to attach; Sandustry ships no host and delegates to whatever occupies
the loader slot. `src/patch/core-patches.js` supplies it, anchored on the
assignment:

```js
find: /sandkit=\{(mods:\{[^]{0,400}?keyBindings:\{\})\}/g
```

Both that pattern and its one variant require the object literal to be assigned
directly to `sandkit`. On 0.5.6 it is not. The object is built first and only
the identifier is assigned:

```js
…events:{},hooks:{},keyBindings:{}});E.jsonConfigs=x,M.sandkit=E,…
```

So the patch does not apply, `getApi` is never defined, and every one of those
45 call sites — the game's own, not ours — hits `undefined`. Nothing a mod
registers can work, because there is no API object to register against. The
self-test reports this as two of its five standing failures:

```
- anchors re-resolve when the shape around the literal moves:
    {"healed":[],"broken":["smln:sandkit-get-api"]}
- the getApi patch applies once and yields a working Sandkit API:
    patch did not apply: anchor did not match
```

This is not a missing capability. It is the floor under every other one.

### 2. Recipes became possible and the code still says they are not

The README's first listed limitation:

> **Recipes.** Sandustry 0.5.5 has no recipe registry at all — `recipes`
> appears nowhere in the build's API object.

On 0.5.6 it appears 22 times, and the registry is real. Its shape, read out of
the bundle:

```js
r = {contacts:[], shakers:[], kineticPresses:[], growers:[], condensers:[],
     steamDryers:[], synthesizers:[], snowmakers:[], smelters:[]}
…
structures:{ recipes:{
  getWeightedRecipe:(e,t,n)=>…,
  selectWeightedOutput:(e,t)=>…,
  register:(e,t,n)=>{ Xe(e,t,n) } } }
```

Nine machine categories, and `register(state, kind, def)` — state-first, which
is the arity and order `src/renderer/registration.js:356` already calls with.
The registry validates its own input and throws: at least one output, each
`chance` between 0 and 1, chances totalling no more than 1, and
`"Sandkit must be initialized before registering recipes."` when
`state.sandkit.mods` is absent.

So `register.recipe` needs no new plumbing. What is wrong is that three places
assert the registry cannot exist:

| file | what it does today |
|---|---|
| `src/compat/flux-content.js:246` | replaces corelib's recipe functions with a stub that records "this build has no recipe registry" |
| `src/renderer/sandkit-shims.js:878` | installs a dead in-memory recipe table when `api.structures.recipes` is missing |
| `src/renderer/flux-register.js:139` | reports every recipe a mod declared as missing content |

The shim already stands down when the real registry is present
(`if (api.structures && !api.structures.recipes)`). The other two do not.

## Design

### The third anchor variant

Anchor on the assignment rather than on the literal, and append to whatever was
assigned:

```js
find:    /sandkit=([A-Za-z_$][\w$]*)(?=[,;])/g
replace: `sandkit=${id},${id}.getApi=${id}.getApi||function(){…}`
```

`M.sandkit=E,` becomes `M.sandkit=E,E.getApi=E.getApi||function(){…},` — valid
inside the comma expression it sits in, and valid after a `;` too. How `E` was
built stops mattering, which is exactly what defeated the existing variants.

It goes *after* the two existing patterns so builds that still assign an object
literal are served unchanged, and it requires an identifier where they require
`{`, so the two cannot both match the same text. The `getApi||` guard leaves a
future build that defines its own alone.

The returned API is unchanged from the current patch: the captured runtime's
`FH`, falling back to the raw global. The game's 45 call sites are the game's,
not ours — breaking them would break vanilla gameplay, which outranks loading
any mod.

### Recipes

`register.recipe` is left as it is. The work is removing the assumption that the
registry cannot exist, and translating what Fluxloader mods send.

New in `src/compat/flux-translate.js`: `translateRecipe(kind, config)`, mapping
corelib's four shapes onto the game's categories.

| corelib | game | config corelib sends |
|---|---|---|
| `basic` | `contacts` | `{inputTop, inputBottom, outputTop, outputBottom}` |
| `press` | `kineticPresses` | `{input, outputs: [["Spore", 1], …]}` |
| `grower` | `growers` | `{input, output}` |
| `shaker` | `shakers` | `{input, outputAbove: [["Slag", 1]], outputBelow: […]}` |

Element names resolve to `elementType` numbers in two steps, because neither
source alone is enough. `flux-translate.js` has `matterTypeToNumber`, but that
is the *matter* table, not the element one, and it does not answer this.

1. The live API first: `api.elements.getRegisteredTypes()` and
   `structures.resolveTypeName()` exist on 0.5.6 and know about elements mods
   registered earlier in the same run — which is the case that matters, since a
   corelib recipe usually consumes a corelib element.
2. `enums.ElementType` (`src/game/enums.js:32`) as the fallback for vanilla
   names, so a recipe naming `Water` resolves even before any mod content is in.

Output pairs become `{elementType, chance}`. The game's remaining five categories — condensers,
steamDryers, synthesizers, snowmakers, smelters — have no corelib equivalent
and are reachable only through `SMLN.register.recipe()` directly.

`registerConveyorBeltIgnores`, `registerGrowerAllows` and `registerShakerAllows`
are element allow-lists, not recipes. They stay untranslated and keep being
reported as unsupported; inventing a recipe for them would be worse than saying
so.

### Vanilla seeds are forwarded

corelib's constructor registers about nine recipes the game already implements
natively — `Sand + Water → WetSand`, `Lava + Water → Steam`, and so on. Under
Fluxloader corelib replaces the vanilla behaviour by patching; under SandLoader
we bridge to the native registry instead, so those two do not cancel out.

**Decision: forward everything, including the seeds.** No special-casing, no
list of known-vanilla recipes to maintain, and no risk of silently dropping a
recipe a mod meant to add.

The cost, stated plainly: those reactions then exist twice — once hardcoded in
the game and once as a mod recipe — and where the game picks a weighted output,
a duplicate entry shifts the distribution. If that turns out to matter in play,
skipping the seeds is a small, contained change to `translateRecipe`'s caller,
not a redesign.

### Failing honestly

The registry throws on invalid input, and a name that does not resolve produces
`elementType: undefined` if passed through. Neither is allowed to end the load:

- a throw from `recipes.register` is recorded as a problem carrying the mod id,
  the recipe kind and the game's own message
- an unresolvable element name is recorded the same way and the recipe is
  skipped, rather than registered with an undefined type

This matches how the content bridge already reports untranslatable content, so
a player sees it in the mod UI instead of losing the mod.

## Verification

Plain-Node self-test:

- `translateRecipe` for all four corelib shapes, including output pairs and
  chance passthrough
- an unresolvable element name is reported and the recipe skipped
- allow-list calls stay unsupported and are not mistaken for recipes
- the new anchor variant's regex against both bundle shapes: the 0.5.6
  identifier assignment matches, and a 0.5.5-style object literal is left to
  the earlier patterns

Against the real installed bundle, already in the suite and currently red:

- `anchors re-resolve when the shape around the literal moves` — goes green
- `the getApi patch applies once and yields a working Sandkit API` — goes green

Both are the proof for the anchor work; nothing else in this spec can be
trusted while they are red.

In the running game, through the debug bridge the shadow attach now makes
reachable: `state.sandkit.getApi()` resolves, and a recipe registered through
`SMLN.register.recipe()` is present in `sandkit.mods.recipes`.

## Risks

- **Duplicate vanilla reactions**, as decided above.
- **corelib's config shapes are read from its source, not a specification.** A
  fifth shape that no bundled mod happens to use would be missed. The
  unsupported-content report is what surfaces that, rather than a silent drop.
- **The other three standing self-test failures are out of scope.** The host-ABI
  pair belongs to the removed loader slot, and `player.inventory.addFromId` is
  an API-scan gap in a bundled mod. This spec touches none of them and they stay
  red.

## Non-goals

The worker-side Sandkit surface, map-mod loading, and the game's own
`MODDING_ENABLED` pipeline each have their own gap and their own spec. Nothing
here anticipates them.
