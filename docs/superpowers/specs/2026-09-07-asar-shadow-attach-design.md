# asar shadow attach

**Date:** 2026-09-07
**Status:** approved, not yet implemented
**Game:** Sandustry 0.5.6 (Steam, Electron 33.2.1)
**Goal:** SandLoader attaches to builds that no longer offer a loader slot, and
the attach point it falls back to is one that actually works.

## Problem

SandLoader does not load on Sandustry 0.5.6. Neither of its two attach points
exists on that build, and one of them never worked anywhere.

### 1. The Steam loader slot is gone

Until 0.5.5 the game's own `main.js` scanned the Steam Workshop for a
`modinfo.json` declaring `modID: "fluxloader"` and required the bundle beside
it. That slot is SandLoader's whole reason for being Steam-only and for needing
no changes on disk. On 0.5.6 it is absent. Read out of the shipped
`resources/app.asar/main.js` (75 062 chars, `package.json` version `0.5.6`):

| marker | present in 0.5.6 `main.js` |
|---|---|
| `fluxloader` | no |
| `modID` | no |
| `startManager` | no |
| `startGame` | no |
| `getAPI` | no |
| `setGameWindow` | no |

The five self-test failures that predate this spec are not stale expectations.
They are that measurement, reported correctly, and they have been red since the
game updated.

The game gained its own modding pipeline in the same release — workshop
discovery, patch sets, a local mods folder, a protocol interceptor — and shipped
it switched off:

```js
const MODDING_ENABLED = false;
...
if (MODDING_ENABLED && PLATFORM_NAME === 'steam') {
  workshopDiscoveryResult = discoverNativeWorkshopMods();
  setupProtocolInterceptor();
}
```

So there is nothing to occupy and nothing to ask. SandLoader has to bring its
own way in.

### 2. The non-Steam fallback rests on a false premise

`src/asar/platform.js` documents, and `strategyFor()` relies on, this claim:

> Electron resolves its application package by searching, under
> `process.resourcesPath`, the names `['app', 'app.asar', 'default_app.asar']`
> in that order. `app` comes first.

The order is the other way round. Electron's own fuses documentation, in the
section on `onlyLoadAppFromAsar`, gives the default search sequence as
`app.asar`, then `app`, then `default_app.asar`. Measured on this install to be
sure: with a probe placed in `resources/app` that calls `app.quit()` before
doing anything else, launching the game still started the game — `main.log` grew
by 2 092 bytes and four Sandustry processes appeared. The probe never ran.

`resources-app-bootstrap` is therefore inert on every build that ships an
`app.asar`, which is every build. The GOG and standalone support it documents
has never worked.

### 3. The installer never checked

`strategyFor()` returns `WORKSHOP_SLOT` for `kind === 'steam'` unconditionally,
without asking whether the slot exists. That is why `install.js --status`
reports a healthy `INSTALLED` against 0.5.6 while nothing loads.

## What makes a fix possible

The binary's Electron fuses, read from `Sandustry.exe` (wire version 1):

| fuse | state |
|---|---|
| `runAsNode` | enabled |
| `enableCookieEncryption` | disabled |
| `enableNodeOptionsEnvironmentVariable` | enabled |
| `enableNodeCliInspectArguments` | enabled |
| `enableEmbeddedAsarIntegrityValidation` | **disabled** |
| `onlyLoadAppFromAsar` | **disabled** |
| `loadBrowserProcessSpecificV8Snapshot` | disabled |
| `grantFileProtocolExtraPrivileges` | enabled |

`onlyLoadAppFromAsar` being off means the first name in the search order,
`app.asar`, does not have to be an archive. A directory of that name is loaded
like any other application package. `enableEmbeddedAsarIntegrityValidation`
being off means nothing checks the archive we move aside.

Measured end to end on this install before writing this spec: the original
archive renamed to `app.smln-original.asar`, its `app.asar.unpacked` sibling
renamed alongside it, and a directory `app.asar/` containing `package.json` and
a probe put in their place. Launching through Steam produced

```json
{
  "stage": "shadow directory loaded",
  "ranFrom": "...\\resources\\app.asar",
  "appPath": "...\\resources\\app.asar",
  "isPackaged": true,
  "electron": "33.2.1",
  "chaining": "original main.js required OK"
}
```

with the game running (four processes) and `[startup] platform=steam
appVersion=0.5.6` in its log — so the native `steamworks.js` modules resolved
out of the renamed `.unpacked` directory. `app.getAppPath()` reports the same
path it reported before the change, which is what keeps the game's own path
handling intact.

## Design

### The strategy

A new strategy replaces `resources-app-bootstrap`: `STRATEGIES.SHADOW_ASAR`,
with the id string `asar-shadow-directory`, following the naming already used
for `WORKSHOP_SLOT` / `steam-workshop-slot`.

**Install**, refusing to start unless every precondition holds:

1. `resources` is writable; the game is not running; `<base>.asar` is a file and
   reads as a real archive; no shadow directory is already there; no orphaned
   `<base>.smln-original.asar` is lying around.
2. Rename `<base>.asar` to `<base>.smln-original.asar`.
3. Rename `<base>.asar.unpacked` to `<base>.smln-original.asar.unpacked`, if it
   exists. Electron maps `X.asar/…` to `X.asar.unpacked/…`, so this rename is
   not optional housekeeping — skipping it costs the game its native modules.
4. Create the directory `<base>.asar/` holding `package.json`,
   `smln-bootstrap.js` and the `.smln-bootstrap.json` receipt.

Every step rolls back the steps before it on failure. A half-applied attach is
the one outcome that leaves the player without a game.

**Uninstall:** verify the receipt, delete the directory, rename both paths back.

`<base>` is the archive name `src/asar/locate.js` already selected for this
install — `app` or `game` — not a hard-coded string, so the `game.asar` builds
that `locate.js` learned about in PR #6 are covered by the same code. The
renamed original keeps the `.asar` suffix (`app.smln-original.asar`) because
Electron's unpacked lookup derives `X.asar.unpacked` from `X.asar`; a name that
broke that pattern would strand the native modules.

### The bootstrap finds the original from the receipt

`originalAppRoot()` currently guesses between `game.asar` and `app.asar` by
probing the filesystem. Under a shadow attach the archive it wants no longer
carries either name, and guessing a third is worse. The receipt sits beside the
bootstrap inside the shadow directory, reachable from `__dirname` without
searching, and records the original's absolute path; the bootstrap reads it and
uses it. That is exact, and it is testable in plain Node, which the guess is not.

The existing rule does not change: if anything at all fails, the untouched game
is required anyway and the player gets an unmodified game.

### Strategy selection asks the host

`strategyFor()` stops assuming and starts probing:

- the host's `main.js` still exposes the loader ABI → `WORKSHOP_SLOT`, which
  remains preferred because it genuinely changes nothing on disk
- otherwise → `SHADOW_ASAR`
- MS Store and Game Pass → unsupported, unchanged and for the same reasons
- resources not writable → unsupported, unchanged

The ABI probe reads the archive, which `locate.js` already opens, so the check
rides along with work that is being done anyway.

`resources-app-bootstrap` is deleted rather than repaired. It cannot work while
an `app.asar` exists, and leaving it in the code would keep a strategy that
silently does nothing and a paragraph of documentation that is false.

### Damage control

Steam replaces `app.asar` on update and restores it on *Verify integrity of game
files*. Both break the attach, and they break it in two distinguishable ways:

| on disk | meaning | response |
|---|---|---|
| shadow present, original missing | update or verify removed the archive we chained to | refuse to start modded, say so plainly |
| shadow missing, `*.smln-original.asar` present | Steam restored `app.asar`; our original is now an orphan | offer to clean up |

Both are reported by `install.js --status` and detected by the bootstrap. A new
`node install.js --repair` restores a consistent state. Neither path acts on the
game silently.

### The documentation stops claiming things that are not true

- `src/asar/platform.js` module header: correct the search order, and say it was
  measured, not assumed.
- README: the headline promise becomes "no original file's *content* is
  modified; two paths are renamed, and renaming them back is the uninstall".
  The Steam entry stops promising a Workshop slot on builds that do not have one.
- README limitations: record that 0.5.6 removed the loader slot and ships its own
  modding pipeline behind `MODDING_ENABLED = false`.

## Verification

The gap that let this break go unnoticed is that nothing in the project ever
started the game. The self-test runs in plain Node and cannot.

**`tools/e2e-attach.js`**, opt-in because it launches the game: install the
shadow attach, launch through Steam, wait for the loader to announce itself,
report, uninstall, then assert that `resources` is back to its recorded state —
names, the archive's byte length, and the count of files under `.unpacked`.

**Self-test additions**, in plain Node against a fabricated resources directory:

- rename ordering, and rollback after an induced failure at each step
- the receipt guard refusing to delete a directory SandLoader did not create
- orphan and half-applied detection, both directions of the table above
- `<base>` derivation for `app.asar` and for `game.asar`
- the bootstrap resolving the original from the receipt rather than by guessing

The five failing host-ABI checks stay failing against 0.5.6 and become the
signal that drives strategy selection, rather than noise to be silenced.

## Risks

- **Steam updates mid-session.** Detected, not prevented. Repair is manual and
  explicit.
- **Renaming under a running game.** Refused outright; the check is a
  precondition, not a warning.
- **GOG and standalone inherit this path** and cannot be measured here. They
  gain a mechanism that is proven on Steam and was provably broken before, but
  proven on Steam is not proven there.
- **Elevation.** `resources` under Program Files needs an elevated installer,
  as it already did.

## Non-goals

Repacking `app.asar`, whether to restore the loader slot or to flip
`MODDING_ENABLED`, is out of scope: it modifies file content, needs an asar
writer the project does not have, and does not survive a game update. Attaching
through `--inspect-brk` and a supervising process is out of scope: it changes no
file, but it needs the player to set Steam launch options and a helper process
racing the game's startup.

Building on the game's own native modding pipeline is not addressed here. It is
disabled in this build, so it cannot be evaluated; if a later build enables it,
it deserves its own spec.
