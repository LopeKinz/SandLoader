/* eslint-env browser */
'use strict'
/**
 * SandLoader UI translation runtime. Installs `SMLN.i18n`.
 *
 * There is no framework here on purpose: the whole renderer is a handful of
 * concatenated ES5-ish files with no build step (see prelude.js), so pulling
 * in an i18n library would mean bundling one by hand. The actual job is
 * small - pick a locale, look a key up in a flat table, fill in `{name}`
 * placeholders - and does not need one.
 *
 * Locale selection, in priority order, decided once at install and possibly
 * revised once (see below):
 *
 *   1. An explicit SandLoader preference, `global.__SMLN_LOCALE__`, which the
 *      main process injects into the prelude ahead of this file (may be
 *      absent - first run, or a build that has not wired it up yet).
 *   2. Sandustry's own active locale, if the game exposes it reliably. `FH`
 *      (published here as `SMLN.game`) does not exist until the core patch
 *      calls `__capture` at `game:ready` - long after this file has already
 *      run - so this cannot be checked at install time. It is re-checked
 *      once, from the runtime's `ready` event, and only takes effect if step
 *      1 did not already set an explicit preference.
 *   3. `navigator.language`, reduced to its primary subtag (`de-AT` -> `de`).
 *   4. `'en'`.
 *
 * Fallback chain for a single lookup: active locale -> English -> the key
 * itself. A miss must never surface as the literal string "undefined" - that
 * is worse than showing an untranslated key, because a key at least tells a
 * developer what to go fill in.
 *
 * No HTML escaping happens in `t()`. Every call site in this codebase assigns
 * the result to `.textContent` (see modsui.js, splash.js), never to
 * `innerHTML`, so there is nothing here that ends up parsed as markup -
 * escaping it anyway would just double-encode a `&` a translator typed.
 *
 * Mod-supplied strings - a mod's own name, id or description - are never
 * routed through `t()`. Those belong to the mod's author; running them
 * through this catalogue would either do nothing (no matching key, silently
 * returns the string unchanged only because `t()` is never called on them)
 * or, worse, invite a future contributor to add a key for someone else's
 * product name. Only SandLoader's own UI chrome lives in locales.js.
 */
;(function installSmlnI18n(global) {
  var SMLN = global.__SMLN__
  if (!SMLN || SMLN.i18n) return

  var LOCALES = global.__SMLN_LOCALES__ || {}
  var FALLBACK = 'en'
  var changeListeners = []
  var warnedMissing = Object.create(null) // key -> true; a miss logs once, never per render.

  function hasLocale(code) {
    return !!(code && Object.prototype.hasOwnProperty.call(LOCALES, code))
  }

  function availableCodes() {
    var out = []
    for (var k in LOCALES) if (Object.prototype.hasOwnProperty.call(LOCALES, k)) out.push(k)
    return out
  }

  /** 'de-AT' -> 'de'; tolerates anything, including garbage or nothing. */
  function primarySubtag(tag) {
    if (!tag || typeof tag !== 'string') return ''
    return tag.split(/[-_]/)[0].toLowerCase()
  }

  function pickInitialLocale() {
    try {
      if (hasLocale(global.__SMLN_LOCALE__)) return global.__SMLN_LOCALE__
    } catch (_) { /* reading a global should never throw, but nothing here may either */ }
    try {
      var nav = primarySubtag(global.navigator && global.navigator.language)
      if (hasLocale(nav)) return nav
    } catch (_) {}
    return FALLBACK
  }

  var active = pickInitialLocale()
  // True once a preference was set deliberately (step 1 above, or a later
  // setLocale() call) - guards the one-time game-locale check below so it can
  // only ever upgrade an unopinionated guess, never override a real choice.
  var explicitPreference = hasLocale(global.__SMLN_LOCALE__)

  /**
   * Re-check against Sandustry's own locale once the game API is captured.
   * `SMLN.game` is null until then, so this cannot run any earlier than the
   * runtime's `ready` event.
   */
  function reevaluateAfterCapture() {
    if (explicitPreference) return
    try {
      if (SMLN.game && SMLN.game.i18n && typeof SMLN.game.i18n.getLocale === 'function') {
        var gameLocale = primarySubtag(SMLN.game.i18n.getLocale())
        if (hasLocale(gameLocale) && gameLocale !== active) {
          active = gameLocale
          notifyChange()
        }
      }
    } catch (e) {
      SMLN.log && SMLN.log('warn', 'i18n: reading the game locale failed: ' + (e && e.message))
    }
  }
  if (typeof SMLN.on === 'function') SMLN.on('ready', reevaluateAfterCapture)

  function lookupRaw(code, key) {
    var table = LOCALES[code]
    if (!table) return undefined
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined
  }

  function warnMissing(key) {
    if (warnedMissing[key]) return
    warnedMissing[key] = true
    SMLN.log && SMLN.log('debug', 'i18n: no translation for "' + key + '"')
  }

  /**
   * Resolve the raw (un-interpolated) template for `key`, applying the
   * `key.one` / `key.other` plural convention when `params.count` is given,
   * then the active -> English fallback. Returns undefined only when neither
   * locale has anything for any candidate.
   */
  function resolveTemplate(key, params) {
    var candidates = [key]
    if (params && typeof params === 'object' && params.count !== undefined && params.count !== null) {
      var n = Number(params.count)
      candidates = [isFinite(n) && Math.abs(n) === 1 ? key + '.one' : key + '.other', key]
    }
    for (var i = 0; i < candidates.length; i++) {
      var v = lookupRaw(active, candidates[i])
      if (v !== undefined) return v
    }
    if (active !== FALLBACK) {
      for (var j = 0; j < candidates.length; j++) {
        var v2 = lookupRaw(FALLBACK, candidates[j])
        if (v2 !== undefined) return v2
      }
    }
    return undefined
  }

  /** `{name}` -> params.name. A placeholder with no matching param is left as-is. */
  function interpolate(template, params) {
    if (!params || typeof params !== 'object') return template
    return template.replace(/\{([^{}]+)\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    })
  }

  /**
   * Translate `key`. Never throws, on any input including `null`.
   * Fallback chain: active locale -> English -> the key itself.
   */
  function t(key, params) {
    try {
      if (typeof key !== 'string' || !key) return key == null ? '' : String(key)
      var template = resolveTemplate(key, params)
      if (template === undefined) {
        warnMissing(key)
        return key
      }
      return interpolate(String(template), params)
    } catch (e) {
      try { SMLN.log && SMLN.log('error', 'i18n.t("' + key + '") failed: ' + (e && e.message)) } catch (_) {}
      return typeof key === 'string' ? key : ''
    }
  }

  function has(key) {
    if (typeof key !== 'string' || !key) return false
    return lookupRaw(active, key) !== undefined || lookupRaw(FALLBACK, key) !== undefined
  }

  function locale() { return active }

  function locales() {
    return availableCodes().map(function (code) {
      var meta = (LOCALES[code] && LOCALES[code].__meta) || {}
      return {
        code: meta.code || code,
        nativeName: meta.nativeName || code,
        englishName: meta.englishName || code,
      }
    })
  }

  function notifyChange() {
    for (var i = 0; i < changeListeners.length; i++) {
      try { changeListeners[i](active) } catch (e) {
        // A listener is UI code the mod/UI layer supplied; it must not be
        // able to wedge every other listener out of a language switch.
        SMLN.log && SMLN.log('error', 'i18n onChange listener threw: ' + (e && e.message))
      }
    }
  }

  /**
   * Switch the active locale, persist the choice on the main process, and
   * notify subscribers so they can re-render. Unknown codes degrade to
   * English rather than being rejected - there is no wrong input here that
   * should be able to leave the UI mid-switch.
   */
  function setLocale(code) {
    if (!hasLocale(code)) code = FALLBACK
    explicitPreference = true
    var changed = code !== active
    active = code
    try {
      if (typeof SMLN.callMain === 'function') SMLN.callMain('setLoaderLocale', { locale: code })
    } catch (e) {
      SMLN.log && SMLN.log('warn', 'i18n: could not persist locale: ' + (e && e.message))
    }
    if (changed) notifyChange()
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return function () {}
    changeListeners.push(fn)
    return function off() {
      var i = changeListeners.indexOf(fn)
      if (i >= 0) changeListeners.splice(i, 1)
    }
  }

  /** Best-effort locale-aware number formatting; plain String() if Intl is missing. */
  function format(n) {
    try {
      if (typeof Intl !== 'undefined' && Intl.NumberFormat) return new Intl.NumberFormat(active).format(n)
    } catch (_) {}
    return String(n)
  }

  SMLN.i18n = {
    t: t,
    has: has,
    locale: locale,
    setLocale: setLocale,
    locales: locales,
    onChange: onChange,
    format: format,
  }

  SMLN.log && SMLN.log('info', 'i18n installed, locale=' + active)
})(typeof globalThis !== 'undefined' ? globalThis : window)
