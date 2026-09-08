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
   */
  var CSS = [
    '#smln-mapedit{position:fixed;inset:0;z-index:2147483500;display:none;',
    'flex-direction:column;background:rgba(4,7,11,.98);',
    "font-family:'SMLN Play',system-ui,sans-serif;font-size:14px;line-height:1.55;color:#e2e8f0}",
    '#smln-mapedit.open{display:flex}',

    // --- masthead
    '#smln-mapedit header{display:flex;align-items:center;gap:16px;flex:none;',
    'padding:14px 22px;border-bottom:1px solid rgba(100,116,139,.34)}',
    '#smln-mapedit h2{margin:0;font-size:16px;font-weight:700;letter-spacing:.16em;',
    'text-transform:uppercase;color:#ffe700;line-height:1;flex:none}',
    '#smln-mapedit .name{flex:1;min-width:0;background:transparent;color:#f1f5f9;font:inherit;',
    'font-size:15px;border:1px solid transparent;border-radius:0 4px 0 4px;padding:5px 8px}',
    '#smln-mapedit .name:hover{border-color:rgba(100,116,139,.4)}',
    '#smln-mapedit .name:focus{outline:none;border-color:rgba(255,231,0,.45)}',
    '#smln-mapedit .dims{flex:none;color:#64748b;font-size:11px;letter-spacing:.09em;text-transform:uppercase}',

    // --- toolbar
    '#smln-mapedit .tools{display:flex;align-items:center;gap:18px;flex:none;flex-wrap:wrap;',
    'padding:10px 22px;border-bottom:1px solid rgba(100,116,139,.34);background:rgba(2,6,10,.5)}',
    '#smln-mapedit .group{display:flex;align-items:center;gap:6px}',
    '#smln-mapedit .group .cap{color:#64748b;font-size:10px;letter-spacing:.1em;',
    'text-transform:uppercase;margin-right:2px}',

    '#smln-mapedit button{cursor:pointer;border:1px solid rgba(100,116,139,.68);background:transparent;',
    'color:#e2e8f0;font:inherit;font-size:12px;padding:5px 12px;border-radius:0 4px 0 4px}',
    '#smln-mapedit button:hover{background:rgba(148,163,184,.12)}',
    '#smln-mapedit button[disabled]{opacity:.4;cursor:default;background:transparent}',
    // Selected is never colour-only: the border thickens on the left and the
    // label goes bold, so the current layer and tool survive being read in
    // grayscale.
    '#smln-mapedit button.on{border-color:rgba(255,231,0,.55);border-left-width:4px;',
    'background:rgba(255,231,0,.08);color:#ffe700;font-weight:700}',
    '#smln-mapedit .eye{padding:5px 7px;color:#94a3b8;min-width:26px}',
    '#smln-mapedit .eye.off{color:#475569}',
    '#smln-mapedit .zoomval{color:#94a3b8;font-size:11.5px;min-width:56px;text-align:center;',
    "font-family:'Cascadia Mono',Consolas,monospace}",

    // --- the working area: palette, stage, problems
    '#smln-mapedit .work{flex:1;min-height:0;display:flex;align-items:stretch}',

    // --- palette
    '#smln-mapedit .palette{flex:none;width:246px;display:flex;flex-direction:column;min-height:0;',
    'border-right:1px solid rgba(100,116,139,.34);background:rgba(2,6,10,.45)}',
    '#smln-mapedit .current{flex:none;display:flex;align-items:flex-start;gap:10px;padding:12px 14px;',
    'border-bottom:1px solid rgba(100,116,139,.28)}',
    '#smln-mapedit .current .chip{flex:none;width:34px;height:34px;border:1px solid rgba(226,232,240,.45);',
    'border-radius:0 4px 0 4px}',
    '#smln-mapedit .current .who{min-width:0;flex:1}',
    '#smln-mapedit .current .who b{display:block;font-size:12px;font-weight:700;color:#f1f5f9}',
    '#smln-mapedit .current .who span{display:block;color:#64748b;font-size:10.5px;',
    "font-family:'Cascadia Mono',Consolas,monospace;letter-spacing:.04em}",
    '#smln-mapedit .swatches{flex:1;min-height:0;overflow-y:auto;padding:4px 8px 12px}',
    '#smln-mapedit .kind{color:#94a3b8;font-size:10px;letter-spacing:.1em;text-transform:uppercase;',
    'margin:12px 6px 5px;padding-bottom:3px;border-bottom:1px solid rgba(100,116,139,.24)}',
    '#smln-mapedit .swatch{display:flex;align-items:center;gap:8px;width:100%;text-align:left;',
    'padding:3px 6px;font-size:11.5px;line-height:1.35;border-color:transparent}',
    '#smln-mapedit .swatch .chip{flex:none;width:15px;height:15px;',
    'border:1px solid rgba(226,232,240,.35)}',
    '#smln-mapedit .swatch .txt{min-width:0;flex:1}',
    '#smln-mapedit .paletteNote{padding:10px 14px;color:#f87171;font-size:11.5px}',
    '#smln-mapedit .layerHint{flex:none;padding:8px 14px;color:#94a3b8;font-size:11px;',
    'border-top:1px solid rgba(100,116,139,.28);display:none}',
    '#smln-mapedit .layerHint.on{display:block}',

    // --- stage
    '#smln-mapedit .stage{flex:1;min-width:0;min-height:0;position:relative;overflow:hidden;',
    // The same two-tone checkerboard the maps overlay uses, so a transparent
    // cell reads as an absence of world rather than as black rock.
    'background-color:#0a0d11;background-image:',
    'linear-gradient(45deg,#151a21 25%,transparent 25%),',
    'linear-gradient(-45deg,#151a21 25%,transparent 25%),',
    'linear-gradient(45deg,transparent 75%,#151a21 75%),',
    'linear-gradient(-45deg,transparent 75%,#151a21 75%);',
    'background-size:16px 16px;background-position:0 0,0 8px,8px -8px,-8px 0}',
    '#smln-mapedit .view{position:absolute;inset:0;display:block;cursor:crosshair;',
    // Belt and braces with ctx.imageSmoothingEnabled=false: this one covers
    // the browser scaling the canvas element itself on a HiDPI display.
    'image-rendering:pixelated}',
    '#smln-mapedit .view.pan{cursor:grab}',
    '#smln-mapedit .busy{position:absolute;inset:0;display:flex;align-items:center;',
    'justify-content:center;color:#94a3b8;font-size:13px;text-align:center;padding:0 30px}',

    // --- problems
    '#smln-mapedit .issues{flex:none;width:320px;display:none;flex-direction:column;min-height:0;',
    'border-left:1px solid rgba(100,116,139,.34);background:rgba(2,6,10,.55)}',
    '#smln-mapedit .issues.open{display:flex}',
    '#smln-mapedit .issues .top{flex:none;display:flex;align-items:center;gap:10px;padding:11px 14px;',
    'border-bottom:1px solid rgba(100,116,139,.28)}',
    '#smln-mapedit .issues .top b{flex:1;font-size:11px;font-weight:700;letter-spacing:.14em;',
    'text-transform:uppercase;color:#e2e8f0}',
    '#smln-mapedit .issues .body{flex:1;min-height:0;overflow-y:auto;padding:4px 12px 16px}',
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
    'justify-content:center;background:rgba(4,7,11,.75);z-index:5}',
    '#smln-mapedit .dialog .card{width:min(380px,90%);padding:20px 22px;background:#080c11;',
    'border:1px solid rgba(100,116,139,.5);border-radius:0 8px 0 8px}',
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
    '#smln-mapedit .dialog .row{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}',
    '#smln-mapedit .anchors{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;max-width:150px}',
    '#smln-mapedit .anchors button{padding:8px 0;font-size:11px}',

    // --- footer
    '#smln-mapedit footer{flex:none;display:flex;align-items:center;gap:16px;',
    'padding:11px 22px;border-top:1px solid rgba(100,116,139,.34);background:rgba(2,6,10,.5)}',
    '#smln-mapedit footer .note{flex:1;min-width:0;color:#94a3b8;font-size:11.5px;overflow:hidden;',
    'text-overflow:ellipsis;white-space:nowrap}',
    '#smln-mapedit footer .note.err{color:#f87171}',
    '#smln-mapedit footer .under{flex:none;color:#94a3b8;font-size:11px;max-width:280px;',
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#smln-mapedit footer .at{flex:none;color:#64748b;font-size:11px;',
    "font-family:'Cascadia Mono',Consolas,monospace;min-width:96px;text-align:right}",
    '#smln-mapedit .save{border-color:rgba(255,231,0,.45);background:rgba(255,231,0,.08);',
    'color:#ffe700;letter-spacing:.06em;text-transform:uppercase;padding:7px 22px}',
    '#smln-mapedit .save:hover{background:rgba(255,231,0,.16)}',
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
    paletteSide.className = 'palette'

    var stage = document.createElement('div')
    stage.className = 'stage'
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

  /** A labelled row of buttons. */
  function group(parent, caption) {
    var g = document.createElement('div')
    g.className = 'group'
    if (caption) {
      var cap = document.createElement('span')
      cap.className = 'cap'
      cap.textContent = caption
      g.appendChild(cap)
    }
    parent.appendChild(g)
    return g
  }

  function button(parent, text, title, onClick) {
    var b = document.createElement('button')
    b.textContent = text
    if (title) b.setAttribute('title', title)
    b.addEventListener('click', onClick)
    parent.appendChild(b)
    return b
  }

  /** The toolbar: tools, brush, layers, zoom, transforms, history, checking. */
  function buildTools(tools) {
    var toolBtns = Object.create(null)
    var toolGroup = group(tools, tx('editor.tool', 'Tool'))
    TOOLS.forEach(function (spec) {
      var b = button(toolGroup, tx('editor.tool.' + spec.id, spec.label),
        tx('editor.tool.' + spec.id + '.key', spec.label + '  (' + spec.key.toUpperCase() + ')'),
        function () { setTool(spec.id) })
      toolBtns[spec.id] = b
    })

    var brushBtns = []
    var brushGroup = group(tools, tx('editor.brush', 'Brush'))
    BRUSHES.forEach(function (size, i) {
      var b = button(brushGroup, String(size),
        tx('editor.brushSize', size + ' cells across  (' + (i + 1) + ')', { size: size }),
        function () { brush = size; refreshTools() })
      b._size = size
      brushBtns.push(b)
    })

    var layerBtns = Object.create(null)
    var eyeBtns = Object.create(null)
    var layerGroup = group(tools, tx('editor.layers', 'Layer'))
    LAYERS.forEach(function (layer) {
      var pick = button(layerGroup, tx('editor.layer.' + layer, LAYER_LABEL[layer]), null,
        function () { setLayer(layer) })
      var eye = document.createElement('button')
      eye.className = 'eye'
      eye.setAttribute('aria-label', tx('editor.visibility', 'Show or hide this layer'))
      eye.addEventListener('click', function () {
        visible[layer] = !visible[layer]
        refreshTools()
        render()
      })
      layerGroup.appendChild(eye)
      layerBtns[layer] = pick
      eyeBtns[layer] = eye
    })

    var zoomGroup = group(tools, tx('editor.zoom', 'Zoom'))
    button(zoomGroup, '-', null, function () { zoomBy(0.5) })
    var zoomVal = document.createElement('span')
    zoomVal.className = 'zoomval'
    zoomGroup.appendChild(zoomVal)
    button(zoomGroup, '+', null, function () { zoomBy(2) })
    button(zoomGroup, '1:1', null, function () { setZoom(1); centreView(); render(); refreshTools() })
    button(zoomGroup, tx('editor.fit', 'Fit'), null, function () { fitView(); render(); refreshTools() })

    var shapeGroup = group(tools, tx('editor.shape', 'Shape'))
    button(shapeGroup, tx('editor.resize', 'Resize...'),
      tx('editor.resizeTip', 'Change the map size, keeping what is painted anchored somewhere in it'),
      function () { openResize() })
    var cropBtn = button(shapeGroup, tx('editor.crop', 'Crop'),
      tx('editor.cropTip', 'Cut the map down to the selection'),
      function () { cropToSelection() })
    button(shapeGroup, tx('editor.mirrorX', 'Mirror ⇄'), null, function () { applyMirror('x') })
    button(shapeGroup, tx('editor.mirrorY', 'Mirror ⇅'), null, function () { applyMirror('y') })
    button(shapeGroup, tx('editor.shift', 'Shift...'),
      tx('editor.shiftTip', 'Move everything painted by a number of cells'),
      function () { openShift() })

    var histGroup = group(tools, tx('editor.history', 'History'))
    var panBtn = button(histGroup, tx('editor.pan', 'Pan'), null,
      function () { panMode = !panMode; refreshTools() })
    var undoBtn = button(histGroup, tx('editor.undo', 'Undo'),
      tx('editor.undoTip', 'Undo  (Ctrl+Z)'), function () { stepBack() })
    var redoBtn = button(histGroup, tx('editor.redo', 'Redo'),
      tx('editor.redoTip', 'Redo  (Ctrl+Y)'), function () { stepForward() })

    var checkGroup = group(tools, tx('editor.checkCap', 'Check'))
    var checkBtn = button(checkGroup, tx('editor.check', 'Check map'),
      tx('editor.checkTip', 'Read the map back and say what it will do to the player'),
      function () { runCheck(false) })

    overlay._toolBtns = toolBtns
    overlay._brushBtns = brushBtns
    overlay._layerBtns = layerBtns
    overlay._eyeBtns = eyeBtns
    overlay._panBtn = panBtn
    overlay._undoBtn = undoBtn
    overlay._redoBtn = redoBtn
    overlay._cropBtn = cropBtn
    overlay._checkBtn = checkBtn
    overlay._zoomVal = zoomVal
  }

  /**
   * The palette picker: the table's own groups, in the table's own order, with
   * the table's own labels.
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

    overlay._swatches = swatchBtns
    overlay._currentChip = chip
    overlay._currentLabel = label
    overlay._currentRgb = rgb
    overlay._layerHint = hint
  }

  function buildIssues(issues) {
    var top = document.createElement('div')
    top.className = 'top'
    var title = document.createElement('b')
    title.textContent = tx('editor.problems', 'What this map will do')
    top.appendChild(title)
    button(top, tx('editor.hide', 'Hide'), null, function () {
      issues.classList.toggle('open', false)
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
    TOOLS.forEach(function (spec) {
      overlay._toolBtns[spec.id].classList.toggle('on', tool === spec.id)
    })
    overlay._brushBtns.forEach(function (b) { b.classList.toggle('on', b._size === brush) })
    LAYERS.forEach(function (layer) {
      overlay._layerBtns[layer].classList.toggle('on', active === layer)
      var eye = overlay._eyeBtns[layer]
      eye.classList.toggle('off', !visible[layer])
      // A glyph, not only a colour, so the state is readable without it.
      eye.textContent = visible[layer] ? '◉' : '◌'
    })
    overlay._panBtn.classList.toggle('on', panMode)
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
    for (var i = 0; i < LAYERS.length; i++) {
      var layer = LAYERS[i]
      if (!visible[layer]) continue
      ctx.drawImage(doc.layers[layer], 0, 0, doc.width, doc.height, view.x, view.y, dw, dh)
    }

    // The world's edge, so an empty map is still a rectangle you can see.
    if (ctx.strokeRect) {
      ctx.strokeStyle = 'rgba(100,116,139,.6)'
      ctx.lineWidth = 1
      ctx.strokeRect(view.x - 0.5, view.y - 0.5, dw + 1, dh + 1)
    }

    drawSpawnMarker(ctx)
    drawSelection(ctx)
    drawBand(ctx)
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
      fitView()
    }
    for (var j = 0; j < step.tiles.length; j++) {
      var tile = step.tiles[j]
      ctxOf(doc.layers[tile.layer || step.layer]).putImageData(tile.image, tile.x, tile.y)
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

    dialogButtons(card, tx('editor.apply', 'Resize'), function () {
      var w = Math.round(Number(widthInput.value))
      var h = Math.round(Number(heightInput.value))
      if (!isFinite(w) || !isFinite(h) || w < MIN_WIDTH || h < MIN_HEIGHT ||
          w > MAX_SIZE || h > MAX_SIZE) {
        hint.textContent = tx('editor.resizeRefused',
          'Between ' + MIN_WIDTH + ' × ' + MIN_HEIGHT + ' and ' + MAX_SIZE + ' × ' + MAX_SIZE +
          ' cells. ' + minimumSentence())
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

    if (openPanel) overlay._issues.classList.toggle('open', true)
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
    ink = palette ? palette.DEFAULT_SOLID || null : null
    if (overlay) {
      overlay._issues.classList.toggle('open', false)
      clearChildren(overlay._issuesBody)
      overlay._under.textContent = ''
      overlay._at.textContent = ''
      closeDialog()
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
