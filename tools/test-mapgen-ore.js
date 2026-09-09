#!/usr/bin/env node
'use strict'
/**
 * Regression tests for the map generator's ore-placement stage.
 *
 * The failures these guard against are all invisible in a screenshot. A vein
 * that fills a cave, a vein that lands in the spawn pocket, a vein of a colour
 * no tool can remove - the PNG looks fine in every one of those cases, and the
 * map is wrong the first time somebody plays it. So the checks below read the
 * buffer back pixel by pixel and assert on what the game will do with it,
 * rather than on what it looks like.
 *
 * Plain Node, no framework, same shape and exit behaviour as
 * `tools/test-official-native.js`.
 */

const palette = require('../src/game/terrain-palette.js')
const validate = require('../src/renderer/mapeditor-validate.js')
const ore = require('../src/game/mapgen-ore.js')

function assert(value, message) {
  if (!value) throw new Error(message)
}

/* ------------------------------------------------------------------ *
 * Fixtures.
 * ------------------------------------------------------------------ */

/**
 * A seeded generator, so "same seed, same map" is a claim the tests can make.
 * mulberry32 - small, well-known, and reproducible across Node versions.
 */
function rngFrom(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const AIR = palette.byRgb(153, 0, 0).rgb        // #990000, air with no side effects
const DIRT = palette.byRgb(0, 0, 0).rgb         // #000000, the ground fill
const FOG = palette.byRgb(102, 102, 102).rgb    // #666666, the trap colour
const BEDROCK = palette.byRgb(34, 34, 34).rgb   // #222222, indestructible floor

function put(buf, x, y, rgb, alpha) {
  const i = (y * buf.width + x) * 4
  buf.data[i] = rgb[0]
  buf.data[i + 1] = rgb[1]
  buf.data[i + 2] = rgb[2]
  buf.data[i + 3] = alpha == null ? 255 : alpha
}

function at(buf, x, y) {
  const i = (y * buf.width + x) * 4
  return [buf.data[i], buf.data[i + 1], buf.data[i + 2], buf.data[i + 3]]
}

function hexAt(buf, x, y) {
  const c = at(buf, x, y)
  return '#' + c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')
}

/** Ground under a wavy surface, exactly what the landscape stage would hand over. */
function makeWorld(width, height, opts) {
  const o = opts || {}
  const buf = { data: new Uint8ClampedArray(width * height * 4), width, height }
  const profile = new Int32Array(width)
  for (let x = 0; x < width; x++) {
    profile[x] = o.flat != null ? o.flat
      : Math.round(height * 0.25 + Math.sin(x / 9) * 4)
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) put(buf, x, y, y < profile[x] ? AIR : DIRT)
  }
  return { buf, profile }
}

/** Carve an air rectangle, the way the cave stage would. */
function carve(buf, x0, y0, x1, y1) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(buf, x, y, AIR)
}

/** Every hex this module is willing to write. */
function allowedHexes() {
  return new Set(ore.placeable().allowed.map((e) => e.hex))
}

/** Cell indices holding one of the ore colours. */
function oreCells(buf) {
  const wanted = allowedHexes()
  const out = []
  for (let y = 0; y < buf.height; y++) {
    for (let x = 0; x < buf.width; x++) {
      if (wanted.has(hexAt(buf, x, y))) out.push(y * buf.width + x)
    }
  }
  return out
}

/** Four-connected component containing `start`, restricted to `members`. */
function component(members, start, width) {
  const set = new Set(members)
  const seen = new Set([start])
  const stack = [start]
  while (stack.length) {
    const cell = stack.pop()
    const x = cell % width
    const neighbours = [
      x > 0 ? cell - 1 : -1,
      x + 1 < width ? cell + 1 : -1,
      cell - width,
      cell + width,
    ]
    for (const n of neighbours) {
      if (n < 0 || seen.has(n) || !set.has(n)) continue
      seen.add(n)
      stack.push(n)
    }
  }
  return seen
}

/* ------------------------------------------------------------------ *
 * placeable() - the list that is the module's actual value.
 * ------------------------------------------------------------------ */

function testPlaceableIsHonest() {
  const r = ore.placeable()
  assert(Array.isArray(r.allowed) && Array.isArray(r.excluded),
    'placeable() must return {allowed, excluded}')
  assert(r.allowed.length > 0, 'placeable() offers nothing at all')

  // Every distinct material in the palette is ruled on exactly once. No third
  // bucket of colours quietly skipped without a word.
  const labels = new Set()
  for (const e of palette.TERRAIN) labels.add(e.label)
  const ruled = new Map()
  for (const e of r.allowed) {
    assert(!ruled.has(e.label), 'material ruled on twice: ' + e.label)
    ruled.set(e.label, 'allowed')
  }
  for (const e of r.excluded) {
    assert(!ruled.has(e.label), 'material ruled on twice: ' + e.label)
    ruled.set(e.label, 'excluded')
  }
  for (const label of labels) {
    assert(ruled.has(label), 'placeable() says nothing about "' + label + '"')
  }
  assert(ruled.size === labels.size, 'placeable() invented a material')

  // Every exclusion carries a reason a mapmaker could act on.
  for (const e of r.excluded) {
    assert(typeof e.reason === 'string' && e.reason.length > 20,
      'exclusion of ' + e.hex + ' has no usable reason')
  }

  // Every offer is a solid palette colour with its defaults attached.
  for (const e of r.allowed) {
    const row = palette.byHex(e.hex)
    assert(row, 'offered ' + e.hex + ', which is not a palette colour')
    assert(row.kind === 'solid', 'offered ' + e.hex + ', which is not solid ground')
    assert(e.ore && e.ore.depth && e.ore.size && e.ore.density > 0,
      'offered ' + e.hex + ' without placement defaults')
    assert(e.ore.depth.from >= 0 && e.ore.depth.to <= 1 && e.ore.depth.from < e.ore.depth.to,
      e.hex + ' has a nonsense depth band')
    assert(e.ore.size.min >= 1 && e.ore.size.max >= e.ore.size.min,
      e.hex + ' has a nonsense vein size')
  }

  // The specific traps this module exists to avoid. Each of these looks like
  // ore in a picker and is worthless, dangerous or fatal on a real map.
  const excluded = new Map(r.excluded.map((e) => [e.hex, e.reason]))
  const mustExclude = {
    '#666666': 'fog',           // the hollow-map trap
    '#f0dc78': 'broken',        // the loader throws on it
    '#222222': 'un-minable',    // bedrock
    '#181c20': 'un-minable',    // deepstone
    '#ff1414': 'un-minable',    // blackrock
    '#f5e7a3': 'un-minable',    // sandstone
    '#ffde00': 'un-minable',    // limestone
    '#66ccff': 'un-minable',    // ice
    '#19e680': 'un-minable',    // glass
    '#4a40b0': 'un-minable',    // auralite
    '#3d1a5c': 'spreads',       // void flower soil
    '#4a3728': 'chain',         // dissolving rock
    '#8b7355': 'self-erasing',  // puff mushroom
    '#de9d10': 'drops nothing', // solidite: the looks-rich-gives-nothing trap
    '#cd8b8b': 'dynamite',      // crackstone
    '#b6bcc1': 'gun',           // shatterstone
    '#aaaaaa': 'drill',         // stone: bulk rock behind a tool gate
  }
  for (const hex of Object.keys(mustExclude)) {
    assert(excluded.has(hex), hex + ' is not excluded, and it should be')
    assert(excluded.get(hex).indexOf(mustExclude[hex]) >= 0,
      'the reason given for excluding ' + hex + ' does not mention "' +
      mustExclude[hex] + '": ' + excluded.get(hex))
  }

  // And the ones that are the whole point of the module.
  const offered = new Set(r.allowed.map((e) => e.hex))
  for (const hex of ['#af00e0', '#ff5500', '#0094b3']) {
    assert(offered.has(hex), hex + ' is a real ore and is not offered')
  }
}

/* ------------------------------------------------------------------ *
 * Reproducibility.
 * ------------------------------------------------------------------ */

function testSameSeedSameMap() {
  const a = makeWorld(340, 260)
  const b = makeWorld(340, 260)
  const ra = ore.scatter(a.buf, a.profile, {}, rngFrom(0xc0ffee))
  const rb = ore.scatter(b.buf, b.profile, {}, rngFrom(0xc0ffee))

  assert(a.buf.data.length === b.buf.data.length, 'the two runs produced different buffers')
  for (let i = 0; i < a.buf.data.length; i++) {
    assert(a.buf.data[i] === b.buf.data[i],
      'the same seed produced different pixels at byte ' + i)
  }
  assert(JSON.stringify(ra) === JSON.stringify(rb),
    'the same seed produced a different report')
  assert(ra.veins.length > 0, 'the run placed no veins at all, so it proves nothing')

  const c = makeWorld(340, 260)
  ore.scatter(c.buf, c.profile, {}, rngFrom(0xc0ffee + 1))
  let different = false
  for (let i = 0; i < a.buf.data.length; i++) {
    if (a.buf.data[i] !== c.buf.data[i]) { different = true; break }
  }
  assert(different, 'a different seed produced a byte-identical map')
}

function testNeverCallsMathRandom() {
  const w = makeWorld(340, 260)
  const real = Math.random
  Math.random = function () { throw new Error('mapgen-ore called Math.random') }
  try {
    ore.scatter(w.buf, w.profile, {}, rngFrom(7))
  } finally {
    Math.random = real
  }
}

/* ------------------------------------------------------------------ *
 * What must never be touched.
 * ------------------------------------------------------------------ */

function testLeavesAirCavesAndFixturesAlone() {
  const width = 340, height = 260
  const w = makeWorld(width, height)

  // Caves, a fog pocket, a bedrock floor, and a translucent pixel that the
  // loader would turn into fog. All of them must come back untouched.
  carve(w.buf, 40, 90, 120, 130)
  carve(w.buf, 200, 150, 260, 205)
  carve(w.buf, 10, 220, 330, 226)
  for (let x = 0; x < width; x++) put(w.buf, x, height - 1, BEDROCK)
  for (let x = 150; x < 170; x++) for (let y = 140; y < 150; y++) put(w.buf, x, y, FOG)
  // A slab of dirt that is not quite opaque. It reads as ordinary ground in a
  // preview and the loader turns every cell of it into fog, so it is exactly
  // the kind of damage a generator must not spread by writing over it. Big
  // enough that a vein will certainly cross it.
  for (let x = 80; x < 260; x++) for (let y = 150; y < 162; y++) put(w.buf, x, y, DIRT, 0)

  const before = Uint8ClampedArray.from(w.buf.data)
  const r = ore.scatter(w.buf, w.profile, {}, rngFrom(4242))
  assert(r.veins.length > 0, 'nothing was placed, so this test proves nothing')

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const changed = before[i] !== w.buf.data[i] || before[i + 1] !== w.buf.data[i + 1] ||
        before[i + 2] !== w.buf.data[i + 2] || before[i + 3] !== w.buf.data[i + 3]
      if (!changed) continue

      const was = '#' + [before[i], before[i + 1], before[i + 2]]
        .map((v) => v.toString(16).padStart(2, '0')).join('')
      assert(before[i + 3] === 255,
        'overwrote a translucent pixel at ' + x + ',' + y)
      assert(was !== '#990000' && was !== '#ffffff',
        'overwrote open air at ' + x + ',' + y + ' - a cave was filled in')
      assert(was !== '#666666', 'overwrote a fog pocket at ' + x + ',' + y)
      assert(was !== '#222222', 'overwrote the bedrock floor at ' + x + ',' + y)
      const entry = palette.byHex(was)
      assert(entry && entry.kind === 'solid',
        'overwrote a non-solid cell (' + was + ') at ' + x + ',' + y)
      assert(y >= w.profile[x] + 1,
        'wrote at ' + x + ',' + y + ', on or above this column\'s surface row ' + w.profile[x])
    }
  }
}

function testSpawnPocketIsUntouched() {
  const width = 340, height = 260
  const w = makeWorld(width, height, { flat: 60 })
  const spawn = validate.spawnCell(width)
  assert(spawn.x < width && spawn.y < height, 'the fixture map is too small to have a spawn')

  // Saturate the map, so an unguarded run would certainly hit the pocket.
  const before = Uint8ClampedArray.from(w.buf.data)
  ore.scatter(w.buf, w.profile, {
    veinDensity: 900,
    veinSize: [30, 60],
  }, rngFrom(31337))

  let touched = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (before[i] !== w.buf.data[i] || before[i + 1] !== w.buf.data[i + 1] ||
          before[i + 2] !== w.buf.data[i + 2]) touched++
    }
  }
  assert(touched > 5000, 'the saturating run barely wrote anything: ' + touched + ' cells')

  // The pocket the validator tells authors to clear, plus this module's slack.
  for (let y = spawn.y - 2; y <= spawn.y + 8 + 2; y++) {
    for (let x = spawn.x - 2; x <= spawn.x + 3 + 2; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue
      assert(hexAt(w.buf, x, y) === '#000000',
        'ore landed in the spawn pocket at ' + x + ',' + y + ': ' + hexAt(w.buf, x, y))
    }
  }
}

/**
 * A bedrock floor stays a floor.
 *
 * Indestructible material is solid ground, so "only replace solid ground" is
 * not on its own enough to protect it - and replacing it is worse than useless:
 * it turns a barrier an author placed to be permanent into a hole the player
 * can mine through. Saturate a map whose bottom twenty rows are bedrock and
 * whose left and right edges are blackrock, and check every one of those cells
 * is still what it was.
 */
function testIndestructibleGroundIsNotReplaced() {
  const width = 340, height = 260
  const w = makeWorld(width, height, { flat: 50 })
  const BLACKROCK = palette.byRgb(255, 20, 20).rgb
  for (let y = height - 20; y < height; y++) {
    for (let x = 0; x < width; x++) put(w.buf, x, y, BEDROCK)
  }
  for (let y = 50; y < height - 20; y++) {
    for (let x = 0; x < 6; x++) put(w.buf, x, y, BLACKROCK)
    for (let x = width - 6; x < width; x++) put(w.buf, x, y, BLACKROCK)
  }

  const r = ore.scatter(w.buf, w.profile, {
    veinDensity: 600,
    veinSize: [24, 48],
    materials: { '#0094b3': { depth: [0.5, 1] }, '#ffa500': { depth: [0.5, 1] } },
  }, rngFrom(1717))
  assert(r.veins.length > 100, 'the saturating run placed only ' + r.veins.length + ' veins')

  for (let y = height - 20; y < height; y++) {
    for (let x = 0; x < width; x++) {
      assert(hexAt(w.buf, x, y) === '#222222',
        'the bedrock floor was mined out at ' + x + ',' + y + ': ' + hexAt(w.buf, x, y))
    }
  }
  for (let y = 50; y < height - 20; y++) {
    for (let x = 0; x < 6; x++) {
      assert(hexAt(w.buf, x, y) === '#ff1414',
        'the blackrock border was replaced at ' + x + ',' + y + ': ' + hexAt(w.buf, x, y))
    }
  }
}

/* ------------------------------------------------------------------ *
 * What is written.
 * ------------------------------------------------------------------ */

function testEveryWrittenPixelIsSafe() {
  const width = 340, height = 260
  const w = makeWorld(width, height)
  carve(w.buf, 60, 120, 200, 180)
  const before = Uint8ClampedArray.from(w.buf.data)
  const r = ore.scatter(w.buf, w.profile, {}, rngFrom(99))

  const allowed = allowedHexes()
  let written = 0
  const counted = {}
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (before[i] === w.buf.data[i] && before[i + 1] === w.buf.data[i + 1] &&
          before[i + 2] === w.buf.data[i + 2] && before[i + 3] === w.buf.data[i + 3]) continue
      written++
      const hex = hexAt(w.buf, x, y)
      assert(w.buf.data[i + 3] === 255,
        'wrote a pixel that is not fully opaque at ' + x + ',' + y + ' - it decodes to fog')
      assert(hex !== '#666666', 'wrote Fog at ' + x + ',' + y)
      assert(hex !== '#f0dc78', 'wrote the broken colour at ' + x + ',' + y)
      const entry = palette.byHex(hex)
      assert(entry && entry.kind !== 'broken', 'wrote a broken colour at ' + x + ',' + y)
      assert(allowed.has(hex),
        'wrote ' + hex + ' at ' + x + ',' + y + ', which placeable() does not offer')
      counted[hex] = (counted[hex] || 0) + 1
    }
  }
  assert(written > 0, 'nothing was written at all')

  // The report has to match the buffer, or the dialog will lie to the author.
  for (const hex of Object.keys(counted)) {
    assert(r.placed[hex] === counted[hex],
      'reported ' + r.placed[hex] + ' cells of ' + hex + ' but the map holds ' + counted[hex])
  }
  let fromVeins = 0
  for (const v of r.veins) {
    fromVeins += v.cells
    assert(allowed.has(v.hex), 'a vein record names an unofferable colour: ' + v.hex)
  }
  assert(fromVeins === written,
    'the vein records add up to ' + fromVeins + ' cells but ' + written + ' were written')
}

/* ------------------------------------------------------------------ *
 * Veins, not confetti.
 * ------------------------------------------------------------------ */

/**
 * A case small enough to count by hand.
 *
 * A 12x12 map of open air with a single 3x3 block of dirt in it - nine cells,
 * at 4..6 across and 5..7 down. One vein is asked for, with a target size of 20
 * and no minimum, so it will try to grow well past what is there. The only
 * correct answer is those nine cells and nothing else: not eight, because it
 * has to fill the block; not ten, because there is no tenth solid cell to take.
 */
function testHandCountedVein() {
  const width = 12, height = 12
  const buf = { data: new Uint8ClampedArray(width * height * 4), width, height }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(buf, x, y, AIR)
  for (let y = 5; y <= 7; y++) for (let x = 4; x <= 6; x++) put(buf, x, y, DIRT)
  const profile = new Int32Array(width)   // surface at row 0 everywhere

  // The spawn for a 12-wide map is off the right-hand edge and 200 rows down,
  // so the pocket cannot reach this block and cannot explain the result.
  const spawn = validate.spawnCell(width)
  assert(spawn.x >= width || spawn.y >= height, 'the fixture accidentally has a spawn in it')

  const r = ore.scatter(buf, profile, {
    only: ['#af00e0'],
    minRun: 1,
    attempts: 400,
    materials: { '#af00e0': { count: 1, size: [20, 20], depth: [0, 1] } },
  }, rngFrom(2024))

  assert(r.veins.length === 1, 'expected exactly one vein, got ' + r.veins.length)
  assert(r.veins[0].cells === 9,
    'the vein should have filled all nine dirt cells, it took ' + r.veins[0].cells)
  assert(r.placed['#af00e0'] === 9, 'reported ' + r.placed['#af00e0'] + ' cells, not 9')

  let count = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const isOre = hexAt(buf, x, y) === '#af00e0'
      const inBlock = x >= 4 && x <= 6 && y >= 5 && y <= 7
      assert(isOre === inBlock,
        'cell ' + x + ',' + y + ' is ' + (isOre ? 'ore' : 'not ore') + ' and should be ' +
        (inBlock ? 'ore' : 'not ore'))
      if (isOre) count++
    }
  }
  assert(count === 9, 'counted ' + count + ' ore cells by hand, expected 9')
}

/** In open ground a vein must reach exactly the size it was asked for, in one run. */
function testVeinsAreConnectedRunsOfTheRequestedSize() {
  const width = 200, height = 240
  const w = makeWorld(width, height, { flat: 40 })
  const r = ore.scatter(w.buf, w.profile, {
    only: ['#af00e0'],
    materials: { '#af00e0': { count: 6, size: [14, 14], depth: [0.1, 0.6] } },
  }, rngFrom(555))

  assert(r.veins.length === 6, 'expected 6 veins in open ground, got ' + r.veins.length)
  for (const v of r.veins) {
    assert(v.cells === 14, 'a vein in open ground came out at ' + v.cells + ' cells, not 14')
  }

  // Every ore cell belongs to a component of exactly 14. Veins are far enough
  // apart at this density that a merged component would be a real failure.
  const cells = oreCells(w.buf)
  assert(cells.length === 6 * 14, 'the map holds ' + cells.length + ' ore cells, expected 84')
  const accounted = new Set()
  let components = 0
  for (const cell of cells) {
    if (accounted.has(cell)) continue
    const comp = component(cells, cell, width)
    assert(comp.size === 14,
      'found a connected run of ' + comp.size + ' cells; every vein should be 14')
    for (const c of comp) accounted.add(c)
    components++
  }
  assert(components === 6, 'expected 6 connected runs, found ' + components)
}

/**
 * Confetti is rolled back, not kept.
 *
 * The ground here is isolated single dirt cells with air all round, so no vein
 * can ever grow past one cell. With the default minimum run of three, every
 * attempt must be undone and the map must come back byte-identical.
 */
function testSinglePixelVeinsAreRolledBack() {
  const width = 180, height = 240
  const buf = { data: new Uint8ClampedArray(width * height * 4), width, height }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(buf, x, y, AIR)
  const profile = new Int32Array(width)
  for (let x = 0; x < width; x++) profile[x] = 20
  for (let y = 24; y < height; y += 3) {
    for (let x = 1; x < width; x += 3) put(buf, x, y, DIRT)
  }

  const before = Uint8ClampedArray.from(buf.data)
  const r = ore.scatter(buf, profile, { veinDensity: 400 }, rngFrom(8080))

  assert(r.veins.length === 0, 'kept ' + r.veins.length + ' one-pixel veins')
  for (const hex of Object.keys(r.placed)) {
    assert(r.placed[hex] === 0, 'reported ' + r.placed[hex] + ' cells of ' + hex)
  }
  for (let i = 0; i < buf.data.length; i++) {
    assert(before[i] === buf.data[i],
      'a rolled-back vein left a pixel changed at byte ' + i)
  }
}

/* ------------------------------------------------------------------ *
 * Depth.
 * ------------------------------------------------------------------ */

/**
 * Depth bands hold.
 *
 * A flat surface at row 100 of a 300-row map, with the surface margin turned
 * off so the arithmetic is exact: 200 rows of ground, rows 100..299. A band of
 * 0..0.25 is rows 100..149, and 0.75..1 is rows 250..299. Nothing of either
 * material may appear outside its own band, and there must be enough of both
 * for the check to mean something.
 */
function testDepthBandsAreRespected() {
  const width = 340, height = 300
  const w = makeWorld(width, height, { flat: 100 })
  const r = ore.scatter(w.buf, w.profile, {
    surfaceMargin: 0,
    only: ['#f0d25a', '#0094b3'],
    materials: {
      '#f0d25a': { count: 40, size: [10, 10], depth: [0, 0.25] },
      '#0094b3': { count: 40, size: [10, 10], depth: [0.75, 1] },
    },
  }, rngFrom(606))

  assert(r.placed['#f0d25a'] > 200 && r.placed['#0094b3'] > 200,
    'not enough was placed to test the bands: ' + JSON.stringify(r.placed))

  const bands = { '#f0d25a': [100, 149], '#0094b3': [250, 299] }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const hex = hexAt(w.buf, x, y)
      const band = bands[hex]
      if (!band) continue
      assert(y >= band[0] && y <= band[1],
        hex + ' landed at row ' + y + ', outside its band ' + band[0] + '..' + band[1])
    }
  }

  // And the defaults really do sort common shallow, rare deep - the claim the
  // module's ORE table makes in prose.
  const defaults = new Map(ore.placeable().allowed.map((e) => [e.hex, e.ore]))
  assert(defaults.get('#f0d25a').depth.to < defaults.get('#0094b3').depth.from,
    'the default bands no longer put the soft common material above the rare hard one')
  assert(defaults.get('#f0d25a').density > defaults.get('#0094b3').density,
    'the default densities no longer make the deep material the rarer one')
}

/* ------------------------------------------------------------------ *
 * Parameters and edges.
 * ------------------------------------------------------------------ */

function testParamsAndEdges() {
  const w = makeWorld(340, 260)
  const r = ore.scatter(w.buf, w.profile, {
    only: ['#af00e0'],
    materials: { '#af00e0': { count: 3, size: [8, 8] } },
  }, rngFrom(11))
  assert(Object.keys(r.placed).length === 1 && r.placed['#af00e0'] > 0,
    '`only` did not restrict the run: ' + JSON.stringify(r.placed))

  const w2 = makeWorld(340, 260)
  const r2 = ore.scatter(w2.buf, w2.profile, {
    materials: { '#af00e0': { skip: true } },
  }, rngFrom(11))
  assert(r2.placed['#af00e0'] === undefined, '`skip` did not drop the material')

  const w3 = makeWorld(340, 260)
  const before = Uint8ClampedArray.from(w3.buf.data)
  const r3 = ore.scatter(w3.buf, w3.profile, { veinCount: 0 }, rngFrom(11))
  assert(r3.veins.length === 0, 'a zero count still placed veins')
  for (let i = 0; i < before.length; i++) {
    assert(before[i] === w3.buf.data[i], 'a zero count still changed the map')
  }

  // A map with no room at all, and nonsense input, must fail loudly or do
  // nothing - never write past the end of a buffer.
  const empty = ore.scatter({ data: new Uint8ClampedArray(0), width: 0, height: 0 },
    new Int32Array(0), {}, rngFrom(1))
  assert(empty.veins.length === 0, 'a zero-sized map produced veins')

  let threw = false
  try { ore.scatter(null, new Int32Array(4), {}, rngFrom(1)) } catch (e) { threw = true }
  assert(threw, 'scatter accepted a null buffer')

  threw = false
  try { ore.scatter({ data: new Uint8ClampedArray(64), width: 4, height: 4 }, null, {}, rngFrom(1)) } catch (e) { threw = true }
  assert(threw, 'scatter accepted a missing profile')

  threw = false
  try { ore.scatter({ data: new Uint8ClampedArray(64), width: 4, height: 4 }, new Int32Array(4), {}) } catch (e) { threw = true }
  assert(threw, 'scatter accepted a missing generator - it would have to use Math.random')
}

function testExportsExactly() {
  const keys = Object.keys(ore).sort()
  assert(keys.join(',') === 'placeable,scatter',
    'the module exports more than placeable and scatter: ' + keys.join(', '))
}

try {
  testExportsExactly()
  testPlaceableIsHonest()
  testSameSeedSameMap()
  testNeverCallsMathRandom()
  testLeavesAirCavesAndFixturesAlone()
  testSpawnPocketIsUntouched()
  testIndestructibleGroundIsNotReplaced()
  testEveryWrittenPixelIsSafe()
  testHandCountedVein()
  testVeinsAreConnectedRunsOfTheRequestedSize()
  testSinglePixelVeinsAreRolledBack()
  testDepthBandsAreRespected()
  testParamsAndEdges()
  console.log('PASS map generator ore-placement regression tests')
} catch (e) {
  console.error('FAIL map generator ore-placement regression tests:', e.message)
  process.exit(1)
}
