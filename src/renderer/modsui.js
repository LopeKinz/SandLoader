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

    var installWs = document.createElement('button')
    installWs.className = 'act steam'
    installWs.addEventListener('click', function () { doInstallWorkshop(installWs) })

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
    actions.appendChild(installWs)
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
    overlay._installWs = installWs
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
    overlay._installWs.textContent = tx('mods.installFromWorkshop', 'Install from Workshop')
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
      return afterReview(button, r, 'installModCommit', 'installModAbort')
    })
  }

  /**
   * The half of an install that is identical however the mod was found: show
   * the permission review, then commit or abort on the answer.
   *
   * Shared by the ZIP and Workshop buttons deliberately. The review is the
   * security boundary, so there must be exactly one path through it - a second
   * copy is a second place for the "no review UI means refuse" rule to be got
   * wrong.
   *
   * @param {any} button           re-disabled for the duration of the commit
   * @param {any} r                the review response
   * @param {string} commitAction  RPC that installs
   * @param {string} abortAction   RPC that throws the staged copy away
   */
  function afterReview(button, r, commitAction, abortAction) {
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
        return rpc(abortAction, { token: r.token })
      }
      return busy(button, tx('mods.installing', 'Installing...'), function () {
        return rpc(commitAction, { token: r.token })
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
  }

  /**
   * Install straight from a Workshop URL or id.
   *
   * SteamCMD is checked first so a machine without it says so immediately,
   * rather than after the player has gone and found a URL to paste. From there
   * the flow is the ZIP flow: the item is downloaded, its manifest reviewed,
   * and nothing is installed until the same permission dialog is answered.
   */
  function doInstallWorkshop(button) {
    if (!SMLN.permUI || typeof SMLN.permUI.prompt !== 'function') {
      say(tx('mods.workshopNoPrompt', 'this build cannot ask for a Workshop link'), 'err')
      return Promise.resolve()
    }

    return busy(button, tx('mods.checkingSteamcmd', 'Checking...'), function () {
      return rpc('steamcmdStatus', {})
    }).then(function (st) {
      if (st && st.ok && !st.available) {
        say(tx('mods.steamcmdMissing', 'SteamCMD was not found. ' + (st.hint || ''),
          { hint: st.hint || '' }), 'err')
        return
      }

      return SMLN.permUI.prompt({
        title: tx('mods.installFromWorkshop', 'Install from Workshop'),
        label: tx('mods.workshopPromptLabel', 'Paste the Workshop URL of the mod, or just its id:'),
        placeholder: 'https://steamcommunity.com/sharedfiles/filedetails/?id=...',
        hint: tx('mods.workshopPromptHint',
          'Downloaded with SteamCMD and installed as a normal local mod, so you can remove it here later.'),
        confirm: tx('mods.workshopPromptGo', 'Download'),
      }).then(function (ref) {
        if (!ref) { say(''); return }
        say(tx('mods.workshopDownloading', 'downloading from Steam - this can take a moment ...'))
        return busy(button, tx('mods.downloading', 'Downloading...'), function () {
          return rpc('installWorkshopReview', { ref: ref })
        }).then(function (r) {
          // Sandustry is a paid game, so Steam refuses to hand a Workshop item
          // to the anonymous login SteamCMD uses. Subscribing is the way
          // through, and SandLoader imports Steam's copy on the next attempt -
          // so offer that instead of leaving the player at a dead end.
          if (r && !r.ok && r.canSignIn) return useSteamAccount(button, r.publishedFileId, 1)
          if (r && !r.ok && r.canSubscribe) return offerSubscribe(button, r)
          return afterReview(button, r, 'installWorkshopCommit', 'installWorkshopAbort')
        })
      })
    })
  }

  /** How long to wait for Steam to finish downloading, and how often to look. */
  var SUBSCRIBE_POLL_MS = 2000
  var SUBSCRIBE_TIMEOUT_MS = 5 * 60 * 1000

  /**
   * Timings live on an object rather than in the closure so the self-test can
   * turn a five-minute wait into a few milliseconds. Nothing else reads them.
   */
  var timing = { pollMs: SUBSCRIBE_POLL_MS, timeoutMs: SUBSCRIBE_TIMEOUT_MS }

  /**
   * How many times a refused install may be retried from the recovery dialog.
   *
   * Each remedy leads back into the install, and the install can be refused
   * again - so without a ceiling, a remedy that does not work re-opens its own
   * dialog forever. Two attempts is enough to cover "I subscribed" and "then I
   * used an account"; past that the error is the answer.
   */
  var MAX_RECOVERY_ATTEMPTS = 2

  /**
   * The way out of the ownership wall, without leaving the game.
   *
   * Steam refuses to hand a paid game's Workshop item to the anonymous login
   * SteamCMD uses, and there are exactly two ways through: subscribe in Steam
   * so it downloads the item itself, or log SteamCMD in as an account that owns
   * the game. Both are offered here and both complete in-game - the old
   * behaviour was to print an environment variable name and give up, which is
   * not something a player can act on from inside Sandustry.
   */
  function offerSubscribe(button, r, attempt) {
    var tries = attempt || 1
    if (!SMLN.permUI || typeof SMLN.permUI.choose !== 'function') {
      say(tx('mods.workshopNeedsSubscribe',
        'Steam will not download that item anonymously - subscribe to it in Steam, then install it here again.'),
        'err')
      return
    }

    return SMLN.permUI.choose({
      title: tx('mods.installFromWorkshop', 'Install from Workshop'),
      body: r.error,
      hint: tx('mods.workshopSubscribeHint',
        'Subscribing is the simple way: Steam downloads the item and SandLoader installs it as soon as it appears.'),
      options: [
        { key: 'account', label: tx('mods.steamSignIn', 'Sign in to Steam') },
        { key: 'steam', label: tx('mods.workshopOpenSteam', 'Open in Steam'), kind: 'go' },
      ],
    }).then(function (choice) {
      if (choice === 'steam') return subscribeAndWait(button, r.publishedFileId, tries)
      if (choice === 'account') return useSteamAccount(button, r.publishedFileId, tries)
      say('')
    })
  }

  /**
   * Open the item in Steam, then wait for it to arrive and install it.
   *
   * The waiting is the point. Telling the player to come back and paste the
   * link a second time is the same dead end in a longer form; polling for the
   * folder means one click, a wait, and the mod is installed.
   */
  function subscribeAndWait(button, id, attempt) {
    return rpc('openWorkshop', { id: id }).then(function (opened) {
      if (!opened || !opened.ok) {
        say(tx('mods.workshopOpenFailed', 'Could not open Steam: {error}',
          { error: (opened && opened.error) || tx('common.unknownError', 'unknown error') }), 'err')
        return
      }

      var waiting = SMLN.permUI.progress({
        title: tx('mods.installFromWorkshop', 'Install from Workshop'),
        body: tx('mods.workshopWaiting', 'Waiting for Steam to download the item...'),
        hint: tx('mods.workshopWaitingHint',
          'Click Subscribe on the page Steam just opened. This installs by itself once the download lands.'),
      })

      var started = Date.now()

      function look() {
        // The player closing the dialog is an answer, so stop asking.
        if (waiting.cancelled()) { say(''); return null }

        if (Date.now() - started > timing.timeoutMs) {
          waiting.close()
          say(tx('mods.workshopWaitTimeout',
            'Steam has not downloaded that item yet. Subscribe in Steam, then install from the same link again.'), 'err')
          return null
        }

        return rpc('workshopProbe', { ref: id }).then(function (probe) {
          if (waiting.cancelled()) { say(''); return null }
          if (probe && probe.ok && probe.present) {
            waiting.close()
            return true
          }
          return delay(timing.pollMs).then(look)
        })
      }

      return Promise.resolve(look()).then(function (found) {
        if (!found) return
        say(tx('mods.workshopFound', 'Steam has it - installing ...'), 'good')
        return retryWorkshopInstall(button, id, attempt)
      })
    })
  }

  /**
   * Sign in to Steam, from inside the game.
   *
   * Steam will not hand a paid game's Workshop items to the anonymous account,
   * so downloading one without subscribing means a real sign-in. SteamCMD does
   * the signing in; this collects what it asks for and passes it along.
   *
   * What happens to the password: it is sent to the main process for this one
   * call, handed to SteamCMD over stdin, and dropped. It is never written to
   * settings, never logged, and never sent back. Only the account name is
   * remembered - SteamCMD caches its own session, so later downloads need
   * nothing else. That is also why there is no "stay signed in" option: it is
   * already the behaviour, and it belongs to SteamCMD rather than to us.
   */
  function useSteamAccount(button, id, attempt) {
    return rpc('getSteamUser', {}).then(function (current) {
      return SMLN.permUI.form({
        title: tx('mods.steamSignIn', 'Sign in to Steam'),
        body: tx('mods.steamSignInBody',
          'Sandustry is a paid game, so Steam only sends its Workshop items to an account that owns it.'),
        fields: [
          {
            key: 'user',
            label: tx('mods.steamAccountLabel', 'Steam account name'),
            value: (current && current.user) || '',
          },
          {
            key: 'password',
            label: tx('mods.steamPasswordLabel', 'Password'),
            type: 'password',
          },
        ],
        hint: tx('mods.steamSignInHint',
          'Your password goes straight to SteamCMD and is not saved anywhere by SandLoader. ' +
          'Only the account name is remembered.'),
        confirm: tx('mods.steamSignInGo', 'Sign in'),
      })
    }).then(function (creds) {
      if (!creds) { say(''); return }
      return attemptLogin(button, id, creds, attempt)
    })
  }

  /**
   * One sign-in attempt, plus the Steam Guard round trip if Steam asks for one.
   *
   * The credentials are kept only for the length of this exchange, because a
   * Steam Guard retry has to re-send them - SteamCMD starts a fresh process for
   * the second attempt and does not remember the first.
   */
  function attemptLogin(button, id, creds, attempt, guardCode) {
    return busy(button, tx('mods.steamSigningIn', 'Signing in...'), function () {
      return rpc('steamLogin', {
        user: creds.user,
        password: creds.password,
        guardCode: guardCode || '',
      })
    }).then(function (r) {
      if (r && r.ok) {
        say(tx('mods.steamSignedIn', 'signed in to Steam as {user}', { user: creds.user }), 'good')
        return retryWorkshopInstall(button, id, attempt)
      }

      // Steam wants a second factor. Ask for it and finish the same sign-in.
      if (r && r.needsGuard && !guardCode) {
        return SMLN.permUI.prompt({
          title: tx('mods.steamGuard', 'Steam Guard'),
          label: tx('mods.steamGuardLabel', 'Enter the Steam Guard code Steam just sent you:'),
          placeholder: 'XXXXX',
          confirm: tx('mods.steamGuardGo', 'Confirm'),
        }).then(function (code) {
          if (!code) { say(''); return }
          return attemptLogin(button, id, creds, attempt, code)
        })
      }

      say(tx('mods.steamSignInFailed', 'sign-in failed: ' + ((r && r.error) || 'unknown error'),
        { error: (r && r.error) || tx('common.unknownError', 'unknown error') }), 'err')
    })
  }

  /** Run the install again for an id we already have, without re-asking for it. */
  function retryWorkshopInstall(button, id, attempt) {
    var tries = (attempt || 1) + 1
    return busy(button, tx('mods.downloading', 'Downloading...'), function () {
      return rpc('installWorkshopReview', { ref: id })
    }).then(function (again) {
      // Still refused. Offer the other remedy once, then stop: re-opening the
      // same dialog after every failed attempt is a loop, not a fix.
      if (again && !again.ok && (again.canSubscribe || again.canSignIn)) {
        if (tries > MAX_RECOVERY_ATTEMPTS) {
          say(tx('mods.installFailed', 'install failed: ' + again.error, { error: again.error }), 'err')
          return
        }
        return offerSubscribe(button, again, tries)
      }
      return afterReview(button, again, 'installWorkshopCommit', 'installWorkshopAbort')
    })
  }

  function delay(ms) {
    return new Promise(function (resolve) { global.setTimeout(resolve, ms) })
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
    // A mod can load cleanly and still be unable to do its job, because this
    // build lacks Sandkit namespaces it calls. That failure surfaces later, as
    // a dead button or a missing tooltip, which reads exactly like a mod that
    // does nothing. Name it here instead.
    var gap = SMLN.apiSupport && SMLN.apiSupport.summarise(m.id)
    if (gap) {
      var warn = document.createElement('span')
      warn.className = 'state warn'
      warn.textContent = '   ' + tx('mods.apiMissing', 'unsupported: ' + gap, { list: gap })
      warn.title = tx('mods.apiMissingHint',
        'This game build does not provide these Sandkit namespaces. ' +
        'The mod loads, but features relying on them will not work.')
      nm.appendChild(warn)
    }

    // A missing REQUIRED dependency means this mod never loads at all, and the
    // resolver records that only as a warning - so without this the row looks
    // enabled and healthy while the mod silently does nothing. Optional ones
    // are shown too but worded as information, since the mod works without
    // them and only skips the integration.
    var missing = m.missingDependencies || []
    if (missing.length) {
      var required = missing.filter(function (d) { return !d.optional })
      var optional = missing.filter(function (d) { return d.optional })
      var describe = function (d) { return d.id + ' (' + d.reason + ')' }
      if (required.length) {
        var dep = document.createElement('span')
        dep.className = 'state warn'
        var names = required.map(describe).join(', ')
        dep.textContent = '   ' + tx('mods.depsMissing', 'needs: ' + names, { list: names })
        dep.title = tx('mods.depsMissingHint',
          'This mod requires other mods that are not available, so it will not load. ' +
          'Install or enable them, then reload.')
        nm.appendChild(dep)
      }
      if (optional.length) {
        var opt = document.createElement('span')
        opt.className = 'state'
        var optNames = optional.map(function (d) { return d.id }).join(', ')
        opt.textContent = '   ' + tx('mods.depsOptional', 'optional: ' + optNames, { list: optNames })
        opt.title = tx('mods.depsOptionalHint',
          'This mod can integrate with these when they are installed. ' +
          'It works without them.')
        nm.appendChild(opt)
      }
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
    } else if (m.importedFrom === 'workshop') {
      // Imported, not subscribed: it says where the mod came from, and the
      // absence of the Steam-managed tag is what says it is yours to delete.
      srcTag = document.createElement('span')
      srcTag.className = 'tag ws'
      srcTag.textContent = tx('mods.importedFromWorkshop', 'imported from Workshop')
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
    _timing: timing,
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
