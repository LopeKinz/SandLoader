# Sandustry modding reference

**What Sandustry looks like on the inside, and every kind of mod that runs on
it.** Three mod formats exist in the wild and SandLoader loads all three; this
document covers the game itself, all three formats, and where each one's limits
actually lie.

For the full detail of SandLoader's own API — permissions, capabilities,
storage, hot reload, console commands — see
[WRITING-MODS.md](WRITING-MODS.md). This document is the map; that one is the
manual for one territory on it.

Everything here was verified against **Sandustry 0.5.5** (Steam AppID 2764460).
Where a number appears, it was measured from the real bundle or a real game
start, not estimated.

## Contents

**The game**
- [How the game is built](#how-the-game-is-built)
- [The content types](#the-content-types)
- [How SandLoader gets in](#how-sandloader-gets-in)

**The three mod formats**
- [Which format is which](#which-format-is-which)
- [SMLN mods](#smln-mods)
- [Official (Sandkit) mods](#official-sandkit-mods)
- [Fluxloader mods](#fluxloader-mods-what-works-and-what-doesnt)
- [The content bridge](#the-content-bridge)
- [Writing a Fluxloader mod](#writing-a-fluxloader-mod)

**Content mods**
- [Map mods](#map-mods)
- [Skin mods](#skin-mods)

**Practice**
- [Troubleshooting](#troubleshooting)

---

## How the game is built

Sandustry is an Electron app:

| | |
|---|---|
| Electron | 33.2.1 |
| Chromium | 130 |
| Node | 20.18.1 |
| Game code | `resources/app.asar` |

The code lives **inside the asar archive**, not as loose files. Electron reads
into it with the ordinary `fs` module as if it were a directory — paths look
like `.../app.asar/dist/img/foo.png` and simply work.

### The four bundles

```
dist/index.html
dist/js/bundle.js              3.8 MB   Renderer: UI, rendering, game logic
dist/js/simulation-worker.js   1272 KB  Particle simulation
dist/js/utility-worker.js      1225 KB
dist/js/manager-worker.js        46 KB  Coordination
```

All of it is **minified**. Variables are named `d`, `l`, `Vh`. That is why
patches break so easily: an anchor like
`;if(l.structureType===d.GloomEmitter` depends on names the minifier is free to
reassign on every build.

### The threading model — this matters for mods

The simulation runs across **18 worker threads**. Each holds its **own copy** of
the element registry.

One rule follows from that, and it explains a lot of mod bugs:

> Writing an element into a registry object by hand reaches **none** of the
> threads. Only the game's own registration path distributes it to all of them.

This is why SandLoader always calls the game's real API instead of mutating
objects. A mod doing `registry.elements[myId] = {...}` will see its element in
the inventory and crash when spawning it.

---

## The content types

0.5.5 knows these content types (counts are built-in entries):

| Type | Count | Registrable? |
|---|---|---|
| Elements | 20 | ✅ `elements.register` |
| Terrains (soils) | 34 | ✅ `terrains.register` |
| Structures (machines) | 27 | ✅ `registerStructure` |
| Tech nodes | 104 | ✅ `addTechDefinition` |
| Tools | 16 | — |
| **Upgrades** | — | ❌ **does not exist** |
| **Recipes** | — | ❌ **does not exist** |

The last two are not gaps in SandLoader but in the game: the entire bundle
contains **no** function for registering upgrades or recipes. Verified:
`addUpgradeDefinition` → 0 matches, `registerUpgrade` → 0 matches.

### MatterType

Elements need a numeric `matterType`:

| # | Name | # | Name |
|---|---|---|---|
| 1 | Solid | 5 | Static |
| 2 | Liquid | 6 | Slushy |
| 3 | Particle | 7 | Wisp |
| 4 | Gas | 8 | Powder |

Fluxloader mods write the **name** (`"Slushy"`); 0.5.5 stores the **number**
(`6`). `src/compat/flux-translate.js` does the conversion.

### nameKey — the most common beginner mistake

0.5.5 stores no display names, only **i18n keys**. Every type has its **own
namespace**:

```
elements|trash|name
terrains|trashsoil|name
structures|portal|name
items|blinker|name
```

If the key is not registered, the game shows literally
`[MISSING: elements|trash|name]` in the tooltip. And a soil filed under
`elements|...` by mistake will never resolve.

Second trap: **register for the player's locale, not only `en`.** A German
client looks up `de` and will not find a translation registered only under `en`.

---

## How SandLoader gets in

SandLoader **never modifies game files**. It takes over the `file://` protocol
and patches the bundles **in memory**, on the way to the renderer.

That means:

- installed files stay untouched
- Steam file validation stays green
- a game update cannot leave a stale patched bundle behind

### Two ways to get content into the game

**1. Patches** — text replacement in the bundle. Powerful but fragile: the
anchor text must exist exactly.

**2. Registration** — calling the game's own API. Survives updates, because it
does not depend on minified names.

> **Rule of thumb:** register content, patch behaviour. And when you must patch,
> choose semantic anchors (strings, key names) over minified variable names.

### Atomic patch groups

All of one mod's patches for **one file** form a group and apply together:
either all of them or none.

The reason is practical. corelib's `colorIdFix` changes buffer sizing in one
patch and the readers of that buffer in the next. Applying only half produces a
bundle that is internally inconsistent — a black screen. Aborting the whole file
would take SandLoader's own patches down with it. The group is the third option.

---

## Which format is which

Three manifests exist in the wild. SandLoader reads all of them and tells them
apart by **which keys are present**, never by guessing:

| Format | Manifest | Identifying key | Loaded by |
|---|---|---|---|
| SMLN | `smln.mod.json` | filename | SandLoader |
| Official (Sandkit) | `modinfo.json` | `manifestVersion` | the game's own loader |
| Fluxloader | `modinfo.json` | `modID` | SandLoader's compat layer |

Note the collision: official and Fluxloader mods **share a filename**. The
`manifestVersion` key is what separates them.

### Where mods live

```
<SandLoader>/mods/                     bundled with the loader
%APPDATA%\sandustry\smln-mods\         your SMLN mods
%APPDATA%\sandustry\fluxloader-mods\   your Fluxloader mods
%APPDATA%\sandustry\mods\              official mods (game-managed)
%APPDATA%\sandustry\custom_maps\       .custommap files
```

### What each format can do

| | SMLN | Official | Fluxloader |
|---|---|---|---|
| Register elements / terrain | ✅ | ✅ | ✅ via bridge |
| Register structures | ✅ | ✅ | ✅ via bridge |
| Register tech nodes | ✅ | ✅ | ✅ via bridge |
| Patch the bundle | ✅ | ✅ `patches.json` | ✅ |
| Asset / texture overrides | ✅ | ✅ `assets/` | ✅ |
| Worker-thread code | ✅ | ✅ | ✅ |
| Main-process code | ✅ with `node` | ✅ | ✅ |
| Declared permissions | ✅ | — | — |
| Private per-mod storage | ✅ | — | — |
| Console commands | ✅ | — | — |
| Runs without SandLoader | — | ✅ | — |
| Steam Workshop | — | ✅ | — |

Hot reload is driven by the file watcher and is not restricted to one format,
but how far a reload gets depends on which entrypoint changed: renderer and
worker code can be re-run, while a main-process entrypoint needs a restart and
the loader says so.

### Choosing a format for new work

- **Writing something new?** Use **SMLN**. It has the richest API, real
  permissions, hot reload and the best error reporting.
- **Publishing to the Workshop?** Use the **official** format — that is what
  the game itself loads.
- **Fluxloader** is for compatibility with mods that already exist. There is
  little reason to start a new mod in it.

---

## SMLN mods

SandLoader's own format. The manifest is `smln.mod.json`:

```json
{
  "id": "example-hello",
  "name": "Hello Example",
  "version": "1.0.0",
  "priority": 100,
  "renderer": "renderer.js"
}
```

Entrypoints are named by role, and each one runs somewhere different. Two
spellings are accepted — the flat fields are the original, the `entrypoints`
object is the newer one:

| Flat field | Inside `entrypoints` | Runs in |
|---|---|---|
| `renderer` | `game` | the browser context, with `SMLN` |
| — | `worker` | the simulation/utility worker threads |
| `main` | `native` | the main process, with real Node.js |

```json
{
  "id": "my-mod",
  "version": "1.0.0",
  "entrypoints": {
    "game": "renderer.js",
    "worker": "worker.js",
    "native": "main.js"
  }
}
```

### Permission tiers

This is what SMLN has that the other two formats do not:

| Tier | What it can reach |
|---|---|
| `SANDBOXED` | game API, worker API, config, its own private storage |
| `ELEVATED` | the above plus `SMLN.net` and/or `SMLN.fs` |
| `NATIVE` | real Node.js — the same privileges as the game itself |

```json
{ "permissions": ["network", "filesystem", "node"] }
```

A permission that was not declared is genuinely unavailable at runtime, not just
undocumented: `SMLN.net.fetch()` in a mod without `network` rejects with
`E_PERMISSION_DENIED` and never touches the network stack.

The honest caveat, which SandLoader states rather than hides: a mod granted
`node` gets a real `require`, and from there `fs`, `net` and `child_process` are
one line away. So `filesystem` and `network` do **not** restrict a native mod —
the capability object reports `enforceable: false`, and the mod manager shows
that sentence too.

### Registering content

```js
const api = SMLN.register.as('my-mod')

api.element({ id: 'Trash', name: 'Trash', matterType: 1, density: 120 })
api.terrain({ id: 'TrashSoil', /* ... */ })
api.structure({ id: 'Melter', /* ... */ })
api.machine({ /* alias of structure */ })
api.sprite('melter', 'assets/melter.png')
api.keyBinding('my-mod:toggle', ['Alt', 'K'])
api.conveyorType('Melter', { /* ... */ })
api.hook('someHook', fn)
```

`SMLN.register` queues calls until the game is ready, attributes failures to the
right mod, and isolates one bad definition from the rest — a mod registering
five elements and getting one wrong loses only that one.

See [WRITING-MODS.md](WRITING-MODS.md) for the full surface: storage, network,
filesystem, translations, settings, messaging, hot reload, console commands.

---

## Official (Sandkit) mods

Sandustry's own format, `manifestVersion: 1`. This is what the Steam Workshop
distributes.

```
my-mod/
  modinfo.json     manifest
  main.js          entry       - main thread
  worker.js        workerEntry - manager and simulation worker threads
  patches.json     bundle patches
  config/          overrides native JSON configs
  assets/          overrides textures
  map/             blueprints and config for custom maps
```

```json
{
  "manifestVersion": 1,
  "id": "author.mod-name",
  "name": "My Mod",
  "version": "0.2.0",
  "apiVersion": 1,
  "entry": "main.js",
  "dependencies": [],
  "loadOrder": 0,
  "configSchema": {
    "enabled": { "type": "boolean", "default": true }
  }
}
```

The id convention is `author.mod-name`.

### Who actually runs these

**The game does, not SandLoader.** Official entrypoints are lifecycle-sensitive:
Sandustry must execute `entry` during world initialisation and `workerEntry`
through its own worker-only Sandkit surface. So SandLoader mirrors enabled
official mods into the game's native local-mod directory and lets the game's own
loader run them.

SandLoader still handles their **patches and asset overrides**, because it owns
the file interceptor on builds where the host patcher is inactive.

The practical consequence: an official mod is the most "native" thing you can
write, and the least dependent on SandLoader being present.

### Workshop mods

Workshop items arrive in the official format with a `workshop.json` alongside.
They are marked non-removable in the manager — uninstall by unsubscribing in
Steam. SandLoader can also fetch them via SteamCMD for non-Steam installs.

---

## Fluxloader mods: what works and what doesn't

SandLoader emulates Fluxloader's API. Existing mods run **unchanged** — keep
`modinfo.json`, the three entrypoints and the global `fluxloaderAPI`.

### What works

| Area | Status |
|---|---|
| Elements, soils | ✅ via the content bridge |
| Blocks (machines) | ✅ as structures |
| Tech nodes | ✅ |
| Maps | ✅ |
| Skins / textures | ✅ as file overrides |
| Events, IPC, worker messaging | ✅ |
| Config schemas, `mod.script.js` | ✅ |
| Patches | ⚠️ only when the anchor still matches |
| Upgrades | ❌ the game cannot |
| Recipes | ❌ the game cannot |

### The hard truth about older mods

Many Fluxloader mods were written against older Sandustry versions. Their patch
anchors no longer exist in 0.5.5. Measured on a real 0.5.5 start with corelib
3.1.3: of **56** corelib patches reaching the bundle, **46 find zero matches**,
and the remaining ones are dropped with their atomic group. **Zero corelib
patches applied.**

This distinction is worth internalising:

> SandLoader can bridge **content** — definitions get translated and handed to
> the new API. It cannot bridge **behaviour**: a patch needs anchor text that
> occurs in the build. If it is gone, it is gone.

A concrete example: the `portals` mod registers its Portal structure
successfully — it appears in the inventory and can be placed. But its placement
logic lives in a patch anchored on
`;if(l.structureType===d.GloomEmitter`, which does not exist in 0.5.5. So the
portal is **visible but inert**.

Fixing that would mean rewriting the mod's own patch.

---

## The content bridge

The mechanism that lets old mods register content anyway.

### The problem

corelib registers content by patching the bundle. On 0.5.5 that fails — and even
if the anchors matched, corelib would emit entries in the **old format**
(`{name: "Cinder"}` instead of
`{nameKey: "elements|basalt|name", matterType: 1}`).

### The solution

SandLoader swaps corelib's content modules for **capturing shims** — the instant
corelib publishes itself, **before** the next mod loads. The flow:

```
mod calls corelib.elements.registerElement(...)
        ↓
shim intercepts the call
        ↓
translation into 0.5.5 shape (flux-translate.js)
        ↓
IPC into the renderer
        ↓
SMLN.register → Sandkit → all 18 threads
```

One detail matters here: the shim does not **replace** corelib's registration,
it **wraps** it. corelib's own registry still gets filled, because other mods
read it back — `refinement`, for instance, calls
`upgrades.getUpgrade("portals", ...)` to rebalance costs. Only the patch corelib
would later emit is suppressed.

Of corelib's ~90 patches, exactly those the bridge replaces are dropped. The UI
patches (config menus, tech-tree connectors) stay.

---

## Writing a Fluxloader mod

### Folder layout

```
my-mod/
  modinfo.json          required
  entry.electron.js     main process
  entry.game.js         renderer
  entry.worker.js       simulation threads
  mod.script.js         optional: computes the config schema
```

Where it goes:

```
%APPDATA%\sandustry\fluxloader-mods\my-mod\
```

### modinfo.json

```json
{
  "modID": "my-mod",
  "name": "My Mod",
  "version": "1.0.0",
  "author": "You",
  "fluxloaderVersion": "^2.0.0",
  "shortDescription": "Short",
  "description": "Longer",
  "dependencies": {
    "corelib": "^3.0.0",
    "portals": "optional:^1.0.8"
  },
  "tags": ["block"],
  "electronEntrypoint": "entry.electron.js",
  "gameEntrypoint": "entry.game.js",
  "workerEntrypoint": "entry.worker.js"
}
```

`modID` must match exactly what your own code checks for later.

**`optional:`** before a range makes the dependency soft — the mod loads without
it and only integrates when the other mod is present.

**`tags`** is functional, not decorative: loader mods find their content through
it. `"map"` is collected by custommaploader, `"skin"` by skinloader. Without the
tag your map is never discovered.

### Registering an element

```js
corelib.elements.registerElement({
  id: "Trash",
  name: "Trash",
  matterType: "Powder",
  density: 120,
  colors: [
    [80, 70, 60, 255],
    [90, 80, 70, 255],
  ],
})
```

Colours may be a flat array — SandLoader wraps them into the
`{variants: [...]}` shape the renderer expects. (Without that the game throws
`Cannot read properties of undefined (reading '3')` on spawn.)

### Registering a machine

```js
corelib.blocks.register({
  sourceMod: "my-mod",
  id: "Melter",
  name: "Melter",
  description: "Melts things.",
  shape: [[0,0],[0,0]],       // determines the size
  imagePath: "Melter",
  angles: [0],
  hasConfigMenu: true,
})
```

`shape` is required — the size is derived from it.

### Registering a tech node

```js
corelib.tech.register({
  id: "mytech",
  name: "My Tech",
  cost: 20000,
  parent: "Drones1",
  unlocks: { structures: ["d.Melter"] },
})
```

The `d.` prefix is a leftover: corelib used to splice that string straight into
the bundle. SandLoader strips it automatically.

### Config

```json
"configSchema": {
  "map": { "type": "string", "default": "default" },
  "splits": { "type": "array", "default": [1, 2] }
}
```

Reading it — **both forms work**:

```js
const config = await fluxloaderAPI.modConfig.get("my-mod")  // awaited
const config = fluxloaderAPI.modConfig.get("my-mod")        // direct
```

Passing your own `modID` as the key returns the **whole** config object, not an
entry inside it. (That is Fluxloader convention, and not obvious.)

### Events

```js
fluxloaderAPI.events.on("fl:mod-loaded", (mod) => {
  if (mod.info.tags.includes("map")) { /* ... */ }
})
```

| Event | Argument | When |
|---|---|---|
| `fl:mod-loaded` | `{info, path}` | once per active mod |
| `fl:all-mods-loaded` | — | after all mods |
| `fl:pre-scene-loaded` | `"game"` | before patches are harvested |

The argument to `fl:pre-scene-loaded` is **not decorative** — custommaploader
only resolves the selected map when the scene is `"game"` or `"intro"`.

A mod may also register and fire its own events; `fl:` is only the loader's
namespace.

> **Known gap:** `fl:mod-config-changed` is **not** emitted by SandLoader.
> skinloader listens for it to re-apply a skin when the player changes the
> setting, so a skin change currently takes effect on the next restart rather
> than immediately. Anything else relying on live config changes has the same
> limitation.

### IPC between main process and renderer

```js
// entry.electron.js
fluxloaderAPI.handleGameIPC("my-mod:getData", (event, args) => {
  return myData
})

// entry.game.js
const data = await fluxloaderAPI.invokeElectronIPC("my-mod:getData")
```

### Other useful APIs

```js
fluxloaderAPI.getGameAsarPath()      // .../app.asar/dist
fluxloaderAPI.getEnabledMods()       // {id: {info, path}}
fluxloaderAPI.patchExists(file, tag) // bool
fluxloaderAPI.setPatch(file, tag, patch)
fluxloaderAPI.removePatch(file, tag)
```

`getEnabledMods()` answers to both spellings mods use in practice:

```js
Object.values(fluxloaderAPI.getEnabledMods()).filter(...)  // custommaploader
fluxloaderAPI.getEnabledMods().filter(...)                 // refinement
```

---

## Map mods

A map is a mod tagged `"map"` carrying these files:

```
map_blueprint_playtest.png                terrain
map_blueprint_playtest_authorization.png
map_blueprint_playtest_lights.png
map_blueprint_playtest_sensors.png
fog_playtest.png                          fog
meta.json                                 spawn, limits, intro
modinfo.json
```

**All images must share the same dimensions** (except `fog_playtest.png`).

`meta.json`:

```json
{
  "spawn":    { "x": 375, "y": 226 },
  "unstuck":  { "x": 375, "y": 226 },
  "introSequence": { "0": "end" },
  "fog":      { "startY": 6500, "endY": 10070 },
  "yLimit":   { "hard": 100, "soft": 275 },
  "parallaxOffset": -2600
}
```

Many downloaded map packs ship **without a `modinfo.json`** — you have to write
one, with `"tags": ["map"]` and `modID` exactly as the map's own
`entry.electron.js` checks for:

```js
fluxloaderAPI.events.on("CML:mapLoaded", (map) => {
  if (map === "DigsiteLily") { /* modID must be "DigsiteLily" */ }
})
```

Map images are **not patched** but swapped: the interceptor serves your PNG in
place of the game's.

---

## Skin mods

A skin is a mod tagged `"skin"` carrying images that replace the originals:

```
player.png     gun.png       bullet.png
flamethrower.png             rocket.png
rocket_launcher_sprite.png   weapon.png
builder.png
player_arm_horisontal.png    player_arm_vertical.png
```

Not all are required — missing ones keep the original.

---

## Troubleshooting

### Where the logs are

```
%APPDATA%\sandustry\smln\logs\
```

The newest file is the last start. Useful search terms:

| Search | Meaning |
|---|---|
| `expected any match(es), found 0` | patch anchor no longer exists |
| `atomic group ... skipped entirely` | group failed, all that mod's patches dropped |
| `content bridge:` | what the bridge captured |
| `served from` | a file override is active (map/skin) |
| `electron entrypoint threw` | the mod crashed |

### Common failures

**`[MISSING: elements|foo|name]` in the tooltip**
The i18n key is not registered — or is in the wrong namespace (`elements|`
instead of `terrains|`), or registered only for `en` rather than the player's
locale.

**`Cannot read properties of undefined (reading '3')` on spawn**
Colours are a flat array; the game expects `{variants: [...]}`.

**A mod shows in the manager but does nothing**
Check for missing dependencies — the mod manager now lists them as
`needs: xyz (not installed)`. A missing required dependency prevents loading
entirely.

**A machine is in the inventory but does nothing**
The structure was registered (content) but the mod's behaviour patch cannot find
its anchor (behaviour). See the explanation above.

**Black screen after start**
A patch left the bundle inconsistent. The log names the group.

### The in-game console

Press `^`, backtick or `F1`. Useful for inspecting live state without a
debugger, and for anything a mod registers as a command.

### Inspecting the live game

SandLoader ships an MCP debug bridge (`mods/sandustry-mcp`) that exposes the
running game to tooling: evaluate code in the renderer, read the loader state,
list registered API namespaces, capture screenshots, read logs, inspect and diff
game state, and drive the DOM.

This is how most of the findings in this document were verified — the running
game is the authority, and offline tables are only a convenience.

### Checking an anchor without launching the game

```js
const reader = require('./src/asar/reader.js')
const a = reader.open('C:/.../Sandustry/resources/app.asar')
const src = a.read('dist/js/bundle.js').toString('utf8')
a.close()
console.log(src.split('MY_ANCHOR').length - 1, 'match(es)')
```

Zero matches means the patch will never apply.

---

## Summary

Four things worth carrying away:

**1. Register content, patch behaviour.** Registration survives game updates
because it hangs off the API. Patches hang off anchor text in a minified bundle
and break as soon as the build changes. This is why old Fluxloader mods work
*partially* today: the bridge carries their content across, but not their
behaviour.

**2. Never mutate a registry directly.** 18 worker threads each hold their own
copy. Only the game's own registration path reaches all of them.

**3. Pick the format for the job.** SMLN for new work and the richest API,
official for the Workshop and for running without SandLoader, Fluxloader for
compatibility with what already exists.

**4. Some things the game simply cannot do.** Upgrades and recipes have no
registration function anywhere in 0.5.5. No loader can add one; the honest
answer is to say so rather than fail quietly.

---

## See also

- [WRITING-MODS.md](WRITING-MODS.md) — SandLoader's own mod API in full detail:
  permissions, capabilities, storage, translations, settings, messaging, hot
  reload, console commands, packaging
- [../README.md](../README.md) — install, console, security model, how the
  loader hooks the game
