/* eslint-env browser */
'use strict'
/**
 * Loader splash screen, in the game's own visual language.
 *
 * Shown the moment the runtime installs - before a single line of game code
 * runs - and taken down once the game has painted its own UI.
 *
 * Styling is not an imitation: the typeface is the game's own `Play`, loaded
 * straight from `dist/fonts/`, and the panel reuses the exact border, radius
 * and shadow values Sandustry uses for its dialogs (slate border at 68%
 * opacity, large radius on the top-right and bottom-left corners only, and the
 * `#ffe700` accent).
 *
 * It deliberately hooks no game internal to decide when to leave: it watches
 * `#ui` for content and keeps a wall-clock ceiling, so a game update cannot
 * strand the player behind an overlay that never lifts.
 */
;(function installSmlnSplash(global) {
  var SMLN = global.__SMLN__
  if (!SMLN || SMLN.splash) return

  var MAX_VISIBLE_MS = 20000
  var FADE_MS = 420

  var node = null
  var statusLine = null
  var done = false
  var timer = null
  var observer = null

  /**
   * The renderer reloads for every scene change - the game navigates to
   * `index.html?new_game` / `?db_load` - so without this the splash would
   * reappear every time a save is loaded. Only the bare initial load counts as
   * "starting the game".
   */
  function isInitialLoad() {
    try {
      var q = String(global.location && global.location.search || '')
      if (/new_game|db_load/.test(q)) return false
    } catch (_) { /* no location: treat as initial */ }
    try {
      if (global.sessionStorage) {
        if (global.sessionStorage.getItem('smln.splash.shown')) return false
        global.sessionStorage.setItem('smln.splash.shown', '1')
      }
    } catch (_) { /* storage unavailable: fall back to the query check alone */ }
    return true
  }

  var CSS = [
    // The game's UI face, served from its own asset folder. Relative to
    // index.html, which is what the document's base URL resolves against.
    "@font-face{font-family:'SMLN Play';src:url('fonts/Play-Regular.ttf') format('truetype');",
    'font-weight:400;font-style:normal;font-display:block}',
    "@font-face{font-family:'SMLN Play';src:url('fonts/Play-Bold.ttf') format('truetype');",
    'font-weight:700;font-style:normal;font-display:block}',

    '#smln-splash{position:fixed;inset:0;z-index:2147483600;display:flex;',
    'align-items:center;justify-content:center;',
    'background:radial-gradient(ellipse at 50% 45%,#0d1520 0%,#04070a 72%);',
    "font-family:'SMLN Play',system-ui,sans-serif;color:#e2e8f0;",
    'transition:opacity ' + FADE_MS + 'ms ease-out;user-select:none}',
    '#smln-splash.gone{opacity:0;pointer-events:none}',

    // Sandustry dialog panel: slate border, rounded top-right + bottom-left.
    '#smln-splash .panel{min-width:340px;padding:30px 40px 26px;text-align:center;',
    'background:rgba(8,12,17,.92);border:1px solid rgba(100,116,139,.68);',
    'border-radius:0 8px 0 8px;box-shadow:0 4px 12px rgba(0,0,0,.28)}',

    '#smln-splash .mark{font-size:30px;font-weight:700;letter-spacing:.16em;',
    'text-transform:uppercase;color:#ffe700;margin-bottom:6px}',
    '#smln-splash .sub{font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:#94a3b8}',

    '#smln-splash .bar{margin:22px auto 14px;width:240px;height:3px;',
    'background:rgba(255,231,0,.14);overflow:hidden}',
    '#smln-splash .bar i{display:block;height:100%;width:34%;background:#ffe700;',
    'animation:smln-sweep 1.15s ease-in-out infinite}',
    '@keyframes smln-sweep{0%{transform:translateX(-110%)}100%{transform:translateX(360%)}}',

    '#smln-splash .status{font-size:13px;color:#94a3b8;min-height:1.5em}',
  ].join('')

  function build() {
    if (!document.body || node) return

    var style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)

    node = document.createElement('div')
    node.id = 'smln-splash'

    var panel = document.createElement('div')
    panel.className = 'panel'

    var mark = document.createElement('div')
    mark.className = 'mark'
    mark.textContent = 'SandLoader'

    var sub = document.createElement('div')
    sub.className = 'sub'
    sub.textContent = 'mod loader  v' + SMLN.version

    var bar = document.createElement('div')
    bar.className = 'bar'
    bar.appendChild(document.createElement('i'))

    statusLine = document.createElement('div')
    statusLine.className = 'status'
    statusLine.textContent = 'preparing'

    panel.appendChild(mark)
    panel.appendChild(sub)
    panel.appendChild(bar)
    panel.appendChild(statusLine)
    node.appendChild(panel)
    document.body.appendChild(node)

    describeMods()
    watchForGameUI()
    timer = setTimeout(function () { hide('timeout') }, MAX_VISIBLE_MS)
  }

  function describeMods() {
    var mods = global.__SMLN_MODS__ || []
    if (!mods.length) { status('no mods installed'); return }
    var smln = mods.filter(function (m) { return m.flavour !== 'fluxloader' }).length
    var flux = mods.length - smln
    var parts = []
    if (smln) parts.push(smln + ' mod' + (smln === 1 ? '' : 's'))
    if (flux) parts.push(flux + ' fluxloader mod' + (flux === 1 ? '' : 's'))
    status('loaded ' + parts.join(' + '))
  }

  function status(text) {
    if (statusLine) statusLine.textContent = text
  }

  /** Leave as soon as the game has rendered something into its UI root. */
  function watchForGameUI() {
    var root = document.getElementById('ui')
    if (!root) {
      setTimeout(function () { if (!done) hide('no-ui-root') }, 6000)
      return
    }
    if (root.childNodes.length) { hide('ui-present'); return }
    if (typeof MutationObserver !== 'function') {
      setTimeout(function () { hide('no-observer') }, 5000)
      return
    }
    observer = new MutationObserver(function () {
      if (root.childNodes.length) hide('ui-rendered')
    })
    observer.observe(root, { childList: true, subtree: false })
  }

  function hide(reason) {
    if (done) return
    done = true
    if (timer) { clearTimeout(timer); timer = null }
    if (observer) { observer.disconnect(); observer = null }
    SMLN.log('info', 'splash dismissed (' + reason + ')')
    if (!node) return
    node.classList.add('gone')
    setTimeout(function () {
      if (node && node.parentNode) node.parentNode.removeChild(node)
      node = null
    }, FADE_MS + 60)
  }

  SMLN.splash = {
    hide: hide,
    status: status,
    isVisible: function () { return !!node && !done },
    /** Forces the splash regardless of the initial-load check; for testing. */
    show: function () { done = false; build() },
  }

  if (!isInitialLoad()) {
    SMLN.log('info', 'splash skipped (scene reload, not a fresh start)')
    done = true
    return
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build)
  else build()
})(typeof globalThis !== 'undefined' ? globalThis : window)
