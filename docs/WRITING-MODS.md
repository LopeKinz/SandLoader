# Writing SandLoader mods

A mod is a folder with a manifest. No build step, no dependencies, no
boilerplate — a single file is a valid mod.

- [Your first mod in 60 seconds](#your-first-mod-in-60-seconds)
- [The manifest](#the-manifest)
- [The renderer half](#the-renderer-half)
- [The main-process half](#the-main-process-half)
- [Adding console commands](#adding-console-commands)
- [Patching the game](#patching-the-game)
- [The game's own API](#the-games-own-api)
- [Debugging](#debugging)
- [Packaging](#packaging-for-others)

---

## Your first mod in 60 seconds

Create `mods/hello/` with two files.

**`mods/hello/smln.mod.json`**

```json
{
  "id": "hello",
  "name": "Hello",
  "version": "1.0.0",
  "renderer": "renderer.js"
}
```

**`mods/hello/renderer.js`**

```js
SMLN.registerCommand({
  name: 'hello',
  summary: 'Say hello',
  args: [{ name: 'who', optional: true, values: () => ['world', 'sandustry'] }],
  run: (args) => ['hello, ' + (args[0] || 'world') + '!'],
})
```

Restart the game, open the console with `^`, type `hello`. Done.

---

## The manifest

`smln.mod.json` in the mod's root folder.

| Field | Required | Meaning |
|---|---|---|
| `id` | **yes** | Lowercase letters, digits, `.`, `-`, `_`. 2–64 chars. Must be unique. |
| `version` | **yes** | Any string. Shown in the manager. |
| `name` | no | Display name. Defaults to `id`. |
| `renderer` | no | Script injected into the game page, next to the console. |
| `main` | no | CommonJS module loaded in the Electron main process. |
| `dependencies` | no | Array of mod ids that must load first. |
| `priority` | no | Lower loads earlier. Default `100`. |
| `enabled` | no | Set `false` to ship a mod switched off. |

Both `main` and `renderer` are optional, but a mod with neither does nothing.
Paths must stay inside the mod folder.

Dependencies are ordered topologically. A missing dependency or a cycle disables
just that mod, names the problem in the log, and leaves everything else running.

---

## The renderer half

Runs in the game page with `SMLN` already installed, **before** any game code.

```js
// Runs immediately, before the game exists.
SMLN.log('info', 'hello mod loading')

// Runs once the game is up. Fires immediately if it already is.
SMLN.whenReady((api) => {
  api.game            // the game's own API object (see below)
  api.state           // live game state
})

// Every scene load re-runs your script, so treat it as an entry point.
SMLN.on('ready', (api) => { /* ... */ })
```

### What `SMLN` gives you

| | |
|---|---|
| `SMLN.game` | The game's internal modding API. `null` before capture. |
| `SMLN.state` | Live game state. `null` before capture. |
| `SMLN.enums` | Static type tables — element ids, worker messages, UI screens. |
| `SMLN.whenReady(fn)` | Run `fn` when the game is ready. |
| `SMLN.on(event, fn)` | `'ready'`, `'game:ready'`, `'game:started'`. |
| `SMLN.registerCommand(spec)` | Add a console command. |
| `SMLN.postSim([msgType, ...args])` | Raw message to the simulation worker. |
| `SMLN.refreshUI()` | Ask the game to redraw its screens. |
| `SMLN.callMain(action, payload)` | Call your own main-process handler. Returns a Promise. |
| `SMLN.log(level, msg)` | Goes to the console *and* the log file. |
| `SMLN.console.print(text)` | Write a line into the in-game console. |

A throwing renderer script is caught and logged — it cannot stop the game from
booting, or stop other mods from loading.

---

## The main-process half

Runs in Electron's main process with **full Node access**: `fs`, `path`,
`child_process`, everything.

```js
// mods/hello/main.js
module.exports.setup = ({ mod, logger, smln, host }) => {
  logger.info('loaded from ' + mod.dir)
  logger.info('game version: ' + smln.install.version)

  return {
    patches: [ /* see below */ ],
  }
}
```

| Argument | |
|---|---|
| `mod` | Your manifest, resolved: `{ id, version, dir, ... }` |
| `logger` | Scoped to your mod id; writes to the log file |
| `smln` | `{ version, install, enums }` — `install` has the game path and version |
| `host` | The game's host API: `ipcMain`, `shell`, `dialog`, `screen`, `paths` |

---

## Adding console commands

```js
SMLN.registerCommand({
  name: 'teleport',
  summary: 'Move the player',
  usage: 'teleport <x> <y>',
  args: [
    { name: 'x' },
    { name: 'y' },
  ],
  run: (args) => {
    const api = SMLN.game
    if (!api) return ['no game loaded']
    api.player.setPosition(SMLN.state, Number(args[0]), Number(args[1]))
    return ['moved to ' + args[0] + ',' + args[1]]
  },
})
```

**`args`** drives completion. Each entry may carry `values: () => string[]`,
evaluated every keystroke — so you can offer live data:

```js
args: [{ name: 'element', values: () => Object.keys(SMLN.enums.ElementByName) }]
```

**`run(args)`** returns a string or an array of strings to print. Returning
nothing prints nothing. Throwing is caught and reported in the console rather
than crashing anything.

If your command changes the world or the player's resources, mark the save so
achievements behave as the game intends — see the README's achievements section.

---

## Patching the game

Only for things the API can't reach. Return patches from your `main.js`:

```js
module.exports.setup = () => ({
  patches: [{
    id: 'my-hook',
    description: 'why this patch exists, in one line',
    find: /(\w+)\.FH\.events\.emit\((\w+),"building:placed"/g,
    replace: (full, ns, st) => `console.log("placed!"),${full}`,
    expect: 1,          // exact match count; 'any' to allow several
    required: true,     // false = tolerate zero matches
    target: 'js/bundle.js',   // or js/simulation-worker.js
  }],
})
```

### Rules that keep patches alive across game updates

1. **Anchor on authored source.** String literals (`"building:placed"`), property
   names, i18n keys. Never module ids, never minified variable names, never byte
   offsets — those change on every build.
2. **Capture identifiers as backreferences.** Use `([\w$]+)` and reuse the group.
   Minifiers emit names like `$s`; a bare `\w` silently fails to match them.
3. **State your match count.** `expect: 1` means exactly one. Getting more is
   treated as an error, because a pattern that quietly became ambiguous would
   corrupt several places at once.
4. **Prefer the API.** If `FH` can already do it, don't patch.

A failing required patch aborts the whole run and the file is served untouched.
Better an unmodded game than a half-patched one.

Check your anchors without launching:

```bash
node tools/selftest.js
```

---

## The game's own API

Sandustry ships a full internal modding API. SandLoader captures it and hands it
to you as `SMLN.game`. It has ~79 namespaces; the useful ones:

| Namespace | Examples |
|---|---|
| `elements` | `createAt(state, x, y, id, opts)`, `removeAt`, `replaceAt`, `register`, `getName`, `setPhysics` |
| `terrains` | `createAt(state, x, y, "copper")`, `removeAt`, `register`, `setTerrainHP` |
| `structures` | `build`, `removeAt`, `register`, `getAtCell`, `addVariant` |
| `world` | `setCellId`, `getCellId`, `isCellEmpty`, `excavate`, `createLightSource` |
| `player` | `getPosition`, `setPosition`, `setVelocity`, `isOnGround` |
| `ui` | `toast(state, {key, params})`, `confirm`, `prompt`, `update`, `overlays` |
| `events` | `on(state, name, fn)`, `emit(state, name, payload)` |
| `items`, `upgrades`, `tools`, `sound`, `i18n`, `input`, `energy` | … |

Note the shape: **elements are addressed by numeric id, terrains by name.**

```js
SMLN.game.elements.createAt(SMLN.state, 100, 50, 3, {})       // water
SMLN.game.terrains.createAt(SMLN.state, 100, 50, 'copper')    // copper terrain
```

Explore it live from the console:

```
api                 list every namespace
api elements        list that namespace's methods
```

Useful events: `game:ready`, `game:started`, `frame:update`, `frame:render`,
`cell:process`, `element:createdAt`, `element:moved`, `building:placed`,
`building:removed`, `entity:collected`, `factory:levelUp`, `input:*`.

---

## Debugging

**The log** — `<userData>/smln/logs/smln-<timestamp>.log`. `SMLN.log()` and your
`logger` both land here.

**DevTools** — `Ctrl+Shift+Backspace` in game. `SMLN` is on `window`, so you can
poke at everything from the DevTools console.

**The self-test** — `node tools/selftest.js` verifies your patch anchors against
the installed game.

**Common mistakes**

| Symptom | Cause |
|---|---|
| Mod doesn't appear in the manager | Manifest is invalid — the log says exactly why. |
| `SMLN.game` is `null` | You ran too early. Use `SMLN.whenReady()`. |
| Completion list is empty | `values()` threw; it is called on every keystroke. |
| Patch never applies | Anchored on a minified name. Use authored strings. |
| Changes don't show up | Mods load at startup. Restart the game. |

---

## Packaging for others

Zip the mod folder. Either layout works — a wrapper folder is stripped
automatically:

```
my-mod.zip
└── smln.mod.json, renderer.js, ...

my-mod.zip
└── my-mod/
    └── smln.mod.json, renderer.js, ...
```

Users install it with **Main menu → SandLoader Mods → Install from ZIP**.

The installer refuses archives without a valid manifest, and refuses any entry
whose path would write outside the mods folder.

---

## Fluxloader mods

Existing [Fluxloader](https://fluxloader.app/) mods run unchanged — keep your
`modinfo.json`, your three entrypoints and the `fluxloaderAPI` global. See the
README for what is and isn't supported.
