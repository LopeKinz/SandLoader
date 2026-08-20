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
function nameKeyFor(id) {
  const s = String(id || '')
  return 'elements|' + (s.charAt(0).toLowerCase() + s.slice(1)) + '|name'
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
 * Convert one `corelib.elements.registerElement(config)` argument into the
 * definition `SMLN.register.element` expects.
 *
 * `colors` is passed through rather than consumed: Sandkit's own
 * `elements.register` installs `def.colors` into the session colour scheme, so
 * converting them here would do the work twice and disagree with the built-ins.
 */
function translateElement(config, enumTable) {
  const c = config || {}
  if (!c.id || typeof c.id !== 'string') {
    return { ok: false, reason: 'an element needs a string "id"' }
  }

  const matter = matterTypeToNumber(c.matterType == null ? 'Solid' : c.matterType, enumTable)
  if (!matter.ok) return { ok: false, reason: `element "${c.id}": ${matter.reason}` }

  const colors = Array.isArray(c.colors) ? c.colors : []
  const def = {
    id: c.id,
    // Passing `name` lets the game register the English fallback itself; the
    // explicit nameKey keeps the entry readable if it ever inspects it first.
    name: c.name || c.id,
    nameKey: nameKeyFor(c.id),
    density: typeof c.density === 'number' ? c.density : 100,
    matterType: matter.value,
    colors,
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
    nameKey: nameKeyFor(c.id),
    hp: typeof c.hp === 'number' ? c.hp : 1,
    onlyRocketBreakable: !!c.onlyRocketBreakable,
  }

  if (Array.isArray(c.colorHSL)) {
    const rgba = hslToRgba(c.colorHSL)
    if (!rgba.ok) return { ok: false, reason: `soil "${c.id}": ${rgba.reason}` }
    def.colors = [rgba.value]
    const meta = rgbaToMetaColor(rgba.value)
    if (meta.ok) def.metaColor = meta.value
  } else if (Array.isArray(c.colors)) {
    def.colors = c.colors
  }

  if (c.outputElement) def.outputElement = c.outputElement
  if (typeof c.chanceForOutput === 'number') def.chanceForOutput = c.chanceForOutput
  if (Array.isArray(c.interactsWithHoverText)) def.interactions = c.interactsWithHoverText

  return { ok: true, def }
}

module.exports = {
  matterTypeToNumber, nameKeyFor, rgbaToMetaColor, hslToRgba,
  translateElement, translateSoil,
}
