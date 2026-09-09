'use strict'
/**
 * The one place the four generator modules are put together.
 *
 * Each of the four was built to its own brief, and their vocabularies do not
 * match. That is this file's fault, not theirs: the interfaces were specified
 * in four separate briefs with no single source, so `mapgen-params.js` names a
 * knob for its effect (`caveDensity`, `minCaveSize`) while `mapgen-caves.js`
 * names the same knob for its mechanism (`density`, `minRegion`).
 *
 * Renaming inside the modules was the alternative and was rejected. Their tests
 * pin their own names, three of them are mutation-checked, and a rename would
 * churn all of that to move a mismatch rather than remove it. So the mismatch
 * lives here, once, written down and tested - and the names a person types stay
 * the ones that describe what they get.
 *
 * Order is not negotiable: shape lays the ground, caves hollow it, ore fills
 * what is left. Run ore before caves and the caves eat the veins.
 */

const params = require('./mapgen-params')
const shape = require('./mapgen-shape')
const caves = require('./mapgen-caves')
const ore = require('./mapgen-ore')

/**
 * How a user-facing name reaches the module that acts on it.
 *
 * Exported so a test can assert the translation rather than trusting it, and so
 * the next person to add a knob can see what already exists. `null` on the
 * right means the module has no counterpart: those are listed rather than
 * silently dropped, because a parameter that quietly does nothing is worse than
 * one that is missing.
 */
const MAPPING = {
  shape: {
    surfaceAmplitude: 'amplitude',
    surfaceRoughness: 'roughness',
    surfaceWavelength: 'featureWidth',
    topsoilDepth: 'topsoilDepth',
    floorThickness: 'floorDepth',
    // surfaceLevel is a fraction of the map's height; surfaceY is a row. The
    // conversion needs the height, so it is done in code, not by this table.
    surfaceLevel: 'surfaceY (computed from the map height)',
    // No counterpart today: mapgen-shape lays topsoil, then stone, then floor,
    // with no separately configurable hard layer, and paints from the palette
    // by role rather than from a colour it is handed.
    hardLayerDepth: null,
    borderThickness: null,
    skyMaterial: null,
    topsoilMaterial: null,
    stoneMaterial: null,
    hardLayerMaterial: null,
    floorMaterial: null,
    borderMaterial: null,
  },
  caves: {
    caveDensity: 'density',
    smoothingPasses: 'passes',
    minCaveSize: 'minRegion',
    minDepthBelowSurface: 'roof',
    minHeightAboveFloor: 'floor',
    connectCaves: 'connect',
    // A width the player walks through, halved into the radius the carver uses.
    tunnelWidth: 'corridorRadius (half, rounded up)',
    caveMaterial: null,
  },
  ore: {
    veinCount: 'veinCount',
    veinSize: 'veinSize ({min,max}, derived from the size and its variation)',
    veinSizeVariation: 'veinSize ({min,max}, with veinSize)',
    // An array of rows becomes an object keyed by colour. This is the one
    // difference a rename could never have closed.
    materials: 'materials (array of rows -> object keyed by hex)',
    keepInsideRock: null,
  },
}

function num(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** The shape stage's own vocabulary, from the user-facing one. */
function forShape(p, height) {
  const s = (p && p.shape) || {}
  const out = {}
  if (s.surfaceLevel != null) out.surfaceY = Math.round(num(s.surfaceLevel, 0.18) * height)
  if (s.surfaceAmplitude != null) out.amplitude = num(s.surfaceAmplitude, undefined)
  if (s.surfaceRoughness != null) out.roughness = num(s.surfaceRoughness, undefined)
  if (s.surfaceWavelength != null) out.featureWidth = num(s.surfaceWavelength, undefined)
  if (s.topsoilDepth != null) out.topsoilDepth = num(s.topsoilDepth, undefined)
  if (s.floorThickness != null) out.floorDepth = num(s.floorThickness, undefined)
  return out
}

/** The caves stage's own vocabulary. */
function forCaves(p, shapeParams) {
  const c = (p && p.caves) || {}
  const out = {}
  if (c.caveDensity != null) out.density = num(c.caveDensity, undefined)
  if (c.smoothingPasses != null) out.passes = num(c.smoothingPasses, undefined)
  if (c.minCaveSize != null) out.minRegion = num(c.minCaveSize, undefined)
  if (c.minDepthBelowSurface != null) out.roof = num(c.minDepthBelowSurface, undefined)
  if (c.connectCaves != null) out.connect = !!c.connectCaves
  if (c.tunnelWidth != null) out.corridorRadius = Math.max(1, Math.ceil(num(c.tunnelWidth, 2) / 2))

  // The floor the caves must not break through is the floor the shape stage
  // laid. Taking it from the shape parameters rather than from the caves ones
  // is what stops caves reaching into the permanent bottom: measured, at the
  // carver's own default of 2 against a 4-row floor, its top two rows were
  // carved away while the world still did not drain.
  const laid = shapeParams && shapeParams.floorDepth
  const asked = c.minHeightAboveFloor
  out.floor = Math.max(num(laid, 4), num(asked, 0))
  return out
}

/** The ore stage's own vocabulary: rows become an object keyed by colour. */
function forOre(p) {
  const o = (p && p.ore) || {}
  const out = {}
  if (o.veinCount != null) out.veinCount = num(o.veinCount, undefined)

  if (o.veinSize != null) {
    const mid = num(o.veinSize, 24)
    const spread = Math.max(0, Math.min(1, num(o.veinSizeVariation, 0.5)))
    out.veinSize = { min: Math.max(1, Math.round(mid * (1 - spread))), max: Math.round(mid * (1 + spread)) }
  }

  if (Array.isArray(o.materials) && o.materials.length) {
    const byHex = {}
    const only = []
    for (const row of o.materials) {
      const hex = String((row && row.colour) || '').toLowerCase()
      if (!hex) continue
      only.push(hex)
      const entry = {}
      if (row.fromDepth != null || row.toDepth != null) {
        entry.depth = { from: num(row.fromDepth, 0), to: num(row.toDepth, 1) }
      }
      if (row.veinSize != null) {
        const mid = num(row.veinSize, 24)
        entry.size = { min: Math.max(1, Math.round(mid * 0.5)), max: Math.round(mid * 1.5) }
      }
      // `share` is a proportion of the total vein budget; the ore module counts
      // veins per material, so it only means anything once there is a budget.
      if (row.share != null && o.veinCount != null) {
        entry.count = Math.max(0, Math.round(num(row.share, 0) * num(o.veinCount, 0)))
      }
      byHex[hex] = entry
    }
    // Naming materials is also choosing them: anything not listed is off.
    out.materials = byHex
    out.only = only
  }
  return out
}

/**
 * Generate a whole map.
 *
 * @param {number} width  cells
 * @param {number} height cells
 * @param {object} input  user-facing parameters, as `mapgen-params` describes
 * @returns {{ok:true, buf, profile, params, stats}|{ok:false, reason:string}}
 */
function generate(width, height, input) {
  if (!(width > 0) || !(height > 0)) {
    return { ok: false, reason: 'a map needs a width and a height in cells' }
  }

  const normalised = params.normalise(input || {})
  if (!normalised.ok) return normalised
  const p = normalised.params

  const seed = p.seed != null && p.seed !== '' ? p.seed : params.randomSeed()

  // One stream per stage, each seeded from the same seed but distinct, so that
  // changing the cave settings does not reshuffle the ore. A single shared
  // stream would make every knob move everything.
  const rngShape = params.rng(seed + ':shape')
  const rngCaves = params.rng(seed + ':caves')
  const rngOre = params.rng(seed + ':ore')

  const buf = { data: new Uint8ClampedArray(width * height * 4), width: width, height: height }

  const shapeParams = forShape(p, height)
  const profile = shape.surfaceProfile(width, shapeParams, rngShape)
  const ground = shape.applyGround(buf, profile, shapeParams)

  const caveParams = forCaves(p, shapeParams)
  const hollowed = caves.carve(buf, profile, caveParams, rngCaves)

  const oreParams = forOre(p)
  const scattered = ore.scatter(buf, profile, oreParams, rngOre)

  return {
    ok: true,
    buf: buf,
    profile: profile,
    params: p,
    seed: seed,
    stats: { ground: ground, caves: hollowed, ore: scattered },
  }
}

module.exports = { generate, MAPPING, forShape, forCaves, forOre }
