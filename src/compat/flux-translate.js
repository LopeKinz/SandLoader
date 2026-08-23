'use strict'
/**
 * Value translation between the Fluxloader mod format and Sandustry 0.5.5.
 *
 * corelib was written against a build that spelled an element
 * `{name:"Cinder", matterType:X.Slushy}`. 0.5.5 spells the same entry
 * `{nameKey:"elements|basalt|name", matterType:6}` - a localisation key and a
 * plain number. These functions convert one to the other.
 *
 * Every function returns {ok, value} | {ok:false, reason} rather than throwing
 * or falling back to a default. A wrong matterType puts an element in the
 * wrong physics class, where it behaves subtly incorrectly forever; a refused
 * registration with a reason is recoverable.
 */

/**
 * Map a Fluxloader matter type name onto this build's numeric id.
 * @param {string} name       e.g. "Slushy"
 * @param {object} enumTable  the live bidirectional MatterType enum
 */
function matterTypeToNumber(name, enumTable) {
  const table = enumTable || {}
  if (typeof name !== 'string' || !name) {
    return { ok: false, reason: 'matterType must be a string, got ' + typeof name }
  }
  const value = table[name]
  if (typeof value === 'number') return { ok: true, value }

  // Name the valid options: the author's next action is picking one.
  const valid = Object.keys(table).filter((k) => typeof table[k] === 'number')
  return {
    ok: false,
    reason: `matterType "${name}" does not exist on this game build ` +
      `(valid: ${valid.join(', ')})`,
  }
}

/**
 * The localisation key 0.5.5 stores instead of a display name. The game
 * derives this same key from a `name` when one is passed to its own register,
 * so the two spellings agree.
 */
function nameKeyFor(id, kind) {
  const s = String(id || '')
  // Each content type has its own namespace, and they are not interchangeable:
  // the game's own entries read `terrains|solidite|name` and
  // `structures|conveyor|name`. A soil filed under the element namespace
  // resolves to nothing and shows as "[MISSING: elements|trashSoil|name]" on
  // the hover tooltip. Verified against the 0.5.5 bundle.
  const NS = { terrain: 'terrains', structure: 'structures', item: 'items' }
  const ns = NS[kind] || 'elements'
  return ns + '|' + (s.charAt(0).toLowerCase() + s.slice(1)) + '|name'
}

/** Pack [r,g,b,a] into the 24-bit integer the registry stores as metaColor. */
function rgbaToMetaColor(rgba) {
  if (!Array.isArray(rgba) || rgba.length < 3) {
    return { ok: false, reason: 'a colour needs at least [r, g, b]' }
  }
  const [r, g, b] = rgba
  if (![r, g, b].every((c) => typeof c === 'number' && c >= 0 && c <= 255)) {
    return { ok: false, reason: `colour channels must be 0-255, got [${rgba.join(', ')}]` }
  }
  return { ok: true, value: (Math.round(r) << 16) + (Math.round(g) << 8) + Math.round(b) }
}

/**
 * corelib declares soil colours as HSL with s/l given in percent, which is
 * what its own `colorHSL` field means. Elements everywhere else are RGBA.
 */
function hslToRgba(hsl) {
  if (!Array.isArray(hsl) || hsl.length < 3) {
    return { ok: false, reason: 'colorHSL needs [h, s, l]' }
  }
  const [h, s, l] = hsl
  if (![h, s, l].every((n) => typeof n === 'number')) {
    return { ok: false, reason: `colorHSL must be numbers, got [${hsl.join(', ')}]` }
  }
  const sN = s / 100
  const lN = l / 100
  const c = (1 - Math.abs(2 * lN - 1)) * sN
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const m = lN - c / 2
  let rgb
  if (hp < 1) rgb = [c, x, 0]
  else if (hp < 2) rgb = [x, c, 0]
  else if (hp < 3) rgb = [0, c, x]
  else if (hp < 4) rgb = [0, x, c]
  else if (hp < 5) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return { ok: true, value: rgb.map((v) => Math.round((v + m) * 255)).concat(255) }
}

/**
 * The colour shape the game's draw path expects: `{variants: [[r,g,b,a], ...]}`.
 * Accepts either spelling so a mod that already wrapped its colours is not
 * double-wrapped.
 */
function toVariants(colors) {
  if (colors && !Array.isArray(colors) && Array.isArray(colors.variants)) return colors
  return { variants: Array.isArray(colors) ? colors : [] }
}

/**
 * Convert one `corelib.elements.registerElement(config)` argument into the
 * definition `SMLN.register.element` expects.
 *
 * `colors` is reshaped, not passed through. Sandkit's colour installer is a
 * bare assignment - `scheme.element[type] = colors` - so whatever shape arrives
 * is what the renderer later reads. Every built-in entry is
 * `{variants: [[r,g,b,a], ...]}`, and the draw path indexes `.variants`, so a
 * Fluxloader mod's flat array lands as `undefined` there and spawning the
 * element throws "Cannot read properties of undefined (reading '3')".
 */
function translateElement(config, enumTable) {
  const c = config || {}
  if (!c.id || typeof c.id !== 'string') {
    return { ok: false, reason: 'an element needs a string "id"' }
  }

  const matter = matterTypeToNumber(c.matterType == null ? 'Solid' : c.matterType, enumTable)
  if (!matter.ok) return { ok: false, reason: `element "${c.id}": ${matter.reason}` }

  // Accept both spellings: a Fluxloader mod's flat array, and the wrapped
  // {variants: [...]} the game itself stores. Testing only for an array
  // silently dropped the wrapped form to nothing.
  const colors = Array.isArray(c.colors)
    ? c.colors
    : (c.colors && Array.isArray(c.colors.variants) ? c.colors.variants : [])
  const def = {
    id: c.id,
    // Passing `name` lets the game register the English fallback itself; the
    // explicit nameKey keeps the entry readable if it ever inspects it first.
    name: c.name || c.id,
    nameKey: nameKeyFor(c.id),
    density: typeof c.density === 'number' ? c.density : 100,
    matterType: matter.value,
    // The shape the renderer reads: a mod already using {variants: [...]} is
    // left alone, a flat Fluxloader array is wrapped.
    colors: colors.length ? toVariants(colors) : colors,
  }

  if (colors.length) {
    const meta = rgbaToMetaColor(colors[0])
    if (!meta.ok) return { ok: false, reason: `element "${c.id}": ${meta.reason}` }
    def.metaColor = meta.value
  }
  if (Array.isArray(c.interactsWithHoverText)) def.interactions = c.interactsWithHoverText
  if (c.addToFilterList !== undefined) def.addToFilterList = !!c.addToFilterList

  return { ok: true, def }
}

/**
 * Convert `corelib.elements.registerSoil(config)`. Soils are mineable terrain
 * that drops an element, so the output fields travel with the definition.
 */
function translateSoil(config, enumTable) {
  const c = config || {}
  if (!c.id || typeof c.id !== 'string') {
    return { ok: false, reason: 'a soil needs a string "id"' }
  }

  const def = {
    id: c.id,
    name: c.name || c.id,
    nameKey: nameKeyFor(c.id, 'terrain'),
    hp: typeof c.hp === 'number' ? c.hp : 1,
    onlyRocketBreakable: !!c.onlyRocketBreakable,
  }

  if (Array.isArray(c.colorHSL)) {
    const rgba = hslToRgba(c.colorHSL)
    if (!rgba.ok) return { ok: false, reason: `soil "${c.id}": ${rgba.reason}` }
    def.colors = toVariants([rgba.value])
    const meta = rgbaToMetaColor(rgba.value)
    if (meta.ok) def.metaColor = meta.value
  } else if (Array.isArray(c.colors)) {
    def.colors = toVariants(c.colors)
  }

  if (c.outputElement) def.outputElement = c.outputElement
  if (typeof c.chanceForOutput === 'number') def.chanceForOutput = c.chanceForOutput
  if (Array.isArray(c.interactsWithHoverText)) def.interactions = c.interactsWithHoverText

  return { ok: true, def }
}

/**
 * A corelib block into a Sandkit structure definition.
 *
 * "Block" is corelib's word; Sandustry calls the same thing a structure, and
 * registers it through `structures.register`. The shape is a grid of cells
 * describing the machine's footprint - corelib passes it as `shape`, the game
 * reads `size` from its dimensions.
 *
 * Behaviour does not come across. corelib's blocks get their tick logic from
 * its own patches, and a mod whose patches no longer match this build gets a
 * structure that can be seen and placed but does nothing. That is deliberate:
 * an inert entry the player can find beats an invisible one they cannot.
 */
function translateBlock(config) {
  const c = config || {}
  if (!c.id || typeof c.id !== 'string') {
    return { ok: false, reason: 'a block needs a string "id"' }
  }

  const shape = Array.isArray(c.shape) ? c.shape : []
  const height = shape.length
  const width = height && Array.isArray(shape[0]) ? shape[0].length : 0
  if (!width || !height) {
    return { ok: false, reason: `block "${c.id}": needs a non-empty 2D "shape"` }
  }

  const def = {
    id: c.id,
    name: c.name || c.id,
    nameKey: nameKeyFor(c.id, 'structure'),
    description: typeof c.description === 'string' ? c.description : '',
    size: { width, height },
    shape,
  }

  // Only forward what the caller actually set: a `false` here means "off",
  // while an absent key means "let the game decide", and collapsing the two
  // would override the build's own defaults.
  if (c.imagePath != null) def.imagePath = String(c.imagePath)
  if (Array.isArray(c.angles)) def.angles = c.angles
  if (c.singleBuild !== undefined) def.singleBuild = !!c.singleBuild
  if (c.hasConfigMenu !== undefined) def.hasConfigMenu = !!c.hasConfigMenu
  if (c.hasHoverUI !== undefined) def.hasHoverUI = !!c.hasHoverUI
  if (typeof c.animationInterval === 'number') def.animationInterval = c.animationInterval

  return { ok: true, def }
}

/**
 * A corelib tech node into the shape `SMLN.sandkit.tech.registerNode` takes.
 *
 * corelib names the anchor `parent`; the shim reads `requires`, an array,
 * because a node may sit behind more than one prerequisite.
 *
 * `unlocks.structures` arrives prefixed with the bundle's minified namespace
 * ("d.Portal") because corelib's patches used to splice that string straight
 * into the bundle. Nothing evaluates it here, so the prefix is stripped back
 * to the bare structure id the registry actually knows.
 */
function translateTech(config) {
  const c = config || {}
  if (!c.id || typeof c.id !== 'string') {
    return { ok: false, reason: 'a tech node needs a string "id"' }
  }

  const def = {
    id: c.id,
    name: c.name || c.id,
    description: typeof c.description === 'string' ? c.description : '',
    cost: typeof c.cost === 'number' ? c.cost : 0,
  }

  if (typeof c.parent === 'string' && c.parent) def.requires = [c.parent]
  else if (Array.isArray(c.requires)) def.requires = c.requires.slice()

  const unlockedStructures = c.unlocks && Array.isArray(c.unlocks.structures)
    ? c.unlocks.structures
    : []
  if (unlockedStructures.length) {
    def.unlocks = {
      structures: unlockedStructures.map((s) => String(s).replace(/^[A-Za-z_$][\w$]*\./, '')),
    }
  }

  return { ok: true, def }
}

/**
 * A corelib upgrade into a flat record the renderer can install.
 *
 * corelib models upgrades as tab -> category -> upgrade. The `kind` says which
 * of the three this is, because they share one registry and the renderer has
 * to rebuild the nesting in order.
 */
function translateUpgrade(kind, config) {
  const c = config || {}
  if (!c.id || typeof c.id !== 'string') {
    return { ok: false, reason: `an upgrade ${kind} needs a string "id"` }
  }

  const def = { kind, id: c.id, name: c.name || c.id }
  if (typeof c.description === 'string') def.description = c.description
  if (typeof c.tabID === 'string') def.tabID = c.tabID
  if (typeof c.categoryID === 'string') def.categoryID = c.categoryID
  if (typeof c.maxLevel === 'number') def.maxLevel = c.maxLevel
  if (Array.isArray(c.costs)) def.costs = c.costs.slice()
  // A tab may be gated behind a tech node; the renderer needs the id to know
  // when to reveal it.
  if (c.requirement && typeof c.requirement.tech === 'string') {
    def.requiresTech = c.requirement.tech
  }

  return { ok: true, def }
}

module.exports = {
  toVariants,
  matterTypeToNumber, nameKeyFor, rgbaToMetaColor, hslToRgba,
  translateElement, translateSoil,
  translateBlock, translateTech, translateUpgrade,
}
