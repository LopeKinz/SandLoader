'use strict'
/**
 * Ore placement: scattering something worth mining through generated ground.
 *
 * This is the third stage of the map generator. Something else has already
 * drawn the landscape and carved the caves; this module walks the solid ground
 * that survived and replaces runs of it with materials the player gets paid
 * for. It never draws ground of its own, never opens a hole, and never touches
 * a cell that is not already solid.
 *
 * **The one judgement that matters here is which colours count as ore**, and it
 * is not a cosmetic choice. The blueprint format has roughly thirty solid
 * colours and most of them are not rewards. Six are flatly indestructible - no
 * tool in the game removes bedrock, deepstone, blackrock, sandstone, limestone
 * or ice. Three erase themselves the moment they are disturbed. One, Solidite,
 * mines in a single hit and drops nothing at all. A generator that treats those
 * as "ore" fills a map with purple and gold that reads as riches from across
 * the screen and pays out nothing when the player walks over and digs. That
 * failure is invisible in a screenshot and obvious after ten minutes of play,
 * which is the worst possible place for it to surface, so `placeable()` states
 * the whole ruling - what is in, what is out, and one sentence of why for every
 * single exclusion.
 *
 * Every fact about a material - hit points, tool gate, what it drops, whether
 * it stays put - comes from `terrain-palette.js` and, behind it,
 * `.superpowers/sdd/terrain-palette-investigation.md`, which was read out of
 * the shipped 0.5.6 bundle. No colour triple is written down here except in the
 * ORE table's keys, and each of those is looked up in the palette at load time
 * so a typo is a startup failure rather than a silently dead material.
 *
 * **Honesty about what is unverified.** Nobody has mined a vein this module
 * produced. The game has not been run against its output. The depth bands and
 * densities below are *judgement*, argued from measured hit points and tool
 * gates but not measured themselves, and the comment on the ORE table says so
 * plainly rather than dressing an opinion up as data.
 *
 * Pure and DOM-free: give it a buffer and a seeded generator and it will hand
 * back the same map every time.
 *
 * @module mapgen-ore
 */

const palette = require('./terrain-palette.js')

// The spawn formula is fixed, unconditional and easy to get subtly wrong - the
// horizontal offset is not a whole number of cells. It is stated exactly once
// in the repository, in the validator, and this module reads it from there
// rather than keeping a second copy that could drift. That is a deliberate
// reach across from `src/game` into `src/renderer`; `mapeditor-validate.js` is
// itself DOM-free and node-loadable, so it costs this module nothing.
const { spawnCell } = require('../renderer/mapeditor-validate.js')

/* ------------------------------------------------------------------ *
 * What is worth scattering, and what only looks like it is.
 * ------------------------------------------------------------------ */

/**
 * The materials this module will place, with their default placement rules.
 *
 * Membership rule, applied to every solid colour in the palette: it is in this
 * table only if the player can remove it with a tool, it drops something when
 * they do, and it stays where it is put until they do. All three, or it is out.
 *
 * **`depth` is a fraction of the ground column, not a row number.** `[0.1,
 * 0.6]` means "between one tenth and six tenths of the way from this column's
 * surface down to the bottom of the map", so a band means the same thing under
 * a mountain as it does under a valley. `density` is veins per 100,000 cells of
 * map area, so the same defaults give a sensible map at 480x400 and at
 * 3840x2160 without the caller retuning anything. `size` is the vein's target
 * cell count, drawn uniformly from the range.
 *
 * **On what basis were these numbers chosen - and this is the paragraph to read
 * sceptically.** The *ordering* is argued from measured data: the palette
 * records each material's hit points and tool requirement, read out of the
 * shipped bundle, and this table sorts by that effort. Dune sand is hp 1 and
 * sits at the top; Fluxite is hp 3 and the game's staple, so it gets the widest
 * band and the highest density; Sandium is hp 20, Copper needs a drill, Crystal
 * is hp 40 - those three sink to the bottom. "More work to mine, so put it
 * deeper and make it rarer" is a genre convention, and matching the game's own
 * effort curve is the most defensible reading of it available without playing.
 *
 * The *magnitudes* - 0.22 rather than 0.25, density 22 rather than 15 - are
 * intuition. Nobody has played a map made from these numbers, no reference
 * Sandustry world was measured to calibrate them, and there is no claim here
 * that a generated map's ore economy resembles the shipped one. They are a
 * starting point that should look reasonable and be retuned by whoever first
 * plays the output; every one of them is overridable through `params`.
 *
 * @type {{hex:string, tool:string, why:string, depth:[number,number],
 *   density:number, size:[number,number]}[]}
 */
const ORE = [
  {
    hex: '#f0d25a', tool: 'shovel',
    why: 'hp 1 and shovel-diggable, drops sunsand - the softest thing worth digging, so it belongs where the player digs first.',
    depth: [0.00, 0.22], density: 12, size: [12, 34],
  },
  {
    hex: '#ffff00', tool: 'shovel',
    why: 'hp 4, shovel, 50% chance of a Seed - cheap, so shallow.',
    depth: [0.04, 0.30], density: 10, size: [8, 22],
  },
  {
    hex: '#af00e0', tool: 'shovel',
    why: 'hp 3, shovel, and the one material the game keeps its own counter for - the staple, so the widest band and the highest density of anything here.',
    depth: [0.08, 0.60], density: 22, size: [6, 18],
  },
  {
    hex: '#ccffff', tool: 'shovel',
    why: 'hp 1, shovel, drops FreezingIce - soft, but a specialised drop, so mid-depth rather than at the top.',
    depth: [0.30, 0.70], density: 7, size: [8, 20],
  },
  {
    hex: '#ff5500', tool: 'shovel',
    why: 'hp 20, drops Sandium - the toughest thing the starting shovel can still get through, so it sits below the easy layers.',
    depth: [0.45, 0.85], density: 8, size: [6, 16],
  },
  {
    hex: '#ffa500', tool: 'drill',
    why: 'hp 12 and an ore in the game\'s own terms, but gated behind a drill, so it is placed deep - deep enough that a player who can reach it comfortably is a player who has one.',
    depth: [0.55, 0.95], density: 7, size: [6, 16],
  },
  {
    hex: '#0094b3', tool: 'shovel',
    why: 'hp 40 - ten times the work of dirt, and the longest dig in the palette that the shovel can still finish, so the rarest and the deepest.',
    depth: [0.70, 1.00], density: 4, size: [4, 12],
  },
]

/**
 * Why each colour this module will not scatter is not scattered.
 *
 * Keyed by hex, one sentence each, in the words a mapmaker would use. Colours
 * that resolve to the same material as one of these share its label and are
 * folded into the same row, exactly as the palette's own `paintable()` folds
 * them, so nobody is asked to read the same exclusion twice.
 */
const EXCLUDED = {
  // Un-minable: no tool in the game ever removes these.
  '#66ccff': 'un-minable - no excavation touches it; only a flamethrower melt removes it, so a vein of it is a permanent obstruction.',
  '#f5e7a3': 'un-minable - flagged indestructible, so every tool does exactly zero damage to it.',
  '#ffde00': 'un-minable - flagged indestructible, so every tool does exactly zero damage to it.',
  '#222222': 'un-minable - indestructible by design; it is the right material for a map floor and the wrong one for anything the player is meant to get through.',
  '#181c20': 'un-minable - flagged indestructible, so no tool removes it.',
  '#ff1414': 'un-minable - flagged indestructible, so no tool removes it.',
  '#19e680': 'un-minable - it has no hit points at all, so excavation skips it, and it is flagged as a building so the player is blocked by it unless hovering.',
  '#4a40b0': 'un-minable - no hit points, so no tool removes it, however much it looks like a gemstone deposit.',

  // Minable in principle, but not with anything a player has when they meet it.
  '#aaaaaa': 'needs a drill, and it is bulk rock rather than a deposit - hp 8 with nothing at the end of it, so a vein of it is a wall, not a reward.',
  '#cd8b8b': 'needs dynamite - only a rocket-launcher blast removes it, which is not a tool an ore vein should assume.',
  '#b6bcc1': 'needs the gun - the shovel does nothing to it at all.',

  // Will not stay where it is put.
  '#3d1a5c': 'spreads on its own at runtime, so a vein of it will not be the shape it was generated as by the time anyone reaches it.',
  '#4a3728': 'chain-reacts - destroying one cell queues a dissolve of up to 800 neighbours, so mining it rearranges the map around the player.',
  '#8b7355': 'self-erasing - destroying one can fire a spore burst that excavates an eleven-cell circle, which is a hole in the map rather than a drop.',

  // Mines fine and pays nothing, or is not ground at all.
  '#de9d10': 'mines in one hit and drops nothing - its output chance is zero, which makes it the exact "looks rich, gives nothing" trap this module exists to avoid.',
  '#339999': 'flagged as a building, so the player phases through it while hovering - it is scenery, not ground, and it is flammable.',
  '#000000': 'this is the ground itself, the fill the previous stage laid down - there is nothing to scatter it through.',
  '#00ff00': 'surface plant matter, not a deposit - it belongs on top of the ground, which is the landscape stage\'s job, not this one\'s.',
  '#00e000': 'surface plant matter and flammable, with nothing at the end of digging it.',
  '#006600': 'hp 1 and it burns away almost instantly if anything ignites it; it is a partition, not a deposit.',
  '#1dae1d': 'a plant - hp 1, flammable, and no drop that a factory uses.',

  // Refused outright.
  '#f0dc78': 'broken - its palette entry has no foreground value, so the loader throws and the map never opens at all. Never write it anywhere.',
}

/** Reasons for whole classes of colour that are not solid ground. */
const KIND_EXCLUSIONS = {
  empty: 'not solid ground - it is open air, or a sealed fog pocket that dissolves to open air the moment anything digs it. Scattering it would punch holes in the map.',
  fluid: 'not solid ground - it becomes a live element, or a sealed pocket that reveals one. Nothing collides with the result and there is nothing to mine.',
  broken: 'broken - the loader refuses this colour and the map never opens.',
}

/** hex -> ORE row, with the palette entry resolved once at load. */
const ORE_BY_HEX = new Map()
for (const row of ORE) {
  const entry = palette.byHex(row.hex)
  // A typo in the table above should fail at require time, not silently drop a
  // material and leave a thin map that nobody can explain.
  if (!entry) throw new Error('mapgen-ore: ' + row.hex + ' is not a colour the palette knows')
  if (entry.kind !== 'solid') throw new Error('mapgen-ore: ' + row.hex + ' is not solid ground')
  ORE_BY_HEX.set(row.hex, { row, entry })
}

/** r,g,b packed into one integer, for set membership at pixel speed. */
function pack(r, g, b) { return (r * 65536) + (g * 256) + b }

/** Every solid colour in the palette - the cells this module may replace. */
const SOLID_RGB = new Set()
for (const e of palette.TERRAIN) {
  if (e.kind === 'solid') SOLID_RGB.add(pack(e.rgb[0], e.rgb[1], e.rgb[2]))
}

/** The ore colours themselves - never overwritten, so counts stay exact. */
const ORE_RGB = new Set()
for (const { entry } of ORE_BY_HEX.values()) {
  ORE_RGB.add(pack(entry.rgb[0], entry.rgb[1], entry.rgb[2]))
}

/**
 * Solid colours this module refuses to *replace*, as against refusing to write.
 *
 * All eight are indestructible - no tool in the game removes them - which is
 * exactly why an author reaches for them: a bedrock floor, a blackrock border,
 * a limestone shell around something. Dropping a fluxite vein into a bedrock
 * floor does not enrich the map, it puts a mineable hole in a barrier that was
 * placed to be permanent. So "only replace solid ground" is read here as "only
 * replace ground the player could have dug anyway".
 *
 * Every hex is checked against the palette at load, so a typo is a startup
 * failure rather than a guard that silently stops guarding.
 */
const PROTECTED_HEX = [
  '#222222', // Bedrock - the canonical map floor and border
  '#181c20', // Deepstone
  '#ff1414', '#141414', // Blackrock, both of its colours
  '#f5e7a3', // Sandstone
  '#ffde00', '#fedc00', // Limestone, both of its colours
  '#66ccff', // Ice
  '#19e680', // Glass
  '#4a40b0', // Auralite crystal
]
const PROTECTED_RGB = new Set()
for (const hex of PROTECTED_HEX) {
  const e = palette.byHex(hex)
  if (!e) throw new Error('mapgen-ore: protected colour ' + hex + ' is not in the palette')
  PROTECTED_RGB.add(pack(e.rgb[0], e.rgb[1], e.rgb[2]))
}

/**
 * What this module will and will not scatter, and why not.
 *
 * Every distinct material in the palette appears in exactly one of the two
 * lists - there is no third bucket of colours quietly skipped without comment.
 * Colours that resolve to the same material are folded together, the way the
 * palette's own picker folds them, so "Dune sand" is ruled on once rather than
 * twice.
 *
 * `allowed` entries carry the palette row's own label and note plus an `ore`
 * block holding this module's defaults for that material, which is also how a
 * caller discovers what `params` can override.
 *
 * @returns {{allowed: object[], excluded: {hex:string, label:string, kind:string, reason:string}[]}}
 */
function placeable() {
  const allowed = []
  const excluded = []
  const seen = new Set()

  for (const e of palette.TERRAIN) {
    if (seen.has(e.label)) continue
    seen.add(e.label)

    const hit = ORE_BY_HEX.get(e.hex)
    if (hit) {
      allowed.push({
        hex: e.hex,
        rgb: e.rgb.slice(),
        kind: e.kind,
        label: e.label,
        note: e.note,
        cellType: e.cellType,
        ore: {
          tool: hit.row.tool,
          why: hit.row.why,
          depth: { from: hit.row.depth[0], to: hit.row.depth[1] },
          density: hit.row.density,
          size: { min: hit.row.size[0], max: hit.row.size[1] },
        },
      })
      continue
    }

    excluded.push({
      hex: e.hex,
      label: e.label,
      kind: e.kind,
      reason: EXCLUDED[e.hex] || KIND_EXCLUSIONS[e.kind] ||
        'not a material this module scatters.',
    })
  }

  return { allowed, excluded }
}

/* ------------------------------------------------------------------ *
 * Parameters.
 * ------------------------------------------------------------------ */

/** Rows below a column's surface that are never written, whatever the band. */
const DEFAULT_SURFACE_MARGIN = 1

/** A vein shorter than this is confetti; it is rolled back rather than kept. */
const DEFAULT_MIN_RUN = 3

/** Seed placements tried per vein before giving that vein up. */
const DEFAULT_ATTEMPTS = 24

/**
 * The spawn pocket, in cells, anchored at `spawnCell(width)`.
 *
 * The validator tells authors to clear "about 4 cells across and 9 down" at the
 * spawn, which is the player's 12x30 world-pixel box plus slack. It keeps those
 * two numbers private, so they are restated here rather than imported - but the
 * *position* is never restated, because that is the part with a fractional
 * offset in it and the part that would actually drift. The two cells of padding
 * are this module's own caution: an ore vein one cell from the player's head is
 * not worth the risk of a spawn that opens inside rock.
 */
const DEFAULT_POCKET = { width: 4, height: 9, pad: 2 }

/** Read a `[a,b]` or `{min,max}`/`{from,to}` pair, falling back cleanly. */
function pair(value, keyA, keyB, fallback) {
  if (Array.isArray(value) && value.length >= 2) {
    const a = Number(value[0]), b = Number(value[1])
    if (Number.isFinite(a) && Number.isFinite(b)) return [a, b]
  }
  if (value && typeof value === 'object') {
    const a = Number(value[keyA]), b = Number(value[keyB])
    if (Number.isFinite(a) && Number.isFinite(b)) return [a, b]
  }
  return fallback
}

function num(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v) }

/**
 * Turn the caller's `params` into a fixed, ordered plan.
 *
 * Ordered, because the plan is walked in array order and every draw comes off
 * the caller's generator in that order - which is the whole of what makes the
 * same seed give the same map.
 */
function plan(params, width, height) {
  const p = params && typeof params === 'object' ? params : {}
  const overrides = p.materials && typeof p.materials === 'object' ? p.materials : {}
  const only = Array.isArray(p.only) ? new Set(p.only.map((h) => String(h).toLowerCase())) : null
  const area = width * height

  const globalSize = p.veinSize != null ? pair(p.veinSize, 'min', 'max', null) : null
  const out = []

  for (const row of ORE) {
    if (only && !only.has(row.hex)) continue
    const o = overrides[row.hex] && typeof overrides[row.hex] === 'object' ? overrides[row.hex] : {}
    if (o.skip === true) continue

    const size = pair(o.size, 'min', 'max', globalSize || row.size)
    const min = Math.max(1, Math.round(size[0]))
    const max = Math.max(min, Math.round(size[1]))

    const depth = pair(o.depth, 'from', 'to', row.depth)
    const from = clamp(depth[0], 0, 1)
    const to = clamp(depth[1], from, 1)

    // Absolute count wins; otherwise a density, in veins per 100,000 cells of
    // map area, so one set of defaults suits every map size.
    let count
    if (o.count != null) count = Math.max(0, Math.round(num(o.count, 0)))
    else if (p.veinCount != null) count = Math.max(0, Math.round(num(p.veinCount, 0)))
    else {
      const density = num(o.density, num(p.veinDensity, row.density))
      count = Math.max(0, Math.round(density * area / 100000))
    }

    const entry = ORE_BY_HEX.get(row.hex).entry
    out.push({
      hex: row.hex,
      r: entry.rgb[0], g: entry.rgb[1], b: entry.rgb[2],
      from, to, count, min, max,
    })
  }

  return out
}

/* ------------------------------------------------------------------ *
 * Placement.
 * ------------------------------------------------------------------ */

/**
 * Scatter ore veins through the solid ground of `buf`, in place.
 *
 * What it will never do, in the order the failures would hurt:
 *
 *  - **Write anything that is not fully opaque.** Alpha 0 decodes to Fog, and
 *    a "vein" of fog is a hole waiting to happen.
 *  - **Write a colour that is not ore.** The only colours written are the ones
 *    `placeable().allowed` lists, so Fog and the broken colour cannot appear
 *    however the caller configures it.
 *  - **Overwrite anything that is not solid ground.** Air, caves, water, fog
 *    and existing ore are all read before writing and left alone, so a cave the
 *    previous stage carved stays carved. Indestructible material - a bedrock
 *    floor, a blackrock border - is left alone too: see `PROTECTED_HEX`.
 *  - **Write above the surface.** Nothing lands at or above `profile[x]`.
 *  - **Touch the spawn pocket.**
 *  - **Call `Math.random`.** Every draw comes from `rng`, in a fixed order.
 *
 * A vein is grown, not stamped: a seed cell is chosen inside the material's
 * depth band and the blob spreads to random four-connected neighbours until it
 * reaches its target size or runs out of eligible ground. Every cell added
 * touches a cell already added, so a vein is always one connected run. A vein
 * that cannot reach `minRun` cells - because it seeded against a cave wall, say
 * - is rolled back to the pixels that were there before rather than left as a
 * one-pixel speck.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} buf RGBA,
 *   row-major, one pixel per world cell, y=0 at the top. Mutated.
 * @param {Int32Array|number[]} profile surface row per column, length >= width.
 * @param {object} [params] see `placeable()` for the per-material defaults.
 *   `materials[hex] = {count|density, size, depth, skip}` overrides one
 *   material; `only` restricts the run to a list of hexes; `veinSize`,
 *   `veinCount` and `veinDensity` override every material at once;
 *   `surfaceMargin`, `minRun`, `attempts` and `spawnPocket` tune the guards.
 * @param {() => number} rng seeded generator returning [0,1).
 * @returns {{placed: Object<string, number>, veins: {hex:string, x:number,
 *   y:number, cells:number}[]}} `placed` counts cells written per colour;
 *   `veins` is one record per vein that survived, seed cell and final size.
 */
function scatter(buf, profile, params, rng) {
  if (!buf || typeof buf !== 'object' || !buf.data ||
      !Number.isFinite(buf.width) || !Number.isFinite(buf.height)) {
    throw new TypeError('mapgen-ore.scatter: buf must be {data, width, height}')
  }
  if (typeof rng !== 'function') {
    throw new TypeError('mapgen-ore.scatter: rng must be a seeded function returning [0,1)')
  }

  const width = buf.width | 0
  const height = buf.height | 0
  const data = buf.data
  const placed = {}
  const veins = []

  if (width <= 0 || height <= 0) return { placed, veins }
  if (data.length < width * height * 4) {
    throw new TypeError('mapgen-ore.scatter: buf.data is too short for ' + width + 'x' + height)
  }
  if (!profile || typeof profile.length !== 'number' || profile.length < width) {
    throw new TypeError('mapgen-ore.scatter: profile must hold one surface row per column')
  }

  const p = params && typeof params === 'object' ? params : {}
  const surfaceMargin = Math.max(0, Math.round(num(p.surfaceMargin, DEFAULT_SURFACE_MARGIN)))
  const minRun = Math.max(1, Math.round(num(p.minRun, DEFAULT_MIN_RUN)))
  const attempts = Math.max(1, Math.round(num(p.attempts, DEFAULT_ATTEMPTS)))

  const pocketOpt = p.spawnPocket && typeof p.spawnPocket === 'object' ? p.spawnPocket : {}
  const pocketW = Math.max(0, Math.round(num(pocketOpt.width, DEFAULT_POCKET.width)))
  const pocketH = Math.max(0, Math.round(num(pocketOpt.height, DEFAULT_POCKET.height)))
  const pocketPad = Math.max(0, Math.round(num(pocketOpt.pad, DEFAULT_POCKET.pad)))
  const spawn = spawnCell(width)
  const pocketX0 = spawn.x - pocketPad
  const pocketX1 = spawn.x + pocketW - 1 + pocketPad
  const pocketY0 = spawn.y - pocketPad
  const pocketY1 = spawn.y + pocketH - 1 + pocketPad

  const jobs = plan(p, width, height)
  if (jobs.length === 0) return { placed, veins }

  // The three scratch buffers, allocated once for the whole run. Nothing below
  // allocates per pixel, per cell or per vein.
  let maxSize = 1
  for (const job of jobs) if (job.max > maxSize) maxSize = job.max
  const frontier = new Int32Array(4 * maxSize + 8)
  const writtenCells = new Int32Array(maxSize)
  const writtenPixels = new Uint32Array(maxSize)

  // The first row of each column this module may write into: the surface plus
  // the margin, so the ground's own skin is left to the landscape stage.
  const groundTop = new Int32Array(width)
  for (let x = 0; x < width; x++) {
    const s = Number(profile[x])
    const row = Number.isFinite(s) ? Math.round(s) : 0
    groundTop[x] = clamp(row + surfaceMargin, 0, height)
  }

  // Refilled per material: the inclusive row range that material may occupy in
  // each column. Two arrays, reused, rather than a rectangle per vein.
  const bandTop = new Int32Array(width)
  const bandBot = new Int32Array(width)

  for (const job of jobs) {
    placed[job.hex] = placed[job.hex] || 0
    if (job.count === 0) continue

    for (let x = 0; x < width; x++) {
      const top = groundTop[x]
      const depth = height - top
      if (depth <= 0) { bandTop[x] = 1; bandBot[x] = 0; continue }
      const t = top + Math.floor(job.from * depth)
      const b = top + Math.ceil(job.to * depth) - 1
      bandTop[x] = clamp(t, top, height - 1)
      bandBot[x] = clamp(b, top - 1, height - 1)
    }

    for (let v = 0; v < job.count; v++) {
      // --- Find a seed. Bounded tries, so a map with no room simply places
      // --- fewer veins instead of spinning.
      let seed = -1
      let seedX = 0, seedY = 0
      for (let a = 0; a < attempts; a++) {
        const x = clamp(Math.floor(rng() * width), 0, width - 1)
        const lo = bandTop[x], hi = bandBot[x]
        if (hi < lo) continue
        const y = lo + Math.floor(rng() * (hi - lo + 1))
        if (y > hi) continue
        const cell = y * width + x
        if (eligible(x, y, cell)) { seed = cell; seedX = x; seedY = y; break }
      }
      if (seed < 0) continue

      // --- Grow. Target size is drawn once, up front, so the draw order does
      // --- not depend on how the blob happens to spread.
      const target = job.min + Math.floor(rng() * (job.max - job.min + 1))
      let n = 0
      let flen = 0
      frontier[flen++] = seed

      while (n < target && flen > 0) {
        let k = Math.floor(rng() * flen)
        if (k >= flen) k = flen - 1
        const cell = frontier[k]
        frontier[k] = frontier[--flen]

        const x = cell % width
        const y = (cell - x) / width
        if (!eligible(x, y, cell)) continue

        const i = cell * 4
        writtenCells[n] = cell
        writtenPixels[n] = (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) |
          (data[i + 3] << 24)) >>> 0
        data[i] = job.r
        data[i + 1] = job.g
        data[i + 2] = job.b
        data[i + 3] = 255
        n++

        // Four-connected: every cell added neighbours one already added, which
        // is what makes the vein a single connected run. A cell can be queued
        // by up to four written neighbours; the eligibility re-check on pop
        // discards the repeats, so no visited set is needed.
        if (x > 0 && flen < frontier.length) frontier[flen++] = cell - 1
        if (x + 1 < width && flen < frontier.length) frontier[flen++] = cell + 1
        if (y > 0 && flen < frontier.length) frontier[flen++] = cell - width
        if (y + 1 < height && flen < frontier.length) frontier[flen++] = cell + width
      }

      if (n < minRun) {
        // Confetti. Put the ground back exactly as it was.
        for (let j = 0; j < n; j++) {
          const i = writtenCells[j] * 4
          const px = writtenPixels[j]
          data[i] = px & 255
          data[i + 1] = (px >>> 8) & 255
          data[i + 2] = (px >>> 16) & 255
          data[i + 3] = (px >>> 24) & 255
        }
        continue
      }

      placed[job.hex] += n
      veins.push({ hex: job.hex, x: seedX, y: seedY, cells: n })
    }
  }

  return { placed, veins }

  /**
   * May this cell become ore? Every guard the contract promises lives here, so
   * seeding and growth cannot disagree about what is safe to write.
   */
  function eligible(x, y, cell) {
    // The band is what keeps this off the surface: `bandTop` is never allowed
    // below `groundTop`, which is the column's surface row plus the margin, so
    // one comparison enforces both the depth rule and the surface rule.
    if (y < bandTop[x] || y > bandBot[x]) return false
    if (x >= pocketX0 && x <= pocketX1 && y >= pocketY0 && y <= pocketY1) return false
    const i = cell * 4
    if (data[i + 3] !== 255) return false        // not solid: translucent decodes to fog
    const here = pack(data[i], data[i + 1], data[i + 2])
    if (!SOLID_RGB.has(here)) return false       // air, cave, water, fog: leave it
    if (PROTECTED_RGB.has(here)) return false    // a bedrock floor stays a floor
    // Ore already in the buffer - this vein's own cells, an earlier vein's, or
    // a deposit the caller supplied - is never recycled, which is what keeps
    // the returned counts equal to what is actually on the map.
    if (ORE_RGB.has(here)) return false
    return true
  }
}

module.exports = { placeable, scatter }
