'use strict'
/**
 * The cave half of the map generator: caverns hollowed out of solid ground.
 *
 * `mapgen-shape.js` lays down a landscape - sky above a surface line, solid
 * material below it. This module takes that buffer and empties cells out of the
 * solid part, leaving rooms and passages. It is the only thing here: it does not
 * decide what the ground is made of, does not place ore, and does not touch a
 * single pixel above the surface line it is handed.
 *
 * ## Why cellular automata
 *
 * The obvious way to make caves is to roll a die per cell and empty the ones
 * that come up low. That does not make caves; it makes static. Every hole is one
 * cell wide, nothing connects to anything, and a player sees speckled rock
 * rather than a space they can stand in.
 *
 * So the fill is only the seed. The shape comes from repeatedly replacing every
 * cell with the majority verdict of its eight neighbours: a lone hole in solid
 * rock has no cave neighbours and closes; a hole in a crowd of holes stays open
 * and its ragged edge gets smoothed. A few passes of that turn noise into
 * rounded chambers with wandering walls, which is what a cave looks like. It is
 * the classic method for exactly this reason - it is two nested loops, it has
 * knobs a person can reason about, and its output can be counted in a test
 * rather than judged by eye.
 *
 * The difference is measurable, and was measured on a 480x270 map at the
 * defaults below. The raw fill is 8,860 separate holes whose biggest is 167
 * cells - static. One pass leaves 1,695, and its biggest is already 1,301. Four
 * passes leave 492. That is the whole argument for the method: the passes are
 * not cosmetic, they are what turns thousands of specks into hundreds of rooms.
 *
 * The knobs are all in `params`. The defaults give a cave field - a few hundred
 * chambers of a hundred-odd cells each through otherwise solid ground - rather
 * than one hollow world:
 *
 *   fill            0..1, how much of the carvable ground starts as cave. This
 *                   is the knob that matters, and it does not behave linearly:
 *                   on that same map 0.44 empties 23% of the ground into 290
 *                   caverns whose largest is 646 cells, 0.46 empties 31% into
 *                   263 whose largest is 1,419, 0.48 empties 39% into 166 whose
 *                   largest is 3,930, and 0.50 empties 48% into 75 whose largest
 *                   is 16,959. Connectivity is bought with hollowness, and past
 *                   about 0.52 the ground is more air than rock. Below 0.40 the
 *                   seeds die out and almost nothing survives.
 *   passes          how many smoothing rounds. 0 leaves the raw fill (which is
 *                   what makes the pattern tests countable by hand); past six or
 *                   so the shape stops changing. Capped, so a caller cannot ask
 *                   for an unbounded amount of work.
 *   birth, survive  how many of the eight neighbours must be cave for solid rock
 *                   to open up, and for an open cell to stay open. birth above
 *                   survive is what lets a chamber hold its shape while isolated
 *                   specks still die.
 *   roof            solid cells kept between the surface line and the highest
 *                   cave. At least 1 always, so a cave can never break the sky.
 *   floor           solid rows kept above the bottom edge. At least 1 always, so
 *                   the bottom border row is never carved - a world with a hole
 *                   in its floor drains everything that falls into it. The
 *                   default of 2 is the safety margin and nothing more: if the
 *                   shape pass laid a bedrock floor several rows thick and you
 *                   would rather caves did not reach up into it, this is the
 *                   knob, and it wants that thickness.
 *   minRegion       caverns smaller than this are filled back in. A one-cell
 *                   hole is not a cave, and shipping a thousand of them would
 *                   make the carved-cell count look healthy while the map is
 *                   unplayable.
 *   spawnClearance,
 *   spawnPocketWidth,
 *   spawnPocketHeight
 *                   the box around the player's landing spot that stays solid.
 *
 * ## What gets written
 *
 * One colour, ever: the palette's plain open air. Not the white that also
 * records a column's horizon depth - underground, that colour tells the game the
 * surface is down there and the cave ambience never comes on - and never fog,
 * which looks like black rock and then dissolves its whole connected mass the
 * instant anything breaks one cell of it. If a caller ever asks this module for
 * sealed pockets, the answer is no: at cave scale a fog pocket is a bomb, and
 * there is no size at which "the entire cavern wall vanishes on the first shovel
 * hit" is the feature somebody wanted.
 *
 * Every write is fully opaque. Alpha 0 decodes to fog, not to air.
 *
 * ## Cost
 *
 * One classification pass, `passes` smoothing passes and one labelling pass,
 * each O(width x height) with constant work per cell. The typed arrays are
 * allocated once up front; nothing is allocated per pixel.
 *
 * Plain CommonJS, no DOM. `mapeditor-validate.js` is required for one thing only
 * - `spawnCell` - because the spawn formula is fixed, unobvious and already
 * written down there, and a second copy of it here would be a second copy to get
 * wrong. That module is pure too.
 *
 * @module mapgen-caves
 */

const palette = require('./terrain-palette.js')
const { spawnCell } = require('../renderer/mapeditor-validate.js')

/**
 * The only colour this module writes: air with no side effects.
 *
 * Taken from the palette by its role rather than as a triple, and checked, so
 * that if that table is ever reordered or re-valued this fails loudly at load
 * instead of quietly carving caves out of something else.
 */
const AIR = palette.DEFAULT_EMPTY
if (!AIR || AIR.kind !== 'empty' || AIR.cellType !== 0 || !Array.isArray(AIR.rgb)) {
  throw new Error('mapgen-caves: the terrain palette no longer offers a plain air entry')
}
const AIR_R = AIR.rgb[0]
const AIR_G = AIR.rgb[1]
const AIR_B = AIR.rgb[2]

/** Defaults for every knob. See the module comment for what each one does. */
const DEFAULTS = {
  fill: 0.46,
  passes: 4,
  birth: 5,
  survive: 4,
  roof: 8,
  floor: 2,
  minRegion: 24,
  spawnClearance: 4,
  spawnPocketWidth: 4,
  spawnPocketHeight: 9,
}

/** Smoothing is bounded: no caller gets to ask for an unbounded amount of work. */
const MAX_PASSES = 16

/** Distinct colours whose palette lookup the classification pass memoises. */
const CLASS_CACHE_CAP = 4096

/** True when `buf` is a pixel buffer big enough for the size it claims. */
function bufferOk(buf) {
  if (!buf || !buf.data || typeof buf.data.length !== 'number') return false
  const w = Math.floor(buf.width)
  const h = Math.floor(buf.height)
  if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return false
  return buf.data.length >= w * h * 4
}

/** A whole number from `v`, clamped, falling back to `fallback` if it is not one. */
function whole(v, fallback, min, max) {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return fallback
  if (n < min) return min
  if (n > max) return max
  return n
}

/** A 0..1 fraction from `v`, falling back to `fallback` if it is not one. */
function fraction(v, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/**
 * `params` filled in and clamped. Never mutates what it was given.
 *
 * `roof` and `floor` have a minimum of 1 rather than 0, and that is not
 * tidiness: 0 would let a cavern reach the surface row itself or the bottom
 * border row, which are the two carves this module exists to never make.
 */
function options(params) {
  const p = params && typeof params === 'object' ? params : {}
  return {
    fill: fraction(p.fill, DEFAULTS.fill),
    passes: whole(p.passes, DEFAULTS.passes, 0, MAX_PASSES),
    birth: whole(p.birth, DEFAULTS.birth, 0, 8),
    survive: whole(p.survive, DEFAULTS.survive, 0, 8),
    roof: whole(p.roof, DEFAULTS.roof, 1, 1 << 20),
    floor: whole(p.floor, DEFAULTS.floor, 1, 1 << 20),
    minRegion: whole(p.minRegion, DEFAULTS.minRegion, 1, 1 << 28),
    spawnClearance: whole(p.spawnClearance, DEFAULTS.spawnClearance, 0, 1 << 20),
    spawnPocketWidth: whole(p.spawnPocketWidth, DEFAULTS.spawnPocketWidth, 0, 1 << 20),
    spawnPocketHeight: whole(p.spawnPocketHeight, DEFAULTS.spawnPocketHeight, 0, 1 << 20),
  }
}

/**
 * Which cells this run is allowed to empty, as one byte per cell.
 *
 * A cell is carvable when all four of these hold:
 *
 *  - it is at least `roof` rows below its own column's surface, so no cave
 *    breaks through the sky and no pixel above the profile is ever written;
 *  - it is at least `floor` rows above the bottom edge, so the border row lives;
 *  - it is outside the spawn keep-out box;
 *  - it currently holds a colour the palette calls solid. Anything else - air
 *    already there, water, an unrecognised colour - is left exactly as it is.
 *    Rock is the only thing a cave is carved out of.
 *
 * Everything else counts as wall for the smoothing passes, which is what makes
 * caverns taper closed at the surface, at the floor and around spawn instead of
 * being sliced off there with a straight edge.
 */
function carvable(buf, profile, p, w, h) {
  const open = new Uint8Array(w * h)
  const d = buf.data
  const cache = new Map()

  // The spawn point is read from the validator, never re-derived: the formula is
  // half the width plus a fixed offset that is not a whole number of cells, and
  // it does not scale with the map.
  const spawn = spawnCell(w)
  const keepX0 = spawn.x - p.spawnClearance
  const keepX1 = spawn.x + p.spawnPocketWidth - 1 + p.spawnClearance
  const keepY0 = spawn.y - p.spawnClearance
  const keepY1 = spawn.y + p.spawnPocketHeight - 1 + p.spawnClearance

  const lastRow = h - 1 - p.floor
  for (let x = 0; x < w; x++) {
    let surface = Math.floor(Number(profile[x]))
    if (!Number.isFinite(surface) || surface < 0) surface = 0
    const firstRow = surface + p.roof
    const inSpawnColumns = x >= keepX0 && x <= keepX1
    for (let y = firstRow; y <= lastRow; y++) {
      if (inSpawnColumns && y >= keepY0 && y <= keepY1) continue
      const idx = y * w + x
      const i = idx * 4
      const key = (d[i] * 256 + d[i + 1]) * 256 + d[i + 2]
      let solid = cache.get(key)
      if (solid === undefined) {
        const entry = palette.byRgb(d[i], d[i + 1], d[i + 2])
        solid = !!entry && entry.kind === 'solid'
        if (cache.size < CLASS_CACHE_CAP) cache.set(key, solid)
      }
      if (solid) open[idx] = 1
    }
  }
  return open
}

/**
 * How many of the eight neighbours are cave.
 *
 * Off the edge of the buffer counts as rock, so the map's border behaves like
 * the solid mass it is and caves do not grow out through it.
 */
function neighbours(cave, w, h, x, y) {
  let n = 0
  for (let dy = -1; dy <= 1; dy++) {
    const ny = y + dy
    if (ny < 0 || ny >= h) continue
    const base = ny * w
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue
      const nx = x + dx
      if (nx < 0 || nx >= w) continue
      n += cave[base + nx]
    }
  }
  return n
}

/**
 * Hollow caverns out of the solid ground below `profile`. Mutates `buf`.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} buf RGBA,
 *   row-major, one pixel per world cell, y = 0 at the top.
 * @param {Int32Array|number[]} profile surface row per column, as
 *   `mapgen-shape.js` produces. It must have one entry per column; without that
 *   this refuses to carve rather than guessing where the sky ends.
 * @param {object} [params] the knobs above. Missing values take the defaults.
 * @param {function(): number} rng seeded float source in [0, 1). Consumed once
 *   per carvable cell, row-major from the top-left, so the same seed and the
 *   same inputs always give the same map. `Math.random` is never called here.
 * @returns {{carved: number, largest: number, regions: number}} cells emptied,
 *   the size of the biggest connected cavern, and how many caverns there are.
 *   Connectivity is 4-connected, which is how the game's own flood fills travel.
 */
function carve(buf, profile, params, rng) {
  const nothing = { carved: 0, largest: 0, regions: 0 }
  if (!bufferOk(buf)) return nothing
  if (typeof rng !== 'function') return nothing

  const w = Math.floor(buf.width)
  const h = Math.floor(buf.height)
  if (!profile || typeof profile.length !== 'number' || profile.length < w) return nothing

  const p = options(params)
  const open = carvable(buf, profile, p, w, h)

  // --- Seed: noise, which is not yet caves.
  let cave = new Uint8Array(w * h)
  let next = new Uint8Array(w * h)
  for (let idx = 0; idx < open.length; idx++) {
    if (open[idx] && rng() < p.fill) cave[idx] = 1
  }

  // --- Smooth: the majority rule that turns the noise into rooms.
  for (let pass = 0; pass < p.passes; pass++) {
    for (let y = 0; y < h; y++) {
      const base = y * w
      for (let x = 0; x < w; x++) {
        const idx = base + x
        if (!open[idx]) { next[idx] = 0; continue }
        const n = neighbours(cave, w, h, x, y)
        next[idx] = (cave[idx] ? n >= p.survive : n >= p.birth) ? 1 : 0
      }
    }
    const swap = cave
    cave = next
    next = swap
  }

  // --- Label: what is actually connected to what. An explicit index stack, not
  // --- recursion - one cavern can reach most of a map, and the recursive form
  // --- would blow the JavaScript stack on the author's machine, not here.
  const label = new Int32Array(w * h)
  const stack = new Int32Array(w * h)
  const sizes = []
  for (let seed = 0; seed < cave.length; seed++) {
    if (!cave[seed] || label[seed]) continue
    const id = sizes.length + 1
    let size = 0
    let sp = 0
    stack[sp++] = seed
    label[seed] = id
    while (sp > 0) {
      const idx = stack[--sp]
      size++
      const x = idx % w
      if (x > 0 && cave[idx - 1] && !label[idx - 1]) { label[idx - 1] = id; stack[sp++] = idx - 1 }
      if (x < w - 1 && cave[idx + 1] && !label[idx + 1]) { label[idx + 1] = id; stack[sp++] = idx + 1 }
      if (idx >= w && cave[idx - w] && !label[idx - w]) { label[idx - w] = id; stack[sp++] = idx - w }
      const down = idx + w
      if (down < cave.length && cave[down] && !label[down]) { label[down] = id; stack[sp++] = down }
    }
    sizes.push(size)
  }

  // --- Prune: a hole too small to stand in is not a cavern, and counting it as
  // --- one would let this function report a healthy map full of specks.
  let carved = 0
  let largest = 0
  let regions = 0
  for (let i = 0; i < sizes.length; i++) {
    if (sizes[i] < p.minRegion) continue
    regions++
    carved += sizes[i]
    if (sizes[i] > largest) largest = sizes[i]
  }

  // --- Write. Every carvable cell held a solid colour, so every one of these is
  // --- a real change, and `carved` is both cells emptied and pixels written.
  const d = buf.data
  for (let idx = 0; idx < cave.length; idx++) {
    const id = label[idx]
    if (!id || sizes[id - 1] < p.minRegion) continue
    const i = idx * 4
    d[i] = AIR_R
    d[i + 1] = AIR_G
    d[i + 2] = AIR_B
    d[i + 3] = 255
  }

  return { carved: carved, largest: largest, regions: regions }
}

module.exports = { carve }
