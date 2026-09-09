'use strict'
/**
 * What the five non-terrain layers mean, and what a person needs on screen to
 * edit one.
 *
 * A `.custommap` is six PNGs, and only one of them is a picture of anything.
 * The other five are data wearing a colour's clothes: the game reads their
 * bytes through five different decoders, and a colour that means "solid rock"
 * in the terrain layer means "brightness 1.7" in one of the others. The map
 * editor used to offer the terrain palette whatever layer was selected, so
 * choosing `lightsMeta` and painting a rock colour wrote brightness 0 - a number
 * the
 * author never typed and could not see.
 *
 * This module is the answer to "what can be painted here, and what does the
 * game do with it". It has no DOM in it, for the same reason
 * src/game/terrain-palette.js has none: the editor's rail, the validator and
 * the self-test all have to agree about these tables, and the way they agree
 * is by reading one copy.
 *
 * ## Where these facts come from
 *
 * Every table below was read out of the shipped bundle's own decoders, not
 * inferred from the layer names. Four of the five are settled:
 *
 *   - **lights** - `if (A === 0) return`, then the pixel's RGB *is* the light's
 *     colour, straight through as `[R/255, G/255, B/255, 1]`. Any colour is
 *     legitimate, so this layer wants a colour picker and not a table. One
 *     colour is special-cased: 58,211,204 raises brightness to 1.1.
 *   - **lightsMeta** - two numbers, not a colour. `R = brightness x 100` and
 *     `G = size / 4`, B unused, alpha gates the pixel. Zero is not zero: the
 *     decoder tests `if (metaR)` before it divides, so R = 0 leaves brightness
 *     at its default of 1 and G = 0 leaves size at its default of 400.
 *   - **sensors** - exactly two meaningful colours, pure red and pure yellow.
 *     Every other opaque colour falls through to Artifact 1 in silence.
 *   - **authorization** - twelve numbered restriction zones looked up in a
 *     fixed colour table. An unrecognised colour is zone 0, which restricts
 *     nothing at all.
 *
 * The fifth is not:
 *
 *   - **wall** - the backdrop. Its decoder was not found, so nothing here
 *     claims to know what its colours mean. It is offered as a free colour,
 *     and the one hard fact about it - `wallData` carries a palette with room
 *     for 254 entries - is surfaced as a live count rather than as a rule
 *     about appearance. If someone later reads that decoder, this is the
 *     comment that should change.
 *
 * @module mapeditor-layers
 */

/**
 * What kind of editing surface each layer needs.
 *
 * `palette` is the terrain table and lives in src/game/terrain-palette.js;
 * everything else is here.
 */
const SURFACES = {
  terrain: 'palette',
  lights: 'colour',
  lightsMeta: 'meta',
  sensors: 'choices',
  authorization: 'choices',
  wall: 'colour',
}

/** Brightness when the meta pixel does not say otherwise. */
const DEFAULT_LIGHT_BRIGHTNESS = 1

/** Radius when the meta pixel does not say otherwise. */
const DEFAULT_LIGHT_SIZE = 400

/** `brightness x 100` is stored in R, so R is a hundredth of a brightness. */
const BRIGHTNESS_SCALE = 100

/** `size / 4` is stored in G, so one step of G is four of size. */
const SIZE_SCALE = 4

/** A byte holds 255, so these are the ceilings the two fields have. */
const MAX_LIGHT_BRIGHTNESS = 255 / BRIGHTNESS_SCALE
const MAX_LIGHT_SIZE = 255 * SIZE_SCALE

/** The one colour the lights decoder treats as special, and what it does. */
const LIGHT_BOOST = { rgb: [58, 211, 204], brightness: 1.1 }

/** The wall layer's palette has room for indices 1..254 and no more. */
const MAX_WALL_COLOURS = 254

/**
 * @typedef {object} LayerEntry
 * @property {[number,number,number]} rgb  the bytes written into the layer
 * @property {string} hex  lowercase `#rrggbb`
 * @property {string} label  what a mapmaker reads
 * @property {string} note  one sentence on anything surprising, or ''
 * @property {number} [a]  alpha, when it is not the usual 255
 */

/** `[r,g,b]` as `#rrggbb`. */
function hexOf(rgb) {
  return '#' + rgb.map((n) => (n < 16 ? '0' : '') + n.toString(16)).join('')
}

/**
 * The two artifact markers, and nothing else.
 *
 * The decoder is a two-branch `if`: pure red is the first artifact, pure yellow
 * is the second, and the initial value of the variable it assigns into is the
 * first artifact - so any other opaque colour becomes an Artifact 1 marker with
 * no complaint. Two entries is the honest surface, and `unknownConsequence`
 * below is what the validator says about anything else.
 */
const SENSORS = [
  {
    rgb: [255, 0, 0], hex: '#ff0000', label: 'Artifact 1',
    note: 'The same pure red is an air colour in the terrain layer; here it marks the first artifact.',
  },
  {
    rgb: [255, 255, 0], hex: '#ffff00', label: 'Artifact 2',
    note: '',
  },
]

/**
 * The twelve restriction zones, named by what each one takes away.
 *
 * Labelled the way the terrain palette labels a colour: by what the player
 * gets, not by the number the code uses. The number is kept in front of it
 * because that is the zone's identity everywhere else, but the sentence after
 * it is the thing an author is choosing between.
 */
const ZONES = [
  {
    zone: 1, rgb: [255, 0, 0], hex: '#ff0000',
    forbids: ['jetpack', 'grabbing', 'building', 'tools'],
    label: 'Zone 1 - no jetpack, grabbing, building or tools',
  },
  {
    zone: 2, rgb: [255, 255, 0], hex: '#ffff00',
    forbids: ['building', 'grabbing', 'tools'],
    label: 'Zone 2 - no building, grabbing or tools',
  },
  {
    zone: 3, rgb: [255, 255, 255], hex: '#ffffff',
    forbids: ['building'],
    label: 'Zone 3 - no building',
  },
  {
    zone: 4, rgb: [0, 0, 255], hex: '#0000ff',
    forbids: ['excavation'],
    label: 'Zone 4 - no digging',
  },
  {
    zone: 5, rgb: [0, 255, 0], hex: '#00ff00',
    forbids: ['jetpack', 'grabbing', 'building', 'excavation'],
    label: 'Zone 5 - no jetpack, grabbing, building or digging',
  },
  {
    zone: 6, rgb: [255, 0, 255], hex: '#ff00ff',
    forbids: ['jetpack', 'grabbing', 'building', 'tools', 'excavation'],
    label: 'Zone 6 - no jetpack, grabbing, building, tools or digging',
  },
  {
    zone: 7, rgb: [0, 255, 255], hex: '#00ffff',
    forbids: ['grabbing', 'building', 'excavation'],
    label: 'Zone 7 - no grabbing, building or digging',
  },
  {
    zone: 8, rgb: [255, 128, 0], hex: '#ff8000',
    forbids: ['grabbing', 'building', 'excavation', 'tools'],
    label: 'Zone 8 - no grabbing, building, digging or tools',
  },
  {
    zone: 9, rgb: [128, 0, 255], hex: '#8000ff',
    forbids: ['jetpack', 'grabbing', 'tools', 'excavation'],
    label: 'Zone 9 - no jetpack, grabbing, tools or digging',
  },
  {
    zone: 10, rgb: [0, 128, 255], hex: '#0080ff',
    forbids: ['building', 'grabbing'],
    label: 'Zone 10 - no building or grabbing',
  },
  {
    zone: 11, rgb: [128, 255, 0], hex: '#80ff00',
    forbids: ['everything except the flamethrower', 'building'],
    label: 'Zone 11 - only the flamethrower works, and no building',
  },
  {
    zone: 12, rgb: [128, 128, 0], hex: '#808000',
    forbids: ['jetpack', 'grabbing', 'building', 'excavation', 'everything except the flamethrower'],
    label: 'Zone 12 - only the flamethrower works, and no jetpack, grabbing, building or digging',
  },
]

/** The enumerated tables, by layer. Layers not listed have no fixed table. */
const CHOICES = { sensors: SENSORS, authorization: ZONES }

/**
 * What kind of surface a layer needs, or null for a layer this module has never
 * heard of - which is not a thing that can happen through the editor, but is
 * exactly what a caller should be able to test for rather than assume.
 */
function surfaceOf(layer) {
  return Object.prototype.hasOwnProperty.call(SURFACES, layer) ? SURFACES[layer] : null
}

/** The fixed table a layer offers, or null when it does not have one. */
function choices(layer) {
  return Object.prototype.hasOwnProperty.call(CHOICES, layer) ? CHOICES[layer] : null
}

/** A byte, however badly the caller asked for it. */
function byteOf(n) {
  const v = Math.round(Number(n))
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : (v > 255 ? 255 : v)
}

/** The entry in a layer's table with this colour, or null. Alpha is not part of it. */
function choiceByRgb(layer, r, g, b) {
  const table = choices(layer)
  if (!table) return null
  for (const entry of table) {
    if (entry.rgb[0] === r && entry.rgb[1] === g && entry.rgb[2] === b) return entry
  }
  return null
}

/**
 * Two numbers as the bytes that carry them.
 *
 * Zero is not "no brightness" and not "no size": the decoder tests the byte
 * before it uses it, so a zero byte is how the format spells "leave this one
 * alone". Passing 0 - or anything that is not a positive number - therefore
 * encodes *the default*, which is what an author who clears the field means.
 *
 * @param {number} brightness  a multiplier, 1 being ordinary
 * @param {number} size  a radius in the units the light decoder uses
 * @returns {[number,number,number]} the RGB to store; B is unused by the game
 */
function encodeMeta(brightness, size) {
  const bn = Number(brightness)
  const sn = Number(size)
  return [
    Number.isFinite(bn) && bn > 0 ? byteOf(bn * BRIGHTNESS_SCALE) : 0,
    Number.isFinite(sn) && sn > 0 ? byteOf(sn / SIZE_SCALE) : 0,
    0,
  ]
}

/**
 * The bytes back as the two numbers an author thinks in, each flagged with
 * whether it was actually stated or is the decoder's default.
 *
 * @param {number} r  the red byte
 * @param {number} g  the green byte
 * @returns {{brightness:number, size:number,
 *   brightnessDefaulted:boolean, sizeDefaulted:boolean}}
 */
function decodeMeta(r, g) {
  const rb = byteOf(r)
  const gb = byteOf(g)
  return {
    brightness: rb ? rb / BRIGHTNESS_SCALE : DEFAULT_LIGHT_BRIGHTNESS,
    size: gb ? gb * SIZE_SCALE : DEFAULT_LIGHT_SIZE,
    brightnessDefaulted: !rb,
    sizeDefaulted: !gb,
  }
}

/** A number without a trailing `.00` nobody typed. */
function num(n) {
  return String(Math.round(n * 1000) / 1000)
}

/** "Brightness 1.5, size 600", saying which halves the game is filling in. */
function metaLabel(r, g) {
  const m = decodeMeta(r, g)
  return 'Brightness ' + num(m.brightness) + (m.brightnessDefaulted ? ' (default)' : '') +
    ', size ' + num(m.size) + (m.sizeDefaulted ? ' (default)' : '')
}

/** A meta pixel as an entry, so it travels through the editor like any colour. */
function metaEntry(brightness, size) {
  const rgb = encodeMeta(brightness, size)
  return { rgb, hex: hexOf(rgb), label: metaLabel(rgb[0], rgb[1]), note: '' }
}

/** A free colour as an entry, named by the only thing that is true of it. */
function colourEntry(layer, r, g, b) {
  const rgb = [byteOf(r), byteOf(g), byteOf(b)]
  const boosted = layer === 'lights' && rgb[0] === LIGHT_BOOST.rgb[0] &&
    rgb[1] === LIGHT_BOOST.rgb[1] && rgb[2] === LIGHT_BOOST.rgb[2]
  return {
    rgb,
    hex: hexOf(rgb),
    label: layer === 'lights' ? 'Light ' + rgb.join(',') : 'Backdrop ' + rgb.join(','),
    note: boosted
      ? 'The game special-cases this exact colour and lights it at brightness ' +
        LIGHT_BOOST.brightness + ' instead of 1.'
      : '',
  }
}

/**
 * What the eraser writes on a layer, or null for one this module does not own.
 *
 * Fully transparent, and that is not a shortcut: the four decoders that were
 * read all open with a test on alpha and return without doing anything when it
 * is zero, so alpha 0 is precisely "nothing here". The wall layer's decoder was
 * never found - transparency is what the map format's own transforms already
 * fill new wall space with, and the shipped campaign map has no wall layer at
 * all, so it is the established empty rather than a verified one.
 *
 * Terrain is the exception the editor keeps to itself - a see-through terrain
 * pixel is Fog - and it is not answered here.
 */
function emptyInk(layer) {
  if (!surfaceOf(layer) || layer === 'terrain') return null
  return { rgb: [0, 0, 0], a: 0, hex: '#000000', label: 'Nothing here', note: '' }
}

/**
 * What a layer starts out painting with.
 *
 * Terrain answers null: its default is the palette's, and this module has no
 * opinion about it. The meta layer starts at the game's own defaults stated
 * explicitly rather than at the zero that means "unstated", so the two fields
 * open showing the numbers that are actually in force.
 */
function defaultInk(layer) {
  switch (layer) {
    case 'lights': return colourEntry('lights', 255, 255, 255)
    case 'wall': return colourEntry('wall', 128, 128, 128)
    case 'lightsMeta': return metaEntry(DEFAULT_LIGHT_BRIGHTNESS, DEFAULT_LIGHT_SIZE)
    case 'sensors': return SENSORS[0]
    case 'authorization': return ZONES[0]
    default: return null
  }
}

/**
 * What is stored at one pixel of one layer, in a sentence.
 *
 * Returns null for terrain and for anything unknown, because the terrain layer
 * already has a table that answers this better than a sentence could.
 */
function describe(layer, rgba) {
  const kind = surfaceOf(layer)
  if (!kind || kind === 'palette' || !rgba) return null
  if (rgba[3] === 0) return 'nothing here'
  const r = rgba[0], g = rgba[1], b = rgba[2]
  if (kind === 'meta') return metaLabel(r, g)
  if (kind === 'choices') {
    const entry = choiceByRgb(layer, r, g, b)
    if (entry) return entry.label
    return r + ',' + g + ',' + b + ' - ' + unknownConsequence(layer)
  }
  return colourEntry(layer, r, g, b).label
}

/**
 * What the game does with a colour a fixed table does not contain.
 *
 * One sentence, phrased as an outcome rather than as a complaint, because both
 * the rail and the validator say it and they must say the same thing.
 */
function unknownConsequence(layer) {
  if (layer === 'sensors') return 'the game reads it as an Artifact 1 marker'
  if (layer === 'authorization') return 'the game reads it as no zone at all'
  return ''
}

/**
 * The line above a layer's controls: what the thing being chosen actually is.
 *
 * The terrain line is the one this file has always shown, kept here so all six
 * are read side by side rather than one being a special case somewhere else.
 */
function controlsLine(layer) {
  switch (layer) {
    case 'terrain':
      return 'These squares are the codes the map format stores, not how the world will look.'
    case 'lights':
      return 'The colour you pick here is the light\'s own colour - any colour works.'
    case 'lightsMeta':
      return 'These are two numbers, not a colour. They tune a light that the Lights layer ' +
        'has already put here.'
    case 'sensors':
      return 'The game reads exactly two colours here, one for each artifact.'
    case 'authorization':
      return 'Each colour is one numbered zone, and a zone is a list of things the player ' +
        'cannot do inside it.'
    case 'wall':
      return 'The backdrop behind the world. How the game reads these colours has not been ' +
        'confirmed, so pick freely - but it has room for ' + MAX_WALL_COLOURS + ' of them.'
    default:
      return ''
  }
}

/**
 * The line below them: what happens if the author gets it wrong, or what the
 * game will do that they cannot see. Empty for terrain, which says its piece
 * in every one of its own labels.
 */
function consequenceLine(layer) {
  switch (layer) {
    case 'lights':
      return 'A see-through pixel is no light at all, which is what the eraser writes. ' +
        LIGHT_BOOST.rgb.join(',') + ' is special-cased and comes out at brightness ' +
        LIGHT_BOOST.brightness + '.'
    case 'lightsMeta':
      return 'Zero means "leave it alone": brightness stays ' + DEFAULT_LIGHT_BRIGHTNESS +
        ' and size stays ' + DEFAULT_LIGHT_SIZE + '. Tuning a spot where the Lights layer has ' +
        'no light does nothing at all.'
    case 'sensors':
      return 'Any other colour that is not see-through becomes an Artifact 1 marker, ' +
        'without a word about it.'
    case 'authorization':
      return 'A colour that is not one of these twelve is no zone at all, so nothing is ' +
        'restricted there.'
    case 'wall':
      return 'Past ' + MAX_WALL_COLOURS + ' colours the game paints the rest in one shared ' +
        'colour, so stretches of the backdrop come out visibly wrong.'
    default:
      return ''
  }
}

/**
 * Distinct RGBA values in a layer, counted the way the game's wall palette
 * counts them: a fully see-through pixel costs nothing, and alpha is part of a
 * colour's identity, so two pixels differing only in alpha are two colours.
 *
 * Bounded by `cap` so a photographic layer cannot turn a count into a memory
 * problem; past it we stop and say so, which is all a caller needs to know.
 *
 * @param {{data:ArrayLike<number>, width:number, height:number}} buffer
 * @param {number} cap  stop counting past this many distinct colours
 * @returns {{count:number, capped:boolean}}
 */
function countColours(buffer, cap) {
  const limit = Number.isFinite(cap) && cap > 0 ? cap : 1024
  if (!buffer || !buffer.data) return { count: 0, capped: false }
  const { data, width, height } = buffer
  const seen = new Set()
  let capped = false
  for (let i = 0, n = Math.min(data.length, width * height * 4); i < n; i += 4) {
    if (data[i + 3] === 0) continue
    if (seen.size >= limit) { capped = true; break }
    seen.add(((data[i] * 256 + data[i + 1]) * 256 + data[i + 2]) * 256 + data[i + 3])
  }
  return { count: seen.size, capped }
}

const LAYER_SURFACES = {
  SURFACES,
  SENSORS,
  ZONES,
  CHOICES,
  LIGHT_BOOST,
  DEFAULT_LIGHT_BRIGHTNESS,
  DEFAULT_LIGHT_SIZE,
  BRIGHTNESS_SCALE,
  SIZE_SCALE,
  MAX_LIGHT_BRIGHTNESS,
  MAX_LIGHT_SIZE,
  MAX_WALL_COLOURS,
  surfaceOf,
  choices,
  choiceByRgb,
  encodeMeta,
  decodeMeta,
  metaLabel,
  metaEntry,
  colourEntry,
  emptyInk,
  defaultInk,
  describe,
  unknownConsequence,
  controlsLine,
  consequenceLine,
  countColours,
  hexOf,
}

/*
 * CommonJS for the self-test and the main process, a global for the renderer -
 * the same arrangement mapeditor-tools.js uses, and for the same reason: the
 * prelude concatenates these files into one script where `module` does not
 * exist, and neither side should be reading a second copy of these tables.
 */
if (typeof module !== 'undefined' && module.exports) module.exports = LAYER_SURFACES
if (typeof globalThis !== 'undefined') globalThis.__SMLN_MAPEDITOR_LAYERS__ = LAYER_SURFACES
