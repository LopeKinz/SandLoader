'use strict'
/**
 * The cave half of the map generator: caverns hollowed out of solid ground.
 *
 * `mapgen-shape.js` lays down a landscape - sky above a surface line, solid
 * material below it. This module takes that buffer and empties cells out of the
 * solid part, leaving chambers and the passages between them. It is the only
 * thing here: it does not decide what the ground is made of, does not place ore,
 * and does not touch a single pixel above the surface line it is handed.
 *
 * ## Why cellular automata, and where they stop
 *
 * The obvious way to make caves is to roll a die per cell and empty the ones
 * that come up low. That does not make caves; it makes static. Every hole is one
 * cell wide, nothing connects to anything, and a player sees speckled rock
 * rather than a space they can stand in.
 *
 * So the fill is only a seed. The shape comes from repeatedly replacing every
 * cell with the majority verdict of its eight neighbours: a lone hole in solid
 * rock has no cave neighbours and closes; a hole in a crowd of holes stays open
 * and its ragged edge gets smoothed. The difference is measurable. On a 480x270
 * fixture the raw fill is 8,860 separate holes whose biggest is 167 cells; one
 * pass leaves 1,695 and its biggest is already 1,301; four passes leave 492. The
 * passes are the method, not decoration.
 *
 * What the passes cannot do is give large connected caverns *and* mostly-solid
 * ground, because for this rule those are the same knob. The seed threshold has
 * a percolation threshold just under 0.5, and the map falls through it: measured
 * on an 800x400 world, a threshold of 0.35 empties 1.6% of the underground into
 * 69 pockets whose largest is 77 cells, 0.40 empties 9.4% into 287 whose largest
 * is 190, and 0.46 empties 28.9% into 338 whose largest is 1,309. Below the
 * threshold you get foam that is all crumbs; above it you get foam that is all
 * air. There is no setting of a single density at which this rule produces a
 * handful of big rooms in solid rock - that shape is simply not in the family of
 * things the rule generates.
 *
 * That was not a guess either: the first version of this module shipped the raw
 * threshold as its main knob at 0.46, and a world generated from it and played
 * came back described as a sponge - "rock reads as the exception rather than the
 * material the caves are cut into".
 *
 * So there are two more stages, and they are what make this a cave system rather
 * than a foam:
 *
 *  - **Selection.** Only the largest `caverns` chambers are kept; everything
 *    else is filled back in. Chamber count stops being an accident of where the
 *    threshold landed and becomes something the caller asked for.
 *  - **Connection.** Those chambers are linked by corridors along a minimum
 *    spanning tree of their centres, so the result is one explorable system
 *    instead of a scatter of sealed rooms. Corridors are carved through the same
 *    permission mask as everything else, so every guard below holds for them
 *    automatically - a corridor cannot reach the sky, the floor or the spawn
 *    pocket any more than a chamber can.
 *
 * ## The controls
 *
 * The raw threshold is still there as `fill`, and it is still a cliff, so it is
 * not what a person is meant to turn. The exposed pair is:
 *
 *   density   0..1, the share of carvable ground to empty. Solved for rather
 *             than set: the threshold that hits it is found by bisection over a
 *             fixed random field, so `density` responds the way a person expects
 *             - twice the number empties about twice the ground - while the
 *             cliff stays hidden behind it. 0.10 by default: caves you go
 *             looking for, in ground that is still ground.
 *   caverns   how many chambers that budget is spent on. The largest that many
 *             survive; 0 means keep every chamber that clears `minRegion`. This
 *             is the "fewer, larger" knob: the same density over 6 caverns gives
 *             big halls, over 40 gives a warren.
 *
 * Solving for `density` costs up to `solveSteps` extra rounds of the whole
 * pipeline - about 250-350 ms on an 800x400 map at the defaults, and it stops
 * early once it is close enough. Each trial measures the finished map, corridors
 * included, because solving against the chambers alone lies at the small end:
 * the corridors are a near-fixed cost, so a low density got 20% more ground than
 * it asked for. A caller who does not want to pay for the solve can pass `fill`
 * directly, and then none of it happens - which is also how the tests pin exact
 * shapes.
 *
 * The rest:
 *
 *   fill            the raw seed threshold. Setting it skips the solve entirely.
 *                   Documented, kept, and not recommended: see the cliff above.
 *   solveSteps      bisection rounds for `density`. Bounded.
 *   passes          smoothing rounds. 0 leaves the raw fill (which is what makes
 *                   the pattern tests countable by hand); past six or so the
 *                   shape stops changing. Capped, so a caller cannot ask for an
 *                   unbounded amount of work.
 *   birth, survive  how many of the eight neighbours must be cave for solid rock
 *                   to open up, and for an open cell to stay open. `survive` no
 *                   greater than `birth` also makes the rule monotone in its
 *                   input, which is what lets the `density` solve bisect.
 *   connect         carve the corridors. On by default; off gives the bare
 *                   chambers, which is occasionally what a test wants.
 *   corridorRadius  half-width of a corridor. 1 is three cells wide.
 *   roof            solid cells kept between the surface line and the highest
 *                   cave. At least 1 always, so a cave can never break the sky.
 *   floor           solid rows kept above the bottom edge. At least 1 always, so
 *                   the bottom border row is never carved - a world with a hole
 *                   in its floor drains everything that falls into it. The
 *                   default of 2 is the safety margin and nothing more: if the
 *                   shape pass laid a bedrock floor several rows thick and you
 *                   would rather caves did not reach up into it, this is the
 *                   knob, and it wants that thickness.
 *   minRegion       chambers smaller than this are filled back in, whatever
 *                   `caverns` says. A one-cell hole is not a cave, and shipping a
 *                   thousand of them would make the carved-cell count look
 *                   healthy while the map is unplayable.
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
 * One classification pass, then at most `solveSteps` trial rounds and one final
 * round. A round is `passes` smoothing passes, a labelling pass, the selection
 * sweep, the corridors and a second labelling pass - every one of those
 * O(width x height) with constant work per cell, and the count of them bounded
 * by the clamps on `solveSteps` and `passes`. The spanning tree is O(n^2) in the
 * chamber count, which `caverns` bounds. Every grid is allocated once up front
 * and reused across the rounds; nothing is allocated per pixel.
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
  density: 0.10,
  caverns: 12,
  solveSteps: 10,
  passes: 4,
  birth: 5,
  survive: 4,
  connect: true,
  corridorRadius: 1,
  roof: 8,
  floor: 2,
  minRegion: 24,
  spawnClearance: 4,
  spawnPocketWidth: 4,
  spawnPocketHeight: 9,
}

/** Smoothing is bounded: no caller gets to ask for an unbounded amount of work. */
const MAX_PASSES = 16

/** So is solving. Ten halvings already resolve the threshold to one part in 600. */
const MAX_SOLVE_STEPS = 24

/**
 * The bracket the `density` solve searches.
 *
 * Wide enough to hold the percolation threshold with room either side, narrow
 * enough that the bisection is not spending its first rounds on thresholds that
 * empty nothing or everything.
 */
const SOLVE_LO = 0.15
const SOLVE_HI = 0.80

/** Close enough, as a share of the carvable ground, to stop bisecting early. */
const SOLVE_TOLERANCE = 0.002

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
 *
 * `fill` is null unless the caller named one, and that null is what decides
 * whether the density solve runs at all.
 */
function options(params) {
  const p = params && typeof params === 'object' ? params : {}
  const named = Number(p.fill)
  return {
    fill: Number.isFinite(named) ? fraction(named, DEFAULTS.density) : null,
    density: fraction(p.density, DEFAULTS.density),
    caverns: whole(p.caverns, DEFAULTS.caverns, 0, 4096),
    solveSteps: whole(p.solveSteps, DEFAULTS.solveSteps, 0, MAX_SOLVE_STEPS),
    passes: whole(p.passes, DEFAULTS.passes, 0, MAX_PASSES),
    birth: whole(p.birth, DEFAULTS.birth, 0, 8),
    survive: whole(p.survive, DEFAULTS.survive, 0, 8),
    connect: p.connect === undefined ? DEFAULTS.connect : !!p.connect,
    corridorRadius: whole(p.corridorRadius, DEFAULTS.corridorRadius, 0, 64),
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
 * being sliced off there with a straight edge. It is also the single permission
 * mask the corridors are carved through, so the guards need stating once and
 * hold for every stage.
 */
function carvable(buf, profile, p, w, h, out) {
  const d = buf.data
  const cache = new Map()
  let count = 0

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
      if (solid) {
        out[idx] = 1
        count++
      }
    }
  }
  return count
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
 * Threshold the random field at `fill` and smooth it. Returns the live grid.
 *
 * The field is drawn once, before any of this, and every trial re-thresholds
 * that same field rather than drawing again. Two reasons, and both matter: the
 * generator is consumed exactly once per carvable cell however many trials the
 * solve runs, and raising the threshold can then only ever *add* seed cells,
 * which is what makes the carved total monotone in `fill` and the bisection
 * sound.
 *
 * `s.a` and `s.b` swap as the passes alternate; both stay owned by `s` so no
 * trial allocates.
 */
function fillAndSmooth(s, fill) {
  const w = s.w
  const h = s.h
  let cur = s.a
  let nxt = s.b
  const open = s.open
  const field = s.field
  for (let idx = 0; idx < cur.length; idx++) {
    cur[idx] = open[idx] && field[idx] < fill ? 1 : 0
  }
  for (let pass = 0; pass < s.p.passes; pass++) {
    for (let y = 0; y < h; y++) {
      const base = y * w
      for (let x = 0; x < w; x++) {
        const idx = base + x
        if (!open[idx]) { nxt[idx] = 0; continue }
        const n = neighbours(cur, w, h, x, y)
        nxt[idx] = (cur[idx] ? n >= s.p.survive : n >= s.p.birth) ? 1 : 0
      }
    }
    const swap = cur
    cur = nxt
    nxt = swap
  }
  s.a = cur
  s.b = nxt
  return cur
}

/**
 * Label every connected cavern in `cave`, 4-connected, and return their sizes.
 *
 * 4-connected because that is how the game's own flood fills travel, which is
 * what stops paint - and fog - leaking through the corner of a one-cell wall.
 * An explicit index stack, never recursion: one cavern can reach most of a map,
 * and the recursive form would blow the JavaScript stack on the author's
 * machine, not here.
 */
function labelRegions(cave, label, stack, w, sizes) {
  label.fill(0)
  sizes.length = 0
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
  return sizes
}

/**
 * The region ids that survive selection, largest first.
 *
 * Ties break on the lower id, which is the earlier cell in reading order, so
 * two equally sized chambers are always chosen in the same order for the same
 * seed. `caverns` of 0 means no cap.
 */
function survivors(sizes, p) {
  const kept = []
  for (let i = 0; i < sizes.length; i++) {
    if (sizes[i] >= p.minRegion) kept.push(i + 1)
  }
  kept.sort((a, b) => (sizes[b - 1] - sizes[a - 1]) || (a - b))
  if (p.caverns > 0 && kept.length > p.caverns) kept.length = p.caverns
  return kept
}

/**
 * The seed threshold that empties about `density` of the carvable ground.
 *
 * Bisection, not a formula: the relationship between threshold and carved
 * fraction depends on the smoothing rule, the map's shape and the field itself,
 * and it is a cliff. Bisecting a monotone function is the honest way to invert
 * something nobody can write down, and it is what turns a hostile parameter into
 * one whose response a person can predict.
 *
 * Each trial runs the *whole* pipeline, corridors included, and measures the
 * finished map. Solving against the chambers alone was tried first and it lies
 * at the small end: the corridors are a near-fixed cost, so at a low density
 * they were 20% of the result that nobody had asked for, and 0.05 delivered
 * 1.67 times as much ground as 0.10 rather than half.
 */
function solveFill(s, target) {
  let lo = SOLVE_LO
  let hi = SOLVE_HI
  let bestFill = (lo + hi) / 2
  let bestErr = Infinity
  const tolerance = SOLVE_TOLERANCE * s.openCount
  for (let step = 0; step < s.p.solveSteps; step++) {
    const mid = (lo + hi) / 2
    const got = round(s, mid).carved
    const err = Math.abs(got - target)
    if (err < bestErr) { bestErr = err; bestFill = mid }
    if (err <= tolerance) break
    if (got < target) lo = mid
    else hi = mid
  }
  return bestFill
}

/**
 * A corridor from (ax, ay) to (bx, by), `r` cells either side of the line.
 *
 * Bresenham, and straight: an L-shaped corridor with a right-angled elbow reads
 * as architecture, and a wandering one costs random draws that would have to
 * come from somewhere. A straight run between two chamber centres reads as a
 * fissure, which is the thing a cave system actually has.
 *
 * Every cell is filtered through `open`, so a corridor obeys the roof, the
 * floor, the spawn keep-out and the "solid only" rule without restating any of
 * them. Where non-carvable ground crosses its path the corridor simply stops
 * being carved there, and the final labelling pass reports the connection it
 * failed to make rather than claiming it.
 */
function corridor(cave, open, w, h, ax, ay, bx, by, r) {
  let x = ax
  let y = ay
  const dx = Math.abs(bx - ax)
  const sx = ax < bx ? 1 : -1
  const dy = -Math.abs(by - ay)
  const sy = ay < by ? 1 : -1
  let err = dx + dy
  for (;;) {
    for (let oy = -r; oy <= r; oy++) {
      const ny = y + oy
      if (ny < 0 || ny >= h) continue
      const base = ny * w
      for (let ox = -r; ox <= r; ox++) {
        const nx = x + ox
        if (nx < 0 || nx >= w) continue
        const idx = base + nx
        if (open[idx]) cave[idx] = 1
      }
    }
    if (x === bx && y === by) break
    const e2 = 2 * err
    if (e2 >= dy) { err += dy; x += sx }
    if (e2 <= dx) { err += dx; y += sy }
  }
}

/**
 * Link the kept chambers into one system.
 *
 * A minimum spanning tree over the chamber centres by Prim's, so every chamber
 * is reachable and the corridors are the shortest set that does it - no ring
 * roads, no chamber left out, and no corridor longer than it has to be. O(n^2)
 * in the chamber count, which `caverns` bounds.
 *
 * Each chamber's endpoint is the cell of its own that sits nearest its centroid,
 * not the centroid itself: the centroid of a crescent is outside it, and a
 * corridor starting there would begin with a pointless stub through rock.
 */
function connectChambers(s, kept) {
  const n = kept.length
  if (n < 2) return
  const w = s.w
  const h = s.h
  const cave = s.a
  const label = s.label

  // Where each kept chamber is, by id. `slot` maps a label id to its index here.
  const slot = new Int32Array(s.sizes.length + 1).fill(-1)
  for (let i = 0; i < n; i++) slot[kept[i]] = i
  const sumX = new Float64Array(n)
  const sumY = new Float64Array(n)
  const count = new Float64Array(n)
  for (let idx = 0; idx < cave.length; idx++) {
    const id = label[idx]
    if (!id) continue
    const i = slot[id]
    if (i < 0) continue
    sumX[i] += idx % w
    sumY[i] += (idx / w) | 0
    count[i]++
  }
  const repX = new Int32Array(n)
  const repY = new Int32Array(n)
  const bestD = new Float64Array(n).fill(Infinity)
  for (let idx = 0; idx < cave.length; idx++) {
    const id = label[idx]
    if (!id) continue
    const i = slot[id]
    if (i < 0) continue
    const x = idx % w
    const y = (idx / w) | 0
    const ddx = x - sumX[i] / count[i]
    const ddy = y - sumY[i] / count[i]
    const d = ddx * ddx + ddy * ddy
    if (d < bestD[i]) { bestD[i] = d; repX[i] = x; repY[i] = y }
  }

  const inTree = new Uint8Array(n)
  const near = new Float64Array(n).fill(Infinity)
  const from = new Int32Array(n).fill(-1)
  near[0] = 0
  for (let k = 0; k < n; k++) {
    let u = -1
    let ud = Infinity
    for (let i = 0; i < n; i++) {
      if (!inTree[i] && near[i] < ud) { ud = near[i]; u = i }
    }
    if (u < 0) break
    inTree[u] = 1
    if (from[u] >= 0) {
      corridor(cave, s.open, w, h, repX[from[u]], repY[from[u]], repX[u], repY[u],
        s.p.corridorRadius)
    }
    for (let i = 0; i < n; i++) {
      if (inTree[i]) continue
      const ddx = repX[i] - repX[u]
      const ddy = repY[i] - repY[u]
      const d = ddx * ddx + ddy * ddy
      if (d < near[i]) { near[i] = d; from[i] = u }
    }
  }
}

/**
 * One complete pass at a given threshold: chambers, selection, corridors, count.
 *
 * Leaves `s.a` holding the finished cave grid and `s.label` / `s.sizes` labelling
 * it, so the caller can either read the numbers back (a solve trial) or go on to
 * write the pixels (the real run). The whole pipeline lives here rather than
 * being spelt once for the trials and again for the final run - two copies of a
 * pipeline is two pipelines, and the solve would eventually be measuring
 * something the map no longer does.
 */
function round(s, fill) {
  const p = s.p
  const cave = fillAndSmooth(s, fill)
  let sizes = labelRegions(cave, s.label, s.stack, s.w, s.sizes)

  // Selection: keep the largest `caverns` chambers, fill the rest back in.
  const kept = survivors(sizes, p)
  if (kept.length === 0) {
    cave.fill(0)
    s.label.fill(0)
    s.sizes.length = 0
    return { carved: 0, largest: 0, regions: 0 }
  }
  const isKept = new Uint8Array(sizes.length + 1)
  for (const id of kept) isKept[id] = 1
  for (let idx = 0; idx < cave.length; idx++) {
    if (cave[idx] && !isKept[s.label[idx]]) cave[idx] = 0
  }

  // Connection: one system rather than a scatter of sealed rooms.
  if (p.connect) connectChambers(s, kept)

  // The corridors have moved the answer, so the numbers come from the finished
  // shape and never from the shape before them.
  sizes = labelRegions(cave, s.label, s.stack, s.w, s.sizes)
  let carved = 0
  let largest = 0
  let regions = 0
  for (let i = 0; i < sizes.length; i++) {
    if (sizes[i] < p.minRegion) continue
    regions++
    carved += sizes[i]
    if (sizes[i] > largest) largest = sizes[i]
  }
  return { carved: carved, largest: largest, regions: regions }
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
 *   per carvable cell, row-major from the top-left, and exactly once however
 *   many rounds the density solve runs, so the same seed and the same inputs
 *   always give the same map. `Math.random` is never called here.
 * @returns {{carved: number, largest: number, regions: number}} cells emptied,
 *   the size of the biggest connected cavern, and how many caverns there are -
 *   counted on the finished map, after selection and after the corridors, so
 *   they describe what the player will actually find.
 */
function carve(buf, profile, params, rng) {
  const nothing = { carved: 0, largest: 0, regions: 0 }
  if (!bufferOk(buf)) return nothing
  if (typeof rng !== 'function') return nothing

  const w = Math.floor(buf.width)
  const h = Math.floor(buf.height)
  if (!profile || typeof profile.length !== 'number' || profile.length < w) return nothing

  const p = options(params)
  const cells = w * h
  const s = {
    w: w,
    h: h,
    p: p,
    open: new Uint8Array(cells),
    field: new Float32Array(cells),
    a: new Uint8Array(cells),
    b: new Uint8Array(cells),
    label: new Int32Array(cells),
    stack: new Int32Array(cells),
    sizes: [],
    openCount: 0,
  }
  s.openCount = carvable(buf, profile, p, w, h, s.open)
  if (s.openCount === 0) return nothing

  // The field is drawn once, here, and every later stage re-reads it. This is
  // the only place the caller's generator is touched.
  for (let idx = 0; idx < cells; idx++) {
    if (s.open[idx]) s.field[idx] = rng()
  }

  const fill = p.fill !== null ? p.fill : solveFill(s, p.density * s.openCount)
  const stats = round(s, fill)
  if (stats.carved === 0) return nothing

  // Every carvable cell held a solid colour, so every one of these is a real
  // change, and `carved` is both cells emptied and pixels written.
  const sizes = s.sizes
  const d = buf.data
  for (let idx = 0; idx < cells; idx++) {
    const id = s.label[idx]
    if (!id || sizes[id - 1] < p.minRegion) continue
    const i = idx * 4
    d[i] = AIR_R
    d[i + 1] = AIR_G
    d[i + 2] = AIR_B
    d[i + 3] = 255
  }

  return stats
}

module.exports = { carve }
