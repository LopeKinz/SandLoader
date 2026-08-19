'use strict'
/**
 * Text patch engine for the renderer bundle.
 *
 * Design rule: never anchor on a byte offset, a minified identifier, or a
 * module id. Those are regenerated on every game build. Anchor on things the
 * game's *source* controls - string literals, event names, property names -
 * and let the minifier rename whatever it likes around them.
 *
 * Every patch declares how many matches it expects. Getting 0 is a failure;
 * getting more than expected is *also* a failure, because a pattern that
 * silently became ambiguous after an update would otherwise corrupt the bundle
 * in several places at once. Ambiguity is a bug, not a warning.
 */

const { SmlnError } = require('../core/errors')

/**
 * @typedef {Object} Patch
 * @property {string} id            Stable identifier, used in logs and configs.
 * @property {string} [owner]       Mod id that contributed it ('smln' for core).
 * @property {string} description   Why this patch exists, in one line.
 * @property {RegExp|string} find   Anchor. RegExp must carry the /g flag.
 * @property {string|((m:RegExpMatchArray)=>string)} replace
 * @property {number|'any'} [expect=1]  Required match count.
 * @property {boolean} [required=true]  If false, 0 matches is tolerated.
 */

/**
 * @typedef {Object} PatchOutcome
 * @property {string} id
 * @property {'applied'|'skipped'|'failed'} status
 * @property {number} matches
 * @property {string} [reason]
 * @property {string} [context]  Bundle excerpt around the first match, for triage.
 */

const CONTEXT_RADIUS = 90

/** Escape a literal so it can be used inside a RegExp. */
function escapeLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Normalise `find` into a global RegExp without mutating the caller's object. */
function toRegExp(find) {
  if (typeof find === 'string') return new RegExp(escapeLiteral(find), 'g')
  const flags = find.flags.includes('g') ? find.flags : find.flags + 'g'
  return new RegExp(find.source, flags)
}

/**
 * Count matches without consuming the expression the caller passed in.
 * @returns {{count:number, firstIndex:number}}
 */
function probe(source, find) {
  const re = toRegExp(find)
  let count = 0
  let firstIndex = -1
  let m
  while ((m = re.exec(source)) !== null) {
    if (firstIndex < 0) firstIndex = m.index
    count++
    // Guard against a zero-width pattern spinning forever.
    if (m[0].length === 0) re.lastIndex++
    if (count > 1000) break
  }
  return { count, firstIndex }
}

/**
 * Report whether each patch's anchor still resolves, without modifying
 * anything. This is the version-drift early warning: run it against a new game
 * build and every broken hook names itself before a player ever sees a crash.
 * @param {string} source
 * @param {Patch[]} patches
 * @returns {PatchOutcome[]}
 */
function verify(source, patches) {
  return patches.map((p) => {
    const { count, firstIndex } = probe(source, p.find)
    const expect = p.expect == null ? 1 : p.expect
    const ok = expect === 'any' ? count > 0 : count === expect
    return {
      id: p.id,
      status: ok ? 'applied' : count === 0 && p.required === false ? 'skipped' : 'failed',
      matches: count,
      reason: ok ? undefined : `expected ${expect} match(es), found ${count}`,
      context: firstIndex >= 0 ? excerpt(source, firstIndex) : undefined,
    }
  })
}

function excerpt(source, index) {
  const from = Math.max(0, index - CONTEXT_RADIUS)
  const to = Math.min(source.length, index + CONTEXT_RADIUS)
  return (from > 0 ? '...' : '') + source.slice(from, to) + (to < source.length ? '...' : '')
}

/**
 * Apply patches in order. A failing *required* patch aborts the whole run and
 * returns the original source untouched - a half-patched bundle is worse than
 * an unpatched one, because the failure surfaces as an incomprehensible
 * runtime error instead of a clear loader message.
 *
 * @param {string} source
 * @param {Patch[]} patches
 * @param {{logger?:{debug:Function,warn:Function,error:Function}}} [opts]
 * @returns {{source:string, outcomes:PatchOutcome[], ok:boolean, error?:SmlnError}}
 */
function apply(source, patches, opts = {}) {
  const log = opts.logger
  const original = source
  /** @type {PatchOutcome[]} */
  const outcomes = []
  let current = source

  for (const p of patches) {
    const expect = p.expect == null ? 1 : p.expect
    const required = p.required !== false
    const { count, firstIndex } = probe(current, p.find)
    const context = firstIndex >= 0 ? excerpt(current, firstIndex) : undefined

    if (count === 0) {
      const outcome = {
        id: p.id,
        status: required ? 'failed' : 'skipped',
        matches: 0,
        reason: `anchor did not match (${p.description})`,
      }
      outcomes.push(outcome)
      if (required) {
        log && log.error(`patch ${p.id}: anchor did not match - aborting, bundle left unpatched`)
        return {
          source: original,
          outcomes,
          ok: false,
          error: new SmlnError('E_PATCH_FAILED', `patch "${p.id}" anchor did not match`, {
            detail: { id: p.id, owner: p.owner, description: p.description },
          }),
        }
      }
      log && log.warn(`patch ${p.id}: optional anchor missing, skipped`)
      continue
    }

    if (expect !== 'any' && count !== expect) {
      outcomes.push({ id: p.id, status: 'failed', matches: count, reason: `expected ${expect}, found ${count}`, context })
      log && log.error(`patch ${p.id}: ambiguous anchor (${count} matches, expected ${expect}) - aborting`)
      return {
        source: original,
        outcomes,
        ok: false,
        error: new SmlnError('E_PATCH_AMBIGUOUS', `patch "${p.id}" matched ${count} times, expected ${expect}`, {
          detail: { id: p.id, owner: p.owner, matches: count, context },
        }),
      }
    }

    const re = toRegExp(p.find)
    current = current.replace(re, /** @type {any} */ (p.replace))
    outcomes.push({ id: p.id, status: 'applied', matches: count, context })
    log && log.debug(`patch ${p.id}: applied (${count} match(es))`)
  }

  return { source: current, outcomes, ok: true }
}

module.exports = { apply, verify, probe, escapeLiteral, toRegExp }
