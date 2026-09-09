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
const problems = require('../core/problems')

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

/** Joins two mod ids into one key. Cannot occur in an id, so "a"+"bc" and "ab"+"c" stay distinct. */
const SEP = String.fromCharCode(1)

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

// ---------------------------------------------------------------- conflicts
/**
 * Saying when two mods are fighting over the same code.
 *
 * Several mods patch the same shipped file. When two of them rewrite the same
 * region, the later one may find nothing left to match, or may rewrite what
 * the first one wrote. The symptom the loader used to report - "expected 1
 * match, found 0" - names the patch that lost and nothing else, so the player
 * sees a mod that does nothing and blames the mod or the game, and the author
 * sees a patch that worked yesterday. It is the hardest failure in the system
 * to diagnose and the one the engine already has every fact to name: it knows
 * who owns each patch, where each one matched, and in what order they ran.
 *
 * Three rules, cheapest first:
 *
 *   duplicate-anchor  Two owners anchored on the same literal. Knowable from
 *                     the patch list alone, before a byte is rewritten, so it
 *                     is reported up front by the loader (see entry.js).
 *   superseded        A patch found nothing to match, but its anchor *is* in
 *                     the shipped file - so an earlier patch rewrote it away,
 *                     and we can usually say whose. Kept strictly distinct
 *                     from an anchor that was never in this build at all,
 *                     which is a stale anchor and a different problem.
 *   overlap           Two patches from different owners rewrote intersecting
 *                     regions of the file.
 *
 * These sit downstream of a policy that is not theirs to overturn.
 * `interceptor.js` runs `conflicts.preflight` before any of this, and that
 * refuses a file outright when two owners' spans intersect in the original
 * text, serving it unmodified so the game still boots. So `duplicate-anchor`
 * is the one of the three that always gets to speak - it runs at load time,
 * before the interceptor exists - while `overlap` and `superseded` report on
 * what the preflight let through. Each carries a note at its own report site
 * saying exactly what that is. Neither is dead code, and neither is a second
 * opinion on whether the file should load: the preflight refuses a file, and
 * these explain one.
 *
 * Two rules hold throughout.
 *
 * *Different owners only.* A mod patching its own anchor twice is its own
 * business, and core's patches (`owner: 'smln'`) deliberately sit next to each
 * other. Reporting those would bury the real thing in noise.
 *
 * *Report, never intervene.* Nothing here reorders, skips or refuses a patch.
 * Two mods overlapping often still works, and a diagnostic that changed the
 * outcome would just be a second thing to debug. Every conflict is a warning;
 * none of them is ever an error.
 */

/**
 * @typedef {Object} Conflict
 * @property {'overlap'|'superseded'|'stale-anchor'|'duplicate-anchor'} kind
 * @property {string} target      The file both patches were queued for.
 * @property {string[]} owners    Mod ids involved, in the order they ran.
 * @property {string[]} patches   Patch ids, in the same order.
 * @property {string|null} modId  Who to file it against in the Problems panel.
 * @property {string} message     One paragraph a player can act on.
 */

/** A patch's owner, with core's default spelled out. */
function ownerOf(p) {
  return (p && p.owner) || 'smln'
}

/** The file a patch was queued for. `entry.js` stamps this when it queues one. */
function targetOf(p, fallback) {
  return (p && p.target) || fallback || 'the game file'
}

/**
 * The literal a patch is anchored on, if it has one.
 *
 * Core patches declare `anchorLiteral` outright. Fluxloader `replace` patches
 * do not, but their `find` *is* a literal string, which is the same fact under
 * another name - and two Fluxloader mods anchored on the same string is the
 * common real-world collision, so both count.
 */
function anchorOf(p) {
  if (p && p.anchorLiteral) return String(p.anchorLiteral)
  if (p && typeof p.find === 'string') return p.find
  return null
}

/** Shorten a literal for a one-line message without losing what it was. */
function snippet(s, max = 60) {
  const flat = String(s).replace(/\s+/g, ' ')
  return flat.length <= max ? flat : flat.slice(0, max - 3) + '...'
}

/**
 * Every position `find` matches in `source`. This is `probe` with the offsets
 * kept instead of thrown away - knowing *where* a patch lands is the whole
 * basis of overlap detection.
 * @returns {{start:number,end:number}[]}
 */
function matchRanges(source, find) {
  const re = toRegExp(find)
  const out = []
  let m
  while ((m = re.exec(source)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length })
    // Guard against a zero-width pattern spinning forever, same as `probe`.
    if (m[0].length === 0) re.lastIndex++
    if (out.length > 1000) break
  }
  return out
}

/** Two half-open intervals overlap iff each starts before the other ends. Touching does not count. */
function overlaps(a, b) {
  return a.start < b.end && b.start < a.end
}

/** Prefer filing a conflict against a real mod rather than against core. */
function blameFor(ownerA, ownerB) {
  if (ownerB !== 'smln') return ownerB
  if (ownerA !== 'smln') return ownerA
  return null
}

/**
 * The cheapest of the three checks: two owners carrying the same anchor, read
 * off the patch list with no source and nothing applied.
 *
 * @param {Patch[]} patches  Everything queued for one file.
 * @param {string} [target]  That file, for the message.
 * @returns {Conflict[]}
 */
function anchorConflicts(patches, target) {
  /** @type {Conflict[]} */
  const out = []
  try {
    /** @type {Map<string, {patch:Patch, owner:string}[]>} */
    const byAnchor = new Map()
    for (const p of patches || []) {
      const anchor = anchorOf(p)
      if (!anchor) continue
      const seen = byAnchor.get(anchor)
      if (seen) seen.push({ patch: p, owner: ownerOf(p) })
      else byAnchor.set(anchor, [{ patch: p, owner: ownerOf(p) }])
    }

    for (const [anchor, seen] of byAnchor) {
      if (seen.length < 2) continue
      // One report per pair of mods per anchor. A mod with five patches on the
      // same literal would otherwise generate five copies of the same news.
      const said = new Set()
      for (let i = 0; i < seen.length; i++) {
        for (let j = i + 1; j < seen.length; j++) {
          const a = seen[i]
          const b = seen[j]
          if (a.owner === b.owner) continue
          // Sorted, so "moda vs modb" and "modb vs moda" count as one pair.
          const pair = [a.owner, b.owner].sort().join(SEP)
          if (said.has(pair)) continue
          said.add(pair)
          const file = targetOf(a.patch, target)
          out.push({
            kind: 'duplicate-anchor',
            target: file,
            owners: [a.owner, b.owner],
            patches: [a.patch.id, b.patch.id],
            modId: blameFor(a.owner, b.owner),
            message:
              `${a.owner} and ${b.owner} both patch ${file} at the same anchor \`${snippet(anchor)}\` ` +
              `(patches "${a.patch.id}" and "${b.patch.id}"). ${a.owner} is queued first, so whichever ` +
              `of the two rewrites that text first may leave the other with nothing to match. ` +
              `Disable one of them, or load them in the other order.`,
          })
        }
      }
    }
  } catch (_) {
    // Diagnosis is never allowed to become the failure. Whatever was collected
    // before the throw is still worth saying.
  }
  return out
}

/** A tracker that records nothing, used when building the real one throws. */
const INERT_TRACKER = {
  active: false,
  noteApplied() {},
  noteZeroMatch() {},
  finish() { return [] },
}

/**
 * Watch one `apply` run and collect what the mods did to each other.
 *
 * Match ranges are all measured against the *original* source, because that is
 * the one coordinate frame every patch in the run shares - positions in the
 * text as it stands mid-run mean different things to the first patch and the
 * tenth. The cost is that a patch which matched only inside text an earlier
 * patch produced has no original-frame range and so contributes no overlap
 * pair; that case shows up as a `superseded` report on whoever lost instead.
 *
 * @param {string} source   The file before anything was applied.
 * @param {Patch[]} patches Everything queued for it.
 * @param {{target?:string}} [opts]
 */
function makeTracker(source, patches, opts) {
  const fallbackTarget = (opts && opts.target) || null
  const owners = new Set()
  for (const p of patches) owners.add(ownerOf(p))

  // Cost nothing when there is nothing to say. One owner means no cross-owner
  // pair can exist, so no ranges are ever scanned - and that is the usual
  // case, since the worker bundle carries only core patches.
  const active = owners.size > 1

  /** @type {{patch:Patch, owner:string, ranges:{start:number,end:number}[]}[]} in application order */
  const applied = []
  /** @type {Conflict[]} */
  const found = []

  return {
    active,

    /** A patch just rewrote the file. Remember where, in original coordinates. */
    noteApplied(p) {
      if (!active) return
      try {
        applied.push({ patch: p, owner: ownerOf(p), ranges: matchRanges(source, p.find) })
      } catch (_) { /* never stop a patch to take a note about it */ }
    },

    /**
     * A patch matched nothing. Was its anchor taken from it, or was it never
     * in this build to begin with? The original source answers that: if the
     * anchor is there and is not in the text this patch was handed, an earlier
     * patch rewrote it away, and we can name the one whose own rewrite covered
     * the spot. If the anchor is not in the shipped file either, nobody took
     * it - the patch is simply written against a different game build, which
     * is a stale anchor and a different problem with a different fix.
     */
    noteZeroMatch(p) {
      if (!active) return
      try {
        const owner = ownerOf(p)
        const file = targetOf(p, fallbackTarget)
        const original = matchRanges(source, p.find)

        if (!original.length) {
          found.push({
            kind: 'stale-anchor',
            target: file,
            owners: [owner],
            patches: [p.id],
            modId: owner === 'smln' ? null : owner,
            message:
              `${owner}'s patch "${p.id}" found nothing to match in ${file}, and its anchor is not in ` +
              `the shipped file either, so no other mod took it. That is a stale anchor: the patch was ` +
              `written against a different game build and needs updating.`,
          })
          return
        }

        let culprit = null
        for (const a of applied) {
          if (a.owner === owner) continue
          if (a.ranges.some((ra) => original.some((ro) => overlaps(ra, ro)))) { culprit = a; break }
        }
        // No range covered it, but somebody else has already rewritten this
        // file - the most recent of them is the best guess, and the wording
        // below is careful to offer it as a likely cause rather than a fact.
        if (!culprit) {
          for (let i = applied.length - 1; i >= 0; i--) {
            if (applied[i].owner !== owner) { culprit = applied[i]; break }
          }
        }
        // Nobody else has touched the file, so whatever consumed the anchor
        // belongs to this same mod. That is its own business, not a conflict.
        if (!culprit) return

        // Reachability, honestly: in the running game this fires less often
        // than it looks, and it is not dead. `interceptor.js` runs
        // `conflicts.preflight` first, and that refuses a file outright when
        // two owners' match spans intersect in the *original* text - which is
        // how an anchor usually gets eaten, so that road never reaches here.
        // What does reach here:
        //
        //   - a pair the preflight deliberately waived, where both patches set
        //     `allowOverlap`. Nothing else reports on those, so this is the
        //     only account of what the waiver actually cost;
        //   - an anchor destroyed from outside its own match span. The
        //     preflight compares `m[0]` spans, so a lookahead, a lookbehind or
        //     a \b that reaches into text another mod rewrote is invisible to
        //     it and lands squarely here. That is exactly the case the
        //     `culprit` fallback above exists for: no range covers the anchor,
        //     yet it is gone, and the wording stays at "very likely why";
        //   - any caller of `apply` that does not preflight - the self-test
        //     today, and whatever calls it next.
        //
        // Do not delete this branch on the reasoning that the preflight has it
        // covered. The preflight refuses a file; it never explains one.
        found.push({
          kind: 'superseded',
          target: file,
          owners: [culprit.owner, owner],
          patches: [culprit.patch.id, p.id],
          modId: blameFor(culprit.owner, owner),
          message:
            `${owner}'s patch "${p.id}" found nothing to match in ${file}; ${culprit.owner} rewrote this ` +
            `file first (patch "${culprit.patch.id}"), which is very likely why - the anchor is in the ` +
            `shipped file but not in the text "${p.id}" was handed. Disable ${culprit.owner}, or load ` +
            `${owner} before it, and see whether "${p.id}" takes.`,
        })
      } catch (_) { /* as above: a note is never worth a broken patch run */ }
    },

    /**
     * Pair up everything that applied and report the cross-owner overlaps.
     *
     * The pair loop is O(n^2) in the patches that applied to this one file.
     * With the ~80 a full mod set produces that is about 3,200 integer
     * comparisons, which is nothing beside the regex scans the run already
     * paid for. It would stop being fine somewhere north of a few thousand
     * patches on a single file; at that point sort the ranges by start and
     * sweep once instead of comparing every pair.
     */
    finish() {
      if (!active) return found
      try {
        for (let i = 0; i < applied.length; i++) {
          for (let j = i + 1; j < applied.length; j++) {
            const first = applied[i]
            const second = applied[j]
            if (first.owner === second.owner) continue
            let hit = false
            for (const ra of first.ranges) {
              for (const rb of second.ranges) { if (overlaps(ra, rb)) { hit = true; break } }
              if (hit) break
            }
            if (!hit) continue

            // Reachability, honestly: `interceptor.js` runs
            // `conflicts.preflight` before this, over the same original-text
            // spans, and refuses the whole file when two owners intersect. So
            // in the running game the ordinary cross-owner overlap is caught
            // and stopped upstream and never arrives here at all.
            //
            // Three things still do arrive, and they are why this stays:
            //
            //   - a pair the preflight waived because both patches set
            //     `allowOverlap`. That waiver is the one case where two mods
            //     knowingly share a region and the file is served anyway, and
            //     this is the only thing that says afterwards what the sharing
            //     did - who ran first, and whose text ships;
            //   - pairs the preflight cannot rule on, because it weighs every
            //     patch that *matches* while this weighs only the ones that
            //     actually *applied*. A patch inside a skipped atomic group
            //     matches and never runs; pairing it would be a lie;
            //   - any caller of `apply` that does not preflight.
            //
            // What does NOT arrive, despite sounding like it should: a patch
            // whose replacement introduces text a later patch then matches.
            // Ranges here are measured in the original source, which is the
            // only frame every patch in a run shares, so a match that exists
            // only in another patch's output has no range to intersect and
            // pairs with nothing. That collision surfaces as `superseded` on
            // whoever lost the anchor, not as an overlap. Measuring it
            // properly would mean tracking every edit's position and length
            // through the whole run - buildable, but it would be the detector
            // and not the patcher deciding how text gets replaced, which is a
            // trade this file has deliberately not made.
            const file = targetOf(first.patch, fallbackTarget)
            found.push({
              kind: 'overlap',
              target: file,
              owners: [first.owner, second.owner],
              patches: [first.patch.id, second.patch.id],
              modId: blameFor(first.owner, second.owner),
              message:
                `${first.owner} and ${second.owner} both rewrite ${file} at the same place. ` +
                `${first.owner}'s patch "${first.patch.id}" ran first; ${second.owner}'s patch ` +
                `"${second.patch.id}" then rewrote the same text, so ${second.owner}'s version is what ` +
                `ships there. Disable one of them, or load them in the other order.`,
            })
          }
        }
      } catch (_) { /* return whatever was collected before the throw */ }
      return found
    },
  }
}

/**
 * File conflicts where every other survived failure is filed.
 *
 * The engine reports these itself rather than handing them back for a caller
 * to forward, because a diagnostic that only works when every call site
 * remembers to plumb it is a diagnostic that does not work. `problems.record`
 * is total and dependency-free by contract, so the engine pays nothing for it.
 *
 * A stale anchor is deliberately not filed: the patch's own outcome already
 * says it matched nothing, and repeating that would bury the reports that name
 * a second mod. It is still returned on the result for anyone who wants it.
 */
function reportConflicts(list, log) {
  for (const c of list) {
    if (c.kind === 'stale-anchor') continue
    problems.record({
      // Never an error. Two mods overlapping often still works, and this is a
      // record of what happened, not a verdict on whether the game will run.
      severity: 'warn',
      scope: 'patch',
      modId: c.modId || undefined,
      error: new SmlnError('E_PATCH_CONFLICT', c.message, {
        detail: { kind: c.kind, target: c.target, owners: c.owners, patches: c.patches },
      }),
    })
    if (log && log.warn) { try { log.warn(c.message) } catch (_) { /* logging is optional */ } }
  }
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
/**
 * Split into consecutive runs that must succeed or fail together.
 * A patch without a `group` forms a run of its own.
 * @param {Patch[]} patches
 * @returns {{group:string|undefined, members:Patch[]}[]}
 */
function toGroups(patches) {
  const runs = []
  for (const p of patches) {
    const last = runs[runs.length - 1]
    if (p.group && last && last.group === p.group) last.members.push(p)
    else runs.push({ group: p.group, members: [p] })
  }
  return runs
}

function apply(source, patches, opts = {}) {
  const log = opts.logger
  const original = source
  /** @type {PatchOutcome[]} */
  const outcomes = []
  let current = source

  // Conflict detection is pure observation, and it is built so that it cannot
  // become the thing that goes wrong: constructing it is guarded here, every
  // method guards itself, and `close` is on all four exits so a run that
  // aborts still says what it saw before it did.
  let tracker
  try { tracker = makeTracker(source, patches, opts) } catch (_) { tracker = INERT_TRACKER }

  /** Attach and file whatever the tracker collected, then hand the result on. */
  function close(value) {
    try {
      const conflicts = tracker.finish()
      value.conflicts = conflicts
      reportConflicts(conflicts, log)
    } catch (_) {
      if (!value.conflicts) value.conflicts = []
    }
    return value
  }

  for (const run of toGroups(patches)) {
    // An atomic group is all-or-nothing: probe every member against the text as
    // it stands now, and only commit if the whole group resolves. Half of a
    // group is worse than none of it, because the mod's assumptions no longer
    // hold in the code it did manage to change.
    if (run.group && run.members.length > 1) {
      const probes = run.members.map((p) => {
        const expect = p.expect == null ? 1 : p.expect
        const { count, firstIndex } = probe(current, p.find)
        const ok = expect === 'any' ? count > 0 : count === expect
        return { patch: p, count, firstIndex, ok, expect }
      })
      const broken = probes.filter((x) => !x.ok)
      if (broken.length) {
        for (const x of probes) {
          if (x.count === 0) tracker.noteZeroMatch(x.patch)
          outcomes.push({
            id: x.patch.id,
            status: 'skipped',
            matches: x.count,
            reason: x.ok
              ? `skipped: atomic group "${run.group}" could not be applied in full`
              : `expected ${x.expect} match(es), found ${x.count}`,
            context: x.firstIndex >= 0 ? excerpt(current, x.firstIndex) : undefined,
          })
        }
        const names = broken.map((x) => x.patch.id).join(', ')
        log && log.error(`atomic group "${run.group}" skipped entirely - unresolved: ${names}`)
        if (run.members.some((p) => p.required)) {
          return close({
            source: original,
            outcomes,
            ok: false,
            error: new SmlnError('E_PATCH_FAILED',
              `required atomic group "${run.group}" could not be applied (${names})`,
              { detail: { group: run.group, broken: broken.map((x) => x.patch.id) } }),
          })
        }
        continue
      }
      for (const x of probes) {
        current = current.replace(toRegExp(x.patch.find), /** @type {any} */ (x.patch.replace))
        tracker.noteApplied(x.patch)
        outcomes.push({ id: x.patch.id, status: 'applied', matches: x.count })
      }
      log && log.debug(`atomic group "${run.group}": ${probes.length} patch(es) applied`)
      continue
    }

    const result = applyOne(run.members[0], current, outcomes, log, original, tracker)
    if (result.abort) return close(result.value)
    current = result.source
  }

  return close({ source: current, outcomes, ok: true })
}

/** Apply a single ungrouped patch. Extracted so `apply` stays readable. */
function applyOne(p, current, outcomes, log, original, tracker) {
  {
    const expect = p.expect == null ? 1 : p.expect
    const required = p.required !== false
    const { count, firstIndex } = probe(current, p.find)
    const context = firstIndex >= 0 ? excerpt(current, firstIndex) : undefined

    if (count === 0) {
      tracker.noteZeroMatch(p)
      const outcome = {
        id: p.id,
        status: required ? 'failed' : 'skipped',
        matches: 0,
        reason: `anchor did not match (${p.description})`,
      }
      outcomes.push(outcome)
      if (required) {
        log && log.error(`patch ${p.id}: anchor did not match - aborting, file left unpatched`)
        return {
          abort: true,
          value: {
            source: original,
            outcomes,
            ok: false,
            error: new SmlnError('E_PATCH_FAILED', `patch "${p.id}" anchor did not match`, {
              detail: { id: p.id, owner: p.owner, description: p.description },
            }),
          },
        }
      }
      log && log.warn(`patch ${p.id}: optional anchor missing, skipped`)
      return { abort: false, source: current }
    }

    if (expect !== 'any' && count !== expect) {
      outcomes.push({
        id: p.id,
        status: required ? 'failed' : 'skipped',
        matches: count,
        reason: `expected ${expect}, found ${count}`,
        context,
      })
      log && log.error(`patch ${p.id}: ambiguous anchor (${count} matches, expected ${expect})`)
      if (!required) return { abort: false, source: current }
      return {
        abort: true,
        value: {
          source: original,
          outcomes,
          ok: false,
          error: new SmlnError('E_PATCH_AMBIGUOUS', `patch "${p.id}" matched ${count} times, expected ${expect}`, {
            detail: { id: p.id, owner: p.owner, matches: count, context },
          }),
        },
      }
    }

    const re = toRegExp(p.find)
    current = current.replace(re, /** @type {any} */ (p.replace))
    tracker.noteApplied(p)
    outcomes.push({ id: p.id, status: 'applied', matches: count, context })
    log && log.debug(`patch ${p.id}: applied (${count} match(es))`)
    return { abort: false, source: current }
  }
}

module.exports = { apply, verify, probe, escapeLiteral, toRegExp, toGroups, anchorConflicts, matchRanges }
