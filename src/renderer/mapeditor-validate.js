'use strict'
/**
 * What a map will do to the player, read off the pixels before anyone plays it.
 *
 * Everything this module catches is invisible until someone loads the map. A
 * `.custommap` can assemble cleanly, list cleanly and preview cleanly, and then
 * open onto a hollow world - that has already happened here once, with a map
 * whose rock was 102,102,102. The preview drew the PNG; nothing said what the
 * PNG meant.
 *
 * So these are not "is the file well-formed" checks. Each one names a thing the
 * player will experience, in the words a mapmaker would use, because the person
 * reading the message is holding a brush, not a debugger.
 *
 * Every fact encoded here comes from two reports read out of the shipped 0.5.6
 * bundle - `.superpowers/sdd/terrain-palette-investigation.md` (what each colour
 * becomes, and what collides) and `.superpowers/sdd/map-editor-investigation.md`
 * (the spawn formula, the layer strides, the real size limits). The colour table
 * itself is not duplicated: it lives in `src/game/terrain-palette.js` and is the
 * single authority on what any given colour does.
 *
 * @module mapeditor-validate
 */

const palette = require('../game/terrain-palette.js')

/** World pixels per cell. One blueprint pixel is one world cell. */
const CELL_SIZE = 4

/** World pixels added to the half-width when the game places the player. */
const SPAWN_X_OFFSET_PIXELS = 315

/** The spawn row is a literal 200 cells, whatever the map's height. */
const SPAWN_ROW_CELLS = 200

/**
 * The shared mouse position is a Uint16 holding *world pixels*, so a coordinate
 * has to stay under 65,536 - which is 16,384 cells, and 16,383 as a last index.
 */
const MAX_CELLS_PER_AXIS = 16383

/** The wall layer's palette has room for indices 1..254 and no more. */
const MAX_WALL_COLOURS = 254

/**
 * Counting distinct wall colours is bounded so a photographic wall layer cannot
 * turn a validation pass into a memory problem. Past this we stop counting and
 * say "at least", which is all the author needs to hear anyway.
 */
const WALL_COLOUR_SCAN_CAP = 10000

/** Distinct colours whose palette lookup we memoise during the terrain scan. */
const CLASS_CACHE_CAP = 4096

/** The player's box is 12x30 world pixels; this is that, plus a cell of slack. */
const POCKET_CELLS_WIDE = 4
const POCKET_CELLS_TALL = 9

/** The six layers the game reads, in the order it reads them. */
const LAYER_ORDER = ['terrain', 'lights', 'lightsMeta', 'sensors', 'authorization', 'wall']

/** What each layer is called when a mapmaker is being told about it. */
const LAYER_NAMES = {
  terrain: 'terrain',
  lights: 'lights',
  lightsMeta: 'light settings',
  sensors: 'artifact sensors',
  authorization: 'zones',
  wall: 'wall backdrop',
}

/**
 * The cell the game drops the player into, in cells.
 *
 * The formula is fixed and unconditional - there is no search for open space
 * and no fallback. In world pixels it is `x = (width / 2) * 4 + 315` and
 * `y = 200 * 4`; dividing back down by the cell size gives cells, and the
 * horizontal offset is not a whole number of cells (315 / 4 = 78.75), so the
 * column floors. A 480-wide map spawns at column 318, row 200.
 *
 * @param {number} widthInCells the terrain layer's width
 * @returns {{x:number, y:number}} the spawn cell
 */
function spawnCell(widthInCells) {
  const width = Number(widthInCells)
  const safe = Number.isFinite(width) && width > 0 ? width : 0
  const xPixels = (safe / 2) * CELL_SIZE + SPAWN_X_OFFSET_PIXELS
  return { x: Math.floor(xPixels / CELL_SIZE), y: SPAWN_ROW_CELLS }
}

/** Does this look like the `{data, width, height}` an ImageData gives us? */
function isBuffer(b) {
  return !!b && typeof b === 'object' && !!b.data &&
    typeof b.data.length === 'number' &&
    Number.isFinite(b.width) && Number.isFinite(b.height)
}

/** 1234567 -> "1,234,567", without depending on the host's locale data. */
function group(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** "1 place" / "37 places". */
function places(n) {
  return group(n) + (n === 1 ? ' place' : ' places')
}

/** A colour as a mapmaker writes it. */
function rgbText(r, g, b) {
  return r + ',' + g + ',' + b
}

/**
 * A palette entry as a sentence fragment: "Solid rock (needs a drill),
 * 170,170,170". Tolerates an entry without an `rgb` array.
 */
function describe(entry, fallbackLabel) {
  if (!entry) return fallbackLabel
  const label = entry.label || fallbackLabel
  const c = entry.rgb
  if (Array.isArray(c) && c.length >= 3) return label + ', ' + rgbText(c[0], c[1], c[2])
  if (typeof entry.hex === 'string' && entry.hex) return label + ', ' + entry.hex
  return label
}

/** One entry in the returned list. */
function problem(severity, code, message, layer, at) {
  return { severity, code, message, layer: layer || null, at: at || null }
}

/**
 * Read every pixel of the terrain layer once, and come back with everything the
 * five terrain rules need. One pass, because the alternative is five.
 *
 * Colour classification is memoised, since a real map uses a few dozen colours
 * across millions of pixels. The cache is capped so a pathological image cannot
 * grow it without bound - past the cap we simply look colours up each time.
 */
function scanTerrain(buffer, fogCellType) {
  const { data, width, height } = buffer
  const out = {
    translucent: { count: 0, first: null },
    broken: new Map(),          // hex -> {entry, count, first}
    fog: { count: 0, first: null, mask: null, largest: 0 },
    anySolid: false,
    firstRgba: null,
    oneColourOnly: true,
    soleEntry: null,
    spawnEntry: null,
    spawnSolid: false,
  }

  const cache = new Map()
  const spawn = spawnCell(width)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = y * width + x
      const i = cell * 4
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3]

      // Alpha 0 is not air: the loader turns it into fog. Anything short of
      // fully opaque is a hole waiting to be one.
      if (a < 255) {
        out.translucent.count++
        if (!out.translucent.first) out.translucent.first = { x, y }
      }

      const rgba = ((r * 256 + g) * 256 + b) * 256 + a
      if (out.firstRgba === null) out.firstRgba = rgba
      else if (out.oneColourOnly && rgba !== out.firstRgba) out.oneColourOnly = false

      const key = (r * 256 + g) * 256 + b
      let entry = cache.get(key)
      if (entry === undefined) {
        entry = palette.byRgb(r, g, b) || null
        if (cache.size < CLASS_CACHE_CAP) cache.set(key, entry)
      }

      if (entry) {
        if (entry.kind === 'solid') out.anySolid = true
        if (entry.kind === 'broken') {
          let seen = out.broken.get(entry.hex)
          if (!seen) {
            seen = { entry, count: 0, first: { x, y } }
            out.broken.set(entry.hex, seen)
          }
          seen.count++
        }
      }

      // Fog is identified by the material it resolves to, not by one colour:
      // four different colours all land on the same sealed-pocket cell type,
      // and they all carry the same trap.
      const isFog = (r === 102 && g === 102 && b === 102) ||
        (fogCellType !== null && entry !== null && entry.cellType === fogCellType)
      if (isFog) {
        out.fog.count++
        if (!out.fog.first) {
          out.fog.first = { x, y }
          out.fog.mask = new Uint8Array(width * height)
        }
        out.fog.mask[cell] = 1
      }

      if (x === spawn.x && y === spawn.y) {
        out.spawnEntry = entry
        out.spawnSolid = !!entry && entry.kind === 'solid'
      }
    }
  }

  if (out.firstRgba !== null && out.oneColourOnly) {
    const rgba = out.firstRgba
    out.soleEntry = palette.byRgb((rgba >>> 24) & 255, (rgba >>> 16) & 255, (rgba >>> 8) & 255)
  }
  if (out.fog.mask) out.fog.largest = largestConnected(out.fog.mask, width, height)
  return out
}

/**
 * The biggest 4-connected run of marked cells.
 *
 * This is the number that matters for fog: breaking a single cell anywhere in a
 * connected mass dissolves the whole mass, so "how many cells go at once" is the
 * difference between a deliberate pocket and an accident.
 */
function largestConnected(mask, width, height) {
  const seen = new Uint8Array(mask.length)
  // A plain array, not a typed one: the stack never holds more than the patch
  // being walked, and sizing it to the whole map would cost more memory than
  // the map itself on a large blueprint.
  const stack = []
  let largest = 0

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue
    let size = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length > 0) {
      const cell = stack.pop()
      size++
      const x = cell % width
      const y = (cell - x) / width
      if (x > 0 && mask[cell - 1] && !seen[cell - 1]) { seen[cell - 1] = 1; stack.push(cell - 1) }
      if (x < width - 1 && mask[cell + 1] && !seen[cell + 1]) { seen[cell + 1] = 1; stack.push(cell + 1) }
      if (y > 0 && mask[cell - width] && !seen[cell - width]) { seen[cell - width] = 1; stack.push(cell - width) }
      if (y < height - 1 && mask[cell + width] && !seen[cell + width]) { seen[cell + width] = 1; stack.push(cell + width) }
    }
    if (size > largest) largest = size
  }
  return largest
}

/**
 * Count distinct RGBA values in the wall layer the way the game does: a fully
 * see-through pixel is skipped and costs nothing, and alpha is part of a
 * colour's identity, so two pixels that differ only in alpha are two colours.
 */
function countWallColours(buffer) {
  const { data, width, height } = buffer
  const seen = new Set()
  let capped = false
  for (let i = 0, n = width * height * 4; i < n; i += 4) {
    if (data[i + 3] === 0) continue
    if (seen.size >= WALL_COLOUR_SCAN_CAP) { capped = true; break }
    seen.add(((data[i] * 256 + data[i + 1]) * 256 + data[i + 2]) * 256 + data[i + 3])
  }
  return { count: seen.size, capped }
}

/**
 * Everything wrong with a map, worst first.
 *
 * @param {{params?:{width?:number, height?:number}, layers?:object}} doc
 * @returns {{problems: Array<{severity:'error'|'warning', code:string,
 *   message:string, layer:?string, at:?{x:number,y:number}}>}}
 */
function validate(doc) {
  const problems = []
  const d = doc || {}
  const layers = d.layers || {}
  const terrain = layers.terrain

  // Nothing below means anything without the terrain layer: it is the layer the
  // world's size and every cell's material come from.
  if (!isBuffer(terrain)) {
    problems.push(problem('error', 'terrain-missing',
      'This map has no terrain layer. Terrain is the layer the world is built from - ' +
      'it decides how big the map is and what every single cell of it is made of. ' +
      'Without it there is nothing to play.', 'terrain', null))
    return { problems }
  }

  const width = terrain.width
  const height = terrain.height

  // Every rule below compares something against the map's size, so if the size
  // itself is nonsense they have nothing to say and would only bury the one
  // problem that has to be fixed first under a pile of derived noise.
  const dimsSane = Number.isInteger(width) && Number.isInteger(height) &&
    width > 0 && height > 0 &&
    width <= MAX_CELLS_PER_AXIS && height <= MAX_CELLS_PER_AXIS
  const sizeUsable = dimsSane && terrain.data.length >= width * height * 4

  // ---- Rule 6: a size the game cannot carry -------------------------------
  for (const axis of [{ name: 'wide', n: width }, { name: 'tall', n: height }]) {
    if (!Number.isInteger(axis.n) || axis.n <= 0) {
      problems.push(problem('error', 'map-size',
        (Number.isInteger(axis.n)
          ? 'The map is ' + axis.n + ' cells ' + axis.name + '.'
          : 'The map does not have a real width and height.') +
        ' There is no world here to play - give the terrain layer a size, and paint ' +
        'something into it, before saving.', 'terrain', null))
    } else if (axis.n > MAX_CELLS_PER_AXIS) {
      problems.push(problem('error', 'map-size',
        'The map is ' + group(axis.n) + ' cells ' + axis.name + '. Above ' +
        group(MAX_CELLS_PER_AXIS) + ' the game loses track of where the mouse is - ' +
        'positions past that point wrap around, so clicks, digging and building all land ' +
        'somewhere other than where the player aimed. Keep both sides at ' +
        group(MAX_CELLS_PER_AXIS) + ' cells or under.', 'terrain', null))
    }
  }

  if (dimsSane && !sizeUsable) {
    problems.push(problem('error', 'terrain-missing',
      'The terrain layer says it is ' + width + 'x' + height + ' but does not hold that many ' +
      'pixels, so part of the map has never been drawn. Re-open or re-create the map before ' +
      'saving it.', 'terrain', null))
  }

  // ---- Rule 5: the size the map advertises ---------------------------------
  const params = d.params
  const pw = params ? params.width : undefined
  const ph = params ? params.height : undefined
  const haveParams = Number.isFinite(pw) && Number.isFinite(ph)
  if (!dimsSane) {
    // No size worth advertising yet - rule 6 has already said so.
  } else if (!haveParams) {
    problems.push(problem('error', 'params-size',
      'This map does not record its own size. The game prints that size straight onto the ' +
      'Custom Maps screen without checking it is there, so the whole list of maps fails to ' +
      'draw and the player cannot pick any map at all - not just this one. It should say ' +
      width + 'x' + height + ', to match the terrain layer.', null, null))
  } else if (pw !== width || ph !== height) {
    problems.push(problem('error', 'params-size',
      'This map says it is ' + pw + 'x' + ph + ', but its terrain layer is ' + width + 'x' +
      height + '. The world is built from the terrain layer, so the map will play at ' +
      width + 'x' + height + ' while the Custom Maps screen advertises a different size. ' +
      'Correct the recorded size to ' + width + 'x' + height + '.', null, null))
  }

  // ---- Rule 1: layers that disagree about how big the world is -------------
  for (const name of LAYER_ORDER) {
    if (name === 'terrain' || !dimsSane) continue
    const layer = layers[name]
    if (!isBuffer(layer)) continue
    if (layer.width === width && layer.height === height) continue
    problems.push(problem('error', 'layer-size-mismatch',
      'The ' + LAYER_NAMES[name] + ' layer is ' + layer.width + 'x' + layer.height +
      ', but the map is ' + width + 'x' + height + '. The game reads each layer row by row ' +
      'using that layer\'s own width, so a layer of the wrong size slips further sideways ' +
      'with every row down the map: what you drew ends up smeared diagonally across the ' +
      'world, and the game says nothing about it. Resize the ' + LAYER_NAMES[name] +
      ' layer to ' + width + 'x' + height + '.', name, null))
  }

  // ---- Rules 2, 3, 7, 8, 9: everything that needs the terrain pixels -------
  if (sizeUsable) {
    const fogRef = palette.byRgb(102, 102, 102)
    const fogCellType = fogRef && Number.isInteger(fogRef.cellType) && fogRef.cellType > 0
      ? fogRef.cellType
      : null
    const scan = scanTerrain(terrain, fogCellType)
    const air = describe(palette.DEFAULT_EMPTY, 'open air')
    const rock = describe(palette.DEFAULT_SOLID, 'solid rock')

    // Rule 2 - anything less than fully opaque becomes fog, not air.
    if (scan.translucent.count > 0) {
      const first = scan.translucent.first
      problems.push(problem('error', 'terrain-transparent',
        group(scan.translucent.count) + ' terrain ' +
        (scan.translucent.count === 1 ? 'pixel is' : 'pixels are') + ' see-through, the first ' +
        'at ' + first.x + ', ' + first.y + '. A see-through pixel is not open air: the game ' +
        'turns it into sealed fog, which the player cannot walk through, and which then ' +
        'dissolves in one huge lump the first time anything digs into it. Paint every ' +
        'terrain pixel at full opacity, and use ' + air + ' where you want air.',
        'terrain', first))
    }

    // Rule 3 - a colour the loader cannot answer to.
    for (const seen of scan.broken.values()) {
      const c = seen.entry.rgb
      const colour = Array.isArray(c) ? rgbText(c[0], c[1], c[2]) : seen.entry.hex
      problems.push(problem('error', 'terrain-broken-colour',
        'The terrain layer uses ' + colour + ' in ' + places(seen.count) + ', the first at ' +
        seen.first.x + ', ' + seen.first.y + '. ' +
        (seen.entry.note ||
          'The game has no material for this colour and gives up while loading the map.') +
        ' The player never sees this map: the game abandons it and drops them into a random ' +
        'world instead, with only a flicker of a message. Replace every one of these pixels.',
        'terrain', seen.first))
    }

    // Rule 7 - the player is dropped into rock. Survivable, so a warning.
    const spawn = spawnCell(width)
    if (scan.spawnSolid) {
      problems.push(problem('warning', 'spawn-blocked',
        'The player appears at ' + spawn.x + ', ' + spawn.y + ', and that cell is ' +
        describe(scan.spawnEntry, 'solid ground') + '. The game does not look for open ' +
        'ground - it drops the player exactly there, every time. Buried, they are shoved ' +
        'upward a few cells per frame until they pop out of the top of the rock, so the map ' +
        'is playable, but it opens with the player erupting out of the ground somewhere you ' +
        'did not choose. Clear about ' + POCKET_CELLS_WIDE + ' cells across and ' +
        POCKET_CELLS_TALL + ' down at ' + spawn.x + ', ' + spawn.y + ' - ' + air +
        ' is plain empty space - and put your floor just under it.',
        'terrain', spawn))
    }

    // Rule 8 - fog is a trap at any size the author did not choose deliberately.
    if (scan.fog.count > 0) {
      problems.push(problem('warning', 'terrain-fog',
        'The terrain layer holds ' + group(scan.fog.count) + ' fog ' +
        (scan.fog.count === 1 ? 'cell' : 'cells') + ', the first at ' + scan.fog.first.x +
        ', ' + scan.fog.first.y + ', and the largest connected patch is ' +
        group(scan.fog.largest) + ' of them. Fog looks and behaves exactly like black rock ' +
        'until something breaks a single cell of it - and then the entire connected patch ' +
        'dissolves into open air, all ' + group(scan.fog.largest) + ' cells of it, over a ' +
        'couple of seconds. That is what makes a good sealed pocket and a terrible cave ' +
        'wall. If you meant rock that stays put, use ' + rock + '.',
        'terrain', scan.fog.first))
    }

    // Rule 9 - a map nobody has drawn yet.
    if (scan.oneColourOnly) {
      const what = scan.soleEntry
      let consequence
      if (what && what.kind === 'solid') {
        consequence = 'The whole world is one unbroken block with no air anywhere in it. ' +
          'The player spawns inside it and is pushed up through the entire map.'
      } else if (what && (what.kind === 'empty' || what.kind === 'fluid')) {
        consequence = 'There is nothing solid anywhere in the world - no ground to stand ' +
          'on, nothing to dig, nothing to build against. The player falls to the bottom of ' +
          'the map and stays there.'
      } else {
        consequence = 'The whole world is made of one thing, so there is nowhere to stand ' +
          'and nothing to dig.'
      }
      problems.push(problem('warning', 'terrain-unfinished',
        'Every pixel of the terrain layer is the same colour' +
        (what ? ' - ' + describe(what, 'it') : '') + '. ' + consequence +
        ' That is almost always a map that has not been drawn yet rather than one anybody ' +
        'meant to make.', 'terrain', null))
    } else if (!scan.anySolid) {
      problems.push(problem('warning', 'terrain-unfinished',
        'Nothing in the terrain layer is solid. Every colour in it comes out as air, ' +
        'liquid or fog, so there is no ground to stand on, nothing to dig and nothing to ' +
        'build against - the player falls to the bottom of the map at the start and stays ' +
        'there. If you meant rock, use ' + rock + '.', 'terrain', null))
    }
  }

  // ---- Rule 4: more backdrop colours than the game can hold ----------------
  const wall = layers.wall
  if (isBuffer(wall) && wall.width > 0 && wall.height > 0 &&
      wall.data.length >= wall.width * wall.height * 4) {
    const wallColours = countWallColours(wall)
    if (wallColours.capped || wallColours.count > MAX_WALL_COLOURS) {
      const how = wallColours.capped
        ? 'at least ' + group(WALL_COLOUR_SCAN_CAP)
        : group(wallColours.count)
      problems.push(problem('error', 'wall-colour-limit',
        'The wall backdrop uses ' + how + ' different colours. The game has room for ' +
        group(MAX_WALL_COLOURS) + ': every colour after that is painted in one single shared ' +
        'colour instead, so stretches of your backdrop come out visibly wrong in game. ' +
        'Bring the wall layer down to ' + group(MAX_WALL_COLOURS) + ' colours or fewer - ' +
        'fully see-through pixels are free and do not count.', 'wall', null))
    }
  }

  return { problems }
}

module.exports = { spawnCell, validate }
