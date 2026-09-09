#!/usr/bin/env node
'use strict'
/**
 * Duplicate-registration detection: when two mods claim one content id.
 *
 * `src/renderer/registration.js` is a browser IIFE, so it is loaded into a
 * `vm` sandbox the same way tools/selftest.js loads the other renderer
 * modules, and driven with a fake SMLN + fake FH. The fake FH keeps a live
 * table, which is what lets these tests check the *claim* the report makes
 * ("corelib's is in effect") against what the registry actually holds, rather
 * than against an assumption.
 */

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'registration.js'), 'utf8')

function assert(value, message) {
  if (!value) throw new Error(message)
}

/** Let queued microtasks and the drain's own chaining finish. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * @param {{logThrows?:boolean, reportThrows?:boolean, reportRejects?:boolean,
 *          gameElements?:Record<string,unknown>}} [opts]
 */
function boot(opts) {
  const o = opts || {}
  const logs = []
  const problems = []
  /** What the game's registry really ends up holding. */
  const live = { elements: {}, terrains: {} }

  const FH = {
    elements: {
      register(_state, def) {
        // Refuse to overwrite, so a bug that let a second claim through would
        // show up here rather than being papered over.
        live.elements[def.id] = def
        return { elementType: Object.keys(live.elements).length }
      },
    },
    terrains: {
      register(_state, def) {
        live.terrains[def.id] = def
        return { cellType: Object.keys(live.terrains).length }
      },
    },
  }

  // The live registry `duplicate()` consults as a bonus check. Anything seeded
  // here belongs to the game, not to a mod.
  const state = {
    sandkit: { mods: { elements: Object.assign({}, o.gameElements), terrains: {} } },
  }

  let readyFn = null
  const SMLN = {
    log(level, msg) {
      // Scoped to the conflict messages on purpose. A log channel that throws
      // for *everything* breaks registration.js's own pre-existing logging in
      // `fail()` and `drain()`, which is a different problem; what is under
      // test here is that the conflict reporter cannot take a registration
      // down with it.
      if (o.logThrows && /content conflict/.test(msg)) {
        throw new Error('the log channel exploded')
      }
      logs.push(level + ': ' + msg)
    },
    whenReady(fn) { readyFn = fn },
    game: null,          // FH does not exist until game:ready; that is the point
    getState() { return state },
    callMain(channel, payload) {
      if (o.reportThrows) throw new Error('the IPC bridge exploded')
      problems.push({ channel, payload })
      if (o.reportRejects) return Promise.reject(new Error('the main process said no'))
      return Promise.resolve({ ok: true })
    },
  }

  const sandbox = {
    globalThis: null,
    __SMLN__: SMLN,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(SOURCE, { filename: 'registration.js' }).runInContext(sandbox)

  const env = {
    SMLN, logs, problems, live, state,
    register: SMLN.register,
    as(modId) { return SMLN.register.as(modId) },
    conflicts() { return SMLN.register.conflicts() },
    /** game:ready: FH appears and the queue drains. */
    async ready() {
      SMLN.game = FH
      assert(readyFn, 'registration.js never subscribed to whenReady')
      readyFn()
      await tick()
      await tick()
    },
    /** Every conflict problem filed at warn severity. */
    conflictProblems() {
      return problems.filter((p) => p.channel === 'reportProblem' &&
        p.payload && p.payload.code === 'E_CONTENT_CONFLICT')
    },
  }
  return env
}

/** Swallow the rejection of a refused registration; it is expected. */
function quiet(promise) {
  return promise.then((v) => ({ ok: true, value: v }), (e) => ({ ok: false, error: e }))
}

// --------------------------------------------------------------------- tests

async function testTwoOwnersAreReported() {
  const env = boot()
  const a = quiet(env.as('corelib').element({ id: 'trash', from: 'corelib' }))
  const b = quiet(env.as('trashelement').element({ id: 'trash', from: 'trashelement' }))
  await env.ready()
  const first = await a
  const second = await b

  assert(first.ok, 'the first registration was refused')
  assert(!second.ok, 'the duplicate was accepted, so this test is no longer testing anything')
  assert(second.error.code === 'E_DUPLICATE', 'refusal code changed: ' + second.error.code)

  const filed = env.conflictProblems()
  assert(filed.length === 1, 'expected exactly one conflict problem, got ' + filed.length)
  const msg = filed[0].payload.message
  assert(/corelib/.test(msg), 'the report does not name corelib: ' + msg)
  assert(/trashelement/.test(msg), 'the report does not name trashelement: ' + msg)
  assert(/\belement\b/.test(msg), 'the report does not say what kind of content: ' + msg)
  assert(/"trash"/.test(msg), 'the report does not name the id: ' + msg)
  assert(/[Dd]isable one of the two mods/.test(msg),
    'the report does not say what to do about it: ' + msg)
  assert(filed[0].payload.severity === 'warn',
    'a conflict was filed at ' + filed[0].payload.severity + ', not warn')
  assert(filed[0].payload.modId === 'trashelement',
    'the problem was attributed to ' + filed[0].payload.modId +
    ', not to the mod whose content went missing')
  assert(env.logs.some((l) => /^warn: content conflict:/.test(l)),
    'nothing reached the log channel: ' + env.logs.join(' | '))
}

async function testSameOwnerIsNotReported() {
  const env = boot()
  const a = quiet(env.as('corelib').element({ id: 'trash', pass: 1 }))
  const b = quiet(env.as('corelib').element({ id: 'trash', pass: 2 }))
  await env.ready()
  await a
  await b

  assert(env.conflictProblems().length === 0,
    'a mod re-registering its own id was reported as a conflict')
  assert(env.conflicts().count === 0,
    'a mod re-registering its own id landed in the conflict ledger')
  assert(!env.logs.some((l) => /content conflict/.test(l)),
    'a mod re-registering its own id reached the log as a conflict')
}

async function testGameCollisionIsNotBlamedOnAMod() {
  // The id is already in the game's own registry and no mod ever claimed it,
  // so there is no second mod to name. It must not invent one.
  const env = boot({ gameElements: { sand: { builtin: true } } })
  const r = quiet(env.as('corelib').element({ id: 'sand' }))
  await env.ready()
  const out = await r

  assert(!out.ok && out.error.code === 'E_DUPLICATE', 'the built-in collision was not refused')
  assert(env.conflictProblems().length === 0,
    'a collision with the game\'s own registry was reported as a mod-vs-mod conflict')
}

async function testInEffectMatchesTheRegistry() {
  const env = boot()
  const a = quiet(env.as('corelib').element({ id: 'trash', from: 'corelib' }))
  const b = quiet(env.as('trashelement').element({ id: 'trash', from: 'trashelement' }))
  await env.ready()
  await a
  await b

  const rec = env.conflicts().conflicts[0]
  assert(rec, 'no conflict was recorded')

  // The claim the report makes...
  assert(rec.inEffect === 'corelib', 'the report says ' + rec.inEffect + ' is in effect')
  assert(rec.refused === 'trashelement', 'the report says ' + rec.refused + ' was refused')

  // ...checked against what the registry really holds. `execute()` refuses a
  // duplicate before calling FH, so the first claim is the one the game has.
  const held = env.live.elements.trash
  assert(held, 'nothing reached the game registry at all')
  assert(held.from === rec.inEffect,
    'the report names ' + rec.inEffect + ' but the registry holds ' + held.from + '\'s definition')
  assert(new RegExp(rec.inEffect + '\'s element is the one in effect').test(rec.message),
    'the message does not say which one is in effect: ' + rec.message)
}

async function testNothingIsReportedBeforeDrain() {
  const env = boot()
  const a = quiet(env.as('corelib').element({ id: 'trash' }))
  const b = quiet(env.as('trashelement').element({ id: 'trash' }))

  // Queued, not run. A detector that answered here would call an empty ledger
  // a clean bill of health.
  await tick()
  const early = env.conflicts()
  assert(early.count === 0, 'a conflict was reported before anything ran')
  assert(early.drained === false, 'the ledger claimed to be drained before game:ready')
  assert(early.ready === false,
    'the query offered an answer before there was anything to have a conflict about')
  assert(env.conflictProblems().length === 0, 'a problem was filed before anything ran')

  await env.ready()
  await a
  await b

  const late = env.conflicts()
  assert(late.ready === true, 'the query is still not ready after a full drain')
  assert(late.count === 1, 'the conflict was not found after the drain: ' + late.count)
}

async function testDrainedButEmptyIsNotACleanBill() {
  // Nothing registered at all: `drained` alone would say "no conflicts", which
  // is technically true and useless. `ready` has to withhold that answer.
  const env = boot()
  await env.ready()
  const info = env.conflicts()
  assert(info.drained === true, 'the queue never drained')
  assert(info.registered === 0, 'something registered in an empty run')
  assert(info.ready === false,
    'an empty run was presented as a checked, conflict-free one')
}

async function testAThrowingReporterDoesNotStopRegistration() {
  // Both channels broken: the log throws and the IPC bridge throws.
  const env = boot({ logThrows: true, reportThrows: true })
  const a = quiet(env.as('corelib').element({ id: 'trash', from: 'corelib' }))
  const b = quiet(env.as('trashelement').element({ id: 'trash', from: 'trashelement' }))
  const c = quiet(env.as('corelib').terrain({ id: 'soil', from: 'corelib' }))
  await env.ready()
  const first = await a
  const second = await b
  const third = await c

  assert(first.ok, 'a broken reporter took out the registration that came before it')
  assert(third.ok, 'a broken reporter took out the registration that came after it')
  assert(env.live.elements.trash && env.live.elements.trash.from === 'corelib',
    'the winning element never reached the registry')
  assert(env.live.terrains.soil, 'the following terrain never reached the registry')
  assert(!second.ok && second.error.code === 'E_DUPLICATE',
    'the duplicate stopped being refused when the reporter broke')

  // The ledger is still right even though nobody could be told.
  const info = env.conflicts()
  assert(info.count === 1, 'the conflict was lost when reporting failed: ' + info.count)
  assert(info.conflicts[0].inEffect === 'corelib', 'the ledger recorded the wrong winner')
}

async function testARejectedReportIsSwallowed() {
  const rejections = []
  const onUnhandled = (e) => rejections.push(e)
  process.on('unhandledRejection', onUnhandled)
  try {
    const env = boot({ reportRejects: true })
    const a = quiet(env.as('corelib').element({ id: 'trash' }))
    const b = quiet(env.as('trashelement').element({ id: 'trash' }))
    await env.ready()
    await a
    await b
    await tick()
    assert(env.conflicts().count === 1, 'the conflict was not recorded')
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }
  assert(rejections.length === 0,
    'a failed problem report left an unhandled rejection behind')
}

async function testTheQueryAnswersZeroOneAndSeveral() {
  // Zero: real registrations, no collisions.
  const zero = boot()
  const z = [
    quiet(zero.as('corelib').element({ id: 'trash' })),
    quiet(zero.as('trashelement').element({ id: 'scrap' })),
    quiet(zero.as('corelib').terrain({ id: 'soil' })),
  ]
  await zero.ready()
  await Promise.all(z)
  const zi = zero.conflicts()
  assert(zi.ready === true, 'a run with three registrations is not ready')
  assert(zi.count === 0 && zi.conflicts.length === 0,
    'conflicts were invented where there were none: ' + zi.count)
  assert(zi.registered === 3, 'registered count is ' + zi.registered + ', not 3')

  // One.
  const one = boot()
  const o = [
    quiet(one.as('corelib').element({ id: 'trash' })),
    quiet(one.as('trashelement').element({ id: 'trash' })),
    quiet(one.as('corelib').terrain({ id: 'soil' })),
  ]
  await one.ready()
  await Promise.all(o)
  const oi = one.conflicts()
  assert(oi.count === 1 && oi.conflicts.length === 1, 'expected one conflict, got ' + oi.count)
  assert(oi.conflicts[0].type === 'element' && oi.conflicts[0].id === 'trash',
    'the one conflict is described as ' + oi.conflicts[0].type + ' "' + oi.conflicts[0].id + '"')

  // Several, across kinds and owners - and a mod that claims the same id twice
  // must not inflate the count.
  const many = boot()
  const m = [
    quiet(many.as('corelib').element({ id: 'trash' })),
    quiet(many.as('trashelement').element({ id: 'trash' })),
    quiet(many.as('trashelement').element({ id: 'trash' })),   // same claim again
    quiet(many.as('corelib').terrain({ id: 'soil' })),
    quiet(many.as('soilmod').terrain({ id: 'soil' })),
    quiet(many.as('corelib').element({ id: 'ash' })),
    quiet(many.as('ashmod').element({ id: 'ash' })),
  ]
  await many.ready()
  await Promise.all(m)
  const mi = many.conflicts()
  assert(mi.count === 3, 'expected three conflicts, got ' + mi.count + ': ' +
    mi.conflicts.map((c) => c.type + ':' + c.id + ':' + c.refused).join(', '))
  assert(many.conflictProblems().length === 3,
    'expected three problems filed, got ' + many.conflictProblems().length)
  const kinds = mi.conflicts.map((c) => c.type + ' ' + c.id).sort().join(', ')
  assert(kinds === 'element ash, element trash, terrain soil', 'wrong conflicts: ' + kinds)

  // The returned list is a copy: a caller cannot corrupt the ledger.
  mi.conflicts.length = 0
  assert(many.conflicts().count === 3, 'the ledger was mutated by its own reader')
}

async function testTheConsoleAsksTheSameQuestion() {
  // The console command is the player-facing form of the query. This checks it
  // is wired and that "conflicts" is not swallowed as a content kind.
  const { createDom } = require('./dom-harness')
  const prelude = require('../src/renderer/prelude')
  const dom = createDom()
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: dom.document,
    window: dom.window,
    navigator: { language: 'en-US' },
    location: { search: '' },
    setTimeout, clearTimeout, setInterval, clearInterval,
    WeakSet,
    MutationObserver: dom.window.MutationObserver,
    electron: { log() {} },
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  sandbox.window.document = dom.document
  vm.createContext(sandbox)
  new vm.Script(prelude.build({ reload: true, mods: [], locale: 'en' }),
    { filename: 'prelude.js' }).runInContext(sandbox)

  const S = sandbox.__SMLN__
  assert(S && S.commands && S.commands.content, 'the content command is missing')
  assert(typeof S.register.conflicts === 'function',
    'SMLN.register.conflicts() is not exposed on the installed runtime')

  const out = S.commands.content.run(['conflicts'])
  assert(Array.isArray(out) && out.length, 'content conflicts printed nothing')
  assert(!out.some((l) => /no such content kind/.test(l)),
    '"conflicts" was treated as a content kind: ' + out.join(' | '))
  // Nothing has drained in this harness, so it must say so rather than
  // claiming a clean bill of health.
  assert(/has not run yet/.test(out[0]), 'unexpected answer before drain: ' + out[0])

  const values = S.commands.content.args[0].values()
  assert(values.indexOf('conflicts') >= 0, 'conflicts is missing from the completion list')

  // The four answers a player can get, driven through the real formatter.
  const answer = (info) => {
    S.register.conflicts = () => info
    return S.commands.content.run(['conflicts']).join('\n')
  }

  const nothingYet = answer({ ready: false, drained: true, queued: 0, registered: 0, count: 0, conflicts: [] })
  assert(/nothing to conflict/.test(nothingYet),
    'a drained-but-empty run was not distinguished: ' + nothingYet)

  const clean = answer({ ready: true, drained: true, queued: 0, registered: 12, count: 0, conflicts: [] })
  assert(/no content conflicts: 12 registration/.test(clean), 'clean answer reads: ' + clean)

  const one = answer({
    ready: true, drained: true, queued: 0, registered: 4, count: 1,
    conflicts: [{ type: 'element', id: 'trash', inEffect: 'corelib', refused: 'trashelement', message: 'DO THIS' }],
  })
  assert(/1 content conflict/.test(one) && /element "trash"/.test(one) &&
    /in effect: corelib/.test(one) && /refused: trashelement/.test(one) && /DO THIS/.test(one),
    'one-conflict answer reads: ' + one)

  const several = answer({
    ready: true, drained: true, queued: 0, registered: 9, count: 2,
    conflicts: [
      { type: 'element', id: 'trash', inEffect: 'corelib', refused: 'trashelement', message: 'A' },
      { type: 'terrain', id: 'soil', inEffect: 'corelib', refused: 'soilmod', message: 'B' },
    ],
  })
  assert(/2 content conflict/.test(several) && /terrain "soil"/.test(several) &&
    /element "trash"/.test(several), 'several-conflict answer reads: ' + several)
}

const TESTS = [
  testTwoOwnersAreReported,
  testSameOwnerIsNotReported,
  testGameCollisionIsNotBlamedOnAMod,
  testInEffectMatchesTheRegistry,
  testNothingIsReportedBeforeDrain,
  testDrainedButEmptyIsNotACleanBill,
  testAThrowingReporterDoesNotStopRegistration,
  testARejectedReportIsSwallowed,
  testTheQueryAnswersZeroOneAndSeveral,
  testTheConsoleAsksTheSameQuestion,
]

;(async function main() {
  for (const t of TESTS) {
    try {
      await t()
    } catch (e) {
      console.error('FAIL duplicate-registration detection: ' + t.name + ': ' + e.message)
      process.exit(1)
    }
  }
  console.log('PASS duplicate-registration detection (' + TESTS.length + ' checks)')
})().catch((e) => {
  console.error('FAIL duplicate-registration detection:', (e && e.stack) || e)
  process.exit(1)
})
