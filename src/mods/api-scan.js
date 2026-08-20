'use strict'
/**
 * Which Sandkit namespaces does a mod actually need, and does this build have
 * them?
 *
 * Sandustry's Sandkit exists in two generations. 0.5.x ships the legacy surface
 * (`api.elements.createAt(state, ...)`); mods on the sandustry-mods index are
 * written against v1 (`api.elements.createAtCellWhenIdle(...)`). The renderer
 * adapter translates the ~36 calls that were merely renamed, but it cannot
 * invent namespaces the build does not have - `api.effects.*`,
 * `api.tech.registerNode`, `api.sprites.loadFromMod` simply do not exist here.
 *
 * A mod needing one of those loads fine and then throws the moment that code
 * path runs - often long after startup, in a tooltip or on a button press. From
 * the player's side that is indistinguishable from a mod that does nothing.
 *
 * So: read what each mod calls, compare against what the build offers, and let
 * the manager say so up front. Static source scanning is deliberate - it sees
 * calls on paths that never execute, which is exactly the point. Running the
 * mod to find out would defeat the purpose.
 *
 * The scan is intentionally conservative. It reports what it can prove from the
 * source text and stays quiet otherwise; a false "unsupported" would train
 * players to ignore the warning, which costs more than the warning gains.
 */

/**
 * Namespaces reached through the Sandkit facade. Anchored on the two spellings
 * mods actually use:
 *
 *   const api = sandkit.api;  api.elements.createAtCellWhenIdle(...)
 *   sandkit.api.elements.getTypeFromId(...)
 *
 * Both reduce to `<root>.<namespace>.<method>`, so one pattern covers them once
 * the root alias is known.
 */
const CALL_RE = /\b(?:api|sandkit\.api)\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g

/** Direct `sandkit.<field>` reads: react, enums, engine, state, settings. */
const FIELD_RE = /\bsandkit\.([A-Za-z_$][\w$]*)/g

/**
 * Fields on the sandkit object that are not API namespaces, so a mod reading
 * them tells us nothing about namespace support.
 */
const NON_NAMESPACE = new Set(['api', 'apiVersion', 'state', 'engine', 'enums', 'react', 'settings'])

/**
 * Strip comments and string literals before scanning.
 *
 * Without this, prose in a header comment ("uses api.effects.* for glow") and
 * documentation strings register as real calls. Mods here ship long explanatory
 * headers, so this is not hypothetical.
 *
 * A character scanner rather than a regex: nested quotes inside comments and
 * apostrophes inside prose defeat any single expression, and getting this wrong
 * produces exactly the false positives the module must not emit.
 */
function stripNonCode(src) {
  let out = ''
  let i = 0
  const n = src.length

  while (i < n) {
    const c = src[i]
    const d = src[i + 1]

    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && d === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      i++
      while (i < n && src[i] !== quote) {
        // A backslash escapes the next character, including the quote itself.
        if (src[i] === '\\') i++
        i++
      }
      i++
      // Preserve a space so `a."x".b` cannot fuse into a false identifier.
      out += ' '
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * Extract the Sandkit surface one mod source touches.
 *
 * @param {string} source
 * @returns {{namespaces:Record<string,string[]>, fields:string[]}}
 */
function scan(source) {
  const code = stripNonCode(String(source || ''))
  const namespaces = {}
  const fields = new Set()

  let m
  CALL_RE.lastIndex = 0
  while ((m = CALL_RE.exec(code))) {
    const [, ns, method] = m
    if (NON_NAMESPACE.has(ns)) continue
    ;(namespaces[ns] || (namespaces[ns] = new Set())).add(method)
  }

  FIELD_RE.lastIndex = 0
  while ((m = FIELD_RE.exec(code))) fields.add(m[1])

  const out = {}
  for (const [ns, set] of Object.entries(namespaces)) out[ns] = [...set].sort()
  return { namespaces: out, fields: [...fields].sort() }
}

/**
 * Compare a scan against the live API surface.
 *
 * `available` is the adapted API object as the renderer sees it (SMLN.api), so
 * a name the adapter aliases counts as present - which is correct: the mod's
 * call will work.
 *
 * A namespace missing entirely is reported as `missingNamespaces`; a namespace
 * that exists but lacks specific methods is `missingMethods`. The distinction
 * matters to a player: the first means a whole feature is absent, the second
 * usually means one button will not work.
 *
 * @returns {{missingNamespaces:string[], missingMethods:Array<{ns:string,methods:string[]}>, ok:boolean}}
 */
function compare(scanned, available) {
  const missingNamespaces = []
  const missingMethods = []

  if (!available || typeof available !== 'object') {
    // No API to compare against. Report nothing rather than everything: a
    // capture failure is a different problem with its own reporting, and
    // flagging every namespace here would bury it.
    return { missingNamespaces: [], missingMethods: [], ok: true, inconclusive: true }
  }

  for (const [ns, methods] of Object.entries(scanned.namespaces || {})) {
    const live = available[ns]
    if (!live || typeof live !== 'object') {
      missingNamespaces.push(ns)
      continue
    }
    const gone = methods.filter((name) => typeof live[name] !== 'function')
    if (gone.length) missingMethods.push({ ns, methods: gone })
  }

  return {
    missingNamespaces: missingNamespaces.sort(),
    missingMethods: missingMethods.sort((a, b) => a.ns.localeCompare(b.ns)),
    ok: missingNamespaces.length === 0 && missingMethods.length === 0,
  }
}

/** Short line for the manager row: "needs effects, tech" or null when fine. */
function summarise(result) {
  if (!result || result.ok || result.inconclusive) return null
  const parts = []
  if (result.missingNamespaces.length) parts.push(result.missingNamespaces.join(', '))
  for (const g of result.missingMethods) parts.push(g.ns + '.' + g.methods.join('/'))
  return parts.join(', ')
}

module.exports = { scan, compare, summarise, stripNonCode, NON_NAMESPACE }
