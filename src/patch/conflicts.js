'use strict'
/**
 * Preflight conflict analysis for the patch engine.
 *
 * `engine.apply` runs patches sequentially: each one rewrites the text as it
 * stands after every patch before it. That is fine when two mods touch
 * different corners of the bundle, and silently wrong when they don't. If
 * mod A and mod B both anchor near the same call site, whichever patch runs
 * second sees text mod A already rewrote - its `find` may still match (source
 * literals are usually untouched by a neighbouring edit) and it happily
 * clobbers mod A's change, or worse, mangles it into something that only
 * fails at runtime, deep in a worker, with a stack trace that names neither
 * mod. Nobody who reports that bug can point at what caused it.
 *
 * This module runs *before* `engine.apply` touches anything. It computes the
 * real `[start, end)` character ranges every patch's anchor would rewrite in
 * the untouched source, and checks those ranges for overlap across mods.
 * Two patches from the *same* mod overlapping is that mod's own business -
 * it wrote both, it can order them - so only cross-owner overlap is a
 * conflict. Finding one is fatal by default: consistent with the engine's
 * all-or-nothing philosophy, a bundle nobody can safely reason about should
 * not load, not load-with-a-warning. The narrow escape hatch is
 * `allowOverlap: true`, and it only works when *both* patches carry it -
 * one mod cannot unilaterally waive a collision on another mod's behalf.
 */

const engine = require('./engine')
const { SmlnError } = require('../core/errors')

/**
 * @typedef {Object} MatchRange
 * @property {number} start   Inclusive character offset in `source`.
 * @property {number} end     Exclusive character offset in `source`.
 * @property {string} text    The matched substring, `source.slice(start,end)`.
 */

/**
 * @typedef {Object} PatchRanges
 * @property {string} id
 * @property {string} owner
 * @property {number} matches
 * @property {MatchRange[]} ranges
 */

/**
 * @typedef {Object} Conflict
 * @property {string} [target]
 * @property {{id:string, owner:string, range:{start:number,end:number}}} a
 * @property {{id:string, owner:string, range:{start:number,end:number}}} b
 * @property {{start:number,end:number}} overlap
 * @property {number} occurrences   How many range-pairs from this patch pair overlapped.
 * @property {string} context       Source excerpt around the overlap.
 * @property {boolean} fatal
 * @property {boolean} allowed      True when both sides opted in via `allowOverlap`.
 */

/**
 * @typedef {Object} Report
 * @property {string} [target]
 * @property {PatchRanges[]} patches
 * @property {Conflict[]} conflicts
 * @property {boolean} fatal
 * @property {{id:string, owner:string, reason:string}[]} unresolved
 */

const CONTEXT_RADIUS = 90

/** Same radius and ellipsis convention as `engine.js`'s excerpt, so log output reads consistently. */
function excerpt(source, index) {
  const from = Math.max(0, index - CONTEXT_RADIUS)
  const to = Math.min(source.length, index + CONTEXT_RADIUS)
  return (from > 0 ? '...' : '') + source.slice(from, to) + (to < source.length ? '...' : '')
}

/**
 * Run a patch's `find` over `source` and return every match's real position.
 * This is `engine.probe` with positions kept instead of thrown away - the
 * whole point of the preflight is knowing *where* a patch lands, not just
 * whether it does.
 * @param {string} source
 * @param {import('./engine').Patch} patch
 * @returns {{ok:true, ranges:MatchRange[]} | {ok:false, reason:string}}
 */
function ranges(source, patch) {
  let re
  try {
    re = engine.toRegExp(patch.find)
  } catch (e) {
    return { ok: false, reason: `find could not be compiled: ${e.message}` }
  }

  const out = []
  let count = 0
  let m
  while ((m = re.exec(source)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] })
    count++
    // Guard against a zero-width pattern spinning forever, same as engine.probe.
    if (m[0].length === 0) re.lastIndex++
    if (count > 1000) break
  }
  return { ok: true, ranges: out }
}

/** Two half-open intervals overlap iff each starts before the other ends. Touching does not count. */
function intersects(a, b) {
  return a.start < b.end && b.start < a.end
}

/**
 * Compute every patch's match ranges against the original source and report
 * cross-owner overlaps. Does not modify `source` or the patches.
 * @param {string} source
 * @param {import('./engine').Patch[]} patches
 * @param {{target?:string}} [opts]
 * @returns {Report}
 */
function analyse(source, patches, opts = {}) {
  const target = opts.target

  // Keyed by position, not by `p.id`: two mods may independently name a patch
  // "fix-1", and collapsing them into one map entry would hide exactly the
  // cross-mod overlap this function exists to find.
  /** @type {PatchRanges[]} */
  const info = []
  const unresolved = []

  for (const p of patches) {
    const owner = p.owner || 'smln'
    const result = ranges(source, p)

    if (!result.ok) {
      info.push({ id: p.id, owner, matches: 0, ranges: [] })
      unresolved.push({ id: p.id, owner, reason: result.reason })
      continue
    }

    info.push({ id: p.id, owner, matches: result.ranges.length, ranges: result.ranges })
    if (result.ranges.length === 0) {
      // Zero matches is not, by itself, a conflict-analysis failure - the engine
      // already owns whether a missing required anchor aborts the run. Here it
      // just means this patch contributes nothing to overlap checking.
      unresolved.push({
        id: p.id,
        owner,
        reason: `anchor did not match (${p.description || p.id})`,
      })
    }
  }

  /** @type {Conflict[]} */
  const conflicts = []

  for (let i = 0; i < patches.length; i++) {
    const infoA = info[i]
    if (!infoA.ranges.length) continue

    for (let j = i + 1; j < patches.length; j++) {
      const infoB = info[j]
      if (!infoB.ranges.length) continue
      if (infoA.owner === infoB.owner) continue // one mod's own overlap is not our call

      let first = null
      let occurrences = 0
      for (const ra of infoA.ranges) {
        for (const rb of infoB.ranges) {
          if (!intersects(ra, rb)) continue
          occurrences++
          if (!first) first = { ra, rb }
        }
      }
      if (!first) continue

      const overlap = {
        start: Math.max(first.ra.start, first.rb.start),
        end: Math.min(first.ra.end, first.rb.end),
      }
      const allowed = patches[i].allowOverlap === true && patches[j].allowOverlap === true

      conflicts.push({
        target,
        a: { id: infoA.id, owner: infoA.owner, range: { start: first.ra.start, end: first.ra.end } },
        b: { id: infoB.id, owner: infoB.owner, range: { start: first.rb.start, end: first.rb.end } },
        overlap,
        occurrences,
        context: excerpt(source, overlap.start),
        fatal: !allowed,
        allowed,
      })
    }
  }

  conflicts.sort((x, y) => x.overlap.start - y.overlap.start)

  return {
    target,
    patches: info,
    conflicts,
    fatal: conflicts.some((c) => c.fatal),
    unresolved,
  }
}

/**
 * `analyse` plus the fail-safe gate: any fatal conflict turns into a typed
 * error the caller can abort on, the same shape `engine.apply` already
 * returns for `E_PATCH_FAILED` / `E_PATCH_AMBIGUOUS`.
 * @param {string} source
 * @param {import('./engine').Patch[]} patches
 * @param {{target?:string}} [opts]
 * @returns {{ok:true, report:Report} | {ok:false, report:Report, error:SmlnError}}
 */
function preflight(source, patches, opts = {}) {
  const report = analyse(source, patches, opts)
  if (!report.fatal) return { ok: true, report }

  const fatalConflicts = report.conflicts.filter((c) => c.fatal)
  const first = fatalConflicts[0]
  const prefix = report.target ? `${report.target}: ` : ''
  let message =
    `${prefix}${first.a.owner}:${first.a.id} (${first.a.range.start}..${first.a.range.end}) overlaps ` +
    `${first.b.owner}:${first.b.id} (${first.b.range.start}..${first.b.range.end})`
  if (fatalConflicts.length > 1) {
    const rest = fatalConflicts.length - 1
    message += ` (+${rest} more conflict${rest === 1 ? '' : 's'})`
  }

  const error = new SmlnError('E_PATCH_CONFLICT', message, {
    detail: { target: report.target, conflicts: report.conflicts },
  })
  return { ok: false, report, error }
}

/**
 * Multi-line human report for the log. Mirrors the level of detail
 * `engine.js`'s excerpts give for a single failed patch, but for a pair.
 * @param {Report} report
 * @returns {string}
 */
function formatReport(report) {
  const target = report.target || '(unknown target)'
  const lines = []

  lines.push(`patch conflict report - ${target}`)
  lines.push(
    `  ${report.patches.length} patch(es) analysed, ${report.conflicts.length} conflict(s), ` +
      `${report.unresolved.length} unresolved anchor(s)`
  )

  if (report.conflicts.length) {
    lines.push('')
    lines.push('conflicts (source order):')
    for (const c of report.conflicts) {
      const verdict = c.fatal ? 'FATAL' : 'accepted (allowOverlap on both sides)'
      lines.push(`  [${verdict}] ${c.a.owner}:${c.a.id}  <->  ${c.b.owner}:${c.b.id}`)
      lines.push(`    a: ${c.a.owner}:${c.a.id}  range ${c.a.range.start}..${c.a.range.end}`)
      lines.push(`    b: ${c.b.owner}:${c.b.id}  range ${c.b.range.start}..${c.b.range.end}`)
      lines.push(
        `    overlap ${c.overlap.start}..${c.overlap.end}` +
          (c.occurrences > 1 ? `  (${c.occurrences} overlapping spans, showing first)` : '')
      )
      lines.push(`    context: ${c.context}`)
    }
  }

  if (report.unresolved.length) {
    lines.push('')
    lines.push('unresolved anchors:')
    for (const u of report.unresolved) {
      lines.push(`  ${u.owner}:${u.id} - ${u.reason}`)
    }
  }

  return lines.join('\n')
}

module.exports = { ranges, analyse, preflight, formatReport }
