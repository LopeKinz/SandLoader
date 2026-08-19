'use strict'
/**
 * The problem registry: every failure the loader survived, kept for display.
 *
 * SandLoader's first rule is that a working unmodded game beats a half-patched
 * broken one, and its second is that one bad mod must not take the others
 * down. Both are already enforced by the code paths that catch - but a caught
 * error nobody ever sees is only half a policy. A player whose mod silently
 * did nothing has no way to tell a broken mod from a mod that loaded fine and
 * simply has no visible effect.
 *
 * So every failure lands here, attributed to the mod that caused it, and the
 * in-game manager shows the list. The loader keeps going regardless; this is a
 * record, not a control flow.
 *
 * Deliberately dependency-free and total: `record()` must be safe to call from
 * inside a catch block that is already handling something going wrong, so it
 * never throws and never allocates anything it cannot afford.
 */

/** Beyond this a log file is the right tool, and memory is not. */
const MAX_PROBLEMS = 500

/**
 * @typedef {Object} Problem
 * @property {string} id         Stable per-entry id, for the UI.
 * @property {string} code       SmlnError code, or 'E_UNKNOWN'.
 * @property {'error'|'warn'} severity
 * @property {string} scope      Subsystem: 'mods', 'patch', 'interceptor', ...
 * @property {string|null} modId Owning mod, when the failure can be attributed.
 * @property {string} message
 * @property {string} [detail]   Stack or extra context, for the details view.
 * @property {string} at         ISO timestamp.
 * @property {number} count      Repeats of an identical problem are counted,
 *                               not appended - a mod failing every frame must
 *                               not push everything else out of the list.
 */

/** @type {Problem[]} */
let problems = []
let seq = 0
let overflowed = 0

/**
 * Identity of a problem, for de-duplication. The fields are joined with a
 * separator that cannot occur in any of them - without one, scope "a" plus
 * mod "bc" would collide with scope "ab" plus mod "c".
 */
function keyOf(p) {
  return [p.scope, p.modId || '', p.code, p.message].join('\u0001')
}

/**
 * Record a survived failure.
 *
 * @param {Object} input
 * @param {unknown} input.error       An Error, SmlnError or string.
 * @param {string} [input.scope]
 * @param {string} [input.modId]
 * @param {'error'|'warn'} [input.severity]
 * @param {string} [input.detail]
 * @returns {Problem|null}
 */
function record(input) {
  try {
    const e = input && input.error
    const isError = e && typeof e === 'object' && 'message' in e
    const entry = {
      id: 'p' + (++seq),
      code: (e && e.code) || 'E_UNKNOWN',
      severity: input.severity === 'warn' ? 'warn' : 'error',
      scope: input.scope || 'smln',
      modId: input.modId || (e && e.detail && e.detail.mod) || null,
      message: isError ? String(e.message) : String(e),
      detail: input.detail || (e && e.stack) || undefined,
      at: new Date().toISOString(),
      count: 1,
    }

    const k = keyOf(entry)
    const existing = problems.find((p) => keyOf(p) === k)
    if (existing) {
      existing.count++
      existing.at = entry.at
      return existing
    }

    if (problems.length >= MAX_PROBLEMS) {
      // Drop the oldest rather than refusing new ones: the most recent failure
      // is almost always the one being investigated.
      problems.shift()
      overflowed++
    }
    problems.push(entry)
    return entry
  } catch (_) {
    // record() is called from catch blocks. It failing must not become the
    // failure the caller reports.
    return null
  }
}

/** Record many at once, e.g. the error array a discovery pass returns. */
function recordAll(errors, common) {
  const out = []
  for (const error of errors || []) {
    const p = record({ ...common, error })
    if (p) out.push(p)
  }
  return out
}

/** @returns {Problem[]} newest first */
function list(filter) {
  let out = problems.slice().reverse()
  if (filter && filter.modId) out = out.filter((p) => p.modId === filter.modId)
  if (filter && filter.severity) out = out.filter((p) => p.severity === filter.severity)
  return out
}

/** Everything attributed to one mod. */
function forMod(modId) {
  return list({ modId })
}

function summary() {
  const errors = problems.filter((p) => p.severity === 'error').length
  const warnings = problems.length - errors
  const mods = [...new Set(problems.map((p) => p.modId).filter(Boolean))]
  return { total: problems.length, errors, warnings, mods, overflowed }
}

/** Cleared on a reload, so the panel reflects the current launch. */
function clear() {
  problems = []
  overflowed = 0
  return true
}

/** Plain-data form for the renderer. */
function toJSON() {
  return { problems: list(), summary: summary() }
}

module.exports = { record, recordAll, list, forMod, summary, clear, toJSON, MAX_PROBLEMS }
