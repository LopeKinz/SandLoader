/* eslint-env browser */
'use strict'
/**
 * Renderer half of mod hot reload.
 *
 * The decision about *what* a change means lives in src/mods/watcher.js, in
 * the main process, because only it can see the files. This file drives the
 * part that has to happen in the page: disposing a mod's recorded resources,
 * evaluating its replacement, and asking the user before doing something that
 * ends their current run.
 *
 * On the honest limits of a renderer-only reload, see the header of
 * src/mods/watcher.js. In short: SandLoader can reclaim what SandLoader handed
 * out - listeners, timers, messaging handlers, recorded registrations - and
 * nothing else. A mod that patched a game function in place stays patched.
 */
;(function installSmlnHotReload(global) {
  var SMLN = global.__SMLN__
  if (!SMLN || SMLN.hotreload) return

  var status = { state: 'idle', stage: null, message: '', at: null }
  var statusListeners = []
  /** modId -> 'loaded' | 'disposed' | 'failed' */
  var modState = Object.create(null)

  function t(key, params) {
    if (SMLN.i18n && typeof SMLN.i18n.t === 'function') return SMLN.i18n.t(key, params)
    return key
  }

  function setStatus(state, message, stage) {
    status = { state: state, stage: stage || null, message: message || '', at: Date.now() }
    for (var i = 0; i < statusListeners.length; i++) {
      // UI callbacks are not ours; one throwing must not stop the rest or the
      // reload that produced the status.
      try { statusListeners[i](status) }
      catch (e) { SMLN.log('error', 'hotreload status listener threw: ' + (e && e.message)) }
    }
  }

  function onStatus(fn) {
    if (typeof fn !== 'function') return function () {}
    statusListeners.push(fn)
    return function () {
      var i = statusListeners.indexOf(fn)
      if (i >= 0) statusListeners.splice(i, 1)
    }
  }

  // ------------------------------------------------------- confirm overlay
  /**
   * A context reload navigates the window, which ends the run in progress.
   * Defaults to "no": a reload the user did not expect costs them progress,
   * and there is no undo.
   */
  function confirmDestructive(message) {
    return new Promise(function (resolve) {
      if (!global.document || !global.document.body) { resolve(false); return }

      var overlay = global.document.createElement('div')
      overlay.id = 'smln-reload-confirm'
      overlay.setAttribute('style', [
        'position:fixed', 'inset:0', 'z-index:2147483500', 'display:flex',
        'align-items:center', 'justify-content:center', 'background:rgba(3,6,10,.72)',
        "font-family:'SMLN Play',system-ui,sans-serif", 'font-size:14px', 'color:#e2e8f0',
      ].join(';'))

      var panel = global.document.createElement('div')
      panel.setAttribute('style', [
        'width:min(460px,92vw)', 'padding:22px', 'background:rgba(8,12,17,.97)',
        'border:1px solid rgba(100,116,139,.68)', 'border-radius:0 8px 0 8px',
        'box-shadow:0 4px 12px rgba(0,0,0,.28)',
      ].join(';'))

      var head = global.document.createElement('div')
      head.setAttribute('style', 'color:#ffe700;font-weight:700;letter-spacing:.12em;text-transform:uppercase;margin-bottom:12px')
      head.textContent = t('reload.title')

      var body = global.document.createElement('div')
      body.setAttribute('style', 'margin-bottom:18px;line-height:1.55')
      body.textContent = message

      var row = global.document.createElement('div')
      row.setAttribute('style', 'display:flex;gap:9px;justify-content:flex-end')

      function button(label, accent) {
        var b = global.document.createElement('button')
        b.textContent = label
        b.setAttribute('style', [
          'cursor:pointer', 'font:inherit', 'font-size:12px', 'padding:7px 18px',
          'border-radius:0 4px 0 4px', 'background:transparent',
          accent ? 'border:1px solid rgba(255,231,0,.45)' : 'border:1px solid rgba(100,116,139,.68)',
          accent ? 'color:#ffe700' : 'color:#e2e8f0',
        ].join(';'))
        return b
      }

      function close(answer) {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
        global.removeEventListener('keydown', onKey, true)
        resolve(answer)
      }
      function onKey(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(false) }
      }

      var cancel = button(t('common.cancel'), false)
      cancel.addEventListener('click', function () { close(false) })
      var go = button(t('reload.action'), true)
      go.addEventListener('click', function () { close(true) })

      row.appendChild(cancel)
      row.appendChild(go)
      panel.appendChild(head)
      panel.appendChild(body)
      panel.appendChild(row)
      overlay.appendChild(panel)
      global.document.body.appendChild(overlay)
      global.addEventListener('keydown', onKey, true)
      // Cancel is focused, so Enter never destroys a session by accident.
      try { cancel.focus() } catch (_e) {}
    })
  }

  // ------------------------------------------------------------ the reload
  function reload(opts) {
    var options = opts || {}
    setStatus('running', t('reload.reloading'))

    return SMLN.callMain('reloadMods', { plan: true }).then(function (r) {
      if (!r || !r.ok) {
        var why = (r && r.error) || t('common.unknownError')
        setStatus('failed', t('reload.failed', { error: why }))
        return { ok: false, error: why }
      }

      var plan = r.plan || { stage: 'context', destroysSession: true }

      // The main process planned it; the user decides whether to pay for it.
      var proceed = Promise.resolve(true)
      if (plan.destroysSession && !options.force) {
        proceed = confirmDestructive(t('reload.confirmRestart'))
      }

      return proceed.then(function (yes) {
        if (!yes) {
          setStatus('idle', '')
          return { ok: false, cancelled: true }
        }
        setStatus('running', t('reload.reloading'), plan.stage)
        return SMLN.callMain('reloadMods', { apply: true }).then(function (applied) {
          if (!applied || !applied.ok) {
            var msg = (applied && applied.error) || t('common.unknownError')
            setStatus('failed', t('reload.failed', { error: msg }), plan.stage)
            return { ok: false, error: msg }
          }
          setStatus('done', t('reload.reloaded', { count: (applied.report && applied.report.mods && applied.report.mods.length) || 0 }), plan.stage)
          return { ok: true, plan: plan, report: applied.report }
        })
      })
    }, function (e) {
      setStatus('failed', t('reload.failed', { error: (e && e.message) || String(e) }))
      return { ok: false, error: (e && e.message) || String(e) }
    })
  }

  /** Ask the main process whether this one mod can be swapped in place. */
  function reloadMod(modId) {
    setStatus('running', t('reload.reloading'))
    return SMLN.callMain('reloadMod', { id: modId }).then(function (r) {
      if (!r || !r.ok) {
        setStatus('failed', t('reload.failed', { error: (r && r.error) || t('common.unknownError') }))
        return { ok: false, error: r && r.error }
      }
      if (r.stage !== 'renderer' || typeof r.source !== 'string') {
        // The main process decided a renderer-only swap is not safe. Do not
        // half-do it; escalate to the full reload the plan actually needs.
        return reload({ force: false })
      }
      return applyRendererMod(modId, r.source)
    })
  }

  /**
   * Swap one mod's renderer code. Called by the main process through the same
   * executeJavaScript channel it uses for RPC replies.
   *
   * Dispose first, always. Evaluating the new source over a live mod would
   * leave the old listeners and timers running alongside the new ones, which
   * looks like the mod firing twice and is very hard to diagnose.
   */
  function applyRendererMod(modId, source) {
    var disposed = null
    try {
      if (typeof SMLN.__disposeMod === 'function') disposed = SMLN.__disposeMod(modId)
      else SMLN.log('warn', 'no dispose support installed; ' + modId + ' may leave listeners behind')
      modState[modId] = 'disposed'
    } catch (e) {
      SMLN.log('error', 'disposing ' + modId + ' failed: ' + (e && e.message))
    }

    try {
      // eslint-disable-next-line no-new-func
      ;(0, eval)(source)
      modState[modId] = 'loaded'
      setStatus('done', t('reload.reloaded', { count: 1 }), 'renderer')
      SMLN.log('info', 'reloaded mod "' + modId + '" in place')
      return { ok: true, modId: modId, stage: 'renderer', disposed: disposed }
    } catch (e) {
      // Say what the state actually is. The mod is gone, not running-but-old.
      modState[modId] = 'failed'
      var msg = (e && e.message) || String(e)
      setStatus('failed', t('reload.failed', { error: msg }), 'renderer')
      SMLN.log('error', 'mod "' + modId + '" was disposed but its new code threw: ' + msg, e && e.stack)
      return { ok: false, modId: modId, stage: 'renderer', error: msg, state: 'disposed-not-reloaded' }
    }
  }

  SMLN.hotreload = {
    reload: reload,
    reloadMod: reloadMod,
    applyRendererMod: applyRendererMod,
    confirmDestructive: confirmDestructive,
    status: function () { return { state: status.state, stage: status.stage, message: status.message, at: status.at } },
    onStatus: onStatus,
    modState: function (id) { return id ? (modState[id] || 'loaded') : modState },
  }

  SMLN.log('info', 'hot reload installed')
})(typeof globalThis !== 'undefined' ? globalThis : window)
