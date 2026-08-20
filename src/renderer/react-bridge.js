/* eslint-env browser */
'use strict'
/**
 * Hand the game's own React to mods that draw UI.
 *
 * Official Sandkit mods receive `sandkit.react` and immediately destructure it:
 *
 *   const React = sandkit.react
 *   const h = React.createElement      // top level, so null throws instantly
 *
 * The game bundles React 18.3.1 as a webpack module and never puts it on a
 * global, so `global.React` is undefined and `sandkit.react` was null. Six of
 * the eleven bundled mods died on exactly that line - the whole entry, before
 * any of their own logic ran.
 *
 * Mods must get the *same* React instance the game renders with. A second copy
 * would have its own dispatcher, and any hook called from a mod component would
 * throw "invalid hook call" - so bundling our own React is not an option.
 *
 * Webpack's chunk array is the supported way in. Pushing a chunk whose third
 * element is a callback hands us the real `__webpack_require__`, from which we
 * pull the live module out of the running instance's cache:
 *
 *   webpackChunksand_v1.push([[id], {}, (req) => { React = req(MODULE) }])
 *
 * The module id is found by probing rather than hardcoded: minified ids are
 * regenerated on every game build, so `74159` is true for 0.5.5 and a liability
 * afterwards. We look for the module whose exports actually look like React,
 * and only fall back to known ids if the scan finds nothing.
 */
;(function installReactBridge(global) {
  var SMLN = global.__SMLN__
  if (!SMLN || SMLN.react) return

  /** Known entry ids, newest build first. Only a fallback for the shape scan. */
  var KNOWN_IDS = [74159, 15287]

  /** react-dom client entry ids, same fallback role. */
  var KNOWN_DOM_IDS = [40961]

  /** Does this object quack like react-dom/client? */
  function isReactDom(m) {
    return !!m && (typeof m.createRoot === 'function' || typeof m.render === 'function')
  }

  /** Does this object quack like the React package entry? */
  function isReact(m) {
    return !!m &&
      typeof m.createElement === 'function' &&
      typeof m.useState === 'function' &&
      // Distinguish React itself from react-dom / jsx-runtime, which also
      // export createElement-adjacent helpers but never Component + Fragment.
      (typeof m.Component === 'function' || m.Fragment != null)
  }

  /**
   * Find React and react-dom in the game's module graph.
   *
   * Shape checks rather than ids: minified ids change every build, so the known
   * ids are only a fast path. See webpack-bridge.js for the mechanics.
   */
  function extract() {
    if (!SMLN.webpack || !SMLN.webpack.available()) {
      return { react: null, dom: null, why: (SMLN.webpack && SMLN.webpack.why()) || 'no webpack bridge' }
    }
    var react = SMLN.webpack.find(isReact, KNOWN_IDS)
    var dom = SMLN.webpack.find(isReactDom, KNOWN_DOM_IDS)
    return { react: react, dom: dom, why: react ? null : 'no React-shaped module found' }
  }

  /**
   * Resolved lazily and cached. The bundle must have executed before its
   * modules exist, and this file is injected *ahead* of the bundle, so probing
   * at install time would always fail.
   */
  var cached = null
  var cachedDom = null
  var attempted = false

  function resolve() {
    if (attempted) return
    attempted = true

    // An explicit global wins: a future build exposing React deliberately
    // should be believed over our archaeology.
    if (isReact(global.React)) cached = global.React
    if (isReactDom(global.ReactDOM)) cachedDom = global.ReactDOM
    if (cached && cachedDom) return

    var out = extract()
    cached = cached || out.react
    cachedDom = cachedDom || out.dom

    if (cached) {
      SMLN.log('info', 'react bridge ready (React ' + (cached.version || 'unknown') +
        ', react-dom ' + (cachedDom ? 'available' : 'unavailable') + ')')
    } else {
      SMLN.log('warn', 'react bridge could not reach the game React: ' + out.why +
        ' - mods that draw UI will not start')
    }
  }

  function getReact() {
    if (!cached) resolve()
    return cached
  }

  function getReactDom() {
    if (!cachedDom) resolve()
    return cachedDom
  }

  SMLN.react = { get: getReact, dom: getReactDom, isReact: isReact }

  // Resolve once the bundle has run, so the first mod to ask does not pay for
  // the scan and any failure is reported at a predictable point.
  if (typeof SMLN.on === 'function') SMLN.on('ready', function () { getReact() })

  SMLN.log('info', 'react bridge installed')
})(typeof globalThis !== 'undefined' ? globalThis : window)
