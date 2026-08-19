# SandLoader

A mod loader for **[Sandustry](https://store.steampowered.com/app/2764460/Sandustry/)** with an
in-game console, a mod manager, and support for existing
[Fluxloader](https://fluxloader.app/) mods.

**It never modifies your game files.** Patching happens in memory while the game
loads, so Steam's file verification stays green and a game update can't leave a
broken patched file behind. Uninstalling is deleting one folder.

Works on **Steam**, **GOG** and **manual/standalone** installs.

```
Press  ^  (or F1) in game        →  console
Main menu → "SandLoader Mods"    →  install / enable / remove mods
```

---

## Contents

- [Requirements](#requirements) · [Which stores work](#which-stores-work)
- [Install](#install) · [Update](#update) · [Uninstall](#uninstall)
- [Using the console](#using-the-console)
- [Managing mods](#managing-mods)
- [Achievements](#achievements-read-this-once)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Writing mods](docs/WRITING-MODS.md)
- [How it works](#how-it-works) · [Project layout](#project-layout)
- [Security model](#security-model)
- [Non-Steam builds](#non-steam-builds)
- [Limitations](#limitations-and-whats-not-built-yet)

---

## Requirements

| | |
|---|---|
| **Game** | Sandustry **0.5.4** |
| **Stores** | Steam, GOG, manual/standalone |
| **OS** | Windows, Linux or macOS |
| **Node.js** | **18 or newer**, only to run the installer — [nodejs.org](https://nodejs.org) |

### Which stores work

| Store | Status | How SandLoader attaches |
|---|---|---|
| **Steam** | supported | the game's own Workshop loader slot — writes nothing into the install |
| **GOG** | supported | an added `resources/app/` bootstrap — no original file is modified |
| **Manual / standalone** | supported | same bootstrap |
| **Microsoft Store** | **not supported** | package is ACL-protected and signature-verified |
| **Game Pass** | **not supported** | same package, same reason |

Sandustry only scans for a mod loader on Steam — its own `main.js` starts that
check with `if (PLATFORM_NAME !== 'steam') return null`. On GOG and standalone
builds SandLoader supplies its own entry point instead, by *adding* a directory
Electron already looks for. Nothing is overwritten and uninstalling removes it
again. Details in [Non-Steam builds](#non-steam-builds).

Microsoft Store and Game Pass builds live under `WindowsApps`, which refuses
writes even to an administrator and verifies its own signature. There is no file
we are allowed to add and no non-destructive way in, so the installer says so
plainly rather than offering a workaround that would modify game files.

`node install.js --status` reports which build you have, on what evidence, and
for an unsupported one exactly why it cannot attach.

Check Node is installed:

```bash
node --version      # must print v18.x or higher
```

---

## Install

**1. Get the project.** Clone it, or download the ZIP and unpack it somewhere
permanent — SandLoader runs from wherever you put it, so don't leave it in a
temp folder.

```bash
git clone https://github.com/<you>/sandloader.git
cd sandloader
```

**2. Run the installer.**

```bash
node install.js
```

The installer detects your build and picks the right attach point on its own.

On **Steam** you should see:

```
  game      sandustry 0.5.4
  at        C:\Program Files (x86)\Steam\steamapps\common\Sandustry
  platform  steam (certain)  -  resources/steam_appid.txt
  slot      C:\Program Files (x86)\Steam\steamapps\workshop\content\2764460\smln
  loader    C:\...\sandloader\src\main\entry.js

  Installed. Start Sandustry and press ^ (or F1) to open the console.
  Nothing in the game directory was modified.
```

On **GOG** or a standalone copy:

```
  game      sandustry 0.5.4
  at        C:\GOG Games\Sandustry
  platform  gog (certain)  -  goggame-1234567890.info beside the executable
  attach    resources-app-bootstrap
  bootstrap C:\GOG Games\Sandustry\resources\app
  loader    C:\...\sandloader\src\boot\bootstrap.js

  Installed. The original app.asar was not touched; these three files were added:
    C:\GOG Games\Sandustry\resources\app\package.json
    C:\GOG Games\Sandustry\resources\app\smln-bootstrap.js
    C:\GOG Games\Sandustry\resources\app\.smln-bootstrap.json

  Uninstall with: node install.js --uninstall
```

**3. Start Sandustry.** A "SandLoader" splash appears while the game loads.

That is all. There is no build step and nothing to compile.

<details>
<summary><b>"could not find a Sandustry installation"</b></summary>

Point the installer at the folder containing `Sandustry.exe`:

```bash
# Windows (PowerShell)
$env:SANDUSTRY_DIR="D:\Games\Steam\steamapps\common\Sandustry"; node install.js

# Windows (cmd)
set SANDUSTRY_DIR=D:\Games\Steam\steamapps\common\Sandustry && node install.js

# Linux / macOS
SANDUSTRY_DIR="$HOME/.steam/steam/steamapps/common/Sandustry" node install.js
```
</details>

<details>
<summary><b>"no permission to write into the Steam workshop folder"</b></summary>

Your Steam library sits in a protected location. Either run the terminal as
Administrator once, or move the Steam library somewhere outside
`C:\Program Files`.
</details>

<details>
<summary><b>"SandLoader cannot write to ... resources"</b> (GOG / standalone)</summary>

The non-Steam bootstrap adds three files inside the game folder, which needs
write permission there. Run the terminal as Administrator once, or install the
game somewhere outside `C:\Program Files`.
</details>

<details>
<summary><b>"resources\app already exists and is not ours"</b></summary>

Something else is already attached at that path — another loader, or a leftover
from one. SandLoader refuses to overwrite a directory it did not create, because
doing so would silently break whatever put it there. Remove or rename it
yourself if you are sure it is no longer needed, then run the installer again.
</details>

<details>
<summary><b>"SandLoader cannot attach to this build"</b> (Microsoft Store / Game Pass)</summary>

Not fixable, and not for lack of trying. That package sits under `WindowsApps`
with ACLs that deny writes even to an administrator, and Windows verifies its
signature on launch. Every way in would mean modifying game files, which
SandLoader does not do. Run `node install.js --status` for the specific reason.
</details>

<details>
<summary><b>"no Steam Workshop content folder"</b></summary>

`steamapps/workshop/content/2764460` does not exist yet. Subscribe to any
Sandustry Workshop item once so Steam creates it, or create the folder by hand,
then run the installer again.
</details>

### Update

Pull the new version. **No reinstall needed** — the installed slot is a
three-line file pointing back at this folder, so edits take effect on the next
game launch.

```bash
git pull
node tools/selftest.js     # confirm it still matches your game version
```

### Uninstall

```bash
node install.js --uninstall
```

That deletes one folder — the Workshop slot on Steam, or the added
`resources/app` directory on GOG and standalone builds. The bootstrap is only
removed if it carries SandLoader's receipt file, so a directory we did not
create is never touched.

Your game was never modified; saves and mods stay where they are.

### Check what is installed

```bash
node install.js --status
```

It reports the detected store, the evidence it used, which attach method applies,
and — on an unsupported build — exactly why it cannot attach:

```
Platform
  Installation : gog (certain)
  Location     : C:\GOG Games\Sandustry
  Evidence     : goggame-1234567890.info beside the executable
  Attach       : resources-app-bootstrap
  Why          : Electron searches resources/ for 'app' before 'app.asar', so an
                 added app/ directory loads first. No original file is modified.
  Would create : C:\GOG Games\Sandustry\resources\app\package.json
                 C:\GOG Games\Sandustry\resources\app\smln-bootstrap.js
                 C:\GOG Games\Sandustry\resources\app\.smln-bootstrap.json
  Writable     : yes
```

---

## Using the console

Press **`^`** (the key left of `1`), **`` ` ``** or **F1**.

Suggestions appear above the input as you type, Minecraft-style — first command
names, then the values each argument accepts.

| Key | |
|---|---|
| `Tab` | complete the highlighted suggestion |
| `↑` `↓` | move through suggestions, or through history when there are none |
| `Enter` | run |
| `Esc` | close |

### Commands

| Command | What it does |
|---|---|
| `spawn <material> [radius] [x] [y]` | Place any material at your cursor. Works for elements *and* terrain. |
| `give <resource> <amount>` | Add to a resource. |
| `set <resource> <amount>` | Set a resource to an exact value. |
| `resources` | Show every resource this save has. |
| `list <kind>` | `elements`, `terrains`, `gases`, `liquids`, `solids`, `machines`, `resources` |
| `tech <on\|off>` | Free tech and upgrades, for this session only. |
| `sim <pause\|resume\|speed N>` | Control the simulation. |
| `integrity [on\|off\|clear\|status]` | Achievement policy — [see below](#achievements-read-this-once). |
| `api [namespace]` | Inspect the game's live modding API. |
| `help [command]`, `clear` | |

### Examples

```
spawn water            place water at the cursor (radius 2)
spawn lava 6           a bigger blob
spawn copper 3         copper — resolved as an element or terrain automatically
spawn steam 4 120 80   at explicit cell coordinates
give gold 10000        add 10 000 gold
set energy 999999
list gases
sim speed 5
```

Don't know a name? Type `spawn ` and browse, or run `list elements`. All 50
elements and 34 terrains the game ships are available, and anything a mod
registers appears automatically.

---

## Managing mods

Main menu → **SandLoader Mods**.

| | |
|---|---|
| **Install from ZIP** | Pick a `.zip`; it is validated and unpacked into the right folder. |
| **Open folder** | Opens your mods directory in the file manager. |
| **Enabled / Disabled** | Per-mod toggle, remembered between launches. |
| **Delete** | Removes the mod from disk. Asks once before it does. |

Mods load once when the game starts, so **every change takes effect on the next
launch**. The UI says so rather than pretending otherwise.

### Where mods live

| Kind | Folder |
|---|---|
| SandLoader mods | `mods/` in this project, and `<userData>/smln-mods/` |
| Fluxloader mods | `<userData>/fluxloader-mods/` and the Steam Workshop folder |

`<userData>` is `%APPDATA%\sandustry` on Windows, `~/.config/sandustry` on
Linux, `~/Library/Application Support/sandustry` on macOS.

### Fluxloader mods

Existing [Fluxloader](https://fluxloader.app/) mods work as-is. SandLoader reads
their `modinfo.json`, runs all three entrypoints (electron / game / worker),
provides the `fluxloaderAPI` global, translates their patches onto its own patch
engine, and persists their config. See
[limitations](#limitations-and-whats-not-built-yet) for the one gap.

---

## Achievements, read this once

Sandustry refuses to unlock achievements on a save that has been cheated on or
modded. That is the game's own rule, in its own code:

```js
function unlockAchievement(state, id) {
  if (state.store.integrity?.cheatsUsed || state.store.integrity?.modsUsed
      || config.debug.active || state.session.cinematic) return   // blocked
  ...
}
```

**SandLoader respects that by default.** Any console command that changes your
world or your resources marks the save, and says so in its reply:

```
> give gold 1000
gold  gold: 0 -> 1000 (save marked: achievements now disabled - "integrity" to change)
```

You can opt out. The choice is stored **inside that savegame**, so it travels
with it:

| Command | |
|---|---|
| `integrity status` | Show the current policy and whether this save is marked |
| `integrity off` | Stop marking the save when you cheat |
| `integrity on` | Resume marking (the default) |
| `integrity clear` | Un-mark a save that was already marked |

Steam achievements show on your public profile, so this is never a silent side
effect of typing a command — it is always your explicit call.

---

## Troubleshooting

**The log is the first place to look:**
`<userData>/smln/logs/smln-<timestamp>.log`

| Symptom | Cause / fix |
|---|---|
| No splash, console won't open | SandLoader didn't load at all. Check whether the log file exists. If not, re-run `node install.js` then `node install.js --status`. |
| Splash appears, console doesn't | Look for `console installed` in the log. If it's missing, a mod's renderer script probably threw — search the log for `renderer mod failed`. |
| `could not find a Sandustry installation` | Set `SANDUSTRY_DIR` — see [install](#install). |
| `patch ... anchor did not match` | The game updated and a hook broke. Run `node tools/selftest.js`; it names the broken hook. The game still starts, just unpatched. |
| Console opens but a command does nothing | Read the reply — commands report *why* they failed. `no game loaded` means you are still in the main menu. |
| `spawn` says "nothing was placed" | The target cells are solid terrain or outside the world. Move the cursor or pass explicit coordinates. |
| A mod doesn't load | The log names the mod and the reason. Bad manifests, missing dependencies and dependency cycles are each reported separately. |
| The game won't start at all | Remove the loader with `node install.js --uninstall`. If it still won't start, SandLoader wasn't the cause. |
| GOG/standalone: game starts but no splash | The bootstrap did not take. Run `node install.js --status` — it says whether `resources/app` is installed and whether it is ours. |
| GOG/standalone: game launcher reports changed files | Expected. The bootstrap *adds* `resources/app/`; it modifies nothing. `--uninstall` restores the original layout exactly. |
| `SandLoader cannot attach to this build` | Microsoft Store / Game Pass. Not supported — see [Which stores work](#which-stores-work). |

Verify compatibility with your installed game at any time:

```bash
node tools/selftest.js
```

It checks the game version, every patch anchor, the loader ABI and the console
end-to-end, and tells you exactly what broke.

---

## FAQ

**Does this modify my game files?**
No. Not one byte. Patching happens in memory as files are served to the renderer.

**Will Steam file verification flag it?**
No, because nothing in the game folder changes. On Steam, SandLoader lives in the
Workshop content folder.

**What about GOG?**
Supported. Since GOG builds never scan for a loader, SandLoader adds its own
`resources/app/` directory — three new files beside the untouched `app.asar`.
Electron already searches for `app` before `app.asar`, so it loads first and
hands control straight back to the real game. No original file is modified, and
`--uninstall` removes the directory again.

**Why not Microsoft Store or Game Pass?**
That package is ACL-protected and signature-verified. There is no file we are
allowed to add, and forcing one would mean modifying the game — so it is
reported as unsupported instead of half-working.

**Can this get me banned?**
Sandustry is single-player and ships no anti-cheat. There is nothing to ban.

**Will a game update break it?**
Possibly — and it will tell you. Hooks are anchored on strings from the game's
source rather than on positions or minified names, so they usually survive. When
one doesn't, the loader serves the game unpatched instead of half-patched: you
can still play, just without mods, and `tools/selftest.js` names the break.

**Do I need to reinstall after editing SandLoader's code?**
No. Just restart the game.

**Does it work on GOG / Microsoft Store / Game Pass?**
No — see [requirements](#requirements).

**Is it safe to install a random mod ZIP?**
A mod is arbitrary code with full Node access, exactly like this loader. The
installer rejects archives without a valid manifest and refuses any that try to
write outside the mods folder, but it cannot judge what the code does. Treat mods
like any other software you install.

---

## How it works

### On Steam, the game has a loader slot

Sandustry's own `main.js` scans `steamapps/workshop/content/2764460/*/` for a
`modinfo.json` declaring `modID: "fluxloader"`, `require`s the
`fluxloader.bundle.js` next to it, and drives it through a fixed interface:

```js
initialize(hostAPI) → { success }    // hostAPI: { ipcMain, shell, dialog, screen,
startManager()                       //            createWindow, paths, startGame }
getAPI() → { events: { trigger } }
setGameWindow(win) · onGameStarted() · closeGame()
```

That is the **game's ABI** — the contract a host offers a loader. SandLoader
implements it directly. It shares no code with the Fluxloader project; it answers
the same phone number, and separately knows how to read Fluxloader's mods.

### Everywhere else, SandLoader brings its own

That Workshop scan is Steam-gated, so on GOG and standalone builds nothing ever
looks for a loader. There SandLoader adds a `resources/app/` directory: Electron
resolves its app package by searching `resources/` for `app`, then `app.asar`,
then `default_app.asar`, so an added `app/` loads first. It initialises the
loader, installs the file interceptor, and only then `require`s the real
`app.asar/main.js` — the same order the Steam host uses, which is what makes the
patches land. If any of that fails it loads the original `main.js` untouched, so
a broken loader still leaves you a working game.

The payoff: SandLoader runs in the Electron **main process with full Node
access**, before the game window exists.

### Patching happens in memory

The game loads its UI with `loadFile(dist/index.html)`, so every asset arrives as
a `file://` request. SandLoader takes over that protocol and rewrites three files
on the way past:

| Target | Purpose |
|---|---|
| `js/bundle.js` | renderer — hooks, runtime, console, mod scripts |
| `js/simulation-worker.js` | simulation thread — worker-side mods |
| `js/utility-worker.js` | utility thread |

### One hook, and the whole API comes with it

Sandustry already ships a complete internal modding API — the object its bundle
calls `FH`, with **79 namespaces** at runtime:

```
events  elements  ui  structures  storage  sprites  workers  effects  world
terrains  input  sound  items  rendering  config  action  player  entities
i18n  upgrades  tools  queue  triggers  energy  collector  …
```

It is simply never published to `window`. So SandLoader reimplements none of it.
**One patch** captures the game's own object where it announces readiness:

```js
FH.events.emit(state, "game:ready", { state })
```

After that, `SandLoader.game` *is* `FH`.

### Version resistance

1. **Anchors, never offsets.** Patches match authored strings (`"game:ready"`),
   never module ids or minified names.
2. **Ambiguity is an error.** Every patch declares its expected match count. Zero
   fails; *more* than expected also fails, because a pattern that silently became
   ambiguous would corrupt the bundle in several places at once.
3. **All or nothing.** A failed required patch aborts and serves the file
   untouched. A broken loader must not become a broken game.
4. **Runtime over static.** Element ids, resource fields and API surfaces are read
   from the running game; the tables in `src/game/enums.js` are fallbacks.
5. **Drift detection.** `tools/selftest.js` reports which hooks still resolve,
   before anyone launches.

---

## Project layout

```
src/
  core/       errors, Result, logging, the problem registry
  asar/       archive reader, installation discovery, platform detection
  boot/       non-Steam bootstrap
  patch/      anchor-based patch engine, conflict preflight, core patches
  mods/       manifests, semver, dependency ordering, permissions, approvals,
              config, restricted storage, network capability, sandbox, watcher,
              ZIP install/remove
  compat/     Fluxloader mod compatibility and its messaging bridge
  main/       host-ABI entry point, file interceptor, RPC
  renderer/   injected runtime, capability facades, registration API, messaging,
              worker runtime, i18n, console, splash, mod manager, settings,
              permission UI, hot reload
  game/       type tables extracted from the bundle
tools/        self-test and its DOM harness
mods/         your mods
docs/         mod authoring guide
```

No dependencies. No build step. `install.js` writes a shim that points here.

```bash
node tools/selftest.js    # runs against your real installed game
```

---

## Security model

Sandustry's window runs with Electron's modern defaults — `contextIsolation:
true`, `nodeIntegration: false`. Renderer and worker mod code therefore has no
`require`, no `process` and no `Buffer`. That boundary is enforced by Chromium,
not by SandLoader.

What SandLoader adds on top:

- mods never receive the game's `window.electron` bridge or SandLoader's own
  `SMLN.callMain` main-process RPC;
- `SMLN.net` and `SMLN.fs` are gated on declared permissions, and a mod without
  them gets a rejection, not a missing function;
- every mod gets a private storage directory that traversal, absolute paths,
  UNC paths, device names and symlink escapes cannot leave;
- the permission review happens **before** any mod code is read, required or
  evaluated.

| Tier | Runs in | Reaches |
|---|---|---|
| `SANDBOXED` | renderer / worker | game API, worker API, config, private storage |
| `ELEVATED` | renderer / worker | the above, plus network and/or a wider filesystem root |
| `NATIVE` | Electron main process | real Node.js — everything the game itself can |

A mod declaring `node` gets a real `require`, from which `fs`, `net`, `http`
and `child_process` are one line away. SandLoader therefore does **not** claim
that `filesystem` and `network` restrict a native mod. They cannot, the
capability reports `enforceable: false`, and the mod manager says so in plain
language. Native mods are supported on purpose — they are just labelled.

`vm` is not treated as a security boundary anywhere in this codebase, because
it is not one when the sandbox object carries `require`.

Full details, including the install dialog and the escalation-on-update flow,
are in [docs/WRITING-MODS.md](docs/WRITING-MODS.md#permissions-and-the-security-model).

---

## Non-Steam builds

Which stores work is summarised [above](#which-stores-work); this is the
mechanism and the trade-offs.

**How the bootstrap works.** Electron resolves its application package by
searching `resources/` for `app`, then `app.asar`, then `default_app.asar`.
Adding a `resources/app/` directory therefore loads first, and hands control
straight back to the untouched `app.asar` once SandLoader is initialised — after
the file interceptor is live, which is the ordering that makes patches land at
all. Three new files are created:

```
<game>/resources/app/package.json
<game>/resources/app/smln-bootstrap.js
<game>/resources/app/.smln-bootstrap.json
```

No original file is modified, overwritten or deleted, and `node install.js
--uninstall` removes the directory again — but only if the receipt file is
there, so a directory SandLoader did not create is never touched.

Being straight about the trade-off: this writes new files *inside* the
installation directory, it needs write permission there (administrator under
Program Files), and afterwards `app.getAppPath()` reports `resources/app`. The
bootstrap mirrors the real `name` and `version` so `app.getName()` and
`app.getVersion()` stay correct.

Detection is evidence-based, not guesswork: Steam is recognised by
`resources/steam_appid.txt` and `installscript.vdf` plus a `steamapps/common`
path, GOG by its `goggame-*.info` files, and Microsoft Store by `WindowsApps` /
`AppxManifest.xml`. Writability is tested by actually creating and removing a
file, not inferred from the path. `node install.js --status` prints what it
found and why.

Microsoft Store and Game Pass cannot be supported without modifying the game
package, which would break its signature. The installer says so rather than
offering a workaround.

---

## Limitations and what's not built yet

An honest list:

- **Recipes.** Sandustry 0.5.4 has no recipe registry at all —
  `api.structures.recipes` exists only in the newer Sandkit v1.
  `SMLN.register.recipe()` feature-detects it and reports that it is
  unavailable on this build rather than pretending to have registered
  something.
- **Map mods.** Custom-map blueprints are discovered and reported, but loading
  them needs game-side support that is not exposed.
- **Renderer hot reload is partial by nature.** SandLoader reclaims what it
  handed out — listeners, timers, messaging handlers, recorded registrations.
  A mod that monkey-patched a game function in place stays patched until the
  window reloads, and the UI says which stage actually happened.
- **A native (`main`) entrypoint change needs a full restart.** Node's require
  cache can be cleared, but a module that already registered listeners or
  opened handles cannot be un-run; two live copies would be worse than asking.
- **Native mods are not sandboxed.** By construction, not by omission. See the
  security model above.
- **Microsoft Store and Game Pass builds cannot be modded** by any
  non-destructive method.
- **SandLoader's own UI ships English and German.** Adding a language is a
  data-only change in `src/renderer/locales.js`; mod-supplied text is never
  auto-translated.

---

## Status

Verified against **Sandustry 0.5.4**. Self-test: **82/82**.

## License

[MIT](LICENSE)
