# SandLoader

A mod loader for **[Sandustry](https://store.steampowered.com/app/2764460/Sandustry/)** with an
in-game console, a mod manager, and support for existing
[Fluxloader](https://fluxloader.app/) mods.

**No file's content is ever modified.** Patching happens in memory while the game
loads, so a game update can never leave a broken patched file behind. Where the
build still offers a loader slot, nothing in the install is touched at all.
Sandustry **0.5.6** removed that slot, so there SandLoader renames `app.asar`
aside and puts a directory of its own in its place — renaming the two paths back
is the uninstall, and Steam's *Verify integrity of game files* undoes it
(`node install.js --repair` puts it back).

Works on **Steam**, **GOG** and **manual/standalone** installs.

**Vanilla branch only.** SandLoader targets Sandustry's default `public` branch. The
experimental modded branch ships a different Sandkit generation and is not supported.

```
Press  ^  (or F1) in game        →  console
Main menu → "SandLoader Mods"    →  install / enable / remove mods
Main menu → "Maps"               →  browse, import, edit and play maps
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
- [Custom maps](#custom-maps) — the `.custommap` format, where maps live, and
  how a mod ships one
- [The map editor](#the-map-editor) — draw a playable map in game, and the
  limits that shape it
- [Missions and story](#missions-and-story) — objectives, speakers and story
  beats a mod can add, and how they reach across mods
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
| **Attach** | The Workshop loader slot where the build still offers one (up to 0.5.5); otherwise a shadow directory at `resources/app.asar`, with the original renamed aside |
| **OS** | Windows, Linux or macOS |
| **Node.js** | **18 or newer**, only to run the installer — [nodejs.org](https://nodejs.org) |

### Which stores work

| Store | Status | How SandLoader attaches |
|---|---|---|
| **Steam** | supported | the game's own Workshop loader slot where the build still offers one (up to 0.5.5); on 0.5.6 a shadow `app.asar` directory, with the original renamed aside |
| **GOG** | supported | an added `resources/app/` bootstrap — no original file is modified |
| **Manual / standalone** | supported | same bootstrap |
| **Microsoft Store** | **not supported** | package is ACL-protected and signature-verified |
| **Game Pass** | **not supported** | same package, same reason |

Up to 0.5.5, Sandustry scanned for a mod loader on Steam and nowhere else — its
own `main.js` started that check with `if (PLATFORM_NAME !== 'steam') return
null`. **0.5.6 removed the scan entirely**, so on every store SandLoader now
supplies its own entry point by adding a directory Electron already looks for:
`resources/app/` on GOG and standalone builds, and on Steam a directory that
takes over the `app.asar` name with the original renamed aside. No file's
content is overwritten and uninstalling puts the names back. Details in
[Non-Steam builds](#non-steam-builds).

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
  attach    asar-shadow-directory
  attach    C:\...\steamapps\common\Sandustry\resources\app.asar
  original  C:\...\common\Sandustry\resources\app.smln-original.asar
  loader    C:\...\sandloader\src\boot\bootstrap.js

  Fetching SteamCMD - needed for "Install from Workshop".
  fetching  https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip
  got       757 KiB
  steamcmd  C:\...\sandloader\vendor\steamcmd\steamcmd.exe

  Installed. Start Sandustry and press ^ (or F1) to open the console.
  No file's content was modified; two paths were renamed.
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
  version   0.4.0
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

## Custom maps

Main menu → **Maps** opens SandLoader's own map browser: every `.custommap` the
game can see, a preview of whichever one is selected, and a **Play** button. The
game has a custom-maps screen of its own in this build, but its load action only
shows a "coming soon" panel, so this is not overriding something that already
worked.

Two kinds of map share one folder, and each row says which it is: a map mod's,
written by SandLoader, and the player's own — saved by the game, or brought in
with **Import map…** from anywhere on disk.

**The support was there all along.** The game reads `.custommap` files from
`custom_maps` under its user data folder, and the four IPC handlers that save,
load, list and delete them sit **outside** the build's `MODDING_ENABLED` gate.
Nothing had to be added to the game and nothing had to be patched into it. What
was missing was anything that wrote the file.

### What a `.custommap` is

Two lines. The first is metadata — id, name, seed, recorded size. The second is
the whole document, carrying **six layers**, each one `{width, height, dataUrl}`
with a base64 PNG in the data URL. The game's own save routine writes it that
way and its two readers split on exactly that boundary, so a file written as a
single JSON object lists perfectly and then fails the moment it is opened.

| Layer | What the game does with it |
|---|---|
| `terrain` | One pixel is one world cell. RGB is looked up in a palette to decide what that cell is made of, and the world's size *is* this image's size — there is no scaling step. |
| `lights` | Every pixel that is not transparent becomes a point light on that cell, coloured by its own RGB. |
| `lightsMeta` | A per-pixel override for the light at the same coordinate: its brightness and its size. |
| `sensors` | Artifact markers. |
| `authorization` | A per-cell restriction zone — no jetpack, no grabbing, no building, no digging, and the combinations of those. |
| `wall` | The cosmetic backdrop drawn behind the world. Collision never reads it. |

**All six are mandatory.** The game's loader awaits all six at once with no
undefined-guard, so a file missing one does not lose that layer — it fails to
load at all, with a generic `TypeError` and no friendly message. A blank
stand-in would be a guess about what an invented layer means to the game, so
SandLoader refuses an incomplete set rather than padding it.

### A map that ships with a mod

A mod names its six blueprints in its manifest; SandLoader assembles them into
the file the game already reads and writes it straight into `custom_maps`. There
is no separate map format to learn and no packaging step.

```json
{
  "id": "canyon",
  "name": "Canyon",
  "version": "1.0.0",
  "map": {
    "blueprints": {
      "terrain":       "map/terrain.png",
      "lights":        "map/lights.png",
      "lightsMeta":    "map/lights-meta.png",
      "sensors":       "map/sensors.png",
      "authorization": "map/zones.png",
      "wall":          "map/wall.png"
    }
  }
}
```

The map appears in the browser tagged **Mod**, under the mod's own name, and
leaves with the mod when it is disabled or removed.

### Only files SandLoader wrote are ever pruned

A mod's map is named `smln.<modId>.custommap`, and pruning considers nothing
else — the player's own maps live in the same folder and are not ours to remove.

An imported map is therefore **deliberately renamed** if its name would look
like one of ours. A file called `smln.custommap` would otherwise be deleted on
the next launch, as the leftover map of a mod that is no longer installed. The
id inside the file is rewritten to match its new name at the same time, because
the game opens a map by asking for `<id>.custommap`, and a file whose name and
id disagree lists perfectly and then fails the moment it is started.

### The flight ceiling scales with the map

The game refuses to let the player hover inside a fixed **600-pixel** strip at
the top of the world, and puts a collision ceiling at **550**. Both numbers were
chosen for the vanilla world, which is 3840 cells — **15,360 pixels** — tall,
where 600 pixels is a **3.9%** band across the top.

Neither number scales. On a custom map they are the same two absolutes, so a
320×240 map had **62.5% of its height** as a no-fly zone. SandLoader scales the
strip to the map's own height, keeping the proportion the vanilla world has; a
map at least as tall as the vanilla world keeps the game's own numbers
untouched.

Measured: that same 320×240 map goes from 62.5% to **3.9%**, and a player hovers
where the game previously refused.

### Two limits, stated plainly

- **A custom map reloaded from a save gets the vanilla ceiling.** Whether a
  world is a custom map is read from `custom_map=` in the game's own URL, which
  is the only record of it — the state carries no marker for it anywhere. A
  custom map saved and reloaded through the game's save system comes back under
  `load=` instead, and **there is no state-side signal to tell it apart from the
  vanilla world**, so the fixed 600-pixel strip applies again. Documented, not
  fixed: fixing it properly needs a marker written into the save.
- **The `wall` layer's encoding is unverified.** Its decoder was never found in
  the bundle. The editor offers a free colour and a live count against the
  254-value ceiling that layer's palette has room for, and invents no meaning
  for what those colours look like in the world.

---

## The map editor

Create a map from nothing at a size you choose, paint it, check it, save it,
play it — all inside the game, with no external tool and no file to
hand-assemble. It opens from the same Maps browser: **New map…** in its footer,
or **Edit** beside Play on a map that already exists.

### The size floor is 158 × 201 cells

Not a preference and not a round number. The game drops the player at one fixed
position and never looks to see what is there:

```js
// the branch a .custommap always takes
x = (widthInCells / 2) * cellSize + 315   // half the width, plus about 79 cells across
y = 200 * cellSize                        // row 200, whatever the map's height
```

There is no scan for open ground, no fallback and no second attempt. A map
narrower than 158 cells puts that x past its own right edge; a map shorter than
201 cells has no row 200 at all. Either way the player starts *outside the
world*. So the editor will not create a document below that size, the resize
dialog refuses one, and the validator reports it as an error rather than a
suggestion. There is no way to move the spawn.

### The ceiling is total cells, not cells per axis

The game's own per-axis limit is **16,383** cells, because a shared mouse
position is carried in a `Uint16` of world pixels and anything past that wraps
around — clicks, digging and building would all land somewhere other than where
the player aimed. But both axes at that limit at once would be **268 million
cells**, which is not a map anything can hold. A per-axis rule is the wrong
shape for the real constraint.

Measured, not estimated: **8000×4000** — 32 million cells — opened in **5.0 s**
and saved a **4.4 MB** file, while driving the renderer to **1.78 GB** with a
**3.08 GB** peak. The editor caps at half of that: **16 million cells**, however
they are shaped.

Both size dialogs show a **live memory figure** while a size is being typed —
about **34 bytes a cell**, measured against a 1162 MB baseline — so what a size
will cost is visible before it is committed rather than discovered afterwards. A
refused size says so, and says which of the two rules refused it.

### The palette says what the player gets, not what the colour is called

This exists because a test map built from two colours the format documents came
out unplayable, and neither colour did what its name suggested.

- **`102,102,102` is not background rock.** It is **Fog**, the sealed-pocket
  material. The palette entry really does say `{bg: Stone, fg: Fog}`, but the
  terrain resolver reads only `.fg` and throws the rest away, so no background
  stone is ever placed. Fog is solid on load; break a single cell of it and an
  unbounded flood fill walks every connected fog cell and turns *the whole mass*
  to open air.
- **`34,34,34` is bedrock** — solid, collidable and permanently un-minable. It
  carries no hit points, so the game's own destructibility test is false for it
  and no tool ever damages it.

So every row in the picker is labelled by outcome: *Solid rock (needs a drill)*,
*Bedrock (permanent floor)*, *Crackstone (needs dynamite)*, *Open air*. Every
fog row says **"blocks until dug"** in its *label* and not only in its note, so
nobody scanning the list for air can reach for one blind.

**Alpha 0 is not air either.** A fully transparent terrain pixel does not
resolve to empty space — it decodes to Fog, the same collidable, flooding
material. Every terrain pixel must be opaque. So the eraser writes the palette's
real empty colour rather than clearing to transparency, a blank document starts
full of that colour rather than blank, and a see-through pixel is an error at
save time, not a warning.

### Six layers, six different surfaces

The same bytes mean different things in different layers: a colour that is solid
rock in `terrain` is a brightness and a size in `lightsMeta`. Offering the terrain palette
whatever layer was selected meant an author could pick a rock colour and write a
number they never typed and could not see. So each layer gets the surface its
own decoder deserves.

| Layer | Surface | Why that one |
|---|---|---|
| `terrain` | the palette | A fixed table of the colours the resolver recognises, labelled by what each one gives the player. |
| `lights` | a colour picker | The pixel's RGB *is* the light's colour, straight through. Any colour is legitimate, so there is no table to offer. |
| `lightsMeta` | two numeric fields | It is two numbers wearing a colour's clothes: R is brightness × 100, G is size ÷ 4, B is unused. A **zero means "keep the default"**, not zero — the decoder tests each channel before it uses it. |
| `sensors` | two entries | Only pure red and pure yellow mean anything. Every other opaque colour silently becomes Artifact 1, so two entries is the honest surface and anything else is reported. |
| `authorization` | twelve numbered zones | Each one labelled by what it forbids rather than by its number. An unrecognised colour is zone 0, which restricts nothing at all. |
| `wall` | a free colour, with a count | A live count of distinct colours against the **254**-value ceiling that layer's palette has room for. |

Two things on this screen are **unverified**, and the interface says so. The
`wall` layer's encoding — its decoder was never found, so nothing there claims
to know what its colours mean. And the **1.1× brightness special case**: the
lights decoder singles out `58,211,204` and raises that light's brightness to
1.1, which the interface states but nobody has confirmed the game honours in
play.

### Tools, transforms, and what a save refuses

Brush, eraser, fill, line, box and eyedropper, with undo and redo over all of
them. Resize, crop, mirror and shift run on **all six layers together, as one
undo step**, because the six have to stay the same size as each other: a layer
whose size disagrees with the terrain layer is read at the wrong offset from the
second row onward, so what was drawn on it slides further sideways with every
row down the map, smearing diagonally across the world without a word of
complaint. The spawn cell — the one thing in the world an author cannot see and cannot move — is
drawn on the canvas as a marker.

Before a save, the map is checked against rules written for a mapmaker rather
than for a debugger. Each names something the player will experience, in the
words someone holding a brush would use, because none of it is visible until a
map is loaded.

**Errors — the map will not play.** No terrain layer; a size the game cannot
carry; layers that disagree about how big the world is; a recorded size that
does not match the terrain layer; see-through terrain pixels; a colour that
makes the game abandon the map on load; a spawn outside the world; more wall
colours than the backdrop's palette can hold.

**Warnings — it will play and disappoint.** A spawn buried in solid rock; fog
the author may not have meant, with the size of its largest connected patch; a
terrain layer that is all one colour, or has nothing solid in it at all;
artifact and zone colours that will silently become something else; light
settings with no light underneath them.

**Errors block a save; warnings do not.** A map that will not open is refused. A
map that will open and disappoint is reported and then saved anyway — the author
is the one who knows whether a wall of fog is a mistake or the whole point of
the map.

---

## Missions and story

A mod can put objectives into the game's mission panel and beats into its story
chain. Neither table has a registry API — they are module-scope literals the
game assumes it is the only writer of — so the SDK's whole job is to put a mod's
entry in, keep it there, and supply the four things the game does not: running
the predicate, remembering the completion, keeping ids apart, and refusing
content whose mod is absent.

It hangs off the per-mod facade. Inside a renderer mod `SMLN` *is* that facade,
so `SMLN.story` is the whole surface:

```js
SMLN.story.speaker('surveyor', { name: 'MARA', portrait: PORTRAIT, color: '#8ec5ff' })

SMLN.story.objective({
  id: 'first-quota',
  title: 'Fill the survey quota',
  description: 'Hold 250 gold at one time.',
  check: function (state) { return state.store.resources.gold >= 250 },
})

SMLN.story.step({
  id: 'briefing',
  after: 'establish_wet_sand_processing',
  messages: [
    { speaker: 'surveyor', text: 'Core sample says this seam runs deep.' },
    { speaker: 'zoe', text: 'File it once the sand is moving.', showObjective: true },
  ],
  completeWhen: { objective: 'first-quota' },
})
```

A commented, loadable version of exactly that — plus all three cross-mod
mechanisms and a console command to watch it work — is
[`mods/example-missions/`](mods/example-missions/).

### The surface

```
story.modId                        this mod's namespace, as a string

story.objective(def)               -> boolean
story.complete(id)                 -> boolean
story.isComplete(id)               -> boolean

story.speaker(id, def)             -> boolean
story.step(def)                    -> boolean
story.isStepComplete(id)           -> boolean

story.emit(name, payload)          -> publishes <modId>:name
story.on(event, fn)                -> off()
```

`false` from a registration means refused, always with a named error carrying
the mod id and a code — `E_STORY_BAD_ID`, `E_STORY_MISSING_DEPENDENCY`,
`E_STORY_DUPLICATE_ID`, `E_STORY_NO_PORTRAIT`, `E_STORY_NO_SPEAKER_TABLE` and so
on. It goes to the log *and* to the in-game Problems panel, because a refusal
only a log file ever sees is invisible to exactly the person it is for. `true`
means registered, or queued until the game has started; either way the
definition was accepted, and a refusal at flush time is still reported against
the mod by name. **Nothing here throws at a mod** — a bad definition must not
abort the mod that wrote it.

**`objective(def)`**

| Field | Required | |
|---|---|---|
| `id` | **yes** | Bare. Registers as `<modId>:<id>`; a `:` written by hand is refused. |
| `title` | no | Literal text, or an i18n key — any string containing a `\|`. |
| `description` | no | Same. |
| `check` | no | `(state) => boolean`, run by the SDK about once a second. |
| `next` | no | Ids chained onto the active list when this one completes. |
| `requires` | no | Mod ids that must be installed **and** enabled. |

**`speaker(id, def)`**

| Field | Required | |
|---|---|---|
| `portrait` | **yes** | A `data:` URL, or a path to one of this mod's own assets. Anything else is left to resolve under the game's `dist/`, the way its own portraits do, and that is said out loud in the log. |
| `name` | no | Literal text or an i18n key. Defaults to the bare id. |
| `color` | no | Frame and label colour. Defaults to the game's own `#ffe700`. |
| `borderColor`, `labelColor` | no | Override `color` one at a time. |
| `requires` | no | As above. |

**`step(def)`**

| Field | Required | |
|---|---|---|
| `id` | **yes** | Bare, namespaced like everything else. |
| `messages` | **yes** | At least one — the messages are the beat. |
| `after`, `before` | no | Which step this one sits next to. |
| `completeWhen` | no | What finishes it; see below. |
| `objectiveLabel`, `objectiveDescription` | no | Literal text or an i18n key. |
| `blocksFactoryLevel`, `requireAccept`, `notificationDelayMs` | no | Passed through to the game's own fields of those names. |
| `requires` | no | As above. |

A message keeps the game's own field names, because they are the vocabulary its
own steps are written in: `text`, `speaker`, `showObjective`, `style`
(`{color, italic}`), `characterSwitch`, `type`, `completedText`, `params`. If no
message carries `showObjective`, the SDK puts it on the last one — a step that
never becomes current can never complete, and the chain stops dead behind it.

`completeWhen` takes one of:

| | Run by | |
|---|---|---|
| `{ factoryLevel: N }` | the game | data the game already completes on its own |
| `{ waypoint: { x, y, radius } }` | the game | the position is written into the same save key the game's own steps use |
| `{ objective: 'id' }` | the SDK | bare means this mod's, `mod:id` means someone else's |
| `{ event: 'mod:name' }` | the SDK | remembered in memory only — a world reload forgets that it fired |
| `{ check: fn }`, or a bare function | the SDK | |
| *omitted* | the SDK | a dialogue-only beat, finished the moment the player has read it |

### Ids are namespaced, always

`objective({ id: 'first-quota' })` from `example-missions` registers as
`example-missions:first-quota`. Two mods cannot collide in a table the game
believes it owns alone, the author of a broken objective is in the log line
without a lookup, and a cross-mod reference has to name the mod it means — which
is what makes the next section honest rather than accidental.

Vanilla ids stay bare. A bare id the game already owns — `find_fluxite`,
`establish_wet_sand_processing` — means the game's own and cannot be shadowed;
any other bare id means the calling mod's. Writing a `:` into a registration id
is refused, because that is the one way a mod could aim at another namespace by
hand.

### Reaching across mods

Three ways, in increasing order of coupling.

| | Write | Reach for it when |
|---|---|---|
| **Declared dependency** | `requires: ['gas-pipes']` | the content makes no sense without the other mod. Absent or disabled, it is not registered at all, and the log names both mods and which of the two it was. The mod itself still loads — this is per-registration, unlike the manifest's `dependencies`. |
| **Reference by id** | `completeWhen: { objective: 'other.mod:their-goal' }`, `after: 'other.mod:their-step'`, `next: ['other.mod:their-goal']` | the two pieces genuinely belong to one chain. A reference nothing ever registers is reported once, by name, instead of waited on forever. |
| **Event** | `story.emit('reactor-online')` publishes `<modId>:reactor-online`; anyone finishes on `completeWhen: { event: 'my.mod:reactor-online' }` | the emitting mod should not have to know who is listening. This is what lets a mission pack ship for a machine mod that has never heard of it. |

Ordering is by declaration, never by load order: a step naming an `after` that
has not registered yet waits for it, and the queue is retried until it stops
moving, so a chain of mod steps lands whichever order the mods loaded in. After
five ticks the reference is declared missing, reported once by name, and the
step is appended to the end rather than dropped. Load order is not something a
mod author can control, so it must not be something they have to reason about.

### Why the SDK runs its own predicates

`check` is a field the game already has, and its evaluator is generic — but that
evaluator fires at only three event sites, and seven of the twelve shipped
objectives are completed by hard-coded calls elsewhere. A mod's predicate left
in the game's table would sit there unevaluated forever. So the SDK keeps the
predicate itself and ticks it, about once a second and deliberately not per
frame, because a mod's predicate must not become a cost the simulation pays.

A mod's `check` is therefore **never written into the game's table**. The shipped
evaluator does not catch, so a predicate left there would throw inside the game's
own tech-unlock handler. Inside the SDK it is wrapped: a throw is logged against
the mod that wrote it, and after three throws that one predicate is switched off
and reported rather than throwing every second for the rest of the session. One
bad mod does not take the others down.

Step predicates ride the same tick with one difference: when one turns true the
SDK does not complete the step itself. It emits the game's own
`auralite:productionChanged`, whose only listener in the whole 4.3 MB bundle
re-evaluates the current step — so the chain advance, the next box, the
factory-level unblock and the waypoint cleanup are the vanilla ones, because
they *are* the vanilla path. The cost, stated plainly: a future build that adds
a second listener to that event would see it fired for a reason that is not
auralite.

### Why completion is recorded separately

The game deletes a completed objective from `store.objectives.active` about five
seconds later, and again at world load, and keeps no completed-set anywhere at
all. Left to that, a mod's objective would un-complete itself.

That deletion is left strictly alone — it is the game's behaviour and its reasons
are not ours to guess. Instead the SDK keeps its own record in the saved half of
the state, under `store.smlnStory`, re-read whenever the state or its store is
replaced, which is what a world load looks like from here. It is re-read as a
replacement and never as a union: two saves have two different sets of finished
missions, and carrying one into the other would hand a player completions they
never earned. `isComplete()` answers from that record, which is why it is the
right thing to ask and `store.objectives.active` is not.

Unloading a mod takes its objectives out of the game's table *and* out of the
active list — an id left in the active list of a save whose mod is gone is
permanent, because the game refuses to complete an id its table no longer
defines. The saved record is deliberately kept: a player who turns a mod off and
on again must not have to replay its missions.

### The speaker patch

The dialogue box reads its portrait, label and frame colour out of one
module-scope table with no accessor, no export and no write site, and it picks
with `speaker in table ? speaker : "zoe"` — so a speaker nobody registered is
silently drawn as ZOE. One core patch, `smln:story-speakers`, rewrites that
declaration so the same object also has an identity on the global, and
`speaker()` writes into it there.

That patch is declared `required: false`. On a build that reshapes the literal
it costs mod portraits and nothing else: the anchor reports itself broken,
`speaker()` refuses by name with `E_STORY_NO_SPEAKER_TABLE` rather than
registering a face that would never be worn, and objectives, steps, ordering and
completion all still work. A step whose message names a speaker nobody
registered is reported too, because the game's own answer to that is to draw ZOE
and say nothing.

### Limits, stated plainly

- **A step inserted after a step the player has already completed is never
  reached.** Chaining is array order and, in an existing save, the chain has
  already run past that index. A new world plays the beat; an old one does not,
  and nothing in the SDK can change that.
- **`{ event: … }` completion is remembered in memory only.** A world reload
  forgets that the event fired.
- **The save round trip is inferred, not measured.** The save is written
  wholesale with no field whitelist, so `store.smlnStory` does travel out to
  disk; that the same key comes back on load follows from that same shape and
  has not been watched happening.
- **A `data:` URL portrait has not been seen rendering, and a mod's beat has not
  been seen on screen.** The table writes, the namespacing, the ordering, the
  refusals and the completion record are covered by `tools/selftest.js` against
  fakes of both tables, and the mission half has been watched registering and
  completing in the running game. The pixels have not been watched.
- **Two writers on one table.** The SDK writes only its own namespaced ids and
  never reorders or removes a vanilla entry, but a game update that starts
  rebuilding either table would drop mod content at that moment. The anchors
  report it.
- **Additive only, and no rewards.** Vanilla objectives and steps are never
  replaced or rewritten, branching has no field that expresses it, and the
  objective table has no reward field — completion sets a flag and chains
  successors. A mod that wants to give something does it from its own handler on
  `story.on('story:complete', …)`.

---

## How it works

### Where the game has a loader slot, SandLoader fills it

Up to 0.5.5, Sandustry's own `main.js` scanned
`steamapps/workshop/content/2764460/*/` for a `modinfo.json` declaring
`modID: "fluxloader"`, `require`d the `fluxloader.bundle.js` next to it, and
drove it through a fixed interface:

```js
initialize(hostAPI) → { success }    // hostAPI: { ipcMain, shell, dialog, screen,
startManager()                       //            createWindow, paths, startGame }
getAPI() → { events: { trigger } }
setGameWindow(win) · onGameStarted() · closeGame()
```

That is the **game's ABI** — the contract a host offers a loader. SandLoader
implements it directly. It shares no code with the Fluxloader project; it answers
the same phone number, and separately knows how to read Fluxloader's mods. Two
self-test checks still ask the installed build for that slot and that ABI, and
on 0.5.6 they fail on purpose: that is how the project finds out the day a host
stops offering them.

### Everywhere else — which is now everywhere — SandLoader brings its own

That Workshop scan was Steam-gated and 0.5.6 dropped it, so on GOG, standalone
and now Steam nothing ever looks for a loader. There SandLoader adds a
`resources/app/` directory: Electron
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

- **Sandustry 0.5.6 removed the loader slot.** Up to 0.5.5 the game's own
  `main.js` scanned the Steam Workshop for a loader and drove it through six
  calls. On 0.5.6 none of that is left, so SandLoader attaches by taking over
  the `app.asar` name instead: the original archive is renamed to
  `app.smln-original.asar`, its `.unpacked` sibling moves with it, and a
  three-file directory takes their place. No file's content is modified and
  renaming the two paths back is the uninstall — but this is a rename, not the
  zero-touch install the Workshop slot was. Steam's *Verify integrity of game
  files* undoes it; `node install.js --repair` puts the pieces back.
- **The game has its own modding system now, switched off.** 0.5.6 ships
  Workshop discovery, patch sets, a local `mods` folder and a protocol
  interceptor behind `const MODDING_ENABLED = false`. Nothing SandLoader does
  turns it on, and if a later build enables it that deserves designing for
  properly rather than bolting on.

- **Recipes work on 0.5.6, and only there.** 0.5.6 added a recipe registry with
  nine machine categories — contacts, shakers, kineticPresses, growers,
  condensers, steamDryers, synthesizers, snowmakers and smelters.
  `SMLN.register.recipe()` registers into it, and corelib's four recipe kinds
  are translated onto three of them: shakers, kinetic presses and growers (the
  game calls the grower machine `planterBox`). Contact recipes - element meets
  element - have no machine id on this build and cannot be registered at all;
  they are reported per recipe rather than silently dropped. On 0.5.5 and
  earlier there is no registry
  at all and `register.recipe()` says so rather than pretending. corelib seeds
  about nine recipes the game already implements natively; those are forwarded
  too, so those reactions exist twice and a weighted output can shift.
- **Worker entrypoints get the simulation worker's Sandkit.** The worker builds
  a full one - `getApi()`, the event and interceptor tables - but the state
  holding it is module-local, so an injected script could not see it. That, and
  not a missing API, was all `ReferenceError: sandkit is not defined` ever meant.
  SandLoader publishes the state and hands it over through
  `SMLN.whenWorkerReady(fn)`, which waits because mod code runs before the
  game's worker code does. `SMLN.worker.onEvent` and `SMLN.worker.onInterceptor`
  register handlers that carry their mod's name into any failure and cannot take
  a simulation tick down. Only the **simulation worker** builds a Sandkit; a
  `workerEntry` running in the utility worker still gets messaging and no more.
- **Fluxloader worker mods are translated, not run.** They call corelib, and
  corelib's worker API is built from `exposed.raw` - filled by a patch against
  `js/336.bundle.js`, a chunk Sandustry 0.5.6 no longer emits. Nothing can
  revive that, so SandLoader publishes `corelib` and `fluxloaderAPI` itself,
  with the calls the bundled mods make reimplemented against the game's worker
  API. corelib's own worker entry is skipped, because its last line would
  replace that surface with the broken one. What has no equivalent is reported
  through `SMLN.unsupported()` rather than silently doing nothing.
- **Map mods load, and so do the player's own maps.** The support turned out to
  be exposed all along: the game reads `.custommap` files from `custom_maps`
  under its user data folder, and four IPC handlers for them sit outside the
  `MODDING_ENABLED` gate. A map mod's blueprints are assembled into that file
  and written straight into the folder, and the main menu's Maps button opens
  SandLoader's own browser with a preview, rather than the game's own screen,
  which ships switched off and unfinished. A `.custommap` from anywhere else
  can be brought in from that browser.
- **Only files SandLoader wrote are ever removed.** A mod's map is named
  `smln.<modId>.custommap`, and pruning considers nothing else — the player's
  own maps live in the same folder and are not ours to touch. An imported map
  is deliberately renamed if its name would look like one of ours, because a
  name we could have written is a name the pruner may delete.
- **A custom map reloaded from a save gets the vanilla flight ceiling.** The
  no-fly strip at the top of the world is scaled to a custom map's own height,
  but only when the game is opening one: the test is `custom_map=` in the
  game's URL, which is the only record that a world is a custom map. Reloading
  one through the game's save system brings it back under `load=`, and no
  state-side signal distinguishes it from the vanilla world, so the fixed
  600-pixel strip applies again. See [Custom maps](#custom-maps).
- **The `wall` layer's encoding is unverified.** Its decoder was never found in
  the bundle, so the [map editor](#the-map-editor) offers a free colour and a
  live count against the 254-value ceiling, and invents no meaning for what
  those colours look like in the world.
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

### 0.4.0

Verified against Sandustry 0.5.6. Self-test: 284 checks (+154) — **281 passing, 3
failing on purpose** (see the end of this entry).

This run is about the game moving out from under the loader, and about what a mod
can put *into* the game once it is back in. Sandustry 0.5.6 removed the loader
slot SandLoader had been living in, so the first half of the work was attaching
to a build that offers nothing — and then re-earning every capability against a
bundle that had changed shape. The second half is new ground: maps a mod (or a
player) can draw and play, and missions and story beats a mod can write.

Grouped by subsystem, and by what each one changed for someone using SandLoader.

**Added — the shadow attach: SandLoader runs on 0.5.6 at all**

- 0.5.6 deleted the Workshop loader scan from the game's own `main.js` and the
  `startGame` half of the host API with it. There is no slot left to occupy, so
  the installer parks `app.asar` as `app.smln-original.asar` — its `.unpacked`
  sibling moves with it — and puts a three-file directory in its place, which is
  what Electron loads first. **No file's content is modified**, and renaming the
  two paths back is the uninstall.
- The strategy is chosen from what the installed build actually offers, not from
  its version number: the installer probes for the loader slot and takes it where
  it is still there. A build that restores the slot is attached the old way again
  with no code change.
- `node install.js --repair` puts a half-applied or orphaned attach right and
  names what it found — including the case where Steam's *Verify integrity of
  game files* restored the archive and left our copy of the original behind.
  Nothing that SandLoader did not create is ever renamed or removed.
- Measured, not assumed: the attach was proven by starting the game the way a
  player does and watching it come up modded.

**Added — content reaches the game's own registries**

- Fluxloader mods' **elements, soils, blocks and tech nodes** now arrive in the
  registries the game itself reads, rather than through patches whose anchors
  0.5.6 no longer contains. Blocks and tech nodes are new here; elements and
  soils were bridged in 0.3.4 and now travel the same route.
- **Recipes work on 0.5.6**, and only there. The build added a registry with nine
  machine categories, `SMLN.register.recipe()` registers into it, and corelib's
  four recipe kinds are translated onto three of them — shakers, kinetic presses
  and growers (the game calls the grower `planterBox`). Contact recipes — element
  meets element — have no machine id on this build and are reported per recipe
  instead of vanishing. Element names in a recipe are resolved to the type
  numbers the registration returned, so a mod's own element can be an ingredient.
- Element type numbers are asked of the game instead of read from a vendored
  table of 18, and `getApi` is anchored on the assignment rather than on a
  literal 0.5.6 stopped emitting.
- Four compatibility gaps, each of which had been silently costing a whole mod,
  were fixed after installing five more real Fluxloader mods; map and skin mods
  now apply their content rather than loading and doing nothing.

**Added — the simulation worker's Sandkit**

- `ReferenceError: sandkit is not defined` inside a worker mod never meant a
  missing API. The worker builds a full one; the state holding it was
  module-local. SandLoader publishes that state and hands it over through
  `SMLN.whenWorkerReady(fn)`, which waits because mod code runs before the game's
  worker code does. `SMLN.worker.onEvent` and `SMLN.worker.onInterceptor` carry
  the mod's name into any failure and cannot take a simulation tick down.
- Only the **simulation worker** builds a Sandkit. A `workerEntry` in the utility
  worker still gets messaging and no more, and says so.
- **Fluxloader worker mods are translated, not run.** corelib's worker half is
  built from a patch against `js/336.bundle.js`, a chunk 0.5.6 no longer emits;
  nothing can revive it. SandLoader publishes `corelib` and `fluxloaderAPI`
  itself with the calls the bundled mods actually make reimplemented against the
  game's worker API, skips corelib's own worker entry, and reports what has no
  equivalent through `SMLN.unsupported()`. A Fluxloader worker mod does **not**
  get the worker's Sandkit.

**Added — custom maps**

- A map mod's blueprints are assembled into the `.custommap` file the game
  already reads and written into `custom_maps` under its user data folder. The
  support was exposed all along: four IPC handlers for those files sit outside
  the build's `MODDING_ENABLED` gate.
- The main menu's **Maps** button opens SandLoader's own browser, with previews,
  instead of the game's own screen, which ships switched off and unfinished. A
  `.custommap` from anywhere on disk can be imported from there.
- **Only files SandLoader wrote are ever pruned.** A mod's map is named
  `smln.<modId>.custommap` and nothing else is considered; an imported map is
  deliberately renamed if its name would look like one of ours. Measured: pruning
  removed an orphan and left a player's own file named one character away from it
  untouched. Measured too: a generated map loaded and played.

**Added — the map editor**

- Create a map from nothing at a size you choose, paint it, check it, save it,
  play it. Measured end to end: a 320x240 map made in the editor started in the
  game with the player at exactly the spawn the formula predicts.
- The colour palette is labelled by **what the player gets** — what a colour
  gives you when you dig it — rather than by colour name, because the bytes are
  not the thing the mapmaker is choosing.
- **Nine validation rules** written for mapmakers, run before a save: a map too
  small for the spawn the game will not move is refused, and the rest are named
  with what to do about them. Errors block a save; warnings do not.
- Drawing tools and pure resize/crop/mirror/shift transforms, proven against
  pixels rather than eyeballed.
- **Limits are measured, not estimated.** 8000x4000 — 32 million cells — opened
  in 5.0 s and saved a 4.4 MB file, while driving the renderer to 1.78 GB with a
  3.08 GB peak. The editor now caps by total cells at half of that, and shows a
  live memory figure while a size is being typed (about 34 bytes a cell, measured
  against a 1162 MB baseline). A refused resize now looks like a refusal instead
  of like nothing happening.

**Added — the mission and story SDK**

`SMLN.forMod(id).story` — inside a renderer mod, `SMLN.story` — lets a mod
register objectives, speakers and story beats under namespaced ids. Neither of
the game's tables has a registry API; they are module-scope literals it assumes
it is the only writer of. Documented in full under
[Missions and story](#missions-and-story), with a loadable example in
[`mods/example-missions/`](mods/example-missions/).

- **Missions are proven in the running game.** A mod registers an objective under
  a namespaced id and SandLoader ticks its predicate itself — the game's own
  evaluator fires at only three event sites and would never run it. Measured:
  completion landed 1016 ms after the predicate turned true, and unloading the
  mod returned the game's table to exactly its twelve vanilla entries.
- **Completion is recorded separately**, under `store.smlnStory`, because the
  game deletes a completed objective from its active list seconds later and keeps
  no completed set anywhere. That deletion is left alone; `isComplete()` answers
  from SandLoader's record, which is re-read as a replacement on world load and
  never merged, so two saves keep two different sets of finished missions.
- **Three ways to reach across mods**, in increasing order of coupling: a
  declared `requires` dependency, a reference by namespaced id, and events.
  Ordering is by declaration, never by load order.
- **Story is half proven, and this is the half.** Speakers and steps register
  into the game's own live tables, a step inserts at the position it names with
  the chain intact, and a mod's speaker sits beside the vanilla two. **Not
  verified: a dialogue beat actually appearing on screen, and a `data:` URL
  portrait actually rendering.** Reaching a mod's beat needs play up to a factory
  rank, which nobody has done. The table writes, namespacing, ordering, refusals
  and the completion record are covered by the self-test against fakes of both
  tables; the pixels have not been watched.
- Nothing here throws at a mod. A refusal is named, coded (`E_STORY_BAD_ID`,
  `E_STORY_MISSING_DEPENDENCY`, …) and reported against the mod that wrote it.

**Fixed — what a mod author and a player actually see**

- A mod's refusals reach the player through the Problems panel, not only the log
  — a refusal only a log file ever sees is invisible to the person it is for.
- Stack traces are folded out of the problem log, so the reason is readable
  without scrolling past the trace.
- The eight mod warnings that had never left English are translated.
- The install dialog names the mod it is asking about.
- The main menu no longer reads through the console overlay, and the completion
  rail no longer covers what you are reading.
- Three async self-test checks stopped failing for work that happens elsewhere;
  the map editor's canvas lost the invisible sheet that sat over it, and its
  layer list and name field stopped taking the room the palette needed.

**Docs**

- `docs/MODDING-REFERENCE.md`: how Sandustry is built, and all three mod formats
  that run on it.
- The website says what Fluxloader compatibility actually delivers — content
  bridges, behaviour needs anchors that still match — and now documents the
  mission and story SDK.

**Three self-test checks fail on purpose**

Two ask the installed host whether it still exposes the loader slot and the
`startGame` API; 0.5.6 has neither. One reports that a bundled third-party mod
calls `player.inventory.addFromId`, which this build cannot answer. They are the
project's tripwires for the host changing under it, so they are kept red rather
than deleted or weakened: a green run would only mean the questions stopped being
asked.

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

SandLoader **0.4.0**, verified against **Sandustry 0.5.6**. Self-test: **281 passing,
3 known failures** — two host-ABI checks that assert the host still offers a loader
slot and a `startGame` API, and one bundled third-party mod call this build cannot
answer. They are red on purpose: they are how the project notices the host changing
under it.

## License

[MIT](LICENSE)
