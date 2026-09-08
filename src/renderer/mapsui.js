/* eslint-env browser */
'use strict'
/**
 * Main-menu integration: opens SandLoader's own map browser instead of the
 * game's built-in one when "Maps" is clicked.
 *
 * Routed by the `smln:maps-menu-open` bundle patch, exactly the way
 * `smln:mods-menu-open` routes the Mods button - see src/renderer/modsui.js
 * for the fuller rationale (a DOM hook cannot see this entry either, since the
 * game renders it from a React prop). The game's own custom-maps screen still
 * exists in this build but its own "load" action just shows a "coming soon"
 * panel, so this is not overriding something that already worked.
 *
 * Two things are worth knowing about the design:
 *
 *   - Listing is cheap, loading is not. `window.electron.customMaps.list()`
 *     reads only the metadata line each `.custommap` file starts with; the six
 *     PNG layers only come down through `.load(id)`, and a large world's are
 *     several megabytes apiece. So the list is fetched up front and a preview
 *     is fetched only for whichever map is selected, never for all of them.
 *   - A map's origin is read from its id, not carried as a separate flag.
 *     `src/mods/custom-maps.js` prefixes everything it writes with `smln.`,
 *     and nothing else may use that prefix, so the id alone says whether a row
 *     is a mod's map or the player's own.
 *
 * All text goes in with `textContent`. Map names and ids are player- and
 * mod-author-supplied and untrusted.
 */
;(function installSmlnMapsUI(global) {
  var SMLN = global.__SMLN__
  if (!SMLN || SMLN.mapsUI) return

  // Matches src/mods/custom-maps.js's PREFIX. Duplicated rather than shared
  // because this file ships as a standalone renderer script with no require()
  // - the two are kept in step by the fact that both are one short constant.
  var MOD_PREFIX = 'smln.'

  var overlay = null
  var open = false

  /** Listed maps, cheapest form: metadata only, no image data. */
  var entries = []
  var listError = null
  var selectedId = null

  /** id -> {status:'loading'|'ready'|'error', dataUrl?, error?}. Only ever holds entries for ids that were actually selected at least once. */
  var previews = Object.create(null)

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

  function mapsApi() {
    return (global.electron && global.electron.customMaps) || null
  }

  // -------------------------------------------------------------------- CSS
  /*
   * The design system is taken verbatim from modsui.js: near-black surfaces,
   * a slate hairline border, the asymmetric top-right/bottom-left radius, and
   * #ffe700 as the one accent colour. `SMLN Play` itself is declared by
   * splash.js, the first UI part to load - redeclaring the @font-face here
   * would just be a duplicate rule for the same font.
   */
  var CSS = [
    '#smln-maps{position:fixed;inset:0;z-index:2147483400;display:none;',
    'align-items:center;justify-content:center;background:rgba(3,6,10,.72);',
    "font-family:'SMLN Play',system-ui,sans-serif;font-size:14px;line-height:1.55;color:#e2e8f0}",
    '#smln-maps.open{display:flex}',

    // position:relative so the new-map prompt can cover the panel and only
    // the panel.
    '#smln-maps .panel{position:relative;width:min(1040px,95vw);max-height:86vh;display:flex;flex-direction:column;',
    'background:rgba(8,12,17,.97);border:1px solid rgba(100,116,139,.68);',
    'border-radius:0 8px 0 8px;box-shadow:0 4px 12px rgba(0,0,0,.28);overflow:hidden}',

    // --- masthead
    '#smln-maps header{display:flex;align-items:flex-end;justify-content:space-between;',
    'gap:16px;padding:20px 24px 14px;border-bottom:1px solid rgba(100,116,139,.34)}',
    '#smln-maps h2{margin:0;font-size:18px;font-weight:700;letter-spacing:.16em;',
    'text-transform:uppercase;color:#ffe700;line-height:1}',
    '#smln-maps .count{color:#94a3b8;font-size:11px;letter-spacing:.09em;',
    'text-transform:uppercase;padding-bottom:2px}',

    // --- body: a narrow list, then the selected map large.
    '#smln-maps .body{display:flex;flex:1;min-height:0}',

    '#smln-maps .list{width:260px;flex:none;overflow-y:auto;',
    'border-right:1px solid rgba(100,116,139,.34)}',
    '#smln-maps .list::-webkit-scrollbar{width:10px}',
    '#smln-maps .list::-webkit-scrollbar-track{background:transparent}',
    '#smln-maps .list::-webkit-scrollbar-thumb{background:rgba(100,116,139,.35);',
    'border-radius:5px;border:3px solid transparent;background-clip:content-box}',

    // A row's left edge carries its category - a mod's map or the player's
    // own - the same idea modsui.js uses for a mod's security tier: legible
    // from the margin, before a word of the name is read.
    '#smln-maps .row{display:flex;align-items:center;gap:10px;cursor:pointer;',
    'padding:11px 14px 11px 11px;border-bottom:1px solid rgba(100,116,139,.16);',
    'border-left:3px solid rgba(100,116,139,.32)}',
    '#smln-maps .row:last-child{border-bottom:0}',
    '#smln-maps .row:hover{background:rgba(148,163,184,.04)}',
    '#smln-maps .row.mod{border-left-color:rgba(122,162,255,.55)}',
    // Selected is never colour-only: the edge widens, a marker glyph appears,
    // and the name goes bold - three cues that survive being read in
    // grayscale, on top of the tint every hovered row already gets.
    '#smln-maps .row.selected{border-left-width:5px;background:rgba(255,231,0,.05)}',
    '#smln-maps .row .mark{width:0.9em;flex:none;color:#ffe700;font-size:11px}',
    '#smln-maps .row .text{flex:1;min-width:0}',
    '#smln-maps .row .nm{color:#f1f5f9;font-size:13px;overflow:hidden;',
    'text-overflow:ellipsis;white-space:nowrap}',
    '#smln-maps .row.selected .nm{font-weight:700}',
    '#smln-maps .row .sz{color:#64748b;font-size:11px;margin-top:1px}',
    '#smln-maps .row .tag{flex:none;font-size:9px;letter-spacing:.1em;text-transform:uppercase;',
    'padding:2px 6px;border:1px solid rgba(100,116,139,.55);color:#94a3b8;border-radius:0 4px 0 4px}',
    '#smln-maps .row.mod .tag{border-color:rgba(122,162,255,.5);color:#7aa2ff}',

    '#smln-maps .empty{padding:36px 18px;text-align:center;color:#64748b;line-height:1.7;font-size:12.5px}',

    // --- stage: the preview, then what it is, then the one thing to do.
    '#smln-maps .stage{flex:1;min-width:0;display:flex;flex-direction:column;',
    'padding:22px 26px;overflow-y:auto;gap:16px}',
    '#smln-maps .stage .placeholder{padding:40px 18px;text-align:center;color:#64748b}',

    '#smln-maps .canvas{position:relative;flex:none;height:min(46vh,380px);',
    'border:1px solid rgba(100,116,139,.4);border-radius:0 6px 0 6px;overflow:hidden;',
    'display:flex;flex-direction:column;align-items:center;justify-content:center;',
    // A subtle two-tone checkerboard so a fully transparent region - Fog, to
    // the game - reads as an absence of terrain rather than as black rock.
    'background-color:#0a0d11;background-image:',
    'linear-gradient(45deg,#151a21 25%,transparent 25%),',
    'linear-gradient(-45deg,#151a21 25%,transparent 25%),',
    'linear-gradient(45deg,transparent 75%,#151a21 75%),',
    'linear-gradient(-45deg,transparent 75%,#151a21 75%);',
    'background-size:16px 16px;background-position:0 0,0 8px,8px -8px,-8px 0}',
    '#smln-maps .canvas img{width:100%;height:100%;object-fit:contain;display:block;',
    // The signature move: this PNG is a literal one-pixel-per-cell
    // cross-section of the world, so smoothing it would blur cells together
    // instead of showing them.
    'image-rendering:pixelated}',
    '#smln-maps .canvas .note{color:#94a3b8;font-size:12.5px;text-align:center;padding:0 20px}',
    '#smln-maps .canvas .note.err{color:#f87171}',
    '#smln-maps .canvas .retry{margin-top:10px;cursor:pointer;border:1px solid rgba(100,116,139,.68);',
    'background:transparent;color:#e2e8f0;font:inherit;font-size:11.5px;padding:5px 12px;',
    'border-radius:0 4px 0 4px}',
    '#smln-maps .canvas .retry:hover{background:rgba(148,163,184,.12)}',

    '#smln-maps .details{flex:none}',
    '#smln-maps .details .nm{color:#f1f5f9;font-size:17px;overflow-wrap:anywhere}',
    '#smln-maps .details .line{color:#94a3b8;font-size:12.5px;margin-top:6px}',
    '#smln-maps .details .line .tag{font-size:9px;letter-spacing:.1em;text-transform:uppercase;',
    'padding:2px 6px;border:1px solid rgba(100,116,139,.55);color:#94a3b8;border-radius:0 4px 0 4px}',
    '#smln-maps .details .line .tag.mod{border-color:rgba(122,162,255,.5);color:#7aa2ff}',
    '#smln-maps .details .seed{color:#64748b;font-size:11.5px;margin-top:4px;',
    "font-family:'Cascadia Mono',Consolas,monospace}",
    '#smln-maps .details .date{color:#64748b;font-size:11px;margin-top:2px}',

    '#smln-maps .play{margin-top:14px;cursor:pointer;border:1px solid rgba(255,231,0,.45);',
    'background:rgba(255,231,0,.08);color:#ffe700;font:inherit;font-size:13px;',
    'letter-spacing:.06em;text-transform:uppercase;padding:10px 26px;',
    'border-radius:0 4px 0 4px;transition:background .12s ease-out}',
    '#smln-maps .play:hover{background:rgba(255,231,0,.16)}',
    '#smln-maps .play[disabled]{opacity:.4;cursor:default;background:transparent}',

    // Edit sits beside Play but is not the primary action on this screen, so
    // it carries the neutral border rather than the accent.
    '#smln-maps .edit{margin-top:14px;margin-left:10px;cursor:pointer;',
    'border:1px solid rgba(100,116,139,.68);background:transparent;color:#e2e8f0;',
    'font:inherit;font-size:13px;letter-spacing:.06em;text-transform:uppercase;',
    'padding:10px 22px;border-radius:0 4px 0 4px}',
    '#smln-maps .edit:hover{background:rgba(148,163,184,.12)}',

    // --- the new-map prompt: a card over the panel, so the list and the
    // preview stay where they were rather than being replaced by a form.
    '#smln-maps .prompt{position:absolute;inset:0;display:flex;align-items:center;',
    'justify-content:center;background:rgba(3,6,10,.8);z-index:1}',
    '#smln-maps .prompt .card{width:min(420px,90%);padding:22px 24px;',
    'background:rgba(8,12,17,.99);border:1px solid rgba(100,116,139,.68);',
    'border-radius:0 8px 0 8px}',
    '#smln-maps .prompt h3{margin:0 0 14px;font-size:13px;font-weight:700;letter-spacing:.14em;',
    'text-transform:uppercase;color:#ffe700}',
    '#smln-maps .prompt label{display:block;color:#94a3b8;font-size:11px;letter-spacing:.09em;',
    'text-transform:uppercase;margin:12px 0 4px}',
    '#smln-maps .prompt input{width:100%;box-sizing:border-box;background:rgba(2,6,10,.7);',
    'border:1px solid rgba(100,116,139,.5);color:#f1f5f9;font:inherit;font-size:13px;',
    'padding:7px 9px;border-radius:0 4px 0 4px}',
    '#smln-maps .prompt input:focus{outline:none;border-color:rgba(255,231,0,.45)}',
    '#smln-maps .prompt .pair{display:flex;gap:12px}',
    '#smln-maps .prompt .pair>div{flex:1}',
    '#smln-maps .prompt .hint{margin-top:12px;color:#94a3b8;font-size:11px;line-height:1.5}',
    '#smln-maps .prompt .hint.err{color:#f87171}',
    '#smln-maps .prompt .row{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}',

    '#smln-maps footer{padding:13px 24px;border-top:1px solid rgba(100,116,139,.34);',
    'background:rgba(2,6,10,.5);display:flex;justify-content:space-between;align-items:center;gap:16px}',
    '#smln-maps footer .note{color:#f87171;font-size:11.5px;flex:1;min-width:0}',
    '#smln-maps .close,#smln-maps .import{cursor:pointer;border:1px solid rgba(100,116,139,.68);background:transparent;',
    'color:#e2e8f0;font:inherit;font-size:12px;padding:7px 20px;border-radius:0 4px 0 4px}',
    '#smln-maps .close:hover,#smln-maps .import:hover{background:rgba(148,163,184,.12)}',
    '#smln-maps .import[disabled]{opacity:.45;cursor:default;background:transparent}',
  ].join('')

  // --------------------------------------------------------------- overlay
  function build() {
    var style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)

    overlay = document.createElement('div')
    overlay.id = 'smln-maps'

    var panel = document.createElement('div')
    panel.className = 'panel'

    var header = document.createElement('header')
    var h2 = document.createElement('h2')
    h2.textContent = tx('maps.title', 'Maps')
    var count = document.createElement('span')
    count.className = 'count'
    header.appendChild(h2)
    header.appendChild(count)

    var body = document.createElement('div')
    body.className = 'body'

    var list = document.createElement('div')
    list.className = 'list'

    var stage = document.createElement('div')
    stage.className = 'stage'

    body.appendChild(list)
    body.appendChild(stage)

    var footer = document.createElement('footer')
    var note = document.createElement('span')
    note.className = 'note'
    var close = document.createElement('button')
    close.className = 'close'
    close.textContent = tx('maps.close', 'Close')
    close.addEventListener('click', function () { toggle(false) })
    var importBtn = document.createElement('button')
    importBtn.className = 'import'
    importBtn.textContent = tx('maps.import', 'Import map...')
    importBtn.addEventListener('click', function () { importMaps(importBtn) })
    var newBtn = document.createElement('button')
    newBtn.className = 'import'
    newBtn.textContent = tx('maps.newMap', 'New map...')
    newBtn.addEventListener('click', function () { promptNewMap() })
    footer.appendChild(note)
    footer.appendChild(newBtn)
    footer.appendChild(importBtn)
    footer.appendChild(close)

    panel.appendChild(header)
    panel.appendChild(body)
    panel.appendChild(footer)
    overlay.appendChild(panel)
    document.body.appendChild(overlay)

    // Clicking the backdrop closes; clicking the panel must not.
    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) toggle(false)
    })

    overlay._count = count
    overlay._list = list
    overlay._stage = stage
    overlay._note = note
    overlay._panel = panel

    renderList()
    renderStage()
  }

  // ---------------------------------------------------------- the editor
  /** Is SandLoader's map editor installed and on screen right now? */
  function editorOpen() {
    var ed = SMLN.mapEditor
    return !!(ed && typeof ed.isOpen === 'function' && ed.isOpen())
  }

  /**
   * Hand a map to the editor, and refresh the list when it saves.
   *
   * The browser stays open underneath: the editor is a full-screen overlay
   * above it, so closing the editor puts the player back in the list they
   * came from rather than in the main menu.
   */
  function edit(mapId, opts) {
    var ed = SMLN.mapEditor
    if (!ed || typeof ed.open !== 'function') {
      say(tx('maps.noEditor', 'the map editor is not available in this build'))
      return
    }
    var options = opts || {}
    options.onSaved = function (r) {
      if (r && r.id) selectedId = r.id
      // The saved map may be new, or may have changed name or size; the cached
      // preview is of the old pixels either way.
      if (r && r.id) delete previews[r.id]
      loadList()
    }
    ed.open(mapId, options)
  }

  /**
   * What the editor says a new map may be.
   *
   * Asked for rather than written down here: the floor comes from the game's
   * fixed spawn point, which the editor derives from the validator's own
   * formula, and a second copy of the number in this file is a second thing to
   * be wrong. The fallback is only for a build where the editor is missing, in
   * which case nothing here can start one anyway.
   */
  function editorLimits() {
    var ed = SMLN.mapEditor
    var limits = ed && typeof ed.limits === 'function' ? ed.limits() : null
    return limits || { minWidth: 1, minHeight: 1, defaultWidth: 640, defaultHeight: 400, reason: '' }
  }

  /**
   * Ask for a size and a name, then start the editor on a blank map.
   *
   * The size cannot be changed later without deciding what happens to the
   * pixels already painted, so it is asked for once, up front, rather than
   * defaulted silently.
   *
   * A size under the floor is refused here, with the reason, rather than
   * quietly rounded up on the other side: an author who typed 100 and got 158
   * back with no explanation has learned nothing and will type 100 again.
   */
  function promptNewMap() {
    if (!overlay || overlay._prompt) return

    var wrap = document.createElement('div')
    wrap.className = 'prompt'
    var card = document.createElement('div')
    card.className = 'card'

    var h3 = document.createElement('h3')
    h3.textContent = tx('maps.newTitle', 'New map')
    card.appendChild(h3)

    function field(labelText, value, parent) {
      var label = document.createElement('label')
      label.textContent = labelText
      var input = document.createElement('input')
      input.type = 'text'
      input.value = value
      parent.appendChild(label)
      parent.appendChild(input)
      return input
    }

    var nameInput = field(tx('maps.newName', 'Name'), tx('maps.newNameDefault', 'Untitled map'), card)

    var pair = document.createElement('div')
    pair.className = 'pair'
    var wcell = document.createElement('div')
    var hcell = document.createElement('div')
    pair.appendChild(wcell)
    pair.appendChild(hcell)
    var limits = editorLimits()
    var widthInput = field(tx('maps.newWidth', 'Width (cells)'),
      String(limits.defaultWidth), wcell)
    var heightInput = field(tx('maps.newHeight', 'Height (cells)'),
      String(limits.defaultHeight), hcell)
    card.appendChild(pair)

    var hint = document.createElement('div')
    hint.className = 'hint'
    hint.textContent = limits.reason
    card.appendChild(hint)

    var row = document.createElement('div')
    row.className = 'row'
    var cancel = document.createElement('button')
    cancel.className = 'close'
    cancel.textContent = tx('maps.cancel', 'Cancel')
    cancel.addEventListener('click', function () { closePrompt() })
    var create = document.createElement('button')
    create.className = 'play'
    create.style.marginTop = '0'
    create.textContent = tx('maps.create', 'Create')
    create.addEventListener('click', function () {
      var w = parseInt(widthInput.value, 10)
      var h = parseInt(heightInput.value, 10)
      if (!(w >= limits.minWidth) || !(h >= limits.minHeight)) {
        hint.className = 'hint err'
        hint.textContent = tx('maps.newTooSmall',
          'At least ' + limits.minWidth + ' × ' + limits.minHeight + ' cells. ' + limits.reason,
          { width: limits.minWidth, height: limits.minHeight })
        return
      }
      closePrompt()
      edit(null, { width: w, height: h, name: nameInput.value })
    })
    row.appendChild(cancel)
    row.appendChild(create)
    card.appendChild(row)

    wrap.appendChild(card)
    overlay._panel.appendChild(wrap)
    overlay._prompt = wrap
    if (nameInput.focus) nameInput.focus()
  }

  function closePrompt() {
    if (!overlay || !overlay._prompt) return
    overlay._panel.removeChild(overlay._prompt)
    overlay._prompt = null
  }

  function say(text) {
    if (!overlay) return
    overlay._note.textContent = text || ''
  }

  // ------------------------------------------------------------- fetching
  /** Fired every time the browser opens, so a map saved since last time shows up. */
  function loadList() {
    var api = mapsApi()
    if (!api || typeof api.list !== 'function') {
      entries = []
      listError = tx('maps.noBridge', 'this build cannot list custom maps')
      say(listError)
      renderList()
      renderStage()
      return
    }
    return Promise.resolve(api.list()).then(function (result) {
      entries = Array.isArray(result) ? result : []
      listError = null
      say('')
      // Keep the current selection if it is still there; otherwise fall back
      // to the first map, so opening the browser always has something to show.
      if (!selectedId || !entries.some(function (m) { return m.id === selectedId })) {
        selectedId = entries.length ? entries[0].id : null
      }
      renderList()
      renderStage()
      if (selectedId) ensurePreview(selectedId)
    }, function (e) {
      entries = []
      listError = (e && e.message) || tx('maps.listFailed', 'failed to list maps')
      say(listError)
      renderList()
      renderStage()
    })
  }

  /**
   * Fetch the preview for one map, unless it is already cached or in flight.
   *
   * Only ever called with the map that is actually selected - never for the
   * whole list - because `load()` returns full-resolution PNGs for all six
   * layers and a large world's are megabytes. The cache is keyed by id, so a
   * slow load for a map the player has since clicked away from still lands
   * safely; it just fills in a preview nobody is looking at right now.
   */
  function ensurePreview(id) {
    var cached = previews[id]
    if (cached && cached.status !== 'error') return

    previews[id] = { status: 'loading' }
    if (id === selectedId) renderStage()

    var api = mapsApi()
    if (!api || typeof api.load !== 'function') {
      previews[id] = { status: 'error', error: tx('maps.noBridge', 'this build cannot load map previews') }
      if (id === selectedId) renderStage()
      return
    }

    Promise.resolve(api.load(id)).then(function (doc) {
      var terrain = doc && doc.terrain
      if (terrain && terrain.dataUrl) {
        previews[id] = { status: 'ready', dataUrl: terrain.dataUrl }
      } else {
        previews[id] = { status: 'error', error: tx('maps.noTerrain', 'this map has no terrain layer') }
      }
      if (id === selectedId) renderStage()
    }, function (e) {
      previews[id] = { status: 'error', error: (e && e.message) || tx('maps.previewFailed', 'failed to load') }
      if (id === selectedId) renderStage()
    })
  }

  function select(id) {
    if (id === selectedId) {
      // Clicking the current selection again is the retry gesture for a
      // preview that failed, rather than a dead click.
      var cached = previews[id]
      if (cached && cached.status === 'error') ensurePreview(id)
      return
    }
    selectedId = id
    renderList()
    renderStage()
    ensurePreview(id)
  }

  // ---------------------------------------------------------------- render
  function entryFor(id) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].id === id) return entries[i]
    }
    return null
  }

  function isFromMod(id) {
    return String(id || '').indexOf(MOD_PREFIX) === 0
  }

  function sizeText(m) {
    var w = m.params && m.params.width
    var h = m.params && m.params.height
    return (w && h) ? (w + '×' + h) : ''
  }

  function renderList() {
    if (!overlay) return
    var list = overlay._list
    while (list.firstChild) list.removeChild(list.firstChild)

    var countLabel = entries.length + (entries.length === 1 ? ' map' : ' maps')
    overlay._count.textContent = listError ? '' : tx('maps.count', countLabel, { count: entries.length })

    if (!entries.length) {
      var empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = listError ||
        tx('maps.empty', 'No custom maps yet. Save one from the pause menu, or install a map mod.')
      list.appendChild(empty)
      return
    }

    entries.forEach(function (m) {
      var fromMod = isFromMod(m.id)
      var selected = m.id === selectedId
      var row = document.createElement('div')
      row.className = 'row' + (fromMod ? ' mod' : '') + (selected ? ' selected' : '')
      if (selected) row.setAttribute('aria-selected', 'true')

      var mark = document.createElement('span')
      mark.className = 'mark'
      mark.textContent = selected ? '▸' : ''

      var text = document.createElement('div')
      text.className = 'text'
      var nm = document.createElement('div')
      nm.className = 'nm'
      nm.textContent = m.name || m.id
      nm.title = m.name || m.id
      var sz = document.createElement('div')
      sz.className = 'sz'
      sz.textContent = sizeText(m)
      text.appendChild(nm)
      text.appendChild(sz)

      var tag = document.createElement('span')
      tag.className = 'tag'
      tag.textContent = fromMod ? tx('maps.originMod', 'Mod') : tx('maps.originPlayer', 'Player')

      row.appendChild(mark)
      row.appendChild(text)
      row.appendChild(tag)
      row.addEventListener('click', function () { select(m.id) })
      list.appendChild(row)
    })
  }

  /** Everything to the right: the preview canvas, the details, and Play. */
  function renderStage() {
    if (!overlay) return
    var stage = overlay._stage
    while (stage.firstChild) stage.removeChild(stage.firstChild)

    if (!entries.length) {
      var none = document.createElement('div')
      none.className = 'placeholder'
      none.textContent = tx('maps.stageEmpty', 'Nothing to preview yet.')
      stage.appendChild(none)
      return
    }

    var m = entryFor(selectedId)
    if (!m) {
      var pick = document.createElement('div')
      pick.className = 'placeholder'
      pick.textContent = tx('maps.selectPrompt', 'Select a map to preview it.')
      stage.appendChild(pick)
      return
    }

    stage.appendChild(buildCanvas(m))
    stage.appendChild(buildDetails(m))
  }

  function buildCanvas(m) {
    var canvas = document.createElement('div')
    canvas.className = 'canvas'
    var state = previews[m.id]

    if (!state || state.status === 'loading') {
      var loading = document.createElement('div')
      loading.className = 'note'
      loading.textContent = tx('maps.previewLoading', 'Loading preview...')
      canvas.appendChild(loading)
      return canvas
    }

    if (state.status === 'error') {
      var err = document.createElement('div')
      err.className = 'note err'
      err.textContent = tx('maps.previewError', 'preview failed: ' + state.error, { error: state.error })
      canvas.appendChild(err)
      var retry = document.createElement('button')
      retry.className = 'retry'
      retry.textContent = tx('maps.retry', 'Retry')
      retry.addEventListener('click', function () { ensurePreview(m.id) })
      canvas.appendChild(retry)
      return canvas
    }

    var img = document.createElement('img')
    img.src = state.dataUrl
    img.alt = m.name || m.id
    canvas.appendChild(img)
    return canvas
  }

  function buildDetails(m) {
    var fromMod = isFromMod(m.id)
    var details = document.createElement('div')
    details.className = 'details'

    var nm = document.createElement('div')
    nm.className = 'nm'
    nm.textContent = m.name || m.id
    details.appendChild(nm)

    var line = document.createElement('div')
    line.className = 'line'
    var size = document.createElement('span')
    size.textContent = sizeText(m) ? sizeText(m) + '  ' : ''
    line.appendChild(size)
    var tag = document.createElement('span')
    tag.className = 'tag' + (fromMod ? ' mod' : '')
    tag.textContent = fromMod ? tx('maps.originMod', 'Mod') : tx('maps.originPlayer', 'Player')
    line.appendChild(tag)
    details.appendChild(line)

    // A blank field here would read as a bug rather than as "there isn't
    // one", so a missing seed gets its own worded placeholder instead.
    var seed = document.createElement('div')
    seed.className = 'seed'
    seed.textContent = m.seed
      ? tx('maps.seedValue', 'seed: ' + m.seed, { seed: m.seed })
      : tx('maps.seedNone', 'no seed')
    details.appendChild(seed)

    var date = document.createElement('div')
    date.className = 'date'
    date.textContent = formatDate(m.createdAt)
    details.appendChild(date)

    var play = document.createElement('button')
    play.className = 'play'
    play.textContent = tx('maps.play', 'Play')
    play.addEventListener('click', function () { playMap(m.id) })
    details.appendChild(play)

    var editBtn = document.createElement('button')
    editBtn.className = 'edit'
    editBtn.textContent = tx('maps.edit', 'Edit')
    editBtn.addEventListener('click', function () { edit(m.id) })
    details.appendChild(editBtn)

    return details
  }

  /** `createdAt` is an ISO string the game wrote; anything else is shown as-is rather than as "Invalid Date". */
  function formatDate(iso) {
    if (!iso) return ''
    var d = new Date(iso)
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString()
  }

  // ------------------------------------------------------------- starting
  /**
   * Hand off to the game's own navigation for `custom_map=<id>`.
   *
   * Traced through the shipped bundle rather than guessed: the button the
   * game's own (unfinished) map screen uses calls a small helper - a black
   * cover div, an awaited fade-out of the session's music, `history.replaceState`
   * onto the new query string, then a reload on the next two animation frames.
   * That helper is a bare local inside a webpack module and was never attached
   * to anything reachable from outside the bundle, so it cannot be called
   * directly; this reproduces the same steps rather than falling back to a
   * plain `location.reload()`, which would skip both the fade and the cover
   * and cut straight to the raw white flash of a page reload mid-track.
   */
  function playMap(id) {
    toggle(false)

    var doc = global.document
    var loc = global.location
    var hist = global.history
    var cover = doc && typeof doc.createElement === 'function' ? doc.createElement('div') : null
    if (cover && doc.body) {
      cover.style.position = 'fixed'
      cover.style.top = '0'
      cover.style.left = '0'
      cover.style.width = '100%'
      cover.style.height = '100%'
      cover.style.backgroundColor = '#000'
      cover.style.zIndex = '999999'
      cover.style.pointerEvents = 'none'
      doc.body.appendChild(cover)
    }

    var state = SMLN.state
    var fadeOut = state && state.session && state.session.music &&
      state.session.music.engine && typeof state.session.music.engine.fadeOut === 'function'
      ? state.session.music.engine.fadeOut(300)
      : null

    Promise.resolve(fadeOut).then(function () {
      if (!loc || !hist || typeof hist.replaceState !== 'function') return
      var base = loc.protocol + '//' + loc.host + loc.pathname
      hist.replaceState({}, '', base + '?custom_map=' + encodeURIComponent(id))
      var raf = typeof global.requestAnimationFrame === 'function'
        ? global.requestAnimationFrame
        : function (fn) { global.setTimeout(fn, 0) }
      raf(function () { raf(function () { loc.reload && loc.reload() }) })
    })
  }

/**
   * Take a `.custommap` from anywhere on disk into the folder the game reads.
   *
   * The picker and the copy both live in the main process: the renderer has no
   * file dialog, and `custom-map-save` would round-trip several megabytes of
   * data URL through IPC to write a file main can simply copy.
   */
  function importMaps(button) {
    if (!SMLN || typeof SMLN.callMain !== 'function') {
      say(tx('maps.importUnavailable', 'importing needs the loader bridge'))
      return
    }
    button.disabled = true
    Promise.resolve(SMLN.callMain('importCustomMap', {})).then(function (r) {
      if (!r || r.cancelled) return
      var failed = (r && r.failed) || []
      var imported = (r && r.imported) || []
      // The refresh clears the status line on its way through, so the outcome
      // is said after it lands - otherwise a refused file's reason appears and
      // is wiped a round-trip later, and the player never learns which file
      // was refused or why.
      var refreshed = Promise.resolve()
      if (imported.length) {
        // Show what just arrived rather than leaving the old selection in place.
        selectedId = imported[imported.length - 1].id
        refreshed = Promise.resolve(loadList())
      }
      return refreshed.then(function () {
        if (failed.length) {
          say(failed.length === 1
            ? failed[0].file + ': ' + failed[0].reason
            : tx('maps.importFailed', failed.length + ' file(s) could not be imported', { count: failed.length }))
        } else if (imported.length) {
          say(tx('maps.imported', imported.length + ' map(s) imported', { count: imported.length }))
        }
      })
    }).catch(function (e) {
      say((e && e.message) || 'the import failed')
    }).then(function () { button.disabled = false })
  }

  // --------------------------------------------------------------- toggle
  function toggle(force) {
    if (!overlay) build()
    open = force == null ? !open : !!force
    overlay.classList.toggle('open', open)
    if (open) loadList()
  }

  function onKey(ev) {
    if (!open || ev.key !== 'Escape') return
    // The editor covers this overlay and has its own Escape, which asks
    // before discarding unsaved pixels. Both handlers sit on window, and
    // stopPropagation does not stop a sibling listener on the same node, so
    // the browser would otherwise close the list out from under the editor.
    if (editorOpen()) return
    if (overlay && overlay._prompt) {
      ev.preventDefault()
      ev.stopPropagation()
      closePrompt()
      return
    }
    ev.preventDefault()
    ev.stopPropagation()
    toggle(false)
  }

  SMLN.mapsUI = {
    toggle: toggle,
    isOpen: function () { return open },
    render: function () { renderList(); renderStage() },
  }

  function boot() {
    if (!document.body) { setTimeout(boot, 50); return }
    build()
    window.addEventListener('keydown', onKey, true)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})(typeof globalThis !== 'undefined' ? globalThis : window)
