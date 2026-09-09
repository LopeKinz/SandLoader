'use strict'
/**
 * Map generator parameters, and the seeded randomness every stage draws from.
 *
 * Three modules sit downstream of this one - `mapgen-shape.js`, `mapgen-caves.js`
 * and `mapgen-ore.js`. Each is handed an `rng` function from here and its own
 * slice of a `params` object from here, which is why the parameters are grouped
 * by stage rather than flattened: a caller passes `params.shape` to the shape
 * module and nothing else, and no stage can read a knob that is not its own.
 *
 * **Every number in DEFAULTS and PRESETS is judgement, not measurement.** No map
 * this module has parameterised has been generated, loaded or played. The values
 * were chosen so the layers stack in an order that makes sense against
 * `terrain-palette.js` - dirt the starting shovel can move, then soil it can
 * still get through, then rock that wants a drill, then bedrock - and so the
 * cave and ore numbers sit in the range those algorithms usually want. They are
 * a starting point for a mapmaker to move, not a tuned result. Anything here
 * described as "good" or "forgiving" is a prediction that has not been checked.
 *
 * What this module deliberately does NOT own:
 *
 *  - **Map size.** `SMLN.mapEditor.limits()` already owns the floor (158 x 201,
 *    derived from where the game drops the player), the ceiling and the memory
 *    cost. Nothing here validates a width or a height, and `normalise` will not
 *    accept one. The `suggestedSize` on a preset is a suggestion only - the
 *    editor may refuse it, and the editor is right.
 *  - **Colour meaning.** The hex values below are drawn from `terrain-palette.js`,
 *    which is the authority on what each one does to a player. This module only
 *    checks that a colour is a well-formed `#rrggbb`; it does not require the
 *    palette to recognise it, because a mapmaker may know about a colour the
 *    table has not caught up with yet.
 *
 * No dependencies, plain CommonJS.
 */

/* ------------------------------------------------------------------ *
 * Seeded randomness
 * ------------------------------------------------------------------ */

/**
 * xmur3 - a small, well-travelled string hash, used only to turn a seed of any
 * shape into the single 32-bit integer mulberry32 wants. Its job is avalanche:
 * `aurora-7` and `aurora-8` must land on states that are nowhere near each
 * other, or a one-character seed edit would produce a recognisably similar map.
 * @param {string} str
 * @returns {function(): number} successive 32-bit unsigned hashes
 */
function xmur3(str) {
  var h = 1779033703 ^ str.length
  for (var i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16
    return h >>> 0
  }
}

/**
 * mulberry32 - 32 bits of state, one multiply-and-xorshift round per draw.
 *
 * Chosen because it is tiny, has no dependencies, passes the usual small-PRNG
 * smoke tests, and - the part that matters here - is entirely determined by its
 * 32-bit state, so the same seed always replays the same map. It is not
 * cryptographic and must never be used as though it were.
 * @param {number} a  32-bit seed state
 * @returns {function(): number} a float in [0,1)
 */
function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    var t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A deterministic random source for one map.
 *
 * `rng('cobalt-gulch-41')` twice gives two functions that produce the identical
 * sequence. A number seed and its decimal string are the same seed, because the
 * seed is hashed as text: `rng(7)` and `rng('7')` agree.
 * @param {string|number} seed
 * @returns {function(): number} a float in [0,1)
 */
function rng(seed) {
  var text
  if (typeof seed === 'string') text = seed
  else if (seed === undefined || seed === null) text = ''
  else {
    // A seed can arrive from a UI or a mod, so a hostile `toString` is possible.
    try { text = String(seed) } catch (e) { text = '' }
  }
  return mulberry32(xmur3(text)())
}

/* ------------------------------------------------------------------ *
 * The parameter specification
 * ------------------------------------------------------------------ */

/**
 * Every parameter, with the bound `normalise` holds it to.
 *
 * `def` is the value DEFAULTS carries, so the two can never drift apart. `kind`
 * decides how a supplied value is read: `number` and `int` clamp into
 * [min,max], `fraction` is a number whose range happens to be inside 0..1,
 * `boolean` takes true/false, `colour` takes `#rrggbb`, and `materials` is the
 * ore table with its own item rules.
 *
 * Key order matters in one place only: `ore.materials` is read last so that a
 * material omitting `veinSize` can inherit the already-settled `ore.veinSize`.
 */
var SPEC = {

  /**
   * Stage one: the ground itself - where the surface sits, how it wobbles, and
   * what the column underneath is made of. Depths are in cells measured DOWN
   * from that column's own surface line, not from the top of the map, so a
   * hilly map keeps a constant topsoil thickness over the hills.
   */
  shape: {
    // Where the mean ground surface sits, as a fraction of map height from the
    // top. 0.18 leaves a healthy sky to fall through and build in.
    surfaceLevel: { kind: 'fraction', def: 0.18, min: 0.02, max: 0.90 },
    // How far the surface rises and falls, in cells, peak to trough.
    surfaceAmplitude: { kind: 'number', def: 24, min: 0, max: 4000 },
    // How jagged that rise and fall is: 0 is a smooth swell, 1 is broken scree.
    surfaceRoughness: { kind: 'fraction', def: 0.35, min: 0, max: 1 },
    // Cells from one hilltop to the next. Small values make a comb, not hills.
    surfaceWavelength: { kind: 'number', def: 90, min: 4, max: 4000 },
    // Cells of diggable topsoil below the surface line. Dirt is hit points 4,
    // so this is the band the player can move in their first minute.
    topsoilDepth: { kind: 'int', def: 8, min: 0, max: 4000 },
    // Cells below the surface line where the hard layer begins. Everything
    // between topsoilDepth and here is the bulk stone band.
    hardLayerDepth: { kind: 'int', def: 140, min: 1, max: 8000 },
    // Cells of permanent floor along the bottom edge.
    floorThickness: { kind: 'int', def: 6, min: 0, max: 512 },
    // Cells of permanent wall along each side edge.
    borderThickness: { kind: 'int', def: 4, min: 0, max: 512 },
    // Open air above the surface. #990000 is the one air colour with no side
    // effects - see terrain-palette.js on why #ff0000 is not it.
    skyMaterial: { kind: 'colour', def: '#990000' },
    // Dirt: hit points 4, no tool requirement.
    topsoilMaterial: { kind: 'colour', def: '#000000' },
    // Sandium soil: hit points 20, the toughest thing the starting shovel can
    // still get through, so the middle of the map is slow but never a wall.
    stoneMaterial: { kind: 'colour', def: '#ff5500' },
    // Solid rock: excavation requirement "drill", so the hard layer is a real
    // progression gate rather than just more digging.
    hardLayerMaterial: { kind: 'colour', def: '#aaaaaa' },
    // Bedrock: indestructible, which is what a floor has to be.
    floorMaterial: { kind: 'colour', def: '#222222' },
    borderMaterial: { kind: 'colour', def: '#222222' },
  },

  /**
   * Stage two: the caves cut into that ground.
   */
  caves: {
    // How much of the underground starts as open space before smoothing. Around
    // 0.45 is where cellular smoothing usually settles into rooms rather than
    // either static or a solid block; below 0.2 expect almost nothing.
    caveDensity: { kind: 'fraction', def: 0.44, min: 0, max: 0.90 },
    // How many smoothing rounds turn that noise into rooms. More rounds mean
    // fewer, rounder, larger caverns.
    smoothingPasses: { kind: 'int', def: 4, min: 0, max: 12 },
    // Pockets smaller than this many cells are filled back in, so the map does
    // not end up freckled with holes too small to enter.
    minCaveSize: { kind: 'int', def: 60, min: 1, max: 100000 },
    // Cells of untouched ground kept between the surface line and any cave, so
    // caverns do not open into the sky.
    minDepthBelowSurface: { kind: 'int', def: 18, min: 0, max: 4000 },
    // Cells of untouched ground kept above the floor.
    minHeightAboveFloor: { kind: 'int', def: 4, min: 0, max: 4000 },
    // Whether isolated caverns get tunnels joining them to their neighbours.
    connectCaves: { kind: 'boolean', def: true },
    // How wide those tunnels are, in cells.
    tunnelWidth: { kind: 'int', def: 3, min: 1, max: 64 },
    // What a carved cave becomes. Air, unless a mapmaker wants water caves.
    caveMaterial: { kind: 'colour', def: '#990000' },
  },

  /**
   * Stage three: ore veins salted through what is left.
   */
  ore: {
    // Target number of veins for the whole map, not per screen or per area.
    veinCount: { kind: 'int', def: 120, min: 0, max: 20000 },
    // Mean cells in a vein. A material may override it.
    veinSize: { kind: 'int', def: 24, min: 1, max: 20000 },
    // How much vein size varies around that mean: 0 is every vein identical,
    // 1 is anything from a single cell to twice the mean.
    veinSizeVariation: { kind: 'fraction', def: 0.5, min: 0, max: 1 },
    // Whether veins are trimmed back to solid ground, so none is left hanging
    // in open air where a cave has already been carved.
    keepInsideRock: { kind: 'boolean', def: true },
    /**
     * The depth band each material may appear in.
     *
     * `fromDepth` and `toDepth` are fractions of the underground column: 0 is
     * the surface line for that column, 1 is the top of the floor. They are
     * fractions rather than cells so a band means the same thing on a 400-row
     * map and a 4000-row one.
     *
     * `share` is a relative weight against the other materials, not a
     * percentage. `veinSize` overrides `ore.veinSize` for this material; omit it
     * and it inherits.
     *
     * The default three are a progression, not a random pick: crystal is a long
     * shovel dig and sits shallow, copper needs a drill and sits under it, and
     * fluxite is deepest.
     */
    materials: {
      kind: 'materials',
      def: [
        { name: 'Crystal', colour: '#0094b3', fromDepth: 0.02, toDepth: 0.45, share: 3, veinSize: 20 },
        { name: 'Copper ore', colour: '#ffa500', fromDepth: 0.15, toDepth: 0.80, share: 2, veinSize: 26 },
        { name: 'Fluxite ore', colour: '#af00e0', fromDepth: 0.55, toDepth: 1.00, share: 1, veinSize: 14 },
      ],
    },
  },
}

/** One row of `ore.materials`. */
var MATERIAL_SPEC = {
  name: { kind: 'text', def: '', max: 60 },
  colour: { kind: 'colour', def: null, required: true },
  fromDepth: { kind: 'fraction', def: 0, min: 0, max: 1 },
  toDepth: { kind: 'fraction', def: 1, min: 0, max: 1 },
  share: { kind: 'number', def: 1, min: 0, max: 1000 },
  veinSize: { kind: 'int', def: null, min: 1, max: 20000, inheritFrom: 'veinSize' },
}

/** The seed the map was or will be generated from. `null` means "not chosen". */
var SEED_SPEC = { kind: 'seed', def: null, max: 120 }

/** The stage groups, in the order a caller reads them. */
var GROUPS = ['shape', 'caves', 'ore']

/** At most this many ore materials; beyond it the table is a mistake, not a map. */
var MAX_MATERIALS = 32

/* ------------------------------------------------------------------ *
 * Small helpers, all of them throw-proof where hostile input can reach them
 * ------------------------------------------------------------------ */

/** Deep copy of the plain data this module deals in. */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (value && typeof value === 'object') {
    var out = {}
    for (var k in value) {
      if (Object.prototype.hasOwnProperty.call(value, k)) out[k] = clone(value[k])
    }
    return out
  }
  return value
}

/** Freeze a whole tree, so a caller cannot edit DEFAULTS out from under itself. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (var k in value) {
      if (Object.prototype.hasOwnProperty.call(value, k)) deepFreeze(value[k])
    }
  }
  return value
}

/** `obj[key]`, surviving a getter that throws. */
function read(obj, key) {
  try { return { ok: true, value: obj[key] } } catch (e) {
    return { ok: false, reason: 'reading it threw (' + describeError(e) + ')' }
  }
}

/** `Object.keys`, surviving a proxy whose ownKeys trap throws. Null on failure. */
function safeKeys(obj) {
  try { return Object.keys(obj) } catch (e) { return null }
}

/** Something short and safe to put in a message, whatever the value is. */
function describeValue(v) {
  try {
    if (v === null) return 'null'
    if (v === undefined) return 'undefined'
    if (Array.isArray(v)) return 'an array'
    var t = typeof v
    if (t === 'string') return JSON.stringify(v.length > 40 ? v.slice(0, 40) + '…' : v)
    if (t === 'number' || t === 'boolean') return String(v)
    if (t === 'object') return 'an object'
    return 'a ' + t
  } catch (e) { return 'an unreadable value' }
}

/** An error's message, surviving an error object that is itself hostile. */
function describeError(e) {
  try {
    if (e && typeof e.message === 'string' && e.message) return e.message
    return String(e)
  } catch (_) { return 'unknown error' }
}

/** A refusal, with the parameter path already in the sentence. */
function fail(path, message) {
  return { ok: false, reason: path + ': ' + message }
}

/** A number from a number or a numeric string; null if it is neither. */
function toNumber(raw) {
  if (typeof raw === 'number') return isFinite(raw) ? raw : null
  if (typeof raw === 'string') {
    var s = raw.trim()
    if (!s) return null
    var n = Number(s)
    return isFinite(n) ? n : null
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Coercion, one kind at a time
 * ------------------------------------------------------------------ */

/**
 * Read one value against its spec. Silly values are clamped; values that cannot
 * be made into the thing the spec asks for are refused by name and bound.
 * @returns {{ok: true, value: *}|{ok: false, reason: string}}
 */
function coerce(spec, raw, path, inherited) {
  switch (spec.kind) {

    case 'number':
    case 'int':
    case 'fraction': {
      var n = toNumber(raw)
      if (n === null) {
        return fail(path, 'expected a number between ' + spec.min + ' and ' + spec.max +
          ', got ' + describeValue(raw))
      }
      if (n < spec.min) n = spec.min
      if (n > spec.max) n = spec.max
      if (spec.kind === 'int') n = Math.round(n)
      return { ok: true, value: n }
    }

    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw }
      if (raw === 'true') return { ok: true, value: true }
      if (raw === 'false') return { ok: true, value: false }
      return fail(path, 'expected true or false, got ' + describeValue(raw))
    }

    case 'colour': {
      if (typeof raw !== 'string') {
        return fail(path, 'expected a #rrggbb hex colour, got ' + describeValue(raw))
      }
      var hex = raw.trim().replace(/^#/, '').toLowerCase()
      if (!/^[0-9a-f]{6}$/.test(hex)) {
        return fail(path, 'expected a #rrggbb hex colour, got ' + describeValue(raw))
      }
      return { ok: true, value: '#' + hex }
    }

    case 'text': {
      if (typeof raw !== 'string') return fail(path, 'expected a string, got ' + describeValue(raw))
      return { ok: true, value: raw.trim().slice(0, spec.max) }
    }

    case 'seed': {
      if (raw === null) return { ok: true, value: null }
      if (typeof raw === 'number') {
        if (!isFinite(raw)) return fail(path, 'expected a finite number or a non-empty string, got ' + describeValue(raw))
        return { ok: true, value: raw }
      }
      if (typeof raw !== 'string') {
        return fail(path, 'expected a non-empty string or a number, got ' + describeValue(raw))
      }
      var text = raw.trim()
      if (!text) return fail(path, 'must not be empty - use randomSeed() for one, or null for none')
      if (text.length > spec.max) {
        return fail(path, 'must be ' + spec.max + ' characters or fewer, got ' + text.length)
      }
      return { ok: true, value: text }
    }

    case 'materials':
      return coerceMaterials(raw, path, inherited)
  }
  /* istanbul ignore next - unreachable while SPEC and coerce agree */
  return fail(path, 'has no rule to check it against')
}

/**
 * The ore table. Arrays replace rather than merge: half a materials list is not
 * a meaningful thing to ask for, so a caller supplying one supplies all of it.
 */
function coerceMaterials(raw, path, oreSoFar) {
  if (!Array.isArray(raw)) {
    return fail(path, 'expected an array of materials, got ' + describeValue(raw))
  }
  if (raw.length > MAX_MATERIALS) {
    return fail(path, 'at most ' + MAX_MATERIALS + ' materials, got ' + raw.length)
  }
  var out = []
  var names = Object.keys(MATERIAL_SPEC)
  for (var i = 0; i < raw.length; i++) {
    var here = path + '[' + i + ']'
    var got = read(raw, i)
    if (!got.ok) return fail(here, got.reason)
    var item = got.value
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return fail(here, 'expected an object, got ' + describeValue(item))
    }
    var given = safeKeys(item)
    if (!given) return fail(here, 'its own keys could not be listed')
    for (var g = 0; g < given.length; g++) {
      if (names.indexOf(given[g]) < 0) {
        return fail(here + '.' + given[g], 'not a property of an ore material; expected one of ' + names.join(', '))
      }
    }
    var row = {}
    for (var n = 0; n < names.length; n++) {
      var key = names[n]
      var spec = MATERIAL_SPEC[key]
      var at = here + '.' + key
      if (given.indexOf(key) < 0) {
        if (spec.required) return fail(at, 'is required - a material with no colour cannot be placed')
        row[key] = spec.inheritFrom ? oreSoFar[spec.inheritFrom] : clone(spec.def)
        continue
      }
      var value = read(item, key)
      if (!value.ok) return fail(at, value.reason)
      if (value.value === undefined) {
        if (spec.required) return fail(at, 'is required - a material with no colour cannot be placed')
        row[key] = spec.inheritFrom ? oreSoFar[spec.inheritFrom] : clone(spec.def)
        continue
      }
      var checked = coerce(spec, value.value, at, oreSoFar)
      if (!checked.ok) return checked
      row[key] = checked.value
    }
    if (!(row.fromDepth < row.toDepth)) {
      return fail(here, 'fromDepth (' + row.fromDepth + ') must be less than toDepth (' + row.toDepth +
        ') - the top of a band has to sit above its bottom, or it holds no cells')
    }
    out.push(row)
  }
  if (out.length) {
    var total = 0
    for (var t = 0; t < out.length; t++) total += out[t].share
    if (!(total > 0)) {
      return fail(path, 'every share is 0, so no material could ever be chosen')
    }
  }
  return { ok: true, value: out }
}

/* ------------------------------------------------------------------ *
 * DEFAULTS
 * ------------------------------------------------------------------ */

function buildDefaults() {
  var out = { seed: clone(SEED_SPEC.def) }
  for (var i = 0; i < GROUPS.length; i++) {
    var group = GROUPS[i]
    out[group] = {}
    var keys = Object.keys(SPEC[group])
    for (var k = 0; k < keys.length; k++) out[group][keys[k]] = clone(SPEC[group][keys[k]].def)
  }
  return out
}

/**
 * Every parameter the three stages read, at its default value.
 *
 * Frozen: `normalise` hands back a fresh copy, so nothing a caller does to its
 * own parameters can reach back into this.
 */
var DEFAULTS = deepFreeze(buildDefaults())

/* ------------------------------------------------------------------ *
 * normalise
 * ------------------------------------------------------------------ */

/**
 * Turn whatever a caller supplied into a complete, in-range parameter object -
 * or say, in one sentence, why it cannot be one.
 *
 * Gaps are filled from DEFAULTS. Values that are merely silly are clamped into
 * range. Values that cannot work are refused, and the refusal names the
 * parameter and the bound it missed.
 *
 * It never throws. `null` and `undefined` mean "nothing supplied" and give the
 * defaults; a string, a number or an array is a wrong-shaped input and is
 * refused; an object whose getters or key list throw is refused with the fact
 * that it threw. Unknown keys are refused rather than ignored, because a
 * misspelled parameter that is silently dropped is a map that quietly is not
 * the map that was asked for.
 *
 * Note what is NOT checked: map width and height. Those belong to the editor's
 * own `limits()`, and duplicating them here would let the two drift.
 *
 * @param {*} input
 * @returns {{ok: true, params: object}|{ok: false, reason: string}}
 */
function normalise(input) {
  try {
    return normaliseInner(input)
  } catch (e) {
    // Nothing below should throw, but the promise is that this never does, and
    // a promise with an exception in it is not a promise.
    return { ok: false, reason: 'input: could not be read (' + describeError(e) + ')' }
  }
}

function normaliseInner(input) {
  if (input === undefined || input === null) return { ok: true, params: clone(DEFAULTS) }
  if (Array.isArray(input)) {
    return fail('input', 'expected an object of parameter groups, got an array')
  }
  if (typeof input !== 'object') {
    return fail('input', 'expected an object of parameter groups, got ' + describeValue(input))
  }

  var top = safeKeys(input)
  if (!top) return fail('input', 'its own keys could not be listed')
  var allowed = ['seed'].concat(GROUPS)
  for (var a = 0; a < top.length; a++) {
    if (allowed.indexOf(top[a]) < 0) {
      return fail(top[a], 'not a parameter group; expected one of ' + allowed.join(', '))
    }
  }

  var params = clone(DEFAULTS)

  if (top.indexOf('seed') >= 0) {
    var seedRead = read(input, 'seed')
    if (!seedRead.ok) return fail('seed', seedRead.reason)
    if (seedRead.value !== undefined) {
      var seed = coerce(SEED_SPEC, seedRead.value, 'seed', null)
      if (!seed.ok) return seed
      params.seed = seed.value
    }
  }

  for (var i = 0; i < GROUPS.length; i++) {
    var group = GROUPS[i]
    if (top.indexOf(group) < 0) continue

    var groupRead = read(input, group)
    if (!groupRead.ok) return fail(group, groupRead.reason)
    var supplied = groupRead.value
    if (supplied === undefined || supplied === null) continue
    if (typeof supplied !== 'object' || Array.isArray(supplied)) {
      return fail(group, 'expected an object of parameters, got ' + describeValue(supplied))
    }

    var given = safeKeys(supplied)
    if (!given) return fail(group, 'its own keys could not be listed')
    var spec = SPEC[group]
    var known = Object.keys(spec)
    for (var g = 0; g < given.length; g++) {
      if (known.indexOf(given[g]) < 0) {
        return fail(group + '.' + given[g],
          'not a parameter of ' + group + '; expected one of ' + known.join(', '))
      }
    }

    // Walk the spec, not the input, so `ore.materials` is read after
    // `ore.veinSize` and can inherit it.
    for (var k = 0; k < known.length; k++) {
      var key = known[k]
      if (given.indexOf(key) < 0) continue
      var valueRead = read(supplied, key)
      if (!valueRead.ok) return fail(group + '.' + key, valueRead.reason)
      if (valueRead.value === undefined) continue
      var checked = coerce(spec[key], valueRead.value, group + '.' + key, params[group])
      if (!checked.ok) return checked
      params[group][key] = checked.value
    }
  }

  var crossed = checkCombinations(params)
  if (crossed) return crossed

  return { ok: true, params: params }
}

/**
 * The refusals that no single parameter can see - each value below is legal on
 * its own and impossible next to its neighbour.
 * @returns {{ok: false, reason: string}|null}
 */
function checkCombinations(params) {
  if (params.shape.topsoilDepth >= params.shape.hardLayerDepth) {
    return fail('shape.topsoilDepth', 'is ' + params.shape.topsoilDepth +
      ', which is not above shape.hardLayerDepth (' + params.shape.hardLayerDepth +
      ') - the topsoil has to end before the hard layer begins')
  }
  if (params.ore.materials.length === 0 && params.ore.veinCount > 0) {
    return fail('ore.materials', 'is empty, but ore.veinCount is ' + params.ore.veinCount +
      ' - set veinCount to 0 for a map with no ore')
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Presets
 * ------------------------------------------------------------------ */

/** A complete parameter set: DEFAULTS with this preset's changes laid over it. */
function withChanges(changes) {
  var out = clone(DEFAULTS)
  var groups = Object.keys(changes)
  for (var i = 0; i < groups.length; i++) {
    var group = groups[i]
    var keys = Object.keys(changes[group])
    for (var k = 0; k < keys.length; k++) out[group][keys[k]] = clone(changes[group][keys[k]])
  }
  return out
}

/**
 * Four starting points that produce four recognisably different worlds.
 *
 * Deliberately few. A dozen presets that differ by a rounding are a menu nobody
 * can choose from; these four disagree about the things a player would notice
 * first - how much sky there is, whether the ground is walkable, whether caves
 * exist at all, and how far down the ore is.
 *
 * `params` is complete, so `normalise(preset.params)` returns it unchanged.
 *
 * `suggestedSize` is a SUGGESTION and nothing more. The map editor's `limits()`
 * owns the real floor (158 x 201), ceiling and memory cost, and may refuse any
 * of these; nothing in this module validates them.
 *
 * As above: judgement, not measurement. None of these has been generated.
 */
var PRESETS = deepFreeze({

  rollingHills: {
    name: 'Rolling Hills',
    description: 'Soft, walkable ground with wide caverns underneath and crystal within reach of a starting shovel.',
    suggestedSize: { width: 900, height: 500 },
    params: withChanges({
      shape: {
        surfaceLevel: 0.22,
        surfaceAmplitude: 18,
        surfaceRoughness: 0.22,
        surfaceWavelength: 130,
        topsoilDepth: 12,
        hardLayerDepth: 180,
      },
      caves: {
        caveDensity: 0.46,
        smoothingPasses: 5,
        minCaveSize: 120,
        minDepthBelowSurface: 24,
        tunnelWidth: 4,
      },
      ore: {
        veinCount: 140,
        veinSize: 28,
        materials: [
          { name: 'Crystal', colour: '#0094b3', fromDepth: 0.02, toDepth: 0.50, share: 3, veinSize: 24 },
          { name: 'Copper ore', colour: '#ffa500', fromDepth: 0.12, toDepth: 0.85, share: 2, veinSize: 30 },
          { name: 'Fluxite ore', colour: '#af00e0', fromDepth: 0.50, toDepth: 1.00, share: 1, veinSize: 18 },
        ],
      },
    }),
  },

  brokenBadlands: {
    name: 'Broken Badlands',
    description: 'Jagged ridges over a thin crust: short walks, awkward climbs, and ore that only turns up deep.',
    suggestedSize: { width: 1200, height: 500 },
    params: withChanges({
      shape: {
        surfaceLevel: 0.32,
        surfaceAmplitude: 90,
        surfaceRoughness: 0.85,
        surfaceWavelength: 45,
        topsoilDepth: 3,
        hardLayerDepth: 70,
      },
      caves: {
        caveDensity: 0.40,
        smoothingPasses: 2,
        minCaveSize: 30,
        minDepthBelowSurface: 8,
        connectCaves: false,
        tunnelWidth: 2,
      },
      ore: {
        veinCount: 70,
        veinSize: 16,
        veinSizeVariation: 0.75,
        materials: [
          { name: 'Crystal', colour: '#0094b3', fromDepth: 0.25, toDepth: 0.60, share: 2, veinSize: 14 },
          { name: 'Copper ore', colour: '#ffa500', fromDepth: 0.40, toDepth: 0.90, share: 2, veinSize: 18 },
          { name: 'Fluxite ore', colour: '#af00e0', fromDepth: 0.70, toDepth: 1.00, share: 1, veinSize: 12 },
        ],
      },
    }),
  },

  deepWarren: {
    name: 'Deep Warren',
    description: 'Barely any sky - one connected cave system all the way down, with the payoff at the bottom.',
    suggestedSize: { width: 500, height: 1400 },
    params: withChanges({
      shape: {
        surfaceLevel: 0.06,
        surfaceAmplitude: 10,
        surfaceRoughness: 0.40,
        surfaceWavelength: 70,
        topsoilDepth: 4,
        hardLayerDepth: 400,
      },
      caves: {
        caveDensity: 0.55,
        smoothingPasses: 6,
        minCaveSize: 40,
        minDepthBelowSurface: 6,
        minHeightAboveFloor: 2,
        connectCaves: true,
        tunnelWidth: 3,
      },
      ore: {
        veinCount: 220,
        veinSize: 18,
        veinSizeVariation: 0.4,
        materials: [
          { name: 'Crystal', colour: '#0094b3', fromDepth: 0.05, toDepth: 0.35, share: 2, veinSize: 16 },
          { name: 'Copper ore', colour: '#ffa500', fromDepth: 0.20, toDepth: 0.70, share: 2, veinSize: 20 },
          { name: 'Fluxite ore', colour: '#af00e0', fromDepth: 0.65, toDepth: 1.00, share: 3, veinSize: 26 },
        ],
      },
    }),
  },

  solidCrust: {
    name: 'Solid Crust',
    description: 'Almost no natural caves: every tunnel is one the player dug, and ore is everywhere for those who dig.',
    suggestedSize: { width: 800, height: 600 },
    params: withChanges({
      shape: {
        surfaceLevel: 0.20,
        surfaceAmplitude: 30,
        surfaceRoughness: 0.30,
        surfaceWavelength: 100,
        topsoilDepth: 10,
        hardLayerDepth: 90,
      },
      caves: {
        caveDensity: 0.12,
        smoothingPasses: 8,
        minCaveSize: 400,
        minDepthBelowSurface: 40,
        connectCaves: false,
        tunnelWidth: 2,
      },
      ore: {
        veinCount: 260,
        veinSize: 30,
        veinSizeVariation: 0.35,
        materials: [
          { name: 'Crystal', colour: '#0094b3', fromDepth: 0.02, toDepth: 0.55, share: 2, veinSize: 30 },
          { name: 'Copper ore', colour: '#ffa500', fromDepth: 0.10, toDepth: 0.95, share: 2, veinSize: 34 },
          { name: 'Fluxite ore', colour: '#af00e0', fromDepth: 0.45, toDepth: 1.00, share: 2, veinSize: 22 },
        ],
      },
    }),
  },
})

/* ------------------------------------------------------------------ *
 * randomSeed
 * ------------------------------------------------------------------ */

/*
 * Two short word lists and two digits: 26 x 26 x 90 is 60,840 seeds, which is
 * plenty for "give me another one" and few enough that every seed can be read
 * aloud, written on a note and typed back in without a mistake. A hex blob
 * would have more entropy and nobody would ever share one.
 */
var SEED_HEADS = [
  'amber', 'ashen', 'basalt', 'brine', 'cobalt', 'copper', 'dusty', 'ember',
  'flint', 'frozen', 'gilded', 'granite', 'glassy', 'iron', 'jagged', 'lumen',
  'mossy', 'ochre', 'quartz', 'rusted', 'salted', 'shale', 'silver', 'slate',
  'umber', 'verdant',
]
var SEED_TAILS = [
  'basin', 'bluff', 'canyon', 'chasm', 'crag', 'delve', 'drift', 'dune',
  'fault', 'gulch', 'hollow', 'ledge', 'mesa', 'mire', 'notch', 'pitch',
  'quarry', 'reach', 'ridge', 'scarp', 'shelf', 'shoal', 'spire', 'trench',
  'vault', 'warren',
]

/**
 * A fresh seed a person can read out over a voice call, like `cobalt-gulch-41`.
 *
 * This is the only place `Math.random` is used, and it is used for exactly the
 * thing it is good at: picking an arbitrary starting point. The generation
 * itself never touches it - that is `rng`'s job.
 * @returns {string}
 */
function randomSeed() {
  var head = SEED_HEADS[Math.floor(Math.random() * SEED_HEADS.length)]
  var tail = SEED_TAILS[Math.floor(Math.random() * SEED_TAILS.length)]
  var number = 10 + Math.floor(Math.random() * 90)
  return head + '-' + tail + '-' + number
}

module.exports = {
  rng: rng,
  DEFAULTS: DEFAULTS,
  PRESETS: PRESETS,
  normalise: normalise,
  randomSeed: randomSeed,
}
