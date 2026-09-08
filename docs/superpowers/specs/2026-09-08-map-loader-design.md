# Map loader

**Date:** 2026-09-08
**Status:** approved, not yet implemented
**Game:** Sandustry 0.5.6 (Steam, Electron 33.2.1)
**Goal:** Make custom maps loadable and playable from SandLoader — both the
player's own and the ones a mod ships.

Sub-project 1 of three. The generator and the builder UI have their own specs.

## Problem

SandLoader detects map mods and then declines them:

```js
// src/main/entry.js:1226
if (mod.map) {
  logger.warn(`${mod.id} is a map mod; map blueprints need game-side support and are not loaded yet`)
}
```

`src/mods/official.js:127` already reads a map mod's `map.blueprints` and
resolves every path. The blueprints arrive and are dropped on the floor.

The README repeats the reason:

> **Map mods.** Custom-map blueprints are discovered and reported, but loading
> them needs game-side support that is not exposed.

That is false. The support is exposed, complete, and unused.

### What the game already ships

`resources/app.asar/preload.js`:

```js
customMaps: {
  save:   (id, name, data) => ipcRenderer.invoke('custom-map-save', { id, name, data }),
  load:   (id)             => ipcRenderer.invoke('custom-map-load', id),
  list:   ()               => ipcRenderer.invoke('custom-map-list'),
  delete: (id)             => ipcRenderer.invoke('custom-map-delete', id),
}
```

All four are registered in `main.js` with `ipcMain.handle`, outside the
`MODDING_ENABLED` branch, so they work today. They read and write a folder
`main.js` calls `getCustomMapsPath()` — `<userData>/custom_maps`, which exists
on this machine and is empty.

The renderer consumes a map with six layers, read out of the shipped bundle:

```js
const [n, r, o, a, i, s] = await Promise.all([
  Ya(t.terrain), Ya(t.lights), Ya(t.lightsMeta),
  Ya(t.sensors), Ya(t.authorization), Ya(t.wall),
])
```

alongside `seed`, `createdAt`, `version` and `params`. Starting one is the
game's own navigation:

```js
(0, ce.J)(`custom_map=${n}`, () => …fadeOut(300))
```

And there is a whole screen for it — `CustomMapsScreen = 27` in the UI enum,
with 42 references in the bundle and its own localisation: "Custom Maps",
"Saved Maps ({count})", "No custom maps saved.", "Start new game with this map".
It ships switched off.

So the game does the loading, the starting and the browsing. What is missing is
someone to put a mod's map where it looks, and to turn the screen on.

## Design

### Two sources, one destination

The player's own maps in `<userData>/custom_maps` already work once the screen is
on; SandLoader does not touch them. Map mods gain a path to the same folder.

### What a map mod ships

`smln.mod.json` grows nothing — `map.blueprints` is already read. The keys are
the game's own layer names, so nothing has to be translated:

| key | required |
|---|---|
| `terrain` | yes |
| `lights`, `lightsMeta`, `sensors`, `authorization`, `wall` | no |

Which of the five are genuinely optional is decided by what the game's `Ya`
helper does with `undefined`; the implementation plan verifies that against the
shipped bundle rather than assuming it. A mod may also carry `seed` and `params`
in its `map` object, which travel into the file unchanged.

### Assembling the file

SandLoader reads each blueprint PNG, encodes it as a data URL, and writes a
`.custommap` — the JSON shape above — straight into `<userData>/custom_maps`
from the main process.

Writing the file directly rather than calling `custom-map-save` is deliberate:
the IPC lives in the renderer's preload and would make map installation depend
on a running game window, when the loader knows the path already and installs
before the window exists.

### Names that cannot collide

A mod's map is written as `smln.<modId>.<key>.custommap`. The prefix does three
things: it keeps a mod from overwriting a map the player made, it makes the
origin visible in the browser, and it is what makes pruning safe — SandLoader
only ever deletes files it can prove it wrote.

### Lifecycle

On every load: rewrite the maps of enabled map mods, and delete `smln.*` files
whose mod is gone or disabled. A file without the prefix is never touched, under
any circumstance. An updated mod therefore ships an updated map, and removing a
mod removes its maps, without the player cleaning up by hand.

### Unlocking the browser

Measured: the switch is a literal in the shipped bundle, beside its sibling for
the mods screen.

```js
mods:{showSubscribedMods:!1},customMaps:{showCustomMaps:!1},procgen:{...}
```

It is compiled in, not read from a JSON file, so turning it on is a patch:
`customMaps:{showCustomMaps:!1}` becomes `customMaps:{showCustomMaps:!0}`. One
match, and `required: false`, because a build that moves the literal must cost
the browser screen and never the game. Autoheal reports it like any other
anchor.

### Failing honestly

Per map, never per load:

- a blueprint that is not a readable PNG
- a missing `terrain`
- layers whose dimensions disagree with each other

Each is recorded through the existing problems channel with the mod's id and the
blueprint key, and the remaining maps still install. The warning at
`entry.js:1226` goes away, because it stops being true.

## Verification

Plain Node, against a fabricated mod directory:

- blueprint PNGs become a `.custommap` whose six fields are data URLs
- the file lands under the `smln.<modId>.<key>` name
- a map from a disabled or absent mod is pruned
- a file without the prefix survives pruning, including one named to look close
- a missing `terrain`, an unreadable PNG and mismatched dimensions are each
  reported and do not stop the other maps

In the running game: a map mod's map appears in the browser and starts. That
check is the one that matters, because the last three sub-projects each had a
defect no unit test could have found.

## Risks

- **The browser switch is a compiled-in literal.** One match in a 4 MiB
  bundle, so a build that reshapes that config object silently costs the
  screen. The anchor check reports it, and nothing else depends on it.
- **Layer dimensions and formats are inferred from the game's loader, not from
  documentation.** A map that assembles cleanly can still be rejected at load.
- **Writing into the player's own map folder.** The prefix rule and the
  never-touch-what-we-did-not-write rule are what keep that safe, and the tests
  guard them explicitly.

## Non-goals

Generating maps and editing them — sub-projects 2 and 3. Nothing here reads or
copies `mods/uolkx.map-studio`, a third-party mod with no licence; the facts
about the game in this spec were each verified against the shipped bundle.
