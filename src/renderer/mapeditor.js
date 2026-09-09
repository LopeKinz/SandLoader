/* eslint-env browser */
'use strict'
/**
 * The in-game map editor: paint a `.custommap`, or make one from nothing.
 *
 * Reached from the maps overlay (src/renderer/mapsui.js) - "New map..." in its
 * footer and "Edit" beside Play - and built the same way that file is: plain
 * DOM, no framework, an id-scoped CSS string, and every piece of text going in
 * through `textContent`, because map names come from players and mod authors.
 *
 * Three decisions are worth knowing before reading the code.
 *
 *   - **The document is six canvases, at map resolution.** That is the shape
 *     the game reads a map in, so loading is "decode each dataUrl into its
 *     canvas" and saving is "read each back out with toDataURL". There is no
 *     second representation that could drift, and the round trip is lossless
 *     by construction rather than by care.
 *   - **Saving goes through SandLoader's main process**, not the game's own
 *     custom-map IPC, so an authored map and a mod's map are written by the
 *     one serialiser in src/mods/custom-maps.js. See `saveDocument` there.
 *   - **Nearest-neighbour at every zoom.** One blueprint pixel is one piece of
 *     world; smoothing it would show a blur of two cells that does not exist.
 *
 * ## This file is a user interface, and nothing else
 *
 * Everything that decides what a map *means* lives in four modules that know
 * nothing about the DOM, and this file is the surface that puts them in front
 * of a person:
 *
 *   src/game/terrain-palette.js       what each colour gives the player
 *   src/renderer/mapeditor-tools.js   brush, line, rectangle, fill, pick, eraser
 *   src/renderer/mapeditor-validate.js what a map will do before anyone plays it
 *   src/renderer/mapeditor-transform.js resize, crop, mirror, shift
 *
 * They arrive as globals, injected by src/renderer/prelude.js with a CommonJS
 * shim, so plain Node and the running game read the identical source. Anything
 * this file believes about a colour, a spawn point or a size limit it has been
 * told by one of them - it invents nothing, because a second opinion about what
 * 102,102,102 does is exactly how the hollow test map happened.
 *
 * Four consequences of theirs are load-bearing here and are not this file's to
 * reconsider:
 *
 *   - **Alpha 0 is not air.** A transparent terrain pixel resolves to Fog:
 *     collidable, floods when broken, leaves nothing behind. Every colour
 *     written into terrain is opaque, the eraser writes the palette's real
 *     empty entry rather than clearing, and a blank document starts as that
 *     colour rather than as transparency.
 *   - **The fog rows are classified `empty`** and say "blocks until dug" in
 *     their labels. The picker shows them where the table puts them, with the
 *     labels the table gives them, at full length.
 *   - **The map has a floor size**, because the spawn point does not scale
 *     down with it. Below that the validator reports `spawn-outside`, and this
 *     file will not create a document that small.
 *   - **The six layers must stay the same size as each other**, so every
 *     transform runs on all six with the same arguments, as one undo step.
 *
 * ## A terrain colour is a storage key, not an appearance
 *
 * The corollary of all four, and the reason `render()` is not a plain redraw
 * of the layer canvases: 153,0,0 is how the format spells "open air", so a
 * blank document is a layer full of dark red bytes and drawing those bytes
 * puts a wall on screen where the map has nothing. The view derives what it
 * draws - air becomes an absence, and the stage's checkerboard shows through -
 * while the layer keeps the bytes the game has to read back. Nothing about
 * what is saved changes, and no material's real appearance is invented here,
 * because this file does not know any of them; the palette side says so in
 * one line rather than pretending the swatches are pictures.
 */
;(function installSmlnMapEditor(global) {
  var SMLN = global.__SMLN__
  if (!SMLN || SMLN.mapEditor) return

  /*
   * The four modules, read once at install. Each is optional in the sense that
   * a missing one must not stop the editor installing - the prelude wraps every
   * module in its own try/catch, so one that failed to parse leaves a hole
   * rather than taking the whole prepended script down - but every feature
   * built on one checks for it and says so plainly rather than guessing.
   */
  var palette = global.__SMLN_TERRAIN_PALETTE__ || null
  var draw = global.__SMLN_MAPEDITOR_TOOLS__ || null
  var checker = global.__SMLN_MAPEDITOR_VALIDATE__ || null
  var xform = global.__SMLN_MAPEDITOR_TRANSFORM__ || null

  /** The six fields the game reads, in the order it reads them. */
  var LAYERS = ['terrain', 'lights', 'lightsMeta', 'sensors', 'authorization', 'wall']

  /**
   * Each layer named by what it does to the world rather than by its key.
   * "lightsMeta" tells an author nothing; "Light tuning" tells them whether
   * this is the layer they want. Taken from the format investigation, not
   * from the names themselves.
   */
  var LAYER_LABEL = {
    terrain: 'Terrain',
    lights: 'Lights',
    lightsMeta: 'Light tuning',
    sensors: 'Artifact markers',
    authorization: 'Zones',
    wall: 'Backdrop',
  }

  /**
   * A heading for each of the palette's own buckets, in the palette's own
   * order.
   *
   * These describe the bucket, they do not re-classify it. The `empty` group
   * holds the fog colours on purpose - their durable state is open air - and
   * every one of them says "blocks until dug" in the label the table gives it,
   * so the heading has to be true of both an air colour and a fog colour. It
   * says what the cell ends up as, which is the thing they share.
   */
  var KIND_HEADING = {
    solid: 'Solid - stays where you paint it',
    empty: 'Ends up as open air',
    fluid: 'Ends up as liquid or gas',
    broken: 'Broken - the game refuses these',
  }

  /**
   * The tools, in the order the toolbar shows them.
   *
   * `key` is the single keystroke that selects the tool; `drag` says how the
   * mouse drives it - 'stroke' paints continuously between the last point and
   * this one, 'band' rubber-bands between where the button went down and where
   * it comes up, 'spot' acts once on mousedown.
   */
  var TOOLS = [
    { id: 'brush', label: 'Brush', key: 'b', drag: 'stroke' },
    { id: 'eraser', label: 'Eraser', key: 'e', drag: 'stroke' },
    { id: 'fill', label: 'Fill', key: 'g', drag: 'spot' },
    { id: 'line', label: 'Line', key: 'l', drag: 'band' },
    { id: 'rect', label: 'Box', key: 'r', drag: 'band' },
    { id: 'rectline', label: 'Box outline', key: 'o', drag: 'band' },
    { id: 'pick', label: 'Eyedropper', key: 'i', drag: 'spot' },
    { id: 'select', label: 'Select', key: 'm', drag: 'band' },
  ]

  /** Brush diameters, in cells. A small set, not a slider. */
  var BRUSHES = [1, 2, 4, 8]

  /** The nine positions mapeditor-transform.js anchors a resize at. */
  var ANCHORS = [
    'top-left', 'top', 'top-right',
    'left', 'center', 'right',
    'bottom-left', 'bottom', 'bottom-right',
  ]

  /**
   * Bounds on a new document's size, in cells - one cell is one pixel, with
   * no scaling anywhere on this path.
   *
   * Nothing on the `.custommap` load path enforces a size, but the game does
   * carry the shared mouse position as a Uint16, which puts a real ceiling at
   * 16383 cells per axis. That is the bound, rather than a number invented
   * here. The practical ceiling arrives much sooner: six canvases exist at map
   * resolution at once, so a map that large is a memory problem long before it
   * is a Uint16 problem.
   */
  var MAX_SIZE = 16383
  var DEFAULT_SIZE = { width: 640, height: 400 }

  /**
   * The smallest map that can be played at all, derived rather than declared.
   *
   * The game drops the player at a fixed spot that does not scale down with the
   * map, so below a certain size the spawn is outside the world - which the
   * shove-upward rescue cannot fix, and which mapeditor-validate.js reports as
   * the error `spawn-outside`. Rather than write that size down a second time
   * and let the two drift, walk the validator's own `spawnCell` until the spawn
   * lands inside: whatever the formula is, this is the first width that
   * satisfies it, and the spawn row plus one is the first height.
   *
   * The literals are the answer that walk gives today, kept only as the value
   * to fall back on if the validator did not install.
   */
  var MIN_WIDTH = 158
  var MIN_HEIGHT = 201
  ;(function deriveMinimumSize() {
    if (!checker || typeof checker.spawnCell !== 'function') return
    var w = 1
    while (w < MAX_SIZE && checker.spawnCell(w).x >= w) w++
    var h = checker.spawnCell(w).y + 1
    if (w > 0 && h > 0 && w <= MAX_SIZE && h <= MAX_SIZE) {
      MIN_WIDTH = w
      MIN_HEIGHT = h
    }
  })()

  // --- undo:begin (tools/selftest.js evaluates this region verbatim, so it
  // --- must stay self-contained: no references out of it.)
  /**
   * How much undo history is worth keeping, in bytes of pixels.
   *
   * Bounded by total bytes rather than by step count on purpose. A 1920x1080
   * layer is about 8 MB as ImageData, so "keep thirty steps" would be a
   * quarter of a gigabyte on a large map and nothing at all on a small one -
   * the wrong quantity in both directions. Bytes is the thing that actually
   * runs out.
   */
  var UNDO_BUDGET = 48 * 1024 * 1024

  /**
   * Strokes capture the pixels they are about to overwrite in aligned tiles.
   * A tile is the granularity of "already saved this stroke", so a long drag
   * over the same area costs each tile once rather than once per dab.
   */
  var UNDO_TILE = 32

  /**
   * The undo history: a stack of steps, each a list of {x, y, image} tiles
   * holding what was there before the stroke.
   *
   * Eviction is oldest-first, and one step always survives: a stroke big
   * enough to blow the whole budget by itself is still worth being able to
   * take back once.
   */
  function UndoStack(budget) {
    this.budget = budget
    this.bytes = 0
    this.steps = []
  }
  UndoStack.prototype.push = function (step) {
    var bytes = 0
    for (var i = 0; i < step.tiles.length; i++) bytes += step.tiles[i].image.data.length
    if (!bytes) return
    step.bytes = bytes
    this.steps.push(step)
    this.bytes += bytes
    while (this.steps.length > 1 && this.bytes > this.budget) {
      this.bytes -= this.steps.shift().bytes
    }
  }
  UndoStack.prototype.pop = function () {
    var step = this.steps.pop()
    if (step) this.bytes -= step.bytes
    return step || null
  }
  UndoStack.prototype.depth = function () { return this.steps.length }
  UndoStack.prototype.clear = function () { this.steps = []; this.bytes = 0 }
  // --- undo:end

  var overlay = null
  var isOpen = false

  /**
   * The open document, or null.
   * {id, name, seed, createdAt, width, height, layers:{name->canvas}, dirty}
   */
  var doc = null
  var active = 'terrain'
  var visible = Object.create(null)

  /**
   * Two stacks of the same shape. Undoing a step captures the pixels it is
   * about to replace and pushes that onto the other one, so redo is the same
   * machinery run the other way rather than a second history.
   */
  var undo = new UndoStack(UNDO_BUDGET)
  var redo = new UndoStack(UNDO_BUDGET)

  /** Where the map sits in the view canvas, and how big one cell is drawn. */
  var view = { zoom: 1, x: 0, y: 0 }
  var tool = 'brush'
  var brush = 1
  var panMode = false

  /** Whether the document-operations menu is showing. */
  var shapeOpen = false

  /** The palette entry the brush paints, and the one the eraser writes. */
  var ink = null

  /** The marquee, in cells, or null. Crop is the only thing that reads it. */
  var selection = null

  /** In-flight interaction: a stroke, a rubber band, or a drag panning. */
  var stroke = null
  var band = null
  var panning = null
  var escapeArmed = false

  /** The last validation run, so the panel can be reopened without re-running. */
  var report = null

  /** Called after a successful save, so the maps list can refresh itself. */
  var onSaved = null

  function t(key, params) {
    if (SMLN.i18n && typeof SMLN.i18n.t === 'function') {
      var out = SMLN.i18n.t(key, params)
      if (out !== key) return out
    }
    return null
  }
  /** Translated, or the English literal the file used to hard-code. */
  function tx(key, fallback, params) {
    var out = t(key, params)
    return out == null ? fallback : out
  }

  // -------------------------------------------------------------------- CSS
  /*
   * The design system is mapsui.js's, which is modsui.js's: near-black
   * surfaces, a slate hairline border, the asymmetric top-right/bottom-left
   * radius, #ffe700 as the one accent. The difference is the shape - this is
   * full-screen, not a dialog, because an editor is a workspace and a dialog
   * that big is a full screen wearing a border.
   *
   * Three rules this file adds on top of that, because a workspace has a
   * problem a dialog does not: it holds forty controls at once, and they are
   * not equally important.
   *
   *   - **Volume follows use.** A hand is on the drawing tools and the brush
   *     size all day; zoom, history and the document operations are touched
   *     between strokes at most. The first two get full-size plates, the rest
   *     get small quiet ones, and the five operations that reshape the whole
   *     document sit behind one control instead of five.
   *   - **A cluster is one plate, not a row of pills.** Eight tools cut into a
   *     single bordered plate read as one instrument; eight separate bordered
   *     buttons read as eight things competing. The diagonal corner belongs to
   *     the plate, so the signature is stated once per cluster.
   *   - **Yellow stays scarce.** It is the masthead, the action that commits,
   *     and the spawn cell - the one thing in the world an author cannot see
   *     and must not bury. Selection is carried by an inverted plate or a
   *     raised row instead, which is also what makes it survive grayscale.
   */
  var CSS = [
    '#smln-mapedit{position:fixed;inset:0;z-index:2147483500;display:none;',
    'flex-direction:column;background:#04070b;',
    "font-family:'SMLN Play',system-ui,sans-serif;font-size:14px;line-height:1.55;color:#e2e8f0}",
    '#smln-mapedit.open{display:flex}',

    // --- the plain button, which everything below either uses or overrides.
    '#smln-mapedit button{cursor:pointer;border:1px solid rgba(100,116,139,.68);background:transparent;',
    'color:#e2e8f0;font:inherit;font-size:12px;padding:6px 13px;border-radius:0 4px 0 4px}',
    '#smln-mapedit button:hover{background:rgba(148,163,184,.12)}',
    '#smln-mapedit button[disabled]{opacity:.45;cursor:default;background:transparent}',
    // Selected is an inverted plate: the strongest statement available without
    // spending the accent, and legible with the colour taken out.
    '#smln-mapedit button.on{background:#e2e8f0;border-color:#e2e8f0;color:#080c11;font-weight:700}',
    '#smln-mapedit button.on:hover{background:#f1f5f9}',

    // --- masthead
    '#smln-mapedit header{display:flex;align-items:center;gap:16px;flex:none;',
    'padding:13px 20px;border-bottom:1px solid rgba(100,116,139,.34);background:#070b10}',
    '#smln-mapedit h2{margin:0;font-size:16px;font-weight:700;letter-spacing:.16em;',
    'text-transform:uppercase;color:#ffe700;line-height:1;flex:none}',
    // A field the size of a name.
    //
    // Stretched across the masthead it was over twelve hundred pixels wide and
    // its resting rule read as a line ruled across the header rather than as
    // the underside of a box - so it is bounded on all four sides now, and
    // sized to what goes in it. A longer name scrolls inside the field, which
    // is what a field does; nothing is truncated and nothing is lost.
    '#smln-mapedit .name{flex:0 1 340px;min-width:120px;background:transparent;color:#f1f5f9;',
    'font:inherit;font-size:15px;border:1px solid rgba(100,116,139,.28);',
    'border-radius:0 4px 0 4px;padding:5px 8px}',
    '#smln-mapedit .name:hover{border-color:rgba(100,116,139,.55)}',
    '#smln-mapedit .name:focus{outline:none;border-color:rgba(255,231,0,.45)}',
    // The size and the way out ride the right-hand edge, so the masthead reads
    // title, name - space - size, Close.
    "#smln-mapedit .dims{flex:none;margin-left:auto;color:#94a3b8;font-size:11.5px;",
    "letter-spacing:.06em;font-family:'Cascadia Mono',Consolas,monospace}",

    // --- toolbar: one row. The caption sits above its cluster rather than
    // beside it, which costs a few pixels of height and gives back the width
    // that made three rows necessary.
    // Stretch, not flex-end: every cluster is then the full height of the row,
    // so the captions sit on one line, the plates sit on another, and the rule
    // that separates the stroke from the document runs the whole way down.
    '#smln-mapedit .tools{display:flex;align-items:stretch;gap:14px;flex:none;flex-wrap:wrap;',
    'row-gap:10px;padding:9px 20px 10px;border-bottom:1px solid rgba(100,116,139,.34);',
    'background:#070b10}',
    '#smln-mapedit .cluster{display:flex;flex-direction:column;justify-content:flex-end;gap:5px}',
    '#smln-mapedit .cap{color:#64748b;font-size:9.5px;letter-spacing:.13em;',
    'text-transform:uppercase;line-height:1;padding-left:2px}',
    '#smln-mapedit .push{margin-left:auto}',
    // Everything left of this line changes the stroke; everything right of it
    // changes the document.
    '#smln-mapedit .apart{margin-left:6px;padding-left:16px;',
    'border-left:1px solid rgba(100,116,139,.28)}',

    '#smln-mapedit .seg{display:flex;align-items:stretch;overflow:hidden;',
    'border:1px solid rgba(100,116,139,.5);border-radius:0 6px 0 6px;background:rgba(2,6,10,.6)}',
    '#smln-mapedit .seg>*+*{border-left:1px solid rgba(100,116,139,.28)}',
    '#smln-mapedit .seg button{border:0;border-radius:0;background:transparent;color:#cbd5e1;',
    'font:inherit;font-size:11.5px;padding:5px 10px;line-height:1.5}',
    '#smln-mapedit .seg button:hover{background:rgba(148,163,184,.12);color:#f1f5f9}',
    '#smln-mapedit .seg button.on{background:#e2e8f0;color:#080c11;font-weight:700}',
    '#smln-mapedit .seg button.on:hover{background:#f1f5f9;color:#080c11}',
    // Disabled is a sunken cell, not a faded one: opacity alone drops the
    // label under the contrast a person can still read it at.
    '#smln-mapedit .seg button[disabled]{opacity:1;cursor:default;color:#5b6b80;',
    'background:rgba(100,116,139,.07)}',
    // The two clusters a hand is on all day.
    '#smln-mapedit .loud button{font-size:12.5px;padding:7px 13px;color:#e2e8f0}',
    '#smln-mapedit .loud button:hover{color:#f8fafc}',
    '#smln-mapedit .sizes button{min-width:34px;text-align:center;',
    "font-family:'Cascadia Mono',Consolas,monospace}",
    '#smln-mapedit .zoomval{display:flex;align-items:center;justify-content:center;',
    'color:#94a3b8;font-size:11px;min-width:54px;',
    "font-family:'Cascadia Mono',Consolas,monospace}",

    // --- the document operations, behind one control.
    //
    // Resize, crop, mirror and shift are used once or twice in a map's life
    // and each one moves every pixel of all six layers. Sitting them beside
    // Brush at the same size said they were the same kind of thing.
    '#smln-mapedit .shapeBox{position:relative;display:flex;flex-direction:column;',
    'justify-content:flex-end}',
    '#smln-mapedit .shapeBtn{display:flex;align-items:center;gap:9px}',
    // A disclosure triangle made of a border - no icon font, no asset, and it
    // stays out of the label the button carries.
    "#smln-mapedit .shapeBtn::after{content:'';width:0;height:0;flex:none;",
    'border:4px solid transparent;border-top-color:currentColor;margin-top:3px}',
    '#smln-mapedit .shapeMenu{position:absolute;top:calc(100% + 7px);right:0;z-index:6;',
    'display:none;flex-direction:column;min-width:196px;padding:5px;background:#0b1017;',
    'border:1px solid rgba(100,116,139,.6);border-radius:0 8px 0 8px;',
    'box-shadow:0 6px 20px rgba(0,0,0,.5)}',
    '#smln-mapedit .shapeMenu.open{display:flex}',
    '#smln-mapedit .shapeMenu button{border:0;border-radius:0;text-align:left;padding:7px 11px;',
    'font-size:12px;color:#e2e8f0;background:transparent}',
    '#smln-mapedit .shapeMenu button:hover{background:rgba(148,163,184,.12)}',
    '#smln-mapedit .shapeMenu button[disabled]{opacity:1;color:#5b6b80;background:transparent}',

    // --- the working area: rail, stage, problems
    '#smln-mapedit .work{flex:1;min-height:0;display:flex;align-items:stretch}',

    // --- rail: what is being painted with, then what there is to paint with,
    // then which layer it lands on.
    '#smln-mapedit .rail{flex:none;width:316px;display:flex;flex-direction:column;min-height:0;',
    'border-right:1px solid rgba(100,116,139,.34);background:#070b10}',

    // One line, and it stays one line: the label ellipsises rather than
    // wrapping to three rows of a rail that has a palette to fit.
    '#smln-mapedit .current{flex:none;display:flex;align-items:center;gap:11px;padding:9px 14px;',
    'border-bottom:1px solid rgba(100,116,139,.28)}',
    '#smln-mapedit .current .chip{flex:none;box-sizing:border-box;width:24px;height:24px;',
    'border:1px solid rgba(226,232,240,.5);border-radius:0 4px 0 4px}',
    '#smln-mapedit .current .who{flex:1;min-width:0;display:flex;align-items:baseline;gap:10px}',
    '#smln-mapedit .current .who b{flex:1;min-width:0;font-size:12.5px;font-weight:700;',
    'color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#smln-mapedit .current .who span{flex:none;color:#64748b;font-size:10.5px;white-space:nowrap;',
    "font-family:'Cascadia Mono',Consolas,monospace;letter-spacing:.04em}",

    // Said once, and it scrolls away like anything else said once. It is the
    // first thing in the palette's own scroller rather than a block above it,
    // so it is read on the way in and then stops spending rail height that the
    // colours need - and the first group heading, being sticky, covers it as
    // soon as there is something better to look at.
    '#smln-mapedit .paletteKey{margin:0 -8px;padding:6px 14px;color:#94a3b8;font-size:10.5px;',
    'line-height:1.35;border-bottom:1px solid rgba(100,116,139,.2)}',
    '#smln-mapedit .swatches{flex:1;min-height:0;overflow-y:auto;padding:0 8px 14px}',
    '#smln-mapedit .swatches::-webkit-scrollbar{width:10px}',
    '#smln-mapedit .swatches::-webkit-scrollbar-track{background:transparent}',
    '#smln-mapedit .swatches::-webkit-scrollbar-thumb{background:rgba(100,116,139,.35);',
    'border-radius:5px;border:3px solid transparent;background-clip:content-box}',
    // The heading stays put while its own group scrolls past it, so "which
    // bucket is this colour in" is never answered by scrolling back up.
    '#smln-mapedit .kind{position:sticky;top:0;z-index:1;background:#070b10;color:#94a3b8;',
    'font-size:10px;letter-spacing:.1em;text-transform:uppercase;margin:9px -8px 0;',
    // The space between groups is margin rather than padding on purpose: a
    // stuck heading should be a band the height of its own words, not a band
    // with the gap above the group still inside it.
    'padding:5px 14px;border-bottom:1px solid rgba(100,116,139,.24)}',
    // The chip sets the height of a row, so every pixel of padding around it is
    // a pixel of a colour further down that nobody can see. The chip keeps its
    // size; the air around it does not.
    '#smln-mapedit .swatch{display:flex;align-items:center;gap:10px;width:100%;text-align:left;',
    'padding:3px 7px;margin-top:2px;font-size:11.5px;line-height:1.3;color:#cbd5e1;',
    'border:1px solid transparent;border-left:3px solid transparent;border-radius:0}',
    '#smln-mapedit .swatch:hover{background:rgba(148,163,184,.09);color:#f1f5f9}',
    // Big enough to tell two pale yellows apart, which fifteen pixels was not.
    // Border-box, so twenty-six is the whole square rather than the square
    // plus a border the row then has to be tall enough to hold.
    '#smln-mapedit .swatch .chip{flex:none;box-sizing:border-box;width:26px;height:26px;',
    'border:1px solid rgba(226,232,240,.35);border-radius:0 3px 0 3px}',
    '#smln-mapedit .swatch .txt{min-width:0;flex:1}',
    '#smln-mapedit .swatch.on{border-color:transparent;border-left-color:#e2e8f0;',
    'background:rgba(226,232,240,.09);color:#f8fafc;font-weight:700}',
    '#smln-mapedit .swatch.on .chip{box-shadow:0 0 0 2px #070b10,0 0 0 4px #e2e8f0}',
    '#smln-mapedit .paletteNote{padding:12px 14px;color:#f87171;font-size:11.5px}',

    '#smln-mapedit .layerHint{flex:none;padding:9px 14px;color:#94a3b8;font-size:11px;',
    'line-height:1.45;border-top:1px solid rgba(100,116,139,.28);display:none}',
    '#smln-mapedit .layerHint.on{display:block}',

    // --- layers: a mode you set and leave, so they are in the rail rather
    // than in the row a hand is in mid-stroke, and each carries its own
    // visibility beside its name instead of trailing a loose dot.
    '#smln-mapedit .layers{flex:none;border-top:1px solid rgba(100,116,139,.34);',
    'background:rgba(2,6,10,.55)}',
    '#smln-mapedit .layers .cap{display:block;padding:8px 14px 5px}',
    '#smln-mapedit .layerRow{display:flex;align-items:stretch;',
    'border-left:3px solid transparent;border-top:1px solid rgba(100,116,139,.14)}',
    '#smln-mapedit .layerRow:hover{background:rgba(148,163,184,.06)}',
    '#smln-mapedit .layerRow.on{border-left-color:#e2e8f0;background:rgba(226,232,240,.08)}',
    // A name and a toggle need twenty-seven pixels, not thirty-three. Six rows
    // of a list you set once should not hold a third of the rail while the
    // palette - which is touched on every stroke - shows a fifth of itself.
    '#smln-mapedit .layerPick{flex:1;text-align:left;border:0;border-radius:0;background:transparent;',
    'padding:4px 11px;font-size:12px;color:#cbd5e1}',
    '#smln-mapedit .layerPick:hover{background:transparent;color:#f1f5f9}',
    '#smln-mapedit .layerRow.on .layerPick{color:#f8fafc;font-weight:700}',
    '#smln-mapedit .eye{flex:none;width:36px;border:0;border-radius:0;background:transparent;',
    'border-left:1px solid rgba(100,116,139,.2);color:#94a3b8;font-size:12px;padding:0}',
    '#smln-mapedit .eye:hover{background:rgba(148,163,184,.12);color:#f1f5f9}',
    '#smln-mapedit .eye.off{color:#5b6b80}',

    // --- stage
    //
    // Outside the world is flat and dark; inside it is the checkerboard. The
    // pattern is not decoration on the stage any more, it is the map's own
    // ground - so a document with nothing painted on it is still a rectangle
    // an author can see the edges of, and panning it never loses them.
    '#smln-mapedit .stage{flex:1;min-width:0;min-height:0;position:relative;overflow:hidden;',
    'background:#05080c}',
    '#smln-mapedit .plate{position:absolute;box-sizing:border-box;pointer-events:none;',
    'background-color:#0a0d11;background-image:',
    'linear-gradient(45deg,#171d25 25%,transparent 25%),',
    'linear-gradient(-45deg,#171d25 25%,transparent 25%),',
    'linear-gradient(45deg,transparent 75%,#171d25 75%),',
    'linear-gradient(-45deg,transparent 75%,#171d25 75%);',
    'background-size:16px 16px;background-position:0 0,0 8px,8px -8px,-8px 0;',
    'box-shadow:0 0 0 1px #05080c,0 0 0 3px rgba(148,163,184,.55)}',
    // Corner marks, the way a drawing states its own extent: the frame is a
    // hairline that terrain can be painted right up against, so the corners
    // are where the world says out loud where it stops.
    '#smln-mapedit .plate i{position:absolute;width:15px;height:15px;border:0 solid #e2e8f0}',
    '#smln-mapedit .plate i.tl{left:-5px;top:-5px;border-left-width:3px;border-top-width:3px}',
    '#smln-mapedit .plate i.tr{right:-5px;top:-5px;border-right-width:3px;border-top-width:3px}',
    '#smln-mapedit .plate i.bl{left:-5px;bottom:-5px;border-left-width:3px;border-bottom-width:3px}',
    '#smln-mapedit .plate i.br{right:-5px;bottom:-5px;border-right-width:3px;border-bottom-width:3px}',
    '#smln-mapedit .view{position:absolute;inset:0;display:block;cursor:crosshair;',
    // Belt and braces with ctx.imageSmoothingEnabled=false: this one covers
    // the browser scaling the canvas element itself on a HiDPI display.
    'image-rendering:pixelated}',
    '#smln-mapedit .view.pan{cursor:grab}',
    '#smln-mapedit .busy{position:absolute;inset:0;display:flex;align-items:center;',
    'justify-content:center;color:#94a3b8;font-size:13px;text-align:center;padding:0 30px}',

    // --- problems
    '#smln-mapedit .issues{flex:none;width:320px;display:none;flex-direction:column;min-height:0;',
    'border-left:1px solid rgba(100,116,139,.34);background:#070b10}',
    '#smln-mapedit .issues.open{display:flex}',
    '#smln-mapedit .issues .top{flex:none;display:flex;align-items:center;gap:10px;padding:11px 14px;',
    'border-bottom:1px solid rgba(100,116,139,.28)}',
    '#smln-mapedit .issues .top b{flex:1;font-size:11px;font-weight:700;letter-spacing:.14em;',
    'text-transform:uppercase;color:#e2e8f0}',
    '#smln-mapedit .issues .body{flex:1;min-height:0;overflow-y:auto;padding:4px 12px 16px}',
    '#smln-mapedit .issues .body::-webkit-scrollbar{width:10px}',
    '#smln-mapedit .issues .body::-webkit-scrollbar-track{background:transparent}',
    '#smln-mapedit .issues .body::-webkit-scrollbar-thumb{background:rgba(100,116,139,.35);',
    'border-radius:5px;border:3px solid transparent;background-clip:content-box}',
    '#smln-mapedit .sev{margin:12px 2px 6px;font-size:11px;line-height:1.45}',
    '#smln-mapedit .sev.error{color:#f87171}',
    '#smln-mapedit .sev.warning{color:#fbbf24}',
    '#smln-mapedit .sev.clean{color:#4ade80}',
    '#smln-mapedit .problem{display:block;width:100%;text-align:left;font-size:11.5px;',
    'line-height:1.5;padding:8px 10px;margin:6px 0;border-color:rgba(100,116,139,.4)}',
    '#smln-mapedit .problem.error{border-left:4px solid rgba(248,113,113,.8)}',
    '#smln-mapedit .problem.warning{border-left:4px solid rgba(251,191,36,.8)}',
    '#smln-mapedit .problem .where{display:block;margin-top:5px;color:#64748b;font-size:10.5px;',
    'letter-spacing:.06em;text-transform:uppercase}',

    // --- dialogs (resize, shift), the maps overlay's card on this background
    '#smln-mapedit .dialog{position:absolute;inset:0;display:flex;align-items:center;',
    'justify-content:center;background:rgba(4,7,11,.78);z-index:5}',
    '#smln-mapedit .dialog .card{width:min(380px,90%);padding:20px 22px;background:#0b1017;',
    'border:1px solid rgba(100,116,139,.5);border-radius:0 8px 0 8px;',
    'box-shadow:0 8px 24px rgba(0,0,0,.5)}',
    '#smln-mapedit .dialog h3{margin:0 0 14px;font-size:12px;font-weight:700;letter-spacing:.14em;',
    'text-transform:uppercase;color:#ffe700}',
    '#smln-mapedit .dialog label{display:block;color:#94a3b8;font-size:11px;letter-spacing:.09em;',
    'text-transform:uppercase;margin:10px 0 4px}',
    '#smln-mapedit .dialog input{width:100%;box-sizing:border-box;background:rgba(2,6,10,.7);',
    'border:1px solid rgba(100,116,139,.5);color:#f1f5f9;font:inherit;font-size:13px;',
    'padding:7px 9px;border-radius:0 4px 0 4px}',
    '#smln-mapedit .dialog input:focus{outline:none;border-color:rgba(255,231,0,.45)}',
    '#smln-mapedit .dialog .pair{display:flex;gap:12px}',
    '#smln-mapedit .dialog .pair>div{flex:1}',
    '#smln-mapedit .dialog .hint{margin-top:12px;color:#94a3b8;font-size:11px;line-height:1.5}',
    '#smln-mapedit .dialog .hint.refused{color:#f87171}',
    '#smln-mapedit .dialog input.bad{border-color:#f87171}',
    '#smln-mapedit .dialog .row{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}',
    '#smln-mapedit .anchors{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;max-width:150px}',
    '#smln-mapedit .anchors button{padding:8px 0;font-size:11px}',

    // --- footer: what just happened at the left, what is under the cursor
    // beside it, and the one action that commits at the right.
    '#smln-mapedit footer{flex:none;display:flex;align-items:center;gap:16px;',
    'padding:10px 20px;border-top:1px solid rgba(100,116,139,.34);background:#070b10}',
    '#smln-mapedit footer .note{flex:1;min-width:0;color:#94a3b8;font-size:11.5px;overflow:hidden;',
    'text-overflow:ellipsis;white-space:nowrap}',
    '#smln-mapedit footer .note.err{color:#f87171}',
    '#smln-mapedit footer .under{flex:none;color:#94a3b8;font-size:11px;max-width:280px;',
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#smln-mapedit footer .at{flex:none;color:#64748b;font-size:11px;',
    "font-family:'Cascadia Mono',Consolas,monospace;min-width:96px;text-align:right}",
    '#smln-mapedit .save{border-color:rgba(255,231,0,.45);background:rgba(255,231,0,.08);',
    'color:#ffe700;font-size:12.5px;letter-spacing:.06em;text-transform:uppercase;padding:8px 26px;',
    'transition:background .12s ease-out}',
    '#smln-mapedit .save:hover{background:rgba(255,231,0,.16)}',
    '#smln-mapedit .save[disabled]{opacity:.45;background:transparent}',
  ].join('')

  // ------------------------------------------------------------- canvases
  function newCanvas(w, h) {
    var c = document.createElement('canvas')
    c.width = w
    c.height = h
    return c
  }

  /**
   * A layer's context, never smoothed.
   *
   * `willReadFrequently` because every tool reads pixels back out before it
   * writes them, which is exactly the access pattern that flag exists for.
   */
  function ctxOf(canvas) {
    var ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (ctx) ctx.imageSmoothingEnabled = false
    return ctx
  }

  /** A whole layer as ImageData: what every module here takes as a buffer. */
  function bufferOf(layer) {
    return ctxOf(doc.layers[layer]).getImageData(0, 0, doc.width, doc.height)
  }

  /**
   * A plain {data,width,height} from a transform, as a real ImageData.
   *
   * mapeditor-transform.js returns object literals, on purpose - it has no DOM
   * and cannot make an ImageData - and a browser's putImageData refuses
   * anything that is not the genuine article, so the bytes are copied into one
   * the context made itself.
   */
  function asImageData(ctx, buf) {
    var image = ctx.createImageData(buf.width, buf.height)
    image.data.set(buf.data)
    return image
  }

  function decodeLayer(layer) {
    return new Promise(function (resolve, reject) {
      var canvas = newCanvas(layer.width, layer.height)
      var ctx = ctxOf(canvas)
      var img = new global.Image()
      img.onload = function () {
        try {
          ctx.drawImage(img, 0, 0)
          resolve(canvas)
        } catch (e) { reject(e) }
      }
      img.onerror = function () { reject(new Error('a layer image could not be decoded')) }
      img.src = layer.dataUrl
    })
  }

  // --------------------------------------------------------------- colour
  /**
   * A palette entry as the four opaque bytes to write.
   *
   * Alpha is 255 and is not negotiable: a see-through terrain pixel is Fog,
   * not air, and the whole point of routing every colour through the palette
   * is that the editor cannot write one by accident.
   */
  function rgbaOf(entry) {
    var c = entry && entry.rgb
    if (!c || c.length < 3) return null
    return [c[0], c[1], c[2], 255]
  }

  /** The colour the brush paints. Defaults to the palette's own default. */
  function inkEntry() {
    if (!ink && palette) ink = palette.DEFAULT_SOLID || null
    return ink
  }

  /**
   * The colour the eraser writes.
   *
   * Not transparency. mapeditor-tools.js refuses a fully transparent colour
   * outright and writes nothing, because clearing a terrain pixel fills it
   * with Fog - so the eraser is handed the palette's real empty entry, and if
   * the palette is missing there is no honest colour to erase with.
   */
  function eraserEntry() {
    return palette ? (palette.DEFAULT_EMPTY || null) : null
  }

  function colourText(entry) {
    var c = entry && entry.rgb
    return c ? c[0] + ',' + c[1] + ',' + c[2] : ''
  }

  function cssOf(entry) {
    var c = entry && entry.rgb
    return c ? 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')' : 'transparent'
  }

  /**
   * The stored colours that are nothing at all in the loaded world.
   *
   * A terrain colour is a storage key, not an appearance. 153,0,0 is how the
   * format spells "open air", so a document with nothing painted on it is a
   * layer full of dark red bytes - and drawing those bytes puts a wall on the
   * screen where the map has nothing. The view draws these as an absence
   * instead, and the stage's checkerboard shows through; the layer keeps the
   * bytes, because those are what the game reads back.
   *
   * Read off the table, never listed here, and narrowed by `cellType` rather
   * than by `kind` alone. The fog rows share the `empty` bucket because open
   * air is what they *end up* as, but on load they are collidable obstacles -
   * one of them says "looks like black rock" in its own label - so drawing
   * them as an absence would be this file inventing an appearance for them,
   * which is exactly the trap the palette module exists to close. CellType 0
   * is the table's own way of saying a cell is Empty from the first frame.
   */
  var AIR = null
  var ANY_AIR = false
  function airKeys() {
    if (AIR) return AIR
    AIR = Object.create(null)
    var rows = (palette && palette.TERRAIN) || null
    for (var i = 0; rows && i < rows.length; i++) {
      var e = rows[i]
      if (e.kind !== 'empty' || e.cellType !== 0 || !e.rgb) continue
      AIR[(e.rgb[0] << 16) | (e.rgb[1] << 8) | e.rgb[2]] = true
      ANY_AIR = true
    }
    return AIR
  }

  /**
   * The terrain layer as it should be seen: the same pixels, with every air
   * colour turned into an absence.
   *
   * A cache, not a per-frame pass. The view redraws on every mouse move and a
   * large map is millions of pixels, so the conversion runs only over the
   * rectangles the tools already reported dirty. A stroke costs its own
   * footprint; a zoomed-out redraw costs the one drawImage it always cost.
   */
  var shown = { canvas: null, all: true, rects: [] }

  /** Mark a rectangle of the terrain layer as needing re-derivation, or all of it. */
  function shownDirty(rect) {
    if (!rect) { shown.all = true; shown.rects = []; return }
    if (!shown.all) shown.rects.push(rect)
  }

  function refreshShown(x, y, w, h) {
    var x0 = Math.max(0, Math.floor(x))
    var y0 = Math.max(0, Math.floor(y))
    var x1 = Math.min(doc.width, Math.ceil(x + w))
    var y1 = Math.min(doc.height, Math.ceil(y + h))
    if (x1 <= x0 || y1 <= y0) return
    var air = airKeys()
    var image = ctxOf(doc.layers.terrain).getImageData(x0, y0, x1 - x0, y1 - y0)
    var d = image.data
    for (var i = 0; i < d.length; i += 4) {
      // A see-through pixel is already nothing on screen, and the validator
      // has its own thing to say about one being in the terrain layer.
      if (d[i + 3] === 0) continue
      if (air[(d[i] << 16) | (d[i + 1] << 8) | d[i + 2]]) d[i + 3] = 0
    }
    ctxOf(shown.canvas).putImageData(image, x0, y0)
  }

  /** What render() draws for the terrain layer. */
  function shownTerrain() {
    airKeys()
    // With no table there is no colour anyone can prove is air, so the layer
    // is drawn as it is stored rather than guessed at.
    if (!ANY_AIR) return doc.layers.terrain
    if (!shown.canvas) {
      shown.canvas = newCanvas(doc.width, doc.height)
      // Named so nothing can mistake it for one of the six the map is made of.
      shown.canvas.className = 'shown'
      shown.all = true
    }
    if (shown.canvas.width !== doc.width || shown.canvas.height !== doc.height) {
      shown.canvas.width = doc.width
      shown.canvas.height = doc.height
      shown.all = true
    }
    if (shown.all) {
      refreshShown(0, 0, doc.width, doc.height)
    } else {
      for (var i = 0; i < shown.rects.length; i++) {
        refreshShown(shown.rects[i].x, shown.rects[i].y, shown.rects[i].w, shown.rects[i].h)
      }
    }
    shown.all = false
    shown.rects = []
    return shown.canvas
  }

  // --------------------------------------------------------------- overlay
  function build() {
    var style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)

    overlay = document.createElement('div')
    overlay.id = 'smln-mapedit'

    // --- masthead: what is being edited, and the way out.
    var header = document.createElement('header')
    var h2 = document.createElement('h2')
    h2.textContent = tx('editor.title', 'Map editor')
    var name = document.createElement('input')
    name.className = 'name'
    name.type = 'text'
    name.setAttribute('aria-label', tx('editor.nameLabel', 'Map name'))
    name.addEventListener('input', function () {
      if (doc) { doc.name = name.value; doc.dirty = true }
    })
    var dims = document.createElement('span')
    dims.className = 'dims'
    var close = document.createElement('button')
    close.textContent = tx('editor.close', 'Close')
    close.addEventListener('click', function () { requestClose() })
    header.appendChild(h2)
    header.appendChild(name)
    header.appendChild(dims)
    header.appendChild(close)

    var tools = document.createElement('div')
    tools.className = 'tools'

    var work = document.createElement('div')
    work.className = 'work'

    var paletteSide = document.createElement('div')
    paletteSide.className = 'rail'

    var stage = document.createElement('div')
    stage.className = 'stage'
    // The world itself, as a piece of the page rather than as pixels on the
    // view: it carries the ground the map sits on, the frame around it and
    // the corner marks, and it is behind the canvas so nothing painted is
    // covered by it. Drawn here rather than in render() because a scrim and
    // a frame stroked onto the view are indistinguishable, to anything reading
    // the view back, from map an author painted.
    var plate = document.createElement('div')
    plate.className = 'plate'
    ;['tl', 'tr', 'bl', 'br'].forEach(function (corner) {
      var mark = document.createElement('i')
      mark.className = corner
      plate.appendChild(mark)
    })
    stage.appendChild(plate)
    var canvas = document.createElement('canvas')
    canvas.className = 'view'
    stage.appendChild(canvas)
    var busy = document.createElement('div')
    busy.className = 'busy'
    stage.appendChild(busy)

    var issues = document.createElement('div')
    issues.className = 'issues'

    work.appendChild(paletteSide)
    work.appendChild(stage)
    work.appendChild(issues)

    var footer = document.createElement('footer')
    var note = document.createElement('span')
    note.className = 'note'
    var under = document.createElement('span')
    under.className = 'under'
    var at = document.createElement('span')
    at.className = 'at'
    var save = document.createElement('button')
    save.className = 'save'
    save.textContent = tx('editor.save', 'Save')
    save.addEventListener('click', function () { saveMap(save) })
    footer.appendChild(note)
    footer.appendChild(under)
    footer.appendChild(at)
    footer.appendChild(save)

    overlay.appendChild(header)
    overlay.appendChild(tools)
    overlay.appendChild(work)
    overlay.appendChild(footer)
    document.body.appendChild(overlay)

    overlay._name = name
    overlay._dims = dims
    overlay._tools = tools
    overlay._stage = stage
    overlay._plate = plate
    overlay._canvas = canvas
    overlay._busy = busy
    overlay._issues = issues
    overlay._note = note
    overlay._under = under
    overlay._at = at
    overlay._save = save
    overlay._dialog = null

    buildTools(tools)
    buildPalette(paletteSide)
    buildIssues(issues)
    bindStage(canvas)
  }

  /**
   * A captioned cluster of controls, cut into one plate.
   *
   * The caption goes above rather than beside, which is what buys back the
   * width that used to make the toolbar three rows deep. What comes back is
   * the plate, because that is what the buttons go into.
   */
  function cluster(parent, caption, extra) {
    var box = document.createElement('div')
    box.className = 'cluster' + (extra ? ' ' + extra : '')
    if (caption) {
      var cap = document.createElement('span')
      cap.className = 'cap'
      cap.textContent = caption
      box.appendChild(cap)
    }
    var seg = document.createElement('div')
    seg.className = 'seg'
    box.appendChild(seg)
    parent.appendChild(box)
    return seg
  }

  function button(parent, text, title, onClick) {
    var b = document.createElement('button')
    b.textContent = text
    if (title) b.setAttribute('title', title)
    b.addEventListener('click', onClick)
    parent.appendChild(b)
    return b
  }

  /**
   * The toolbar: one row.
   *
   * Left to right it is what the hand does, then what the eye does, then what
   * the document does - and it is ordered by how often each is reached for,
   * not by how the code is organised. The drawing tools and the brush size
   * carry full weight at the left; history and zoom are small and quiet; the
   * five operations that reshape the whole document are behind one control,
   * because they are used once or twice in a map's life and each one moves
   * every pixel of all six layers.
   *
   * The layer selector is not here at all. It is in the rail (see
   * `buildLayers`): choosing a layer is a mode you set and leave, and putting
   * six more buttons plus six visibility dots in the row a hand is in
   * mid-stroke is what made this a wall in the first place.
   */
  function buildTools(tools) {
    var toolBtns = Object.create(null)
    var toolSeg = cluster(tools, tx('editor.tool', 'Tool'), 'loud')
    TOOLS.forEach(function (spec) {
      var b = button(toolSeg, tx('editor.tool.' + spec.id, spec.label),
        tx('editor.tool.' + spec.id + '.key', spec.label + '  (' + spec.key.toUpperCase() + ')'),
        function () { setTool(spec.id) })
      toolBtns[spec.id] = b
    })

    var brushBtns = []
    var brushSeg = cluster(tools, tx('editor.brush', 'Brush'), 'loud sizes')
    BRUSHES.forEach(function (size, i) {
      var b = button(brushSeg, String(size),
        tx('editor.brushSize', size + ' cells across  (' + (i + 1) + ')', { size: size }),
        function () { brush = size; refreshTools() })
      b._size = size
      brushBtns.push(b)
    })

    // Everything from here rides the right-hand edge, and keeps riding it if
    // the row has to wrap on a narrow window.
    var histSeg = cluster(tools, tx('editor.history', 'History'), 'push')
    var panBtn = button(histSeg, tx('editor.pan', 'Pan'), null,
      function () { panMode = !panMode; refreshTools() })
    var undoBtn = button(histSeg, tx('editor.undo', 'Undo'),
      tx('editor.undoTip', 'Undo  (Ctrl+Z)'), function () { stepBack() })
    var redoBtn = button(histSeg, tx('editor.redo', 'Redo'),
      tx('editor.redoTip', 'Redo  (Ctrl+Y)'), function () { stepForward() })

    var zoomSeg = cluster(tools, tx('editor.zoom', 'Zoom'))
    button(zoomSeg, '-', null, function () { zoomBy(0.5) })
    var zoomVal = document.createElement('span')
    zoomVal.className = 'zoomval'
    zoomSeg.appendChild(zoomVal)
    button(zoomSeg, '+', null, function () { zoomBy(2) })
    button(zoomSeg, '1:1', null, function () { setZoom(1); centreView(); render(); refreshTools() })
    button(zoomSeg, tx('editor.fit', 'Fit'), null, function () { fitView(); render(); refreshTools() })

    // --- the document operations, behind one control.
    //
    // All five are built here and stay built, shown or not. A menu that
    // constructs itself on the way open is a menu whose contents only exist
    // once somebody has already found it, and these five are the operations
    // an author most needs to be able to go looking for.
    var shapeBox = document.createElement('div')
    shapeBox.className = 'shapeBox apart'
    var shapeBtn = document.createElement('button')
    shapeBtn.className = 'shapeBtn'
    shapeBtn.textContent = tx('editor.shape', 'Shape')
    shapeBtn.setAttribute('aria-haspopup', 'true')
    shapeBtn.setAttribute('aria-expanded', 'false')
    shapeBtn.addEventListener('click', function () { setShapeMenu(!shapeOpen) })
    var shapeMenu = document.createElement('div')
    shapeMenu.className = 'shapeMenu'
    shapeBox.appendChild(shapeBtn)
    shapeBox.appendChild(shapeMenu)
    tools.appendChild(shapeBox)

    /** A menu entry: it does its thing, and the menu is done. */
    var op = function (text, title, run) {
      return button(shapeMenu, text, title, function () { setShapeMenu(false); run() })
    }
    op(tx('editor.resize', 'Resize...'),
      tx('editor.resizeTip', 'Change the map size, keeping what is painted anchored somewhere in it'),
      function () { openResize() })
    var cropBtn = op(tx('editor.crop', 'Crop'),
      tx('editor.cropTip', 'Cut the map down to the selection'),
      function () { cropToSelection() })
    op(tx('editor.mirrorX', 'Mirror ⇄'), null, function () { applyMirror('x') })
    op(tx('editor.mirrorY', 'Mirror ⇅'), null, function () { applyMirror('y') })
    op(tx('editor.shift', 'Shift...'),
      tx('editor.shiftTip', 'Move everything painted by a number of cells'),
      function () { openShift() })

    var checkBox = document.createElement('div')
    checkBox.className = 'cluster'
    var checkCap = document.createElement('span')
    checkCap.className = 'cap'
    checkCap.textContent = tx('editor.checkCap', 'Check')
    checkBox.appendChild(checkCap)
    var checkBtn = button(checkBox, tx('editor.check', 'Check map'),
      tx('editor.checkTip', 'Read the map back and say what it will do to the player'),
      function () { runCheck(false) })
    tools.appendChild(checkBox)

    // A menu that can only be left by choosing something out of it is a trap;
    // clicking anywhere else closes it, and so does Escape (see onKey). The
    // guard is for the self-test's DOM, which has no document-level dispatch.
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('click', function (ev) {
        if (!shapeOpen) return
        var target = ev && ev.target
        if (target && typeof shapeBox.contains === 'function' && shapeBox.contains(target)) return
        setShapeMenu(false)
      }, true)
    }

    overlay._toolBtns = toolBtns
    overlay._brushBtns = brushBtns
    overlay._panBtn = panBtn
    overlay._undoBtn = undoBtn
    overlay._redoBtn = redoBtn
    overlay._cropBtn = cropBtn
    overlay._checkBtn = checkBtn
    overlay._zoomVal = zoomVal
    overlay._shapeBtn = shapeBtn
    overlay._shapeMenu = shapeMenu
  }

  /** Open or close the document-operations menu, and say which on the trigger. */
  function setShapeMenu(open_) {
    shapeOpen = !!open_
    if (!overlay || !overlay._shapeMenu) return
    overlay._shapeMenu.classList.toggle('open', shapeOpen)
    overlay._shapeBtn.classList.toggle('on', shapeOpen)
    overlay._shapeBtn.setAttribute('aria-expanded', shapeOpen ? 'true' : 'false')
  }

  /**
   * The rail: what is being painted with, what there is to paint with, and
   * which layer it lands on - in that order, top to bottom.
   *
   * The palette gets the room because it is the control reached for most
   * often and had the least of it: one narrow column of fifteen-pixel squares
   * under headings that scrolled away, so "which bucket is this" could only be
   * answered by scrolling back up. It is now the tall part of the rail, the
   * headings stay put while their own group scrolls, and a swatch is big
   * enough to tell two pale yellows apart. One wide column rather than two,
   * because the labels are the warning - "blocks until dug" is in one of them
   * - and a second column would buy density by truncating exactly the words
   * that must not be shortened.
   *
   * Only `paintable()` is offered, so the two colours that make the game give
   * up while loading a map cannot be reached from here at all - they stay in
   * the table only so a map that already contains one can be reported. Every
   * entry's `note` is on the button as its tooltip, because the note is where
   * "solid rock" turns out to need a drill and "looks like black rock" turns
   * out to dissolve in one lump.
   */
  function buildPalette(side) {
    var current = document.createElement('div')
    current.className = 'current'
    var chip = document.createElement('div')
    chip.className = 'chip'
    var who = document.createElement('div')
    who.className = 'who'
    var label = document.createElement('b')
    var rgb = document.createElement('span')
    who.appendChild(label)
    who.appendChild(rgb)
    current.appendChild(chip)
    current.appendChild(who)
    side.appendChild(current)

    var swatches = document.createElement('div')
    swatches.className = 'swatches'
    side.appendChild(swatches)

    // Said once, plainly, and nowhere else. A colour here is the code the map
    // format stores, not the material's appearance - the indestructible one is
    // bright red and the diggable one is pure black - and the view deliberately
    // does not show what the world will look like either. One line is the whole
    // remedy: this file does not know any material's real appearance and must
    // not invent one.
    //
    // It goes inside the palette's scroller rather than above it, as the first
    // thing there. Said once means it can scroll away once it has been read,
    // and a permanent block of it was fifty pixels of colours nobody could see.
    var codes = document.createElement('div')
    codes.className = 'paletteKey'
    codes.textContent = tx('editor.paletteCodes',
      'These squares are the codes the map format stores, not how the world will look.')
    swatches.appendChild(codes)

    var hint = document.createElement('div')
    hint.className = 'layerHint'
    hint.textContent = tx('editor.paletteTerrainOnly',
      'These colours say what the terrain layer becomes. Another layer reads colour its own way.')
    side.appendChild(hint)

    var swatchBtns = []
    if (!palette || typeof palette.paintable !== 'function') {
      var missing = document.createElement('div')
      missing.className = 'paletteNote'
      missing.textContent = tx('editor.noPalette',
        'The colour table did not load, so there is no safe colour to paint with.')
      swatches.appendChild(missing)
    } else {
      var offered = palette.paintable()
      var kinds = palette.KINDS || ['solid', 'empty', 'fluid', 'broken']
      kinds.forEach(function (kind) {
        var rows = offered.filter(function (e) { return e.kind === kind })
        if (!rows.length) return
        var heading = document.createElement('div')
        heading.className = 'kind'
        heading.textContent = tx('editor.kind.' + kind, KIND_HEADING[kind] || kind)
        swatches.appendChild(heading)
        rows.forEach(function (entry) {
          var b = document.createElement('button')
          b.className = 'swatch'
          var c = document.createElement('span')
          c.className = 'chip'
          c.style.background = cssOf(entry)
          var txt = document.createElement('span')
          txt.className = 'txt'
          // Verbatim. The fog labels carry "blocks until dug" and shortening
          // one is how an author reaches for fog thinking it is rock.
          txt.textContent = entry.label
          b.appendChild(c)
          b.appendChild(txt)
          b.setAttribute('title', entry.note
            ? entry.label + ' - ' + colourText(entry) + '\n' + entry.note
            : entry.label + ' - ' + colourText(entry))
          b.setAttribute('data-hex', entry.hex)
          b._entry = entry
          b.addEventListener('click', function () { setInk(entry) })
          swatches.appendChild(b)
          swatchBtns.push(b)
        })
      })
    }

    buildLayers(side)

    overlay._swatches = swatchBtns
    overlay._currentChip = chip
    overlay._currentLabel = label
    overlay._currentRgb = rgb
    overlay._layerHint = hint
  }

  /**
   * The six layers, pinned to the foot of the rail.
   *
   * Each row is the name and its own visibility together, so "show me only the
   * lights" is one click on the row it belongs to rather than a hunt along a
   * line of loose dots. Which layer is active is carried by the row's left
   * edge, its ground and its weight - three cues, none of them colour, so it
   * reads the same in grayscale - and by aria-pressed, so it reads at all
   * without eyes.
   */
  function buildLayers(side) {
    var box = document.createElement('div')
    box.className = 'layers'
    var cap = document.createElement('span')
    cap.className = 'cap'
    cap.textContent = tx('editor.layers', 'Layer')
    box.appendChild(cap)

    var layerBtns = Object.create(null)
    var layerRows = Object.create(null)
    var eyeBtns = Object.create(null)
    LAYERS.forEach(function (layer) {
      var row = document.createElement('div')
      row.className = 'layerRow'
      var pick = button(row, tx('editor.layer.' + layer, LAYER_LABEL[layer]), null,
        function () { setLayer(layer) })
      pick.className = 'layerPick'
      var eye = document.createElement('button')
      eye.className = 'eye'
      eye.setAttribute('aria-label', tx('editor.visibility', 'Show or hide this layer'))
      eye.addEventListener('click', function () {
        visible[layer] = !visible[layer]
        refreshTools()
        render()
      })
      row.appendChild(eye)
      box.appendChild(row)
      layerBtns[layer] = pick
      layerRows[layer] = row
      eyeBtns[layer] = eye
    })

    side.appendChild(box)
    overlay._layerBtns = layerBtns
    overlay._layerRows = layerRows
    overlay._eyeBtns = eyeBtns
  }

  function buildIssues(issues) {
    var top = document.createElement('div')
    top.className = 'top'
    var title = document.createElement('b')
    title.textContent = tx('editor.problems', 'What this map will do')
    top.appendChild(title)
    button(top, tx('editor.hide', 'Hide'), null, function () {
      keepingCentre(function () { issues.classList.toggle('open', false) })
      refreshTools()
    })
    var body = document.createElement('div')
    body.className = 'body'
    issues.appendChild(top)
    issues.appendChild(body)
    overlay._issuesBody = body
  }

  function refreshTools() {
    if (!overlay) return
    // `aria-pressed` beside every one of these: the visual state is a plate
    // that inverts or a row that raises, and neither of those reaches a screen
    // reader on its own.
    TOOLS.forEach(function (spec) {
      var b = overlay._toolBtns[spec.id]
      b.classList.toggle('on', tool === spec.id)
      b.setAttribute('aria-pressed', tool === spec.id ? 'true' : 'false')
    })
    overlay._brushBtns.forEach(function (b) {
      b.classList.toggle('on', b._size === brush)
      b.setAttribute('aria-pressed', b._size === brush ? 'true' : 'false')
    })
    LAYERS.forEach(function (layer) {
      // The row carries the state, not the name inside it: the left edge, the
      // ground and the weight all belong to the row the eye toggle sits in.
      overlay._layerRows[layer].classList.toggle('on', active === layer)
      overlay._layerBtns[layer].setAttribute('aria-pressed', active === layer ? 'true' : 'false')
      var eye = overlay._eyeBtns[layer]
      eye.classList.toggle('off', !visible[layer])
      eye.setAttribute('aria-pressed', visible[layer] ? 'true' : 'false')
      // A glyph, not only a colour, so the state is readable without it.
      eye.textContent = visible[layer] ? '◉' : '◌'
    })
    overlay._panBtn.classList.toggle('on', panMode)
    overlay._panBtn.setAttribute('aria-pressed', panMode ? 'true' : 'false')
    overlay._undoBtn.disabled = undo.depth() === 0
    overlay._redoBtn.disabled = redo.depth() === 0
    overlay._cropBtn.disabled = !selection || !xform
    overlay._checkBtn.disabled = !checker
    overlay._zoomVal.textContent = Math.round(view.zoom * 100) + '%'
    overlay._canvas.classList.toggle('pan', panMode)
    overlay._dims.textContent = doc ? doc.width + '×' + doc.height : ''
    if (doc && overlay._name.value !== doc.name) overlay._name.value = doc.name

    var entry = inkEntry()
    overlay._currentChip.style.background = cssOf(entry)
    overlay._currentLabel.textContent = entry
      ? entry.label
      : tx('editor.noColour', 'No colour available')
    overlay._currentRgb.textContent = entry ? colourText(entry) : ''
    overlay._swatches.forEach(function (b) { b.classList.toggle('on', b._entry === entry) })
    overlay._layerHint.classList.toggle('on', active !== 'terrain')
  }

  function say(text, isError) {
    if (!overlay) return
    overlay._note.textContent = text || ''
    overlay._note.classList.toggle('err', !!isError)
  }

  function busy(text) {
    if (!overlay) return
    overlay._busy.textContent = text || ''
  }

  function setTool(id) {
    tool = id
    band = null
    refreshTools()
    render()
  }

  /** Selecting a layer shows it: painting into a hidden layer is invisible. */
  function setLayer(layer) {
    active = layer
    visible[layer] = true
    refreshTools()
    render()
  }

  function setInk(entry) {
    ink = entry
    refreshTools()
  }

  // ------------------------------------------------------------ the view
  function stageSize() {
    var stage = overlay._stage
    return {
      width: Math.max(1, stage.clientWidth || 0),
      height: Math.max(1, stage.clientHeight || 0),
    }
  }

  function setZoom(z) {
    view.zoom = Math.max(1 / 16, Math.min(64, z))
  }

  function zoomBy(factor) {
    if (!doc) return
    var size = stageSize()
    // Keep whatever is in the middle of the view in the middle of the view.
    var cx = (size.width / 2 - view.x) / view.zoom
    var cy = (size.height / 2 - view.y) / view.zoom
    setZoom(view.zoom * factor)
    view.x = Math.round(size.width / 2 - cx * view.zoom)
    view.y = Math.round(size.height / 2 - cy * view.zoom)
    render()
    refreshTools()
  }

  /**
   * Run something that changes how wide the stage is, and keep whatever was in
   * the middle of the view in the middle of it.
   *
   * Opening the problems panel takes 320 pixels off the stage. Left alone, the
   * view keeps an offset measured against the old width, so the map slides out
   * of frame at the moment the author asked a question about it - which reads
   * as the editor having lost the map. The same arithmetic as zoomBy, for the
   * same reason.
   */
  function keepingCentre(change) {
    if (!overlay || !doc) { change(); return }
    var before = stageSize()
    var cx = (before.width / 2 - view.x) / view.zoom
    var cy = (before.height / 2 - view.y) / view.zoom
    change()
    var after = stageSize()
    if (after.width === before.width && after.height === before.height) return
    view.x = Math.round(after.width / 2 - cx * view.zoom)
    view.y = Math.round(after.height / 2 - cy * view.zoom)
    render()
  }

  function fitView() {
    if (!doc) return
    var size = stageSize()
    var z = Math.min(size.width / doc.width, size.height / doc.height)
    setZoom(isFinite(z) && z > 0 ? z : 1)
    centreView()
  }

  function centreView() {
    if (!doc) return
    var size = stageSize()
    view.x = Math.round((size.width - doc.width * view.zoom) / 2)
    view.y = Math.round((size.height - doc.height * view.zoom) / 2)
  }

  /** Put a cell in the middle of the stage - what a problem's `at` needs. */
  function jumpTo(cell) {
    if (!doc || !cell) return
    var size = stageSize()
    if (view.zoom < 1) setZoom(1)
    view.x = Math.round(size.width / 2 - (cell.x + 0.5) * view.zoom)
    view.y = Math.round(size.height / 2 - (cell.y + 0.5) * view.zoom)
    render()
    refreshTools()
  }

  function render() {
    if (!overlay || !doc) return
    var canvas = overlay._canvas
    var size = stageSize()
    if (canvas.width !== size.width) canvas.width = size.width
    if (canvas.height !== size.height) canvas.height = size.height

    var ctx = canvas.getContext('2d')
    if (!ctx) return
    // Resizing a canvas resets its context, so this is re-asserted per frame
    // rather than once at build time.
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    var dw = Math.max(1, Math.round(doc.width * view.zoom))
    var dh = Math.max(1, Math.round(doc.height * view.zoom))
    placePlate(dw, dh)
    for (var i = 0; i < LAYERS.length; i++) {
      var layer = LAYERS[i]
      if (!visible[layer]) continue
      // Terrain is drawn from what its colours mean, not from what they spell.
      var source = layer === 'terrain' ? shownTerrain() : doc.layers[layer]
      ctx.drawImage(source, 0, 0, doc.width, doc.height, view.x, view.y, dw, dh)
    }

    drawSpawnMarker(ctx)
    drawSelection(ctx)
    drawBand(ctx)
  }

  /**
   * Put the world's own rectangle under the view, at the size and place the
   * map is drawn.
   *
   * This is the answer to "where does my map stop", and it is a piece of the
   * page rather than a stroke on the canvas for one reason: the view canvas is
   * read back - by the spawn check, and by anything else asking what is on
   * screen - and a frame or a scrim painted onto it is indistinguishable there
   * from terrain an author painted. Behind the canvas it can be as definite as
   * it likes: the checkerboard is the world's ground and stops at its edge, so
   * outside the map is flat and dark, a hairline separates the two, and the
   * four corner marks state the extent outright.
   */
  function placePlate(dw, dh) {
    var plate = overlay._plate
    if (!plate) return
    plate.style.display = 'block'
    plate.style.left = Math.round(view.x) + 'px'
    plate.style.top = Math.round(view.y) + 'px'
    plate.style.width = dw + 'px'
    plate.style.height = dh + 'px'
  }

  /** No document, no world: the frame must not outlive the map it framed. */
  function hidePlate() {
    if (overlay && overlay._plate) overlay._plate.style.display = 'none'
  }

  /** Screen position of a cell corner. */
  function screenX(cellX) { return view.x + cellX * view.zoom }
  function screenY(cellY) { return view.y + cellY * view.zoom }

  /**
   * Where the player will appear, drawn over every layer at every zoom.
   *
   * The spawn is fixed and unconditional - the game does not look for open
   * space - so an author who cannot see it cannot avoid burying it. It is
   * drawn on the view canvas and never into a layer, and it is a crosshair
   * whose arms are measured in screen pixels rather than cells: at a zoom
   * where one cell is a fraction of a pixel the cell box would vanish, and no
   * arrangement of painted cells can look like arms that stay the same length
   * as the map is zoomed.
   */
  function drawSpawnMarker(ctx) {
    if (!checker || typeof checker.spawnCell !== 'function') return
    var spawn = checker.spawnCell(doc.width)
    var x = screenX(spawn.x)
    var y = screenY(spawn.y)
    var w = Math.max(1, view.zoom)
    var arm = 9

    ctx.fillStyle = 'rgba(255,231,0,.30)'
    ctx.fillRect(x, y, w, w)
    if (ctx.strokeRect) {
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(4,7,11,.85)'
      ctx.strokeRect(x - 0.5, y - 0.5, w + 1, w + 1)
      ctx.strokeStyle = '#ffe700'
      ctx.strokeRect(x - 1.5, y - 1.5, w + 3, w + 3)
    }
    if (ctx.beginPath && ctx.moveTo && ctx.lineTo && ctx.stroke) {
      var cx = x + w / 2
      var cy = y + w / 2
      ctx.beginPath()
      ctx.moveTo(cx - w / 2 - arm, cy)
      ctx.lineTo(cx - w / 2 - 2, cy)
      ctx.moveTo(cx + w / 2 + 2, cy)
      ctx.lineTo(cx + w / 2 + arm, cy)
      ctx.moveTo(cx, cy - w / 2 - arm)
      ctx.lineTo(cx, cy - w / 2 - 2)
      ctx.moveTo(cx, cy + w / 2 + 2)
      ctx.lineTo(cx, cy + w / 2 + arm)
      ctx.strokeStyle = '#ffe700'
      ctx.stroke()
    }
  }

  function outline(ctx, rect, colour, dashed) {
    if (!ctx.strokeRect) return
    ctx.lineWidth = 1
    ctx.strokeStyle = colour
    if (dashed && ctx.setLineDash) ctx.setLineDash([4, 3])
    ctx.strokeRect(
      screenX(rect.x) - 0.5, screenY(rect.y) - 0.5,
      rect.w * view.zoom + 1, rect.h * view.zoom + 1)
    if (dashed && ctx.setLineDash) ctx.setLineDash([])
  }

  function drawSelection(ctx) {
    if (selection) outline(ctx, selection, 'rgba(226,232,240,.9)', true)
  }

  /** The rubber band, so a box or a line is placed before it is committed. */
  function drawBand(ctx) {
    if (!band) return
    var spec = toolSpec(band.tool)
    if (!spec || spec.drag !== 'band') return
    if (band.tool === 'line') {
      if (!ctx.beginPath) return
      ctx.beginPath()
      ctx.moveTo(screenX(band.from.x + 0.5), screenY(band.from.y + 0.5))
      ctx.lineTo(screenX(band.to.x + 0.5), screenY(band.to.y + 0.5))
      ctx.strokeStyle = 'rgba(226,232,240,.9)'
      ctx.lineWidth = 1
      ctx.stroke()
      return
    }
    outline(ctx, bandRect(), 'rgba(226,232,240,.9)', true)
  }

  function bandRect() {
    var x0 = Math.min(band.from.x, band.to.x)
    var y0 = Math.min(band.from.y, band.to.y)
    return {
      x: x0, y: y0,
      w: Math.abs(band.to.x - band.from.x) + 1,
      h: Math.abs(band.to.y - band.from.y) + 1,
    }
  }

  function toolSpec(id) {
    for (var i = 0; i < TOOLS.length; i++) if (TOOLS[i].id === id) return TOOLS[i]
    return null
  }

  function cellAt(clientX, clientY) {
    var rect = overlay._canvas.getBoundingClientRect
      ? overlay._canvas.getBoundingClientRect()
      : { left: 0, top: 0 }
    return {
      x: Math.floor((clientX - rect.left - view.x) / view.zoom),
      y: Math.floor((clientY - rect.top - view.y) / view.zoom),
    }
  }

  // -------------------------------------------------------------- painting
  function beginStroke(layer) {
    stroke = { layer: layer, seen: Object.create(null), tiles: [] }
  }

  /**
   * Remember what a rectangle looked like before the stroke touches it.
   *
   * Tile-aligned and recorded once per stroke, so dragging back and forth over
   * the same ground costs those tiles once. Undo restores the tiles rather
   * than a bounding box, so the gaps a stroke skipped are never overwritten
   * with stale pixels.
   *
   * Called with the rectangle a tool reported as dirty, and always before the
   * pixels go back to the canvas - the tools work on a detached ImageData, so
   * at this moment the canvas still holds what was there before.
   */
  function captureBefore(x0, y0, x1, y1) {
    if (!stroke) return
    var ctx = ctxOf(doc.layers[stroke.layer])
    var tx0 = Math.floor(x0 / UNDO_TILE)
    var ty0 = Math.floor(y0 / UNDO_TILE)
    var tx1 = Math.floor(x1 / UNDO_TILE)
    var ty1 = Math.floor(y1 / UNDO_TILE)
    for (var ty = ty0; ty <= ty1; ty++) {
      for (var tx = tx0; tx <= tx1; tx++) {
        var key = tx + ',' + ty
        if (stroke.seen[key]) continue
        stroke.seen[key] = true
        var px = tx * UNDO_TILE
        var py = ty * UNDO_TILE
        var w = Math.min(UNDO_TILE, doc.width - px)
        var h = Math.min(UNDO_TILE, doc.height - py)
        if (px < 0 || py < 0 || w <= 0 || h <= 0) continue
        stroke.tiles.push({ layer: stroke.layer, x: px, y: py, image: ctx.getImageData(px, py, w, h) })
      }
    }
  }

  function endStroke() {
    if (stroke && stroke.tiles.length) commit({ layer: stroke.layer, tiles: stroke.tiles })
    stroke = null
    refreshTools()
  }

  /**
   * Run one tool over one layer, and repaint and record only what it touched.
   *
   * The shape is the same for every tool: lift the smallest region that could
   * possibly change, hand that buffer to the module, and take back the exact
   * dirty rectangle it reports. Nothing here recomputes what was touched -
   * an editor that guessed a wider rectangle than the tool actually wrote
   * would make undo restore pixels the stroke never owned.
   *
   * `run` is called with the buffer and the origin it was lifted from, and
   * returns the tool's rectangle in buffer coordinates, or null.
   */
  function operate(layer, box, run) {
    if (!doc || !draw) return null
    var x0 = Math.max(0, Math.min(doc.width - 1, box.x))
    var y0 = Math.max(0, Math.min(doc.height - 1, box.y))
    var x1 = Math.max(0, Math.min(doc.width - 1, box.x + box.w - 1))
    var y1 = Math.max(0, Math.min(doc.height - 1, box.y + box.h - 1))
    if (x1 < x0 || y1 < y0) return null

    var ctx = ctxOf(doc.layers[layer])
    var buf = ctx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1)
    var rect = run(buf, x0, y0)
    if (!rect) return null

    var abs = { x: x0 + rect.x, y: y0 + rect.y, w: rect.w, h: rect.h }
    captureBefore(abs.x, abs.y, abs.x + abs.w - 1, abs.y + abs.h - 1)
    ctx.putImageData(buf, x0, y0)
    // The tool's own rectangle again, so what is redrawn is what was written.
    if (layer === 'terrain') shownDirty(abs)
    doc.dirty = true
    return abs
  }

  /**
   * The box a dab of `size` centred anywhere in (x0,y0)-(x1,y1) can reach.
   *
   * The width is the span between the ends plus the dab's own width: a dab
   * reaches `half` one way and `size - 1 - half` the other, and those two plus
   * the centre are `size`, so the span plus size covers both end dabs and
   * everything the tool draws between them.
   */
  function reach(x0, y0, x1, y1, size) {
    var half = Math.floor((size - 1) / 2)
    return {
      x: Math.min(x0, x1) - half,
      y: Math.min(y0, y1) - half,
      w: Math.abs(x1 - x0) + size,
      h: Math.abs(y1 - y0) + size,
    }
  }

  /**
   * One dab.
   *
   * The eraser goes through the module's own `eraser` rather than through
   * `brush` with a pale colour: that function refuses a fully transparent
   * colour and writes nothing, which is the guard that stops an eraser filling
   * a map with Fog. Routing around it would work today and quietly stop being
   * true the moment somebody made the eraser's colour configurable.
   */
  function paintDab(cell, rgba) {
    var dab = tool === 'eraser' ? draw.eraser : draw.brush
    return operate(active, reach(cell.x, cell.y, cell.x, cell.y, brush), function (buf, ox, oy) {
      return dab(buf, cell.x - ox, cell.y - oy, brush, rgba)
    })
  }

  function paintLine(from, to, rgba) {
    return operate(active, reach(from.x, from.y, to.x, to.y, brush), function (buf, ox, oy) {
      return draw.line(buf, from.x - ox, from.y - oy, to.x - ox, to.y - oy, brush, rgba)
    })
  }

  function paintRect(from, to, rgba, filled) {
    var box = {
      x: Math.min(from.x, to.x),
      y: Math.min(from.y, to.y),
      w: Math.abs(to.x - from.x) + 1,
      h: Math.abs(to.y - from.y) + 1,
    }
    return operate(active, box, function (buf, ox, oy) {
      return draw.rectangle(buf, from.x - ox, from.y - oy, to.x - ox, to.y - oy, rgba, filled)
    })
  }

  /**
   * Flood fill needs the whole layer: the region it reaches is not knowable
   * until it has reached it.
   */
  function paintFill(cell, rgba) {
    return operate(active, { x: 0, y: 0, w: doc.width, h: doc.height }, function (buf) {
      return draw.fill(buf, cell.x, cell.y, rgba)
    })
  }

  /** The colour under a cell, as the eyedropper and the readout both need it. */
  function colourAt(layer, x, y) {
    if (!doc || x < 0 || y < 0 || x >= doc.width || y >= doc.height) return null
    var image = ctxOf(doc.layers[layer]).getImageData(x, y, 1, 1)
    return draw ? draw.pick(image, 0, 0)
      : [image.data[0], image.data[1], image.data[2], image.data[3]]
  }

  function eyedropper(cell) {
    var c = colourAt(active, cell.x, cell.y)
    if (!c) return
    var entry = palette ? palette.byRgb(c[0], c[1], c[2]) : null
    if (entry && entry.kind !== 'broken') {
      setInk(entry)
      say(entry.label + ' - ' + colourText(entry))
    } else if (entry) {
      say(tx('editor.pickedBroken', 'That is ' + entry.label + ' - it cannot be painted with.'), true)
    } else {
      say(tx('editor.pickedUnknown',
        'The game has no material for ' + c[0] + ',' + c[1] + ',' + c[2] +
        ' - a cell of it is left as empty space.'), true)
    }
  }

  // ------------------------------------------------------------- history
  /**
   * Push a step and drop the redo history.
   *
   * Editing after an undo abandons what was undone, the way every editor does:
   * keeping it would mean redo replaying pixels onto a canvas that has moved
   * on underneath it.
   */
  function commit(step) {
    undo.push(step)
    redo.clear()
    refreshTools()
  }

  /** Every layer, whole, plus the size - what a transform has to be able to undo. */
  function snapshotDoc() {
    var tiles = []
    for (var i = 0; i < LAYERS.length; i++) {
      var layer = LAYERS[i]
      tiles.push({ layer: layer, x: 0, y: 0, image: bufferOf(layer) })
    }
    return { layer: null, size: { width: doc.width, height: doc.height }, tiles: tiles }
  }

  /** The same tiles, holding what is on the canvas right now. */
  function recapture(step) {
    var tiles = []
    for (var i = 0; i < step.tiles.length; i++) {
      var tile = step.tiles[i]
      var layer = tile.layer || step.layer
      tiles.push({
        layer: layer,
        x: tile.x,
        y: tile.y,
        image: ctxOf(doc.layers[layer]).getImageData(tile.x, tile.y, tile.image.width, tile.image.height),
      })
    }
    return { layer: step.layer, tiles: tiles }
  }

  /** Put a step's pixels back, growing or shrinking the document if it says to. */
  function applyStep(step) {
    if (step.size && (step.size.width !== doc.width || step.size.height !== doc.height)) {
      for (var i = 0; i < LAYERS.length; i++) {
        var canvas = doc.layers[LAYERS[i]]
        canvas.width = step.size.width
        canvas.height = step.size.height
      }
      doc.width = step.size.width
      doc.height = step.size.height
      selection = null
      shownDirty(null)
      fitView()
    }
    for (var j = 0; j < step.tiles.length; j++) {
      var tile = step.tiles[j]
      var name = tile.layer || step.layer
      ctxOf(doc.layers[name]).putImageData(tile.image, tile.x, tile.y)
      if (name === 'terrain') {
        shownDirty({ x: tile.x, y: tile.y, w: tile.image.width, h: tile.image.height })
      }
    }
    doc.dirty = true
  }

  function move(from, to) {
    var step = from.pop()
    if (!step || !doc) { refreshTools(); return false }
    // The inverse is taken before the step lands, so it holds what is being
    // replaced rather than what replaced it.
    to.push(step.size ? snapshotDoc() : recapture(step))
    applyStep(step)
    render()
    refreshTools()
    return true
  }

  function stepBack() { move(undo, redo) }
  function stepForward() { move(redo, undo) }

  // ----------------------------------------------------------- transforms
  /**
   * The five colours that are not terrain fill their new space with nothing.
   *
   * Transparency means "nothing here" in all five - they are deny-lists and
   * decoration, and the shipped campaign map loads with no wall layer at all.
   * Terrain is the exception, and the reason mapeditor-transform.js refuses to
   * default a fill colour: a transparent terrain pixel is Fog, so new terrain
   * has to be the palette's real empty colour or the transform silently seals
   * the edges of the map.
   */
  function fillFor(layer) {
    if (layer !== 'terrain') return [0, 0, 0, 0]
    var c = rgbaOf(eraserEntry())
    return c || null
  }

  /**
   * Run one transform over all six layers, as one undo step.
   *
   * All six, always, and never one: the game fills its grids using each image's
   * own width as the stride, so layers of different sizes smear the world
   * diagonally and say nothing about it.
   */
  function transformAll(what, run) {
    if (!doc || !xform) {
      say(tx('editor.noTransform', 'the transform module did not load'), true)
      return false
    }
    var before = snapshotDoc()
    var results = []
    try {
      for (var i = 0; i < LAYERS.length; i++) {
        results.push(run(LAYERS[i], bufferOf(LAYERS[i])))
      }
    } catch (e) {
      say((e && e.message) || tx('editor.transformFailed', 'that could not be applied'), true)
      return false
    }

    var width = results[0].width
    var height = results[0].height
    for (var k = 0; k < results.length; k++) {
      if (results[k].width !== width || results[k].height !== height) {
        // Cannot happen with one operation and one set of arguments, and is
        // worth refusing rather than writing: unequal layers are the silent
        // corruption this function exists to prevent.
        say(tx('editor.transformUneven',
          'that transform would have left the layers different sizes, so nothing was changed'), true)
        return false
      }
    }

    for (var j = 0; j < LAYERS.length; j++) {
      var canvas = doc.layers[LAYERS[j]]
      canvas.width = width
      canvas.height = height
      var ctx = ctxOf(canvas)
      ctx.putImageData(asImageData(ctx, results[j]), 0, 0)
    }
    doc.width = width
    doc.height = height
    doc.dirty = true
    selection = null
    report = null
    shownDirty(null)
    commit(before)
    fitView()
    render()
    refreshTools()
    say(what + ' - ' + doc.width + ' × ' + doc.height + ' ' + tx('editor.cells', 'cells'))
    return true
  }

  function applyMirror(axis) {
    transformAll(axis === 'x'
      ? tx('editor.mirroredX', 'Mirrored left to right')
      : tx('editor.mirroredY', 'Mirrored top to bottom'),
    function (layer, buf) { return axis === 'x' ? xform.mirrorX(buf) : xform.mirrorY(buf) })
  }

  function cropToSelection() {
    if (!selection) {
      say(tx('editor.noSelection', 'Select an area first, with the Select tool.'), true)
      return
    }
    var rect = selection
    if (rect.w < MIN_WIDTH || rect.h < MIN_HEIGHT) {
      say(tx('editor.cropTooSmall',
        'That selection is ' + rect.w + ' × ' + rect.h + '. ' + minimumSentence()), true)
      return
    }
    transformAll(tx('editor.cropped', 'Cropped'), function (layer, buf) {
      return xform.crop(buf, rect.x, rect.y, rect.w, rect.h)
    })
  }

  // ------------------------------------------------------------- dialogs
  function closeDialog() {
    if (!overlay || !overlay._dialog) return
    overlay._stage.removeChild(overlay._dialog)
    overlay._dialog = null
  }

  function dialog(titleText) {
    closeDialog()
    var wrap = document.createElement('div')
    wrap.className = 'dialog'
    var card = document.createElement('div')
    card.className = 'card'
    var h3 = document.createElement('h3')
    h3.textContent = titleText
    card.appendChild(h3)
    wrap.appendChild(card)
    overlay._stage.appendChild(wrap)
    overlay._dialog = wrap
    return card
  }

  function field(parent, labelText, value) {
    var label = document.createElement('label')
    label.textContent = labelText
    var input = document.createElement('input')
    input.type = 'text'
    input.value = String(value)
    parent.appendChild(label)
    parent.appendChild(input)
    return input
  }

  function dialogButtons(card, confirmText, onConfirm) {
    var row = document.createElement('div')
    row.className = 'row'
    button(row, tx('editor.cancel', 'Cancel'), null, function () { closeDialog() })
    var ok = button(row, confirmText, null, onConfirm)
    ok.className = 'save'
    card.appendChild(row)
    return ok
  }

  function openResize() {
    if (!doc || !xform) return
    var card = dialog(tx('editor.resizeTitle', 'Resize the map'))
    var pair = document.createElement('div')
    pair.className = 'pair'
    var wcell = document.createElement('div')
    var hcell = document.createElement('div')
    pair.appendChild(wcell)
    pair.appendChild(hcell)
    var widthInput = field(wcell, tx('editor.width', 'Width (cells)'), doc.width)
    var heightInput = field(hcell, tx('editor.height', 'Height (cells)'), doc.height)
    card.appendChild(pair)

    var anchorLabel = document.createElement('label')
    anchorLabel.textContent = tx('editor.anchor', 'Keep what is painted at')
    card.appendChild(anchorLabel)
    var grid = document.createElement('div')
    grid.className = 'anchors'
    var chosen = 'center'
    var anchorBtns = []
    ANCHORS.forEach(function (anchor) {
      var b = button(grid, '·', anchor, function () {
        chosen = anchor
        anchorBtns.forEach(function (o) { o.classList.toggle('on', o._anchor === chosen) })
      })
      b._anchor = anchor
      b.classList.toggle('on', anchor === chosen)
      anchorBtns.push(b)
    })
    card.appendChild(grid)

    var hint = document.createElement('div')
    hint.className = 'hint'
    hint.textContent = minimumSentence()
    card.appendChild(hint)

    /*
     * The refusal has to LOOK like one.
     *
     * This hint already carries the minimum-size sentence at rest, so writing a
     * near-identical sentence into the same grey paragraph changes almost
     * nothing on screen - the button appears to do nothing at all. Measured in
     * the running game: entering 100 x 150 and pressing Resize was
     * indistinguishable from a dead button.
     */
    function refuseResize(message, bad) {
      hint.textContent = message
      hint.className = 'hint refused'
      for (var i = 0; i < bad.length; i++) bad[i].className = 'bad'
    }

    function clearRefusal() {
      hint.className = 'hint'
      widthInput.className = ''
      heightInput.className = ''
    }
    widthInput.addEventListener('input', clearRefusal)
    heightInput.addEventListener('input', clearRefusal)

    dialogButtons(card, tx('editor.apply', 'Resize'), function () {
      var w = Math.round(Number(widthInput.value))
      var h = Math.round(Number(heightInput.value))
      var bad = []
      if (!isFinite(w) || w < MIN_WIDTH || w > MAX_SIZE) bad.push(widthInput)
      if (!isFinite(h) || h < MIN_HEIGHT || h > MAX_SIZE) bad.push(heightInput)
      if (bad.length) {
        refuseResize(tx('editor.resizeRefused',
          'Between ' + MIN_WIDTH + ' × ' + MIN_HEIGHT + ' and ' + MAX_SIZE + ' × ' + MAX_SIZE +
          ' cells. ' + minimumSentence()), bad)
        return
      }
      closeDialog()
      transformAll(tx('editor.resized', 'Resized'), function (layer, buf) {
        return xform.resize(buf, w, h, chosen, fillFor(layer))
      })
    })
  }

  function openShift() {
    if (!doc || !xform) return
    var card = dialog(tx('editor.shiftTitle', 'Shift everything'))
    var pair = document.createElement('div')
    pair.className = 'pair'
    var xcell = document.createElement('div')
    var ycell = document.createElement('div')
    pair.appendChild(xcell)
    pair.appendChild(ycell)
    var dxInput = field(xcell, tx('editor.shiftX', 'Right (cells)'), 0)
    var dyInput = field(ycell, tx('editor.shiftY', 'Down (cells)'), 0)
    card.appendChild(pair)

    var hint = document.createElement('div')
    hint.className = 'hint'
    hint.textContent = tx('editor.shiftHint',
      'The map keeps its size. Anything pushed over an edge is lost, and the space left behind ' +
      'becomes empty terrain.')
    card.appendChild(hint)

    dialogButtons(card, tx('editor.applyShift', 'Shift'), function () {
      var dx = Math.round(Number(dxInput.value))
      var dy = Math.round(Number(dyInput.value))
      if (!isFinite(dx) || !isFinite(dy)) {
        hint.textContent = tx('editor.shiftRefused', 'Give a whole number of cells for each.')
        return
      }
      closeDialog()
      transformAll(tx('editor.shifted', 'Shifted'), function (layer, buf) {
        return xform.shift(buf, dx, dy, fillFor(layer))
      })
    })
  }

  // ---------------------------------------------------------- validation
  /**
   * Read the map back and say what it will do to the player.
   *
   * The messages are not paraphrased and not summarised: mapeditor-validate.js
   * writes them for a mapmaker holding a brush, and each one says what will
   * happen in the world rather than what is wrong with the file. Anything this
   * file added would be a worse version of the same sentence.
   */
  function runCheck(quiet) {
    if (!doc) return null
    if (!checker || typeof checker.validate !== 'function') {
      if (!quiet) say(tx('editor.noValidate', 'the map checker did not load'), true)
      return null
    }
    var layers = {}
    for (var i = 0; i < LAYERS.length; i++) layers[LAYERS[i]] = bufferOf(LAYERS[i])
    var out = checker.validate({
      params: { width: doc.width, height: doc.height },
      layers: layers,
    })
    var problems = (out && out.problems) || []
    report = {
      problems: problems,
      errors: problems.filter(function (p) { return p.severity === 'error' }),
      warnings: problems.filter(function (p) { return p.severity !== 'error' }),
    }
    // Opened when the author asked, and when there is something to read.
    // A save that is clean has nothing to show and should not open a panel to
    // say so - the footer already does.
    showIssues(!quiet || problems.length > 0)
    if (!quiet) {
      if (report.errors.length) {
        say(countText(report.errors.length, report.warnings.length) + ' ' +
          tx('editor.errorsBlock', 'Errors stop the map being saved; warnings do not.'), true)
      } else if (report.warnings.length) {
        say(countText(0, report.warnings.length) + ' ' +
          tx('editor.warningsOk', 'Warnings do not stop the map being saved.'))
      } else {
        say(tx('editor.checkClean', 'Nothing to report - this map will load and play.'))
      }
    }
    return report
  }

  function countText(errors, warnings) {
    var parts = []
    if (errors) {
      parts.push(errors + ' ' + (errors === 1
        ? tx('editor.oneError', 'error') : tx('editor.manyErrors', 'errors')))
    }
    if (warnings) {
      parts.push(warnings + ' ' + (warnings === 1
        ? tx('editor.oneWarning', 'warning') : tx('editor.manyWarnings', 'warnings')))
    }
    return parts.join(', ') + '.'
  }

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild)
  }

  function showIssues(openPanel) {
    if (!overlay || !report) return
    var body = overlay._issuesBody
    clearChildren(body)

    if (!report.problems.length) {
      var clean = document.createElement('div')
      clean.className = 'sev clean'
      clean.textContent = tx('editor.checkCleanLong',
        'Nothing to report. This map will load, and the player will land inside it.')
      body.appendChild(clean)
    }

    addSeverity(body, 'error', report.errors,
      tx('editor.errorsHeading',
        'Errors - the map is not saved until these are fixed'))
    addSeverity(body, 'warning', report.warnings,
      tx('editor.warningsHeading',
        'Warnings - the map still saves and still plays'))

    if (openPanel) {
      keepingCentre(function () { overlay._issues.classList.toggle('open', true) })
    }
    refreshTools()
  }

  function addSeverity(body, severity, list, headingText) {
    if (!list.length) return
    var heading = document.createElement('div')
    heading.className = 'sev ' + severity
    heading.textContent = headingText + ' (' + list.length + ')'
    body.appendChild(heading)

    list.forEach(function (p) {
      var b = document.createElement('button')
      b.className = 'problem ' + severity
      // Verbatim: the module wrote this for the person holding the brush.
      b.textContent = p.message
      var where = document.createElement('span')
      where.className = 'where'
      var bits = []
      if (p.layer) bits.push(tx('editor.layer.' + p.layer, LAYER_LABEL[p.layer] || p.layer))
      if (p.at) bits.push(p.at.x + ', ' + p.at.y + '  ' + tx('editor.goThere', '(go there)'))
      where.textContent = bits.join('  ·  ')
      b.appendChild(where)
      b._problem = p
      b.addEventListener('click', function () {
        if (p.layer && doc && doc.layers[p.layer]) setLayer(p.layer)
        if (p.at) jumpTo(p.at)
      })
      body.appendChild(b)
    })
  }

  // ---------------------------------------------------------------- input
  function bindStage(canvas) {
    canvas.addEventListener('mousedown', function (ev) {
      if (!doc) return
      var pans = panMode || ev.button === 1 || ev.button === 2 || ev.shiftKey
      if (pans) {
        panning = { x: ev.clientX, y: ev.clientY, ox: view.x, oy: view.y }
      } else if (ev.button === 0 || ev.button == null) {
        beginAt(cellAt(ev.clientX, ev.clientY))
      }
      if (ev.preventDefault) ev.preventDefault()
    })

    canvas.addEventListener('mousemove', function (ev) {
      if (!doc) return
      var cell = cellAt(ev.clientX, ev.clientY)
      readout(cell)
      if (panning) {
        view.x = panning.ox + (ev.clientX - panning.x)
        view.y = panning.oy + (ev.clientY - panning.y)
        render()
      } else if (stroke) {
        var rgba = strokeInk()
        if (rgba) paintLine(stroke.last, cell, rgba)
        stroke.last = cell
        render()
      } else if (band) {
        band.to = cell
        render()
      }
    })

    canvas.addEventListener('wheel', function (ev) {
      if (!doc) return
      zoomBy(ev.deltaY < 0 ? 2 : 0.5)
      if (ev.preventDefault) ev.preventDefault()
    })

    // Released anywhere, including outside the canvas: a stroke that ends off
    // the edge of the stage must still end.
    window.addEventListener('mouseup', function () {
      panning = null
      if (stroke) endStroke()
      if (band) endBand()
    })
  }

  /** The colour the current stroke writes, or null if there is none to write. */
  function strokeInk() {
    var entry = tool === 'eraser' ? eraserEntry() : inkEntry()
    var rgba = rgbaOf(entry)
    if (!rgba) {
      say(tx('editor.noColourToPaint',
        'The colour table did not load, so there is no colour to paint with.'), true)
    }
    return rgba
  }

  function beginAt(cell) {
    var spec = toolSpec(tool)
    if (!spec) return
    if (spec.drag === 'band') {
      band = { tool: tool, from: cell, to: cell }
      render()
      return
    }
    if (tool === 'pick') { eyedropper(cell); return }
    if (tool === 'fill') {
      var fillInk = strokeInk()
      if (!fillInk) return
      beginStroke(active)
      paintFill(cell, fillInk)
      endStroke()
      render()
      return
    }
    var rgba = strokeInk()
    if (!rgba) return
    beginStroke(active)
    paintDab(cell, rgba)
    stroke.last = cell
    render()
  }

  function endBand() {
    var pending = band
    band = null
    if (!pending || !doc) { render(); return }
    if (pending.tool === 'select') {
      selection = clipRect({
        x: Math.min(pending.from.x, pending.to.x),
        y: Math.min(pending.from.y, pending.to.y),
        w: Math.abs(pending.to.x - pending.from.x) + 1,
        h: Math.abs(pending.to.y - pending.from.y) + 1,
      })
      say(selection
        ? tx('editor.selected', 'Selected ' + selection.w + ' × ' + selection.h + ' cells at ' +
          selection.x + ', ' + selection.y)
        : tx('editor.selectedNothing', 'That selection is outside the map.'), !selection)
      render()
      refreshTools()
      return
    }
    var rgba = strokeInk()
    if (!rgba) { render(); return }
    beginStroke(active)
    if (pending.tool === 'line') paintLine(pending.from, pending.to, rgba)
    else paintRect(pending.from, pending.to, rgba, pending.tool === 'rect')
    endStroke()
    render()
  }

  function clipRect(rect) {
    var x0 = Math.max(0, rect.x)
    var y0 = Math.max(0, rect.y)
    var x1 = Math.min(doc.width - 1, rect.x + rect.w - 1)
    var y1 = Math.min(doc.height - 1, rect.y + rect.h - 1)
    if (x1 < x0 || y1 < y0) return null
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
  }

  /**
   * Where the cursor is, and what is under it.
   *
   * The coordinate is the one every validator message is phrased in, so an
   * author can read "the first at 318, 200" and go there. The material beside
   * it is the palette's own label, because "0,0,0" says nothing about whether
   * the starting shovel can get through it.
   */
  function readout(cell) {
    if (!overlay) return
    var inside = cell.x >= 0 && cell.y >= 0 && cell.x < doc.width && cell.y < doc.height
    overlay._at.textContent = inside ? cell.x + ', ' + cell.y : ''
    if (!inside) { overlay._under.textContent = ''; return }
    var c = colourAt(active, cell.x, cell.y)
    if (!c) { overlay._under.textContent = ''; return }
    if (c[3] === 0) {
      overlay._under.textContent = active === 'terrain'
        ? tx('editor.underClear', 'see-through - the game reads this as sealed fog')
        : tx('editor.underEmpty', 'nothing here')
      return
    }
    var entry = palette ? palette.byRgb(c[0], c[1], c[2]) : null
    overlay._under.textContent = entry
      ? entry.label
      : c[0] + ',' + c[1] + ',' + c[2]
  }

  function typingIn(target) {
    if (!target) return false
    var tag = String(target.tagName || '').toUpperCase()
    return tag === 'INPUT' || tag === 'TEXTAREA' || target.className === 'name'
  }

  function onKey(ev) {
    if (!isOpen) return
    if (ev.key === 'Escape') {
      ev.preventDefault()
      // Innermost first, so a menu or a dialog is dismissed rather than the
      // whole editor closing out from under whatever was open on top of it.
      if (shapeOpen) { setShapeMenu(false); return }
      if (overlay && overlay._dialog) { closeDialog(); return }
      requestClose()
      return
    }
    // A name field is a text field; typing in it must not drive the editor.
    if (typingIn(ev.target)) return

    if (ev.ctrlKey || ev.metaKey) {
      var k = String(ev.key || '').toLowerCase()
      if (k === 'z' && ev.shiftKey) { ev.preventDefault(); stepForward(); return }
      if (k === 'z') { ev.preventDefault(); stepBack(); return }
      if (k === 'y') { ev.preventDefault(); stepForward(); return }
      return
    }

    var key = String(ev.key || '').toLowerCase()
    for (var i = 0; i < TOOLS.length; i++) {
      if (TOOLS[i].key === key) { ev.preventDefault(); setTool(TOOLS[i].id); return }
    }
    var slot = parseInt(key, 10)
    if (slot >= 1 && slot <= BRUSHES.length) {
      ev.preventDefault()
      brush = BRUSHES[slot - 1]
      refreshTools()
    }
  }

  // ---------------------------------------------------------- open / close
  /**
   * Said wherever a size is asked for or refused.
   *
   * A sentence rather than a silent clamp: an author who typed 100 and got 158
   * with no explanation learns nothing, and will type 100 again.
   */
  function minimumSentence() {
    return tx('editor.minSize',
      'The smallest map the game can start is ' + MIN_WIDTH + ' × ' + MIN_HEIGHT +
      ' cells - it drops the player at a fixed spot, half the width plus about 79 cells across ' +
      'and 200 cells down, and never moves it, so anything smaller starts them outside the world.',
      { width: MIN_WIDTH, height: MIN_HEIGHT })
  }

  function clampSize(value, fallback, minimum) {
    var n = Math.round(Number(value))
    if (!isFinite(n) || n <= 0) n = fallback
    return Math.max(minimum, Math.min(MAX_SIZE, n))
  }

  function reset(document_) {
    doc = document_
    undo.clear()
    redo.clear()
    active = 'terrain'
    for (var i = 0; i < LAYERS.length; i++) visible[LAYERS[i]] = true
    tool = 'brush'
    brush = 1
    panMode = false
    stroke = null
    band = null
    panning = null
    selection = null
    report = null
    escapeArmed = false
    shownDirty(null)
    ink = palette ? palette.DEFAULT_SOLID || null : null
    if (overlay) {
      overlay._issues.classList.toggle('open', false)
      clearChildren(overlay._issuesBody)
      overlay._under.textContent = ''
      overlay._at.textContent = ''
      closeDialog()
      setShapeMenu(false)
    }
    fitView()
    render()
    refreshTools()
  }

  /**
   * A blank document: five empty layers, and terrain painted with air.
   *
   * The five are transparent because that is what "nothing here yet" means in
   * a deny-list or a decoration. Terrain is not, and cannot be: a transparent
   * terrain pixel is Fog, so a blank map made of transparency would be a solid
   * block of the worst material in the game, which the validator would then
   * refuse to save. Air is what a map with nothing painted on it is.
   */
  function blankDoc(opts) {
    var width = clampSize(opts.width, DEFAULT_SIZE.width, MIN_WIDTH)
    var height = clampSize(opts.height, DEFAULT_SIZE.height, MIN_HEIGHT)
    var layers = Object.create(null)
    for (var i = 0; i < LAYERS.length; i++) layers[LAYERS[i]] = newCanvas(width, height)

    var air = rgbaOf(eraserEntry())
    if (air) {
      var ctx = ctxOf(layers.terrain)
      ctx.fillStyle = 'rgba(' + air[0] + ',' + air[1] + ',' + air[2] + ',1)'
      ctx.fillRect(0, 0, width, height)
    }

    return {
      id: null,
      name: typeof opts.name === 'string' && opts.name ? opts.name : tx('editor.untitled', 'Untitled map'),
      seed: typeof opts.seed === 'string' ? opts.seed : '',
      createdAt: null,
      width: width,
      height: height,
      layers: layers,
      dirty: false,
      raised: (Number(opts.width) > 0 && Math.round(Number(opts.width)) < MIN_WIDTH) ||
        (Number(opts.height) > 0 && Math.round(Number(opts.height)) < MIN_HEIGHT),
    }
  }

  /**
   * Open the editor.
   *
   * `open(id)` edits the map with that id; `open(null, {width, height, name})`
   * starts a new one. Returns a promise that settles when the document is on
   * screen, which is what the loading path makes necessary and what tests use.
   */
  function open(mapId, opts) {
    var options = opts || {}
    if (!overlay) build()
    onSaved = typeof options.onSaved === 'function' ? options.onSaved : null
    isOpen = true
    overlay.classList.toggle('open', true)
    say('')
    busy('')

    if (!mapId) {
      var blank = blankDoc(options)
      reset(blank)
      if (blank.raised) {
        say(tx('editor.sizeRaised',
          'Made ' + blank.width + ' × ' + blank.height + ' instead. ' + minimumSentence(),
          { width: blank.width, height: blank.height }), true)
      } else {
        say(openingNote())
      }
      return Promise.resolve(true)
    }

    var api = (global.electron && global.electron.customMaps) || null
    if (!api || typeof api.load !== 'function') {
      busy(tx('editor.noBridge', 'this build cannot load maps'))
      say(tx('editor.noBridge', 'this build cannot load maps'), true)
      return Promise.resolve(false)
    }

    doc = null
    hidePlate()
    busy(tx('editor.loading', 'Loading map...'))
    return Promise.resolve(api.load(mapId)).then(function (raw) {
      var terrain = raw && raw.terrain
      if (!terrain || !terrain.width || !terrain.height || !terrain.dataUrl) {
        throw new Error(tx('editor.noTerrain', 'this map has no terrain layer'))
      }
      var width = terrain.width
      var height = terrain.height
      var repaired = []
      return Promise.all(LAYERS.map(function (layer) {
        var l = raw[layer]
        if (!l || !l.dataUrl || !l.width || !l.height) {
          // The game refuses a map missing any of the six, so one that got
          // here is already broken; a blank stand-in makes it fixable rather
          // than unopenable, and saving writes all six back.
          repaired.push(layer)
          return Promise.resolve(newCanvas(width, height))
        }
        return decodeLayer(l)
      })).then(function (canvases) {
        var layers = Object.create(null)
        LAYERS.forEach(function (layer, i) { layers[layer] = canvases[i] })
        busy('')
        reset({
          id: String(raw.id || mapId),
          name: typeof raw.name === 'string' && raw.name ? raw.name : String(mapId),
          seed: typeof raw.seed === 'string' ? raw.seed : '',
          createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
          width: width,
          height: height,
          layers: layers,
          dirty: false,
        })
        say(repaired.length
          ? tx('editor.repaired', 'blank layers added for: ' + repaired.join(', '), { layers: repaired.join(', ') })
          : openingNote())
        return true
      })
    }).catch(function (e) {
      busy((e && e.message) || tx('editor.loadFailed', 'that map could not be opened'))
      say((e && e.message) || tx('editor.loadFailed', 'that map could not be opened'), true)
      return false
    })
  }

  /** Said on open: the one thing an author cannot see and has to know. */
  function openingNote() {
    return tx('editor.opening',
      'The marked cell is where the player appears - the game puts them there and nowhere else. ' +
      'Check map says what this one will do before anybody plays it.')
  }

  function close() {
    if (!overlay) return
    isOpen = false
    escapeArmed = false
    closeDialog()
    setShapeMenu(false)
    overlay.classList.toggle('open', false)
  }

  /** Escape twice to discard: unsaved pixels are the one thing here to lose. */
  function requestClose() {
    if (doc && doc.dirty && !escapeArmed) {
      escapeArmed = true
      say(tx('editor.confirmDiscard', 'Unsaved changes - close again to discard them.'), true)
      return
    }
    close()
  }

  // ----------------------------------------------------------------- save
  function saveMap(button_) {
    if (!doc) return Promise.resolve(false)
    if (!SMLN || typeof SMLN.callMain !== 'function') {
      say(tx('editor.noSaveBridge', 'saving needs the loader bridge'), true)
      return Promise.resolve(false)
    }

    // Checked on the way out, every time, whether or not the author ran it -
    // an error here is something that makes the map unplayable or unlistable,
    // and it is invisible until somebody tries to play it.
    var checked = runCheck(true)
    if (checked && checked.errors.length) {
      say(tx('editor.saveBlocked',
        'Not saved: ' + countText(checked.errors.length, 0) + ' ' +
        'Errors stop the map being saved; warnings do not.'), true)
      return Promise.resolve(false)
    }

    button_.disabled = true
    say(tx('editor.saving', 'Saving...'))

    // A save is a round trip through the main process, and the player can
    // open another map while it is in flight. The result belongs to the
    // document that was saved, so it is only applied if that is still the one
    // on screen.
    var target = doc
    var layers = {}
    try {
      for (var i = 0; i < LAYERS.length; i++) {
        var layer = LAYERS[i]
        layers[layer] = {
          width: doc.width,
          height: doc.height,
          dataUrl: doc.layers[layer].toDataURL('image/png'),
        }
      }
    } catch (e) {
      button_.disabled = false
      say((e && e.message) || 'the layers could not be encoded', true)
      return Promise.resolve(false)
    }

    var warnings = checked ? checked.warnings.length : 0
    return Promise.resolve(SMLN.callMain('saveCustomMap', {
      id: doc.id,
      name: doc.name,
      seed: doc.seed,
      params: { width: doc.width, height: doc.height },
      createdAt: doc.createdAt,
      layers: layers,
    })).then(function (r) {
      button_.disabled = false
      if (!r || !r.ok) {
        say((r && (r.reason || r.error)) || tx('editor.saveFailed', 'the save failed'), true)
        return false
      }
      // The id the main process settled on is the one the game will open, so
      // the next save edits this map rather than making a second one.
      target.id = r.id
      if (doc === target) {
        doc.dirty = false
        escapeArmed = false
      }
      say(tx('editor.saved', 'Saved as ' + r.file, { file: r.file }) +
        (warnings ? '  ' + countText(0, warnings) + ' ' +
          tx('editor.savedWithWarnings', 'Warnings do not stop it saving.') : ''))
      if (onSaved) { try { onSaved(r) } catch (_e) { /* the caller's problem, not the save's */ } }
      return true
    }, function (e) {
      button_.disabled = false
      say((e && e.message) || tx('editor.saveFailed', 'the save failed'), true)
      return false
    })
  }

  SMLN.mapEditor = {
    open: open,
    close: close,
    isOpen: function () { return isOpen },
    /**
     * What a new map may be, so the maps overlay's dialog can say the same
     * thing this file would rather than keeping its own copy of the numbers.
     */
    limits: function () {
      return {
        minWidth: MIN_WIDTH,
        minHeight: MIN_HEIGHT,
        maxSize: MAX_SIZE,
        defaultWidth: DEFAULT_SIZE.width,
        defaultHeight: DEFAULT_SIZE.height,
        reason: minimumSentence(),
      }
    },
  }

  function boot() {
    if (!document.body) { setTimeout(boot, 50); return }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', function () {
      if (!isOpen || !doc) return
      render()
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})(typeof globalThis !== 'undefined' ? globalThis : window)
