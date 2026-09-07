# SandLoader

A mod loader for **[Sandustry](https://store.steampowered.com/app/2764460/Sandustry/)** with an
in-game console, a mod manager, and support for existing
[Fluxloader](https://fluxloader.app/) mods.

**It never modifies your game files.** Patching happens in memory while the game
loads, so Steam's file verification stays green and a game update can't leave a
broken patched file behind. Uninstalling is deleting one folder.

Works on **Steam**, **GOG** and **manual/standalone** installs.

**Vanilla branch only.** SandLoader targets Sandustry's default `public` branch. The
experimental modded branch ships a different Sandkit generation and is not supported.

```
Press  ^  (or F1) in game        →  console
Main menu → "SandLoader Mods"    →  install / enable / remove mods
```

---

## Contents

- [Requirements](#requirements) · [Which stores work](#which-stores-work)
- [Install](#install) · [SteamCMD](#steamcmd) · [Update](#update) · [Uninstall](#uninstall)
- [Using the console](#using-the-console)
- [Managing mods](#managing-mods) · [Install from Workshop](#install-from-workshop)
- [Achievements](#achievements-read-this-once)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Writing mods](docs/WRITING-MODS.md)
- [Modding reference](docs/MODDING-REFERENCE.md) — how Sandustry looks on the
  inside, and all three mod formats that run on it
- [How it works](#how-it-works) · [Project layout](#project-layout)
- [Security model](#security-model)
- [When the game updates](#it-re-checks-itself-when-the-game-updates)
- [Non-Steam builds](#non-steam-builds)
- [Limitations](#limitations-and-whats-not-built-yet)
- [Changelog](#changelog)

---

## Requirements

| | |
|---|---|
| **Game** | Sandustry **0.5.6** |
| **Branch** | **Vanilla only** — Steam's default `public` branch. The experimental modded branch is **not supported** |
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
git clone https://github.com/LopeKinz/SandLoader.git
cd SandLoader
```

**2. Run the installer.**

```bash
node install.js
```

The installer detects your build and picks the right attach point on its own.

On **Steam** you should see:

```
  game      sandustry 0.5.6
  at        C:\Program Files (x86)\Steam\steamapps\common\Sandustry
  platform  steam (certain)  -  resources/steam_appid.txt
  slot      C:\Program Files (x86)\Steam\steamapps\workshop\content\2764460\smln
  loader    C:\...\sandloader\src\main\entry.js

  Fetching SteamCMD - needed for "Install from Workshop".
  fetching  https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip
  got       757 KiB
  steamcmd  C:\...\sandloader\vendor\steamcmd\steamcmd.exe

  Installed. Start Sandustry and press ^ (or F1) to open the console.
  Nothing in the game directory was modified.
```

On **GOG** or a standalone copy:

```
  game      sandustry 0.5.6
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

  Fetching SteamCMD - needed for "Install from Workshop".
  steamcmd  C:\...\sandloader\vendor\steamcmd\steamcmd.exe
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

### SteamCMD

The installer also fetches [SteamCMD](https://developer.valvesoftware.com/wiki/SteamCMD)
into `vendor/steamcmd`. It is Valve's headless downloader, used by
[Install from Workshop](#install-from-workshop), and it is the only thing
SandLoader downloads.

```bash
node install.js --no-steamcmd        # install the loader, skip the download
node install.js --steamcmd           # fetch SteamCMD on its own, later
node install.js --steamcmd --force   # re-fetch it
```

- The download URL is printed before it is fetched, and only Valve's own hosts
  are used.
- A SteamCMD already on your `PATH` (or named by `SMLN_STEAMCMD`) is used as-is
  — nothing is downloaded and nothing of yours is touched.
- A failed download is a warning, not a failed install. Everything except
  Workshop downloading still works.
- `node install.js --uninstall` removes it again, but only the copy the
  installer fetched.

Anonymous SteamCMD downloads do **not** work for Sandustry's Workshop, because
it is a paid game — see [Install from Workshop](#install-from-workshop) for the
two routes that do, both of them driven from the mod manager.

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

That deletes the attach point — the Workshop slot on Steam, or the added
`resources/app` directory on GOG and standalone builds — plus `vendor/steamcmd`
if the installer fetched it. The bootstrap is only removed if it carries
SandLoader's receipt file, so a directory we did not create is never touched,
and a SteamCMD you installed yourself is left alone.

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

SandLoader
  path      C:\GOG Games\Sandustry\resources\app
  status    INSTALLED
  version   0.3.4
  steamcmd  C:\...\sandloader\vendor\steamcmd\steamcmd.exe
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
| **Install from Workshop** | Paste a Workshop link or id; it is imported as a local mod. |
| **Browse Workshop** | Opens the Sandustry Workshop hub. |
| **Open folder** | Opens your mods directory in the file manager. |
| **Enabled / Disabled** | Per-mod toggle, remembered between launches. |
| **Delete** | Removes the mod from disk. Asks once before it does. |

Mods load once when the game starts, so **every change takes effect on the next
launch**. The UI says so rather than pretending otherwise.

### Install from Workshop

Paste a Workshop link or a bare id — all of these name the same item:

```
3141592653
https://steamcommunity.com/sharedfiles/filedetails/?id=3141592653
https://steamcommunity.com/workshop/filedetails/?id=3141592653
steam://url/CommunityFilePage/3141592653
```

**The mod is imported, not linked.** Wherever the files come from, they are
copied into your normal mods directory, which means:

- it is an ordinary local mod — you can delete it from the manager like any other
- Steam will not re-download or update it behind your back
- unsubscribing in Steam afterwards does not remove it

Its origin is recorded in a small `.smln-workshop.json` beside it, so the manager
can still show where it came from and link back to its Workshop page.

Everything else is the ZIP path exactly: the manifest is validated before
anything is written, the same permission review is shown before anything is
installed, and declining leaves nothing behind. An item with no `smln.mod.json`
or `modinfo.json` is refused as "not a mod SandLoader can load" rather than
half-installed.

#### Where the files come from

SandLoader tries two sources, in this order.

**1. A copy Steam has already downloaded.** If you are subscribed to the item,
Steam has put it in `steamapps/workshop/content/2764460/<id>/` and SandLoader
imports straight from there. No download, no login, nothing to install. Steam's
copy is never modified or deleted — only read.

**2. SteamCMD, anonymously.** If you are not subscribed, SandLoader asks
SteamCMD to fetch the item.

> [!IMPORTANT]
> **Anonymous downloads do not work for Sandustry.** Steam only serves them for
> apps that permit it, which generally means free ones. Sandustry is a paid game,
> so Steam refuses the anonymous account and SteamCMD reports a bare `Failure`.

That is not a dead end — the manager offers both ways through, and both finish
without leaving the game:

**Subscribe in Steam.** Choose **Open in Steam** and the item's page opens. Click
Subscribe; SandLoader waits for Steam to finish downloading and then installs it
by itself. No second trip through the link box.

**Or sign in to Steam.** Choose **Sign in to Steam** and enter the account name
and password of an account that owns Sandustry, plus a Steam Guard code if Steam
asks for one. The download then proceeds without subscribing to anything.

> [!NOTE]
> **What happens to your password.** It is passed to SteamCMD — Valve's own tool
> — on its standard input, and nothing else is done with it. It is never written
> to disk, never logged, and never put on a command line (which any other program
> running as you could read, including a mod holding the `node` permission).
> SandLoader stores only the **account name**; SteamCMD caches its own session,
> so later downloads need nothing more.

#### When something goes wrong

| The manager says | What it means |
|---|---|
| *Steam would not hand over that item…* | Anonymous download refused. Subscribe in Steam, or sign in — both are offered. |
| *SteamCMD is set to use a Steam account but has not signed in to it yet* | An account name is saved but SteamCMD has no session for it. Sign in once. |
| *Steam rejected that account name or password* | Wrong credentials, or the account does not exist. |
| *Steam is rate-limiting sign-in attempts* | Too many tries. Wait a few minutes. |
| *Steam does not have a Workshop item with that id* | The id is wrong, or the item was removed. |
| *SteamCMD was not found* | Run `node install.js --steamcmd`. |
| *…is not a mod SandLoader can load* | The item has no mod manifest — it may target a different loader. |

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

**Does it work on the experimental / modded branch?**
No — SandLoader supports the **vanilla** branch only, which is Steam's default `public`
branch. The two branches ship different generations of Sandustry's modding API: vanilla
has the legacy Sandkit surface, the modded branch has Sandkit v1 with namespaces vanilla
does not have. To switch back: right-click Sandustry in Steam → Properties → Betas →
select **None**. Installing on the experimental branch is not blocked, but nothing about
it is verified — anchors may not resolve, and the loader reports what failed rather than
pretending it worked.

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

### It re-checks itself when the game updates

SandLoader records a fingerprint of the installation - version, `app.asar`
size and mtime. When any of it moves, the next launch re-reads the renderer
bundle and re-resolves every hook before serving a single file. An unchanged
install pays nothing; a changed one costs about 50 ms.

Each hook may declare ordered **fallback patterns**, all anchored on the same
invariant string literal but progressively looser about the shape around it.
That is what the 0.5.4 → 0.5.5 diff looks like in practice:

```
0.5.4   ie.FH.events.emit(p,"game:ready",{state:p})
0.5.5   ie.FH.events.emit(g,"game:ready",{state:g})
```

Only the local names moved. If a future build also moves the *shape* - the
payload gains a field, the call loses its namespace prefix - the next fallback
that resolves cleanly is adopted, and adoption is gated on the patched bundle
still parsing. Everything adopted is reported as a warning in the log, on the
splash and in the Problems panel; nothing changes silently.

**What it cannot do**, stated plainly: it cannot invent a hook. If the game
removes `"game:ready"` outright, no scan finds a semantic replacement, and
guessing would be worse than failing - SandLoader would patch a place nobody
chose. In that case it reports where the literal used to be, serves the file
unmodified, and the game still starts.

Force a re-scan any time with `node tools/selftest.js`, which reports each
anchor and its match count.

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
              ZIP install/remove, Workshop import and its SteamCMD driver
  compat/     Fluxloader mod compatibility and its messaging bridge
  main/       host-ABI entry point, file interceptor, RPC
  renderer/   injected runtime, capability facades, registration API, messaging,
              worker runtime, i18n, console, splash, mod manager, settings,
              permission UI, hot reload
  game/       type tables extracted from the bundle
tools/        self-test and its DOM harness
website/      the documentation site (one generated index.html)
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

Permissions are not a one-shot decision at install time: **SandLoader Mods →
Details** on any row shows what that mod can reach and lets you approve or
withdraw it afterwards. Granting a native mod from there opens the same review
dialog the installer shows, warning included.

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

- **Recipes.** Sandustry 0.5.5 has no recipe registry at all — `recipes`
  appears nowhere in the build's API object, and `api.structures.recipes`
  exists only in the newer Sandkit v1.
  `SMLN.register.recipe()` feature-detects it and reports that it is
  unavailable on this build rather than pretending to have registered
  something.
- **Worker entrypoints do not get a Sandkit API yet.** A mod with a
  `workerEntry` is injected into the simulation workers, but there is no
  worker-side `sandkit` for it to call, so it logs
  `worker mod failed: ReferenceError: sandkit is not defined` and stops. That is
  deliberate: the worker Sandkit surface is not the main one, and handing a mod
  the main adapter inside a simulation worker would corrupt simulation state.
  Failing loudly is the honest option until the native worker-entry bridge is
  wired up. Everything a mod does in the game context is unaffected.
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

## Changelog

### 0.3.4

Verified against Sandustry 0.5.5. Self-test: 130 checks (+26).

This run makes **corelib** work, and with it the Fluxloader mods that depend on
it — a chain of bugs sat between a corelib mod and a running game, each one only
reachable once the one in front of it was gone. It also adds installing mods
straight from the Steam Workshop.

**Fixed — corelib loads, and mods that depend on it register their content**

- The compat layer never implemented `includeVMScript`, so corelib threw
  `ReferenceError` on line 12 of its electron entrypoint, before any mod
  initialised, and the game did not start. Included files now run in their
  mod's own context, so a class declared in `modules/blocks.js` is visible to
  the entrypoint and to the files included after it. Reads are confined to the
  mod's own folder.
- Also missing, and each its own failure once the one before it was fixed: the
  bare `log()` global (corelib calls it 56 times), `events.registerEvent` /
  `trigger` / `tryTrigger`, `gameInstance.state` and `gameInstanceState`,
  `setMappedPatch`, and `getModsPath`. `addMappedPatch` ignored the per-bundle
  variable-name arrays mods pass it. `path` and `fs` are in scope for electron
  entrypoints, as they are under Fluxloader.
- Mod entrypoints may use top-level `await`. corelib's game entrypoint ends on
  `await corelib.init()`, which was a `SyntaxError` inside the old non-async
  wrapper — and that took down every mod in the concatenated bundle, not just
  the one that used it.
- A mod that depends on a library mod could not see it. Each mod ran in its own
  context, so corelib's `globalThis.corelib = new CoreLib()` never reached its
  dependents and they died on `corelib is not defined`. Each mod now gets its
  own context whose global **inherits** from one shared object: reads fall
  through to what other mods published, while `fluxloaderAPI` stays per-mod and
  shadows it. The isolation added in 0.2.0 — two mods cannot overwrite each
  other's id, config or channels — is unchanged.
- Every patch corelib registered was attributed to whichever mod loaded last.
  corelib queues its patches from a deferred `fl:pre-scene-loaded` callback,
  and a shared-but-mutable `fluxloaderAPI` resolves when the callback *fires*,
  not when it was created. All 92 of corelib's patches were filed under the
  wrong mod, breaking attribution, `removePatch` and conflict reporting.
- Fluxloader mods are now ordered by dependency before loading. Discovery
  returns directory order, which was correct only while the names happened to
  sort favourably (`corelib` < `trashelement`); a dependent named earlier in the
  alphabet loaded first and failed. Uses the existing resolver, so version
  ranges and dependency cycles are reported the same way as for SMLN mods.

**Added — Fluxloader content bridge**

Fluxloader mods register content through corelib, which does it by patching the
game bundle. On Sandustry 0.5.5 that no longer works: **75 of corelib 3.1.3's 92
patch anchors exist in no shipped file**. The build stopped splitting into
numbered chunks (`js/336.bundle.js` and friends are never requested), and the
element registry changed shape — `{name:"Cinder", matterType:X.Slushy}` became
`{nameKey:"elements|basalt|name", matterType:6}`, a localisation key and a plain
number. Retargeting the patches would still emit entries the game cannot read.

SandLoader now bridges it instead. `registerElement` and `registerSoil` are
intercepted, each definition is translated into 0.5.5 shape, and the result goes
to Sandkit's own `elements.register` / `terrains.register` by way of
`SMLN.register`. The mod is not modified, corelib is not modified, and only the
patches the bridge supersedes are dropped — the rest are left untouched.

Registration has to happen in the renderer, not the main process: the simulation
runs across **18 worker threads**, each with its own copy of the registry, and
only the game's own registration path reaches all of them.

This also fixes the reason nothing registered at all — corelib defers every
patch to `fl:pre-scene-loaded`, and SandLoader never emitted that event, so mods
loaded cleanly and registered nothing.

Three defects surfaced once those 92 patches became real for the first time,
each fixed:

- The interceptor served every transformed file as `application/javascript`.
  Every target had been a script, so it was invisible until a mod patched
  `index.html` — which Chromium then rendered as source text on a black screen.
  The type now comes from the file.
- Fluxloader patches defaulted to `required`, so one mod's stale anchor aborted
  the whole file and took SandLoader's own patches with it.
- Applying only the patches that still matched was worse: corelib's `colorIdFix`
  rewrites buffer sizing in one patch and that buffer's readers in the next, so a
  partial apply left the bundle internally inconsistent. Fluxloader patches are
  now **one atomic group per mod per file** — a mod's patches all land or none
  do, and no mod can veto another's or the loader's.

**Recipes remain unavailable.** Sandustry 0.5.5 has no recipe registry —
`sandkit.structures.recipes` is undefined, no namespace among the 79 matches
`/recipe/i`, and no module carries an input/output shape. A mod's recipe calls
are reported with that reason rather than silently doing nothing.

**Added — Install from Workshop**

- The mod manager takes a Workshop URL or a bare id and installs the item as an
  ordinary local mod. All four link spellings Steam uses are accepted; anything
  else is refused by name rather than coerced into an id.
- Items already subscribed in Steam are imported directly from
  `steamapps/workshop/content/`, with no download and no login. Steam's copy is
  read, never modified or deleted.
- Otherwise the item is fetched with **SteamCMD**, which `install.js` now
  downloads into `vendor/steamcmd` (skip with `--no-steamcmd`). Reuses the
  existing ZIP reader to unpack it on Windows, so no dependency was added.
- Sandustry is a paid game, so Steam refuses anonymous Workshop downloads for it
  and SteamCMD reports a bare `Failure`. That case is now detected specifically
  and answered with the two routes that do work rather than the raw wording.
- Imported mods stay fully removable and are tagged with their origin; the
  Steam-managed rule still applies only to content Steam itself owns.
- Install goes through the existing permission review unchanged: the ZIP and
  Workshop paths now share one implementation of it rather than two.
- Refused downloads are recoverable from the manager: **Open in Steam** waits for
  Steam to finish downloading a newly subscribed item and then installs it, and
  **Sign in to Steam** signs SteamCMD in to an account that owns the game,
  including the Steam Guard round trip. The password goes to SteamCMD on stdin
  and is never stored, logged, or placed on a command line; only the account
  name is kept.

**Fixed**

- Official (`manifestVersion: 1`) mods could not be installed at all. The
  installer's reviewer treated every `modinfo.json` as Fluxloader's and demanded
  a `modID`, so an official manifest was refused with `the manifest has no
  "modID"` — a valid mod, read by the wrong reader. It now discriminates on
  `manifestVersion` the way `manage.js` and `official.js` already did. This
  affected ZIP installs too, not only Workshop ones.
- **Three adapter aliases pointed at methods this build does not have**, found
  by diffing the alias table against the API object extracted from the shipped
  `app.asar` rather than against memory of it. `player.isWithinRadiusOfCell`
  mapped to itself, and 0.5.5 spells it `isWithinRadius`. `terrains.getTypeFromId`
  mapped to `getTerrainTypeFromId`, which appears **nowhere in the bundle** — the
  only id lookup this build has is `world.getCellTypeByName`. Both resolved to
  nothing, so a mod calling either got `undefined is not a function`.
  `elements.setDataFieldAtCellWhenIdle` mapped to `setDataField1`, which takes
  `(state, x, y, value)` — one argument short of the v1 signature's
  `(x, y, fieldNumber, value)`. That one did not throw: the field *number* landed
  in the value slot and the value was dropped, so the call silently wrote the
  wrong number to data field 1. It now maps to `setDataField`, which has the
  matching arity.
- **Alias targets may now name another namespace.** `terrains.getTypeFromId`
  cannot be fixed inside a namespace-local table because its only honest target
  lives on `world`. A dotted target (`'world.getCellTypeByName'`) is resolved
  against the root sandkit object, keeps `this` bound to the namespace that owns
  the method, and takes its state-binding decision from *that* namespace's
  `NO_STATE_ARG` entry rather than the aliasing one.
- **51 v1 calls that had no alias at all** now have one, each target verified
  present in 0.5.5 before being written: the `...WhenIdle` element mutators
  (`setVelocity`, `convertToParticle`, `convertFromParticle`, `setDuration`),
  the `...AtCell` reads (`isTypeAt`, `isFreeFalling`, `getVelocity`,
  `getDataField`), four `structures` renames including
  `removeAtCellsWhenIdle` → `removeAtPositions`, and twelve namespaces the table
  never covered — `authorization`, `collector`, `discoveries`, `fire`, `grid`,
  `patterns`, `raycast`, `upgrades`, `sprites`, `items`, `effects` and `tech`.
  Unaliased names still pass through untouched, so this only ever adds
  translations; it cannot take one away. A self-test now holds all 91 alias
  targets to a method that exists in the build.
- **The API scan was blind to calls two levels deep.** `api.player.buildings.unlockByType`
  was read as `player.buildings` — a container that exists — so the scan reported
  the mod supported and the mod then died at runtime on the method, which is
  exactly what the scan is there to predict. It now captures the third segment
  and checks each call at the depth it lives at. Eight such calls across the
  bundled mods had never been checked at all; a self-test now holds every one of
  them to an accounted-for source.
- `api.structures.processing.isEnabledAt()` is now shimmed. It was missing from
  the `processing` object entirely, and a mod calling it inside a per-structure
  tick lost the whole tick. This build has no per-machine on/off state, so it
  reports every structure as enabled — unless the mod set `data.enabled = false`
  itself — and says so once. Labelled as an approximation at its definition.
- `api.player.buildings.unlockByType()` is now shimmed. This build spells it
  `buildings.add`, so a mod calling the v1 name died on that line and lost
  everything after it - including, for one Workshop mod, the structure it had
  just registered. Implemented against the build list directly rather than
  delegating, because `player.buildings` is a nested object and the adapter only
  state-binds top-level functions.
- The Workshop download cleanup matched any path shaped
  `workshop/content/<appid>/<id>`, which is also the shape of Steam's own
  subscribed-content folder. Importing a subscribed item would therefore have
  deleted Steam's copy, which Steam then silently re-downloads. Cleanup is now
  refused for anything inside a Steam library.

### 0.3.0

Verified against Sandustry 0.5.5. Self-test: 104 checks.

This run fixes the reason official (`manifestVersion: 1`) mods appeared in the
manager as **Enabled** while doing nothing in game
([#1](https://github.com/LopeKinz/SandLoader/issues/1)). It was not one bug but
a chain of five, each hidden by the one in front of it.

**Fixed — official mods now actually run**

- Official mods were never executed at all. `readMod()` forced `entry` and
  `workerEntry` to `undefined` on the theory that the native bridge (staging
  into `<userData>/mods`) would run them instead. Sandustry has no local-mod
  loader — it delegates to whatever holds the Workshop loader slot, which is
  SandLoader — so nothing ran them. Staging reported success, the manager showed
  Enabled, and no error was raised anywhere.
- `state.sandkit.getApi()` is called 44 times by the renderer and defined
  nowhere; only the simulation worker defines one. Supplying it is the host's
  job. New `smln:sandkit-get-api` patch attaches it to the game's own sandkit
  object, which is why `SMLN.sandkit` was permanently `null` before.
- Mod content never reached the simulation workers. The game flushes
  `sandkit.mods` to them once during world init, *before* `game:ready` — and
  official entries run at `game:ready`. Content landed on the main thread only:
  registered, no error, invisible. The runtime now repeats the flush once the
  entries settle, using the game's own messages and registries.

**Fixed — vendored game data**

Both of these failed silently, because mods read enums inside their own
`try`/`catch`:

- `MatterType` was id→name only. Sandustry's enums are bidirectional, so the
  documented `MatterType[def.matter]` returned `undefined`. Atomic Age breaks
  out of its element loop on the first bad matter type, so it registered **zero**
  elements while still reporting itself loaded.
- The `Tech` enum was missing entirely, so `sandkit.enums.Tech.Smelter` threw,
  the parent id came back `undefined`, and every mod research node was skipped.
  Extracted from the bundle: 104 members.
- The enum tables handed to mods are now bidirectional, matching the game.

**Fixed — adapter argument order**

- The adapter assumed every legacy method is state-first. `i18n`, `utils` and
  `random` take no state at all, and `tech` is mixed (`isLocked` takes state,
  `getDefinition`/`addDefinition`/`updateDefinition` do not). Binding state
  shifted every argument by one — `i18n.register("en", table)` arrived as
  `register(state, "en")` and the table was dropped, which is why mod strings
  rendered as `[MISSING: tech|…|name]`.

**Added — compatibility shim layer**

- `src/renderer/sandkit-shims.js` implements v1 Sandkit calls this build has no
  equivalent for, on top of what it does have. Nothing is shadowed: a shim
  installs only where the live API lacks that name. Includes
  `structures.processing` (a real per-structure scheduler), `hooks.intercept`
  (genuine cancellation through the engine's control object),
  `world.revealFogAtCell` (the game's own `StartFogReveal` worker message),
  `tech.registerNode`, `ui.inject`, `i18n.register` and ~20 more.
- Approximations are labelled as such and warn once at runtime:
  `player.setMovementMode` cancels falling rather than granting lift;
  `structures.recipes` is a registry only (this build has no recipe system);
  `structures.registerPlacementConfig` applies field defaults, with no hotbar UI.

**Added — React and webpack bridges**

- `src/renderer/webpack-bridge.js` reaches the game's own module registry,
  finding modules by *shape* rather than by minified id.
- `src/renderer/react-bridge.js` hands mods the game's **live** React instance
  (a second copy would break hooks). `sandkit.react` was always `null` before,
  so six of the eleven bundled mods died on their first line.

**Added — knowing what a mod can't do**

- Mod sources are scanned for the Sandkit namespaces they call, resolved
  against the live API, and anything this build cannot satisfy is named on the
  mod's row in the manager instead of failing later as a dead button.
- New console commands: `sandkit` (the v1 API, marking calls SandLoader
  supplies), `shims`, `content` (what mods actually registered), `mods`, and
  `hooks`.
- The self-test now verifies the vendored enum tables against the installed
  bundle — 159 entries across `MatterType`, `Tech`, `ToolType` and `CellType`.
  Both enum bugs above would have been caught before launch.

### 0.2.0

Verified against Sandustry 0.5.5.

**Making content**

- `SMLN.register` on top of the game's own `FH` registry: elements, terrains,
  matters, structures/machines, items, sprites, projectiles, triggers, key
  bindings, conveyor/launcher/energy types and hooks. Calls made before
  `game:ready` queue and flush in order, duplicate ids are refused naming the
  mod that got there first, and one failing registration never aborts the rest.
- `SMLN.assets.url()`, served through the interceptor that already owns the
  game's `file://` requests — no second web server.
- Translation registration mapped onto the real `FH.i18n.register(locale, table)`,
  namespaced per mod, with English fallback.
- Content reference tables (`SMLN.enums.ELEMENT_INFO` and friends) for names,
  descriptions, phases and colours before a save is loaded.

**Security**

- A real capability model: `SANDBOXED` / `ELEVATED` / `NATIVE`, derived from
  where code runs plus what the manifest declares, shown as a badge on every row.
- `SMLN.net` and `SMLN.fs` are gated on declared permissions; without them the
  call rejects and no request is made.
- Per-mod private storage that traversal, absolute paths, UNC paths, Windows
  device names and symlink escapes cannot leave.
- Install review reads the manifest **out of the archive without unpacking or
  executing anything**. Approvals bind to mod id + version + permission set;
  an update that adds a permission asks again, dropping one does not.
- Permissions can also be granted or withdrawn later from **Details**. Granting
  a native mod there opens the same review dialog, warning included.
- Native mods are supported and clearly labelled. SandLoader does not claim to
  sandbox them — a mod with `node` gets a real `require`, and the UI says so.

**Reliability**

- A broken mod no longer costs you the others: every load stage is contained
  per mod, and failures are visible in the splash, on the row, and in a new
  **Problems** panel with the real error text.
- Patch conflict detection on actual source ranges, checked before anything is
  rewritten. Cross-mod overlap fails safely; deliberate overlap needs both
  patches to opt in.
- Hooks re-resolve themselves when the game updates. Each anchor may declare
  ordered fallbacks around the same invariant literal; adoption is gated on the
  patched bundle still parsing, and everything adopted is reported, never
  silent. It cannot invent a hook, and says so when one is genuinely gone.

**Mod management**

- Steam Workshop items are recognised, tagged with their published id, and
  never deleted from disk — Steam would simply re-download them. The row offers
  **View in Steam** instead, and the footer a **Browse Workshop** link.
- In-game settings from `configSchema`, validated before they persist, with
  per-field and panel-level reset.
- Dependencies enforce semver ranges (`"library-mod": "^2.1.0"`) with five
  distinct failure kinds instead of one vague one.
- Hot reload with `SMLN.onDispose()` and three honest stages: renderer-only
  swap, full context rebuild, or "restart required" when it genuinely is.

**Cross-context**

- Game ↔ Worker messaging in both directions, plus Fluxloader's
  `sendWorkerMessage` / `listenGameMessage` and the remaining Fluxloader IPC.
  Late handlers still receive earlier messages, a throwing handler cannot stall
  the simulation worker, and two mods cannot read each other's channels.
- Fluxloader mods now each get their own `fluxloaderAPI` — previously one
  shared global, so the second mod overwrote the first's id, config and channels.

**Platforms and UI**

- GOG and standalone installs supported through an additive `resources/app`
  bootstrap. No original file is modified. Microsoft Store and Game Pass are
  reported as unsupported, with the specific reason.
- English and German throughout, with a language picker.
- Reworked console: header with live context, colour-coded output, highlighted
  completions with colour swatches, drag to resize.
- Rebuilt splash: a boot report listing every mod with its security badge, the
  hook targets, and the first problems inline.

**Fixed**

- `ELEMENT_PHASE` was hand-written guesswork — wrong in 14 of the 18 cases that
  could be checked, and covering only 20 of 50 elements. Now derived from the
  game's own `matterType` values.
- The version was hardcoded in four places and could drift; `package.json` is
  now the single source.
- `src/renderer/sandkit-adapter.js` was never loaded (missing from the prelude).

### 0.1.0

Initial release: in-game console, mod manager, in-memory patching against the
game's own loader slot, and Fluxloader mod compatibility.

---

## Status

SandLoader **0.3.4**, verified against **Sandustry 0.5.5**. Self-test: **130/130**.

## License

[MIT](LICENSE)
