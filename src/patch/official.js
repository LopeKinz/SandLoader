'use strict'
/**
 * Sandustry's official `patches.json` format.
 *
 * A mod folder may ship a `patches.json` holding an array of patch descriptors:
 *
 *   {
 *     "id": "bundle-log-prefix",
 *     "file": "js/bundle.js",
 *     "find": "initializing workers",         // literal text
 *     "operation": "insertBefore",            // or insertAfter | replace | wrap
 *     "code": "[patched] ",
 *     "expectedMatches": 1,
 *     "atomicGroup": "worker-logs"            // optional
 *   }
 *
 * Instead of `find` a patch may carry `regex: { pattern, flags }`, in which case
 * `$1`-style backreferences work inside `code`. With a literal `find` there are
 * no capture groups, so `$` is escaped and inserted verbatim - otherwise a mod
 * containing a stray `$&` in its replacement would silently corrupt the output.
 *
 * `wrap` uses `before` and `after` instead of `code`.
 *
 * Everything is translated onto SandLoader's own patch engine, so official
 * patches get the same guarantees as native ones: exact match counts, atomic
 * groups, and no partial writes.
 */

const fs = require('fs')
const path = require('path')

const { SmlnError } = require('../core/errors')

const PATCHES_FILE = 'patches.json'

const OPERATIONS = ['insertBefore', 'insertAfter', 'replace', 'wrap']

/** Files a patch may target, normalised to dist-relative posix paths. */
const FILE_ALIASES = {
  'bundle.js': 'js/bundle.js',
  'js/bundle.js': 'js/bundle.js',
  'dist/js/bundle.js': 'js/bundle.js',
  'manager-worker.js': 'js/manager-worker.js',
  'js/manager-worker.js': 'js/manager-worker.js',
  'dist/js/manager-worker.js': 'js/manager-worker.js',
  'simulation-worker.js': 'js/simulation-worker.js',
  'js/simulation-worker.js': 'js/simulation-worker.js',
  'dist/js/simulation-worker.js': 'js/simulation-worker.js',
  'utility-worker.js': 'js/utility-worker.js',
  'js/utility-worker.js': 'js/utility-worker.js',
  'dist/js/utility-worker.js': 'js/utility-worker.js',
  'index.html': 'index.html',
}

function normaliseFile(file) {
  const key = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '')
  return FILE_ALIASES[key] || FILE_ALIASES[key.split('/').pop()] || key
}

/** `$` has meaning in a String.replace replacement; a literal insert must not. */
function escapeDollar(text) {
  return String(text).replace(/\$/g, '$$$$')
}

/**
 * Translate one descriptor into an engine patch.
 * @param {any} entry
 * @param {string} owner  mod id, for logs and conflict reports
 * @returns {{ok:true, patch:import('./engine').Patch, file:string}|{ok:false, error:SmlnError}}
 */
function toPatch(entry, owner) {
  const fail = (msg) => ({
    ok: false,
    error: new SmlnError('E_PATCH_FAILED', `${owner}: ${PATCHES_FILE}: ${msg}`, { detail: { entry } }),
  })

  if (!entry || typeof entry !== 'object') return fail('entry is not an object')
  const id = typeof entry.id === 'string' && entry.id ? entry.id : null
  if (!id) return fail('every patch needs an "id"')
  if (typeof entry.file !== 'string' || !entry.file) return fail(`patch "${id}" has no "file"`)

  const operation = entry.operation == null ? 'replace' : String(entry.operation)
  if (!OPERATIONS.includes(operation)) {
    return fail(`patch "${id}" has unknown operation "${operation}" (expected ${OPERATIONS.join(', ')})`)
  }

  const hasLiteral = typeof entry.find === 'string' && entry.find.length > 0
  const hasRegex = entry.regex && typeof entry.regex.pattern === 'string'
  if (hasLiteral === hasRegex) {
    return fail(`patch "${id}" needs exactly one of "find" or "regex"`)
  }

  let find
  if (hasRegex) {
    const flags = typeof entry.regex.flags === 'string' ? entry.regex.flags : ''
    try {
      find = new RegExp(entry.regex.pattern, flags.includes('g') ? flags : flags + 'g')
    } catch (e) {
      return fail(`patch "${id}" has an invalid regex: ${e.message}`)
    }
  } else {
    find = entry.find
  }

  // With a regex, keep $1 substitution. With literal text, insert verbatim.
  const prep = hasRegex ? (s) => String(s) : (s) => escapeDollar(s)

  let replace
  if (operation === 'wrap') {
    const before = prep(entry.before == null ? '' : entry.before)
    const after = prep(entry.after == null ? '' : entry.after)
    if (!before && !after) return fail(`patch "${id}" is a wrap with neither "before" nor "after"`)
    replace = hasRegex
      ? (...args) => before + args[0] + after
      : (match) => before.replace(/\$\$/g, '$') + match + after.replace(/\$\$/g, '$')
  } else {
    if (entry.code == null) return fail(`patch "${id}" has no "code"`)
    const code = prep(entry.code)
    if (operation === 'replace') {
      replace = hasRegex ? code : () => String(entry.code)
    } else if (operation === 'insertBefore') {
      replace = hasRegex ? (code + '$&') : (match) => String(entry.code) + match
    } else {
      replace = hasRegex ? ('$&' + code) : (match) => match + String(entry.code)
    }
  }

  const expected = entry.expectedMatches
  const expect = expected == null ? 'any' : Number(expected)
  if (expect !== 'any' && (!Number.isInteger(expect) || expect < 0)) {
    return fail(`patch "${id}" has a non-integer "expectedMatches"`)
  }

  return {
    ok: true,
    file: normaliseFile(entry.file),
    patch: {
      id: `${owner}:${id}`,
      owner,
      description: `${operation} in ${entry.file} (${owner})`,
      find,
      replace,
      expect,
      // Mod patches must not take the game down; a failure disables the patch
      // (and its atomic group) and is reported.
      required: entry.required === true,
      group: typeof entry.atomicGroup === 'string' && entry.atomicGroup
        ? `${owner}:${entry.atomicGroup}`
        : undefined,
    },
  }
}

/**
 * Read a mod's `patches.json`.
 * @returns {{patchesByFile: Record<string, any[]>, errors: SmlnError[]}}
 */
function load(modDir, owner) {
  const file = path.join(modDir, PATCHES_FILE)
  const patchesByFile = {}
  const errors = []
  if (!fs.existsSync(file)) return { patchesByFile, errors }

  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    errors.push(new SmlnError('E_PATCH_FAILED', `${owner}: ${PATCHES_FILE} is not valid JSON: ${e.message}`))
    return { patchesByFile, errors }
  }
  if (!Array.isArray(parsed)) {
    errors.push(new SmlnError('E_PATCH_FAILED', `${owner}: ${PATCHES_FILE} must contain an array`))
    return { patchesByFile, errors }
  }

  for (const entry of parsed) {
    const result = toPatch(entry, owner)
    if (!result.ok) { errors.push(result.error); continue }
    ;(patchesByFile[result.file] || (patchesByFile[result.file] = [])).push(result.patch)
  }
  return { patchesByFile, errors }
}

module.exports = { load, toPatch, normaliseFile, PATCHES_FILE, OPERATIONS }
