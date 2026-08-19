'use strict'
/**
 * Main-process half of the mod execution boundary: builds the wrapper text
 * put around a renderer mod's source, and the ergonomic context object
 * handed to a native (main-process) mod's `setup()`.
 *
 * Read this before anything else in this file, because it decides what the
 * two exports below are allowed to claim:
 *
 *   - Sandustry's renderer runs with Electron's modern defaults
 *     (contextIsolation:true, nodeIntegration:false, no sandbox:false). A
 *     renderer ("game") mod therefore has NO Node - no `require`, `process`,
 *     `Buffer`, `module` - full stop, enforced by Chromium before a single
 *     line of SandLoader code runs. `wrapRendererMod` below does not, and
 *     could not, add that guarantee; it is already true of the page.
 *   - What the page *does* have that is privileged is `window.electron` (the
 *     contextBridge surface) and `SMLN.callMain` (SandLoader's own RPC to the
 *     main process). `wrapRendererMod` gives each mod a lexically-scoped
 *     `SMLN`/`__SMLN__` that is a capability facade (built in
 *     src/renderer/capabilities.js), not the real runtime object, so a mod
 *     that behaves and only reaches its own `SMLN` parameter never sees
 *     `callMain` or `window.electron` at all.
 *   - That said: renderer mod sources are concatenated into one script (see
 *     src/renderer/prelude.js). The wrapper is a lexical *convention* - it
 *     changes what a well-behaved mod's own top-level code resolves `SMLN`
 *     to - not a hard wall. A mod that deliberately writes
 *     `globalThis.__SMLN__.callMain` (the real one, reached by name instead
 *     of through the shadowed local) still finds it, because deleting or
 *     hiding the real object would break SandLoader's own console, splash and
 *     mods-UI, which all need it. The hard boundary for a renderer mod is
 *     Chromium's absence of Node; this wrapper is about making the *right*
 *     default surface the easy path, and capability checks the normal one -
 *     not about containing a mod that is already trying to misbehave.
 *   - The genuinely privileged execution class is the main process: an SMLN
 *     `main` entrypoint (loaded with a real `require`, via src/mods/loader.js
 *     `loadMain`) and a Fluxloader `electronEntrypoint` (run through Node's
 *     `vm` module with real `require`/`process`/`Buffer` handed into the
 *     sandbox object by src/compat/fluxloader.js). Both are NATIVE. `vm` is
 *     not a security boundary there - the script gets literal Node - and
 *     `createNativeContext` below never claims otherwise: it is an ergonomic,
 *     auditable surface for a mod that already has everything, not a
 *     restriction on it. Omitting a field from that context stops nothing;
 *     the mod can `require()` the same thing itself.
 *
 * See src/mods/permissions.js for the tier/permission model this file reads
 * (`classify()`'s output, called a "capability" throughout) and never
 * redefines.
 */

const { SmlnError } = require('../core/errors')
const { TIERS } = require('./permissions')

// --------------------------------------------------------------- utilities

/**
 * A JS expression that evaluates to `value`, safe to splice into a script.
 * JSON already produces a valid JS literal for anything JSON-serialisable;
 * the two line/paragraph-separator code points are legal in a JSON string
 * but were, before ES2019, illegal unescaped inside a JS string literal.
 * Escaping them costs nothing and removes any dependence on which JS engine
 * the injected code happens to run under.
 * @param {unknown} value
 * @returns {string}
 */
function toScriptLiteral(value) {
  return JSON.stringify(value === undefined ? null : value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

// ------------------------------------------------------------- 1. renderer

/**
 * Wrap a renderer mod's source so that, inside it, `SMLN` and `__SMLN__`
 * resolve to that mod's own capability facade (`SMLN.forMod(modId, ...)`
 * from src/renderer/capabilities.js) rather than the full runtime object.
 *
 * Deliberately an IIFE taking the facade as a parameter, not a `with` block
 * or a Proxy: parameter shadowing is ordinary lexical scoping, so it behaves
 * exactly like every other variable in the mod's source and needs no engine
 * support beyond what ES5 already guarantees. `fluxloaderAPI` is left
 * completely alone - no parameter is declared for it - because Fluxloader
 * compatibility owns that name via src/compat/fluxloader.js's
 * `environmentShim`, and shadowing it here would be one more place that name
 * could quietly diverge from what that shim set up.
 *
 * A throw inside the mod is caught here (matching the behaviour
 * src/renderer/prelude.js's own generic wrapper already provides - this
 * wrapper is meant to sit *inside* that one, not replace the need for it, so
 * a mod that somehow still throws before reaching this try block is caught
 * by prelude's outer one too) and reported with the mod id, both to the
 * devtools console directly and through the facade's `log`, which also mirrors
 * to the main-process log file when the preload bridge exists.
 *
 * The wrapper introduces no identifiers into the page: every name it defines
 * (`__smlnFacade`, `SMLN`, `__SMLN__`, `e`, `__smlnMsg`) is a parameter or
 * `var` of one of its own IIFEs, invisible once they return.
 *
 * @param {{modId:string, capability?:import('./permissions').Capability, source?:string}} opts
 * @returns {string}
 */
function wrapRendererMod(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  if (typeof o.modId !== 'string' || !o.modId) {
    throw new SmlnError('E_MOD_LOAD', 'sandbox.wrapRendererMod requires a string modId')
  }
  const modId = o.modId
  const source = typeof o.source === 'string' ? o.source : ''
  const capability = o.capability && typeof o.capability === 'object' ? o.capability : null

  const modIdLit = toScriptLiteral(modId)
  const capLit = toScriptLiteral(capability)
  const failMsgLit = toScriptLiteral('[SMLN] renderer mod "' + modId + '" failed:')
  const logMsgPrefixLit = toScriptLiteral('mod "' + modId + '" threw: ')
  // A comment carrying an attacker-controlled mod id must not be able to
  // close the comment early and splice arbitrary script in ahead of the IIFE.
  const commentSafeId = modId.replace(/\*\//g, '')

  return (
    '/* --- mod (renderer, sandboxed by SMLN): ' + commentSafeId + ' --- */\n' +
    ';(function (__smlnFacade) {\n' +
    '  ;(function (SMLN, __SMLN__) {\n' +
    "    'use strict';\n" +
    '    try {\n' +
    source + '\n' +
    '    } catch (e) {\n' +
    '      var __smlnMsg = (e && e.message) || String(e);\n' +
    '      console.error(' + failMsgLit + ', e);\n' +
    '      if (SMLN && typeof SMLN.log === "function") { SMLN.log("error", ' + logMsgPrefixLit + ' + __smlnMsg, e && e.stack); }\n' +
    '    }\n' +
    '  })(__smlnFacade, __smlnFacade);\n' +
    '})((function () {\n' +
    "  var g = typeof globalThis !== 'undefined' ? globalThis : window;\n" +
    '  return (g.__SMLN__ && typeof g.__SMLN__.forMod === "function")\n' +
    '    ? g.__SMLN__.forMod(' + modIdLit + ', ' + capLit + ')\n' +
    '    : undefined;\n' +
    '})());\n'
  )
}

// ---------------------------------------------------------------- 2. native

/** Mod ids already warned about, so a mod loaded once (the normal case) gets exactly one warning. */
const warnedNative = new Set()

/**
 * Build the context object passed to a native mod's `setup({...})`.
 *
 * This is composition, not enforcement: `storage`/`network` are handles the
 * *caller* already built (this function does not implement I/O), and all
 * this does is decide whether to include them based on `capability.granted`.
 * For a native mod `granted.node/filesystem/network` are always true (that is
 * what `classify()` in src/mods/permissions.js means by NATIVE), so in
 * practice everything supplied is included - there is no real fs/net access
 * to withhold from code that already has `require('fs')` and `require('http')`
 * one line away. The one-time warning exists so that fact is never buried in
 * a comment nobody reads: it goes to the actual mod log, once per mod.
 *
 * @param {{mod:{id:string,name?:string,version?:string,dir?:string},
 *           capability?:import('./permissions').Capability, logger?:any,
 *           storage?:any, network?:any, host?:any}} opts
 * @returns {{mod:object, logger:any, permissions:string[],
 *            capability:import('./permissions').Capability|null,
 *            host:any, storage?:any, network?:any}}
 */
function createNativeContext(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const mod = o.mod && typeof o.mod === 'object' ? o.mod : {}
  const capability = o.capability && typeof o.capability === 'object' ? o.capability : null
  const logger = o.logger || null

  const isNative = !capability || capability.tier === TIERS.NATIVE
  const granted = (capability && capability.granted) || { node: true, filesystem: true, network: true }

  if (isNative && logger && typeof logger.warn === 'function' && !warnedNative.has(mod.id)) {
    warnedNative.add(mod.id)
    logger.warn(
      `mod "${mod.id}" is NATIVE: it runs with a real "require", "process", filesystem and network access - ` +
      'exactly what this Electron process has. This setup() context is ergonomic sugar, not a restriction: ' +
      'leaving a field off it does not stop the mod from reaching the same thing directly through require(). ' +
      'SandLoader cannot sandbox native code; only install a native mod from a source you trust completely.'
    )
  }

  /** @type {any} */
  const context = {
    mod: { id: mod.id, name: mod.name, version: mod.version, dir: mod.dir },
    logger,
    permissions: (capability && capability.permissions) || [],
    capability,
    host: o.host !== undefined ? o.host : null,
  }
  if (granted.filesystem && o.storage !== undefined) context.storage = o.storage
  if (granted.network && o.network !== undefined) context.network = o.network
  return context
}

// -------------------------------------------------------------- 3. reporting

/**
 * One-line, human-readable description of what a mod at this capability can
 * actually reach, phrased around the mechanisms this file cares about
 * (window.electron, SMLN.callMain, Node) rather than the permission names -
 * `permissions.summarise()` already covers the latter and this is meant to
 * sit next to it, not duplicate it.
 * @param {import('./permissions').Capability} capability
 * @returns {string}
 */
function sandboxSummary(capability) {
  const cap = capability && typeof capability === 'object' ? capability : null
  if (!cap || cap.tier !== TIERS.NATIVE) {
    if (!cap) {
      return 'sandboxed: no Node, no window.electron, no SMLN.callMain, no SMLN.net, no SMLN.fs (SMLN.storage still available, mod-scoped)'
    }
    const bits = ['SMLN.storage (mod-scoped)']
    if (cap.granted && cap.granted.network) bits.push('SMLN.net')
    if (cap.granted && cap.granted.filesystem) bits.push('SMLN.fs')
    const tierWord = cap.tier === TIERS.ELEVATED ? 'elevated' : 'sandboxed'
    return `${tierWord}: ${bits.join(', ')} - still no Node, no window.electron, no SMLN.callMain`
  }
  return 'native: real Node.js in the Electron main process (require, process, filesystem, network) - not sandboxed, not enforceable'
}

/**
 * Dev helper: throws if `value` carries an obviously privileged reference
 * before it is handed to sandboxed mod code. Best-effort by design - it
 * walks own-enumerable keys a few levels deep looking for a short list of
 * telltale names, not a proof of safety. Used by the self-test to catch the
 * class of mistake this whole file exists to prevent ("the sandbox object
 * accidentally included `electron`"), not to certify arbitrary objects safe.
 * @param {unknown} value
 * @param {{maxDepth?:number}} [opts]
 * @returns {true}
 */
const UNSAFE_KEYS = [
  'electron', 'ipcRenderer', 'ipcMain', 'callMain', '__rpcResult',
  'process', 'require', 'module', 'child_process', 'Buffer', '__dirname', '__filename',
]

function assertRendererSafe(value, opts) {
  const maxDepth = opts && typeof opts.maxDepth === 'number' ? opts.maxDepth : 3
  const seen = new Set()
  walk(value, [], 0)
  return true

  function walk(v, pathParts, depth) {
    if (v === null || v === undefined) return
    if (typeof v !== 'object' && typeof v !== 'function') return
    if (seen.has(v)) return
    seen.add(v)
    let keys
    try { keys = Object.keys(v) } catch (_e) { return }
    for (const k of keys) {
      if (UNSAFE_KEYS.includes(k)) {
        const where = pathParts.length ? pathParts.concat(k).join('.') : k
        throw new SmlnError(
          'E_UNSAFE_HANDOFF',
          `refusing to hand a sandboxed mod a value carrying "${k}" (at ${where}) - ` +
          'this looks like a privileged reference (Electron, Node or SMLN.callMain) leaking into a sandboxed context',
          { key: k, path: where }
        )
      }
      if (depth < maxDepth) {
        let val
        try { val = v[k] } catch (_e) { continue }
        walk(val, pathParts.concat(k), depth + 1)
      }
    }
  }
}

module.exports = {
  wrapRendererMod,
  createNativeContext,
  sandboxSummary,
  assertRendererSafe,
}
