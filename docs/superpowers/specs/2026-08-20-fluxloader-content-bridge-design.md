# Fluxloader content bridge

**Date:** 2026-08-20
**Status:** approved, not yet implemented
**Game:** Sandustry 0.5.5
**Goal:** Fluxloader mods register real content on 0.5.5 without modifying the mods or corelib.

## Problem

Fluxloader mods register no content on Sandustry 0.5.5. Two independent
failures, one already fixed:

1. **The event was never fired** (fixed). corelib registers nothing while its
   entrypoint runs; it defers all ~92 patches to `fl:pre-scene-loaded`, and
   SandLoader never emitted that event. Mods loaded cleanly and queued nothing.
   Fixed in `src/compat/fluxloader.js` by declaring and emitting the event
   after entrypoints load and before patches are harvested.

2. **corelib's patches do not match this build** (this spec). With the event
   firing, corelib queues 92 patches. Measured against the shipped bundle:

   | | count |
   |---|---|
   | patches queued | 92 |
   | anchor present in some shipped file | 17 |
   | anchor present in **no** shipped file | **75** |
   | queued for `bundle.js` but living elsewhere | 0 |

   The anchors are absent, not relocated. corelib 3.1.3 targets a chunk-split
   build (`js/336.bundle.js`, `js/515.bundle.js`, `js/546.bundle.js`); 0.5.5
   ships a single unsplit `bundle.js` and no webpack chunk loader
   (`__webpack_require__.e` is absent).

   The data shape also changed. Live registry entries read
   `{nameKey:"elements|sand|name", density:150, matterType:1, metaColor:16032864}` —
   49 of 50 entries use `nameKey`, and `matterType` is a plain number on every
   entry. corelib emits `name:"Trash"` and `matterType:X.Slushy`, an enum
   reference. Retargeting the patches would still produce entries the game
   cannot read.

Because a required patch that misses aborts the whole run
(`src/patch/engine.js`), one stale anchor discards all 61 bundle patches.
Relaxing `required` would raise 0 applied to ~17 while element registration
stayed broken — a green log with no content, which is worse than failing loudly.

## Key insight

corelib's patch approach is unsalvageable here, and does not need salvaging.
**Sandustry 0.5.5 ships a native registration API**, and **SandLoader already
wraps it.**

`sandkit` exposes `elements`, `items`, `structures`, `matters`, `schedule`,
`terrains`, and more, each with `register()`. `sandkit.elements.register`
auto-allocates the next element type id, stores into `sandkit.mods.elements`,
registers colors into the session scheme, and handles `metaColor` — precisely
what corelib's 12 element patches hand-rolled.

`src/renderer/registration.js` (582 lines) already wraps that API as
`SMLN.register` with load-time queuing, per-mod ownership, error isolation, and
feature detection.

So the bridge translates corelib's calls into `SMLN.register` calls. It does
not generate patches.

### Why not runtime object mutation

The live registry is extensible — a probe added and removed an element
successfully. But there are **18 simulation workers**, each with its own copy;
a renderer-side write reaches none of them. Sandkit's own `register`
propagates through the game's machinery, which is why corelib patched source
text in the first place. The bridge must go through Sandkit, not around it.

## Architecture

New module `src/compat/flux-content.js`. When a Fluxloader mod publishes
`globalThis.corelib`, SandLoader replaces corelib's content modules with shims
that capture registrations instead of queuing patches.

```
trashelement: corelib.elements.registerElement({id:"Trash", ...})
      |  (mod source unchanged, corelib source unchanged)
      v
flux-content shim captures the definition
      |  translate: name -> nameKey, "Slushy" -> matterType 6,
      |             colors -> session scheme, density/metaColor passthrough
      v
SMLN.register.element(def)  ->  sandkit.elements.register(state, def)
      |
      v
propagates to all 19 contexts through the game's own registration path
```

### Where the shim is installed

corelib's electron entrypoint ends on `globalThis.corelib = new CoreLib()`
followed by `corelib.init()`. The shim replaces the content modules after
`init()` and before `fl:pre-scene-loaded` fires, so registrations are captured
rather than turned into patches.

The captured definitions cross to the renderer over the existing IPC bridge.
corelib already does exactly this: its game entrypoint awaits
`fluxloaderAPI.invokeElectronIPC("corelib:getModuleRegistrations")`, and
`src/compat/flux-messaging.js` already implements
`invokeElectronIPC`/`handleGameIPC`. No new transport is needed.

### Suppressing the stale patches

With content routed through Sandkit, corelib's element/soil patches are both
broken and redundant. The bridge drops the patches whose subsystem it has
taken over, and leaves every other corelib patch untouched, so anything that
still matches this build keeps working.

## Translation

Verified against the live registry.

| corelib field | 0.5.5 target | Rule |
|---|---|---|
| `id` | `id` | passthrough; also derives `nameKey` |
| `name` | `nameKey` | game derives `elements\|<id>\|name` from `name` and registers the English fallback itself (see `registration.js` header) |
| `matterType` (string) | `matterType` (number) | map via the live matter enum: Solid 1, Liquid 2, Particle 3, Gas 4, Static 5, Slushy 6, Wisp 7, Powder 8 |
| `colors` (RGBA array) | session colour scheme | `sandkit.elements.register` applies `def.colors` itself |
| `density` | `density` | passthrough |
| `interactsWithHoverText` | interactions | passthrough where the build accepts it |
| `addToFilterList` | filter list | passthrough where supported |

Soils (`registerSoil`) carry `hp`, `chanceForOutput`, `outputElement`,
`colorHSL`, `onlyRocketBreakable`; they map onto terrain/element registration
with `colorHSL` converted to RGBA.

The matter-type mapping is read from the live enum at runtime, never
hard-coded, so a future build that renumbers matter types does not silently
mis-register.

## Scope

Requested: everything corelib exposes. What 0.5.5 actually supports:

Sandkit 0.5.5 exposes **79 namespaces** carrying **20 registration methods**,
enumerated from the live game:

```
matters.register        elements.register      terrains.register
items.register          projectiles.register   structures.register
misc.register           triggers.register      upgrades.register
debug.register          i18n.register          conveyors.registerType
launchers.registerType  energy.registerType    strataform.registerType
entities.registerType   entities.registerSpawner
queue.registerHandler   input.registerKeyBinding
swarmConsole.registerEntityType  retroConsole.registerGame
```

| corelib subsystem | 0.5.5 target | Status |
|---|---|---|
| elements, soils | `sandkit.elements`, `sandkit.terrains` | supported |
| matterTypes | `sandkit.matters.register` | supported |
| items | `sandkit.items.register` | supported |
| blocks / structures | `sandkit.structures.register` | supported |
| tech | `sandkit.tech.addDefinition` | supported |
| upgrades | `sandkit.upgrades.register` | supported |
| schedules | `sandkit.schedule` | partial (`nextTick` only) |
| **recipes** | **no registry exists** | **cannot work** |
| colorIdFix | fixes an older engine bug | likely obsolete on 0.5.5 |

Tech uses `addDefinition`/`updateDefinition` rather than `register`; upgrades
use `register`. Both are real targets, so corelib's tech and upgrade
subsystems are in scope.

### Recipes cannot work

Confirmed absent in the live game: `sandkit.structures.recipes` is undefined,
`sandkit.factory` carries no recipe table, and no namespace among the 79
matches `/recipe/i`. Content probes for `inputs`/`outputs`, `input`/`output`,
`from`/`to` and `reaction` shapes all return zero modules. This matches the
existing README note ("Sandustry 0.5.5 has no recipe registry at all") and the
feature-detected `register.recipe` already in `registration.js`.

trashelement's two recipe calls (`registerPressRecipe`,
`registerShakerRecipe`) will report unavailable. Its three elements will
register. This is a limit of the game build, not of the bridge.

## Diagnostics (option 2, folded in)

Detection is not a separate feature; it is the bridge's reporting. For every
corelib call the bridge records one of:

- `registered` — translated and accepted by Sandkit
- `unavailable` — no 0.5.5 target exists (recipes), with the reason
- `failed` — target exists, registration threw, with the error

Reported per mod through the existing problems channel, so the mod manager and
log show why a mod registered nothing instead of failing silently. On a build
whose registry shape the bridge does not recognise, it says so rather than
guessing.

## Error handling

- One bad definition fails that definition only; `registration.js` already
  isolates per-entry failures and attributes them to the owning mod.
- If Sandkit is absent, the bridge reports unavailable and leaves corelib's
  original patch path untouched, so behaviour is no worse than today.
- Translation is total: an unmappable `matterType` is reported, not coerced to
  a default that would put an element in the wrong physics class.

## Testing

TDD. Fixtures are shapes captured from the live game, not invented.

**Unit** — translation in isolation:
- `name` -> `nameKey` derivation
- matter-type string -> live numeric id, including the unmappable case
- RGBA and HSL colour handling
- soil field mapping

**Integration** — against real mods:
- trashelement's Trash, CompressedTrash, TrashSoil each reach
  `SMLN.register.element` with a 0.5.5-correct definition
- its two recipe calls report `unavailable`, not silent success
- corelib's element/soil patches are dropped; its other patches are untouched
- a mod using no corelib still loads unchanged

**Live (MCP)** — the acceptance test:
- `hasTrash` in the live element registry becomes **true**
- element count rises from 50
- no new console errors

## Files

| File | Change |
|---|---|
| `src/compat/flux-content.js` | new — interception, translation, diagnostics |
| `src/compat/fluxloader.js` | install the shim after entrypoints load (small) |
| `src/renderer/registration.js` | reuse as-is; extend only if a gap appears |
| `tools/selftest.js` | unit + integration tests |
| `README.md` | document the bridge and the recipe limitation |

## Out of scope

- Modifying corelib or any mod (explicit requirement).
- Reimplementing subsystems 0.5.5 has no target for (recipes).
- Backporting to other game versions; the matter map is read at runtime, but
  only 0.5.5 is verified.
