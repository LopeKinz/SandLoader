'use strict'
/**
 * Detect that the game changed, re-resolve the hooks, and say what happened.
 *
 * WHAT THIS CAN AND CANNOT DO - stated first, because the difference matters.
 *
 * SandLoader's hooks anchor on strings the game's *source* controls:
 * `"game:ready"`, `"ui|mainMenu|mods"`, `.modsScreen.open`. A minifier renames
 * everything around them but never the literals themselves. Comparing 0.5.4
 * with 0.5.5 shows exactly that and nothing else:
 *
 *     0.5.4   ie.FH.events.emit(p,"game:ready",{state:p})
 *     0.5.5   ie.FH.events.emit(g,"game:ready",{state:g})
 *     0.5.4   (0,$s.t)("ui|mainMenu|mods")
 *     0.5.5   (0,Gs.t)("ui|mainMenu|mods")
 *
 * So the realistic failure is not "the hook is gone", it is "the shape around
 * the literal shifted". This module handles that: each patch may declare
 * ordered `variants` - progressively looser patterns anchored on the *same*
 * invariant literal - and when the primary stops matching, the next one that
 * resolves cleanly is adopted.
 *
 * It cannot invent a hook. If the game removes `"game:ready"` outright, no
 * amount of scanning finds a semantic replacement, and pretending otherwise
 * would be worse than failing: SandLoader would serve a bundle patched at a
 * place nobody chose. When nothing resolves, this reports where the literal
 * still appears so a human can write the new anchor in minutes, and the loader
 * falls back to serving the file unmodified.
 *
 * Every adopted variant is gated on the patched source still *parsing*. That is
 * a real check and a cheap one; it is not proof the hook is semantically right,
 * and this file does not claim it is.
 */

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const { SmlnError } = require('../core/errors')
const engine = require('./engine')

const STATE_FILE = 'anchors.json'
const STATE_VERSION = 1
/** Context shown around a literal when a hook cannot be re-resolved. */
const DIAG_RADIUS = 110
const MAX_DIAG_HITS = 6

// ------------------------------------------------------------- fingerprint

/**
 * Cheap identity of an installation. Deliberately does not hash the bundle:
 * that means reading megabytes on every launch to answer a question the file
 * metadata already answers. The full re-scan happens only when this changes.
 *
 * @param {{version:string, asar:string}} install
 * @returns {{version:string, size:number, mtimeMs:number, key:string}}
 */
function fingerprint(install) {
  let size = 0
  let mtimeMs = 0
  try {
    // Inside Electron the asar layer reports the archive as a directory, so
    // stat it with that translation disabled - same reason locate.js does.
    const previous = process.noAsar
    process.noAsar = true
    try {
      const st = fs.statSync(install.asar)
      size = st.size
      mtimeMs = Math.floor(st.mtimeMs)
    } finally { process.noAsar = previous }
  } catch (_) { /* an unreadable archive is reported elsewhere */ }

  return {
    version: String(install.version || 'unknown'),
    size,
    mtimeMs,
    key: `${install.version}|${size}|${mtimeMs}`,
  }
}

function statePath(dir) { return path.join(dir, STATE_FILE) }

/** @returns {{version:number, fingerprint:any, adopted:Record<string,string>, checkedAt:string}|null} */
function readState(dir) {
  try {
    const file = statePath(dir)
    if (!fs.existsSync(file)) return null
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || parsed.version !== STATE_VERSION) return null
    return parsed
  } catch (_) {
    // A corrupt record just means "re-scan", which is the safe direction.
    return null
  }
}

function writeState(dir, state) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = statePath(dir)
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ version: STATE_VERSION, ...state }, null, 2))
    fs.renameSync(tmp, file)
    return true
  } catch (_) {
    return false
  }
}

/**
 * Did anything about the installation change since the last recorded scan?
 * @returns {{changed:boolean, first:boolean, reasons:string[]}}
 */
function compare(previous, next) {
  if (!previous || !previous.fingerprint) {
    return { changed: true, first: true, reasons: ['no previous scan on record'] }
  }
  const prev = previous.fingerprint
  const reasons = []
  if (prev.version !== next.version) reasons.push(`game version ${prev.version} -> ${next.version}`)
  if (prev.size !== next.size) reasons.push(`app.asar size ${prev.size} -> ${next.size}`)
  if (prev.mtimeMs !== next.mtimeMs) reasons.push('app.asar was rewritten')
  return { changed: reasons.length > 0, first: false, reasons }
}

// ---------------------------------------------------------------- healing

/** The invariant a patch is really anchored on, for diagnostics. */
function literalOf(patch) {
  if (patch.anchorLiteral) return patch.anchorLiteral
  if (typeof patch.find === 'string') return patch.find
  return null
}

function expectOf(p) { return p.expect == null ? 1 : p.expect }

function satisfies(count, expect) {
  return expect === 'any' ? count > 0 : count === expect
}

/**
 * Does `source` still parse after this patch is applied?
 *
 * The one automated correctness gate worth having. A variant that produces
 * syntactically broken output is definitively wrong, and catching that here is
 * far better than shipping it to the renderer. It says nothing about whether
 * the hook lands in the right place - only a human reading it can say that.
 */
function parses(source) {
  try {
    // eslint-disable-next-line no-new
    new vm.Script(source, { filename: 'heal-probe.js' })
    return true
  } catch (_) {
    return false
  }
}

/**
 * Try one candidate against the source.
 * @returns {{ok:boolean, count:number, reason?:string}}
 */
function tryCandidate(source, candidate, opts) {
  let count
  try {
    count = engine.probe(source, candidate.find).count
  } catch (e) {
    return { ok: false, count: 0, reason: 'pattern did not compile: ' + (e && e.message) }
  }

  const expect = expectOf(candidate)
  if (!satisfies(count, expect)) {
    return { ok: false, count, reason: `expected ${expect} match(es), found ${count}` }
  }

  if (opts && opts.validate === false) return { ok: true, count }

  // Apply in isolation and confirm the result is still valid JavaScript.
  let patched
  try {
    patched = source.replace(engine.toRegExp(candidate.find), /** @type {any} */ (candidate.replace))
  } catch (e) {
    return { ok: false, count, reason: 'replacement threw: ' + (e && e.message) }
  }
  if (!parses(patched)) {
    return { ok: false, count, reason: 'the patched source no longer parses' }
  }
  return { ok: true, count }
}

/**
 * Re-resolve a patch list against the current bundle.
 *
 * Returns a NEW array; the caller's patches are never mutated. A patch that
 * still resolves is passed through untouched, so the common case costs one
 * probe per patch and nothing else.
 *
 * @param {string} source
 * @param {import('./engine').Patch[]} patches
 * @param {{logger?:any, validate?:boolean}} [opts]
 */
function heal(source, patches, opts = {}) {
  const logger = opts.logger
  /** @type {import('./engine').Patch[]} */
  const out = []
  const holding = []
  const healed = []
  const broken = []

  for (const patch of patches) {
    // The primary is the pattern that shipped and was tested against a real
    // build, so it is probed but not parse-validated. Parsing a 4 MB bundle
    // once per patch would cost seconds on every game update to re-confirm
    // something already known. Variants are unproven and do get validated.
    const primary = tryCandidate(source, patch, { ...opts, validate: false })
    if (primary.ok) {
      out.push(patch)
      holding.push({ id: patch.id, matches: primary.count })
      continue
    }

    const variants = Array.isArray(patch.variants) ? patch.variants : []
    let adopted = null
    const tried = [{ label: 'primary', reason: primary.reason }]

    for (let i = 0; i < variants.length; i++) {
      const v = variants[i]
      // A variant inherits everything it does not override, so a fallback only
      // has to state what actually differs.
      const candidate = {
        ...patch,
        ...v,
        id: patch.id,
        owner: patch.owner,
        variantLabel: v.label || `variant ${i + 1}`,
      }
      const result = tryCandidate(source, candidate, opts)
      if (result.ok) { adopted = { candidate, count: result.count }; break }
      tried.push({ label: candidate.variantLabel, reason: result.reason })
    }

    if (adopted) {
      out.push(adopted.candidate)
      healed.push({
        id: patch.id,
        owner: patch.owner,
        variant: adopted.candidate.variantLabel,
        matches: adopted.count,
        primaryReason: primary.reason,
      })
      logger && logger.warn(
        `patch "${patch.id}": the primary anchor stopped matching (${primary.reason}); ` +
        `re-resolved with "${adopted.candidate.variantLabel}" (${adopted.count} match(es))`
      )
      continue
    }

    // Nothing resolved. Keep the original so the engine reports it the way it
    // always has, and attach a diagnostic pointing at the literal.
    out.push(patch)
    const diag = diagnose(source, patch)
    broken.push({
      id: patch.id,
      owner: patch.owner,
      required: patch.required !== false,
      tried,
      diagnostic: diag,
    })
    logger && logger.error(
      `patch "${patch.id}" could not be re-resolved: ` +
      tried.map((t) => `${t.label} (${t.reason})`).join('; ')
    )
  }

  return {
    patches: out,
    report: { holding, healed, broken, total: patches.length },
  }
}

/**
 * Where does this patch's invariant literal still appear?
 *
 * Not a fix - a shortcut for the person who has to write the new anchor. If
 * the literal is still in the bundle, the hook point almost certainly still
 * exists and only its shape moved, and these excerpts show the new shape.
 */
function diagnose(source, patch) {
  const literal = literalOf(patch)
  if (!literal) {
    return { literal: null, found: 0, hits: [], note: 'this patch declares no invariant literal to search for' }
  }

  const hits = []
  let from = 0
  while (hits.length < MAX_DIAG_HITS) {
    const at = source.indexOf(literal, from)
    if (at < 0) break
    const start = Math.max(0, at - DIAG_RADIUS)
    const end = Math.min(source.length, at + literal.length + DIAG_RADIUS)
    hits.push({
      index: at,
      excerpt: (start > 0 ? '...' : '') + source.slice(start, end) + (end < source.length ? '...' : ''),
    })
    from = at + literal.length
  }

  let found = 0
  let scan = 0
  while (true) {
    const at = source.indexOf(literal, scan)
    if (at < 0) break
    found++
    scan = at + literal.length
    if (found > 1000) break
  }

  return {
    literal,
    found,
    hits,
    note: found
      ? 'the literal is still present, so the hook point likely survived and only its shape changed'
      : 'the literal is gone from this build - the hook point itself was removed or renamed',
  }
}

/** Human-readable form of a heal report, for the log. */
function formatReport(report, fingerprintInfo) {
  const lines = []
  lines.push('anchor scan' + (fingerprintInfo ? ` for game ${fingerprintInfo.version}` : ''))
  lines.push(`  ${report.holding.length}/${report.total} anchor(s) still resolve`)
  for (const h of report.healed) {
    lines.push(`  RE-RESOLVED ${h.id} via ${h.variant} (${h.matches} match(es))`)
    lines.push(`      primary failed: ${h.primaryReason}`)
  }
  for (const b of report.broken) {
    lines.push(`  UNRESOLVED  ${b.id}${b.required ? ' (required)' : ' (optional)'}`)
    for (const t of b.tried) lines.push(`      ${t.label}: ${t.reason}`)
    const d = b.diagnostic
    if (d && d.literal) {
      lines.push(`      literal ${JSON.stringify(d.literal)} found ${d.found} time(s) - ${d.note}`)
      for (const hit of d.hits.slice(0, 2)) lines.push(`        @${hit.index} ${hit.excerpt}`)
    }
  }
  return lines.join('\n')
}

/**
 * The whole flow, for the caller that just wants it done.
 *
 * @param {Object} opts
 * @param {any} opts.install        from asar/locate
 * @param {() => string} opts.readBundle  reads the renderer bundle, only called when needed
 * @param {import('./engine').Patch[]} opts.patches
 * @param {string} opts.configDir
 * @param {any} [opts.logger]
 * @param {boolean} [opts.force]    scan even when nothing changed
 */
function run(opts) {
  const logger = opts.logger
  const next = fingerprint(opts.install)
  const previous = readState(opts.configDir)
  const delta = compare(previous, next)

  if (!delta.changed && !opts.force) {
    return {
      scanned: false,
      changed: false,
      fingerprint: next,
      patches: opts.patches,
      report: null,
      reasons: [],
    }
  }

  logger && logger.info(
    delta.first
      ? 'first run against this installation - scanning hook anchors'
      : `the game changed (${delta.reasons.join('; ')}) - re-scanning hook anchors`
  )

  let source
  try {
    source = opts.readBundle()
  } catch (e) {
    // Without the bundle nothing can be re-resolved; leave the patches alone
    // and let the interceptor report whatever happens at serve time.
    const err = new SmlnError('E_IO', `could not read the renderer bundle to verify hooks: ${e && e.message}`)
    logger && logger.error(String(err))
    return {
      scanned: false, changed: true, fingerprint: next, patches: opts.patches,
      report: null, reasons: delta.reasons, error: err,
    }
  }

  const { patches, report } = heal(source, opts.patches, { logger })
  logger && logger.info(formatReport(report, next))

  writeState(opts.configDir, {
    fingerprint: next,
    checkedAt: new Date().toISOString(),
    adopted: report.healed.reduce((acc, h) => { acc[h.id] = h.variant; return acc }, {}),
    unresolved: report.broken.map((b) => b.id),
  })

  return { scanned: true, changed: true, fingerprint: next, patches, report, reasons: delta.reasons }
}

module.exports = {
  run, heal, diagnose, compare, fingerprint,
  readState, writeState, formatReport, literalOf, parses,
  STATE_FILE, STATE_VERSION,
}
