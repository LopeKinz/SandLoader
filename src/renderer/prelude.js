'use strict'
/**
 * Builds the script that gets prepended to the game's renderer bundle.
 *
 * Prepending (rather than adding a <script> tag to index.html) guarantees
 * ordering: the runtime is installed before a single line of game code runs,
 * so the capture hook can never fire before its receiver exists.
 *
 * PART ORDER IS LOAD-BEARING. `runtime.js` defines `__SMLN__`; every other
 * part starts with `var SMLN = global.__SMLN__; if (!SMLN) return`, so a part
 * placed above it silently does nothing. Beyond that:
 *
 *   locales.js       only writes a global, but must precede i18n.js
 *   i18n.js          the UI parts call SMLN.i18n.t() at build time
 *   capabilities.js  defines SMLN.forMod, which mod wrappers call
 *   registration.js  } capabilities.js links these onto each facade if they
 *   messaging.js     } are present, so they must be installed before any mod
 *   sandkit-adapter  normalises the legacy/v1 game API before official mods
 *   official-runtime delays official entries until that adapter is ready
 *   settingsui/permui defined before modsui.js, which opens them
 *
 * The result is cached only when nothing mod-specific went into it, because
 * the interceptor asks for it on every bundle request.
 */

const fs = require('fs')
const path = require('path')

const enums = require('../game/enums')

/** Read once; the renderer parts receive it as an injected global. */
const VERSION = (() => {
  try {
    return String(require('../../package.json').version || '0.0.0')
  } catch (_) {
    return '0.0.0'
  }
})()

/** @type {string|null} */
let cache = null

/**
 * Concatenated in this order. `runtime.js` must stay first.
 */
const PARTS = [
  'runtime.js',
  'locales.js',
  'i18n.js',
  'capabilities.js',
  'registration.js',
  'messaging.js',
  'sandkit-adapter.js',
  'official-runtime.js',
  'splash.js',
  'console.js',
  'settingsui.js',
  'permui.js',
  'modsui.js',
  'hotreload.js',
]

/**
 * Emit `<global>.<name> = <json>` without ever interpolating raw text.
 *
 * `self` is tried first because it is the global in a worker *and* an alias
 * for `window` in the page, so one expression covers both. Reaching only for
 * `globalThis` left the worker runtime reading a name the worker prelude had
 * written somewhere else - harmless in a real worker, where the two are the
 * same object, and wrong anywhere they are not.
 */
function globalAssign(name, value) {
  return ';(function(g){g.' + name + '=' + JSON.stringify(value === undefined ? null : value) + ';})' +
    '(typeof self!=="undefined"?self:typeof globalThis!=="undefined"?globalThis:window);'
}

/**
 * Main-thread official entries are currently tagged by src/main/entry.js as:
 *   `/* official mod: <id>@<version> *\/\n<source>`
 *
 * They cannot be executed as ordinary prepended scripts: Sandustry normally
 * gives them a lexical `sandkit` value and an async function body. Detect the
 * tag here and restore those semantics through official-runtime.js.
 */
function officialRendererMeta(src) {
  const m = /^\/\* official mod: ([a-zA-Z0-9._-]+)@([^*\r\n]+) \*\/\s*/.exec(String(src || ''))
  if (!m) return null
  return { id: m[1], version: m[2].trim(), body: String(src).slice(m[0].length) }
}

function wrapOfficialRenderer(src) {
  const meta = officialRendererMeta(src)
  if (!meta) return src
  const id = JSON.stringify(meta.id)
  return (
    '/* --- official Sandkit main entry: ' + meta.id + '@' + meta.version + ' --- */\n' +
    ';(function(g){\n' +
    '  var S=g.__SMLN__;\n' +
    '  if(!S||!S.official||typeof S.official.execute!=="function"){\n' +
    '    console.error("[SMLN] official mod ' + meta.id + ' cannot start: Sandkit adapter unavailable");\n' +
    '    return;\n' +
    '  }\n' +
    '  S.official.execute(' + id + ',1,async function(sandkit){\n' +
    '    "use strict";\n' +
    meta.body + '\n' +
    '  });\n' +
    '})(typeof globalThis!=="undefined"?globalThis:window);\n'
  )
}

/**
 * @param {Object} [opts]
 * @param {string[]} [opts.modScripts]  Renderer-side mod sources, already
 *   wrapped per mod by src/mods/sandbox.js where applicable.
 * @param {any[]} [opts.mods]           Metadata for the manager and the splash.
 * @param {Record<string,{baseUrl:string}>} [opts.modAssets]  For SMLN.assets.
 * @param {Record<string,any>} [opts.fluxConfig]  Persisted Fluxloader config.
 * @param {string|null} [opts.locale]   Explicit SandLoader language preference.
 * @param {any} [opts.problems]         Failures the loader survived.
 * @param {any} [opts.boot]             What the loader did: mods, patches, hooks.
 * @param {boolean} [opts.reload]
 * @returns {string}
 */
function build(opts = {}) {
  const dynamic = (opts.modScripts && opts.modScripts.length) ||
    (opts.mods && opts.mods.length) ||
    opts.modAssets || opts.fluxConfig || opts.locale || opts.problems || opts.boot
  if (cache && !opts.reload && !dynamic) return cache

  const chunks = []
  chunks.push('/* --- SMLN runtime (injected) --- */')

  // Everything the renderer parts read out of the global scope, defined before
  // the part that reads it runs.
  chunks.push(globalAssign('__SMLN_VERSION__', VERSION))
  chunks.push(globalAssign('__SMLN_ENUMS__', serialisableEnums()))
  chunks.push(globalAssign('__SMLN_MODS__', opts.mods || []))
  chunks.push(globalAssign('__SMLN_MOD_ASSETS__', opts.modAssets || {}))
  chunks.push(globalAssign('__SMLN_FLUX_CONFIG__', opts.fluxConfig || {}))
  chunks.push(globalAssign('__SMLN_LOCALE__', opts.locale || null))
  chunks.push(globalAssign('__SMLN_PROBLEMS__', opts.problems || { problems: [], summary: { total: 0, errors: 0, warnings: 0, mods: [] } }))
  chunks.push(globalAssign('__SMLN_BOOT__', opts.boot || null))

  for (const part of PARTS) {
    const file = path.join(__dirname, part)
    let source
    try {
      source = fs.readFileSync(file, 'utf8')
    } catch (e) {
      // A missing optional part must not stop the loader; the runtime is the
      // only one whose absence is fatal, and that is caught by the caller.
      chunks.push(`/* --- ${part}: unavailable (${e.code || e.message}) --- */`)
      continue
    }
    chunks.push(`/* --- ${part} --- */`)
    // Each part is self-guarding, but a syntax-level throw at install time
    // would abort the whole prepended script and with it the game bundle.
    chunks.push(';try{\n' + source + '\n}catch(e){console.error("[SMLN] part ' + part + ' failed to install:",e)}')
  }

  // Attach the tables to the live API object once it exists.
  chunks.push(
    ';(function(g){if(g.__SMLN__)g.__SMLN__.enums=g.__SMLN_ENUMS__;})' +
    '(typeof globalThis!=="undefined"?globalThis:window);'
  )

  for (const src of opts.modScripts || []) {
    chunks.push('/* --- mod (renderer) --- */')
    // Official Sandustry entries need their own `sandkit` lexical and must run
    // after the game exposes its API. SMLN/Fluxloader scripts keep their
    // existing wrappers and execute immediately as before.
    const prepared = officialRendererMeta(src) ? wrapOfficialRenderer(src) : src
    chunks.push(';try{\n' + prepared + '\n}catch(e){console.error("[SMLN] renderer mod failed:",e)}')
  }

  chunks.push('/* --- end SMLN runtime --- */\n')
  const out = chunks.join('\n')
  if (!dynamic) cache = out
  return out
}

/**
 * The worker-side prelude: SandLoader's worker runtime plus each worker mod,
 * each in its own try/catch so one broken mod cannot stop the simulation
 * worker from booting.
 *
 * Official Sandkit worker entries are intentionally not reinterpreted here.
 * The main and worker Sandkit surfaces are different, and pretending the main
 * adapter is a worker API would corrupt simulation state. Until SandLoader can
 * hand them through Sandustry's native worker-entry bridge, a missing worker
 * API should fail visibly rather than silently execute against the wrong one.
 *
 * @param {string[]} workerScripts
 * @returns {string}
 */
function buildWorker(workerScripts) {
  const chunks = ['/* --- SMLN worker runtime (injected) --- */']
  chunks.push(globalAssign('__SMLN_VERSION__', VERSION))
  try {
    chunks.push(';try{\n' + fs.readFileSync(path.join(__dirname, 'worker-runtime.js'), 'utf8') +
      '\n}catch(e){console.error("[SMLN] worker runtime failed to install:",e)}')
  } catch (e) {
    chunks.push('/* worker-runtime.js unavailable: ' + (e.code || e.message) + ' */')
  }
  for (const src of workerScripts || []) {
    chunks.push(';try{\n' + src + '\n}catch(e){console.error("[SMLN] worker mod failed:",e)}')
  }
  chunks.push('/* --- end SMLN worker runtime --- */\n')
  return chunks.join('\n')
}

/**
 * Only the plain-data parts of the enum module travel to the renderer.
 *
 * The three `*_INFO` tables are the vendored content reference (about 24 KiB
 * of the injected script). They are what turns a completion list of bare ids
 * into one showing display names, phases, descriptions and colours, so the
 * cost buys the console its whole usefulness. Everything reading them degrades
 * to the id alone if they are absent.
 */
function serialisableEnums() {
  const {
    ElementType, MatterType, ELEMENT_PHASE, CellType, StructureType, ToolType,
    WorkerMessage, UIScreen, RESOURCES, ElementByName, CellByName,
    StructureByName, ToolByName, VERIFIED, ELEMENT_KEYS, TERRAIN_KEYS,
    ELEMENT_INFO, STRUCTURE_INFO, ITEM_INFO, CONTENT_META,
  } = enums
  return {
    ElementType, MatterType, ELEMENT_PHASE, CellType, StructureType, ToolType,
    WorkerMessage, UIScreen, RESOURCES, ElementByName, CellByName,
    StructureByName, ToolByName, VERIFIED, ELEMENT_KEYS, TERRAIN_KEYS,
    ELEMENT_INFO, STRUCTURE_INFO, ITEM_INFO, CONTENT_META,
  }
}

function invalidate() { cache = null }

module.exports = { build, buildWorker, invalidate, PARTS, VERSION, officialRendererMeta, wrapOfficialRenderer }
