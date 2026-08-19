/* eslint-env browser */
'use strict'
/**
 * Permission review, per-mod capability details, and the problem log.
 *
 * Three panels, one visual language:
 *
 *   review()   the decision dialog. Shown BEFORE a mod is installed and before
 *              an update with new permissions is allowed to run. The main
 *              process has already parsed the manifest without executing
 *              anything (src/mods/approvals.js); this only renders the answer
 *              and reports the user's choice back.
 *   details()  what a mod already installed can reach, and - when it is native
 *              - the plain statement that SandLoader cannot restrict it.
 *   problems() every failure the loader survived this launch.
 *
 * The problem log exists because "one bad mod must not stop the others" is
 * only half a policy if the survivor never learns what broke. A mod that
 * failed to load looks exactly like a mod that loaded and does nothing.
 *
 * All text goes in with `textContent`. Mod names, ids and error messages are
 * untrusted; a dialog whose whole job is to describe risk must not itself be
 * an injection point.
 */
;(function installSmlnPermUI(global) {
  var SMLN = global.__SMLN__
  if (!SMLN || SMLN.permUI) return

  var MARK = { granted: '✓', requested: '⚠', 'not-requested': '✕' }

  function t(key, params) {
    if (SMLN.i18n && typeof SMLN.i18n.t === 'function') return SMLN.i18n.t(key, params)
    return key
  }

  var CSS = [
    '.smln-modal{position:fixed;inset:0;z-index:2147483460;display:none;',
    'align-items:center;justify-content:center;background:rgba(3,6,10,.76);',
    "font-family:'SMLN Play',system-ui,sans-serif;font-size:14px;line-height:1.55;color:#e2e8f0}",
    '.smln-modal.open{display:flex}',
    '.smln-modal .panel{width:min(560px,92vw);max-height:84vh;display:flex;flex-direction:column;',
    'background:rgba(8,12,17,.98);border:1px solid rgba(100,116,139,.68);',
    'border-radius:0 8px 0 8px;box-shadow:0 4px 12px rgba(0,0,0,.32)}',
    '.smln-modal.wide .panel{width:min(760px,94vw)}',
    '.smln-modal header{padding:18px 22px;border-bottom:1px solid rgba(100,116,139,.34)}',
    '.smln-modal h2{margin:0;font-size:15px;font-weight:700;letter-spacing:.14em;',
    'text-transform:uppercase;color:#ffe700}',
    '.smln-modal .body{overflow-y:auto;padding:6px 0}',
    '.smln-modal .lead{padding:14px 22px 6px;color:#cbd5e1}',
    '.smln-modal .perm{display:flex;gap:12px;padding:10px 22px;align-items:flex-start}',
    '.smln-modal .perm .mark{width:1.2em;text-align:center;flex:none;font-weight:700}',
    '.smln-modal .perm.info .mark{color:#4ade80}',
    '.smln-modal .perm.warn .mark{color:#ffe700}',
    '.smln-modal .perm.danger .mark{color:#f87171}',
    '.smln-modal .perm.off{opacity:.5}',
    '.smln-modal .perm .pt{color:#f1f5f9}',
    '.smln-modal .perm .pd{color:#64748b;font-size:12px}',
    '.smln-modal .perm .new{color:#ffe700;font-size:11px;letter-spacing:.1em;text-transform:uppercase}',
    '.smln-modal .danger-box{margin:14px 22px;padding:12px 14px;border:1px solid #f87171;',
    'background:rgba(248,113,113,.12);border-radius:0 4px 0 4px;color:#fecaca}',
    '.smln-modal .danger-box b{display:block;color:#f87171;margin-bottom:5px;',
    'letter-spacing:.1em;text-transform:uppercase;font-size:11px}',
    '.smln-modal .note-box{margin:10px 22px;padding:10px 12px;border:1px solid rgba(255,231,0,.4);',
    'background:rgba(255,231,0,.07);border-radius:0 4px 0 4px;color:#fde68a;font-size:12px}',
    '.smln-modal footer{padding:14px 22px;border-top:1px solid rgba(100,116,139,.34);',
    'display:flex;justify-content:flex-end;gap:9px}',
    '.smln-modal button{cursor:pointer;font:inherit;font-size:12px;padding:7px 18px;',
    'border-radius:0 4px 0 4px;background:transparent;border:1px solid rgba(100,116,139,.68);color:#e2e8f0}',
    '.smln-modal button:hover{background:rgba(148,163,184,.12)}',
    '.smln-modal button.go{border-color:rgba(255,231,0,.45);color:#ffe700}',
    '.smln-modal button.go.risky{border-color:#f87171;color:#f87171}',
    '.smln-modal .prob{padding:11px 22px;border-bottom:1px solid rgba(100,116,139,.16)}',
    '.smln-modal .prob:last-child{border-bottom:0}',
    '.smln-modal .prob .ph{display:flex;gap:10px;align-items:baseline}',
    '.smln-modal .prob .code{font-size:11px;letter-spacing:.08em;color:#f87171}',
    '.smln-modal .prob.warn .code{color:#ffe700}',
    '.smln-modal .prob .who{color:#94a3b8;font-size:12px}',
    '.smln-modal .prob .msg{color:#e2e8f0;margin-top:3px;word-break:break-word}',
    '.smln-modal .prob .det{color:#64748b;font-size:11px;margin-top:4px;white-space:pre-wrap;',
    'max-height:9em;overflow:auto}',
    '.smln-modal .prob .rep{color:#64748b;font-size:11px}',
    '.smln-modal .empty{padding:34px 22px;text-align:center;color:#64748b}',
  ].join('')

  var styled = false
  function ensureStyle() {
    if (styled) return
    styled = true
    var style = global.document.createElement('style')
    style.textContent = CSS
    global.document.head.appendChild(style)
  }

  /** One reusable modal shell; the three panels differ only in content. */
  function modal(opts) {
    ensureStyle()
    var el = global.document.createElement('div')
    el.className = 'smln-modal' + (opts.wide ? ' wide' : '')

    var panel = global.document.createElement('div')
    panel.className = 'panel'

    var header = global.document.createElement('header')
    var h2 = global.document.createElement('h2')
    h2.textContent = opts.title
    header.appendChild(h2)

    var body = global.document.createElement('div')
    body.className = 'body'

    var footer = global.document.createElement('footer')

    panel.appendChild(header)
    panel.appendChild(body)
    panel.appendChild(footer)
    el.appendChild(panel)
    global.document.body.appendChild(el)

    function close() {
      global.removeEventListener('keydown', onKey, true)
      if (el.parentNode) el.parentNode.removeChild(el)
      if (opts.onClose) opts.onClose()
    }
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close() }
      ev.stopPropagation()
    }
    el.addEventListener('click', function (ev) { if (ev.target === el && opts.backdropCloses !== false) close() })
    global.addEventListener('keydown', onKey, true)
    global.setTimeout(function () { el.classList.add('open') }, 0)

    return { el: el, body: body, footer: footer, close: close }
  }

  /**
   * Guarded because the DOM harness the self-test runs against implements only
   * part of the element API, and modsui.js already guards these the same way.
   */
  function setDisabled(node, on) {
    if (!node) return
    if (on && typeof node.setAttribute === 'function') node.setAttribute('disabled', 'true')
    if (!on && typeof node.removeAttribute === 'function') node.removeAttribute('disabled')
  }

  function button(label, kind) {
    var b = global.document.createElement('button')
    b.textContent = label
    if (kind) b.className = kind
    return b
  }

  function permRow(entry) {
    var row = global.document.createElement('div')
    var risk = entry.state === 'not-requested' ? 'off' : (entry.risk || 'info')
    row.className = 'perm ' + risk + (entry.state === 'not-requested' ? ' off' : '')

    var mark = global.document.createElement('span')
    mark.className = 'mark'
    mark.textContent = MARK[entry.state] || '?'

    var box = global.document.createElement('div')
    var title = global.document.createElement('div')
    title.className = 'pt'
    title.textContent = t(entry.titleKey) !== entry.titleKey ? t(entry.titleKey) : (entry.title || entry.id)
    if (entry.isNew) {
      var tag = global.document.createElement('span')
      tag.className = 'new'
      tag.textContent = '  ' + t('perm.new')
      title.appendChild(tag)
    }
    box.appendChild(title)

    if (entry.state !== 'not-requested') {
      var desc = global.document.createElement('div')
      desc.className = 'pd'
      var d = t(entry.descriptionKey)
      desc.textContent = d !== entry.descriptionKey ? d : (entry.description || '')
      if (desc.textContent) box.appendChild(desc)
    }

    row.appendChild(mark)
    row.appendChild(box)
    return row
  }

  // ------------------------------------------------------------- 1. review
  /**
   * Ask the user to approve a permission set.
   * @returns {Promise<boolean>} true only on an explicit Install/Approve click.
   */
  function review(rev) {
    return new Promise(function (resolve) {
      var isNative = rev.capability && rev.capability.tier === 'native'
      var escalating = rev.kind === 'update' && rev.diff && rev.diff.escalation
      var answered = false

      var m = modal({
        title: t(rev.headlineKey || 'perm.installTitle'),
        // Closing without choosing is a "no", never a silent yes.
        onClose: function () { if (!answered) { answered = true; resolve(false) } },
      })

      var lead = global.document.createElement('div')
      lead.className = 'lead'
      lead.textContent = escalating
        ? t('perm.updateRequests', { name: rev.mod.name })
        : t('perm.requests', { name: rev.mod.name, version: rev.mod.version })
      m.body.appendChild(lead)

      // The native warning goes at the top, in its own box. Burying it under a
      // list of checkmarks is how people end up approving native code without
      // registering that they did.
      if (isNative) {
        var box = global.document.createElement('div')
        box.className = 'danger-box'
        var b = global.document.createElement('b')
        b.textContent = t('perm.badge.native')
        var txt = global.document.createElement('div')
        txt.textContent = t('perm.nativeWarning')
        box.appendChild(b)
        box.appendChild(txt)
        m.body.appendChild(box)
      }

      var entries = escalating
        ? rev.entries.filter(function (e) { return e.isNew || e.state !== 'not-requested' })
        : rev.entries
      for (var i = 0; i < entries.length; i++) m.body.appendChild(permRow(entries[i]))

      if (rev.legacyNative) {
        var legacy = global.document.createElement('div')
        legacy.className = 'note-box'
        legacy.textContent = t('perm.legacyNative')
        m.body.appendChild(legacy)
      }

      var cancel = button(t('common.cancel'))
      cancel.addEventListener('click', function () {
        if (answered) return
        answered = true
        resolve(false)
        m.close()
      })
      var go = button(rev.kind === 'update' ? t('perm.approve') : t('perm.install'), isNative ? 'go risky' : 'go')
      go.addEventListener('click', function () {
        if (answered) return
        answered = true
        resolve(true)
        m.close()
      })

      m.footer.appendChild(cancel)
      m.footer.appendChild(go)
      // Cancel takes focus: Install must be a deliberate click, never the
      // thing that happens when someone taps Enter.
      global.setTimeout(function () { try { cancel.focus() } catch (_e) {} }, 0)
    })
  }

  // ------------------------------------------------------------ 2. details
  /**
   * What a mod already installed can reach, and the place to grant or withdraw
   * that reach.
   *
   * Approving from here is deliberately not a bare one-click for a native mod:
   * clicking Approve on one opens the same review dialog the installer shows,
   * with the warning at the top and Cancel focused. A privileged grant should
   * cost the same deliberate confirmation wherever it is made from - otherwise
   * the details panel quietly becomes the easy way around the install warning.
   */
  function details(mod, info) {
    var cap = (info && info.capability) || mod.capability || {}
    var review = info && info.review
    var approval = info && info.approval
    var isNative = cap.tier === 'native'
    // A sandboxed mod has nothing to grant; showing it an Approve button would
    // imply it was being held back when it is already running.
    var grantable = isNative || (cap.permissions && cap.permissions.length > 0)
    var approved = !!approval && !(review && review.required)

    var m = modal({ title: t('perm.permissions'), wide: true })

    var lead = global.document.createElement('div')
    lead.className = 'lead'
    lead.textContent = (mod.name || mod.id) + '  ' + (mod.version || '')
    m.body.appendChild(lead)

    var entries = (review && review.entries) || entriesFromCapability(cap)
    for (var i = 0; i < entries.length; i++) m.body.appendChild(permRow(entries[i]))

    if (cap.enforceable === false) {
      var box = global.document.createElement('div')
      box.className = 'danger-box'
      var b = global.document.createElement('b')
      b.textContent = t('perm.badge.native')
      var txt = global.document.createElement('div')
      txt.textContent = t('perm.notEnforceable')
      box.appendChild(b)
      box.appendChild(txt)
      m.body.appendChild(box)
    }

    if (cap.reasons && cap.reasons.length) {
      var why = global.document.createElement('div')
      why.className = 'note-box'
      why.textContent = t('perm.classifiedBecause') + ' ' + cap.reasons.join('; ')
      m.body.appendChild(why)
    }

    var problems = (info && info.problems) || []
    if (problems.length) {
      var head = global.document.createElement('div')
      head.className = 'lead'
      head.textContent = t('problems.forMod', { count: problems.length })
      m.body.appendChild(head)
      for (var p = 0; p < problems.length; p++) m.body.appendChild(problemRow(problems[p]))
    }

    // --- approval state, and the buttons that change it
    var status = global.document.createElement('div')
    m.body.appendChild(status)

    function paintStatus(text, danger) {
      status.className = danger ? 'danger-box' : 'note-box'
      status.textContent = text
    }

    function refreshStatus() {
      if (!grantable) { paintStatus(t('perm.nothingToApprove')); return }
      if (approved) {
        paintStatus(t('perm.approvedAt', { at: (approval && approval.approvedAt) || '?' }))
      } else {
        paintStatus(t('perm.notApprovedYet'), isNative)
      }
    }
    refreshStatus()

    /** Keep the manager row in step without waiting for a reload. */
    function syncRow(needsApproval) {
      var list = global.__SMLN_MODS__ || []
      for (var k = 0; k < list.length; k++) {
        if (list[k].id === mod.id) { list[k].needsApproval = needsApproval; break }
      }
      mod.needsApproval = needsApproval
      if (SMLN.modsUI && typeof SMLN.modsUI.render === 'function') SMLN.modsUI.render()
    }

    var approveBtn = null
    var revokeBtn = null

    function commitApprove() {
      setDisabled(approveBtn, true)
      return SMLN.callMain('approveMod', {
        id: mod.id,
        version: mod.version,
        permissions: cap.permissions || [],
      }).then(function (r) {
        setDisabled(approveBtn, false)
        if (!r || !r.ok) {
          paintStatus(t('perm.approveFailed', { error: (r && r.error) || t('common.unknownError') }), true)
          return
        }
        approved = true
        approval = r.record || { approvedAt: new Date().toISOString() }
        syncRow(false)
        paintStatus(t('perm.approvedNow'))
        renderButtons()
      })
    }

    function onApprove() {
      // Native grants go through the full review, warning and all.
      if (isNative && review && SMLN.permUI && typeof SMLN.permUI.review === 'function') {
        return SMLN.permUI.review(review).then(function (yes) {
          if (yes) return commitApprove()
        })
      }
      return commitApprove()
    }

    function onRevoke() {
      setDisabled(revokeBtn, true)
      return SMLN.callMain('revokeMod', { id: mod.id }).then(function (r) {
        setDisabled(revokeBtn, false)
        if (!r || !r.ok) {
          paintStatus(t('perm.revokeFailed', { error: (r && r.error) || t('common.unknownError') }), true)
          return
        }
        approved = false
        approval = null
        syncRow(true)
        paintStatus(t('perm.revoked'), true)
        renderButtons()
      })
    }

    /** Rebuilt after every change so the footer always offers the one move left. */
    function renderButtons() {
      while (m.footer.firstChild) m.footer.removeChild(m.footer.firstChild)
      approveBtn = null
      revokeBtn = null

      if (grantable && !approved) {
        approveBtn = button(t('perm.approve'), isNative ? 'go risky' : 'go')
        approveBtn.addEventListener('click', onApprove)
        m.footer.appendChild(approveBtn)
      }
      if (grantable && approved) {
        revokeBtn = button(t('perm.revoke'))
        revokeBtn.addEventListener('click', onRevoke)
        m.footer.appendChild(revokeBtn)
      }

      var close = button(t('common.close'))
      close.addEventListener('click', m.close)
      m.footer.appendChild(close)
    }
    renderButtons()

    return m
  }

  /** Fallback when the main process only gave us a capability. */
  function entriesFromCapability(cap) {
    var granted = cap.granted || {}
    var contexts = cap.contexts || {}
    var out = [
      { id: 'game', titleKey: 'perm.game.title', descriptionKey: 'perm.game.desc', risk: 'info',
        state: contexts.game ? 'granted' : 'not-requested' },
      { id: 'worker', titleKey: 'perm.worker.title', descriptionKey: 'perm.worker.desc', risk: 'info',
        state: contexts.worker ? 'granted' : 'not-requested' },
      { id: 'filesystem', titleKey: 'perm.filesystem.title', descriptionKey: 'perm.filesystem.desc', risk: 'warn',
        state: granted.filesystem ? 'requested' : 'not-requested' },
      { id: 'network', titleKey: 'perm.network.title', descriptionKey: 'perm.network.desc', risk: 'warn',
        state: granted.network ? 'requested' : 'not-requested' },
      { id: 'node', titleKey: 'perm.node.title', descriptionKey: 'perm.node.desc', risk: 'danger',
        state: granted.node ? 'requested' : 'not-requested' },
    ]
    return out
  }

  // ------------------------------------------------------------ 3. problems
  function problemRow(p) {
    var row = global.document.createElement('div')
    row.className = 'prob' + (p.severity === 'warn' ? ' warn' : '')

    var head = global.document.createElement('div')
    head.className = 'ph'
    var code = global.document.createElement('span')
    code.className = 'code'
    code.textContent = p.code || 'E_UNKNOWN'
    var who = global.document.createElement('span')
    who.className = 'who'
    who.textContent = (p.modId ? p.modId : p.scope || 'smln')
    head.appendChild(code)
    head.appendChild(who)
    if (p.count > 1) {
      var rep = global.document.createElement('span')
      rep.className = 'rep'
      rep.textContent = t('problems.repeated', { count: p.count })
      head.appendChild(rep)
    }

    var msg = global.document.createElement('div')
    msg.className = 'msg'
    msg.textContent = p.message || ''

    row.appendChild(head)
    row.appendChild(msg)

    if (p.detail) {
      var det = global.document.createElement('div')
      det.className = 'det'
      det.textContent = p.detail
      row.appendChild(det)
    }
    return row
  }

  /**
   * The problem log. Reads the snapshot injected at build time first so it
   * shows something even if the RPC bridge is unavailable, then refreshes.
   */
  function problems() {
    var m = modal({ title: t('problems.title'), wide: true })

    function paint(data) {
      while (m.body.firstChild) m.body.removeChild(m.body.firstChild)
      var list = (data && data.problems) || []
      var sum = (data && data.summary) || { errors: 0, warnings: 0 }

      var lead = global.document.createElement('div')
      lead.className = 'lead'
      lead.textContent = list.length
        ? t('problems.summary', { errors: sum.errors, warnings: sum.warnings })
        : ''
      if (lead.textContent) m.body.appendChild(lead)

      if (!list.length) {
        var empty = global.document.createElement('div')
        empty.className = 'empty'
        empty.textContent = t('problems.none')
        m.body.appendChild(empty)
        return
      }
      for (var i = 0; i < list.length; i++) m.body.appendChild(problemRow(list[i]))
    }

    paint(global.__SMLN_PROBLEMS__)
    SMLN.callMain('getProblems', {}).then(function (r) {
      if (r && r.ok) paint({ problems: r.problems, summary: r.summary })
    })

    var close = button(t('common.close'))
    close.addEventListener('click', m.close)
    m.footer.appendChild(close)
    return m
  }

  SMLN.permUI = {
    review: review,
    details: details,
    problems: problems,
    entriesFromCapability: entriesFromCapability,
    /** Exposed for the self-test. */
    _modal: modal,
  }
})(typeof globalThis !== 'undefined' ? globalThis : window)
