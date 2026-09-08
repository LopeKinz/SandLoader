'use strict'
/**
 * Terrain blueprint palette - what each colour actually gives the player.
 *
 * The data behind the map editor's colour picker. Every row is derived from
 * `.superpowers/sdd/terrain-palette-investigation.md`, which read the shipped
 * 0.5.6 bundle's own resolver and collision code. Where that report and
 * `.superpowers/sdd/map-format-investigation.md` §2 disagree, the former wins.
 *
 * The one fact that shapes everything here: **collision is `cellId >= 1 &&
 * cellId <= 1000000`.** There is no pass-through background terrain type. Every
 * non-Empty CellType a blueprint can produce is a solid obstacle, so no entry
 * is ever labelled "background" - the bucket is empty. The only backdrop that
 * exists is the separate cosmetic `wall` layer, which collision never reads.
 *
 * The fog family fits no bucket cleanly, and the investigation says so: on load
 * those cells are collidable terrain, but the first tool hit anywhere in a
 * connected mass converts the whole mass. They are grouped, as the report
 * groups them, by their durable post-contact state - `empty` where nothing is
 * left behind, `fluid` where an element is - because the failure that prompted
 * this module was an author reaching for `102,102,102` as *rock*, and putting
 * fog in `solid` sits it beside Dirt and Stone, exactly where that author was
 * looking. To close the other half of the trap, every fog row says "blocks
 * until dug" in its **label**, not only in its note, so nobody scanning the
 * `empty` group for air can reach for one blind.
 *
 * Two rows of the investigation's 50 are deliberately absent, because they are
 * not colours and cannot be given an `rgb`/`hex`:
 *
 *  - **alpha 0** is its own rule inside the resolver's `default:` arm and yields
 *    `CellType.Fog` (4), not air. It is carried as a warning on the `#000000`
 *    entry, since a transparent pixel reads back through the canvas as black.
 *    Every terrain pixel the editor writes must be opaque.
 *  - **any unrecognised RGB** is silently left `Empty` - no id match, no
 *    metaColor match, no warning, no throw. That case is exactly what `byHex`
 *    and `byRgb` returning `null` mean, so it needs no row.
 *
 * `cellType` is `null` wherever the report says the number is not determined:
 * the 25 built-in terrains the game registers as its own sandkit mods get their
 * CellType allocated at registration time, so the numbers must never be
 * hard-coded. It is also `null` for colours that become a simulated element
 * rather than a terrain cell, since those have no CellType at all.
 *
 * No dependencies, plain CommonJS: the editor, the validator and the self-test
 * all read the same table.
 */

/** Buckets, in the order a picker should show them. */
const KINDS = ['solid', 'empty', 'fluid', 'broken']

/**
 * @typedef {object} TerrainEntry
 * @property {[number,number,number]} rgb
 * @property {string} hex  lowercase `#rrggbb`
 * @property {'solid'|'empty'|'fluid'|'broken'} kind
 * @property {string} label  what a mapmaker reads
 * @property {string} note  one sentence on anything surprising, or ''
 * @property {number|null} cellType
 */

/**
 * One row per colour a terrain blueprint can contain.
 *
 * Grouped by resolution path, highest precedence first: the six literal switch
 * cases, then the main palette table, then the nine reserved terrain names,
 * then the metaColor fallback. That ordering is why #0000ff is water and not
 * the dirt its table entry names - the switch fires first and the table entry
 * is dead code.
 * @type {TerrainEntry[]}
 */
const TERRAIN = [
  // --- The six literal switch cases (RGB only; they beat alpha and the table).

  {
    rgb: [255, 255, 255], hex: '#ffffff', kind: 'empty', cellType: 0,
    label: 'Open sky (sets the horizon)',
    note: 'Air, but it also records this column\'s horizon depth, which drives the cave-versus-surface ambient audio crossfade; paint it in open sky above the surface, never to erase a deep cave.',
  },
  {
    rgb: [170, 170, 170], hex: '#aaaaaa', kind: 'solid', cellType: 23,
    label: 'Solid rock (needs a drill)',
    note: 'The most reliably resolved colour in the whole format, but its excavation requirement is "drill", so the starting shovel does nothing to it.',
  },
  {
    rgb: [0, 0, 255], hex: '#0000ff', kind: 'fluid', cellType: null,
    label: 'Water pool',
    note: 'Becomes live, flowing water - a simulated element rather than a terrain cell, so nothing collides with it and it will drain away if the pocket is open.',
  },
  {
    rgb: [102, 0, 255], hex: '#6600ff', kind: 'fluid', cellType: null,
    label: 'Water pool (also sets the horizon)',
    note: 'The same live water as #0000ff, and it additionally writes this column\'s ground horizon.',
  },
  {
    rgb: [102, 204, 255], hex: '#66ccff', kind: 'solid', cellType: 25,
    label: 'Ice (nothing can mine it)',
    note: 'Solid and permanent to every tool - with no hit points and no fog flag, excavation skips it entirely; only a flamethrower melt removes it.',
  },
  {
    rgb: [255, 0, 0], hex: '#ff0000', kind: 'empty', cellType: 0,
    label: 'Open air (menu fixture marker)',
    note: 'Air, but it also appends a fixture entry read only by the decorative main-menu scene, and it is the sensors layer\'s artifact colour - use #990000 to erase instead.',
  },
  {
    rgb: [153, 0, 0], hex: '#990000', kind: 'empty', cellType: 0,
    label: 'Open air',
    note: '',
  },

  // --- The main palette table. Only the `.fg` half of a `{bg,fg}` pair is ever
  // --- read, so no colour here gives "material X with a backdrop of Y".

  {
    rgb: [0, 0, 0], hex: '#000000', kind: 'solid', cellType: 2,
    label: 'Dirt (diggable from minute one)',
    note: 'Hit points 4 and no tool requirement, so the starting shovel works; write it fully opaque, because a transparent pixel decodes to this same black and becomes a sealed fog pocket instead.',
  },
  {
    rgb: [0, 255, 0], hex: '#00ff00', kind: 'solid', cellType: 9,
    label: 'Grass',
    note: 'A whole cell of grass, not dirt with a grassy top - the dirt half of the palette entry is discarded.',
  },
  {
    rgb: [0, 224, 0], hex: '#00e000', kind: 'solid', cellType: 10,
    label: 'Moss',
    note: 'Hit points 1 and flammable, so fire spreads through it.',
  },
  {
    rgb: [0, 102, 0], hex: '#006600', kind: 'solid', cellType: 8,
    label: 'Divider',
    note: 'Hit points 1, and it burns away almost instantly if anything ignites it.',
  },
  {
    rgb: [255, 255, 0], hex: '#ffff00', kind: 'solid', cellType: 3,
    label: 'Spore soil',
    note: '',
  },
  {
    rgb: [204, 255, 255], hex: '#ccffff', kind: 'solid', cellType: 7,
    label: 'Freezing ice soil',
    note: 'Identical to #99ffff once resolved - two colours, one material.',
  },
  {
    rgb: [153, 255, 255], hex: '#99ffff', kind: 'solid', cellType: 7,
    label: 'Freezing ice soil',
    note: 'Identical to #ccffff once resolved - two colours, one material.',
  },
  {
    rgb: [153, 51, 0], hex: '#993300', kind: 'empty', cellType: 4,
    label: 'Sealed fog pocket (blocks until dug)',
    note: 'Solid on load, but breaking any single cell flood-fills the entire connected fog mass to open air - only ever use it for deliberately sized pockets, never for bulk fill.',
  },
  {
    rgb: [68, 0, 255], hex: '#4400ff', kind: 'empty', cellType: 4,
    label: 'Sealed fog pocket (blocks until dug)',
    note: 'Solid on load, but breaking any single cell flood-fills the entire connected fog mass to open air - only ever use it for deliberately sized pockets, never for bulk fill.',
  },
  {
    rgb: [255, 0, 153], hex: '#ff0099', kind: 'empty', cellType: 5,
    label: 'Sealed fog pocket, jetpack-block variant (blocks until dug)',
    note: 'Collides while sealed, then the same flood-fill to open air as the other fog colours; the no-jetpack rule comes from the authorization layer, not from this colour.',
  },
  {
    rgb: [102, 102, 255], hex: '#6666ff', kind: 'fluid', cellType: 6,
    label: 'Hidden water pocket (blocks until dug)',
    note: 'Collides while sealed; breaking one cell reveals the whole connected mass as live water.',
  },
  {
    rgb: [102, 102, 102], hex: '#666666', kind: 'empty', cellType: 4,
    label: 'Sealed fog pocket (blocks until dug, looks like black rock)',
    note: 'Looks like solid black rock and collides on load, then the first dig anywhere in the mass dissolves all of it to open air - this is the colour that produced the hollow test map.',
  },
  {
    rgb: [153, 102, 255], hex: '#9966ff', kind: 'fluid', cellType: 6,
    label: 'Hidden water pocket (blocks until dug)',
    note: 'The same material as #6666ff - it collides while sealed, then breaking one cell reveals the whole connected mass as live water.',
  },
  {
    rgb: [255, 102, 0], hex: '#ff6600', kind: 'fluid', cellType: 13,
    label: 'Hidden lava pocket (blocks until dug)',
    note: 'Collides while sealed; breaking one cell reveals the whole connected mass as live lava.',
  },
  {
    rgb: [175, 0, 224], hex: '#af00e0', kind: 'solid', cellType: 14,
    label: 'Fluxite ore',
    note: '',
  },
  {
    rgb: [255, 85, 0], hex: '#ff5500', kind: 'solid', cellType: 28,
    label: 'Sandium soil (a long shovel dig)',
    note: 'Hit points 20 - the toughest terrain the starting shovel can still get through.',
  },
  {
    rgb: [205, 139, 139], hex: '#cd8b8b', kind: 'solid', cellType: 30,
    label: 'Crackstone (needs dynamite)',
    note: 'Hit points 1, but its excavation requirement is "dynamite", so only rocket-launcher blasts remove it.',
  },
  {
    rgb: [240, 220, 120], hex: '#f0dc78', kind: 'broken', cellType: null,
    label: 'Broken - crashes the map on load',
    note: 'Its palette entry has no foreground value, so the loader throws "Unknown color in blueprint (case #2)" and the map never opens; never write it, and warn about any map that already contains it.',
  },
  {
    rgb: [51, 51, 51], hex: '#333333', kind: 'empty', cellType: 4,
    label: 'Sealed fog pocket (blocks until dug)',
    note: 'Solid on load, but breaking any single cell flood-fills the entire connected fog mass to open air - only ever use it for deliberately sized pockets, never for bulk fill.',
  },

  // --- The nine reserved names. All are registered unconditionally by the
  // --- bundle's own baked-in content, so all nine work in a stock install.
  // --- Their CellType numbers are allocated at registration and stay `null`.

  {
    rgb: [240, 210, 90], hex: '#f0d25a', kind: 'solid', cellType: null,
    label: 'Dune sand',
    note: 'Hit points 1 and shovel-diggable; the same material as #eed975.',
  },
  {
    rgb: [245, 231, 163], hex: '#f5e7a3', kind: 'solid', cellType: null,
    label: 'Sandstone (nothing can mine it)',
    note: 'Marked indestructible, so every tool does exactly zero damage to it.',
  },
  {
    rgb: [255, 222, 0], hex: '#ffde00', kind: 'solid', cellType: null,
    label: 'Limestone (nothing can mine it)',
    note: 'Marked indestructible; the same material as #fedc00.',
  },
  {
    rgb: [34, 34, 34], hex: '#222222', kind: 'solid', cellType: null,
    label: 'Bedrock (permanent floor)',
    note: 'Solid, collidable and indestructible - no tool ever removes it, which makes it right for a map\'s floor or border and wrong for anything the player must get through.',
  },
  {
    rgb: [24, 28, 32], hex: '#181c20', kind: 'solid', cellType: null,
    label: 'Deepstone (nothing can mine it)',
    note: 'Marked indestructible, so no tool removes it.',
  },
  {
    rgb: [255, 20, 20], hex: '#ff1414', kind: 'solid', cellType: null,
    label: 'Blackrock (nothing can mine it)',
    note: 'Marked indestructible; the same material as #141414.',
  },
  {
    rgb: [61, 26, 92], hex: '#3d1a5c', kind: 'solid', cellType: null,
    label: 'Void flower soil (spreads on its own)',
    note: 'Hit points 1 and shovel-diggable, but it spreads at runtime, so it will not stay where you paint it.',
  },
  {
    rgb: [211, 255, 255], hex: '#d3ffff', kind: 'fluid', cellType: null,
    label: 'Hidden freezing-ice pocket (blocks until dug)',
    note: 'Collides while sealed; breaking one cell reveals the connected mass as freezing-ice elements, which do not collide. The same material as #add8e6.',
  },
  {
    rgb: [182, 188, 193], hex: '#b6bcc1', kind: 'solid', cellType: null,
    label: 'Shatterstone (needs the gun)',
    note: 'Hit points 1, but its excavation requirement is "gun", so the shovel does nothing.',
  },

  // --- Colours that resolve through the metaColor fallback. Not free for an
  // --- editor to reuse: the game already answers to every one of them.

  {
    rgb: [222, 157, 16], hex: '#de9d10', kind: 'solid', cellType: null,
    label: 'Solidite',
    note: 'Hit points 1 and no tool requirement, but it drops nothing when mined.',
  },
  {
    rgb: [0, 148, 179], hex: '#0094b3', kind: 'solid', cellType: null,
    label: 'Crystal (a long shovel dig)',
    note: 'Hit points 40 - shovel-diggable, but ten times the work of dirt.',
  },
  {
    rgb: [238, 217, 117], hex: '#eed975', kind: 'solid', cellType: null,
    label: 'Dune sand',
    note: 'The same material as #f0d25a - two colours, one result.',
  },
  {
    rgb: [254, 220, 0], hex: '#fedc00', kind: 'solid', cellType: null,
    label: 'Limestone (nothing can mine it)',
    note: 'Marked indestructible; the same material as #ffde00.',
  },
  {
    rgb: [255, 165, 0], hex: '#ffa500', kind: 'solid', cellType: null,
    label: 'Copper ore (needs a drill)',
    note: 'Hit points 12 and an excavation requirement of "drill", so the starting shovel does nothing to it.',
  },
  {
    rgb: [25, 230, 128], hex: '#19e680', kind: 'solid', cellType: null,
    label: 'Glass (nothing can mine it)',
    note: 'No hit points, so no tool removes it; it is flagged as a building, so the player passes through it only while hovering and is blocked otherwise.',
  },
  {
    rgb: [74, 55, 40], hex: '#4a3728', kind: 'solid', cellType: null,
    label: 'Dissolving rock (chain-reacts)',
    note: 'Hit points 1, and destroying one cell queues a chain dissolve of up to 800 neighbours, so it does not stay where you paint it.',
  },
  {
    rgb: [139, 115, 85], hex: '#8b7355', kind: 'solid', cellType: null,
    label: 'Puff mushroom',
    note: 'Hit points 1, and destroying one can fire a spore burst that excavates an eleven-cell circle around it.',
  },
  {
    rgb: [173, 216, 230], hex: '#add8e6', kind: 'fluid', cellType: null,
    label: 'Hidden freezing-ice pocket (blocks until dug)',
    note: 'The same material as #d3ffff; collides while sealed, then reveals as non-colliding freezing-ice elements.',
  },
  {
    rgb: [20, 20, 20], hex: '#141414', kind: 'solid', cellType: null,
    label: 'Blackrock (nothing can mine it)',
    note: 'Marked indestructible; the same material as #ff1414.',
  },
  {
    rgb: [51, 153, 153], hex: '#339999', kind: 'solid', cellType: null,
    label: 'Florinol soil',
    note: 'Hit points 1 and flammable; it is flagged as a building, so the player passes through it only while hovering.',
  },
  {
    rgb: [74, 64, 176], hex: '#4a40b0', kind: 'solid', cellType: null,
    label: 'Auralite crystal (nothing can mine it)',
    note: 'No hit points, so no tool removes it.',
  },
  {
    rgb: [29, 174, 29], hex: '#1dae1d', kind: 'solid', cellType: null,
    label: 'Vine',
    note: 'Hit points 1 and flammable, so fire spreads through it.',
  },
]

for (const entry of TERRAIN) {
  Object.freeze(entry.rgb)
  Object.freeze(entry)
}
Object.freeze(TERRAIN)

/** hex -> entry, built once. */
const BY_HEX = new Map(TERRAIN.map((e) => [e.hex, e]))

/**
 * Look a colour up by hex. Accepts `#rrggbb` and `rrggbb`, any case.
 * @param {string} hex
 * @returns {TerrainEntry|null} null for any colour the game does not answer to,
 *   which is itself meaningful: such a cell is silently left Empty on load.
 */
function byHex(hex) {
  if (typeof hex !== 'string') return null
  const key = hex.trim().replace(/^#/, '').toLowerCase()
  if (!/^[0-9a-f]{6}$/.test(key)) return null
  return BY_HEX.get('#' + key) || null
}

/**
 * Look a colour up by channel values.
 * @param {number} r @param {number} g @param {number} b
 * @returns {TerrainEntry|null}
 */
function byRgb(r, g, b) {
  for (const v of [r, g, b]) {
    if (!Number.isInteger(v) || v < 0 || v > 255) return null
  }
  return BY_HEX.get('#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')) || null
}

/**
 * The entries the editor may offer: one row per distinct outcome.
 *
 * Two filters, and they are not the same filter.
 *
 *  - `broken` is dropped because the game refuses those colours outright.
 *  - A row whose label repeats one already offered is dropped because several
 *    of these colours resolve to the identical material. Seven labels appear
 *    twice or three times - the format simply spells those materials more than
 *    one way - and a picker showing "Dune sand" twice asks an author to choose
 *    between two things that are not different. The label is the promise a row
 *    makes about what the player gets, so identical labels are identical
 *    outcomes, and that is the property being deduplicated.
 *
 * This narrows only what is *offered*. `TERRAIN` keeps every row, so `byHex`,
 * `byRgb` and the validator still recognise all of them in a map somebody else
 * made - and the survivor's own note names the colour it stands in for.
 *
 * The row kept is the first in `TERRAIN`, which is the one the game's own
 * resolver reaches first for that material.
 * @returns {TerrainEntry[]}
 */
function paintable() {
  const offered = new Set()
  return TERRAIN.filter((e) => {
    if (e.kind === 'broken' || offered.has(e.label)) return false
    offered.add(e.label)
    return true
  })
}

/** Dirt: the solid that the starting shovel can dig from the first minute. */
const DEFAULT_SOLID = byRgb(0, 0, 0)

/** The only air colour with no side effects - the editor's eraser. */
const DEFAULT_EMPTY = byRgb(153, 0, 0)

module.exports = {
  TERRAIN,
  byHex,
  byRgb,
  paintable,
  DEFAULT_SOLID,
  DEFAULT_EMPTY,
  KINDS,
}
