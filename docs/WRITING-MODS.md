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
| `main` | no | CommonJS module loaded in the Electron main process. **Privileged.** |
| `entrypoints` | no | `{ game, worker, native }`. The newer spelling; adds `worker`. |
| `permissions` | no | Array of capability names. See [Permissions](#permissions-and-the-security-model). |
| `dependencies` | no | Array of ids, or `{ id: versionRange }`. |
| `optionalDependencies` | no | Same shapes. A missing one is a warning, not a failure. |
| `configSchema` | no | Editable settings. See [Settings](#settings). |
| `priority` | no | Lower loads earlier. Default `100`. |
| `enabled` | no | Set `false` to ship a mod switched off. |

A mod with no entrypoint at all does nothing. Every path must stay inside the
mod folder — one that escapes is refused at load time, not sanitised.

### Entrypoints

The flat `main` / `renderer` fields and the `entrypoints` object both work:

```json
{ "renderer": "game.js", "main": "native.js" }
```

```json
{ "entrypoints": { "game": "game.js", "worker": "worker.js", "native": "native.js" } }
```

`main` maps to `entrypoints.native`, `renderer` maps to `entrypoints.game`. When
both are present the object wins and the clash is recorded as a warning. Only
the object form can declare a `worker` entrypoint.

### Versioned dependencies

Both syntaxes are supported, and the array form is not deprecated — it just
means "any version":

```json
{ "dependencies": ["other-mod"] }
```

```json
{
  "dependencies": {
    "library-mod": "^2.1.0",
    "tools-mod": ">=1.2.0 <2.0.0",
    "either-mod": "^1.2.0 || ^2.0.0"
  }
}
```

Supported range syntax: `1.2.3`, `=1.2.3`, `>1.2.3`, `>=1.2.3`, `<2.0.0`,
`<=2.0.0`, `^1.2.3`, `~1.2.3`, `1.2.x`, `1.x`, `*`, space-separated comparator
sets (AND) and `||` (OR). Prerelease versions follow npm's rule: `^1.2.0` does
**not** match `2.0.0-beta.1`.

A range that cannot be parsed is rejected at manifest-validation time rather
than quietly treated as `*` — silently widening a constraint someone wrote on
purpose is how an incompatible dependency gets loaded anyway.

When a dependency cannot be satisfied the dependent mod **does not load**, and
the reason says which of five things went wrong:

```
mod "foo" requires "bar" ^2.0.0, which is not installed
mod "foo" requires "bar" ^2.0.0, which is installed but disabled
mod "foo" requires "bar" ^2.0.0, installed version is 1.6.4
mod "foo" declares an unparsable version range for "bar": "^^2" (...)
dependency cycle: a -> b -> c -> a
```

Failures cascade: a mod whose dependency failed is skipped too, and its error
says the dependency could not be loaded rather than claiming it is missing.

---

## A broken mod never stops the loader

Every stage of loading is contained per mod. A bad manifest, a missing file, a
throwing entrypoint, an unsatisfiable dependency or a failed patch disables
**that** mod and nothing else.

Because a caught error nobody sees is only half a policy, every survived
failure is also recorded and shown:

- the **splash screen** lists each mod as it loads, with its security class,
  and prints the first few problems inline;
- the mod manager marks a failed mod in its row and keeps it in the list — a
  mod that vanished would be indistinguishable from one that loaded and does
  nothing;
- **SandLoader Mods → Problems** shows every problem with its error code, the
  mod it came from, and the stack where there is one;
- everything also goes to the log file.

If a patch fails or two mods conflict, the affected file is served
**unmodified** and the game still boots. A working unmodded game beats a
half-patched broken one.

---

## Permissions and the security model

### What actually enforces what

Sandustry's window runs with Electron's modern defaults — `contextIsolation:
true`, `nodeIntegration: false`. So **renderer and worker mod code has no
`require`, no `process`, no `Buffer`.** That boundary is enforced by Chromium,
not by SandLoader, and nothing in a mod can turn it off.

That leaves two privileged things inside the page, and SandLoader withholds
both from mods: the game's `window.electron` preload bridge, and SandLoader's
own `SMLN.callMain` main-process RPC.

The genuinely privileged execution class is the **main process**: a `main` /
`entrypoints.native` entrypoint is `require`d into it with real Node. Nothing
SandLoader does afterwards can take that back, which is why the gate for it is
an explicit user approval *before* the require.

### Tiers

| Tier | What runs | What it can reach |
|---|---|---|
| `SANDBOXED` | renderer and/or worker code | game API, worker API, config, its own private storage |
| `ELEVATED` | renderer and/or worker code | the above, plus `SMLN.net` and/or `SMLN.fs` |
| `NATIVE` | main-process code | real Node.js — the same privileges as the game itself |

### Permissions

```json
{ "permissions": ["filesystem", "network", "node"] }
```

| Name | Tier | Effect |
|---|---|---|
| `network` | elevated | enables `SMLN.net` |
| `filesystem` | elevated | enables `SMLN.fs`, a wider root than the mod's own folder |
| `node` | **native** | declares privileged native code |

`process`, `shell` and `native-ipc` are recognised names reserved for future
use; declaring one today is rejected with a "not supported yet" message rather
than silently ignored.

Rules the loader enforces:

- `"permissions": "network"` (a string, not an array) is a manifest error.
- An unrecognised name is a manifest error. Unknown permissions are never
  silently granted **or** silently dropped.
- Duplicates are collapsed.
- A permission a mod did not declare is genuinely unavailable at runtime, not
  merely undocumented — `SMLN.net.fetch()` in a mod without `network` rejects
  with `E_PERMISSION_DENIED` and never touches the network stack.

### The honest part about `node`

A mod granted `node` gets a real `require`. From there `fs`, `net`, `http`,
`child_process` and `process` are all one line away. So SandLoader does **not**
claim that `filesystem` and `network` restrict a native mod — they cannot, and
the capability object says so with `enforceable: false`. The mod manager shows
that sentence in the details panel too.

Native mods are supported deliberately (Discord integrations, external APIs,
developer tooling, local databases) — they are just labelled for what they are.

### Install-time review

No mod code runs before you decide. Installing from a ZIP reads the manifest
straight out of the archive's central directory and parses it as JSON; nothing
is unpacked, required or evaluated until the permission dialog is answered.

```
Install "Discord Integration"?

This mod requests:
  ✓ Game API access
  ⚠ Network access
    Lets this mod contact remote servers through SMLN.net.

[Cancel]  [Install]
```

For a `node` request the warning is at the top of the list, in its own red box,
and Cancel holds focus so Install has to be a deliberate click:

> Warning: this mod requests native Node.js access. Native mods can execute
> code with the same operating-system privileges as Sandustry and SandLoader.
> Only install this mod if you trust its author.

An approval is bound to **mod id + version + permission set**. Any of the three
changing asks again; nothing else does. Dropping a permission reuses the
existing approval — re-prompting for strictly less access only teaches people
to click through. An update that adds a permission shows a "Permission Change"
dialog listing what is new, and the mod does not run until it is answered.

### Granting and withdrawing later

The install dialog is not the only place. **SandLoader Mods → Details** on any
row shows what that mod can reach and lets you change the decision:

- a mod waiting on approval gets an **Approve** button, and says plainly that it
  will not load until you use it;
- an approved mod gets **Revoke**, which stops it loading on the next reload;
- a sandboxed mod gets neither, and says there is nothing to approve — it is
  already running and requests nothing privileged.

Approving a **native** mod from Details opens the same review dialog the
installer shows, warning and all, with Cancel focused. A privileged grant costs
the same deliberate confirmation wherever it is made from; otherwise the details
panel would quietly become the way around the install warning.

Either way the change takes effect on the next reload, because a native
entrypoint is required into the main process at startup.

---

## Capabilities

### `SMLN.storage` — private, no permission needed

Every mod gets `<userData>/smln/mod-data/<mod-id>/`. This is the safe
alternative to `require('fs')` and is why ordinary persistence needs no
permission at all.

```js
await SMLN.storage.writeText('cache.json', JSON.stringify(data))
const raw = await SMLN.storage.readText('cache.json')
await SMLN.storage.exists('cache.json')
await SMLN.storage.remove('cache.json')
```

Every path is re-checked on every call against the mod's own root: `..` in any
position, absolute paths, drive-relative and UNC paths, Windows device names,
NUL bytes, and symlinks that resolve outside the root are all refused. One
mod cannot reach another mod's directory. There is a per-mod quota (64 MiB by
default) and an over-quota write fails cleanly rather than leaving a partial
file.

### `SMLN.net` — requires `"network"`

```js
const res = await SMLN.net.json('https://example.com/api/stats')
```

`http:` and `https:` only. Loopback, link-local and the RFC1918 private ranges
are blocked by default, so a gameplay mod cannot probe the player's LAN.
Redirects are followed manually and the policy is re-checked **on every hop** —
otherwise a public URL could 302 to `127.0.0.1` and walk straight through the
check. There is a request timeout and a response size cap.

Without the permission every method rejects with `E_PERMISSION_DENIED` and no
request is made.

### `SMLN.fs` — requires `"filesystem"`

The same API as `SMLN.storage`, scoped to a wider root. Without the permission
every method rejects.

---

## Registering gameplay content

`SMLN.register` sits on top of the game's own `FH` registry. It does not
reimplement it — it queues calls made before the game is ready, gets the
state-first calling convention right, isolates failures per mod, and attributes
them.

```js
SMLN.register.element({
  id: 'crusherdust',
  name: 'Crusher Dust',
  matterType: SMLN.enums.MatterType.Powder,
  density: 20,
  colors: [0x8a7f6d, 0x7d7264],
})

SMLN.register.terrain({ id: 'slagstone', materialId: 120, hp: 40 })
SMLN.register.structure({ id: 'crusher', shape: [[1, 1], [1, 1]] })
SMLN.register.machine({ id: 'sorter', shape: [[1]] })   // alias: machines ARE structures
SMLN.register.matter({ id: 'goo' })
SMLN.register.sprite('crusher', 'sprites/crusher.png')
SMLN.register.item({ id: 'wrench', sprite: { id: 'wrench', path: 'sprites/wrench.png' } })
SMLN.register.keyBinding('smln.toggle', ['KeyK'])
SMLN.register.conveyorType('fast-belt', { velocity: { x: 4, y: 0 } })
SMLN.register.energyType('battery', 'storage', { priority: 1 })
SMLN.register.trigger('tick', { interval: 30 })
SMLN.register.hook('element:createdAt', function (state, args) { /* ... */ })
```

Every call returns a promise. Calls made before `game:ready` are queued and
flushed **in order** once the game API exists — that ordering matters, because
`FH.items.register` throws unless the sprite it names was loaded first.

Duplicate `type` + `id` is refused, naming the mod that got there first. A
failing registration never aborts the queue, and its error carries the mod id,
the content type and the content id.

`SMLN.register.as('my-mod')` returns the same API bound to an owner. The
per-mod `SMLN` a mod receives is already bound, so this is only needed if you
reach for the global.

### Recipes

**Sandustry 0.5.4 has no recipe registry.** `api.structures.recipes` exists
only in the newer Sandkit v1. `SMLN.register.recipe()` is feature-detected: on
a build that has it, it forwards; on 0.5.4 it rejects with a message saying so.
It is not faked and it is not a silent no-op.

---

## Content reference tables

`SMLN.enums` carries offline tables for the game's built-in content, so a mod
or a console command can look something up before a save is loaded:

```js
SMLN.enums.ELEMENT_INFO.water      // {id, name, description, matterType, density, color}
SMLN.enums.STRUCTURE_INFO.conveyor // {id, name, description, category}
SMLN.enums.ITEM_INFO.blinker       // {id, name, description, category}
SMLN.enums.ELEMENT_PHASE.sand      // 'Solid'
```

These come from `src/game/content.json`, cross-checked against the installed
bundle by the self-test — every id must still exist as a translation key, and
the game must not know an element the table lacks.

They are a **convenience, not an authority**. The running game is the authority:
prefer `FH.elements.getName(state, type)` and the live registry when a save is
loaded. Mod-registered content never appears here, so anything reading these
tables must degrade to the raw id.

---

## Assets

```js
const url = SMLN.assets.url('sprites/crusher.png')
```

Paths resolve relative to the owning mod's folder. `..`, absolute paths, drive
letters, UNC paths, backslashes and NUL bytes are refused, and so is any path
whose normalised form escapes the mod root. Only known media/data extensions
are served, so the URL builder cannot be used as a general file reader.

Under the hood the main-process interceptor — which already owns every
`file://` request under the game's `dist` — serves the mod's folder at a
virtual `smln-mods/<mod-id>/` path. No second web server, no protocol
registration, no CORS.

---

## Translations

```js
SMLN.register.translations({
  en: { 'machine.crusher.name': 'Crusher' },
  de: { 'machine.crusher.name': 'Brecher' },
})
```

This maps onto the game's real `FH.i18n.register(locale, table)` — one call per
locale. Keys without a `|` are namespaced as `mod|<your-id>|<key>` so two mods
cannot collide; a key that already contains `|` is passed through untouched, so
you can deliberately override a game string.

English is the fallback. Supplying `de` without `en` warns once and still
registers. A missing key never renders as `undefined` — `SMLN.register.
translations.get(key)` returns the key itself if nothing matches.

Registering before `game:ready` works; it queues like everything else.

Note that passing a plain `name:` string on a content definition already makes
the game derive a key (`elements|<id>|name`) and register the English fallback
for you. That is the game's behaviour, not something SandLoader adds.

---

## Settings

Declare a `configSchema` and the mod gets a **Settings** button in the manager.

```json
{
  "configSchema": {
    "speed":   { "type": "number",  "min": 1, "max": 10, "step": 0.5, "default": 4,
                 "label": "Belt speed", "description": "Cells per tick." },
    "mode":    { "type": "enum",    "values": ["low", "high"], "default": "low" },
    "count":   { "type": "integer", "min": 1, "max": 99, "default": 8 },
    "enabled": { "type": "boolean", "default": true },
    "label":   { "type": "string",  "maxLength": 32, "default": "",
                 "requiresReload": true }
  }
}
```

Types: `boolean`, `number`, `integer`, `string`, `enum` (`select` is accepted
as an alias). Shared fields: `default`, `label`, `description`, `min`, `max`,
`step`, `minLength`, `maxLength`, `pattern`, `requiresReload`, `hidden`,
`order`. A bare `{ "default": 5 }` infers its type from the default.

Reading and writing at runtime:

```js
const speed = await SMLN.config.get('speed')
await SMLN.config.set('speed', 6)
```

There is exactly **one** config store for the whole loader — one file per mod
under `<userData>/smln/config/`, one validator, one set of defaults — so the
settings screen, the main process and a Fluxloader mod's `modConfig` can never
disagree. Values are validated before they are written; an invalid one is
rejected, shown inline in the panel, and never reaches disk. Writes are
atomic, and a key on disk whose schema entry was removed is preserved rather
than discarded.

---

## Messaging between the game and the worker

```js
// renderer
SMLN.messaging.sendWorkerMessage('my-mod', 'tick', 1, { a: 2 })
SMLN.messaging.onWorkerMessage('my-mod', 'pong', function (value) { /* ... */ })
```

```js
// worker entrypoint
self.__SMLN_WORKER__.onGameMessage('my-mod', 'tick', function (n, opts) { /* ... */ })
self.__SMLN_WORKER__.sendGameMessage('my-mod', 'pong', 'done')
```

Fluxloader's spelling works too, on both sides:

```js
fluxloaderAPI.sendWorkerMessage('channel', ...args)
fluxloaderAPI.listenWorkerMessage('channel', handler)
fluxloaderAPI.sendGameMessage('channel', ...args)
fluxloaderAPI.listenGameMessage('channel', handler)
```

How it avoids colliding with the game: Sandustry's own worker protocol is
always an **array** whose first element is a numeric id, dispatched by
`switch (e.data[0])`, and installed with `worker.onmessage = fn`. SandLoader
sends a plain **object** envelope and registers with `addEventListener`. Both
listeners fire, the game's `switch` sees `undefined` and ignores ours, and
`postMessage` is never monkey-patched.

Messages go to every simulation thread — that is where worker mod code lives.
The manager worker is reachable explicitly via `sendManagerMessage`; the
utility worker is the save thread and is deliberately not a mod target.

Other guarantees: a handler registered *after* a message was sent still
receives it (inbound messages are buffered, bounded); a handler that throws is
contained and never reaches the game's own worker dispatch; two mods using the
same channel name cannot see each other's traffic; and a payload that would
fail structured clone is refused with a named reason instead of throwing a
`DataCloneError` inside the game's plumbing.

---

## Hot reload

**Reload Mods** in the manager, or `SMLN.hotreload.reload()`.

SandLoader will not claim to unload arbitrary JavaScript, because nothing can.
What it *can* reclaim is what it handed out — listeners, timers, messaging
handlers and recorded registrations — so reload has three honest stages:

| Stage | Trigger | What happens |
|---|---|---|
| `renderer` | a renderer entrypoint, asset or translation changed | the mod is disposed and its new code injected; the game keeps running |
| `context` | manifest, worker code, patches or config schema changed | everything is rebuilt and the game window reloads; the app does not restart |
| `restart` | a `main` / native entrypoint changed | you are told to restart, because a module that already registered listeners cannot be un-run |

Register cleanup with the lifecycle hook:

```js
SMLN.onDispose(function () { /* release anything the loader cannot see */ })
```

Timers and listeners created through the per-mod `SMLN` are tracked and cleared
for you:

```js
SMLN.setInterval(tick, 1000)   // cleared on dispose
SMLN.on('ready', onReady)      // removed on dispose
```

A `context` reload ends the current run, so the UI asks first. Set
`SMLN_WATCH=1` to reload automatically on file changes during development.

Reloads never accumulate stale patches: the patch list is rebuilt from the mod
definitions every time, and both the prelude and interceptor caches are cleared
*before* the window reloads — otherwise the already-patched body would be
patched a second time.

---

## Patch conflicts

Before any file is rewritten, SandLoader computes the real character ranges
every patch would modify and checks them for overlap **between different mods**:

```
E_PATCH_CONFLICT
js/bundle.js: mod-a:patch-1 (1200..1260) overlaps mod-b:patch-3 (1235..1290)
```

The check uses actual match positions, so string and regex patches are treated
alike and two patches with different `find` strings that happen to overlap are
still caught. Ranges that merely touch are not a conflict, and a mod
overlapping itself is its own business.

A conflict is fatal by default and the file is served unmodified. Deliberate
overlap is possible but needs **both** patches to opt in — one mod cannot waive
a collision on another mod's behalf:

```js
{ id: 'my-patch', find: '...', replace: '...', allowOverlap: true }
```

---

## Surviving game updates

SandLoader fingerprints the installation and re-resolves every hook when the
game changes. Your patches take part in that, and you can make them
self-healing too.

Anchor on something the game's **source** controls — a string literal, an event
name, a translation key — never on a minified identifier or a byte offset.
Then declare fallbacks:

```js
{
  id: 'my-mod:hook',
  description: 'why this patch exists',
  anchorLiteral: '"my:event"',        // the invariant, used in diagnostics
  find: /(\w+)\.events\.emit\((\w+),"my:event",\{state:\2\}\)/g,
  replace: (full, ns, st) => `myHook(${st}),${full}`,
  expect: 1,
  variants: [
    {
      label: 'payload gained fields',
      find: /(\w+)\.events\.emit\((\w+),"my:event",\{state:\2[^}]*\}\)/g,
      replace: (full, ns, st) => `myHook(${st}),${full}`,
      expect: 1,
    },
  ],
}
```

A variant inherits everything it does not override, so it only states what
differs. They are tried in order, loosest last, and the first whose output
still **parses** is adopted — a fallback that produces broken JavaScript is
refused rather than shipped.

`anchorLiteral` is what makes a failure actionable. When nothing resolves,
SandLoader searches for that literal and reports whether it is still in the
bundle (the hook point survived, only its shape moved) or gone (the hook point
itself was removed), with surrounding excerpts so you can write the new pattern
without going spelunking yourself.

Adopted fallbacks are reported as warnings, never applied silently.

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

## Manifest examples

### Normal gameplay mod

```json
{
  "id": "better-machines",
  "name": "Better Machines",
  "version": "1.0.0",
  "renderer": "game.js",
  "permissions": []
}
```

Sandboxed. No Node, no network, no filesystem beyond its own private storage
directory. Installs without a permission prompt.

### Game + worker mod

```json
{
  "id": "advanced-machines",
  "version": "1.0.0",
  "renderer": "game.js",
  "worker": "worker.js",
  "permissions": []
}
```

Still sandboxed — a worker is a different thread, not more privilege.
`entrypoints: { "game": "...", "worker": "..." }` is equivalent.

### Network-enabled sandboxed mod

```json
{
  "id": "online-stats",
  "version": "1.0.0",
  "renderer": "game.js",
  "permissions": ["network"]
}
```

Elevated. Gets `SMLN.net`, still no Node. Shows a `NETWORK` badge and asks once
at install.

### Elevated filesystem + network mod

```json
{
  "id": "cloud-export",
  "version": "1.0.0",
  "renderer": "game.js",
  "permissions": ["filesystem", "network"]
}
```

Elevated. Gets `SMLN.fs` and `SMLN.net`. Both restrictions are real here,
because the code has no other way out.

### Native mod

```json
{
  "id": "native-tool",
  "version": "1.0.0",
  "main": "native.js",
  "permissions": ["node", "filesystem", "network"]
}
```

> **Native Node mods execute privileged code and should only be installed from
> trusted sources.** A mod with `node` runs in the Electron main process with a
> real `require`. It has the same access to your computer as Sandustry itself,
> and SandLoader cannot restrict its filesystem or network use — the tier is
> labelled honestly rather than guarded ineffectively.

### With versioned dependencies and settings

```json
{
  "id": "factory-tools",
  "name": "Factory Tools",
  "version": "2.0.0",
  "entrypoints": { "game": "game.js", "worker": "worker.js" },
  "permissions": [],
  "dependencies": { "library-mod": "^2.1.0" },
  "optionalDependencies": { "theme-mod": "^1.0.0" },
  "configSchema": {
    "speed": { "type": "number", "min": 1, "max": 10, "default": 4, "label": "Belt speed" },
    "mode":  { "type": "enum", "values": ["low", "high"], "default": "low" }
  }
}
```

### Legacy mods

A manifest with no `permissions` field still loads. If it has no privileged
entrypoint it is treated as sandboxed. If it has a `main` entrypoint — or, for
a Fluxloader mod, an `electronEntrypoint` — it is classified **Legacy Native
Mod**: privileged, badged `NATIVE`, and held until acknowledged once. It is
never silently granted privileges and never silently sandboxed into breaking.

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
