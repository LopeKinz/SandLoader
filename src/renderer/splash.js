/* eslint-env browser */
'use strict'
/**
 * Loader splash: a boot report, in the game's own visual language.
 *
 * Shown the moment the runtime installs - before a single line of game code
 * runs - and taken down once the game has painted its own UI.
 *
 * It reports rather than spins. The old version said "loaded 3 mods" and
 * nothing else, which is exactly as informative as saying nothing: a mod that
 * failed to load and a mod that loaded and does nothing look identical from
 * there. This one lists every mod with its security class and state, every
 * patch target with how many hooks went into it, and every problem the loader
 * survived - the same information the log file carries, on screen, while the
 * player is already watching it.
 *
 * Data comes from two places:
 *   __SMLN_BOOT__      what the main process did, injected by the prelude
 *   live SMLN events   what happens in the page after that (capture, ready)
 *
 * Styling is not an imitation: the typeface is the game's own `Play`, loaded
 * straight from `dist/fonts/`, and the panel reuses the exact border, radius
 * and shadow values Sandustry uses for its dialogs (slate border at 68%
 * opacity, large radius on the top-right and bottom-left corners only, and the
 * `#ffe700` accent).
 *
 * It deliberately hooks no game internal to decide when to leave: it watches
 * `#ui` for content and keeps a wall-clock ceiling, so a game update cannot
 * strand the player behind an overlay that never lifts. When something did go
 * wrong it holds a moment longer, because a report nobody can read is not one.
 */
;(function installSmlnSplash(global) {
  var SMLN = global.__SMLN__
  if (!SMLN || SMLN.splash) return

  var MAX_VISIBLE_MS = 20000
  var HOLD_ON_ERROR_MS = 4000
  var FADE_MS = 420
  var STEP_MS = 90

  var node = null
  var els = {}
  var done = false
  var timer = null
  var observer = null
  var uiReady = false
  var queue = []
  var stepping = false

  function boot() { return global.__SMLN_BOOT__ || null }
  function probs() { return global.__SMLN_PROBLEMS__ || { problems: [], summary: { errors: 0, warnings: 0 } } }

  function t(key, params) {
    if (SMLN.i18n && typeof SMLN.i18n.t === 'function') {
      var out = SMLN.i18n.t(key, params)
      if (out !== key) return out
    }
    return null
  }

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
    '#smln-splash .panel{width:min(560px,92vw);padding:26px 30px 20px;',
    'background:rgba(8,12,17,.94);border:1px solid rgba(100,116,139,.68);',
    'border-radius:0 8px 0 8px;box-shadow:0 4px 12px rgba(0,0,0,.28)}',

    '#smln-splash .head{display:flex;align-items:baseline;justify-content:space-between;gap:14px}',
    '#smln-splash .mark{font-size:26px;font-weight:700;letter-spacing:.16em;',
    'text-transform:uppercase;color:#ffe700;line-height:1.1}',
    '#smln-splash .ver{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#64748b}',
    '#smln-splash .game{font-size:12px;color:#94a3b8;margin-top:3px}',
    '#smln-splash .game b{color:#cbd5e1;font-weight:400}',
    '#smln-splash .drift{color:#ffe700}',

    '#smln-splash .bar{margin:16px 0 12px;height:3px;background:rgba(255,231,0,.14);overflow:hidden}',
    '#smln-splash .bar i{display:block;height:100%;width:0;background:#ffe700;',
    'transition:width .28s ease-out}',
    '#smln-splash .bar.idle i{width:34%;animation:smln-sweep 1.15s ease-in-out infinite;transition:none}',
    '@keyframes smln-sweep{0%{transform:translateX(-110%)}100%{transform:translateX(360%)}}',

    // The feed: one line per thing the loader did, revealed in order.
    '#smln-splash .feed{max-height:34vh;overflow:hidden;font-size:12.5px;line-height:1.75}',
    '#smln-splash .line{display:flex;gap:9px;align-items:baseline;opacity:0;',
    'transform:translateY(3px);transition:opacity .22s ease-out,transform .22s ease-out}',
    '#smln-splash .line.in{opacity:1;transform:none}',
    '#smln-splash .line .g{color:#4ade80;width:1em;flex:none;text-align:center}',
    '#smln-splash .line .w{color:#ffe700;width:1em;flex:none;text-align:center}',
    '#smln-splash .line .b{color:#f87171;width:1em;flex:none;text-align:center}',
    '#smln-splash .line .d{color:#475569;width:1em;flex:none;text-align:center}',
    '#smln-splash .line .txt{flex:1;min-width:0;color:#cbd5e1;overflow:hidden;',
    'text-overflow:ellipsis;white-space:nowrap}',
    '#smln-splash .line .tag{font-size:9.5px;letter-spacing:.11em;text-transform:uppercase;',
    'padding:1px 6px;border:1px solid rgba(100,116,139,.5);color:#94a3b8;',
    'border-radius:0 3px 0 3px;flex:none}',
    '#smln-splash .line .tag.flux{border-color:rgba(122,162,255,.5);color:#7aa2ff}',
    '#smln-splash .line .tag.native{border-color:#f87171;color:#f87171}',
    '#smln-splash .line .tag.elev{border-color:rgba(255,231,0,.5);color:#ffe700}',
    '#smln-splash .line .num{color:#64748b;flex:none;font-size:11.5px}',

    '#smln-splash .status{margin-top:12px;padding-top:11px;font-size:12px;color:#94a3b8;',
    'border-top:1px solid rgba(100,116,139,.28);display:flex;justify-content:space-between;gap:12px}',
    '#smln-splash .status .bad{color:#f87171}',
    '#smln-splash .status .warnc{color:#ffe700}',
  ].join('')

  // -------------------------------------------------------------- the feed
  function line(mark, text, opts) {
    return { mark: mark, text: text, tag: opts && opts.tag, tagClass: opts && opts.tagClass, num: opts && opts.num }
  }

  function render(entry) {
    var row = global.document.createElement('div')
    row.className = 'line'

    var m = global.document.createElement('span')
    m.className = entry.mark === 'ok' ? 'g' : entry.mark === 'warn' ? 'w' : entry.mark === 'bad' ? 'b' : 'd'
    m.textContent = entry.mark === 'ok' ? '✓' : entry.mark === 'warn' ? '!' : entry.mark === 'bad' ? '✕' : '·'

    var txt = global.document.createElement('span')
    txt.className = 'txt'
    // textContent: mod names and error messages come from mod authors.
    txt.textContent = entry.text

    row.appendChild(m)
    row.appendChild(txt)

    if (entry.tag) {
      var tag = global.document.createElement('span')
      tag.className = 'tag' + (entry.tagClass ? ' ' + entry.tagClass : '')
      tag.textContent = entry.tag
      row.appendChild(tag)
    }
    if (entry.num != null) {
      var num = global.document.createElement('span')
      num.className = 'num'
      num.textContent = String(entry.num)
      row.appendChild(num)
    }

    els.feed.appendChild(row)
    // Keep the newest lines visible without a scrollbar appearing mid-boot.
    while (els.feed.childNodes.length > 12) els.feed.removeChild(els.feed.firstChild)
    global.setTimeout(function () { row.className = 'line in' }, 10)
    return row
  }

  /** Reveal one line at a time, so the boot reads as a sequence. */
  function pump() {
    if (stepping) return
    stepping = true
    ;(function next() {
      if (!queue.length || !node) { stepping = false; return }
      var entry = queue.shift()
      try { render(entry) } catch (_e) { /* never let the splash break the page */ }
      progress()
      global.setTimeout(next, STEP_MS)
    })()
  }

  function push(entry) {
    queue.push(entry)
    if (node) pump()
  }

  var totalPlanned = 1
  function progress() {
    if (!els.fill) return
    var b = boot()
    var planned = totalPlanned
    var shownRatio = planned ? Math.min(1, (planned - queue.length) / planned) : 1
    els.bar.className = 'bar'
    els.fill.style.width = Math.round(shownRatio * 100) + '%'
    if (b === null) els.bar.className = 'bar idle'
  }

  // ------------------------------------------------------------ the report
  function badgeClass(badge) {
    if (badge === 'NATIVE') return 'native'
    if (badge === 'ELEVATED' || badge === 'NETWORK' || badge === 'FILESYSTEM') return 'elev'
    return ''
  }

  function describe() {
    var b = boot()
    var p = probs()

    if (!b) {
      // No boot report: the main process is older than this renderer, or the
      // injection failed. Say that rather than showing a fake summary.
      push(line('warn', t('splash.noReport') || 'no boot report from the loader'))
      return
    }

    if (b.game) {
      var label = b.game.name + ' ' + b.game.version + '  (' + b.game.source + ')'
      push(line(b.game.verified ? 'ok' : 'warn', label))
      if (!b.game.verified) {
        push(line('warn', t('splash.versionDrift') ||
          'game version differs from the verified build; hooks anchor on source strings'))
      }
    }

    var c = b.counts || {}
    var mods = b.mods || []

    if (!mods.length) {
      push(line('dot', t('splash.noMods') || 'no mods installed'))
    } else {
      for (var i = 0; i < mods.length; i++) {
        var m = mods[i]
        var mark = m.failed ? 'bad' : m.enabled === false ? 'dot' : m.needsApproval ? 'warn' : 'ok'
        var suffix = m.failed
          ? '  -  ' + (t('mods.failed') || 'failed to load')
          : m.needsApproval
            ? '  -  ' + (t('mods.notApproved') || 'needs approval')
            : m.enabled === false ? '  -  ' + (t('mods.stateDisabled') || 'disabled') : ''
        var cap = m.capability || {}
        push(line(mark, (m.name || m.id) + ' ' + (m.version || '') + suffix, {
          tag: cap.badge || (m.flavour === 'fluxloader' ? 'FLUX' : 'MOD'),
          tagClass: cap.badge ? badgeClass(cap.badge) : (m.flavour === 'fluxloader' ? 'flux' : ''),
        }))
      }
    }

    // Hooks, grouped by the file they go into - that is the unit that either
    // works or does not, and it is what the patch report in the log lists.
    var byTarget = {}
    var patches = b.patches || []
    for (var j = 0; j < patches.length; j++) {
      var tgt = patches[j].target || 'js/bundle.js'
      byTarget[tgt] = (byTarget[tgt] || 0) + 1
    }
    var targets = Object.keys(byTarget)
    for (var k = 0; k < targets.length; k++) {
      push(line('ok', (t('splash.hooks') || 'hooks') + '  ' + targets[k], { num: byTarget[targets[k]] }))
    }

    if (c.rendererScripts) {
      push(line('ok', t('splash.rendererScripts') || 'renderer mod scripts', { num: c.rendererScripts }))
    }
    if (c.workerScripts) {
      push(line('ok', t('splash.workerScripts') || 'worker mod scripts', { num: c.workerScripts }))
    }
    if (c.assets) {
      push(line('ok', t('splash.assets') || 'mod asset folders', { num: c.assets }))
    }

    var list = p.problems || []
    var shown = 0
    for (var q = 0; q < list.length && shown < 4; q++) {
      var pr = list[q]
      push(line(pr.severity === 'warn' ? 'warn' : 'bad',
        (pr.modId ? pr.modId + ': ' : '') + pr.message))
      shown++
    }
    if (list.length > shown) {
      push(line('dot', t('splash.moreProblems', { count: list.length - shown }) ||
        (list.length - shown) + ' more problem(s) - see SandLoader Mods > Problems'))
    }

    totalPlanned = Math.max(1, queue.length)
  }

  function summarise() {
    if (!els.status) return
    var p = probs().summary || { errors: 0, warnings: 0 }
    var b = boot()
    var c = (b && b.counts) || {}

    while (els.status.firstChild) els.status.removeChild(els.status.firstChild)

    var left = global.document.createElement('span')
    var parts = []
    if (c.enabled != null) parts.push((t('splash.modsActive', { count: c.enabled }) || (c.enabled + ' mod(s) active')))
    if (c.patches) parts.push((t('splash.hooksTotal', { count: c.patches }) || (c.patches + ' hook(s)')))
    left.textContent = parts.join('   ')

    var right = global.document.createElement('span')
    if (p.errors) {
      right.className = 'bad'
      right.textContent = t('splash.errors', { count: p.errors }) || (p.errors + ' error(s)')
    } else if (p.warnings) {
      right.className = 'warnc'
      right.textContent = t('splash.warnings', { count: p.warnings }) || (p.warnings + ' warning(s)')
    } else {
      right.textContent = t('splash.allClear') || 'all clear'
    }

    els.status.appendChild(left)
    els.status.appendChild(right)
  }

  // ---------------------------------------------------------------- build
  function build() {
    if (!global.document.body || node) return

    var style = global.document.createElement('style')
    style.textContent = CSS
    global.document.head.appendChild(style)

    node = global.document.createElement('div')
    node.id = 'smln-splash'

    var panel = global.document.createElement('div')
    panel.className = 'panel'

    var head = global.document.createElement('div')
    head.className = 'head'
    var mark = global.document.createElement('div')
    mark.className = 'mark'
    mark.textContent = 'SandLoader'
    var ver = global.document.createElement('div')
    ver.className = 'ver'
    ver.textContent = 'v' + SMLN.version
    head.appendChild(mark)
    head.appendChild(ver)

    var bar = global.document.createElement('div')
    bar.className = 'bar idle'
    var fill = global.document.createElement('i')
    bar.appendChild(fill)

    var feed = global.document.createElement('div')
    feed.className = 'feed'

    var status = global.document.createElement('div')
    status.className = 'status'

    panel.appendChild(head)
    panel.appendChild(bar)
    panel.appendChild(feed)
    panel.appendChild(status)
    node.appendChild(panel)
    global.document.body.appendChild(node)

    els = { feed: feed, bar: bar, fill: fill, status: status }

    describe()
    summarise()
    pump()
    watchForGameUI()
    timer = global.setTimeout(function () { hide('timeout') }, MAX_VISIBLE_MS)
  }

  /** Anything else that wants to say something during boot. */
  function status(text, kind) {
    push(line(kind || 'ok', String(text)))
  }

  /** Leave as soon as the game has rendered something into its UI root. */
  function watchForGameUI() {
    var root = global.document.getElementById('ui')
    if (!root) {
      global.setTimeout(function () { if (!done) ready('no-ui-root') }, 6000)
      return
    }
    if (root.childNodes.length) { ready('ui-present'); return }
    if (typeof MutationObserver !== 'function') {
      global.setTimeout(function () { ready('no-observer') }, 5000)
      return
    }
    observer = new MutationObserver(function () {
      if (root.childNodes.length) ready('ui-rendered')
    })
    observer.observe(root, { childList: true, subtree: false })
  }

  /**
   * The game is up. Finish the feed first, and when the loader had something
   * to report, hold a beat so the player can actually read it.
   */
  function ready(reason) {
    if (uiReady || done) return
    uiReady = true
    var p = probs().summary || { errors: 0, warnings: 0 }
    var hold = (p.errors || p.warnings) ? HOLD_ON_ERROR_MS : 0
    var drain = queue.length * STEP_MS + 200
    global.setTimeout(function () { hide(reason) }, Math.max(drain, hold))
  }

  function hide(reason) {
    if (done) return
    done = true
    if (timer) { global.clearTimeout(timer); timer = null }
    if (observer) { observer.disconnect(); observer = null }
    SMLN.log('info', 'splash dismissed (' + reason + ')')
    if (!node) return
    node.className = 'gone'
    global.setTimeout(function () {
      if (node && node.parentNode) node.parentNode.removeChild(node)
      node = null
    }, FADE_MS + 60)
  }

  // The game API arriving is worth a line: it is the hook everything else
  // depends on, and its absence is the single most useful thing to see.
  SMLN.on('ready', function () {
    if (done) return
    var fh = SMLN.game
    push(line('ok', (t('splash.captured') || 'game API captured') +
      (fh ? '  (' + Object.keys(fh).length + ' namespaces)' : '')))
    summarise()
  })

  SMLN.splash = {
    hide: hide,
    status: status,
    push: push,
    isVisible: function () { return !!node && !done },
    /** Forces the splash regardless of the initial-load check; for testing. */
    show: function () { done = false; uiReady = false; build() },
    _queue: function () { return queue.slice() },
  }

  if (!isInitialLoad()) {
    SMLN.log('info', 'splash skipped (scene reload, not a fresh start)')
    done = true
    return
  }

  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', build)
  } else build()
})(typeof globalThis !== 'undefined' ? globalThis : window)
