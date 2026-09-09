'use strict'
/**
 * The terrain-shape half of the map generator: parameters in, a landscape out.
 *
 * Nobody paints eight million cells by hand. This module is the first of the
 * generator's pure halves - it decides where the ground is and what it is made
 * of, and writes that into the same `{data, width, height}` RGBA buffer the map
 * editor's tools operate on. No DOM, no canvas, no randomness of its own: the
 * caller supplies `rng`, so a seed reproduces a world exactly.
 *
 * ## The buffer
 *
 * `{ data: Uint8ClampedArray, width, height }`, RGBA, four bytes per pixel,
 * row-major - exactly what `ImageData` gives, and exactly what
 * `src/renderer/mapeditor-tools.js` expects. One pixel is one world cell, and
 * `y = 0` is the TOP of the map. `applyGround` writes every pixel of the buffer.
 *
 * ## Why these materials and not others
 *
 * Every colour below is looked up in `src/game/terrain-palette.js` rather than
 * written down here, so a correction to that table reaches the generator instead
 * of leaving two tables to disagree. What each one is *for*:
 *
 *  - **Air** (`palette.DEFAULT_EMPTY`, 153,0,0) is the one air colour with no
 *    side effect. It is what the sky above the surface, and the spawn pocket,
 *    are made of.
 *  - **Open sky** (255,255,255) is also air, but it additionally records the
 *    column's horizon depth, which drives the cave-versus-surface ambient audio
 *    crossfade. Exactly one cell per column gets it - the cell immediately above
 *    that column's surface. One cell, rather than the whole sky, because that
 *    makes the recorded horizon unambiguous no matter how the loader aggregates
 *    a column's white pixels: with a single candidate, first-wins and last-wins
 *    are the same answer, and it is the right one.
 *  - **Dirt** (cellType 2) is the topsoil, because it has no tool requirement -
 *    the starting shovel gets through it from the first minute. A new player's
 *    first hole has to go somewhere.
 *  - **Stone** (cellType 23) sits underneath, because it needs a drill. That is
 *    exactly wrong for the surface layer and exactly right for the layer below
 *    it: the depth the player reaches is gated on the tool they have earned.
 *  - **Bedrock** (indestructible) is the last few rows, because no tool ever
 *    removes it. That makes it a floor and nothing else - the world has a
 *    bottom, and no amount of digging falls out of it.
 *
 * Two materials are never emitted, and the module refuses to load if the palette
 * ever hands one of them back:
 *
 *  - **Fog** (102,102,102 and its siblings) looks like black rock and collides,
 *    and then the first dig anywhere in a connected mass flood-fills all of it
 *    to open air. A generator that bulk-filled with it would produce a hollow
 *    world - which has already happened here once, by hand.
 *  - Anything the palette marks **broken**, which the loader refuses outright.
 *
 * And every pixel written is fully opaque, because alpha 0 does not decode to
 * air: it decodes to Fog.
 *
 * ## Cost
 *
 * `surfaceProfile` is O(width x octaves); `applyGround` is O(width x height)
 * with no allocation inside either loop - two `Int32Array`s the width of the map
 * are built up front and the pixel loop only reads them.
 *
 * @module mapgen-shape
 */

const palette = require('./terrain-palette.js')

/*
 * The spawn formula belongs to the validator, which read it out of the shipped
 * bundle, so it is called rather than copied - two copies of a fixed offset are
 * two chances to be wrong about it.
 *
 * The require is guarded because this module has two homes. Under Node it
 * resolves normally. In the renderer, `prelude.js` concatenates these files and
 * supplies a `require` that answers only the ids in its own table, where the
 * validator is registered as `./mapeditor-validate.js` and not by the path a
 * file in `src/game/` would use - so there the lookup throws, and the global the
 * validator publishes for exactly this purpose is read instead, lazily, at the
 * first call. Lazily, so that the two modules' install order does not matter.
 */
let VALIDATE = null
try {
  VALIDATE = require('../renderer/mapeditor-validate.js')
} catch (e) {
  VALIDATE = null
}

/** The spawn cell for a map this wide, from the validator's own formula. */
function spawnCellOf(width) {
  const mod = VALIDATE ||
    (typeof globalThis !== 'undefined' ? globalThis.__SMLN_MAPEDITOR_VALIDATE__ : null)
  if (!mod || typeof mod.spawnCell !== 'function') {
    throw new Error(
      'mapgen-shape: mapeditor-validate.spawnCell is unavailable, so the spawn ' +
      'pocket cannot be placed. Load src/renderer/mapeditor-validate.js first.')
  }
  return mod.spawnCell(width)
}

// ------------------------------------------------------------- the materials

/** The one fog entry named in the design notes; used to recognise the rest. */
const FOG_REF = palette.byRgb(102, 102, 102)

/**
 * True for anything this module must never write.
 *
 * `broken` is refused because the loader throws on it and the map never opens.
 * Fog is refused by two independent tests, because one colour is not the whole
 * family: several colours resolve to the same sealed-pocket cell type, and every
 * one of them says so in its own label.
 */
function unsafe(entry) {
  if (!entry) return true
  if (entry.kind === 'broken') return true
  if (/blocks until dug/i.test(entry.label || '')) return true
  if (FOG_REF && Number.isInteger(FOG_REF.cellType) && entry.cellType === FOG_REF.cellType) {
    return true
  }
  return false
}

/**
 * The first palette row matching `test`, checked for safety before it is used.
 *
 * Throwing at load rather than returning a fallback is deliberate: if a palette
 * correction removes the material this generator was built on, the honest
 * outcome is a loud failure, not a world quietly built out of whatever was left.
 */
function material(what, test) {
  const entry = palette.TERRAIN.find(test)
  if (!entry) {
    throw new Error('mapgen-shape: the terrain palette no longer has an entry for ' + what)
  }
  if (unsafe(entry)) {
    throw new Error(
      'mapgen-shape: the palette entry for ' + what + ' (' + entry.hex + ') is now ' +
      (entry.kind === 'broken' ? 'marked broken' : 'a sealed fog pocket') +
      ', which this module must never emit')
  }
  return entry
}

/** Plain open air: the only air colour with no side effect at all. */
const AIR = material('open air', (e) =>
  palette.DEFAULT_EMPTY && e.hex === palette.DEFAULT_EMPTY.hex)

/** Air that also records the column's horizon depth for the ambient audio. */
const SKY = material('open sky', (e) =>
  e.kind === 'empty' && e.cellType === 0 && /horizon/i.test(e.label))

/** Dirt: solid, hit points 4, no tool requirement - diggable from minute one. */
const DIRT = material('dirt', (e) => e.kind === 'solid' && e.cellType === 2)

/** Stone: solid, but its excavation requirement is a drill. */
const STONE = material('stone', (e) => e.kind === 'solid' && e.cellType === 23)

/** Bedrock: solid and indestructible. A floor, permanently. */
const BEDROCK = material('bedrock', (e) => e.kind === 'solid' && /^bedrock\b/i.test(e.label))

/** Three bytes each; alpha is always 255, because alpha 0 decodes to Fog. */
const AIR_RGB = AIR.rgb
const SKY_RGB = SKY.rgb
const DIRT_RGB = DIRT.rgb
const STONE_RGB = STONE.rgb
const BEDROCK_RGB = BEDROCK.rgb

// ---------------------------------------------------------------- parameters

/**
 * Defaults, chosen so that `surfaceProfile(w, {}, rng)` alone gives a playable
 * landscape on a map of the sizes the editor offers.
 *
 * `surfaceY` sits 8 cells below the spawn row of 200. Spawn is fixed and cannot
 * be moved, so the mean surface is put just under it: the player drops onto the
 * ground within a few cells instead of plummeting, and the hills still have room
 * to rise above the spawn row - where the pocket carves a starting hollow out of
 * them - and to fall well below it.
 */
const DEFAULTS = {
  /** Mean surface row, in cells from the top. */
  surfaceY: 208,
  /** Peak deviation from `surfaceY`, in cells. */
  amplitude: 28,
  /** Cells per period of the largest hill. */
  featureWidth: 160,
  /** How many halvings of `featureWidth` are summed. */
  octaves: 4,
  /** How much of the previous octave's height the next one keeps, 0..1. */
  roughness: 0.5,
  /** Hard bound on |profile[x] - profile[x - 1]|, in cells. */
  maxStep: 3,
  /** The surface never rises above this row - 1 leaves a row of sky. */
  minSurfaceY: 1,
  /** The surface never falls below this row; null for no bound. */
  maxSurfaceY: null,

  /** Rows of dirt under the surface before stone starts. */
  topsoilDepth: 24,
  /** Rows of bedrock at the very bottom of the map. */
  floorDepth: 4,

  /** The clear pocket around the spawn cell, in cells. */
  spawnPocketWidth: 11,
  spawnPocketHeight: 16,
  /** How many of those rows sit above the spawn row. */
  spawnPocketRise: 6,
}

/** A finite number from params, or the default. */
function num(v, dflt) {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

/** A whole number from params, or the default, clamped into [lo, hi]. */
function int(v, dflt, lo, hi) {
  let n = Math.round(num(v, dflt))
  if (!Number.isFinite(n)) n = dflt
  if (n < lo) n = lo
  if (n > hi) n = hi
  return n
}

// --------------------------------------------------------------- the profile

/** Smoothstep, so the interpolated curve has no corner at a lattice point. */
function ease(t) {
  return t * t * (3 - 2 * t)
}

/**
 * The surface row for every column, as an `Int32Array` of length `width`.
 *
 * Summed value noise: a few octaves of random lattice points, each half the
 * wavelength and `roughness` times the height of the one before, interpolated
 * with smoothstep. That gives broad hills with finer detail on them rather than
 * the drunken staircase a plain random walk produces.
 *
 * Continuity is then *guaranteed* rather than hoped for. The noise is already
 * smooth at the default settings, but a caller who asks for a large amplitude
 * over a short `featureWidth` can outrun it, and a world with a one-column
 * hundred-cell cliff in it is a comb, not a landscape. So a final forward pass
 * limits the slope: each column may differ from the one to its left by at most
 * `maxStep` cells. Forward only - one pass is enough to establish the bound
 * everywhere, and a backward pass as well would only trade one asymmetry for a
 * different one.
 *
 * `rng` is the caller's seeded generator. `Math.random` is never called here; a
 * generator that cannot reproduce a seed is not a generator.
 *
 * @param {number} width  the map's width in cells
 * @param {object} [params] see `DEFAULTS`
 * @param {function(): number} rng  returns a float in [0, 1)
 * @returns {Int32Array} the surface row of each column, top-down
 */
function surfaceProfile(width, params, rng) {
  const w = Math.floor(Number(width))
  if (!Number.isFinite(w) || w <= 0) {
    throw new TypeError('mapgen-shape.surfaceProfile: width must be a positive integer')
  }
  if (typeof rng !== 'function') {
    throw new TypeError('mapgen-shape.surfaceProfile: rng must be a function returning [0,1)')
  }
  const p = params || {}

  const base = num(p.surfaceY, DEFAULTS.surfaceY)
  const amplitude = Math.max(0, num(p.amplitude, DEFAULTS.amplitude))
  const featureWidth = Math.max(2, num(p.featureWidth, DEFAULTS.featureWidth))
  const octaves = int(p.octaves, DEFAULTS.octaves, 1, 12)
  const roughness = Math.min(1, Math.max(0, num(p.roughness, DEFAULTS.roughness)))
  const maxStep = int(p.maxStep, DEFAULTS.maxStep, 1, 4096)
  const minY = Math.max(1, int(p.minSurfaceY, DEFAULTS.minSurfaceY, 1, 0x7ffffffe))
  const maxYRaw = p.maxSurfaceY === undefined || p.maxSurfaceY === null
    ? null
    : int(p.maxSurfaceY, DEFAULTS.surfaceY, 1, 0x7ffffffe)
  const maxY = maxYRaw === null ? 0x7ffffffe : Math.max(minY, maxYRaw)

  // One lattice per octave, drawn from the caller's stream in a fixed order, so
  // the same seed draws the same numbers. Allocated once, outside every loop.
  const lattices = new Array(octaves)
  const wavelengths = new Float64Array(octaves)
  const weights = new Float64Array(octaves)
  let weightSum = 0
  for (let o = 0; o < octaves; o++) {
    const wl = Math.max(2, featureWidth / Math.pow(2, o))
    wavelengths[o] = wl
    weights[o] = Math.pow(roughness, o)
    weightSum += weights[o]
    const points = Math.ceil(w / wl) + 2
    const lattice = new Float64Array(points)
    for (let i = 0; i < points; i++) lattice[i] = rng()
    lattices[o] = lattice
  }
  // Normalised so the summed octaves span [-amplitude, amplitude] whatever
  // `roughness` and `octaves` were asked for.
  const scale = weightSum > 0 ? amplitude / weightSum : 0

  const profile = new Int32Array(w)
  for (let x = 0; x < w; x++) {
    let height = 0
    for (let o = 0; o < octaves; o++) {
      const wl = wavelengths[o]
      const pos = x / wl
      const i = Math.floor(pos)
      const lattice = lattices[o]
      const a = lattice[i]
      const b = lattice[i + 1]
      // Lattice values are in [0,1); centred and doubled they are in [-1,1).
      height += weights[o] * ((a + (b - a) * ease(pos - i)) * 2 - 1)
    }
    let y = Math.round(base + height * scale)
    if (y < minY) y = minY
    else if (y > maxY) y = maxY
    profile[x] = y
  }

  // The slope limiter. Clamping toward the previous column can only move a value
  // between two values that are already inside [minY, maxY], so the bounds above
  // survive it.
  for (let x = 1; x < w; x++) {
    const prev = profile[x - 1]
    if (profile[x] > prev + maxStep) profile[x] = prev + maxStep
    else if (profile[x] < prev - maxStep) profile[x] = prev - maxStep
  }

  return profile
}

// ---------------------------------------------------------------- the ground

/** Does this look like the `{data, width, height}` an ImageData gives us? */
function bufferOk(buf) {
  if (!buf || !buf.data || typeof buf.data.length !== 'number') return false
  const w = Math.floor(buf.width)
  const h = Math.floor(buf.height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false
  return buf.data.length >= w * h * 4
}

/** Write one cell. Alpha is 255 always: alpha 0 decodes to Fog, not to air. */
function put(d, i, rgb) {
  d[i] = rgb[0]
  d[i + 1] = rgb[1]
  d[i + 2] = rgb[2]
  d[i + 3] = 255
}

/**
 * Fill the whole buffer from a surface profile: air above, layered ground below.
 *
 * Every cell of the buffer is written, so the caller does not have to clear it
 * first and no cell is left holding whatever was there before - which on a fresh
 * `ImageData` would be four zero bytes, and a zero alpha is Fog.
 *
 * Top to bottom in each column:
 *
 *  1. plain air down to two rows above the surface;
 *  2. one cell of open sky immediately above the surface, which is what records
 *     this column's horizon depth;
 *  3. `topsoilDepth` rows of **dirt**, the material the starting shovel can dig,
 *     so the player's first hole is possible with the tool they arrive holding;
 *  4. **stone** all the way down, which needs a drill - the deeper world is
 *     gated on a tool the player has to earn;
 *  5. `floorDepth` rows of **bedrock** at the very bottom, indestructible, so
 *     the map has a floor nothing can dig through.
 *
 * Then the spawn pocket is cleared: a box `spawnPocketWidth` x
 * `spawnPocketHeight` cells (11 x 16 by default) centred on the spawn column,
 * with `spawnPocketRise` (6) of its rows above the spawn row and the remaining 9
 * below it. The player's box is 3 x 8 cells, so that is roughly three times
 * their width and twice their height - room to stand, turn and take a first step
 * rather than a slot they exactly fit. Spawn is fixed and unconditional: the
 * game does not look for open ground, so a world generated without this pocket
 * would start the player inside rock every time.
 *
 * The pocket never touches the bedrock floor. Carving a hole in the one layer
 * that exists to be un-diggable would be a hole in the bottom of the world. And
 * on a map too small to contain the fixed spawn cell there is no pocket at all -
 * the player was never inside the world, which is the validator's own
 * `spawn-outside` error, and a hole at the clipped edge would help nobody.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} buf
 * @param {Int32Array|number[]} profile  from `surfaceProfile`, length >= width
 * @param {object} [params] see `DEFAULTS`
 * @returns {{solid: number, air: number}} cell counts; they sum to width x height
 */
function applyGround(buf, profile, params) {
  if (!bufferOk(buf)) {
    throw new TypeError(
      'mapgen-shape.applyGround: buf must be {data, width, height} with room for width x height x 4 bytes')
  }
  const w = Math.floor(buf.width)
  const h = Math.floor(buf.height)
  if (!profile || typeof profile.length !== 'number' || profile.length < w) {
    throw new TypeError(
      'mapgen-shape.applyGround: profile must hold one surface row per column (' + w + ')')
  }
  const d = buf.data
  const p = params || {}

  const topsoil = int(p.topsoilDepth, DEFAULTS.topsoilDepth, 0, 0x7ffffffe)
  // At least one row of ground has to survive the floor, or the "map" is a slab
  // of bedrock; and there is no floor at all on a map one row tall.
  const floorDepth = int(p.floorDepth, DEFAULTS.floorDepth, 0, Math.max(0, h - 1))
  const floorTop = h - floorDepth          // first bedrock row

  // The surface is clamped into the rows that can actually hold one: at least 1,
  // so every column has a sky cell above it to record the horizon, and at most
  // `floorTop`, so ground never displaces the floor.
  const surfaceLo = 1
  const surfaceHi = Math.max(surfaceLo, floorTop)
  const surf = new Int32Array(w)
  const soilEnd = new Int32Array(w)        // first stone row, exclusive end of dirt
  for (let x = 0; x < w; x++) {
    let s = Math.floor(Number(profile[x]))
    if (!Number.isFinite(s)) s = DEFAULTS.surfaceY
    if (s < surfaceLo) s = surfaceLo
    else if (s > surfaceHi) s = surfaceHi
    surf[x] = s
    const end = s + topsoil
    soilEnd[x] = end > floorTop ? floorTop : end
  }

  let solid = 0
  let air = 0

  // Row-major, matching the buffer's own layout: the inner loop walks memory
  // forwards and reads two small arrays it has already built.
  for (let y = 0; y < h; y++) {
    let i = y * w * 4
    if (y >= floorTop) {
      for (let x = 0; x < w; x++, i += 4) put(d, i, BEDROCK_RGB)
      solid += w
      continue
    }
    for (let x = 0; x < w; x++, i += 4) {
      const s = surf[x]
      if (y < s - 1) { put(d, i, AIR_RGB); air++ }
      else if (y === s - 1) { put(d, i, SKY_RGB); air++ }
      else if (y < soilEnd[x]) { put(d, i, DIRT_RGB); solid++ }
      else { put(d, i, STONE_RGB); solid++ }
    }
  }

  // ---- the spawn pocket
  const spawn = spawnCellOf(w)
  // On a map too small to contain the fixed spawn cell there is nothing to keep
  // open - the player was never inside the world, which is the validator's own
  // `spawn-outside` error - and carving a pocket at the clipped edge instead
  // would only put a hole somewhere nobody asked for.
  if (spawn.x < 0 || spawn.x >= w || spawn.y < 0 || spawn.y >= h) {
    return { solid: solid, air: air }
  }

  const pw = int(p.spawnPocketWidth, DEFAULTS.spawnPocketWidth, 1, 0x7ffffffe)
  const ph = int(p.spawnPocketHeight, DEFAULTS.spawnPocketHeight, 1, 0x7ffffffe)
  const rise = int(p.spawnPocketRise, DEFAULTS.spawnPocketRise, 0, ph - 1)

  let x0 = spawn.x - Math.floor((pw - 1) / 2)
  let x1 = x0 + pw - 1
  let y0 = spawn.y - rise
  let y1 = y0 + ph - 1
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > w - 1) x1 = w - 1
  // Never into the floor: bedrock is the one layer whose whole job is to be
  // un-diggable, and a hole in it is a hole in the bottom of the world.
  if (y1 > floorTop - 1) y1 = floorTop - 1

  for (let y = y0; y <= y1; y++) {
    let i = (y * w + x0) * 4
    for (let x = x0; x <= x1; x++, i += 4) {
      // Only solid is cleared. A cell the fill already made air is left exactly
      // as it is - which matters for the one open-sky cell at `surf[x] - 1`,
      // since overwriting it would take away that column's horizon record.
      // Rows below the floor are already excluded, so above the surface is air
      // and at or below it is ground.
      if (y < surf[x]) continue
      solid--
      air++
      // What is carved is plain air, never open sky: the pocket can sit well
      // under the surface, and a white cell there would tell the game the
      // horizon is deeper than it is and play surface ambience inside a hole.
      put(d, i, AIR_RGB)
    }
  }

  return { solid: solid, air: air }
}

module.exports = { surfaceProfile, applyGround }
