# Map editor

**Date:** 2026-09-08
**Status:** drafted, two facts pending investigation
**Game:** Sandustry 0.5.6 (Steam, Electron 33.2.1)
**Goal:** Edit an existing custom map, and build one from nothing at a size the
author chooses, without leaving the game.

Sub-project 3 of three. The loader (sub-project 1) is done and proven in-game;
the generator (sub-project 2) is not started and this does not wait on it.

## Problem

SandLoader can now install, list, preview, import and start a custom map. It
cannot make one. Every map in the browser had to arrive from somewhere else,
which means the whole feature is only useful to people who already have a map.

An editor closes that loop. It also fixes something the loader cannot: a map
that assembles cleanly and then plays badly.

### The trap this must not repeat

A test map was generated with `102,102,102` for stone and `34,34,34` for
bedrock. Both are documented palette entries. The world came out hollow - a
backdrop and a floor, nothing to dig. `102,102,102` is `{bg: Stone, fg: Fog}`,
a background wall plus a gas; `34,34,34` resolves to `Empty` without a mod
registering that terrain.

Nothing warned about this. The preview drew the PNG, not what the PNG means,
and the PNG was perfectly correct. **An editor that offers raw colours would
ship that trap to every author.** So the palette here is not a colour picker:
each entry is labelled by what the player gets - solid, background, fluid,
empty - and the colours that resolve to nothing are not offered at all.

## Design

### Where it lives

A full-screen overlay in the renderer, `src/renderer/mapeditor.js`, registered
in `prelude.js` beside `mapsui.js`. It is reached from the maps overlay, which
is already the place maps are listed: **New map...** in the footer, and **Edit**
beside Play on the selected map. Nothing new appears in the game's main menu.

Full-screen rather than the maps overlay's dialog, because an editor is a
workspace: the canvas needs the room, and a dialog that big is a full screen
wearing a border.

### The document

Six layers, each an offscreen canvas at map resolution - the same six the game
reads, held in the shape it reads them. Loading decodes each `dataUrl` into its
canvas; saving reads each back out with `toDataURL('image/png')`.

Working in canvases rather than in a private model means the round trip is
lossless by construction and there is no second representation to keep in sync.

### Saving

Through SandLoader's main process, not the game's `custom-map-save` IPC:
`src/mods/custom-maps.js` already writes the exact two-line file that has been
proven to load, and reusing it means the editor cannot invent a third
serialisation that drifts from the two we have. `assemble`'s serialisation is
extracted so the editor and the mod installer share one writer.

Whether the game's own IPC could have done the job is being checked, and the
answer is recorded either way - but it does not change this decision, because
identity with a proven writer is worth more than one fewer code path.

### Creating from nothing

A size dialog: width and height in blueprint pixels, a name, an optional seed.
Sizes are the author's choice, bounded by whatever the game actually enforces.

The new document starts as air, with one exception: the spawn point is marked.

### The spawn marker

Spawn is fixed and unconditional - the game does not look for open space. A map
whose spawn sits inside rock starts the player inside rock.

So the editor draws a marker at the computed spawn position, over every layer,
at all zoom levels, and refuses to save a map whose spawn is inside solid
terrain - with the reason, and an offer to clear the spot. This is the one
validation worth blocking on, because it is invisible until someone plays.

### Tools

Brush, eraser, flood fill, rectangle, and eyedropper. Brush size is a small set
rather than a slider. That is the whole set: a pixel editor with a labelled
palette, not an art program.

Zoom is fit / 1:1 / step, pan is drag. Nearest-neighbour at every zoom, because
one pixel is one piece of world and smoothing it is a lie.

### Undo

Per stroke, storing the affected rectangle's previous pixels rather than a
whole-canvas snapshot: a 1920x1080 layer is 8 MB as ImageData, so thirty
snapshots would be a quarter of a gigabyte for a feature nobody sees. The stack
is bounded by total bytes, not by step count.

### Layers

Terrain is selected by default and is what most authors will only ever touch.
The other five are switchable, each with a visibility toggle, and each labelled
with what it does rather than with its key name.

## Verification

Plain Node, for everything that does not need a DOM: the palette table's
classifications, the shared serialisation, the undo stack's byte bound, and
flood fill on a small grid.

Through `tools/dom-harness.js` for the overlay: a new document is created at a
requested size, painted, saved, reloaded, and compares equal.

In the running game, which is the check that has caught every real defect so
far: create a map, paint ground under the spawn, save, and play it. The map
loader's own verification took exactly this route and found two format defects
that no unit test could have.

## Risks

- **A wrong SOLID classification produces unplayable maps for everyone.** This
  is the reason the palette is being derived from the bundle's collision code
  rather than from colour names, and why an undetermined colour is omitted
  rather than guessed.
- **Large maps.** A canvas per layer at the author's chosen size, six of them,
  plus an undo stack. The byte bound covers undo; the layer canvases are the
  floor and cannot be avoided while the format is what it is.
- **The editor writes into the player's own map folder.** It reuses the loader's
  rule: SandLoader only ever deletes files it can prove it wrote, and an edited
  map is saved under its own id.

## Non-goals

Procedural generation - sub-project 2. Editing a map while it is being played.
Nothing here reads or copies `mods/uolkx.map-studio`, a third-party mod with no
licence; every fact about the game is taken from the shipped bundle.

## Pending facts

Two investigations are running against the bundle, and this spec is not final
until both land:

1. What the five non-terrain layers mean pixel by pixel, and whether five blank
   ones give a playable world. "Create from nothing" depends on the answer.
2. The definitive colour table, classified by what the player gets, derived
   from the code that decides collision rather than from names.
