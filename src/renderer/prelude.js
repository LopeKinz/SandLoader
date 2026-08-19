'use strict'
/**
 * Builds the script that gets prepended to the game's renderer bundle.
 *
 * Prepending (rather than adding a <script> tag to index.html) guarantees
 * ordering: the runtime is installed before a single line of game code runs,
 * so the capture hook can never fire before its receiver exists.
 *
 * The result is cached, because the interceptor is asked for it on every
 * bundle request and rebuilding it means re-reading three files.
 */

const fs = require('fs')
const path = require('path')

const enums = require('../game/enums')

/** @type {string|null} */
let cache = null

/** Files are concatenated in this order; runtime must come first. */
const PARTS = ['runtime.js', 'splash.js', 'console.js', 'modsui.js']

/**
 * @param {{modScripts?: string[], mods?: any[], reload?: boolean}} [opts]
 *   modScripts: renderer-side mod sources, appended after the console so they
 *   can call SMLN.registerCommand() and SMLN.whenReady() immediately.
 *   mods: metadata for the in-game mod manager and the splash screen.
 * @returns {string}
 */
function build(opts = {}) {
  const dynamic = (opts.modScripts && opts.modScripts.length) || (opts.mods && opts.mods.length)
  if (cache && !opts.reload && !dynamic) return cache

  const chunks = []
  chunks.push('/* --- SMLN runtime (injected) --- */')
  // Expose the static tables before the runtime reads them.
  chunks.push(
    ';(function(g){g.__SMLN_ENUMS__=' + JSON.stringify(serialisableEnums()) + ';})' +
    '(typeof globalThis!=="undefined"?globalThis:window);'
  )

  // Mod metadata for the manager UI and splash, before any part reads it.
  chunks.push(
    ';(function(g){g.__SMLN_MODS__=' + JSON.stringify(opts.mods || []) + ';})' +
    '(typeof globalThis!=="undefined"?globalThis:window);'
  )

  for (const part of PARTS) {
    const file = path.join(__dirname, part)
    chunks.push(`/* --- ${part} --- */`)
    chunks.push(fs.readFileSync(file, 'utf8'))
  }

  // Attach the tables to the live API object once it exists.
  chunks.push(
    ';(function(g){if(g.__SMLN__)g.__SMLN__.enums=g.__SMLN_ENUMS__;})' +
    '(typeof globalThis!=="undefined"?globalThis:window);'
  )

  for (const src of opts.modScripts || []) {
    chunks.push('/* --- mod (renderer) --- */')
    // A throwing mod must not prevent the game bundle from executing.
    chunks.push(';try{\n' + src + '\n}catch(e){console.error("[SMLN] renderer mod failed:",e)}')
  }

  chunks.push('/* --- end SMLN runtime --- */\n')
  const out = chunks.join('\n')
  if (!(opts.modScripts && opts.modScripts.length)) cache = out
  return out
}

/** Only the plain-data parts of the enum module travel to the renderer. */
function serialisableEnums() {
  const {
    ElementType, MatterType, ELEMENT_PHASE, CellType, StructureType, ToolType,
    WorkerMessage, UIScreen, RESOURCES, ElementByName, CellByName,
    StructureByName, ToolByName, VERIFIED, ELEMENT_KEYS, TERRAIN_KEYS,
  } = enums
  return {
    ElementType, MatterType, ELEMENT_PHASE, CellType, StructureType, ToolType,
    WorkerMessage, UIScreen, RESOURCES, ElementByName, CellByName,
    StructureByName, ToolByName, VERIFIED, ELEMENT_KEYS, TERRAIN_KEYS,
  }
}

function invalidate() { cache = null }

module.exports = { build, invalidate }
