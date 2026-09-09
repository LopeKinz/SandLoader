#!/usr/bin/env node
'use strict'
/**
 * Regression tests for patch conflict detection.
 *
 * The failure being pinned down here is the one that used to be unreadable:
 * two mods patch the same shipped file, one of them rewrites the region the
 * other anchored on, and the loser reports "expected 1 match, found 0" without
 * a word about who took it. These tests hold the engine to naming both mods,
 * the file, both patch ids and what to do about it - and, just as importantly,
 * to staying silent when a mod is only patching near itself.
 *
 * Small synthetic sources on purpose: the real bundle is 4 MB of minified
 * JavaScript whose contents change with every game build, so a test written
 * against it would be testing the game rather than the detector.
 */

const engine = require('../src/patch/engine')
const problems = require('../src/core/problems')

function assert(value, message) {
  if (!value) throw new Error(message)
}

/** Run `apply` with a clean problem registry and hand back both halves. */
function run(source, patches) {
  problems.clear()
  const result = engine.apply(source, patches, {})
  return { result, filed: problems.list() }
}

const kinds = (result) => (result.conflicts || []).map((c) => c.kind)
const of = (result, kind) => (result.conflicts || []).filter((c) => c.kind === kind)

// --------------------------------------------------------------- 1. overlap

function testOverlapNamesBothModsAndTheWinner() {
  // Both anchors resolve in the shipped text and their ranges intersect, so
  // both patches apply and the second one rewrites text the first produced.
  const source = 'function boot(){ say hello world today }'
  const first = {
    id: 'corelib:ring', owner: 'corelib', target: 'js/bundle.js',
    description: 'wrap the world call', find: 'world', replace: 'world/*corelib*/',
  }
  const second = {
    id: 'gas-pipes:greet', owner: 'gas-pipes', target: 'js/bundle.js',
    description: 'shout the greeting', find: 'hello world', replace: 'HELLO world',
  }

  const { result, filed } = run(source, [first, second])
  assert(result.ok, 'a conflict changed the outcome of the run: ' + (result.error && result.error.message))
  assert(result.source.includes('HELLO'), 'the second patch was not applied')

  const hits = of(result, 'overlap')
  assert(hits.length === 1, 'expected exactly one overlap, got ' + JSON.stringify(kinds(result)))
  const m = hits[0].message
  assert(m.includes('corelib') && m.includes('gas-pipes'), 'the report did not name both mods: ' + m)
  assert(m.includes('js/bundle.js'), 'the report did not name the file: ' + m)
  assert(m.includes('corelib:ring') && m.includes('gas-pipes:greet'),
    'the report did not name both patch ids: ' + m)
  assert(/corelib's patch "corelib:ring" ran first/.test(m), 'the report did not say who ran first: ' + m)
  assert(m.includes('Disable one of them, or load them in the other order.'),
    'the report told the player nothing to do: ' + m)

  // Reported like any other problem, and never as an error: two mods
  // overlapping often still works.
  const warn = filed.filter((p) => p.code === 'E_PATCH_CONFLICT')
  assert(warn.length === 1, 'the overlap was not filed as a problem')
  assert(warn[0].severity === 'warn', 'a conflict was filed as an error, not a warning')
  assert(warn[0].scope === 'patch', 'wrong scope: ' + warn[0].scope)
  assert(warn[0].modId === 'gas-pipes', 'the problem was not attributed to a mod: ' + warn[0].modId)
}

function testOneModOverlappingItselfIsNotReported() {
  // Identical shapes to the test above, except that one mod owns both patches.
  // A mod patching its own anchor twice is its own business; reporting it
  // would bury the cross-mod reports that matter under the ones that don't.
  const source = 'function boot(){ say hello world today }'
  const first = {
    id: 'gas-pipes:ring', owner: 'gas-pipes', target: 'js/bundle.js',
    description: 'wrap the world call', find: 'world', replace: 'world/*gp*/',
  }
  const second = {
    id: 'gas-pipes:greet', owner: 'gas-pipes', target: 'js/bundle.js',
    description: 'shout the greeting', find: 'hello world', replace: 'HELLO world',
  }

  const { result, filed } = run(source, [first, second])
  assert(result.ok, 'the run failed: ' + (result.error && result.error.message))
  assert(of(result, 'overlap').length === 0,
    'a mod overlapping its own patch was reported: ' + JSON.stringify(result.conflicts))
  assert(filed.length === 0, 'a same-owner overlap was filed as a problem')
}

function testCoreOverlappingItselfIsNotReported() {
  // Core's own patches (owner 'smln', which is also the default when a patch
  // declares no owner) deliberately sit near each other.
  const source = 'function boot(){ say hello world today }'
  const declared = {
    id: 'smln:ring', owner: 'smln', target: 'js/bundle.js',
    description: 'core hook', find: 'world', replace: 'world/*smln*/',
  }
  const implied = {
    id: 'core:greet', target: 'js/bundle.js',
    description: 'core hook without an explicit owner', find: 'hello world', replace: 'HELLO world',
  }

  const { result, filed } = run(source, [declared, implied])
  assert(result.ok, 'the run failed: ' + (result.error && result.error.message))
  assert((result.conflicts || []).length === 0,
    'core patches were reported as fighting each other: ' + JSON.stringify(result.conflicts))
  assert(filed.length === 0, 'a core-on-core overlap was filed as a problem')
}

// ------------------------------------------------------------ 2. superseded

function testSupersededAnchorNamesTheModThatTookIt() {
  // corelib rewrites the anchor gas-pipes was relying on, so gas-pipes finds
  // nothing. The anchor *is* in the shipped file, which is what separates this
  // from a stale anchor.
  const source = 'function tick(){ core(); render(); }'
  const first = {
    id: 'corelib:tick', owner: 'corelib', target: 'js/bundle.js',
    description: 'replace the core call', find: 'core()', replace: 'corelibCore()',
  }
  const second = {
    id: 'gas-pipes:tick', owner: 'gas-pipes', target: 'js/bundle.js',
    description: 'hook the core call', find: 'core()', replace: 'gasCore()', required: false,
  }

  const { result, filed } = run(source, [first, second])
  assert(result.ok, 'a lost anchor aborted the run: ' + (result.error && result.error.message))

  const hits = of(result, 'superseded')
  assert(hits.length === 1, 'expected one superseded anchor, got ' + JSON.stringify(kinds(result)))
  const m = hits[0].message
  assert(m.includes('found nothing to match in js/bundle.js'),
    'the report did not say what happened, in the file it happened in: ' + m)
  assert(m.includes('corelib rewrote this file first'), 'the report did not name the other mod: ' + m)
  assert(m.includes('very likely why'),
    'the report asserted a cause it cannot actually prove: ' + m)
  assert(m.includes('corelib:tick') && m.includes('gas-pipes:tick'),
    'the report did not name both patch ids: ' + m)
  assert(/Disable corelib, or load gas-pipes before it/.test(m),
    'the report told the player nothing to do: ' + m)

  const warn = filed.filter((p) => p.code === 'E_PATCH_CONFLICT')
  assert(warn.length === 1 && warn[0].severity === 'warn',
    'a superseded anchor was not filed as a single warning')
}

function testStaleAnchorReadsDifferentlyFromASupersededOne() {
  // Same shape, but gas-pipes' anchor is not in the shipped file at all, so
  // nobody took it - the patch is simply written against another game build.
  // That is a different problem with a different fix, and it must not accuse
  // the mod that happens to have patched the same file.
  const source = 'function tick(){ core(); render(); }'
  const first = {
    id: 'corelib:tick', owner: 'corelib', target: 'js/bundle.js',
    description: 'replace the core call', find: 'core()', replace: 'corelibCore()',
  }
  const stale = {
    id: 'gas-pipes:old', owner: 'gas-pipes', target: 'js/bundle.js',
    description: 'hook a call this build does not have', find: 'legacyTick()',
    replace: 'gasTick()', required: false,
  }

  const { result, filed } = run(source, [first, stale])
  assert(result.ok, 'the run failed: ' + (result.error && result.error.message))

  const hits = of(result, 'stale-anchor')
  assert(hits.length === 1, 'expected one stale anchor, got ' + JSON.stringify(kinds(result)))
  assert(of(result, 'superseded').length === 0,
    'an out-of-date patch was blamed on another mod: ' + JSON.stringify(result.conflicts))

  const m = hits[0].message
  assert(m.includes('not in the shipped file either'), 'the stale wording lost its distinguishing fact: ' + m)
  assert(m.includes('stale anchor'), 'the stale case was not named as such: ' + m)
  assert(!m.includes('corelib'), 'a stale anchor named an innocent mod: ' + m)

  // The engine's own outcome already reports that this patch matched nothing;
  // filing it a second time would push the reports that name two mods off the
  // top of the Problems panel.
  assert(filed.filter((p) => p.code === 'E_PATCH_CONFLICT').length === 0,
    'a stale anchor was filed as a conflict')

  // And the two really do read differently, which is the whole point.
  const superseded = run(source, [first, { ...stale, find: 'core()' }])
  const other = of(superseded.result, 'superseded')[0]
  assert(other && other.message !== m, 'the superseded and stale reports read the same')
}

function testAModsOwnEarlierPatchIsNotAConflict() {
  // gas-pipes destroys its own anchor. Nobody else has touched the file, so
  // there is nothing to report to anybody.
  const source = 'function tick(){ core(); render(); }'
  const first = {
    id: 'gas-pipes:one', owner: 'gas-pipes', target: 'js/bundle.js',
    description: 'first edit', find: 'core()', replace: 'gasCore()',
  }
  const second = {
    id: 'gas-pipes:two', owner: 'gas-pipes', target: 'js/bundle.js',
    description: 'second edit on the same text', find: 'core()', replace: 'gasCoreAgain()',
    required: false,
  }
  // A third owner so the detector is switched on at all; it patches elsewhere.
  const bystander = {
    id: 'corelib:render', owner: 'corelib', target: 'js/bundle.js',
    description: 'unrelated', find: 'render()', replace: 'corelibRender()',
  }

  const { result, filed } = run(source, [first, second, bystander])
  assert(result.ok, 'the run failed: ' + (result.error && result.error.message))
  assert(of(result, 'superseded').length === 0,
    'a mod eating its own anchor was reported as a conflict: ' + JSON.stringify(result.conflicts))
  assert(filed.length === 0, 'a self-inflicted lost anchor was filed as a problem')
}

// ------------------------------------------------------- 3. identical anchor

function testIdenticalAnchorsAreCaughtBeforeAnythingIsApplied() {
  // No source, nothing applied: this is knowable from the queue alone, which
  // is why the loader runs it up front at load time.
  const queued = [
    { id: 'corelib:ready', owner: 'corelib', target: 'js/bundle.js',
      description: 'hook ready', anchorLiteral: '"game:ready"', find: /"game:ready"/g, replace: 'x' },
    { id: 'gas-pipes:ready', owner: 'gas-pipes', target: 'js/bundle.js',
      description: 'hook ready too', anchorLiteral: '"game:ready"', find: /"game:ready"/g, replace: 'y' },
  ]

  const found = engine.anchorConflicts(queued, 'js/bundle.js')
  assert(found.length === 1, 'expected one duplicate anchor, got ' + found.length)
  const m = found[0].message
  assert(m.includes('corelib') && m.includes('gas-pipes'), 'the report did not name both mods: ' + m)
  assert(m.includes('js/bundle.js'), 'the report did not name the file: ' + m)
  assert(m.includes('"game:ready"'), 'the report did not quote the anchor: ' + m)
  assert(m.includes('corelib:ready') && m.includes('gas-pipes:ready'),
    'the report did not name both patch ids: ' + m)
  assert(m.includes('Disable one of them, or load them in the other order.'),
    'the report told the player nothing to do: ' + m)
}

function testALiteralFindCountsAsAnAnchor() {
  // Fluxloader `replace` patches carry no anchorLiteral - their `find` is the
  // literal, which is the same fact under another name. Without this the check
  // would never fire for the mods that actually collide in practice.
  const found = engine.anchorConflicts([
    { id: 'a:1', owner: 'moda', description: 'x', find: 'workerEventTriggerCounts:{}', replace: 'q' },
    { id: 'b:1', owner: 'modb', description: 'y', find: 'workerEventTriggerCounts:{}', replace: 'r' },
  ], 'js/bundle.js')
  assert(found.length === 1, 'a shared literal find was not treated as a shared anchor')
  assert(found[0].kind === 'duplicate-anchor', 'wrong kind: ' + found[0].kind)
}

function testSameOwnerAnchorsAreNotReported() {
  const own = engine.anchorConflicts([
    { id: 'smln:a', owner: 'smln', description: 'x', anchorLiteral: '"game:ready"', find: 'a', replace: 'q' },
    { id: 'smln:b', owner: 'smln', description: 'y', anchorLiteral: '"game:ready"', find: 'b', replace: 'r' },
    { id: 'mod:a', owner: 'moda', description: 'z', anchorLiteral: '.somethingElse', find: 'c', replace: 's' },
  ], 'js/bundle.js')
  assert(own.length === 0, 'core patches on a shared anchor were reported: ' + JSON.stringify(own))
}

function testOneReportPerPairOfMods() {
  // Three patches on one anchor from two mods is one piece of news, not two.
  const found = engine.anchorConflicts([
    { id: 'a:1', owner: 'moda', description: 'x', anchorLiteral: 'HOOK', find: 'p', replace: 'q' },
    { id: 'b:1', owner: 'modb', description: 'y', anchorLiteral: 'HOOK', find: 'p', replace: 'r' },
    { id: 'a:2', owner: 'moda', description: 'z', anchorLiteral: 'HOOK', find: 'p', replace: 's' },
  ], 'js/bundle.js')
  assert(found.length === 1, 'the same pair of mods was reported twice: ' + found.length)
}

// --------------------------------------------------------------- robustness

function testDetectionFailingDoesNotStopPatchesApplying() {
  // Stand-in for any bug in the detector: reading the patch's owner throws.
  // Every conflict rule needs the owner, so this breaks all of them at once,
  // both while the tracker is being built and while it is being fed. The run
  // must still patch the file exactly as it would have.
  const source = 'function tick(){ core(); render(); }'
  const exploding = {
    id: 'boom', target: 'js/bundle.js', description: 'detonates the detector',
    find: 'core()', replace: 'BOOM()',
    get owner() { throw new Error('detector exploded') },
  }
  const innocent = {
    id: 'corelib:render', owner: 'corelib', target: 'js/bundle.js',
    description: 'unrelated', find: 'render()', replace: 'corelibRender()',
  }

  problems.clear()
  const result = engine.apply(source, [exploding, innocent], {})
  assert(result.ok, 'a throwing detector aborted the run: ' + (result.error && result.error.message))
  assert(result.source === 'function tick(){ BOOM(); corelibRender(); }',
    'a throwing detector changed what was patched: ' + result.source)
  assert(Array.isArray(result.conflicts), 'the result lost its conflicts array')

  // And the same for the up-front check, which the loader calls on every file.
  const found = engine.anchorConflicts([exploding, innocent], 'js/bundle.js')
  assert(Array.isArray(found), 'anchorConflicts threw instead of returning what it had')
}

function testNoCrossOwnerPatchesCostsNothingAndSaysNothing() {
  // The common case: one owner holds every patch on the file. No ranges are
  // scanned and nothing is reported.
  const source = 'function tick(){ core(); render(); }'
  const { result, filed } = run(source, [
    { id: 'smln:a', owner: 'smln', target: 'js/worker.js', description: 'x', find: 'core()', replace: 'A()' },
    { id: 'smln:b', owner: 'smln', target: 'js/worker.js', description: 'y', find: 'render()', replace: 'B()' },
  ])
  assert(result.ok, 'the run failed: ' + (result.error && result.error.message))
  assert(result.conflicts.length === 0, 'a single-owner file produced conflicts')
  assert(filed.length === 0, 'a single-owner file filed problems')
}

function testConflictsAreStillReportedWhenTheRunAborts() {
  // A required patch failing returns the file unpatched, but whatever the
  // detector saw on the way there is exactly what explains the abort.
  const source = 'function tick(){ core(); render(); }'
  const { result } = run(source, [
    { id: 'corelib:tick', owner: 'corelib', target: 'js/bundle.js',
      description: 'take the anchor', find: 'core()', replace: 'corelibCore()' },
    { id: 'gas-pipes:tick', owner: 'gas-pipes', target: 'js/bundle.js',
      description: 'needs the anchor', find: 'core()', replace: 'gasCore()' },
  ])
  assert(!result.ok, 'a required patch with no match should have failed the run')
  assert(result.source === source, 'a failed run leaked a partial patch')
  assert(of(result, 'superseded').length === 1,
    'the abort was reported without saying which mod caused it: ' + JSON.stringify(result.conflicts))
}

function testNothingIsReorderedSkippedOrRefused() {
  // The load-bearing promise: detection observes and never intervenes. Two
  // mods flatly overlapping must produce exactly the text they would have
  // produced with no detector at all.
  const source = 'say hello world today'
  const patches = [
    { id: 'a:1', owner: 'moda', target: 'js/bundle.js', description: 'x', find: 'world', replace: 'world/*a*/' },
    { id: 'b:1', owner: 'modb', target: 'js/bundle.js', description: 'y', find: 'hello world', replace: 'HELLO world' },
  ]
  const { result } = run(source, patches)
  assert(result.ok, 'an overlap refused the run')
  assert(result.source === 'say HELLO world/*a*/ today', 'the detector changed the output: ' + result.source)
  assert(result.outcomes.length === 2 && result.outcomes.every((o) => o.status === 'applied'),
    'a patch was skipped because of a conflict: ' + JSON.stringify(result.outcomes))
}

const tests = [
  testOverlapNamesBothModsAndTheWinner,
  testOneModOverlappingItselfIsNotReported,
  testCoreOverlappingItselfIsNotReported,
  testSupersededAnchorNamesTheModThatTookIt,
  testStaleAnchorReadsDifferentlyFromASupersededOne,
  testAModsOwnEarlierPatchIsNotAConflict,
  testIdenticalAnchorsAreCaughtBeforeAnythingIsApplied,
  testALiteralFindCountsAsAnAnchor,
  testSameOwnerAnchorsAreNotReported,
  testOneReportPerPairOfMods,
  testDetectionFailingDoesNotStopPatchesApplying,
  testNoCrossOwnerPatchesCostsNothingAndSaysNothing,
  testConflictsAreStillReportedWhenTheRunAborts,
  testNothingIsReorderedSkippedOrRefused,
]

try {
  for (const t of tests) t()
  problems.clear()
  console.log(`PASS patch conflict detection (${tests.length} checks)`)
} catch (e) {
  console.error('FAIL patch conflict detection:', e.message)
  process.exit(1)
}
