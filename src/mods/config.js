'use strict'
/**
 * The one config store.
 *
 * Before this module, `src/compat/fluxloader.js` kept an ad-hoc per-mod JSON
 * store (`makeConfigStore`) with no validation at all, and nothing else in the
 * loader had any config story. Once the settings UI, the main process and the
 * Fluxloader shim all need to read and write the same mod's config, having
 * three independent ideas of "what a value is allowed to be" is exactly how a
 * slider ends up saved as the string `"NaN"` in one place and `5` in another.
 * So there is exactly one on-disk representation, one schema validator and one
 * set of defaults, and everything else is re-pointed at it. `makeConfigStore`
 * is expected to become a thin wrapper that calls `createStore` from here.
 *
 * On-disk format (unchanged from the old Fluxloader shim, on purpose):
 *   `<configDir>/<sanitised mod id>.json`, a flat JSON object of persisted
 *   overrides only - schema defaults are never written to disk, so bumping a
 *   default in a mod update takes effect for anyone who never touched that
 *   key. Writes go to `<file>.tmp` then an atomic rename, so a crash mid-write
 *   cannot leave a truncated file behind. A file that fails to parse is never
 *   deleted or rewritten by a read - it is left exactly as it was, and the
 *   store falls back to schema defaults in memory until something explicitly
 *   writes a fresh value.
 *
 * Backwards compatibility promise: any file the old `makeConfigStore` wrote is
 * a flat `{key: value}` object at that same path, which is exactly what
 * `raw()` here reads and `getAll()` merges under schema defaults. A store
 * whose mod declares no `configSchema` (most existing Fluxloader mods) treats
 * every key as schema-less: `set`/`setAll` accept it without validation
 * rather than rejecting it as "unknown", because rejecting it would break
 * every config file already on a player's disk. `validateValue`, used by the
 * settings UI, is stricter on purpose - it only knows about declared schema
 * keys, since the UI can only render a control for a key it has a spec for.
 *
 * Usage from the orchestrator, one store per mod kept alive for the process
 * lifetime so listeners and the in-memory cache persist:
 *
 *   const config = require('./mods/config')
 *   const stores = new Map() // mod id -> Store
 *   function storeFor(mod, logger) {
 *     let store = stores.get(mod.id)
 *     if (!store) {
 *       store = config.createStore({ dir: configDir, id: mod.id, schema: mod.configSchema, logger })
 *       stores.set(mod.id, store)
 *     }
 *     return store
 *   }
 *
 * `fluxloaderAPI.modConfig` (both the electron-side `makeConfigStore` and the
 * `environmentShim` string injected into the game/worker) should end up
 * calling into the same `Store` so a value written from one environment is
 * visible - after a `reload()` - from another.
 */

const fs = require('fs')
const path = require('path')

const { SmlnError } = require('../core/errors')

/**
 * A schema is `{[key]: Spec}`. A Spec has `type` (`boolean`|`number`|
 * `integer`|`string`|`enum`), a validated `default`, and, depending on type,
 * `min`/`max`/`step`, `minLength`/`maxLength`/`pattern`, or `values`. Every
 * spec also carries the common optional fields `label`, `description`,
 * `requiresReload` and `hidden` (booleans), and `order` (a UI sort hint).
 * Declaration order is preserved as the schema object's own key order, and
 * mirrored in a non-enumerable `schema.__order` array for callers that round
 * -trip the schema through JSON, which drops key-order guarantees.
 * @typedef {Record<string, any>} Schema
 */

// --------------------------------------------------------------- schema types

// Fluxloader's own configSchema is opaque to `src/compat/fluxloader.js` (it
// just forwards `info.configSchema`), so there is no fixed upstream spelling
// to match. These aliases cover the spellings a hand-written schema or an
// HTML-ish form builder is likely to use; anything else falls through to the
// literal `type` string, which then fails normalisation with a clear message
// instead of being silently misinterpreted.
const TYPE_ALIASES = {
  boolean: 'boolean', bool: 'boolean', checkbox: 'boolean', toggle: 'boolean',
  number: 'number', float: 'number', double: 'number', range: 'number', slider: 'number',
  integer: 'integer', int: 'integer',
  string: 'string', text: 'string', str: 'string',
  enum: 'enum', select: 'enum', choice: 'enum', dropdown: 'enum', options: 'enum',
}

// `array` is here because Fluxloader schemas use it and real mods depend on
// it - autosplitter declares `{"type":"array","default":[1,2]}` for its split
// points. Rejecting the type threw away that mod's whole config, leaving it
// running on an empty one.
const KNOWN_TYPES = new Set(['boolean', 'number', 'integer', 'string', 'enum', 'array'])

/** Work out a spec's type, inferring from `default` when `type` is absent. */
function resolveType(spec) {
  if (spec && typeof spec.type === 'string') {
    return TYPE_ALIASES[spec.type.toLowerCase()] || spec.type.toLowerCase()
  }
  if (spec && (Array.isArray(spec.values) || Array.isArray(spec.options))) return 'enum'
  if (spec && Object.prototype.hasOwnProperty.call(spec, 'default')) {
    const d = spec.default
    // Checked before the primitives: an array default with no declared type
    // would otherwise fall through to 'string' and be rejected as invalid.
    if (Array.isArray(d)) return 'array'
    if (typeof d === 'boolean') return 'boolean'
    if (typeof d === 'number') return 'number'
    if (typeof d === 'string') return 'string'
  }
  return 'string'
}

/** A sane in-range fallback for a spec with no declared `default`. */
function fallbackDefault(spec) {
  switch (spec.type) {
    case 'boolean': return false
    case 'number':
    case 'integer': {
      let n = 0
      if (spec.min != null && n < spec.min) n = spec.min
      if (spec.max != null && n > spec.max) n = spec.max
      return n
    }
    case 'string': return ''
    case 'enum': return spec.values[0]
    // A fresh array per call: one shared instance would be handed to every
    // mod that declared an array with no default, and a push by any of them
    // would be seen by all the others.
    case 'array': return []
    default: return null
  }
}

/**
 * Validate and normalise one raw spec. Never throws.
 * @param {string} key @param {any} rawSpec
 * @returns {{ok:true,spec:any}|{ok:false,error:SmlnError}}
 */
function normaliseSpec(key, rawSpec) {
  const fail = (msg) => ({ ok: false, error: new SmlnError('E_CONFIG', `config key "${key}": ${msg}`) })

  const type = resolveType(rawSpec)
  if (!KNOWN_TYPES.has(type)) return fail(`unknown type "${rawSpec.type}"`)

  const spec = { type }
  if (typeof rawSpec.label === 'string') spec.label = rawSpec.label
  if (typeof rawSpec.description === 'string') spec.description = rawSpec.description
  spec.requiresReload = !!rawSpec.requiresReload
  spec.hidden = !!rawSpec.hidden
  if (rawSpec.order != null && Number.isFinite(Number(rawSpec.order))) spec.order = Number(rawSpec.order)

  if (type === 'number' || type === 'integer') {
    for (const field of ['min', 'max', 'step']) {
      if (rawSpec[field] == null) continue
      const n = Number(rawSpec[field])
      if (!Number.isFinite(n)) return fail(`"${field}" must be a number`)
      spec[field] = n
    }
    if (spec.min != null && spec.max != null && spec.min > spec.max) {
      return fail(`min (${spec.min}) is greater than max (${spec.max})`)
    }
  }

  if (type === 'string') {
    for (const field of ['minLength', 'maxLength']) {
      if (rawSpec[field] == null) continue
      const n = Number(rawSpec[field])
      if (!Number.isFinite(n) || n < 0) return fail(`"${field}" must be a non-negative number`)
      spec[field] = n
    }
    if (spec.minLength != null && spec.maxLength != null && spec.minLength > spec.maxLength) {
      return fail(`minLength (${spec.minLength}) is greater than maxLength (${spec.maxLength})`)
    }
    if (rawSpec.pattern != null) {
      try { new RegExp(rawSpec.pattern) } catch (e) { return fail(`"pattern" is not a valid regular expression: ${e.message}`) }
      spec.pattern = String(rawSpec.pattern)
    }
  }

  if (type === 'enum') {
    const values = Array.isArray(rawSpec.values) ? rawSpec.values
      : Array.isArray(rawSpec.options) ? rawSpec.options
        : null
    if (!values || values.length === 0) return fail('enum needs a non-empty "values" (or "options") list')
    spec.values = values.slice()
  }

  const hadDefault = rawSpec != null && Object.prototype.hasOwnProperty.call(rawSpec, 'default')
  if (hadDefault) {
    const coerced = coerce(spec, rawSpec.default)
    if (!coerced.ok) return fail(`default value is invalid: ${coerced.reason}`)
    spec.default = coerced.value
  } else {
    spec.default = fallbackDefault(spec)
  }

  return { ok: true, spec }
}

/**
 * Validate and normalise a whole raw `configSchema` object. Never throws -
 * every failure mode a mod manifest can produce comes back as `{ok:false}`.
 * @param {any} rawSchema
 * @returns {{ok:true,schema:Schema}|{ok:false,error:SmlnError}}
 */
function normaliseSchema(rawSchema) {
  if (rawSchema == null) return { ok: true, schema: emptySchema() }
  if (typeof rawSchema !== 'object' || Array.isArray(rawSchema)) {
    return { ok: false, error: new SmlnError('E_CONFIG', 'config schema must be an object') }
  }

  const schema = {}
  const order = []
  for (const key of Object.keys(rawSchema)) {
    const rawSpec = rawSchema[key]
    if (rawSpec == null || typeof rawSpec !== 'object' || Array.isArray(rawSpec)) {
      return { ok: false, error: new SmlnError('E_CONFIG', `config key "${key}": spec must be an object`) }
    }
    const result = normaliseSpec(key, rawSpec)
    if (!result.ok) return result
    schema[key] = result.spec
    order.push(key)
  }
  // __order is non-enumerable so it never shows up in Object.keys/entries or
  // a JSON.stringify of the schema - see the Schema typedef above for why it
  // exists alongside plain key order.
  Object.defineProperty(schema, '__order', { value: order, enumerable: false })
  return { ok: true, schema }
}

function emptySchema() {
  const schema = {}
  Object.defineProperty(schema, '__order', { value: [], enumerable: false })
  return schema
}

// ------------------------------------------------------------------- coerce

/**
 * Convert an HTML-input-shaped value (`"5"`, `"true"`, `"on"`, a raw number,
 * a raw boolean) into the type a spec declares, and check it against that
 * spec's constraints. Never throws.
 * @param {any} spec @param {*} value
 * @returns {{ok:true,value:*}|{ok:false,reason:string}}
 */
function coerce(spec, value) {
  if (!spec || typeof spec !== 'object') return { ok: false, reason: 'invalid config spec' }
  switch (resolveType(spec)) {
    case 'boolean': return coerceBoolean(value)
    case 'number': return coerceNumber(spec, value, false)
    case 'integer': return coerceNumber(spec, value, true)
    case 'string': return coerceString(spec, value)
    case 'enum': return coerceEnum(spec, value)
    case 'array': return coerceArray(value)
    default: return { ok: false, reason: `unsupported config type "${spec.type}"` }
  }
}

/**
 * Arrays hold whatever the mod puts in them, so the contents are not
 * inspected - only that it IS an array, and that it survives a round trip
 * through the JSON config file.
 *
 * A JSON string is accepted because the config UI edits values as text; a
 * string that parses to something other than an array is rejected rather than
 * wrapped, since `"5"` meaning `[5]` would be a guess.
 */
function coerceArray(value) {
  if (Array.isArray(value)) return { ok: true, value: value.slice() }
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '') return { ok: true, value: [] }
    let parsed
    try { parsed = JSON.parse(text) } catch (e) { return { ok: false, reason: 'must be a JSON array' } }
    if (!Array.isArray(parsed)) return { ok: false, reason: 'must be a JSON array' }
    return { ok: true, value: parsed }
  }
  return { ok: false, reason: 'must be an array' }
}

function coerceBoolean(value) {
  if (typeof value === 'boolean') return { ok: true, value }
  if (typeof value === 'number') {
    if (value === 1) return { ok: true, value: true }
    if (value === 0) return { ok: true, value: false }
  }
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase()
    if (['true', 'on', 'yes', '1'].includes(s)) return { ok: true, value: true }
    if (['false', 'off', 'no', '0'].includes(s)) return { ok: true, value: false }
  }
  return { ok: false, reason: 'must be true or false' }
}

function coerceNumber(spec, value, isInteger) {
  // Booleans are technically `number`-coercible in JS (`+true === 1`); that's
  // never what a config value meant, so refuse them rather than silently
  // accepting a checkbox value on a number field.
  if (typeof value === 'boolean') return { ok: false, reason: 'must be a number' }

  let n
  if (typeof value === 'number') {
    n = value
  } else if (typeof value === 'string') {
    if (value.trim() === '') return { ok: false, reason: 'must be a number' } // "nothing typed", not zero
    n = Number(value)
  } else {
    return { ok: false, reason: 'must be a number' }
  }

  if (!Number.isFinite(n)) return { ok: false, reason: 'must be a finite number' }
  if (isInteger && !Number.isInteger(n)) return { ok: false, reason: 'must be a whole number' }

  const hasMin = spec.min != null
  const hasMax = spec.max != null
  if ((hasMin && n < spec.min) || (hasMax && n > spec.max)) {
    if (hasMin && hasMax) return { ok: false, reason: `must be between ${spec.min} and ${spec.max}` }
    if (hasMin) return { ok: false, reason: `must be at least ${spec.min}` }
    return { ok: false, reason: `must be at most ${spec.max}` }
  }

  if (spec.step != null && spec.step > 0) {
    const base = hasMin ? spec.min : 0
    const steps = (n - base) / spec.step
    if (Math.abs(Math.round(steps) - steps) > 1e-9) {
      return { ok: false, reason: `must be a multiple of ${spec.step}${hasMin ? ` starting from ${spec.min}` : ''}` }
    }
  }

  return { ok: true, value: n }
}

function coerceString(spec, value) {
  let s
  if (typeof value === 'string') s = value
  else if (typeof value === 'number' || typeof value === 'boolean') s = String(value)
  else return { ok: false, reason: 'must be a string' }

  const hasMin = spec.minLength != null
  const hasMax = spec.maxLength != null
  if ((hasMin && s.length < spec.minLength) || (hasMax && s.length > spec.maxLength)) {
    if (hasMin && hasMax) return { ok: false, reason: `must be between ${spec.minLength} and ${spec.maxLength} characters` }
    if (hasMin) return { ok: false, reason: `must be at least ${spec.minLength} characters` }
    return { ok: false, reason: `must be at most ${spec.maxLength} characters` }
  }

  if (spec.pattern) {
    let re
    try { re = spec.pattern instanceof RegExp ? spec.pattern : new RegExp(spec.pattern) }
    catch (_) { return { ok: false, reason: 'has an invalid pattern and cannot be validated' } }
    if (!re.test(s)) return { ok: false, reason: `must match pattern ${re.source}` }
  }

  return { ok: true, value: s }
}

function coerceEnum(spec, value) {
  const values = Array.isArray(spec.values) ? spec.values : Array.isArray(spec.options) ? spec.options : []
  if (!values.length) return { ok: false, reason: 'has no allowed values' }
  // Compare loosely too: an HTML <select> always yields a string, even for an
  // enum of numbers, so `2` (the number) must still match `"2"` (the value).
  const match = values.find((v) => v === value || String(v) === String(value))
  if (match === undefined) return { ok: false, reason: `must be one of: ${values.map(String).join(', ')}` }
  return { ok: true, value: match }
}

/**
 * Validate one value against a normalised schema's key. Unlike `Store.set`,
 * this rejects a key the schema does not declare - it is what the settings UI
 * uses, and the UI cannot render a control for a spec it does not have.
 * @param {Schema} schema @param {string} key @param {*} value
 * @returns {{ok:true,value:*}|{ok:false,error:SmlnError}}
 */
function validateValue(schema, key, value) {
  if (!schema || typeof schema !== 'object') {
    return { ok: false, error: new SmlnError('E_CONFIG', 'schema must be an object') }
  }
  const spec = schema[key]
  if (!spec) return { ok: false, error: new SmlnError('E_CONFIG', `unknown config key "${key}"`) }
  const coerced = coerce(spec, value)
  if (!coerced.ok) return { ok: false, error: new SmlnError('E_CONFIG', `${key}: ${coerced.reason}`) }
  return { ok: true, value: coerced.value }
}

/**
 * @param {Schema} schema
 * @returns {Record<string,*>} a fresh plain object of `key -> spec.default`
 */
function defaults(schema) {
  const out = {}
  if (!schema || typeof schema !== 'object') return out
  for (const key of Object.keys(schema)) {
    const spec = schema[key]
    out[key] = spec && 'default' in spec ? spec.default : undefined
  }
  return out
}

// ------------------------------------------------------------------- store

const noopLogger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
  child() { return noopLogger },
}

/**
 * Turn a mod id into a safe filename, refusing anything that could point
 * outside the config directory rather than trying to repair it. The manifest
 * is untrusted input - a mod id is whatever string the mod author wrote, not
 * something SMLN generated - so this does not trust it to already be a bare
 * filename.
 * @param {string} id
 * @returns {{ok:true,safe:string}|{ok:false,reason:string}}
 */
function sanitiseId(id) {
  if (typeof id !== 'string' || !id.trim()) return { ok: false, reason: 'mod id must be a non-empty string' }
  if (id === '.' || id === '..') return { ok: false, reason: `mod id "${id}" is reserved` }
  if (/[\\/]/.test(id)) return { ok: false, reason: `mod id "${id}" must not contain a path separator` }
  // Defense in depth beyond the separator check above: collapse anything else
  // that is not a plain filename character. Combined with the containment
  // check in createStore, the final path can never leave `dir`.
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, '_')
  if (!safe) return { ok: false, reason: `mod id "${id}" has no usable filename characters` }
  return { ok: true, safe }
}

/**
 * Create (or re-open) the config store for one mod. Reading, writing and
 * resetting all funnel through the same in-memory cache, so callers sharing
 * one `Store` instance always see each other's writes without a `reload()`.
 *
 * Unlike the rest of this module, `createStore` can throw a `SmlnError` -
 * only for a mod id that cannot be turned into a safe filename inside `dir`.
 * There is no sensible `Store` to hand back for that case, and silently
 * writing somewhere other than where the caller asked is worse than refusing
 * outright. Every other reported problem (unreadable file, invalid value,
 * failed write, throwing listener) is reported through the returned Store's
 * own `{ok:false}` results and log lines, never by throwing.
 *
 * @param {{dir:string, id:string, schema?:any, logger?:any}} opts
 * @returns {any} a Store - {id, schema, file, getAll, getAllSync, get, getSync,
 *   set, setAll, reset, resetAll, raw, onChange, reload}
 */
function createStore(opts) {
  const { dir, id, schema: rawSchema } = opts || {}
  const log = (opts && opts.logger) || noopLogger

  if (typeof dir !== 'string' || !dir) {
    throw new SmlnError('E_CONFIG', 'createStore requires a config directory')
  }
  const idResult = sanitiseId(id)
  if (!idResult.ok) throw new SmlnError('E_CONFIG', `createStore: ${idResult.reason}`)

  const absDir = path.resolve(dir)
  const file = path.join(absDir, `${idResult.safe}.json`)
  if (path.dirname(path.resolve(file)) !== absDir) {
    throw new SmlnError('E_CONFIG', `createStore: mod id "${id}" would escape the config directory`)
  }

  let schema
  const normalised = normaliseSchema(rawSchema)
  if (normalised.ok) {
    schema = normalised.schema
  } else {
    log.error(`config schema for "${id}" is invalid, ignoring it (values are stored unvalidated): ${normalised.error}`)
    schema = emptySchema()
  }

  let cache = null // null = not yet loaded from disk this session
  const listeners = new Set()

  // Reads are cached; a corrupt/missing file degrades to `{}` (all defaults)
  // rather than throwing, and the bad file itself is left untouched on disk -
  // only an explicit write ever replaces it.
  function ensureLoaded() {
    if (cache) return cache
    let onDisk = {}
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) onDisk = parsed
        else log.warn(`config file for "${id}" (${file}) does not contain a JSON object, falling back to defaults`)
      } catch (e) {
        log.warn(`config file for "${id}" (${file}) is unreadable, falling back to defaults: ${e.message}`)
      }
    }
    cache = onDisk
    const unknown = Object.keys(cache).filter((k) => !schema[k])
    if (unknown.length) {
      log.warn(`config for "${id}" has ${unknown.length} key(s) not declared by its schema, kept as-is: ${unknown.join(', ')}`)
    }
    return cache
  }

  function persist(nextRaw) {
    try {
      fs.mkdirSync(absDir, { recursive: true })
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(nextRaw, null, 2))
      fs.renameSync(tmp, file) // rename is the atomic step; a crash mid-write leaves only the .tmp
      return true
    } catch (e) {
      log.error(`could not save config for "${id}": ${e.message}`)
      return false
    }
  }

  function notify(key, value, oldValue) {
    // A mod's onChange callback is exactly as trustworthy as the mod itself.
    // One throwing listener must not stop the write it reacts to, or the
    // other listeners from running.
    for (const fn of listeners) {
      try { fn(key, value, oldValue) } catch (e) {
        log.error(`onChange listener for "${id}" threw on "${key}": ${e && e.message}`)
      }
    }
  }

  function getAllSync() {
    return { ...defaults(schema), ...ensureLoaded() }
  }

  function getSync(key) {
    const all = getAllSync()
    return key == null ? all : all[key]
  }

  function set(key, value) {
    if (typeof key !== 'string' || !key) {
      return { ok: false, error: new SmlnError('E_CONFIG', 'config key must be a non-empty string') }
    }
    const spec = schema[key]
    let finalValue = value
    if (spec) {
      const coerced = coerce(spec, value)
      if (!coerced.ok) {
        const error = new SmlnError('E_CONFIG', `${id}.${key}: ${coerced.reason}`)
        log.warn(String(error))
        return { ok: false, error }
      }
      finalValue = coerced.value
    } else {
      // No schema entry: a mod with no declared configSchema (most existing
      // Fluxloader mods), or a key a schema update dropped. Rejecting it would
      // silently lose a value the player or the mod already relies on.
      log.debug(`config "${id}.${key}" has no schema entry - stored without validation`)
    }

    const data = ensureLoaded()
    const oldValue = data[key]
    const next = { ...data, [key]: finalValue }
    if (!persist(next)) {
      return { ok: false, error: new SmlnError('E_CONFIG', `could not persist "${id}.${key}"`) }
    }
    cache = next
    notify(key, finalValue, oldValue)
    return { ok: true, value: finalValue }
  }

  function setAll(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, errors: { _: new SmlnError('E_CONFIG', 'setAll requires an object') } }
    }

    const errors = {}
    const coercedEntries = {}
    for (const [k, v] of Object.entries(obj)) {
      const spec = schema[k]
      if (!spec) { coercedEntries[k] = v; continue }
      const c = coerce(spec, v)
      if (!c.ok) { errors[k] = new SmlnError('E_CONFIG', `${id}.${k}: ${c.reason}`); continue }
      coercedEntries[k] = c.value
    }
    // All-or-nothing: a batch save (e.g. "Apply" in the settings UI) should
    // never leave some fields updated and others silently unchanged.
    if (Object.keys(errors).length) return { ok: false, errors }

    const data = ensureLoaded()
    const oldValues = {}
    for (const k of Object.keys(coercedEntries)) oldValues[k] = data[k]
    const next = { ...data, ...coercedEntries }
    if (!persist(next)) {
      return { ok: false, errors: { _: new SmlnError('E_CONFIG', `could not persist config for "${id}"`) } }
    }
    cache = next
    for (const k of Object.keys(coercedEntries)) notify(k, coercedEntries[k], oldValues[k])
    return { ok: true, value: getAllSync() }
  }

  function reset(key) {
    const data = ensureLoaded()
    if (!(key in data)) return { ok: true, value: getSync(key) }
    const oldValue = data[key]
    const next = { ...data }
    delete next[key]
    if (!persist(next)) {
      return { ok: false, error: new SmlnError('E_CONFIG', `could not persist reset of "${id}.${key}"`) }
    }
    cache = next
    const spec = schema[key]
    const newValue = spec ? spec.default : undefined
    notify(key, newValue, oldValue)
    return { ok: true, value: newValue }
  }

  function resetAll() {
    const oldData = { ...ensureLoaded() }
    if (!persist({})) {
      return { ok: false, error: new SmlnError('E_CONFIG', `could not persist reset of "${id}"`) }
    }
    cache = {}
    for (const k of Object.keys(oldData)) {
      const spec = schema[k]
      notify(k, spec ? spec.default : undefined, oldData[k])
    }
    return { ok: true, value: getAllSync() }
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return () => {}
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  function reload() {
    cache = null
    return getAllSync()
  }

  return {
    id,
    schema,
    file,
    async getAll() { return getAllSync() },
    getAllSync,
    async get(key) { return getSync(key) },
    getSync,
    set,
    setAll,
    reset,
    resetAll,
    raw() { return { ...ensureLoaded() } },
    onChange,
    reload,
  }
}

module.exports = {
  normaliseSchema,
  coerce,
  validateValue,
  defaults,
  createStore,
}
