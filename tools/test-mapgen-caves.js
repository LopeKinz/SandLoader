#!/usr/bin/env node
'use strict'
/**
 * Regression tests for the map generator's cave carving.
 *
 * Every one of these guards a failure that is invisible in a preview and fatal
 * in play: a cave that broke the sky, a hole in the world's floor, a cavern
 * carved through the spot the player lands in, a cell of fog that looks like
 * rock until the first shovel hit dissolves the whole wall, and a "cave" that is
 * really a thousand one-cell specks with a healthy-looking pixel count.
 *
 * The last three guard the two things a played world said were missing: a result
 * that is a cave system rather than a foam, and a density control whose response
 * a person can predict instead of a percolation cliff.
 */

const caves = require('../src/game/mapgen-caves.js')
const palette = require('../src/game/terrain-palette.js')
const { spawnCell } = require('../src/renderer/mapeditor-validate.js')

function assert(value, message) {
  if (!value) throw new Error(message)
}

/** The three colours these fixtures are built from, taken from the palette. */
const SKY = palette.byHex('#ffffff')
const ROCK = palette.DEFAULT_SOLID
const AIR = palette.DEFAULT_EMPTY

/**
 * A seeded float source. Any small deterministic generator would do; this one
 * is here so the tests never reach for `Math.random`, which is the exact defect
 * the reproducibility test exists to catch.
 */
function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A landscape: sky above the surface row of each column, solid rock below. */
function world(w, h, surfaceOf) {
  const data = new Uint8ClampedArray(w * h * 4)
  const profile = new Int32Array(w)
  for (let x = 0; x < w; x++) {
    const s = surfaceOf(x)
    profile[x] = s
    for (let y = 0; y < h; y++) {
      const c = y < s ? SKY.rgb : ROCK.rgb
      const i = (y * w + x) * 4
      data[i] = c[0]
      data[i + 1] = c[1]
      data[i + 2] = c[2]
      data[i + 3] = 255
    }
  }
  return { buf: { data: data, width: w, height: h }, profile: profile }
}

/** A rolling landscape big enough for the spawn point to exist inside it. */
function bigWorld() {
  return world(480, 270, (x) => 40 + Math.round(10 * Math.sin(x / 37)))
}

function copyOf(buf) {
  return new Uint8ClampedArray(buf.data)
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function pixel(buf, x, y) {
  const i = (y * buf.width + x) * 4
  return [buf.data[i], buf.data[i + 1], buf.data[i + 2], buf.data[i + 3]]
}

function is(px, rgb, alpha) {
  return px[0] === rgb[0] && px[1] === rgb[1] && px[2] === rgb[2] &&
    (alpha === undefined || px[3] === alpha)
}

/** Every cell whose bytes carve() changed, as {x, y}. */
function changedCells(buf, before) {
  const out = []
  for (let y = 0; y < buf.height; y++) {
    for (let x = 0; x < buf.width; x++) {
      const i = (y * buf.width + x) * 4
      if (buf.data[i] !== before[i] || buf.data[i + 1] !== before[i + 1] ||
          buf.data[i + 2] !== before[i + 2] || buf.data[i + 3] !== before[i + 3]) {
        out.push({ x: x, y: y })
      }
    }
  }
  return out
}

// --------------------------------------------------------------- the tests

/**
 * A seed is a promise: the same one has to give back the same map, byte for
 * byte, or nothing downstream can be reproduced from it - and a different one
 * has to give a different map, or the seed is not doing anything at all.
 */
function testSeedReproduces() {
  const a = bigWorld()
  const b = bigWorld()
  const c = bigWorld()

  const ra = caves.carve(a.buf, a.profile, {}, mulberry32(4242))
  const rb = caves.carve(b.buf, b.profile, {}, mulberry32(4242))
  const rc = caves.carve(c.buf, c.profile, {}, mulberry32(4243))

  assert(ra.carved > 0, 'the default parameters carved nothing at all')
  assert(sameBytes(a.buf.data, b.buf.data), 'the same seed produced two different maps')
  assert(ra.carved === rb.carved && ra.largest === rb.largest && ra.regions === rb.regions,
    'the same seed reported different statistics')
  assert(!sameBytes(a.buf.data, c.buf.data), 'a different seed produced an identical map')
}

/**
 * Nothing above the surface line is read back or written. A cave that reaches
 * the sky is not a cave, it is a pit, and the roof margin is what stops one.
 */
function testNeverCarvesAboveTheProfile() {
  const w = bigWorld()
  const before = copyOf(w.buf)
  const roof = 8
  const r = caves.carve(w.buf, w.profile, { roof: roof }, mulberry32(9))
  assert(r.carved > 0, 'nothing was carved, so this proves nothing')

  const changed = changedCells(w.buf, before)
  assert(changed.length === r.carved, 'carved count and changed pixels disagree: ' +
    r.carved + ' reported, ' + changed.length + ' actually changed')
  for (const cell of changed) {
    assert(cell.y >= w.profile[cell.x] + roof,
      'carved at ' + cell.x + ',' + cell.y + ', which is above the roof margin under ' +
      'surface row ' + w.profile[cell.x])
  }

  // And the sky itself is untouched, stated as its own fact rather than
  // inferred: every cell above a column's surface still holds the sky colour.
  for (let x = 0; x < w.buf.width; x++) {
    for (let y = 0; y < w.profile[x]; y++) {
      assert(is(pixel(w.buf, x, y), SKY.rgb, 255), 'the sky was overwritten at ' + x + ',' + y)
    }
  }
}

/**
 * The bottom border row survives, even when the caller asks for no floor at
 * all. A world with a hole in its floor drains everything that falls into it,
 * so a floor margin of 0 is clamped rather than honoured.
 */
function testBottomRowSurvives() {
  for (const floor of [undefined, 0, -5, 1]) {
    const w = bigWorld()
    const before = copyOf(w.buf)
    const r = caves.carve(w.buf, w.profile, { floor: floor }, mulberry32(11))
    assert(r.carved > 0, 'nothing was carved with floor=' + floor)
    const bottom = w.buf.height - 1
    for (let x = 0; x < w.buf.width; x++) {
      assert(is(pixel(w.buf, x, bottom), ROCK.rgb, 255),
        'the bottom border row was carved at column ' + x + ' with floor=' + floor)
    }
    const changed = changedCells(w.buf, before)
    for (const cell of changed) {
      assert(cell.y < bottom, 'a cell of the bottom row changed with floor=' + floor)
    }
  }
}

/**
 * The spawn pocket stays solid. The game does not look for open ground - it
 * drops the player at a fixed cell, every time - so a cavern carved through
 * that cell is a player falling out of the world on frame one.
 */
function testSpawnPocketUntouched() {
  const w = bigWorld()
  const spawn = spawnCell(w.buf.width)
  assert(spawn.x < w.buf.width && spawn.y < w.buf.height,
    'the fixture is too small for the spawn point to be inside it')

  // Clearance 0 is the strictest case: only the pocket itself is protected.
  const before = copyOf(w.buf)
  caves.carve(w.buf, w.profile, { spawnClearance: 0 }, mulberry32(77))
  for (let x = spawn.x; x < spawn.x + 4; x++) {
    for (let y = spawn.y; y < spawn.y + 9; y++) {
      assert(is(pixel(w.buf, x, y), ROCK.rgb, 255),
        'the spawn pocket was carved at ' + x + ',' + y)
    }
  }
  assert(changedCells(w.buf, before).length > 0, 'nothing was carved, so this proves nothing')

  // At the default clearance the caves do not even touch the pocket.
  const w2 = bigWorld()
  caves.carve(w2.buf, w2.profile, {}, mulberry32(77))
  for (let x = spawn.x - 4; x < spawn.x + 4 + 4; x++) {
    for (let y = spawn.y - 4; y < spawn.y + 9 + 4; y++) {
      assert(is(pixel(w2.buf, x, y), ROCK.rgb, 255),
        'a cave reached the spawn clearance at ' + x + ',' + y)
    }
  }
}

/**
 * Every written pixel is plain open air at full opacity - and nothing else.
 *
 * Three separate traps in one test. Alpha short of 255 decodes to fog, not to
 * air. The white air colour also records a column's horizon depth, so a cave
 * floored with it tells the game the surface is down there. And fog looks like
 * black rock right up until one broken cell dissolves the entire connected mass.
 */
function testWritesAreOpaqueAirOnly() {
  assert(!is(AIR.rgb, SKY.rgb), 'the fixture cannot tell air from sky')

  const w = bigWorld()
  const before = copyOf(w.buf)
  const r = caves.carve(w.buf, w.profile, {}, mulberry32(31337))
  assert(r.carved > 0, 'nothing was carved, so this proves nothing')

  for (const cell of changedCells(w.buf, before)) {
    const px = pixel(w.buf, cell.x, cell.y)
    assert(px[3] === 255, 'wrote a translucent pixel at ' + cell.x + ',' + cell.y +
      ' - alpha ' + px[3] + ' decodes to fog, not air')
    assert(is(px, AIR.rgb), 'wrote ' + px.slice(0, 3).join(',') + ' at ' + cell.x + ',' +
      cell.y + ' instead of plain air ' + AIR.rgb.join(','))
  }

  // Nothing anywhere in the finished map is fog, or anything else this
  // generator has no business introducing.
  const fogHexes = new Set(palette.TERRAIN.filter((e) => /fog/i.test(e.label)).map((e) => e.hex))
  assert(fogHexes.size > 0, 'the palette no longer names any fog colour, so this check is dead')
  const allowed = new Set([SKY.hex, ROCK.hex, AIR.hex])
  for (let y = 0; y < w.buf.height; y++) {
    for (let x = 0; x < w.buf.width; x++) {
      const px = pixel(w.buf, x, y)
      assert(px[3] === 255, 'a translucent pixel survives at ' + x + ',' + y)
      const hex = '#' + px.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')
      assert(!fogHexes.has(hex), 'fog (' + hex + ') is in the finished map at ' + x + ',' + y)
      assert(allowed.has(hex), 'an unexpected colour ' + hex + ' appeared at ' + x + ',' + y)
    }
  }
}

/**
 * `regions` and `largest` describe the actual result.
 *
 * Driven by a scripted generator rather than a seed, with the smoothing turned
 * off, so the carved shape is exactly this picture and the answer can be counted
 * by hand. Rows map to y = 1..10 of a 12x12 world; '#' is a cell the fill opens.
 *
 * Two connected caverns' worth of shape and five one-cell specks:
 *   a 2x2 block            4 cells
 *   a 3x3 ring, hollow     8 cells (connected all the way round; the centre cell
 *                                   stays rock and is not a region)
 *   five lone cells        5 cells
 * which is 7 regions, 17 cells carved, and a largest of 8.
 *
 * One of those lone cells sits diagonally off the corner of the 2x2 block, and
 * it is there to pin the connectivity rule rather than to make a shape: counted
 * 8-connected it would merge into the block and this would report 6 regions.
 * The game's own flood fills travel 4-connected - which is what stops paint, and
 * fog, leaking through the corner of a one-cell wall - so this does too.
 */
const PATTERN = [
  '##..........',
  '##..........',
  '..#.........',
  '....###.....',
  '....#.#.....',
  '....###.....',
  '............',
  '..........#.',
  '............',
  '.#.......#.#',
]

function patternWorld() {
  return world(12, 12, () => 0)
}

/** Returns rng plus a draw count, so the tests can pin how often it was asked. */
function scriptedRng() {
  const draws = []
  for (const row of PATTERN) {
    for (const ch of row) draws.push(ch === '#' ? 0 : 0.9)
  }
  const state = { used: 0, total: draws.length }
  state.next = function () {
    const v = state.used < draws.length ? draws[state.used] : 1
    state.used++
    return v
  }
  return state
}

function testRegionsAreCountedHonestly() {
  // `connect: false` because the corridors exist precisely to merge these into
  // one system, and this test is about counting what is there before they do.
  // `caverns: 0` keeps every chamber, so selection does not prune the count
  // either - the two later tests are where those stages are pinned.
  const params = {
    roof: 1, floor: 1, passes: 0, fill: 0.5, minRegion: 1,
    connect: false, caverns: 0,
  }

  const w = patternWorld()
  const rng = scriptedRng()
  const r = caves.carve(w.buf, w.profile, params, rng.next)

  assert(rng.used === rng.total, 'the fill drew ' + rng.used + ' random numbers for ' +
    rng.total + ' carvable cells, so the pattern does not line up with the picture')
  assert(r.carved === 17, 'carved ' + r.carved + ', expected 17')
  assert(r.regions === 7, 'reported ' + r.regions + ' regions, expected 7 - 6 would mean ' +
    'the diagonal speck was merged into the block, which is 8-connected counting')
  assert(r.largest === 8, 'reported a largest of ' + r.largest + ', expected 8')

  // The picture is on the map exactly where it was drawn.
  for (let row = 0; row < PATTERN.length; row++) {
    for (let x = 0; x < PATTERN[row].length; x++) {
      const y = row + 1
      const want = PATTERN[row][x] === '#' ? AIR.rgb : ROCK.rgb
      assert(is(pixel(w.buf, x, y), want, 255),
        'the carved shape differs from the pattern at ' + x + ',' + y)
    }
  }

  // The specks are the point of minRegion: raise it and the five one-cell holes
  // are filled back in, leaving two real caverns and 12 carved cells.
  const w2 = patternWorld()
  const rng2 = scriptedRng()
  const r2 = caves.carve(w2.buf, w2.profile, Object.assign({}, params, { minRegion: 4 }), rng2.next)
  assert(r2.carved === 12, 'pruned run carved ' + r2.carved + ', expected 12')
  assert(r2.regions === 2, 'pruned run reported ' + r2.regions + ' regions, expected 2')
  assert(r2.largest === 8, 'pruned run reported a largest of ' + r2.largest + ', expected 8')
  assert(is(pixel(w2.buf, 10, 8), ROCK.rgb, 255), 'a one-cell speck survived the prune')
  assert(is(pixel(w2.buf, 1, 10), ROCK.rgb, 255), 'a one-cell speck survived the prune')
  assert(is(pixel(w2.buf, 2, 3), ROCK.rgb, 255), 'the diagonal speck survived the prune')
  assert(is(pixel(w2.buf, 0, 1), AIR.rgb, 255), 'the prune filled in a real cavern')
  assert(is(pixel(w2.buf, 4, 4), AIR.rgb, 255), 'the prune filled in a real cavern')
}

/** Smoothing is what makes caves out of noise, and it can be counted. */
function testSmoothingBeatsRawNoise() {
  // The later stages are off so that this compares the one thing it names: the
  // same seed field, the same threshold, with and without the passes.
  const bare = { fill: 0.46, minRegion: 1, caverns: 0, connect: false }
  const raw = bigWorld()
  const rawStats = caves.carve(raw.buf, raw.profile,
    Object.assign({}, bare, { passes: 0 }), mulberry32(1))
  const smooth = bigWorld()
  const smoothStats = caves.carve(smooth.buf, smooth.profile, bare, mulberry32(1))

  assert(smoothStats.regions * 4 < rawStats.regions,
    'smoothing barely reduced the speck count: ' + rawStats.regions + ' -> ' + smoothStats.regions)
  assert(smoothStats.largest > rawStats.largest * 4,
    'smoothing barely grew the largest cavern: ' + rawStats.largest + ' -> ' + smoothStats.largest)
}

/**
 * The corridors turn a scatter of sealed rooms into one system.
 *
 * Run on the same hand-counted picture, so the before is known exactly: seven
 * chambers, 17 cells. Connecting them can only ever add cells and can only ever
 * reduce the region count, and the finished numbers have to describe that - if
 * `carve` reported the pre-corridor count it would be lying about the map it
 * just wrote.
 */
function testCorridorsMakeOneSystem() {
  const w = patternWorld()
  const rng = scriptedRng()
  const r = caves.carve(w.buf, w.profile,
    { roof: 1, floor: 1, passes: 0, fill: 0.5, minRegion: 1, caverns: 0, connect: true },
    rng.next)

  assert(rng.used === rng.total, 'connecting drew extra random numbers: ' + rng.used +
    ' for ' + rng.total + ' carvable cells - the corridors must not consume the generator')
  assert(r.regions === 1, 'the corridors left ' + r.regions + ' regions, expected 1 system')
  assert(r.carved > 17, 'the corridors carved nothing: still ' + r.carved + ' cells')
  assert(r.largest === r.carved, 'the one system does not hold every carved cell')

  // Every cell the picture asked for is still open, and the guards still hold
  // for the corridors - they are carved through the same permission mask.
  for (let row = 0; row < PATTERN.length; row++) {
    for (let x = 0; x < PATTERN[row].length; x++) {
      if (PATTERN[row][x] !== '#') continue
      assert(is(pixel(w.buf, x, row + 1), AIR.rgb, 255),
        'a corridor run closed a chamber cell at ' + x + ',' + (row + 1))
    }
  }
  for (let x = 0; x < w.buf.width; x++) {
    assert(is(pixel(w.buf, x, 0), ROCK.rgb, 255), 'a corridor reached row 0 at column ' + x)
    assert(is(pixel(w.buf, x, w.buf.height - 1), ROCK.rgb, 255),
      'a corridor reached the bottom border row at column ' + x)
  }
}

/**
 * `density` responds the way a person expects, which the raw threshold does not.
 *
 * This is the whole reason the exposed control is solved for rather than set.
 * The threshold sits on a percolation cliff - on an 800x400 world 0.35 empties
 * 1.6% of the underground and 0.46 empties 28.9%, so a nudge of 0.03 gives an
 * unrecognisably different map. Asking for twice the density has to give about
 * twice the ground, or the control is not a control.
 */
function testDensityResponseIsPredictable() {
  const got = {}
  for (const density of [0.05, 0.1, 0.2]) {
    const w = bigWorld()
    got[density] = caves.carve(w.buf, w.profile, { density: density }, mulberry32(808)).carved
    assert(got[density] > 0, 'density ' + density + ' carved nothing')
  }
  for (const [lo, hi] of [[0.05, 0.1], [0.1, 0.2]]) {
    const ratio = got[hi] / got[lo]
    assert(ratio > 1.7 && ratio < 2.3, 'doubling density from ' + lo + ' to ' + hi +
      ' changed the carved area by ' + ratio.toFixed(2) + 'x, expected about 2x (' +
      got[lo] + ' -> ' + got[hi] + ')')
  }

  // Solving must not cost extra randomness: however many trial rounds it runs,
  // the generator is still drawn from exactly once per carvable cell.
  function counting(seed) {
    const inner = mulberry32(seed)
    const state = { used: 0 }
    state.next = function () { state.used++; return inner() }
    return state
  }
  const solved = bigWorld()
  const solvedRng = counting(5)
  caves.carve(solved.buf, solved.profile, {}, solvedRng.next)
  const direct = bigWorld()
  const directRng = counting(5)
  caves.carve(direct.buf, direct.profile, { fill: 0.4 }, directRng.next)
  assert(solvedRng.used === directRng.used, 'the density solve drew ' + solvedRng.used +
    ' random numbers where a named threshold drew ' + directRng.used)
}

/**
 * The default is a cave system, not a foam.
 *
 * A played world at the old default came back described as a sponge: caverns
 * wall to wall with thin webs of rock between them, 338 regions averaging 128
 * cells. So this asserts the shape of the result and not only its size - the
 * ground is still mostly ground, what is carved is nearly all one connected
 * system, and the chambers in it are big enough to be worth walking into.
 */
function testDefaultsGiveACaveSystem() {
  for (const seed of [1, 2, 3]) {
    const w = bigWorld()
    const r = caves.carve(w.buf, w.profile, {}, mulberry32(seed))

    let ground = 0
    for (let x = 0; x < w.buf.width; x++) ground += w.buf.height - w.profile[x]
    const share = r.carved / ground
    assert(share > 0.04 && share < 0.18, 'seed ' + seed + ' emptied ' +
      (100 * share).toFixed(1) + '% of the underground; the default should leave ' +
      'ground that still reads as ground')
    assert(r.regions <= 2, 'seed ' + seed + ' left ' + r.regions +
      ' separate cave systems, which is a scatter rather than a system')
    assert(r.largest / r.carved > 0.95, 'seed ' + seed + ' put only ' +
      (100 * r.largest / r.carved).toFixed(0) + '% of the carved area in its largest system')
    assert(r.largest > 3000, 'seed ' + seed + ' largest system is only ' + r.largest +
      ' cells, which is a room rather than a cave system')
  }
}

/**
 * `caverns` is the "fewer, larger" knob, and it does what it says.
 *
 * With the corridors off - they would merge everything into one region and hide
 * the count - asking for N chambers gives at most N, and asking for few gives
 * bigger ones than asking for many.
 */
function testCavernCountIsAControl() {
  const seen = {}
  for (const caverns of [4, 20]) {
    const w = bigWorld()
    seen[caverns] = caves.carve(w.buf, w.profile, { caverns: caverns, connect: false },
      mulberry32(64))
    assert(seen[caverns].regions <= caverns, 'asked for at most ' + caverns +
      ' chambers and got ' + seen[caverns].regions)
    assert(seen[caverns].regions > 0, 'asking for ' + caverns + ' chambers gave none')
  }
  assert(seen[20].regions > seen[4].regions, 'asking for 20 chambers gave no more than ' +
    'asking for 4: ' + seen[20].regions + ' vs ' + seen[4].regions)
  const few = seen[4].carved / seen[4].regions
  const many = seen[20].carved / seen[20].regions
  assert(few > many, 'four chambers averaged ' + Math.round(few) + ' cells and twenty ' +
    'averaged ' + Math.round(many) + ' - fewer is supposed to mean larger')
}

/**
 * A corridor cannot strand a speck on the far side of something it cannot carve.
 *
 * This is the one way a sub-minimum cavern can still appear after selection has
 * already thrown the small chambers away: a wide corridor running alongside a
 * thin band of material that is not carvable - water, here - spills past it, and
 * what lands on the far side is cut off from everything.
 *
 * The fixture makes that happen on purpose. Two 30-cell chambers with a
 * full-width row of water below them; a corridor four cells to a side, which is
 * exactly wide enough to reach across the water into the rock beyond it. Run
 * with no minimum, the stranded strip is there and is counted as its own region.
 * Run with the default rule, the same strip is filled back in. Both halves are
 * asserted, because the first is what proves the second is doing something.
 */
function strandedWorld() {
  const w = 24
  const h = 12
  const wd = world(w, h, () => 0)
  const water = palette.byHex('#0000ff')
  assert(water && water.kind !== 'solid', 'the fixture needs a colour that is not carvable')
  for (let x = 0; x < w; x++) {
    const i = (7 * w + x) * 4
    wd.buf.data[i] = water.rgb[0]
    wd.buf.data[i + 1] = water.rgb[1]
    wd.buf.data[i + 2] = water.rgb[2]
    wd.buf.data[i + 3] = 255
  }
  return wd
}

/** Draws in the order carve consumes them: row-major, one per carvable cell. */
function seedRng(buf, roof, floor, seeded) {
  const draws = []
  for (let y = 0; y < buf.height; y++) {
    for (let x = 0; x < buf.width; x++) {
      if (y < roof || y > buf.height - 1 - floor) continue
      if (!is(pixel(buf, x, y), ROCK.rgb)) continue
      draws.push(seeded(x, y) ? 0 : 0.9)
    }
  }
  const state = { used: 0, total: draws.length }
  state.next = function () {
    const v = state.used < draws.length ? draws[state.used] : 1
    state.used++
    return v
  }
  return state
}

function testCorridorsStrandNothing() {
  const chambers = (x, y) => y >= 2 && y <= 6 && ((x >= 1 && x <= 6) || (x >= 17 && x <= 22))
  const base = {
    roof: 1, floor: 1, passes: 0, fill: 0.5, caverns: 0,
    connect: true, corridorRadius: 4,
  }

  const loose = strandedWorld()
  const looseStats = caves.carve(loose.buf, loose.profile,
    Object.assign({}, base, { minRegion: 1 }), seedRng(loose.buf, 1, 1, chambers).next)
  let spilled = 0
  for (let x = 0; x < loose.buf.width; x++) {
    if (is(pixel(loose.buf, x, 8), AIR.rgb, 255)) spilled++
  }
  assert(spilled > 0, 'the fixture never strands anything, so it proves nothing')
  assert(looseStats.regions === 2, 'with no minimum the stranded strip should be its own ' +
    'region, giving 2; got ' + looseStats.regions)

  const strict = strandedWorld()
  const strictStats = caves.carve(strict.buf, strict.profile,
    Object.assign({}, base, { minRegion: 26 }), seedRng(strict.buf, 1, 1, chambers).next)
  assert(strictStats.regions === 1, 'the stranded strip was still reported: ' +
    strictStats.regions + ' regions, expected 1')
  for (let x = 0; x < strict.buf.width; x++) {
    assert(is(pixel(strict.buf, x, 8), ROCK.rgb, 255),
      'a stranded corridor speck survived at ' + x + ',8')
  }

  // And the water itself was never carved, in either run.
  const water = palette.byHex('#0000ff')
  for (const wd of [loose, strict]) {
    for (let x = 0; x < wd.buf.width; x++) {
      assert(is(pixel(wd.buf, x, 7), water.rgb, 255),
        'a corridor carved through water at ' + x + ',7')
    }
  }
}

/** Bad input carves nothing rather than guessing. */
function testRefusesWhatItCannotCarve() {
  const w = bigWorld()
  const before = copyOf(w.buf)
  const zero = { carved: 0, largest: 0, regions: 0 }
  const cases = [
    ['no buffer', () => caves.carve(null, w.profile, {}, mulberry32(1))],
    ['no rng', () => caves.carve(w.buf, w.profile, {}, null)],
    ['no profile', () => caves.carve(w.buf, null, {}, mulberry32(1))],
    ['short profile', () => caves.carve(w.buf, new Int32Array(4), {}, mulberry32(1))],
  ]
  for (const [name, run] of cases) {
    const r = run()
    assert(r.carved === zero.carved && r.largest === zero.largest && r.regions === zero.regions,
      name + ' should have carved nothing, got ' + JSON.stringify(r))
  }
  assert(sameBytes(w.buf.data, before), 'a refused call still modified the buffer')
}

try {
  testSeedReproduces()
  testNeverCarvesAboveTheProfile()
  testBottomRowSurvives()
  testSpawnPocketUntouched()
  testWritesAreOpaqueAirOnly()
  testRegionsAreCountedHonestly()
  testSmoothingBeatsRawNoise()
  testCorridorsMakeOneSystem()
  testDensityResponseIsPredictable()
  testDefaultsGiveACaveSystem()
  testCavernCountIsAControl()
  testCorridorsStrandNothing()
  testRefusesWhatItCannotCarve()
  console.log('PASS map generator cave carving regression tests')
} catch (e) {
  console.error('FAIL map generator cave carving regression tests:', e.message)
  process.exit(1)
}
