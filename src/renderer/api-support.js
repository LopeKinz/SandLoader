/* eslint-env browser */
'use strict'
/**
 * Resolve each mod's declared Sandkit usage against the API this build really
 * has, so the manager can name what is missing.
 *
 * The scan itself happens in the main process (src/mods/api-scan.js), which can
 * read mod sources. Only the renderer can answer whether a namespace exists,
 * because only here does the live, adapted API object exist. So the two halves
 * meet here: `mod.apiUsage` comes down with the mod metadata, and this file
 * checks it once the game is ready.
 *
 * Checked against `SMLN.api` - the adapted surface - not the raw sandkit. A
 * call the adapter aliases (v1 `createAtCellWhenIdle` onto legacy `createAt`)
 * genuinely works, so counting it as missing would be wrong.
 */
;(function installApiSupport(global) {
  var SMLN = global.__SMLN__
  if (!SMLN || SMLN.apiSupport) return

  /** Fields that are not API namespaces; mirrors api-scan.js NON_NAMESPACE. */
  var NON_NAMESPACE = { api: 1, apiVersion: 1, state: 1, engine: 1, enums: 1, react: 1, settings: 1 }

  var results = Object.create(null)
  var resolved = false

  function compare(usage, api) {
    var missingNamespaces = []
    var missingMethods = []

    if (!usage || !usage.namespaces) return { missingNamespaces: [], missingMethods: [], ok: true }
    if (!api || typeof api !== 'object') {
      // Without an API there is nothing to prove. Say "inconclusive" rather
      // than reporting everything as broken - the capture failure is its own
      // problem and has its own report.
      return { missingNamespaces: [], missingMethods: [], ok: true, inconclusive: true }
    }

    for (var ns in usage.namespaces) {
      if (!Object.prototype.hasOwnProperty.call(usage.namespaces, ns)) continue
      if (NON_NAMESPACE[ns]) continue

      var live = api[ns]
      if (!live || typeof live !== 'object') { missingNamespaces.push(ns); continue }

      var wanted = usage.namespaces[ns] || []
      var gone = []
      for (var i = 0; i < wanted.length; i++) {
        if (typeof live[wanted[i]] !== 'function') gone.push(wanted[i])
      }
      if (gone.length) missingMethods.push({ ns: ns, methods: gone })
    }

    missingNamespaces.sort()
    missingMethods.sort(function (a, b) { return a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0 })
    return {
      missingNamespaces: missingNamespaces,
      missingMethods: missingMethods,
      ok: missingNamespaces.length === 0 && missingMethods.length === 0,
    }
  }

  /** "effects, tech" / "structures.forEachOfType" - or null when nothing is missing. */
  function summarise(r) {
    if (!r || r.ok || r.inconclusive) return null
    var parts = []
    if (r.missingNamespaces.length) parts.push(r.missingNamespaces.join(', '))
    for (var i = 0; i < r.missingMethods.length; i++) {
      parts.push(r.missingMethods[i].ns + '.' + r.missingMethods[i].methods.join('/'))
    }
    return parts.join(', ')
  }

  function resolveAll() {
    var mods = (SMLN.getMods && SMLN.getMods()) || SMLN.mods || []
    var api = SMLN.api || SMLN.sandkit
    var unsupported = 0

    for (var i = 0; i < mods.length; i++) {
      var m = mods[i]
      if (!m || !m.id || !m.apiUsage) continue
      var r = compare(m.apiUsage, api)
      results[m.id] = r
      if (!r.ok) {
        unsupported++
        SMLN.log('warn', '[' + m.id + '] this build lacks: ' + summarise(r))
      }
    }

    resolved = true
    if (unsupported) {
      SMLN.log('warn', unsupported + ' mod(s) call Sandkit namespaces this game build does not provide')
    }
    return results
  }

  SMLN.apiSupport = {
    /** Result for one mod, or null if it was never scanned. */
    get: function (id) { return results[id] || null },
    /** Short human-readable line, or null when everything resolves. */
    summarise: function (id) { return summarise(results[id]) },
    all: function () { return results },
    isResolved: function () { return resolved },
    /** Exposed for the self-test. */
    compare: compare,
  }

  if (typeof SMLN.on === 'function') SMLN.on('ready', function () { resolveAll() })
})(typeof globalThis !== 'undefined' ? globalThis : window)
