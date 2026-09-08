# A Sandkit for worker mods

**Date:** 2026-09-08
**Status:** approved, not yet implemented
**Game:** Sandustry 0.5.6 (Steam, Electron 33.2.1)
**Goal:** Give `workerEntry` mods a real API inside the simulation workers, and
make the Fluxloader worker mods that exist today do something other than die.

## Problem

### 1. Worker mods have no API at all

The README states it plainly:

> A mod with a `workerEntry` is injected into the simulation workers, but there
> is no worker-side `sandkit` for it to call, so it logs
> `worker mod failed: ReferenceError: sandkit is not defined` and stops.

That is accurate about the symptom and wrong about the cause. The worker builds
a Sandkit of its own — read out of `dist/js/simulation-worker.js`:

```js
sandkit:{
  getApi:()=>c.FH,
  jsonConfigs:…,
  mods:{elements:{},matters:{}},
  workerEvents:{}, workerEventsByGuard:{},
  workerInterceptors:{}, workerInterceptorsByGuard:{},
  workerModifiers:{}, workerModifiersByGuard:{},
  workerLocal:{}, workerEventTriggerCounts:{}
}
```

Unlike the renderer — where `getApi` is called 45 times and never defined —
the worker's `getApi` **is** defined. There is even a dispatch system the game
drives itself, indexed by element and terrain type with wildcards, and
interceptors that can cancel:

```js
e.sandkit.workerEvents[t]        // handlers, called as fn(state, payload)
e.sandkit.workerInterceptors[t]  // same, with a cancellable context
```

So the surface exists and works. What is missing is a **handle** on it. An
injected worker script runs in the worker's global scope; the state object is
module-local, so `sandkit` is genuinely not a name the script can see.

### 2. The Fluxloader worker mods are dead by construction

`refinement/entry.worker.js` — the only bundled mod with real worker logic —
does not use Sandkit at all:

```js
fluxloaderAPI.events.on("cl:raw-api-setup", () => { corelib.blockRecipes.Melter = melt })
const elementName = corelib.utils.getParticleNameFromNumber(element?.type)
corelib.simulation.setCell(x, y, 0)
```

It depends entirely on **corelib's** worker API. And corelib builds that API
out of raw bundle bindings:

```js
soils:  corelib.exposed.raw.i.vZ,   setCell:      corelib.exposed.raw.u.Jx,
blocks: corelib.exposed.raw.i.ev,   getCellAtPos: corelib.exposed.raw.u.tT,
tech:   corelib.exposed.raw.i.xQ,   moveCell:     corelib.exposed.raw.u.L3,
```

`exposed.raw` is filled by two patches that capture roughly 250 minified
identifiers by name:

```js
fluxloaderAPI.setPatch("js/bundle.js", "corelib:expose", { to:
  `globalThis.corelib.exposed.raw = {kf,Cf,Ef,Tf,_f,Sf,wf,bf,xf,vf,gf,df,…};` })

fluxloaderAPI.setPatch("js/336.bundle.js", "corelib:expose", { to:
  `globalThis.corelib.exposed.raw = {a,n,o,i,l,s,d,u,c,v,h,p,f,g,A,b,R,w,…};` })
```

The names the worker half reads — `raw.i`, `raw.u`, `raw.c` — come from the
second one, and **`js/336.bundle.js` does not exist on 0.5.6**. The build
stopped splitting into numbered chunks; the 0.3.4 changelog already recorded
that for the renderer.

Measured, loading all 12 installed Fluxloader mods through the bridge:

| | count |
|---|---|
| patches registered in total | 99 |
| targeting `js/bundle.js` | 73 |
| targeting chunks that no longer exist (336/515/546) | 25 |
| targeting `index.html` | 1 |
| **targeting any worker file** | **0** |

So `raw.i/u/c` are never populated, `cl:raw-api-setup` fires with nothing behind
it, and every worker mod built on corelib fails on its first call.

This cannot be fixed by retargeting anchors. It would mean reconstructing ~250
minified bindings from a module layout the build no longer has — and minified
names are regenerated every release, so even a success would not survive the
next patch.

The renderer faced this exact wall: 75 of corelib's 92 anchors matched nothing,
and the answer was to bypass corelib's patches and translate into the game's own
registries. The same answer applies here, and more strongly.

## Design

### Capturing the worker state

A new core patch, `smln:capture-worker-state`, on `js/simulation-worker.js`.
Measured: that is the only one of the three worker bundles that builds the full
Sandkit. `js/utility-worker.js` contains no `sandkit:{` construction at all (it
only reads `e.sandkit` off state handed to it), and `js/manager-worker.js`
builds a minimal one, `{jsonConfigs, getApi:()=>({workers:{messages:...}}),
mods:{triggers:{}}}`, whose whole surface is worker messaging. Capturing the
manager's state is possible with its own anchor and is deliberately out of scope
until a mod needs it.

The patch anchors on the end of the Sandkit literal and the statement that
follows it, which names the state:

```js
find: /(sandkit:\{getApi:\(\)=>[\w$.]+,[^]{0,400}?workerEventTriggerCounts:\{\}\}\}),(\w+)\.session\.mainSensorCache/
replace: `$1,(globalThis.__SMLN_WORKER__=globalThis.__SMLN_WORKER__||{}).state=$2,$2.session.mainSensorCache`
```

Verified against the shipped bundle: exactly one match, with the state named
`ue`. The pattern reads that name out of the match rather than assuming it;
minified names are regenerated every release, shapes are not.

The patch is **not** `required`. A build whose shape moves must cost worker mods
their API, never the player their game. `src/patch/autoheal.js` reports it the
same way it reports every other anchor.

### Handing it to mods

`src/renderer/worker-runtime.js` gains, beside the messaging it already
provides:

- `SMLN.state` — the captured state
- `SMLN.sandkit` — `state.sandkit`
- `SMLN.game` — `state.sandkit.getApi()`
- `SMLN.whenWorkerReady(fn)` — defers until the capture has happened, so a mod
  that loads before the state exists is not left guessing

On top of that a thin, safe layer over the game's dispatch tables:

- `SMLN.worker.onEvent(name, fn)` and `SMLN.worker.onInterceptor(name, fn)`

Both attribute the handler to its mod, wrap it so a throw is logged and
swallowed rather than killing a simulation tick, and record the registration so
hot reload can reclaim it — the same contract the renderer half already keeps
for listeners and timers.

### Translating corelib's worker calls

A worker-side compat shim provides what the existing mods actually reach for:

- `fluxloaderAPI` — `events` (on/registerEvent/trigger/tryTrigger) and config,
  carried over the worker messaging channel that already exists
- `corelib` — a `utils` and `simulation` surface implemented against the game's
  worker API instead of `exposed.raw`

Only calls with a real equivalent are translated: `setCell`, `getCellAtPos`,
`moveCell`, `createParticle`, `getParticleNameFromNumber`. Everything else is
reported through the existing unsupported-content channel, per call site, so a
player sees which mod wanted what.

**corelib's own `entry.worker.js` is not executed.** It would fail on its first
line touching `exposed.raw`, and running it only to watch it fail helps nobody.
The shim publishes the `corelib` global itself, carrying the translated surface.

This is a stronger intervention than the renderer's, where corelib runs and its
calls are intercepted. It is also the point in this design most likely to be
wrong: a mod reaching for a corelib method the shim does not implement gets a
report rather than a working call, and corelib's worker half may do things
beyond the surface its dependents are observed to use. If that turns out to
matter, the alternative is not "run corelib unchanged" — that cannot work — but
widening the translated surface, which is additive.

### Failing honestly

- Capture did not happen: worker mods are told once, with the reason, and the
  game runs on untouched.
- A translated call with no equivalent: reported per call, never a silent no-op.
- A mod handler throws: logged against the mod, the tick continues.

## Verification

Plain Node:

- the capture pattern against the real 0.5.6 `simulation-worker.js`,
  asserting exactly one match and that the patched result still parses
- and against `utility-worker.js` and `manager-worker.js`, asserting **no**
  match, so a future build that starts constructing a Sandkit there is noticed
  rather than silently half-supported
- the state identifier is read from the match rather than hard-coded
- each translated corelib method against a fake worker API
- an unimplemented method reports rather than throwing
- a throwing mod handler is isolated

In the running game, which is where the recipe work found four defects no unit
test could have: enable corelib and a worker mod, read the loader log, and
confirm the capture, the handler registration and the translated calls.

## Risks

- **Worker patches are new ground.** SandLoader has never patched a worker file;
  three of them exist and the simulation runs across 18 threads.
- **Only the simulation worker gains the API.** A mod whose `workerEntry` runs
  in the utility worker keeps messaging and nothing else, and has to be told so
  rather than left to discover it.
- **The translated surface is a subset.** `refinement` also wants
  `corelib.blockRecipes`, which has no game equivalent yet and may stay
  unsupported.
- **Time to first proof is longer** than the recipe work, because nothing is
  demonstrable until both the capture and the shim exist.

## Non-goals

Reviving `corelib.exposed.raw`. Map-mod loading, which has its own gap and its
own spec. The `workerModifiers` table, which no bundled mod uses — YAGNI until
one does.
