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
 * What is deliberately NOT here yet, because it is being established
 * separately and guessing it is how authors get shipped unplayable maps:
 * the colour palette (see THE PALETTE SEAM below), the spawn marker, and the
 * spawn-is-inside-rock validation. This file knows exactly one colour, and it
 * is not named after any material.
 *
 * A blank document is six fully transparent canvases, and that is known-safe
 * rather than assumed: the other five layers are deny-lists or decoration -
 * `authorization` zone 0 means everything permitted, and the shipped campaign
 * map itself loads with no `wall` at all - so there is nothing to validate
 * about their contents and nothing here does.
 */
;(function installSmlnMapEditor(global) {
  var SMLN = global.__SMLN__
  if (!SMLN || SMLN.mapEditor) return

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

  /*
   * ======================= THE PALETTE SEAM =============================
   *
   * `brushColour()` is the only thing in this file that knows a colour, and
   * it is the single point a palette module replaces. When the colour table
   * lands - each entry classified by what the player actually gets, derived
   * from the code that decides collision - it takes over this function and
   * the toolbar grows the picker that goes with it. Nothing else here needs
   * to change.
   *
   * Until then the brush paints ONE placeholder, and it is magenta on
   * purpose: the traditional missing-texture colour, so a map painted with it
   * reads as unfinished rather than as a considered choice. It is not stone,
   * it is not solid, it is not bedrock, and it is not anything else - naming
   * it would be the exact defect this seam exists to prevent. A test map from
   * before this split used two documented palette colours and came out hollow.
   * ======================================================================
   */
  var PLACEHOLDER_INK = [255, 0, 255, 255]
  function brushColour() {
    return PLACEHOLDER_INK
  }

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
  var MIN_SIZE = 8
  var MAX_SIZE = 16383
  var DEFAULT_SIZE = { width: 640, height: 400 }

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
  var undo = new UndoStack(UNDO_BUDGET)

  /** Where the map sits in the view canvas, and how big one cell is drawn. */
  var view = { zoom: 1, x: 0, y: 0 }
  var brush = 1
  var panMode = false

  /** In-flight interaction: a stroke being painted, or a drag panning. */
  var stroke = null
  var panning = null
  var escapeArmed = false

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

    // --- stage
    '#smln-mapedit .stage{flex:1;min-height:0;position:relative;overflow:hidden;',
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

    // --- footer
    '#smln-mapedit footer{flex:none;display:flex;align-items:center;gap:16px;',
    'padding:11px 22px;border-top:1px solid rgba(100,116,139,.34);background:rgba(2,6,10,.5)}',
    '#smln-mapedit footer .note{flex:1;min-width:0;color:#94a3b8;font-size:11.5px;overflow:hidden;',
    'text-overflow:ellipsis;white-space:nowrap}',
    '#smln-mapedit footer .note.err{color:#f87171}',
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
   * `willReadFrequently` because undo reads pixels back on every stroke, which
   * is exactly the access pattern that flag exists for.
   */
  function ctxOf(canvas) {
    var ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (ctx) ctx.imageSmoothingEnabled = false
    return ctx
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

    var stage = document.createElement('div')
    stage.className = 'stage'
    var canvas = document.createElement('canvas')
    canvas.className = 'view'
    stage.appendChild(canvas)
    var busy = document.createElement('div')
    busy.className = 'busy'
    stage.appendChild(busy)

    var footer = document.createElement('footer')
    var note = document.createElement('span')
    note.className = 'note'
    var at = document.createElement('span')
    at.className = 'at'
    var save = document.createElement('button')
    save.className = 'save'
    save.textContent = tx('editor.save', 'Save')
    save.addEventListener('click', function () { saveMap(save) })
    footer.appendChild(note)
    footer.appendChild(at)
    footer.appendChild(save)

    overlay.appendChild(header)
    overlay.appendChild(tools)
    overlay.appendChild(stage)
    overlay.appendChild(footer)
    document.body.appendChild(overlay)

    overlay._name = name
    overlay._dims = dims
    overlay._tools = tools
    overlay._stage = stage
    overlay._canvas = canvas
    overlay._busy = busy
    overlay._note = note
    overlay._at = at
    overlay._save = save

    buildTools(tools)
    bindStage(canvas)
  }

  /** The one row of controls: layers, then zoom, then the brush, then undo. */
  function buildTools(tools) {
    var layerBtns = Object.create(null)
    var eyeBtns = Object.create(null)

    var layerGroup = document.createElement('div')
    layerGroup.className = 'group'
    var lcap = document.createElement('span')
    lcap.className = 'cap'
    lcap.textContent = tx('editor.layers', 'Layer')
    layerGroup.appendChild(lcap)

    LAYERS.forEach(function (layer) {
      var pick = document.createElement('button')
      pick.textContent = tx('editor.layer.' + layer, LAYER_LABEL[layer])
      pick.addEventListener('click', function () { active = layer; refreshTools() })
      var eye = document.createElement('button')
      eye.className = 'eye'
      eye.setAttribute('aria-label', tx('editor.visibility', 'Show or hide this layer'))
      eye.addEventListener('click', function () {
        visible[layer] = !visible[layer]
        refreshTools()
        render()
      })
      layerGroup.appendChild(pick)
      layerGroup.appendChild(eye)
      layerBtns[layer] = pick
      eyeBtns[layer] = eye
    })

    var zoomGroup = document.createElement('div')
    zoomGroup.className = 'group'
    var zcap = document.createElement('span')
    zcap.className = 'cap'
    zcap.textContent = tx('editor.zoom', 'Zoom')
    var out = document.createElement('button')
    out.textContent = '-'
    out.addEventListener('click', function () { zoomBy(0.5) })
    var zoomVal = document.createElement('span')
    zoomVal.className = 'zoomval'
    var into = document.createElement('button')
    into.textContent = '+'
    into.addEventListener('click', function () { zoomBy(2) })
    var one = document.createElement('button')
    one.textContent = '1:1'
    one.addEventListener('click', function () { setZoom(1); centreView(); render(); refreshTools() })
    var fit = document.createElement('button')
    fit.textContent = tx('editor.fit', 'Fit')
    fit.addEventListener('click', function () { fitView(); render(); refreshTools() })
    zoomGroup.appendChild(zcap)
    zoomGroup.appendChild(out)
    zoomGroup.appendChild(zoomVal)
    zoomGroup.appendChild(into)
    zoomGroup.appendChild(one)
    zoomGroup.appendChild(fit)

    var brushGroup = document.createElement('div')
    brushGroup.className = 'group'
    var bcap = document.createElement('span')
    bcap.className = 'cap'
    bcap.textContent = tx('editor.brush', 'Brush')
    brushGroup.appendChild(bcap)
    var brushBtns = []
    ;[1, 2, 4, 8].forEach(function (size) {
      var b = document.createElement('button')
      b.textContent = String(size)
      b.addEventListener('click', function () { brush = size; refreshTools() })
      b._size = size
      brushGroup.appendChild(b)
      brushBtns.push(b)
    })

    var moveGroup = document.createElement('div')
    moveGroup.className = 'group'
    var pan = document.createElement('button')
    pan.textContent = tx('editor.pan', 'Pan')
    pan.addEventListener('click', function () { panMode = !panMode; refreshTools() })
    var undoBtn = document.createElement('button')
    undoBtn.textContent = tx('editor.undo', 'Undo')
    undoBtn.addEventListener('click', function () { undoOne() })
    moveGroup.appendChild(pan)
    moveGroup.appendChild(undoBtn)

    tools.appendChild(layerGroup)
    tools.appendChild(zoomGroup)
    tools.appendChild(brushGroup)
    tools.appendChild(moveGroup)

    overlay._layerBtns = layerBtns
    overlay._eyeBtns = eyeBtns
    overlay._brushBtns = brushBtns
    overlay._panBtn = pan
    overlay._undoBtn = undoBtn
    overlay._zoomVal = zoomVal
  }

  function refreshTools() {
    if (!overlay) return
    LAYERS.forEach(function (layer) {
      overlay._layerBtns[layer].classList.toggle('on', active === layer)
      var eye = overlay._eyeBtns[layer]
      eye.classList.toggle('off', !visible[layer])
      // A glyph, not only a colour, so the state is readable without it.
      eye.textContent = visible[layer] ? '◉' : '◌'
    })
    overlay._brushBtns.forEach(function (b) { b.classList.toggle('on', b._size === brush) })
    overlay._panBtn.classList.toggle('on', panMode)
    overlay._undoBtn.disabled = undo.depth() === 0
    overlay._zoomVal.textContent = Math.round(view.zoom * 100) + '%'
    overlay._canvas.classList.toggle('pan', panMode)
    overlay._dims.textContent = doc ? doc.width + '×' + doc.height : ''
    if (doc && overlay._name.value !== doc.name) overlay._name.value = doc.name
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
        stroke.tiles.push({ x: px, y: py, image: ctx.getImageData(px, py, w, h) })
      }
    }
  }

  function endStroke() {
    if (stroke && stroke.tiles.length) undo.push({ layer: stroke.layer, tiles: stroke.tiles })
    stroke = null
    refreshTools()
  }

  function paintDab(cx, cy) {
    if (!doc) return
    var half = Math.floor((brush - 1) / 2)
    var x0 = Math.max(0, cx - half)
    var y0 = Math.max(0, cy - half)
    var x1 = Math.min(doc.width - 1, cx - half + brush - 1)
    var y1 = Math.min(doc.height - 1, cy - half + brush - 1)
    if (x1 < x0 || y1 < y0) return

    captureBefore(x0, y0, x1, y1)
    var ctx = ctxOf(doc.layers[active])
    var c = brushColour()
    // A painted cell replaces what was there rather than blending with it: one
    // pixel is one piece of world, and the game reads a cell's colour, not a
    // composite of two.
    ctx.clearRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1)
    ctx.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (c[3] / 255) + ')'
    ctx.fillRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1)
    doc.dirty = true
  }

  /** Dabs along a segment, so a fast drag does not paint a dotted line. */
  function paintLine(x0, y0, x1, y1) {
    var steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
    if (!steps) { paintDab(x1, y1); return }
    for (var i = 0; i <= steps; i++) {
      paintDab(Math.round(x0 + ((x1 - x0) * i) / steps), Math.round(y0 + ((y1 - y0) * i) / steps))
    }
  }

  function undoOne() {
    var step = undo.pop()
    if (!step || !doc) { refreshTools(); return }
    var ctx = ctxOf(doc.layers[step.layer])
    for (var i = 0; i < step.tiles.length; i++) {
      ctx.putImageData(step.tiles[i].image, step.tiles[i].x, step.tiles[i].y)
    }
    doc.dirty = true
    render()
    refreshTools()
  }

  // ---------------------------------------------------------------- input
  function bindStage(canvas) {
    canvas.addEventListener('mousedown', function (ev) {
      if (!doc) return
      var pans = panMode || ev.button === 1 || ev.button === 2 || ev.shiftKey
      if (pans) {
        panning = { x: ev.clientX, y: ev.clientY, ox: view.x, oy: view.y }
      } else if (ev.button === 0 || ev.button == null) {
        var cell = cellAt(ev.clientX, ev.clientY)
        beginStroke(active)
        paintDab(cell.x, cell.y)
        stroke.last = cell
        render()
      }
      if (ev.preventDefault) ev.preventDefault()
    })

    canvas.addEventListener('mousemove', function (ev) {
      if (!doc) return
      var cell = cellAt(ev.clientX, ev.clientY)
      overlay._at.textContent = cell.x + ', ' + cell.y
      if (panning) {
        view.x = panning.ox + (ev.clientX - panning.x)
        view.y = panning.oy + (ev.clientY - panning.y)
        render()
      } else if (stroke) {
        paintLine(stroke.last.x, stroke.last.y, cell.x, cell.y)
        stroke.last = cell
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
    })
  }

  function onKey(ev) {
    if (!isOpen) return
    if (ev.key === 'Escape') {
      ev.preventDefault()
      requestClose()
      return
    }
    // A name field is a text field; typing in it must not drive the editor.
    if (ev.target && ev.target.className === 'name') return
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'z' || ev.key === 'Z')) {
      ev.preventDefault()
      undoOne()
    }
  }

  // ---------------------------------------------------------- open / close
  function clampSize(value, fallback) {
    var n = Math.round(Number(value))
    if (!isFinite(n) || n <= 0) n = fallback
    return Math.max(MIN_SIZE, Math.min(MAX_SIZE, n))
  }

  function reset(document_) {
    doc = document_
    undo.clear()
    active = 'terrain'
    for (var i = 0; i < LAYERS.length; i++) visible[LAYERS[i]] = true
    brush = 1
    panMode = false
    stroke = null
    panning = null
    escapeArmed = false
    fitView()
    render()
    refreshTools()
  }

  function blankDoc(opts) {
    var width = clampSize(opts.width, DEFAULT_SIZE.width)
    var height = clampSize(opts.height, DEFAULT_SIZE.height)
    var layers = Object.create(null)
    // A fresh canvas is fully transparent, which is what "nothing here yet"
    // means in all six layers.
    for (var i = 0; i < LAYERS.length; i++) layers[LAYERS[i]] = newCanvas(width, height)
    return {
      id: null,
      name: typeof opts.name === 'string' && opts.name ? opts.name : tx('editor.untitled', 'Untitled map'),
      seed: typeof opts.seed === 'string' ? opts.seed : '',
      createdAt: null,
      width: width,
      height: height,
      layers: layers,
      dirty: false,
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
      reset(blankDoc(options))
      say(placeholderNote())
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
          : placeholderNote())
        return true
      })
    }).catch(function (e) {
      busy((e && e.message) || tx('editor.loadFailed', 'that map could not be opened'))
      say((e && e.message) || tx('editor.loadFailed', 'that map could not be opened'), true)
      return false
    })
  }

  /** Said on open, because an author should not have to discover this. */
  function placeholderNote() {
    return tx('editor.placeholderInk',
      'Placeholder ink: the terrain palette is not wired up yet, so painted cells are not yet a material.')
  }

  function close() {
    if (!overlay) return
    isOpen = false
    escapeArmed = false
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
  function saveMap(button) {
    if (!doc) return
    if (!SMLN || typeof SMLN.callMain !== 'function') {
      say(tx('editor.noSaveBridge', 'saving needs the loader bridge'), true)
      return Promise.resolve(false)
    }
    button.disabled = true
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
      button.disabled = false
      say((e && e.message) || 'the layers could not be encoded', true)
      return Promise.resolve(false)
    }

    return Promise.resolve(SMLN.callMain('saveCustomMap', {
      id: doc.id,
      name: doc.name,
      seed: doc.seed,
      params: { width: doc.width, height: doc.height },
      createdAt: doc.createdAt,
      layers: layers,
    })).then(function (r) {
      button.disabled = false
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
      say(tx('editor.saved', 'Saved as ' + r.file, { file: r.file }))
      if (onSaved) { try { onSaved(r) } catch (_e) { /* the caller's problem, not the save's */ } }
      return true
    }, function (e) {
      button.disabled = false
      say((e && e.message) || tx('editor.saveFailed', 'the save failed'), true)
      return false
    })
  }

  SMLN.mapEditor = {
    open: open,
    close: close,
    isOpen: function () { return isOpen },
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
