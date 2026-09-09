'use strict'
/**
 * The generator's four modules, run together.
 *
 * Each module has its own suite; this one exists because the failure that
 * actually happened lived between them. `caveDensity` meant a noise fill in one
 * module and a target carved fraction in another - same word, four times the
 * effect - and every module's own tests passed while the composed generator
 * hollowed out 41% of the ground.
 */
const assert = require('assert')
const gen = require('../src/game/mapgen')
const params = require('../src/game/mapgen-params')

let failures = 0
function check(name, fn) {
  try { fn(); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message) }
}

check('every user-facing knob reaches a module or is declared to reach none', () => {
  for (const stage of ['shape', 'caves', 'ore']) {
    const declared = Object.keys(gen.MAPPING[stage])
    for (const key of Object.keys(params.DEFAULTS[stage])) {
      assert(declared.indexOf(key) !== -1,
        stage + '.' + key + ' exists but the mapping says nothing about it, so it silently does nothing')
    }
  }
})

check('the translation actually renames, and does not pass a name through untouched', () => {
  const p = params.normalise({}).params
  const c = gen.forCaves(p, { floorDepth: 4 })
  assert(c.density === p.caves.caveDensity, 'caveDensity did not become density')
  assert(c.passes === p.caves.smoothingPasses, 'smoothingPasses did not become passes')
  assert(c.minRegion === p.caves.minCaveSize, 'minCaveSize did not become minRegion')
  assert(c.caveDensity === undefined, 'the user-facing name leaked through to the module')

  const s = gen.forShape(p, 400)
  assert(s.surfaceY === Math.round(p.shape.surfaceLevel * 400),
    'surfaceLevel is a fraction and must become an absolute row')
  assert(s.featureWidth === p.shape.surfaceWavelength, 'surfaceWavelength did not become featureWidth')
})

check('caves may not eat the floor the shape stage laid', () => {
  const p = params.normalise({ caves: { minHeightAboveFloor: 0 } }).params
  const c = gen.forCaves(p, { floorDepth: 9 })
  assert(c.floor >= 9, 'the carver was allowed within ' + c.floor + ' rows of a 9-row floor')
})

check('the ore table becomes the shape the ore module reads', () => {
  const p = params.normalise({}).params
  const o = gen.forOre(p)
  assert(o.materials && !Array.isArray(o.materials), 'materials stayed an array')
  assert(Array.isArray(o.only) && o.only.length, 'naming materials did not restrict to them')
  for (const hex of o.only) assert(/^#[0-9a-f]{6}$/.test(hex), 'a material key is not a lowercase hex: ' + hex)
})

check('the composed generator produces caves, not a sponge or a solid block', () => {
  const r = gen.generate(400, 300, { seed: 'composition' })
  assert(r.ok, 'generate refused: ' + r.reason)
  const share = r.stats.caves.carved / r.stats.ground.solid
  // The failure this file was written for: 0.44 read under the new meaning
  // hollowed 41%. The default asks for about a tenth, so anything past a fifth
  // means the two modules have drifted apart again.
  assert(share > 0.01 && share < 0.20,
    'the default carved ' + (share * 100).toFixed(1) + '% of the ground; the default asks for about 10%')
  assert(r.stats.ore.veins.length > 0, 'no ore survived the caves')
})

check('one seed is one map, and each stage draws from its own stream', () => {
  const a = gen.generate(200, 260, { seed: 'x' })
  const b = gen.generate(200, 260, { seed: 'x' })
  const c = gen.generate(200, 260, { seed: 'y' })
  assert(Buffer.from(a.buf.data).equals(Buffer.from(b.buf.data)), 'the same seed gave two different maps')
  assert(!Buffer.from(a.buf.data).equals(Buffer.from(c.buf.data)), 'two seeds gave the same map')

  // Changing a cave knob must not reshuffle the ground, or every knob moves
  // everything and nothing can be tuned.
  const d = gen.generate(200, 260, { seed: 'x', caves: { minCaveSize: 999999 } })
  let same = 0
  for (let i = 0; i < 40; i++) if (a.profile[i] === d.profile[i]) same++
  assert(same === 40, 'a cave setting changed the surface profile')
})

check('a refusal is a refusal, and nothing throws on hostile input', () => {
  for (const bad of [[0, 300], [400, 0], [-1, 10]]) {
    const r = gen.generate(bad[0], bad[1], {})
    assert(r && r.ok === false && typeof r.reason === 'string', 'a bad size was accepted: ' + bad)
  }
  const hostile = { get caves() { throw new Error('boom') } }
  const r = gen.generate(200, 260, hostile)
  assert(r && typeof r.ok === 'boolean', 'a hostile parameter object escaped as an exception')
})

if (failures) { console.log('FAIL generator composition tests: ' + failures + ' failing'); process.exit(1) }
console.log('PASS generator composition tests')
