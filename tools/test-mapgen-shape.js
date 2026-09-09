#!/usr/bin/env node
'use strict'
/**
 * Regression tests for the map generator's terrain-shape module.
 *
 * Everything asserted here is a thing a player would otherwise discover by
 * loading a generated world and finding it wrong: a comb of one-column cliffs,
 * a world that dissolves the first time anyone digs, a player entombed at
 * spawn, or a seed that does not reproduce. None of it needs a DOM, a canvas or
 * the game, so all of it runs in plain Node.
 */

const shape = require('../src/game/mapgen-shape')
const palette = require('../src/game/terrain-palette')
const validate = require('../src/renderer/mapeditor-validate')

function assert(value, message) {
  if (!value) throw new Error(message)
}

/**
 * A seeded generator for the tests themselves - mulberry32.
 *
 * Written out here rather than imported, because the module under test takes
 * `rng` from its caller and the point of these tests is that the same stream
 * gives the same world. `Math.random` appears nowhere in this file either.
 */
function makeRng(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A zeroed RGBA buffer of the shape ImageData has. */
function makeBuffer(width, height) {
  return { data: new Uint8ClampedArray(width * height * 4), width, height }
}

// The three ground materials, looked up the same way the module looks them up,
// so a palette correction moves the test and the code together.
const DIRT = palette.TERRAIN.find((e) => e.kind === 'solid' && e.cellType === 2)
const STONE = palette.TERRAIN.find((e) => e.kind === 'solid' && e.cellType === 23)
const BEDROCK = palette.TERRAIN.find((e) => e.kind === 'solid' && /^bedrock\b/i.test(e.label))
const AIR = palette.DEFAULT_EMPTY
const SKY = palette.TERRAIN.find((e) => e.kind === 'empty' && e.cellType === 0 && /horizon/i.test(e.label))

assert(DIRT && STONE && BEDROCK && AIR && SKY, 'the palette no longer holds the materials this test names')

/** Hardness, deepest-last. The order the ground is documented to be layered in. */
const RANK = {}
RANK[DIRT.hex] = 0
RANK[STONE.hex] = 1
RANK[BEDROCK.hex] = 2

/** The palette entry at a cell, or null for a colour the game does not answer to. */
function at(buf, x, y) {
  const i = (y * buf.width + x) * 4
  const d = buf.data
  return { entry: palette.byRgb(d[i], d[i + 1], d[i + 2]), a: d[i + 3] }
}

/** Defaults this test relies on, mirrored from the module's own documented set. */
const DEF = {
  topsoilDepth: 24,
  floorDepth: 4,
  pocketWidth: 11,
  pocketHeight: 16,
  pocketRise: 6,
  maxStep: 3,
}

const W = 512
const H = 600

/** One generated world, with the profile that produced it. */
function generate(seed, params) {
  const p = params || {}
  const width = p.width || W
  const height = p.height || H
  const profile = shape.surfaceProfile(width, p, makeRng(seed))
  const buf = makeBuffer(width, height)
  const counts = shape.applyGround(buf, profile, p)
  return { profile, buf, counts, width, height }
}

// --------------------------------------------------------------------------

/**
 * The same seed twice is the same world byte for byte; a different seed is not.
 *
 * A generator whose seed does not reproduce is not a generator - the seed is the
 * only handle anyone has on a world they liked.
 */
function testSeedReproduces() {
  const a = generate(12345)
  const b = generate(12345)
  const c = generate(12346)

  assert(a.profile.length === W, 'surfaceProfile did not return one row per column')
  for (let x = 0; x < W; x++) {
    assert(a.profile[x] === b.profile[x], 'the same seed gave a different profile at column ' + x)
  }
  for (let i = 0; i < a.buf.data.length; i++) {
    assert(a.buf.data[i] === b.buf.data[i], 'the same seed gave a different pixel at byte ' + i)
  }
  assert(a.counts.solid === b.counts.solid && a.counts.air === b.counts.air,
    'the same seed gave different cell counts')

  let differs = false
  for (let x = 0; x < W && !differs; x++) if (a.profile[x] !== c.profile[x]) differs = true
  assert(differs, 'two different seeds produced the identical profile')

  let pixelDiffers = false
  for (let i = 0; i < a.buf.data.length && !pixelDiffers; i++) {
    if (a.buf.data[i] !== c.buf.data[i]) pixelDiffers = true
  }
  assert(pixelDiffers, 'two different seeds produced the identical world')
}

/**
 * Nothing in the module reaches for `Math.random`.
 *
 * Asserted by making the call itself fail, because a stray `Math.random` is
 * invisible in the output: the world still looks fine, it just never comes back.
 */
function testNeverCallsMathRandom() {
  const real = Math.random
  Math.random = function () { throw new Error('mapgen-shape called Math.random') }
  try {
    generate(777)
  } finally {
    Math.random = real
  }
}

/**
 * No column differs from its neighbour by more than the bound.
 *
 * The failure this catches is a world of one-column cliffs - a comb - which is
 * unwalkable everywhere and which no single screenshot would show.
 */
function testProfileIsContinuous() {
  const cases = [
    { seed: 1, width: 512, params: {} },
    { seed: 2, width: 1024, params: {} },
    { seed: 3, width: 200, params: {} },
    { seed: 4, width: 1, params: {} },
    { seed: 5, width: 2, params: {} },
    // Deliberately violent settings: a huge amplitude packed into a short
    // feature width is exactly how a caller outruns the noise, and the slope
    // limiter has to hold anyway.
    { seed: 6, width: 800, params: { amplitude: 400, featureWidth: 6, octaves: 6, roughness: 1 } },
    { seed: 7, width: 800, params: { amplitude: 900, featureWidth: 4, maxStep: 1 } },
    { seed: 8, width: 640, params: { amplitude: 0 } },
  ]
  for (const c of cases) {
    const params = c.params
    const bound = params.maxStep === undefined ? DEF.maxStep : params.maxStep
    const profile = shape.surfaceProfile(c.width, params, makeRng(c.seed))
    assert(profile.length === c.width, 'profile length is wrong for width ' + c.width)
    for (let x = 0; x < c.width; x++) {
      assert(Number.isInteger(profile[x]) && profile[x] >= 1,
        'profile column ' + x + ' is not a usable row (' + profile[x] + ')')
      if (x === 0) continue
      const step = Math.abs(profile[x] - profile[x - 1])
      assert(step <= bound,
        'seed ' + c.seed + ' column ' + x + ' jumps ' + step + ' cells, over the bound of ' + bound)
    }
  }
}

/**
 * Every pixel written is fully opaque, on a buffer that started as zeroes.
 *
 * Alpha 0 does not decode to air, it decodes to Fog - so a cell the fill missed
 * is not an empty cell, it is a sealed pocket. Starting from a zeroed buffer
 * means this also proves the fill covers every cell of the map.
 */
function testEveryPixelIsOpaque() {
  const g = generate(2024)
  const d = g.buf.data
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] !== 255) {
      const cell = (i - 3) / 4
      throw new Error('cell ' + (cell % W) + ',' + Math.floor(cell / W) +
        ' was left at alpha ' + d[i] + ', which decodes to Fog')
    }
  }
}

/**
 * No fog, nothing the palette marks broken, and nothing the palette does not
 * recognise at all.
 *
 * Fog is the material that produced the hollow test map: it looks like black
 * rock, and then the first dig anywhere in a connected mass turns all of it to
 * air. A broken colour is worse - the loader throws and the map never opens.
 *
 * The starting buffer is pre-filled with a broken colour, so any cell the fill
 * fails to write is caught here rather than passing as "not fog".
 */
function testNoFogAndNoBrokenColour() {
  const broken = palette.TERRAIN.find((e) => e.kind === 'broken')
  assert(broken, 'the palette no longer marks any colour broken')

  const buf = makeBuffer(W, H)
  for (let i = 0; i < buf.data.length; i += 4) {
    buf.data[i] = broken.rgb[0]
    buf.data[i + 1] = broken.rgb[1]
    buf.data[i + 2] = broken.rgb[2]
    buf.data[i + 3] = 255
  }
  const profile = shape.surfaceProfile(W, {}, makeRng(31337))
  shape.applyGround(buf, profile, {})

  const fogRef = palette.byRgb(102, 102, 102)
  const seen = new Set()
  const d = buf.data
  for (let i = 0; i < d.length; i += 4) {
    const key = (d[i] * 256 + d[i + 1]) * 256 + d[i + 2]
    if (seen.has(key)) continue
    seen.add(key)
    const entry = palette.byRgb(d[i], d[i + 1], d[i + 2])
    const cell = i / 4
    const where = ' at ' + (cell % W) + ',' + Math.floor(cell / W)
    assert(entry, 'the generator wrote ' + d[i] + ',' + d[i + 1] + ',' + d[i + 2] +
      where + ', which the game does not answer to')
    assert(entry.kind !== 'broken',
      'the generator wrote the broken colour ' + entry.hex + where)
    assert(!/blocks until dug/i.test(entry.label),
      'the generator wrote the sealed pocket ' + entry.hex + where)
    assert(!(fogRef && Number.isInteger(fogRef.cellType) && entry.cellType === fogRef.cellType),
      'the generator wrote fog (' + entry.hex + ')' + where)
    assert(entry.hex !== '#666666', 'the generator wrote 102,102,102' + where)
  }
  assert(seen.size <= 5, 'the generator used more colours than the five it documents')
}

/**
 * The ground is layered dirt, then stone, then bedrock - never out of order.
 *
 * Checked as a monotonic hardness rank down every column, which holds even in
 * the spawn columns where the pocket punches air through the layers; and then
 * exactly, on a column the pocket cannot reach.
 */
function testGroundIsLayered() {
  const g = generate(4242)
  const spawn = validate.spawnCell(W)
  const floorTop = H - DEF.floorDepth

  for (let x = 0; x < W; x++) {
    let last = -1
    for (let y = 0; y < H; y++) {
      const c = at(g.buf, x, y)
      const rank = RANK[c.entry.hex]
      if (rank === undefined) continue                  // air of one kind or another
      assert(rank >= last,
        'column ' + x + ' has ' + c.entry.label + ' at row ' + y + ', above softer ground')
      last = rank
    }
    // The floor is bedrock all the way across, and only there.
    for (let y = floorTop; y < H; y++) {
      assert(at(g.buf, x, y).entry.hex === BEDROCK.hex,
        'row ' + y + ' of column ' + x + ' is not the bedrock floor')
    }
    assert(at(g.buf, x, floorTop - 1).entry.hex !== BEDROCK.hex,
      'bedrock reaches above the floor band in column ' + x)
  }

  // An exact reading, far enough from spawn that the pocket cannot touch it.
  const x = (spawn.x + Math.floor(W / 2)) % W
  assert(Math.abs(x - spawn.x) > DEF.pocketWidth, 'the sample column is inside the spawn pocket')
  const surface = g.profile[x]
  for (let y = 0; y < surface - 1; y++) {
    assert(at(g.buf, x, y).entry.hex === AIR.hex, 'row ' + y + ' above the surface is not plain air')
  }
  assert(at(g.buf, x, surface - 1).entry.hex === SKY.hex,
    'the cell just above the surface does not record the horizon')
  for (let y = surface; y < surface + DEF.topsoilDepth; y++) {
    assert(at(g.buf, x, y).entry.hex === DIRT.hex,
      'row ' + y + ' should be topsoil the starting shovel can dig')
  }
  for (let y = surface + DEF.topsoilDepth; y < floorTop; y++) {
    assert(at(g.buf, x, y).entry.hex === STONE.hex, 'row ' + y + ' should be stone')
  }
}

/**
 * Exactly one open-sky cell per column, immediately above that column's surface.
 *
 * 255,255,255 is air that also records the column's horizon depth, which drives
 * the cave-versus-surface ambient audio. One cell makes the recorded value
 * unambiguous; scattering it through the sky, or into a cave, does not.
 */
function testHorizonMarker() {
  const g = generate(909)
  for (let x = 0; x < W; x++) {
    let count = 0
    let where = -1
    for (let y = 0; y < H; y++) {
      if (at(g.buf, x, y).entry.hex === SKY.hex) { count++; where = y }
    }
    assert(count === 1, 'column ' + x + ' has ' + count + ' horizon cells, not 1')
    assert(where === g.profile[x] - 1,
      'column ' + x + ' records its horizon at row ' + where + ', not at its surface')
  }
}

/**
 * The spawn pocket is genuinely clear.
 *
 * Spawn is fixed and unconditional - the game does not look for open ground - so
 * a generated world with no pocket starts the player inside rock every time.
 */
function testSpawnPocketIsClear() {
  for (const seed of [1, 2, 3, 101, 555, 90210]) {
    const g = generate(seed)
    const spawn = validate.spawnCell(W)
    assert(spawn.x >= 0 && spawn.x < W && spawn.y >= 0 && spawn.y < H,
      'the test map is too small to hold the spawn cell')

    const x0 = Math.max(0, spawn.x - Math.floor((DEF.pocketWidth - 1) / 2))
    const x1 = Math.min(W - 1, x0 + DEF.pocketWidth - 1)
    const y0 = Math.max(0, spawn.y - DEF.pocketRise)
    const y1 = Math.min(H - DEF.floorDepth - 1, y0 + DEF.pocketHeight - 1)

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const c = at(g.buf, x, y)
        assert(c.a === 255, 'the spawn pocket has a see-through cell at ' + x + ',' + y)
        assert(c.entry && c.entry.kind === 'empty',
          'seed ' + seed + ': the spawn pocket holds ' + c.entry.label + ' at ' + x + ',' + y)
      }
    }
    // And there is ground to land on a short drop below the pocket, rather than
    // a shaft to the bottom of the map. The bedrock floor makes "some solid cell
    // exists below" true of any map, so the number that matters is how far.
    const maxDrop = 64
    let landing = -1
    for (let y = y1 + 1; y < H && landing < 0; y++) {
      const c = at(g.buf, spawn.x, y)
      if (c.entry && c.entry.kind === 'solid') landing = y
    }
    assert(landing >= 0, 'seed ' + seed + ': nothing solid anywhere below the spawn pocket')
    assert(landing - y1 <= maxDrop, 'seed ' + seed + ': the player falls ' + (landing - y1) +
      ' cells out of the spawn pocket before hitting ground')
  }
}

/** The counts come back honest: they sum to the map, and they match the pixels. */
function testCounts() {
  const g = generate(60606)
  assert(g.counts.solid + g.counts.air === W * H,
    'solid + air is ' + (g.counts.solid + g.counts.air) + ', not ' + (W * H))

  let solid = 0
  let air = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const entry = at(g.buf, x, y).entry
      if (entry.kind === 'solid') solid++
      else air++
    }
  }
  assert(solid === g.counts.solid, 'reported ' + g.counts.solid + ' solid cells, the map has ' + solid)
  assert(air === g.counts.air, 'reported ' + g.counts.air + ' air cells, the map has ' + air)
}

/**
 * Sizes and settings that would otherwise divide by zero or run off an edge.
 *
 * A map too small to hold the spawn cell is a real case - the validator has its
 * own error for it - and the generator has to produce a whole, opaque, fog-free
 * buffer for it anyway rather than throwing halfway through.
 */
function testAwkwardSizes() {
  const cases = [
    { w: 1, h: 1 },
    { w: 4, h: 4 },
    { w: 32, h: 210 },
    { w: 160, h: 8 },
    { w: 200, h: 250, params: { topsoilDepth: 0, floorDepth: 0 } },
    { w: 300, h: 260, params: { topsoilDepth: 100000, floorDepth: 100000 } },
    { w: 300, h: 260, params: { surfaceY: -50 } },
    { w: 300, h: 260, params: { surfaceY: 100000 } },
  ]
  for (const c of cases) {
    const params = c.params || {}
    const profile = shape.surfaceProfile(c.w, params, makeRng(c.w * 31 + c.h))
    const buf = makeBuffer(c.w, c.h)
    const counts = shape.applyGround(buf, profile, params)
    assert(counts.solid + counts.air === c.w * c.h,
      c.w + 'x' + c.h + ': counts do not sum to the map')
    assert(counts.solid >= 0 && counts.air >= 0, c.w + 'x' + c.h + ': a negative cell count')
    for (let i = 0; i < buf.data.length; i += 4) {
      assert(buf.data[i + 3] === 255, c.w + 'x' + c.h + ': a see-through cell survived')
      const entry = palette.byRgb(buf.data[i], buf.data[i + 1], buf.data[i + 2])
      assert(entry && entry.kind !== 'broken' && !/blocks until dug/i.test(entry.label),
        c.w + 'x' + c.h + ': an unsafe colour was written')
    }
  }
}

/** Nonsense arguments are refused rather than silently producing a wrong map. */
function testRejectsNonsense() {
  const bad = [
    () => shape.surfaceProfile(0, {}, makeRng(1)),
    () => shape.surfaceProfile(-4, {}, makeRng(1)),
    () => shape.surfaceProfile(NaN, {}, makeRng(1)),
    () => shape.surfaceProfile(64, {}, null),
    () => shape.applyGround(null, new Int32Array(4), {}),
    () => shape.applyGround(makeBuffer(8, 8), new Int32Array(4), {}),
    () => shape.applyGround({ data: new Uint8ClampedArray(4), width: 8, height: 8 }, new Int32Array(8), {}),
  ]
  for (let i = 0; i < bad.length; i++) {
    let threw = false
    try { bad[i]() } catch (e) { threw = true }
    assert(threw, 'case ' + i + ' should have been refused and was not')
  }
}

const TESTS = [
  ['a seed reproduces its world byte for byte', testSeedReproduces],
  ['Math.random is never called', testNeverCallsMathRandom],
  ['the surface profile is continuous', testProfileIsContinuous],
  ['every pixel is fully opaque', testEveryPixelIsOpaque],
  ['no fog and no broken colour is ever written', testNoFogAndNoBrokenColour],
  ['the ground is layered dirt, stone, bedrock', testGroundIsLayered],
  ['each column records its horizon exactly once', testHorizonMarker],
  ['the spawn pocket is clear', testSpawnPocketIsClear],
  ['the reported cell counts match the map', testCounts],
  ['awkward sizes still produce a whole map', testAwkwardSizes],
  ['nonsense arguments are refused', testRejectsNonsense],
]

let failed = 0
for (const [name, run] of TESTS) {
  try {
    run()
    console.log('  ok   ' + name)
  } catch (e) {
    failed++
    console.error('  FAIL ' + name + ': ' + e.message)
  }
}

if (failed > 0) {
  console.error('FAIL map generator terrain-shape tests: ' + failed + ' of ' + TESTS.length + ' failed')
  process.exit(1)
}
console.log('PASS map generator terrain-shape tests (' + TESTS.length + ' checks)')
