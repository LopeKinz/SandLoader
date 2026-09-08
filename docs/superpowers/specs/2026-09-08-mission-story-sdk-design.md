# Mission and story SDK

**Date:** 2026-09-08
**Status:** approved to build
**Game:** Sandustry 0.5.6 (Steam, Electron 33.2.1)
**Goal:** Let a mod write missions and story, and let those reach across mods.

## What the game gives us, measured

Two investigations against the shipped bundle, with every load-bearing claim
re-measured against the running game before this was written:

| | found | entries | frozen | extensible | fields |
|---|---|---|---|---|---|
| objectives `qs` (module 92659) | yes | 12 | no | yes | `titleKey, descriptionKey, nextObjectives, check` |
| story steps `getSteps()` | yes | 10 | no | yes | `id, messages, objective` |

`getSteps()` returns the same array reference on every call. Both tables are
live, mutable and reachable — `qs` through `SMLN.webpack.get('92659')`, the
steps through the game's own `progression.getSteps`/`setSteps`.

That is the whole opportunity. It is also the whole problem: there is no
registry API, and `progression.complete` refuses any id not already in the
private table. A mod can be in the story only by being put into that table.

## Why an SDK rather than "here is the table"

Handing mods the raw tables would work on the happy path and fail everywhere
else, because the game's own systems assume they are the only writer. Four gaps
were measured, and each one is a piece of this SDK:

1. **`check` is data, but nothing runs it.** The evaluator is generic, yet it
   fires at only three event sites, and seven of the twelve vanilla objectives
   are completed by hard-coded calls elsewhere. A mod's predicate would sit
   there unevaluated. **The SDK drives evaluation itself.**

2. **Completion is not durable.** A completed entry is deleted five seconds
   later and again at world load, and no completed-set exists anywhere. A mod's
   objective would un-complete itself. **The SDK keeps its own record and
   restores it at load.**

3. **Speakers have no registry.** The portrait table has two entries, no
   accessor, no export, three references in 4.3 MB, and an unknown speaker
   silently becomes ZOE — so a mod's character would wear someone else's face
   with no error at all. **One patch gives that table a shared identity mods
   can write into.**

4. **Nothing knows what a mod needs.** **The SDK takes dependencies as data**
   and refuses to register content whose mod is absent, naming both, instead of
   registering something that silently never fires.

## The surface

Scoped per mod through the existing `SMLN.forMod(id)`, so unloading a mod takes
its content with it — the disposal path already exists and is not reinvented.

```js
const story = SMLN.forMod('my.mod').story

story.speaker('kira', { name: 'KIRA', portrait: 'assets/kira.png', color: '#8ec5ff' })

story.objective({
  id: 'find-fluxite',
  title: 'Find fluxite',
  description: 'Locate a vein in the deep layer',
  check: (state) => story.count(state, 'fluxite') > 0,
  next: ['refine-fluxite'],
})

story.step({
  id: 'intro',
  after: 'reach_factory_tier_2',
  messages: [
    { speaker: 'kira', text: 'The readings are wrong.' },
    { speaker: 'zoe', text: 'They are not.', italic: true },
  ],
  completeWhen: { objective: 'find-fluxite' },
})
```

### Ids are namespaced, always

`find-fluxite` registers as `my.mod:find-fluxite`. Two mods cannot collide, the
owner of a broken objective is visible in a log line without a lookup, and a
cross-mod reference has to name the mod it means — which is what makes the next
section honest rather than accidental.

Vanilla ids stay bare, so `after: 'reach_factory_tier_2'` means the game's own
step and cannot be shadowed by a mod's.

## Reaching across mods

Three ways, in increasing order of coupling.

**Declared dependency.** `requires: ['gas-pipes']` — the objective or step is
not registered at all if that mod is absent or disabled, and the reason is
recorded through the existing problems channel with both mod ids. A mission
that silently never completes is the failure this exists to prevent.

**Reference by full id.** `completeWhen: { objective: 'other.mod:their-goal' }`
and `after: 'other.mod:their-step'`. A reference to something that never
registers is reported once, by name, rather than waited on forever.

**Events.** `story.emit('reactor-online')` publishes `my.mod:reactor-online`;
any mod completes on `completeWhen: { event: 'my.mod:reactor-online' }`. This
is the loose coupling: the emitting mod needs to know nothing about who
listens, which is what lets a mission pack ship for a machine mod that has
never heard of it.

Ordering across mods is by declaration, not by load order: a step naming an
`after` that has not registered yet waits for it and is inserted when it
arrives. Load order is not something a mod author can control, so it must not
be something they have to reason about.

## Evaluation

The SDK ticks the predicates it owns — never the game's — on a bounded cadence
rather than every frame, because a mod's predicate must not become a cost the
simulation pays. A predicate that throws is disabled after a small number of
throws and reported with its mod id, on the principle the loader already uses
elsewhere: one bad mod must not take the others down, and a silent no-op is
worse than a named failure.

## Durability

The SDK keeps its own completed set in the saved half of the state, under its
own key, and re-applies it at world load before the first evaluation. This is
the SDK's own bookkeeping, not a repair of the game's: the five-second deletion
is left alone, because fighting it would mean owning a behaviour whose reasons
we do not know.

## Text

`i18n.register(locale, table)` merges into the live table at runtime, and
lookup falls back to the raw key — both measured. So `title` may be a literal
string or a locale key, and a mod that ships neither still shows something
readable rather than an empty row.

## Verification

Plain Node, against fakes of the two tables: namespacing, dependency refusal,
cross-mod references resolving in either registration order, the event path,
the completed set surviving a simulated reload, and a throwing predicate being
disabled rather than escaping.

In the running game, which is the check that has found every real defect in
this project so far: an example mod registers a speaker, an objective and a
step; the objective completes from a predicate the SDK ticked; the step shows
the mod's own character with its own portrait; and the completion survives a
world reload.

## Risks

- **Two writers on one table.** The game assumes it is alone in `qs` and in the
  step list. The SDK writes only its own namespaced ids and never reorders or
  removes a vanilla entry, but a game update that starts rebuilding either
  table will drop mod content at that moment. The anchors report it.
- **The speaker patch is one literal in a 4.3 MB bundle.** A build that
  reshapes it costs mod portraits and nothing else: unknown speakers already
  fall back to ZOE, so the failure is cosmetic, and reported.
- **A mod's predicate runs on our tick.** The bounded cadence and the
  throw-disable rule are what keep a bad mod from becoming a frame-rate
  problem.

## Non-goals

Rewards. The objective table has no reward field at all — completion sets a
flag and chains successors — and inventing a reward system on top would be
SandLoader inventing game design rather than exposing the game. A mod that
wants to give something can do it from its own completion handler.

Replacing or rewriting vanilla objectives and steps. Additive only.
