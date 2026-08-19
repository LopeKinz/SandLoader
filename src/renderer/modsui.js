/* eslint-env browser */
'use strict'
/**
 * Main-menu integration: renames the game's "Mods" entry to "SandLoader Mods"
 * and opens SandLoader's own mod manager instead of the Workshop browser.
 *
 * Opening is driven by the `smln:mods-menu-open` bundle patch, which reroutes
 * the `modsScreen.open` assignment. A DOM hook was tried first and does not
 * work: `id:"main-menu-mods"` in the bundle is a React *prop* on a custom
 * component, not a DOM attribute, and the component never forwards it. The DOM
 * path below is kept only as a fallback for a future build where it might.
 *
 * Installing, removing and revealing mods all happen in the main process; this
 * file only asks. Mods are loaded once at startup and their patches applied
 * then, so every change here takes effect on the next launch and the UI says so
 * rather than pretending to hot-swap.
 */
;(function installSmlnModsUI(global) {
  var SMLN = global.__SMLN__
  if (!SMLN || SMLN.modsUI) return

  var MENU_ID = 'main-menu-mods'
  var LABEL = 'SandLoader Mods'

  var overlay = null
  var open = false
  /** id -> enabled, mirrored from the main process and edited here. */
  var enabledState = Object.create(null)

  function mods() { return global.__SMLN_MODS__ || [] }

  mods().forEach(function (m) { enabledState[m.id] = m.enabled !== false })

  // ------------------------------------------------------------------- RPC
  /**
   * The game's preload exposes no general IPC, and we cannot modify it. It does
   * expose a fire-and-forget logging bridge, so SMLN listens on that same
   * channel in the main process for a reserved scope. One-way by nature, which
   * is all a "remember this toggle" needs.
   */
  function rpc(action, payload) {
    return SMLN.callMain(action, payload)
  }

  // -------------------------------------------------------------------- CSS
  /*
   * Matches the game's dialog language: its own `Play` typeface from
   * dist/fonts, a slate border at 68% opacity, the large radius on top-right
   * and bottom-left corners only, and #ffe700 as the accent.
   */
  var CSS = [
    "@font-face{font-family:'SMLN Play';src:url('fonts/Play-Regular.ttf') format('truetype');",
    'font-weight:400;font-display:block}',
    "@font-face{font-family:'SMLN Play';src:url('fonts/Play-Bold.ttf') format('truetype');",
    'font-weight:700;font-display:block}',

    '#smln-mods{position:fixed;inset:0;z-index:2147483400;display:none;',
    'align-items:center;justify-content:center;background:rgba(3,6,10,.72);',
    "font-family:'SMLN Play',system-ui,sans-serif;font-size:14px;line-height:1.55;color:#e2e8f0}",
    '#smln-mods.open{display:flex}',

    '#smln-mods .panel{width:min(760px,92vw);max-height:82vh;display:flex;flex-direction:column;',
    'background:rgba(8,12,17,.97);border:1px solid rgba(100,116,139,.68);',
    'border-radius:0 8px 0 8px;box-shadow:0 4px 12px rgba(0,0,0,.28)}',

    '#smln-mods header{display:flex;align-items:baseline;justify-content:space-between;',
    'padding:18px 22px;border-bottom:1px solid rgba(100,116,139,.34)}',
    '#smln-mods h2{margin:0;font-size:17px;font-weight:700;letter-spacing:.14em;',
    'text-transform:uppercase;color:#ffe700}',
    '#smln-mods .count{color:#94a3b8;font-size:12px}',

    '#smln-mods .list{overflow-y:auto;padding:4px 0}',
    '#smln-mods .row{display:flex;align-items:center;gap:14px;padding:12px 22px;',
    'border-bottom:1px solid rgba(100,116,139,.18)}',
    '#smln-mods .row:last-child{border-bottom:0}',
    '#smln-mods .meta{flex:1;min-width:0}',
    '#smln-mods .nm{color:#f1f5f9}',
    '#smln-mods .id{color:#64748b;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

    '#smln-mods .tag{font-size:10px;letter-spacing:.12em;text-transform:uppercase;padding:3px 8px;',
    'border:1px solid rgba(100,116,139,.55);color:#94a3b8;border-radius:0 4px 0 4px}',
    '#smln-mods .tag.flux{border-color:rgba(122,162,255,.5);color:#7aa2ff}',

    '#smln-mods .toggle{cursor:pointer;border:1px solid rgba(255,231,0,.45);background:rgba(255,231,0,.05);',
    'color:#ffe700;font:inherit;font-size:12px;padding:6px 14px;border-radius:0 4px 0 4px;min-width:92px}',
    '#smln-mods .toggle:hover{background:rgba(255,231,0,.12)}',
    '#smln-mods .toggle.off{border-color:rgba(100,116,139,.45);color:#94a3b8;background:transparent}',

    '#smln-mods .empty{padding:36px 22px;text-align:center;color:#64748b}',
    '#smln-mods footer{padding:14px 22px;border-top:1px solid rgba(100,116,139,.34);',
    'display:flex;justify-content:space-between;align-items:center;gap:16px}',
    '#smln-mods .note{color:#64748b;font-size:12px}',
    '#smln-mods .note.warn{color:#ffe700}',
    '#smln-mods .close{cursor:pointer;border:1px solid rgba(100,116,139,.68);background:transparent;',
    'color:#e2e8f0;font:inherit;padding:7px 20px;border-radius:0 4px 0 4px}',
    '#smln-mods .close:hover{background:rgba(148,163,184,.12)}',

    '#smln-mods .actions{display:flex;gap:9px;align-items:center}',
    '#smln-mods .act{cursor:pointer;border:1px solid rgba(100,116,139,.68);background:transparent;',
    'color:#e2e8f0;font:inherit;font-size:12px;padding:6px 14px;border-radius:0 4px 0 4px}',
    '#smln-mods .act:hover{background:rgba(148,163,184,.12)}',
    '#smln-mods .act[disabled]{opacity:.45;cursor:default}',
    '#smln-mods .act.primary{border-color:rgba(255,231,0,.45);color:#ffe700;background:rgba(255,231,0,.05)}',
    '#smln-mods .act.primary:hover{background:rgba(255,231,0,.12)}',
    '#smln-mods .del{cursor:pointer;border:1px solid rgba(248,113,113,.4);background:transparent;',
    'color:#f87171;font:inherit;font-size:12px;padding:6px 11px;border-radius:0 4px 0 4px}',
    '#smln-mods .del:hover{background:rgba(248,113,113,.12)}',
    '#smln-mods .del.confirm{background:rgba(248,113,113,.18);border-color:#f87171}',
    '#smln-mods .status{font-size:12px;color:#94a3b8;padding:0 22px 10px;min-height:1.4em}',
    '#smln-mods .status.err{color:#f87171}',
    '#smln-mods .status.good{color:#4ade80}',
  ].join('')

  // --------------------------------------------------------------- overlay
  function build() {
    var style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)

    overlay = document.createElement('div')
    overlay.id = 'smln-mods'

    var panel = document.createElement('div')
    panel.className = 'panel'

    var header = document.createElement('header')
    var h2 = document.createElement('h2')
    h2.textContent = 'SandLoader Mods'
    var count = document.createElement('span')
    count.className = 'count'
    header.appendChild(h2)
    header.appendChild(count)

    var list = document.createElement('div')
    list.className = 'list'

    var status = document.createElement('div')
    status.className = 'status'

    var footer = document.createElement('footer')
    var note = document.createElement('span')
    note.className = 'note'

    var actions = document.createElement('div')
    actions.className = 'actions'

    var install = document.createElement('button')
    install.className = 'act primary'
    install.textContent = 'Install from ZIP'
    install.addEventListener('click', function () { doInstall(install) })

    var openDir = document.createElement('button')
    openDir.className = 'act'
    openDir.textContent = 'Open folder'
    openDir.addEventListener('click', function () { doOpenFolder(openDir) })

    var close = document.createElement('button')
    close.className = 'close'
    close.textContent = 'Close'
    close.addEventListener('click', function () { toggle(false) })

    actions.appendChild(install)
    actions.appendChild(openDir)
    actions.appendChild(close)
    footer.appendChild(note)
    footer.appendChild(actions)

    panel.appendChild(header)
    panel.appendChild(list)
    panel.appendChild(status)
    panel.appendChild(footer)
    overlay.appendChild(panel)
    document.body.appendChild(overlay)

    // Clicking the backdrop closes; clicking the panel must not.
    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) toggle(false)
    })

    overlay._list = list
    overlay._count = count
    overlay._note = note
    overlay._status = status
    overlay._install = install
    overlay._open = openDir
    render()
  }

  function say(text, kind) {
    if (!overlay || !overlay._status) return
    overlay._status.className = 'status' + (kind ? ' ' + kind : '')
    overlay._status.textContent = text || ''
  }

  /** Disable a button while its action is in flight, then restore it. */
  function busy(button, label, fn) {
    var original = button.textContent
    button.textContent = label
    if (button.setAttribute) button.setAttribute('disabled', 'true')
    // Start the request synchronously: deferring it into a microtask bought
    // nothing and made the click handler return before anything was sent.
    var pending
    try { pending = Promise.resolve(fn()) } catch (e) {
      pending = Promise.resolve({ ok: false, error: e && e.message })
    }
    return pending
      .then(null, function (e) { return { ok: false, error: e && e.message } })
      .then(function (result) {
        button.textContent = original
        if (button.removeAttribute) button.removeAttribute('disabled')
        return result
      })
  }

  function doInstall(button) {
    say('choose a .zip archive ...')
    return busy(button, 'Installing...', function () { return rpc('installMod', {}) })
      .then(function (r) {
        if (r && r.cancelled) { say(''); return }
        if (!r || !r.ok) { say('install failed: ' + ((r && r.error) || 'unknown error'), 'err'); return }
        say((r.replaced ? 'replaced ' : 'installed ') + r.id + '@' + r.version +
          '  -  restart the game to load it', 'good')
        // Mods are loaded once at startup, so show it as pending rather than
        // pretending it is already active.
        var mods = global.__SMLN_MODS__ || (global.__SMLN_MODS__ = [])
        if (!mods.some(function (m) { return m.id === r.id })) {
          mods.push({
            id: r.id, name: r.id, version: r.version, flavour: r.flavour,
            enabled: true, dir: r.dir, pending: true,
          })
        }
        enabledState[r.id] = true
        render()
      })
  }

  function doOpenFolder(button) {
    return busy(button, 'Opening...', function () { return rpc('openModsFolder', {}) })
      .then(function (r) {
        if (!r || !r.ok) say('could not open the folder: ' + ((r && r.error) || 'unknown error'), 'err')
        else say(r.dir)
      })
  }

  /** Two-step, because this deletes files from disk. */
  function doRemove(mod, button) {
    if (button._armed) {
      button._armed = false
      return busy(button, 'Removing...', function () { return rpc('removeMod', { dir: mod.dir }) })
        .then(function (r) {
          button.className = 'del'
          if (!r || !r.ok) {
            say('could not remove ' + mod.id + ': ' + ((r && r.error) || 'unknown error'), 'err')
            return
          }
          say('removed ' + mod.id + '  -  restart the game to unload it', 'good')
          var mods = global.__SMLN_MODS__ || []
          for (var i = 0; i < mods.length; i++) {
            if (mods[i].id === mod.id) { mods.splice(i, 1); break }
          }
          render()
        })
    }
    button._armed = true
    button.className = 'del confirm'
    button.textContent = 'Sure?'
    say('click again to delete ' + mod.id + ' from disk')
    setTimeout(function () {
      if (!button._armed) return
      button._armed = false
      button.className = 'del'
      button.textContent = 'Delete'
      say('')
    }, 4000)
    return Promise.resolve()
  }

  function render() {
    var list = overlay._list
    while (list.firstChild) list.removeChild(list.firstChild)

    var all = mods()
    overlay._count.textContent = all.length + ' installed'

    if (!all.length) {
      var empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = 'No mods installed. Use "Install from ZIP", or drop a mod folder into the mods directory.'
      list.appendChild(empty)
      overlay._note.textContent = ''
      return
    }

    all.forEach(function (m) { list.appendChild(rowFor(m)) })
    updateNote()
  }

  function rowFor(m) {
    var row = document.createElement('div')
    row.className = 'row'

    var meta = document.createElement('div')
    meta.className = 'meta'
    var nm = document.createElement('div')
    nm.className = 'nm'
    nm.textContent = (m.name || m.id) + '  ' + (m.version || '') + (m.pending ? '   (restart to load)' : '')
    var id = document.createElement('div')
    id.className = 'id'
    id.textContent = m.id + (m.dir ? '  -  ' + m.dir : '')
    meta.appendChild(nm)
    meta.appendChild(id)

    var tag = document.createElement('span')
    tag.className = 'tag' + (m.flavour === 'fluxloader' ? ' flux' : '')
    tag.textContent = m.flavour === 'fluxloader' ? 'Fluxloader' : 'SandLoader'

    var btn = document.createElement('button')
    btn.className = 'toggle'
    function paint() {
      var on = enabledState[m.id] !== false
      btn.textContent = on ? 'Enabled' : 'Disabled'
      btn.className = 'toggle' + (on ? '' : ' off')
    }
    paint()
    btn.addEventListener('click', function () {
      enabledState[m.id] = enabledState[m.id] === false
      paint()
      rpc('setModEnabled', { id: m.id, enabled: enabledState[m.id] })
      updateNote()
    })

    var del = document.createElement('button')
    del.className = 'del'
    del.textContent = 'Delete'
    del.addEventListener('click', function () { doRemove(m, del) })

    row.appendChild(meta)
    row.appendChild(tag)
    row.appendChild(btn)
    row.appendChild(del)
    return row
  }

  function updateNote() {
    var changed = mods().some(function (m) {
      return (m.enabled !== false) !== (enabledState[m.id] !== false)
    })
    overlay._note.className = changed ? 'note warn' : 'note'
    overlay._note.textContent = changed
      ? 'Changes apply the next time you start the game.'
      : 'Mods load at startup; toggling takes effect after a restart.'
  }

  function toggle(force) {
    if (!overlay) build()
    open = force == null ? !open : !!force
    overlay.classList.toggle('open', open)
    if (open) render()
  }

  function onKey(ev) {
    if (open && ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      toggle(false)
    }
  }

  // ------------------------------------------------------------- menu hook
  /** Deepest descendant carrying the visible label. */
  function labelNode(root) {
    var best = null
    ;(function walk(n) {
      var hasElementChild = false
      for (var i = 0; i < n.childNodes.length; i++) {
        var c = n.childNodes[i]
        if (c.nodeType === 1) { hasElementChild = true; walk(c) }
      }
      if (!hasElementChild && (n.textContent || '').trim() && !best) best = n
    })(root)
    return best
  }

  /**
   * Optional DOM fallback.
   *
   * The real interception is a bundle patch on `modsScreen.open`, which cannot
   * miss. This exists only for the case where that patch failed to apply on a
   * future build: the game renders the entry with `id:"main-menu-mods"` as a
   * React *prop*, and only becomes a DOM id if the component forwards it - it
   * does not today, so this normally finds nothing and costs nothing.
   */
  var hooked = false
  function hookMenu() {
    var entry = document.getElementById(MENU_ID)
    if (!entry) return false

    var label = labelNode(entry)
    if (label && label.textContent.trim() !== LABEL) label.textContent = LABEL

    if (!hooked) {
      hooked = true
      entry.addEventListener('click', function (ev) {
        ev.preventDefault()
        ev.stopPropagation()
        toggle(true)
      }, true)
      SMLN.log('info', 'main menu entry hooked via DOM fallback')
    }
    return true
  }

  function watchMenu() {
    if (hookMenu()) return
    if (typeof MutationObserver !== 'function') return
    var obs = new MutationObserver(function () { hookMenu() })
    var root = document.getElementById('ui') || document.body
    obs.observe(root, { childList: true, subtree: true })
    SMLN.modsUI._observer = obs
  }

  SMLN.modsUI = {
    toggle: toggle,
    isOpen: function () { return open },
    /** Exposed for the self-test. */
    _hookMenu: hookMenu,
    _state: enabledState,
  }

  /**
   * Read by the `smln:mods-menu-label` patch when the menu renders. Set here
   * rather than in the patch so the text lives with the UI that owns it, and
   * so the game falls back to its own translation if SMLN is absent.
   */
  SMLN.menuLabel = LABEL

  function boot() {
    if (!document.body) { setTimeout(boot, 50); return }
    build()
    window.addEventListener('keydown', onKey, true)
    watchMenu()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})(typeof globalThis !== 'undefined' ? globalThis : window)
