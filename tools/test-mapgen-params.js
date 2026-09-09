#!/usr/bin/env node
'use strict'
/** Regression tests for the map generator's parameters and seeded randomness. */

const params = require('../src/game/mapgen-params')

function assert(value, message) {
  if (!value) throw new Error(message)
}

/** Structural equality over the plain data this module deals in. */
function same(a, b) {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => same(v, b[i]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort()
    const kb = Object.keys(b).sort()
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false
    return ka.every((k) => same(a[k], b[k]))
  }
  return false
}

/** Every leaf path in an object, as `a.b[0].c` strings. */
function leafPaths(value, prefix, out) {
  out = out || []
  prefix = prefix || ''
  if (Array.isArray(value)) {
    value.forEach((v, i) => leafPaths(v, prefix + '[' + i + ']', out))
  } else if (value && typeof value === 'object') {
    Object.keys(value).forEach((k) => leafPaths(value[k], prefix ? prefix + '.' + k : k, out))
  } else {
    out.push(prefix)
  }
  return out
}

/** The value at one of those paths. */
function atPath(root, path) {
  return path.split(/\.|(?=\[)/).reduce((node, step) => {
    const m = /^\[(\d+)\]$/.exec(step)
    return m ? node[Number(m[1])] : node[step]
  }, root)
}

/** Call `normalise` and insist it answered at all, whatever it answered. */
function tryNormalise(input, label) {
  let r
  try {
    r = params.normalise(input)
  } catch (e) {
    throw new Error('normalise threw on ' + label + ': ' + (e && e.message))
  }
  assert(r && typeof r === 'object', 'normalise returned no result for ' + label)
  assert(r.ok === true || r.ok === false, 'normalise result for ' + label + ' has no boolean ok')
  if (r.ok === false) {
    assert(typeof r.reason === 'string' && r.reason.length > 0,
      'refusal of ' + label + ' carries no reason')
  } else {
    assert(r.params && typeof r.params === 'object', 'accepted ' + label + ' with no params')
  }
  return r
}

// --- the PRNG -------------------------------------------------------------

function testSeedDeterminism() {
  const draws = (seed, n) => {
    const next = params.rng(seed)
    const out = []
    for (let i = 0; i < n; i++) out.push(next())
    return out
  }

  const a = draws('cobalt-gulch-41', 200)
  const b = draws('cobalt-gulch-41', 200)
  assert(same(a, b), 'the same seed produced two different sequences')

  // A whole new generator mid-way must still replay from the start.
  const restarted = params.rng('cobalt-gulch-41')
  assert(restarted() === a[0], 'a second generator on the same seed did not start where the first did')

  for (const v of a) {
    assert(typeof v === 'number' && v >= 0 && v < 1, 'a draw left [0,1): ' + v)
  }

  // A number seed and its decimal string are the same seed.
  assert(same(draws(7, 20), draws('7', 20)), 'rng(7) and rng("7") disagreed')

  // Different seeds must not merely diverge later - they must not overlap now.
  const different = draws('umber-trench-12', 200)
  assert(!same(a, different), 'two different seeds produced the identical sequence')

  // One character changed is the case that actually catches a fake PRNG: a
  // closure over Math.random passes "same seed, same sequence" only by accident,
  // and a weak hash makes neighbouring seeds share a prefix.
  // Rearranged seeds too: a hash that just adds character codes gives every
  // anagram the same map, and "gulch-cobalt-41" is a seed somebody will type.
  const neighbours = [
    'cobalt-gulch-42', 'cobalt-gulch-4', 'Cobalt-gulch-41', 'cobalt-gulch-51', 'cobalt-gulcy-41',
    'gulch-cobalt-41', 'cobalt-gulch-14', 'cobalt-glcuh-41',
  ]
  for (const seed of neighbours) {
    const other = draws(seed, 64)
    const shared = other.filter((v, i) => v === a[i]).length
    assert(shared === 0,
      'seed "' + seed + '" shared ' + shared + ' of the first 64 draws with "cobalt-gulch-41"')
    assert(Math.abs(other[0] - a[0]) > 0.001,
      'seed "' + seed + '" started within 0.001 of "cobalt-gulch-41" - the seed hash is not mixing')
  }
}

function testSeedUniformity() {
  const BUCKETS = 20
  const DRAWS = 200000
  const counts = new Array(BUCKETS).fill(0)
  const next = params.rng('uniformity-probe')
  let total = 0
  for (let i = 0; i < DRAWS; i++) {
    const v = next()
    total += v
    const bucket = Math.floor(v * BUCKETS)
    assert(bucket >= 0 && bucket < BUCKETS, 'a draw fell outside [0,1): ' + v)
    counts[bucket]++
  }

  // Expected 10000 a bucket, standard deviation about 98, so +/-5% is five
  // sigma: wide enough never to flake, tight enough to catch a broken generator.
  const expected = DRAWS / BUCKETS
  counts.forEach((n, i) => {
    assert(Math.abs(n - expected) < expected * 0.05,
      'bucket ' + i + ' held ' + n + ' of ' + DRAWS + ' draws, expected about ' + expected)
  })
  const mean = total / DRAWS
  assert(Math.abs(mean - 0.5) < 0.01, 'the mean draw was ' + mean + ', expected about 0.5')
}

function testRandomSeed() {
  const seeds = []
  for (let i = 0; i < 400; i++) seeds.push(params.randomSeed())
  for (const s of seeds) {
    assert(typeof s === 'string', 'randomSeed did not return a string')
    assert(/^[a-z]+-[a-z]+-\d\d$/.test(s), 'randomSeed produced something unreadable: ' + JSON.stringify(s))
    assert(s.length <= 24, 'randomSeed produced something too long to read back: ' + s)
  }
  assert(new Set(seeds).size > 150, 'randomSeed repeated itself far too often across 400 calls')

  // And the seeds it makes must actually work as seeds.
  const one = params.randomSeed()
  assert(params.rng(one)() === params.rng(one)(), 'a generated seed did not replay')

  const accepted = tryNormalise({ seed: one }, 'a generated seed')
  assert(accepted.ok && accepted.params.seed === one, 'normalise rejected a seed randomSeed made')
}

// --- DEFAULTS -------------------------------------------------------------

function testDefaultsSurviveNormalise() {
  const empty = tryNormalise({}, '{}')
  assert(empty.ok, 'normalise({}) was refused: ' + empty.reason)
  assert(same(empty.params, params.DEFAULTS),
    'normalise({}) did not reproduce DEFAULTS exactly')

  // Named explicitly as well, so a dropped key is a message about that key
  // rather than a bare "not equal".
  for (const path of leafPaths(params.DEFAULTS)) {
    const got = atPath(empty.params, path)
    assert(got !== undefined, 'DEFAULTS key ' + path + ' did not survive normalise({})')
    assert(same(got, atPath(params.DEFAULTS, path)),
      'DEFAULTS key ' + path + ' came back changed: ' + JSON.stringify(got))
  }

  // The three stages each get their own slice, and nothing else.
  for (const group of ['shape', 'caves', 'ore']) {
    assert(params.DEFAULTS[group] && typeof params.DEFAULTS[group] === 'object',
      'DEFAULTS has no ' + group + ' group for its module to be handed')
    assert(Object.keys(params.DEFAULTS[group]).length > 0, 'DEFAULTS.' + group + ' is empty')
  }

  // The keys the three downstream modules were promised.
  const promised = {
    shape: ['surfaceRoughness', 'surfaceAmplitude', 'topsoilDepth', 'hardLayerDepth', 'floorThickness'],
    caves: ['caveDensity', 'smoothingPasses', 'minCaveSize'],
    ore: ['veinCount', 'veinSize', 'materials'],
  }
  for (const group of Object.keys(promised)) {
    for (const key of promised[group]) {
      assert(Object.prototype.hasOwnProperty.call(params.DEFAULTS[group], key),
        'DEFAULTS.' + group + ' is missing the promised key ' + key)
    }
  }
  for (const material of params.DEFAULTS.ore.materials) {
    for (const key of ['colour', 'fromDepth', 'toDepth']) {
      assert(Object.prototype.hasOwnProperty.call(material, key),
        'an ore material has no ' + key + ', so it has no depth band')
    }
  }

  // DEFAULTS is shared, so it must be untouchable and never handed out directly.
  assert(Object.isFrozen(params.DEFAULTS), 'DEFAULTS is not frozen')
  assert(Object.isFrozen(params.DEFAULTS.shape), 'DEFAULTS.shape is not frozen')
  assert(empty.params !== params.DEFAULTS, 'normalise handed back DEFAULTS itself')
  empty.params.shape.topsoilDepth = 999
  empty.params.ore.materials[0].share = 999
  assert(params.DEFAULTS.shape.topsoilDepth !== 999, 'editing the result reached back into DEFAULTS')
  assert(params.DEFAULTS.ore.materials[0].share !== 999, 'editing a material reached back into DEFAULTS')
}

function testNormaliseIsIdempotent() {
  const once = tryNormalise({}, '{}')
  const twice = tryNormalise(once.params, 'its own output')
  assert(twice.ok, 'normalise refused its own output: ' + twice.reason)
  assert(same(once.params, twice.params), 'normalising twice changed the parameters')
}

// --- hostile input --------------------------------------------------------

function testNormaliseNeverThrows() {
  const hostileGetter = { get shape() { throw new Error('hostile getter') } }
  const hostileNested = { shape: { get topsoilDepth() { throw new Error('nested getter') } } }
  const hostileKeys = new Proxy({}, { ownKeys() { throw new Error('no keys for you') } })
  const hostileToString = { shape: { topsoilDepth: { toString() { throw new Error('no string') } } } }
  const hostileMaterial = { ore: { materials: [{ get colour() { throw new Error('bad colour') } }] } }

  const cases = [
    [null, 'null'],
    [undefined, 'undefined'],
    ['a string', 'a string'],
    ['', 'the empty string'],
    [42, 'a number'],
    [NaN, 'NaN'],
    [true, 'a boolean'],
    [[], 'an empty array'],
    [[1, 2, 3], 'an array of numbers'],
    [[{ shape: {} }], 'an array of objects'],
    [function () {}, 'a function'],
    [Symbol('x'), 'a symbol'],
    [hostileGetter, 'an object whose getter throws'],
    [hostileNested, 'an object whose nested getter throws'],
    [hostileKeys, 'a proxy whose key list throws'],
    [hostileToString, 'a value whose toString throws'],
    [hostileMaterial, 'a material whose colour getter throws'],
    [Object.create(null), 'an object with no prototype'],
    [new Date(), 'a Date'],
    [new Map(), 'a Map'],
  ]
  for (const [input, label] of cases) tryNormalise(input, label)

  // null and undefined mean "nothing supplied", not "wrong".
  for (const nothing of [null, undefined]) {
    const r = tryNormalise(nothing, String(nothing))
    assert(r.ok, 'normalise(' + nothing + ') was refused: ' + r.reason)
    assert(same(r.params, params.DEFAULTS), 'normalise(' + nothing + ') did not give the defaults')
  }

  // A wrong-shaped input is refused, and the refusal says what it wanted.
  for (const wrong of ['a string', 42, true, [], [1, 2]]) {
    const r = tryNormalise(wrong, JSON.stringify(wrong))
    assert(!r.ok, 'normalise accepted ' + JSON.stringify(wrong) + ' as a parameter object')
    assert(/input/.test(r.reason), 'the refusal of ' + JSON.stringify(wrong) + ' did not name the input: ' + r.reason)
  }

  // A getter that throws is refused by name rather than swallowed.
  const thrown = tryNormalise(hostileGetter, 'hostile getter')
  assert(!thrown.ok, 'a getter that throws was accepted')
  assert(/shape/.test(thrown.reason), 'the refusal did not name shape: ' + thrown.reason)
}

// --- clamping -------------------------------------------------------------

function testClamping() {
  const cases = [
    [{ shape: { surfaceRoughness: 5 } }, 'shape', 'surfaceRoughness', 1],
    [{ shape: { surfaceRoughness: -3 } }, 'shape', 'surfaceRoughness', 0],
    [{ shape: { surfaceAmplitude: -50 } }, 'shape', 'surfaceAmplitude', 0],
    [{ shape: { floorThickness: 1e9 } }, 'shape', 'floorThickness', 512],
    [{ shape: { topsoilDepth: 7.6 } }, 'shape', 'topsoilDepth', 8],
    [{ caves: { caveDensity: 2 } }, 'caves', 'caveDensity', 0.45],
    [{ caves: { smoothingPasses: 999 } }, 'caves', 'smoothingPasses', 12],
    [{ caves: { smoothingPasses: -4 } }, 'caves', 'smoothingPasses', 0],
    [{ caves: { tunnelWidth: 0 } }, 'caves', 'tunnelWidth', 1],
    [{ ore: { veinCount: -5 } }, 'ore', 'veinCount', 0],
    [{ ore: { veinSizeVariation: 4 } }, 'ore', 'veinSizeVariation', 1],
  ]
  for (const [input, group, key, expected] of cases) {
    const r = tryNormalise(input, JSON.stringify(input))
    assert(r.ok, 'a clampable value was refused instead: ' + r.reason)
    assert(r.params[group][key] === expected,
      group + '.' + key + ' clamped to ' + r.params[group][key] + ', expected ' + expected)
  }

  // A form hands over strings; a number written as one is not an error.
  const fromForm = tryNormalise({ shape: { surfaceRoughness: '0.5', topsoilDepth: ' 12 ' } }, 'string numbers')
  assert(fromForm.ok, 'numeric strings were refused: ' + fromForm.reason)
  assert(fromForm.params.shape.surfaceRoughness === 0.5, 'the string "0.5" did not read as 0.5')
  assert(fromForm.params.shape.topsoilDepth === 12, 'the string " 12 " did not read as 12')

  // Colours are accepted in whatever case and with or without the hash.
  const colours = tryNormalise({ shape: { floorMaterial: '  AABBCC ' } }, 'a shouted colour')
  assert(colours.ok, 'a valid colour in the wrong case was refused: ' + colours.reason)
  assert(colours.params.shape.floorMaterial === '#aabbcc',
    'the colour did not come back as #rrggbb: ' + colours.params.shape.floorMaterial)

  // A clamped value must not disturb its neighbours.
  const one = tryNormalise({ caves: { smoothingPasses: 999 } }, 'one silly cave value')
  assert(one.params.caves.caveDensity === params.DEFAULTS.caves.caveDensity,
    'clamping one cave parameter changed another')
  assert(same(one.params.shape, params.DEFAULTS.shape), 'a cave parameter changed the shape group')
}

// --- refusals -------------------------------------------------------------

function testRefusals() {
  const cases = [
    // [input, what the reason must mention, label]
    [{ nonsense: {} }, /nonsense/, 'an unknown parameter group'],
    [{ shape: { floorThicknes: 3 } }, /shape\.floorThicknes/, 'a misspelled parameter'],
    [{ caves: { density: 0.5 } }, /caves\.density/, 'a plausible but wrong cave key'],
    [{ shape: 'flat' }, /shape/, 'a group that is a string'],
    [{ shape: [] }, /shape/, 'a group that is an array'],
    [{ ore: 5 }, /ore/, 'a group that is a number'],
    [{ shape: { topsoilDepth: 'deep' } }, /shape\.topsoilDepth/, 'a word where a number belongs'],
    [{ shape: { topsoilDepth: NaN } }, /shape\.topsoilDepth/, 'NaN'],
    [{ shape: { surfaceAmplitude: Infinity } }, /shape\.surfaceAmplitude/, 'Infinity'],
    [{ shape: { topsoilDepth: null } }, /shape\.topsoilDepth/, 'null where a number belongs'],
    [{ shape: { topsoilDepth: {} } }, /shape\.topsoilDepth/, 'an object where a number belongs'],
    [{ shape: { floorMaterial: 'red' } }, /shape\.floorMaterial/, 'a colour name'],
    [{ shape: { floorMaterial: '#12345' } }, /shape\.floorMaterial/, 'a short hex colour'],
    [{ shape: { floorMaterial: 16711680 } }, /shape\.floorMaterial/, 'a colour as a number'],
    [{ caves: { connectCaves: 'yes' } }, /caves\.connectCaves/, 'a not-quite boolean'],
    [{ caves: { connectCaves: 1 } }, /caves\.connectCaves/, '1 as a boolean'],
    [{ seed: '' }, /seed/, 'an empty seed'],
    [{ seed: '   ' }, /seed/, 'a whitespace seed'],
    [{ seed: {} }, /seed/, 'a seed that is an object'],
    [{ seed: 'x'.repeat(500) }, /seed/, 'a seed far too long to read'],
    [{ ore: { materials: 'copper' } }, /ore\.materials/, 'a materials list that is a string'],
    [{ ore: { materials: [{ fromDepth: 0, toDepth: 1 }] } }, /colour/, 'a material with no colour'],
    [{ ore: { materials: [{ colour: '#ffa500', fromDepth: 0.8, toDepth: 0.2 }] } }, /ore\.materials\[0\]/,
      'a depth band that runs upward'],
    [{ ore: { materials: [{ colour: '#ffa500', fromDepth: 0.4, toDepth: 0.4 }] } }, /ore\.materials\[0\]/,
      'a depth band with no thickness'],
    [{ ore: { materials: [{ colour: '#ffa500', share: 0 }] } }, /ore\.materials/, 'every share set to 0'],
    [{ ore: { materials: [{ colour: '#ffa500', tint: 3 }] } }, /tint/, 'an unknown material property'],
    [{ ore: { materials: [] } }, /ore\.materials/, 'no materials but a vein count'],
    [{ ore: { materials: [7] } }, /ore\.materials\[0\]/, 'a material that is a number'],
    [{ shape: { topsoilDepth: 200 } }, /hardLayerDepth/, 'topsoil deeper than the hard layer'],
    [{ shape: { topsoilDepth: 60, hardLayerDepth: 60 } }, /hardLayerDepth/, 'topsoil exactly at the hard layer'],
  ]
  for (const [input, mentions, label] of cases) {
    const r = tryNormalise(input, label)
    assert(!r.ok, 'normalise accepted ' + label)
    assert(mentions.test(r.reason),
      'the refusal of ' + label + ' did not name what was wrong: ' + r.reason)
  }

  // A refusal about a bound should say what the bound was, so the caller can fix it.
  const tooLong = tryNormalise({ seed: 'x'.repeat(500) }, 'an over-long seed')
  assert(/\d/.test(tooLong.reason), 'the over-long seed refusal named no limit: ' + tooLong.reason)
  const stacked = tryNormalise({ shape: { topsoilDepth: 200 } }, 'topsoil below the hard layer')
  assert(/200/.test(stacked.reason) && /140/.test(stacked.reason),
    'the layering refusal quoted neither depth: ' + stacked.reason)

  // Empty materials WITH veinCount 0 is a legitimate map with no ore.
  const noOre = tryNormalise({ ore: { materials: [], veinCount: 0 } }, 'a map with no ore')
  assert(noOre.ok, 'a deliberate no-ore map was refused: ' + noOre.reason)
  assert(noOre.params.ore.materials.length === 0, 'the no-ore map grew materials back')

  // A material may omit veinSize and inherit the stage's own.
  const inherited = tryNormalise(
    { ore: { veinSize: 33, materials: [{ name: 'Copper ore', colour: '#ffa500', fromDepth: 0.1, toDepth: 0.9 }] } },
    'a material with no vein size')
  assert(inherited.ok, 'a material without its own vein size was refused: ' + inherited.reason)
  assert(inherited.params.ore.materials[0].veinSize === 33,
    'the material did not inherit ore.veinSize: ' + inherited.params.ore.materials[0].veinSize)
}

// --- presets --------------------------------------------------------------

function testPresets() {
  const names = Object.keys(params.PRESETS)
  assert(names.length >= 3 && names.length <= 6,
    'PRESETS holds ' + names.length + ' entries - few and distinct was the point')

  const seen = []
  for (const key of names) {
    const preset = params.PRESETS[key]
    assert(typeof preset.name === 'string' && preset.name.length > 0, key + ' has no name')
    assert(typeof preset.description === 'string' && preset.description.length > 20,
      key + ' has no description a mapmaker could act on')
    assert(preset.params && typeof preset.params === 'object', key + ' has no params')

    const r = tryNormalise(preset.params, 'preset ' + key)
    assert(r.ok, 'preset ' + key + ' was refused by normalise: ' + r.reason)
    assert(same(r.params, preset.params),
      'preset ' + key + ' came back from normalise changed - it is out of range somewhere')

    // Sizes are the editor's, not ours: a suggestion may exist, but nothing here
    // validates it and it must never sit inside params.
    if (preset.suggestedSize) {
      assert(preset.suggestedSize.width > 0 && preset.suggestedSize.height > 0,
        'preset ' + key + ' suggests a size that is not a size')
    }
    assert(preset.params.shape.width === undefined && preset.params.shape.height === undefined,
      'preset ' + key + ' put a map size inside params, where this module has no business owning it')

    seen.push(JSON.stringify(preset.params))
  }

  assert(new Set(seen).size === seen.length, 'two presets carry identical parameters')

  // "Genuinely different" is checkable: the presets must disagree about the
  // things a player notices first.
  const values = (path) => names.map((k) => atPath(params.PRESETS[k].params, path))
  for (const path of ['caves.caveDensity', 'shape.surfaceAmplitude', 'shape.surfaceLevel', 'ore.veinCount']) {
    const set = new Set(values(path))
    assert(set.size === names.length,
      'every preset would have to differ in ' + path + ', but ' + (names.length - set.size) + ' agree')
  }
  // A ratio, not a difference. This once demanded max - min > 0.3, which was
  // calibrated to caveDensity when it meant a noise fill on a 0..0.9 scale. The
  // knob now means the fraction of ground actually hollowed, on a 0..0.45
  // scale, and an absolute threshold measures the scale rather than the
  // spread - the same mistake a ratio assertion made elsewhere in this repo.
  const densities = values('caves.caveDensity')
  assert(Math.max.apply(null, densities) / Math.min.apply(null, densities) > 4,
    'the presets all carve about the same share of caves, so they are variations of one world')

  assert(Object.isFrozen(params.PRESETS), 'PRESETS is not frozen')
}

// --- the exported surface -------------------------------------------------

function testExports() {
  const expected = ['DEFAULTS', 'PRESETS', 'normalise', 'randomSeed', 'rng'].sort()
  const actual = Object.keys(params).sort()
  assert(same(actual, expected),
    'the module exports ' + actual.join(', ') + ', not ' + expected.join(', '))
  assert(typeof params.rng === 'function', 'rng is not a function')
  assert(typeof params.normalise === 'function', 'normalise is not a function')
  assert(typeof params.randomSeed === 'function', 'randomSeed is not a function')
  assert(typeof params.rng('x') === 'function', 'rng did not return a function')
}

try {
  testExports()
  testSeedDeterminism()
  testSeedUniformity()
  testRandomSeed()
  testDefaultsSurviveNormalise()
  testNormaliseIsIdempotent()
  testNormaliseNeverThrows()
  testClamping()
  testRefusals()
  testPresets()
  console.log('PASS map generator parameter and seeding regression tests')
} catch (e) {
  console.error('FAIL map generator parameter and seeding regression tests:', e.message)
  process.exit(1)
}
