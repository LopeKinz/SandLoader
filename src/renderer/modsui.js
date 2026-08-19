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
 * Installing, removing and toggling all happen in the main process; this file
 * only asks. Three things are worth knowing about the design:
 *
 *   - Every row carries a security class. A native mod's badge is always
 *     visible, never behind a hover or a details panel, because "this mod can
 *     do anything your account can" is not a detail.
 *   - Installing is two-phase. `installModReview` parses the archive's
 *     manifest without unpacking or running anything and returns what the mod
 *     is asking for; only after the user agrees does `installModCommit` move
 *     it into place. No mod code runs before that decision.
 *   - A mod that failed to load stays in the list, marked, with its error
 *     reachable. Dropping it would make a broken mod indistinguishable from
 *     one that loaded and does nothing.
 *
 * All text goes in with `textContent`. Mod names, ids, directories and error
 * strings come from mod authors and are untrusted.
 */
;(function installSmlnModsUI(global) {
  var SMLN = global.__SMLN__
  if (!SMLN || SMLN.modsUI) return

  var MENU_ID = 'main-menu-mods'
  var FALLBACK_LABEL = 'SandLoader Mods'

  var overlay = null
  var open = false
  /** id -> enabled, mirrored from the main process and edited here. */
  var enabledState = Object.create(null)

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

  function mods() { return global.__SMLN_MODS__ || [] }

  mods().forEach(function (m) { enabledState[m.id] = m.enabled !== false })

  function rpc(action, payload) { return SMLN.callMain(action, payload) }

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

    '#smln-mods .panel{width:min(820px,94vw);max-height:82vh;display:flex;flex-direction:column;',
    'background:rgba(8,12,17,.97);border:1px solid rgba(100,116,139,.68);',
    'border-radius:0 8px 0 8px;box-shadow:0 4px 12px rgba(0,0,0,.28)}',

    '#smln-mods header{display:flex;align-items:baseline;justify-content:space-between;',
    'padding:18px 22px;border-bottom:1px solid rgba(100,116,139,.34)}',
    '#smln-mods h2{margin:0;font-size:17px;font-weight:700;letter-spacing:.14em;',
    'text-transform:uppercase;color:#ffe700}',
    '#smln-mods .count{color:#94a3b8;font-size:12px}',
    '#smln-mods .count .bad{color:#f87171}',

    '#smln-mods .list{overflow-y:auto;padding:4px 0}',
    '#smln-mods .row{display:flex;align-items:center;gap:11px;padding:12px 22px;',
    'border-bottom:1px solid rgba(100,116,139,.18)}',
    '#smln-mods .row:last-child{border-bottom:0}',
    '#smln-mods .row.failed{background:rgba(248,113,113,.07)}',
    '#smln-mods .meta{flex:1;min-width:0}',
    '#smln-mods .nm{color:#f1f5f9}',
    '#smln-mods .nm .state{color:#f87171;font-size:12px}',
    '#smln-mods .nm .state.warn{color:#ffe700}',
    '#smln-mods .id{color:#64748b;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

    '#smln-mods .tag{font-size:10px;letter-spacing:.12em;text-transform:uppercase;padding:3px 8px;',
    'border:1px solid rgba(100,116,139,.55);color:#94a3b8;border-radius:0 4px 0 4px;flex:none}',
    '#smln-mods .tag.flux{border-color:rgba(122,162,255,.5);color:#7aa2ff}',
    '#smln-mods .tag.ws{border-color:rgba(102,192,244,.55);color:#66c0f4}',
    '#smln-mods .act.steam{border-color:rgba(102,192,244,.5);color:#66c0f4}',
    '#smln-mods .act.steam:hover{background:rgba(102,192,244,.12)}',
    '#smln-mods .badge{font-size:10px;letter-spacing:.12em;text-transform:uppercase;padding:3px 8px;',
    'border:1px solid rgba(100,116,139,.55);color:#94a3b8;border-radius:0 4px 0 4px;flex:none}',
    '#smln-mods .badge.elev{border-color:rgba(255,231,0,.55);color:#ffe700}',
    '#smln-mods .badge.native{border-color:#f87171;color:#f87171;background:rgba(248,113,113,.1)}',

    '#smln-mods .toggle{cursor:pointer;border:1px solid rgba(255,231,0,.45);background:rgba(255,231,0,.05);',
    'color:#ffe700;font:inherit;font-size:12px;padding:6px 14px;border-radius:0 4px 0 4px;min-width:88px;flex:none}',
    '#smln-mods .toggle:hover{background:rgba(255,231,0,.12)}',
    '#smln-mods .toggle.off{border-color:rgba(100,116,139,.45);color:#94a3b8;background:transparent}',

    '#smln-mods .empty{padding:36px 22px;text-align:center;color:#64748b}',
    '#smln-mods footer{padding:14px 22px;border-top:1px solid rgba(100,116,139,.34);',
    'display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}',
    '#smln-mods .note{color:#64748b;font-size:12px;flex:1;min-width:120px}',
    '#smln-mods .note.warn{color:#ffe700}',
    '#smln-mods .close{cursor:pointer;border:1px solid rgba(100,116,139,.68);background:transparent;',
    'color:#e2e8f0;font:inherit;padding:7px 20px;border-radius:0 4px 0 4px}',
    '#smln-mods .close:hover{background:rgba(148,163,184,.12)}',

    '#smln-mods .actions{display:flex;gap:9px;align-items:center;flex-wrap:wrap}',
    '#smln-mods .act{cursor:pointer;border:1px solid rgba(100,116,139,.68);background:transparent;',
    'color:#e2e8f0;font:inherit;font-size:12px;padding:6px 13px;border-radius:0 4px 0 4px;flex:none}',
    '#smln-mods .act:hover{background:rgba(148,163,184,.12)}',
    '#smln-mods .act[disabled]{opacity:.45;cursor:default}',
    '#smln-mods .act.primary{border-color:rgba(255,231,0,.45);color:#ffe700;background:rgba(255,231,0,.05)}',
    '#smln-mods .act.primary:hover{background:rgba(255,231,0,.12)}',
    '#smln-mods .act.alert{border-color:rgba(248,113,113,.55);color:#f87171}',
    '#smln-mods .del{cursor:pointer;border:1px solid rgba(248,113,113,.4);background:transparent;',
    'color:#f87171;font:inherit;font-size:12px;padding:6px 11px;border-radius:0 4px 0 4px;flex:none}',
    '#smln-mods .del:hover{background:rgba(248,113,113,.12)}',
    '#smln-mods .del.confirm{background:rgba(248,113,113,.18);border-color:#f87171}',
    '#smln-mods select{background:rgba(2,6,10,.85);border:1px solid rgba(100,116,139,.55);',
    'color:#e2e8f0;font:inherit;font-size:12px;padding:5px 8px;border-radius:0 4px 0 4px}',
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

    var lang = document.createElement('select')
    lang.addEventListener('change', function () {
      if (SMLN.i18n && typeof SMLN.i18n.setLocale === 'function') SMLN.i18n.setLocale(lang.value)
    })

    var install = document.createElement('button')
    install.className = 'act primary'
    install.addEventListener('click', function () { doInstall(install) })

    var openDir = document.createElement('button')
    openDir.className = 'act'
    openDir.addEventListener('click', function () { doOpenFolder(openDir) })

    var browseWs = document.createElement('button')
    browseWs.className = 'act steam'
    browseWs.addEventListener('click', function () { doOpenWorkshop(browseWs, null) })

    var reload = document.createElement('button')
    reload.className = 'act'
    reload.addEventListener('click', function () { doReload(reload) })

    var problems = document.createElement('button')
    problems.className = 'act'
    problems.addEventListener('click', function () {
      if (SMLN.permUI) SMLN.permUI.problems()
    })

    var close = document.createElement('button')
    close.className = 'close'
    close.addEventListener('click', function () { toggle(false) })

    actions.appendChild(lang)
    actions.appendChild(problems)
    actions.appendChild(reload)
    actions.appendChild(openDir)
    actions.appendChild(browseWs)
    actions.appendChild(install)
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
    overlay._reload = reload
    overlay._browseWs = browseWs
    overlay._problems = problems
    overlay._close = close
    overlay._title = h2
    overlay._lang = lang

    if (SMLN.i18n && typeof SMLN.i18n.onChange === 'function') {
      SMLN.i18n.onChange(function () { paintChrome(); render() })
    }
    paintChrome()
    render()
  }

  /** Everything outside the list; re-run on a language change. */
  function paintChrome() {
    if (!overlay) return
    overlay._title.textContent = tx('mods.title', FALLBACK_LABEL)
    overlay._install.textContent = tx('mods.installFromZip', 'Install from ZIP')
    overlay._open.textContent = tx('mods.openFolder', 'Open folder')
    overlay._reload.textContent = tx('mods.reloadMods', 'Reload Mods')
    overlay._browseWs.textContent = tx('mods.browseWorkshop', 'Browse Workshop')
    overlay._close.textContent = tx('mods.close', 'Close')

    var p = global.__SMLN_PROBLEMS__ || { summary: { total: 0, errors: 0 } }
    var n = (p.summary && p.summary.total) || 0
    overlay._problems.textContent = n
      ? tx('problems.badge', n + ' problem(s)', { count: n })
      : tx('problems.button', 'Problems')
    overlay._problems.className = 'act' + (p.summary && p.summary.errors ? ' alert' : '')

    var sel = overlay._lang
    while (sel.firstChild) sel.removeChild(sel.firstChild)
    var locales = (SMLN.i18n && SMLN.i18n.locales && SMLN.i18n.locales()) || []
    var active = (SMLN.i18n && SMLN.i18n.locale && SMLN.i18n.locale()) || 'en'
    for (var i = 0; i < locales.length; i++) {
      var opt = document.createElement('option')
      opt.value = locales[i].code
      opt.textContent = locales[i].nativeName || locales[i].code
      if (locales[i].code === active) opt.selected = true
      sel.appendChild(opt)
    }
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

  // -------------------------------------------------------------- install
  /**
   * Two-phase. The archive is inspected and the permissions shown before
   * anything is written; only an explicit approval commits it.
   */
  function doInstall(button) {
    say(tx('mods.choosingZip', 'choose a .zip archive ...'))
    return busy(button, tx('mods.installing', 'Installing...'), function () {
      return rpc('installModReview', {})
    }).then(function (r) {
      if (r && r.cancelled) { say(''); return }
      if (!r || !r.ok) {
        say(tx('mods.installFailed', 'install failed: ' + ((r && r.error) || 'unknown error'),
          { error: (r && r.error) || tx('common.unknownError', 'unknown error') }), 'err')
        return
      }

      var decide = (SMLN.permUI && r.review)
        ? SMLN.permUI.review(r.review)
        // No review UI installed: refuse rather than install something the
        // user was never shown.
        : Promise.resolve(false)

      return decide.then(function (approved) {
        if (!approved) {
          say(tx('mods.installCancelled', 'install cancelled'))
          return rpc('installModAbort', { token: r.token })
        }
        return busy(button, tx('mods.installing', 'Installing...'), function () {
          return rpc('installModCommit', { token: r.token })
        }).then(function (done) {
          if (!done || !done.ok) {
            say(tx('mods.installFailed', 'install failed: ' + ((done && done.error) || 'unknown error'),
              { error: (done && done.error) || tx('common.unknownError', 'unknown error') }), 'err')
            return
          }
          say(tx('mods.installedStatus',
            (done.replaced ? 'replaced ' : 'installed ') + done.id + '@' + done.version +
            '  -  reload to load it', { id: done.id, version: done.version }), 'good')
          var list = global.__SMLN_MODS__ || (global.__SMLN_MODS__ = [])
          if (!list.some(function (m) { return m.id === done.id })) {
            list.push({
              id: done.id, name: done.id, version: done.version, flavour: done.flavour,
              enabled: true, dir: done.dir, pending: true,
              capability: r.review.capability,
            })
          }
          enabledState[done.id] = true
          render()
        })
      })
    })
  }

  function doOpenFolder(button) {
    return busy(button, tx('mods.opening', 'Opening...'), function () { return rpc('openModsFolder', {}) })
      .then(function (r) {
        if (!r || !r.ok) {
          say(tx('mods.openFailed', 'could not open the folder: ' + ((r && r.error) || 'unknown error'),
            { error: (r && r.error) || '' }), 'err')
        } else say(r.dir)
      })
  }

  /**
   * Hand off to Steam. Subscribing and unsubscribing happen there, not here -
   * SandLoader has no business managing someone's Steam subscriptions, and
   * could not do it reliably if it tried.
   */
  function doOpenWorkshop(button, publishedFileId) {
    return busy(button, tx('mods.opening', 'Opening...'), function () {
      return rpc('openWorkshop', { id: publishedFileId })
    }).then(function (r) {
      if (!r || !r.ok) {
        say(tx('mods.workshopOpenFailed', 'could not open Steam',
          { error: (r && r.error) || tx('common.unknownError', 'unknown error') }), 'err')
        return
      }
      say(r.url || '')
    })
  }

  function doReload(button) {
    return busy(button, tx('reload.reloading', 'Reloading...'), function () {
      if (SMLN.hotreload && typeof SMLN.hotreload.reload === 'function') return SMLN.hotreload.reload()
      return rpc('reloadMods', { apply: true })
    }).then(function (r) {
      if (r && r.cancelled) { say(''); return }
      if (!r || !r.ok) {
        say(tx('reload.failed', 'reload failed: ' + ((r && r.error) || 'unknown error'),
          { error: (r && r.error) || tx('common.unknownError', 'unknown error') }), 'err')
        return
      }
      say(tx('reload.reloaded', 'mods reloaded', { count: (r.report && r.report.mods && r.report.mods.length) || 0 }), 'good')
    })
  }

  /** Two-step, because this deletes files from disk. */
  function doRemove(mod, button) {
    if (button._armed) {
      button._armed = false
      return busy(button, tx('mods.removing', 'Removing...'), function () {
        return rpc('removeMod', { dir: mod.dir })
      }).then(function (r) {
        button.className = 'del'
        if (!r || !r.ok) {
          say(tx('mods.removeFailed', 'could not remove ' + mod.id + ': ' + ((r && r.error) || 'unknown error'),
            { id: mod.id, error: (r && r.error) || '' }), 'err')
          return
        }
        say(tx('mods.removed', 'removed ' + mod.id + '  -  reload to unload it', { id: mod.id }), 'good')
        var list = global.__SMLN_MODS__ || []
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === mod.id) { list.splice(i, 1); break }
        }
        render()
      })
    }
    button._armed = true
    button.className = 'del confirm'
    button.textContent = tx('mods.sure', 'Sure?')
    say(tx('mods.confirmDelete', 'click again to delete ' + mod.id + ' from disk', { id: mod.id }))
    setTimeout(function () {
      if (!button._armed) return
      button._armed = false
      button.className = 'del'
      button.textContent = tx('mods.delete', 'Delete')
      say('')
    }, 4000)
    return Promise.resolve()
  }

  // ---------------------------------------------------------------- render
  function badgeClass(badge) {
    if (badge === 'NATIVE') return ' native'
    if (badge === 'ELEVATED' || badge === 'NETWORK' || badge === 'FILESYSTEM') return ' elev'
    return ''
  }

  function render() {
    if (!overlay) return
    var list = overlay._list
    while (list.firstChild) list.removeChild(list.firstChild)

    var all = mods()
    var broken = all.filter(function (m) { return m.failed }).length
    while (overlay._count.firstChild) overlay._count.removeChild(overlay._count.firstChild)
    var c = document.createElement('span')
    c.textContent = tx('mods.count', all.length + ' installed', { count: all.length })
    overlay._count.appendChild(c)
    if (broken) {
      var b = document.createElement('span')
      b.className = 'bad'
      b.textContent = '   ' + tx('mods.brokenCount', broken + ' failed', { count: broken })
      overlay._count.appendChild(b)
    }

    if (!all.length) {
      var empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = tx('mods.empty',
        'No mods installed. Use "Install from ZIP", or drop a mod folder into the mods directory.')
      list.appendChild(empty)
      overlay._note.textContent = ''
      return
    }

    all.forEach(function (m) { list.appendChild(rowFor(m)) })
    updateNote()
  }

  function rowFor(m) {
    var cap = m.capability || {}
    var row = document.createElement('div')
    row.className = 'row' + (m.failed ? ' failed' : '')

    var meta = document.createElement('div')
    meta.className = 'meta'
    var nm = document.createElement('div')
    nm.className = 'nm'
    nm.textContent = (m.name || m.id) + '  ' + (m.version || '')
    if (m.pending || m.failed || m.needsApproval) {
      var state = document.createElement('span')
      state.className = 'state' + (m.needsApproval && !m.failed ? ' warn' : '')
      state.textContent = '   ' + (m.failed
        ? tx('mods.failed', 'failed to load')
        : m.needsApproval
          ? tx('mods.notApproved', 'needs approval')
          : tx('mods.pending', '(reload to load)'))
      nm.appendChild(state)
    }
    var id = document.createElement('div')
    id.className = 'id'
    id.textContent = m.id +
      (m.publishedFileId ? '  -  Workshop ' + m.publishedFileId : '') +
      (m.dir ? '  -  ' + m.dir : '')
    meta.appendChild(nm)
    meta.appendChild(id)

    var tag = document.createElement('span')
    tag.className = 'tag' + (m.flavour === 'fluxloader' ? ' flux' : '')
    tag.textContent = m.flavour === 'fluxloader' ? 'Fluxloader' : 'SandLoader'

    // Where it came from, shown separately from what format it is - a Workshop
    // item can be either flavour, and the two answer different questions.
    var isWorkshop = m.source === 'workshop'
    var srcTag = null
    if (isWorkshop) {
      srcTag = document.createElement('span')
      srcTag.className = 'tag ws'
      srcTag.textContent = tx('mods.source.workshop', 'Workshop')
    }

    // Always rendered, never conditional: a native mod must be visible as one
    // at a glance, without opening anything.
    var badge = document.createElement('span')
    var badgeId = cap.badge || 'SANDBOXED'
    badge.className = 'badge' + badgeClass(badgeId)
    badge.textContent = tx('perm.badge.' + String(badgeId).toLowerCase(), badgeId)

    var details = document.createElement('button')
    details.className = 'act'
    details.textContent = tx('mods.details', 'Details')
    details.addEventListener('click', function () {
      rpc('getModDetails', { id: m.id }).then(function (info) {
        if (SMLN.permUI) SMLN.permUI.details(m, info && info.ok ? info : null)
      })
    })

    var btn = document.createElement('button')
    btn.className = 'toggle'
    function paint() {
      var on = enabledState[m.id] !== false
      btn.textContent = on ? tx('mods.enabled', 'Enabled') : tx('mods.disabled', 'Disabled')
      btn.className = 'toggle' + (on ? '' : ' off')
    }
    paint()
    btn.addEventListener('click', function () {
      enabledState[m.id] = enabledState[m.id] === false
      paint()
      rpc('setModEnabled', { id: m.id, enabled: enabledState[m.id] })
      updateNote()
    })

    // Steam owns Workshop folders: deleting one only makes Steam re-download
    // it. Offer the page instead, which is where unsubscribing lives.
    var del
    if (isWorkshop) {
      del = document.createElement('button')
      del.className = 'act steam'
      del.textContent = tx('mods.openInSteam', 'View in Steam')
      del.addEventListener('click', function () { doOpenWorkshop(del, m.publishedFileId) })
      if (!m.publishedFileId && del.setAttribute) del.setAttribute('disabled', 'true')
    } else {
      del = document.createElement('button')
      del.className = 'del'
      del.textContent = tx('mods.delete', 'Delete')
      del.addEventListener('click', function () { doRemove(m, del) })
    }

    row.appendChild(meta)
    row.appendChild(tag)
    if (srcTag) row.appendChild(srcTag)
    row.appendChild(badge)
    if (m.hasSettings) {
      var settings = document.createElement('button')
      settings.className = 'act'
      settings.textContent = tx('mods.settings', 'Settings')
      settings.addEventListener('click', function () {
        if (SMLN.settingsUI) SMLN.settingsUI.open(m)
      })
      row.appendChild(settings)
    }
    row.appendChild(details)
    row.appendChild(btn)
    row.appendChild(del)
    return row
  }

  function updateNote() {
    if (!overlay) return
    var changed = mods().some(function (m) {
      return (m.enabled !== false) !== (enabledState[m.id] !== false)
    })
    overlay._note.className = changed ? 'note warn' : 'note'
    overlay._note.textContent = changed
      ? tx('mods.changesPending', 'Changes apply on the next reload.')
      : tx('mods.hint', 'Mods load at startup; use Reload Mods to apply changes now.')
  }

  function toggle(force) {
    if (!overlay) build()
    open = force == null ? !open : !!force
    overlay.classList.toggle('open', open)
    if (open) { paintChrome(); render() }
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
    var wanted = SMLN.menuLabel || FALLBACK_LABEL
    if (label && label.textContent.trim() !== wanted) label.textContent = wanted

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
    render: render,
    /** Exposed for the self-test. */
    _hookMenu: hookMenu,
    _state: enabledState,
  }

  /**
   * Read by the `smln:mods-menu-label` patch when the menu renders. Set here
   * rather than in the patch so the text lives with the UI that owns it, and
   * so the game falls back to its own translation if SMLN is absent.
   */
  SMLN.menuLabel = tx('mods.title', FALLBACK_LABEL)
  if (SMLN.i18n && typeof SMLN.i18n.onChange === 'function') {
    SMLN.i18n.onChange(function () { SMLN.menuLabel = tx('mods.title', FALLBACK_LABEL) })
  }

  function boot() {
    if (!document.body) { setTimeout(boot, 50); return }
    build()
    window.addEventListener('keydown', onKey, true)
    watchMenu()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})(typeof globalThis !== 'undefined' ? globalThis : window)
