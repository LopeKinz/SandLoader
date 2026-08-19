/* eslint-env browser */
'use strict'
/**
 * Per-mod settings panel, driven by the mod's `configSchema`.
 *
 * The schema is normalised and the values are validated in the main process
 * (src/mods/config.js). This file deliberately does not re-implement that
 * validation: two validators drift, and the one that matters is the one
 * guarding the file on disk. It renders controls, sends the value, and shows
 * whatever the main process says went wrong.
 *
 * Every string is built with `textContent`, never `innerHTML`. Labels,
 * descriptions and error text all originate in a mod manifest, which is
 * untrusted input; interpolating it into markup would make a settings panel an
 * injection point.
 */
;(function installSmlnSettingsUI(global) {
  var SMLN = global.__SMLN__
  if (!SMLN || SMLN.settingsUI) return

  /** Commit delay for free-text and number fields, in ms. */
  var COMMIT_DEBOUNCE = 400

  var overlay = null
  var current = null   // {mod, schema, order, values, defaults}

  function t(key, params) {
    if (SMLN.i18n && typeof SMLN.i18n.t === 'function') return SMLN.i18n.t(key, params)
    return key
  }

  var CSS = [
    '#smln-settings{position:fixed;inset:0;z-index:2147483450;display:none;',
    'align-items:center;justify-content:center;background:rgba(3,6,10,.72);',
    "font-family:'SMLN Play',system-ui,sans-serif;font-size:14px;line-height:1.55;color:#e2e8f0}",
    '#smln-settings.open{display:flex}',
    '#smln-settings .panel{width:min(620px,92vw);max-height:82vh;display:flex;flex-direction:column;',
    'background:rgba(8,12,17,.97);border:1px solid rgba(100,116,139,.68);',
    'border-radius:0 8px 0 8px;box-shadow:0 4px 12px rgba(0,0,0,.28)}',
    '#smln-settings header{display:flex;align-items:baseline;justify-content:space-between;',
    'padding:18px 22px;border-bottom:1px solid rgba(100,116,139,.34)}',
    '#smln-settings h2{margin:0;font-size:15px;font-weight:700;letter-spacing:.14em;',
    'text-transform:uppercase;color:#ffe700}',
    '#smln-settings .sub{color:#64748b;font-size:12px}',
    '#smln-settings .body{overflow-y:auto;padding:6px 0}',
    '#smln-settings .field{padding:12px 22px;border-bottom:1px solid rgba(100,116,139,.16)}',
    '#smln-settings .field:last-child{border-bottom:0}',
    '#smln-settings .frow{display:flex;align-items:center;gap:14px}',
    '#smln-settings .flabel{flex:1;min-width:0}',
    '#smln-settings .fname{color:#f1f5f9}',
    '#smln-settings .fdesc{color:#64748b;font-size:12px}',
    '#smln-settings .ferr{color:#f87171;font-size:12px;margin-top:5px}',
    '#smln-settings .fnote{color:#ffe700;font-size:11px;margin-top:4px}',
    '#smln-settings input[type=text],#smln-settings input[type=number],#smln-settings select{',
    'background:rgba(2,6,10,.85);border:1px solid rgba(100,116,139,.55);color:#e2e8f0;',
    'font:inherit;font-size:13px;padding:5px 8px;border-radius:0 4px 0 4px;min-width:150px}',
    '#smln-settings input.bad,#smln-settings select.bad{border-color:#f87171}',
    '#smln-settings input[type=checkbox]{width:16px;height:16px;accent-color:#ffe700}',
    '#smln-settings .reset{cursor:pointer;border:1px solid rgba(100,116,139,.55);background:transparent;',
    'color:#94a3b8;font:inherit;font-size:11px;padding:4px 10px;border-radius:0 4px 0 4px}',
    '#smln-settings .reset:hover{background:rgba(148,163,184,.12)}',
    '#smln-settings footer{padding:14px 22px;border-top:1px solid rgba(100,116,139,.34);',
    'display:flex;justify-content:space-between;align-items:center;gap:16px}',
    '#smln-settings .note{color:#64748b;font-size:12px}',
    '#smln-settings .note.warn{color:#ffe700}',
    '#smln-settings .actions{display:flex;gap:9px}',
    '#smln-settings button.act{cursor:pointer;border:1px solid rgba(100,116,139,.68);background:transparent;',
    'color:#e2e8f0;font:inherit;font-size:12px;padding:6px 16px;border-radius:0 4px 0 4px}',
    '#smln-settings button.act:hover{background:rgba(148,163,184,.12)}',
    '#smln-settings .empty{padding:34px 22px;text-align:center;color:#64748b}',
  ].join('')

  function build() {
    var style = global.document.createElement('style')
    style.textContent = CSS
    global.document.head.appendChild(style)

    overlay = global.document.createElement('div')
    overlay.id = 'smln-settings'

    var panel = global.document.createElement('div')
    panel.className = 'panel'

    var header = global.document.createElement('header')
    var h2 = global.document.createElement('h2')
    var sub = global.document.createElement('span')
    sub.className = 'sub'
    header.appendChild(h2)
    header.appendChild(sub)

    var body = global.document.createElement('div')
    body.className = 'body'

    var footer = global.document.createElement('footer')
    var note = global.document.createElement('span')
    note.className = 'note'
    var actions = global.document.createElement('div')
    actions.className = 'actions'

    var resetAll = global.document.createElement('button')
    resetAll.className = 'act'
    resetAll.addEventListener('click', function () { doResetAll() })

    var close = global.document.createElement('button')
    close.className = 'act'
    close.addEventListener('click', function () { toggle(false) })

    actions.appendChild(resetAll)
    actions.appendChild(close)
    footer.appendChild(note)
    footer.appendChild(actions)

    panel.appendChild(header)
    panel.appendChild(body)
    panel.appendChild(footer)
    overlay.appendChild(panel)
    global.document.body.appendChild(overlay)

    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) toggle(false) })

    overlay._title = h2
    overlay._sub = sub
    overlay._body = body
    overlay._note = note
    overlay._resetAll = resetAll
    overlay._close = close
  }

  function onKey(ev) {
    if (!overlay || !overlay.classList.contains('open')) return
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      toggle(false)
    }
    // The game listens on window for movement keys; a settings field must not
    // walk the player around while it is being typed into.
    ev.stopPropagation()
  }

  // ------------------------------------------------------------- rendering
  function specOf(schema, key) {
    var s = schema && schema[key]
    return s && typeof s === 'object' ? s : {}
  }

  function typeOf(spec) {
    if (spec.type) return String(spec.type).toLowerCase()
    if (spec.values || spec.options) return 'enum'
    if (typeof spec.default === 'boolean') return 'boolean'
    if (typeof spec.default === 'number') return Number.isInteger(spec.default) ? 'integer' : 'number'
    return 'string'
  }

  function valuesOf(spec) {
    var v = spec.values || spec.options || []
    return Object.prototype.toString.call(v) === '[object Array]' ? v : []
  }

  function renderField(key, spec, value) {
    var type = typeOf(spec)
    var field = global.document.createElement('div')
    field.className = 'field'

    var row = global.document.createElement('div')
    row.className = 'frow'

    var labelBox = global.document.createElement('div')
    labelBox.className = 'flabel'
    var name = global.document.createElement('div')
    name.className = 'fname'
    name.textContent = spec.label || key
    labelBox.appendChild(name)
    if (spec.description) {
      var desc = global.document.createElement('div')
      desc.className = 'fdesc'
      desc.textContent = spec.description
      labelBox.appendChild(desc)
    }

    var input
    if (type === 'boolean') {
      input = global.document.createElement('input')
      input.type = 'checkbox'
      input.checked = value === true
      input.addEventListener('change', function () { commit(key, input.checked, field, input, true) })
    } else if (type === 'enum' || type === 'select') {
      input = global.document.createElement('select')
      var list = valuesOf(spec)
      for (var i = 0; i < list.length; i++) {
        var opt = global.document.createElement('option')
        opt.value = String(list[i])
        opt.textContent = String(list[i])
        if (String(list[i]) === String(value)) opt.selected = true
        input.appendChild(opt)
      }
      input.addEventListener('change', function () { commit(key, input.value, field, input, true) })
    } else if (type === 'number' || type === 'integer') {
      input = global.document.createElement('input')
      input.type = 'number'
      if (spec.min != null) input.min = String(spec.min)
      if (spec.max != null) input.max = String(spec.max)
      input.step = spec.step != null ? String(spec.step) : (type === 'integer' ? '1' : 'any')
      input.value = value == null ? '' : String(value)
      debounced(input, key, field)
    } else {
      input = global.document.createElement('input')
      input.type = 'text'
      input.value = value == null ? '' : String(value)
      debounced(input, key, field)
    }

    var reset = global.document.createElement('button')
    reset.className = 'reset'
    reset.textContent = t('settings.reset')
    reset.addEventListener('click', function () { doReset(key) })

    row.appendChild(labelBox)
    row.appendChild(input)
    row.appendChild(reset)
    field.appendChild(row)
    field._input = input
    return field
  }

  /**
   * Typing must not fire one RPC per keystroke, but leaving the panel must not
   * lose the last edit either - so blur commits immediately as well.
   */
  function debounced(input, key, field) {
    var timer = null
    input.addEventListener('input', function () {
      if (timer) global.clearTimeout(timer)
      timer = global.setTimeout(function () {
        timer = null
        commit(key, input.value, field, input, false)
      }, COMMIT_DEBOUNCE)
    })
    input.addEventListener('blur', function () {
      if (timer) { global.clearTimeout(timer); timer = null }
      commit(key, input.value, field, input, false)
    })
  }

  function showFieldError(field, input, reason) {
    var old = field.querySelector('.ferr')
    if (old) field.removeChild(old)
    if (!reason) { input.className = input.className.replace(/\bbad\b/g, '').trim(); return }
    input.className = (input.className ? input.className + ' ' : '') + 'bad'
    var err = global.document.createElement('div')
    err.className = 'ferr'
    err.textContent = reason
    field.appendChild(err)
  }

  function showFieldNote(field, text) {
    var old = field.querySelector('.fnote')
    if (old) field.removeChild(old)
    if (!text) return
    var n = global.document.createElement('div')
    n.className = 'fnote'
    n.textContent = text
    field.appendChild(n)
  }

  function commit(key, value, field, input) {
    if (!current) return Promise.resolve()
    return SMLN.callMain('setModConfig', { mod: current.mod.id, id: current.mod.id, key: key, value: value })
      .then(function (r) {
        if (!r || !r.ok) {
          // Keep what the user typed - reverting it loses their work and
          // hides which value was rejected.
          showFieldError(field, input, (r && (r.reason || r.error)) || t('settings.invalidValue'))
          return
        }
        showFieldError(field, input, null)
        current.values[key] = r.value
        if (r.requiresReload) {
          showFieldNote(field, t('settings.restartRequired'))
          markReloadNeeded()
        }
      })
  }

  var reloadNeeded = false
  function markReloadNeeded() {
    reloadNeeded = true
    overlay._note.className = 'note warn'
    overlay._note.textContent = t('settings.reloadNotice')
  }

  function doReset(key) {
    if (!current) return
    SMLN.callMain('resetModConfig', { mod: current.mod.id, id: current.mod.id, key: key })
      .then(function (r) { if (r && r.ok) { current.values = r.values || current.values; render() } })
  }

  function doResetAll() {
    if (!current) return
    SMLN.callMain('resetModConfig', { mod: current.mod.id, id: current.mod.id })
      .then(function (r) { if (r && r.ok) { current.values = r.values || {}; render() } })
  }

  function render() {
    var body = overlay._body
    while (body.firstChild) body.removeChild(body.firstChild)

    overlay._title.textContent = t('settings.title')
    overlay._sub.textContent = current ? (current.mod.name || current.mod.id) : ''
    overlay._resetAll.textContent = t('settings.resetAll')
    overlay._close.textContent = t('common.close')
    if (!reloadNeeded) {
      overlay._note.className = 'note'
      overlay._note.textContent = ''
    }

    if (!current) return
    var order = current.order && current.order.length ? current.order : Object.keys(current.schema || {})
    var visible = []
    for (var i = 0; i < order.length; i++) {
      var spec = specOf(current.schema, order[i])
      if (spec.hidden) continue
      visible.push(order[i])
    }

    if (!visible.length) {
      var empty = global.document.createElement('div')
      empty.className = 'empty'
      empty.textContent = t('settings.noSettings')
      body.appendChild(empty)
      return
    }

    for (var j = 0; j < visible.length; j++) {
      var key = visible[j]
      var s = specOf(current.schema, key)
      var value = current.values && Object.prototype.hasOwnProperty.call(current.values, key)
        ? current.values[key]
        : s.default
      body.appendChild(renderField(key, s, value))
    }
  }

  function open(mod) {
    if (!overlay) build()
    reloadNeeded = false
    current = null
    render()
    toggle(true)

    return SMLN.callMain('getModConfig', { mod: mod.id, id: mod.id }).then(function (r) {
      if (!r || !r.ok) {
        var body = overlay._body
        while (body.firstChild) body.removeChild(body.firstChild)
        var err = global.document.createElement('div')
        err.className = 'empty'
        err.textContent = t('settings.loadFailed', { error: (r && r.error) || t('common.unknownError') })
        body.appendChild(err)
        return { ok: false }
      }
      current = {
        mod: mod,
        schema: r.schema || {},
        order: r.order || [],
        values: r.values || {},
        defaults: r.defaults || {},
      }
      render()
      return { ok: true }
    })
  }

  function toggle(force) {
    if (!overlay) build()
    var next = force == null ? !overlay.classList.contains('open') : !!force
    overlay.classList.toggle('open', next)
    if (next) global.addEventListener('keydown', onKey, true)
    else global.removeEventListener('keydown', onKey, true)
  }

  SMLN.settingsUI = {
    open: open,
    close: function () { toggle(false) },
    isOpen: function () { return !!overlay && overlay.classList.contains('open') },
    /** Exposed for the self-test. */
    _current: function () { return current },
  }
})(typeof globalThis !== 'undefined' ? globalThis : window)
