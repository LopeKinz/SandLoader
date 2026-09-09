'use strict'
/**
 * SandLoader's own patches against the renderer bundle.
 *
 * There is deliberately only one required patch. Sandustry already ships a
 * complete internal modding API - the object the bundle calls `FH`, carrying
 * `events`, `elements`, `structures`, `terrains`, `items`, `world`, `ui`,
 * `sound`, `workers` and more - but it never publishes it to `window`.
 *
 * So SMLN does not reimplement any of that. It captures the game's own API
 * object at the moment the game announces it is ready, and hands it to mods.
 * One hook, and the entire first-party surface comes with it.
 *
 * ANCHORING, AND THE `variants` LIST
 *
 * Every anchor hangs off a string literal the game's *source* controls, never
 * a byte offset, a minified identifier or a module id. Comparing 0.5.4 with
 * 0.5.5 shows why that holds up:
 *
 *     0.5.4   ie.FH.events.emit(p,"game:ready",{state:p})
 *     0.5.5   ie.FH.events.emit(g,"game:ready",{state:g})
 *     0.5.4   (0,$s.t)("ui|mainMenu|mods")
 *     0.5.5   (0,Gs.t)("ui|mainMenu|mods")
 *
 * Only local names moved, and the backreferences and character classes below
 * already absorb that. The realistic future break is not the literal
 * disappearing, it is the *shape around it* shifting - a payload gaining a
 * field, a call losing its namespace prefix.
 *
 * `variants` is that contingency: ordered fallbacks, loosest last, all anchored
 * on the same literal. src/patch/autoheal.js tries them in order when the
 * primary stops matching, and adopts the first whose output still parses.
 * `anchorLiteral` names the invariant so that, when nothing resolves, the
 * report can show where it still appears instead of just saying "failed".
 *
 * Every patch declares how many matches it expects. Getting 0 is a failure;
 * getting more is *also* a failure, because a pattern that silently became
 * ambiguous would otherwise corrupt the bundle in several places at once.
 */

/** Global the injected runtime installs itself on. Kept ugly on purpose. */
const GLOBAL = '__SMLN__'

/** `(globalThis.__SMLN__ && __SMLN__.__capture(FH, state, phase), <original>)` */
function captureCall(ns, state, phase, original) {
  return `(globalThis.${GLOBAL}&&globalThis.${GLOBAL}.__capture(${ns}.FH,${state},"${phase}"),${original})`
}

/**
 * `globalThis.__SMLN__.storySpeakers`, created on first touch.
 *
 * Written as an expression rather than a statement so the rewrite fits
 * wherever the original assignment sat - a declaration, a comma sequence, an
 * argument list - without the patch having to know which.
 */
const SPEAKER_TABLE =
  `((globalThis.${GLOBAL}||(globalThis.${GLOBAL}={})).storySpeakers` +
  `||(globalThis.${GLOBAL}.storySpeakers={}))`

/**
 * `SMLN.topBound(state, which, fallback)`, degrading to the game's own number.
 *
 * Written as a conditional expression rather than a call because it sits in the
 * middle of the game's movement code: with SandLoader absent, or loaded but
 * older than this patch, the expression is the original literal and the frame
 * costs one property read.
 */
function topBoundCall(state, which, fallback) {
  return `(globalThis.${GLOBAL}&&globalThis.${GLOBAL}.topBound` +
    `?globalThis.${GLOBAL}.topBound(${state},"${which}",${fallback}):${fallback})`
}

/** @type {import('./engine').Patch[]} */
const corePatches = [
  {
    id: 'smln:capture-api',
    owner: 'smln',
    description: "Capture the game's internal FH modding API and live state at game:ready",
    anchorLiteral: '"game:ready"',
    // ie.FH.events.emit(p,"game:ready",{state:p})
    find: /(\w+)\.FH\.events\.emit\((\w+),"game:ready",\{state:\2\}\)/g,
    replace: (...args) => captureCall(args[1], args[2], 'game:ready', args[0]),
    expect: 1,
    required: true,
    variants: [
      {
        // The payload gained fields: {state:p,tick:0}. Still the same call.
        label: 'payload with extra fields',
        find: /(\w+)\.FH\.events\.emit\((\w+),"game:ready",\{state:\2[^}]*\}\)/g,
        replace: (...args) => captureCall(args[1], args[2], 'game:ready', args[0]),
        expect: 1,
      },
      {
        // The state argument stopped being the same identifier as the payload
        // field, so the backreference no longer holds.
        label: 'state no longer backreferenced',
        find: /(\w+)\.FH\.events\.emit\((\w+),"game:ready",\{state:(\w+)[^}]*\}\)/g,
        replace: (...args) => captureCall(args[1], args[3], 'game:ready', args[0]),
        expect: 1,
      },
      {
        // `emit` reached directly rather than through a namespace object.
        // Falls back to reading FH off the state, which is where it lives.
        label: 'emit called without an FH namespace prefix',
        find: /(?<![\w.])emit\((\w+),"game:ready",\{state:\1[^}]*\}\)/g,
        replace: (...args) => {
          const [full, st] = args
          return `(globalThis.${GLOBAL}&&${st}&&${st}.FH&&globalThis.${GLOBAL}.__capture(${st}.FH,${st},"game:ready"),${full})`
        },
        expect: 'any',
      },
    ],
  },
  {
    id: 'smln:capture-started',
    owner: 'smln',
    description: 'Second capture point after the manager loop starts, for late boot paths',
    anchorLiteral: '"game:started"',
    // ie.FH.events.emit(e,"game:started",{state:e})
    find: /(\w+)\.FH\.events\.emit\((\w+),"game:started",\{state:\2\}\)/g,
    replace: (...args) => captureCall(args[1], args[2], 'game:started', args[0]),
    expect: 1,
    required: false,
    variants: [
      {
        label: 'payload with extra fields',
        find: /(\w+)\.FH\.events\.emit\((\w+),"game:started",\{state:\2[^}]*\}\)/g,
        replace: (...args) => captureCall(args[1], args[2], 'game:started', args[0]),
        expect: 1,
      },
      {
        label: 'state no longer backreferenced',
        find: /(\w+)\.FH\.events\.emit\((\w+),"game:started",\{state:(\w+)[^}]*\}\)/g,
        replace: (...args) => captureCall(args[1], args[3], 'game:started', args[0]),
        expect: 1,
      },
    ],
  },
  {
    id: 'smln:mods-menu-open',
    owner: 'smln',
    description: "Open SandLoader's mod manager instead of the game's Workshop screen",
    anchorLiteral: '.modsScreen.open',
    /*
     * The main-menu entry sets this flag from two handlers (onActivate and the
     * inner onClick). Routing the *assignment* rather than a click listener
     * means it does not matter which one fires, and it needs no DOM anchor -
     * the `id:"main-menu-mods"` in the source is a React prop on a custom
     * component, never a DOM id, so a DOM hook cannot see it.
     *
     * When SMLN is present the game's own screen stays closed (the flag ends up
     * false) and our overlay opens instead. Without SMLN the expression is just
     * `true` and the game behaves exactly as shipped.
     */
    find: /\.modsScreen\.open=!0/g,
    replace: () =>
      `.modsScreen.open=(globalThis.${GLOBAL}&&globalThis.${GLOBAL}.modsUI` +
      `?(globalThis.${GLOBAL}.modsUI.toggle(!0),!1):!0)`,
    expect: 2,
    required: false,
    variants: [
      {
        // A handler was added or removed, so the count moved. The rewrite is
        // idempotent per site, so any number of them is fine.
        label: 'any number of assignment sites',
        find: /\.modsScreen\.open=!0/g,
        replace: () =>
          `.modsScreen.open=(globalThis.${GLOBAL}&&globalThis.${GLOBAL}.modsUI` +
          `?(globalThis.${GLOBAL}.modsUI.toggle(!0),!1):!0)`,
        expect: 'any',
      },
      {
        // Un-minified or differently minified boolean: `= true`.
        label: 'assignment written as = true',
        find: /\.modsScreen\.open\s*=\s*true/g,
        replace: () =>
          `.modsScreen.open=(globalThis.${GLOBAL}&&globalThis.${GLOBAL}.modsUI` +
          `?(globalThis.${GLOBAL}.modsUI.toggle(!0),!1):!0)`,
        expect: 'any',
      },
    ],
  },
  {
    id: 'smln:maps-menu-open',
    owner: 'smln',
    description: "Open SandLoader's map browser instead of the game's own (unfinished) one",
    anchorLiteral: '.customMapsScreen.open',
    /*
     * Same shape and same reason as smln:mods-menu-open just above: the
     * main-menu "Maps" entry sets this flag from two handlers (onActivate and
     * the inner onClick), so routing the assignment covers both regardless of
     * which one fires, with no DOM anchor needed.
     *
     * The game's own custom-maps screen is real but visibly unfinished in this
     * build (its "load" button lands on a "coming soon" panel), while the
     * `window.electron.customMaps` bridge it would use is already live. When
     * SMLN is present the flag ends up false and our overlay opens instead;
     * without SMLN the expression is just `true` and the game behaves exactly
     * as shipped.
     */
    find: /\.customMapsScreen\.open=!0/g,
    replace: () =>
      `.customMapsScreen.open=(globalThis.${GLOBAL}&&globalThis.${GLOBAL}.mapsUI` +
      `?(globalThis.${GLOBAL}.mapsUI.toggle(!0),!1):!0)`,
    expect: 2,
    required: false,
    variants: [
      {
        // A handler was added or removed, so the count moved. The rewrite is
        // idempotent per site, so any number of them is fine.
        label: 'any number of assignment sites',
        find: /\.customMapsScreen\.open=!0/g,
        replace: () =>
          `.customMapsScreen.open=(globalThis.${GLOBAL}&&globalThis.${GLOBAL}.mapsUI` +
          `?(globalThis.${GLOBAL}.mapsUI.toggle(!0),!1):!0)`,
        expect: 'any',
      },
      {
        // Un-minified or differently minified boolean: `= true`.
        label: 'assignment written as = true',
        find: /\.customMapsScreen\.open\s*=\s*true/g,
        replace: () =>
          `.customMapsScreen.open=(globalThis.${GLOBAL}&&globalThis.${GLOBAL}.mapsUI` +
          `?(globalThis.${GLOBAL}.mapsUI.toggle(!0),!1):!0)`,
        expect: 'any',
      },
    ],
  },
  {
    id: 'smln:mods-menu-label',
    owner: 'smln',
    description: 'Rename the main-menu entry to "SandLoader Mods"',
    anchorLiteral: '"ui|mainMenu|mods"',
    // Anchored on the translation key, which is authored source. Falls back to
    // the game's own localised string whenever SMLN is absent, so the menu is
    // never left blank. Identifier classes include `$` and `_`: minifiers emit
    // names like `$s`, and `\w` alone silently fails to match them.
    find: /\(0,([\w$]+)\.t\)\("ui\|mainMenu\|mods"\)/g,
    replace: (...args) => {
      const [full, ns] = args
      return `((globalThis.${GLOBAL}&&globalThis.${GLOBAL}.menuLabel)||(0,${ns}.t)("ui|mainMenu|mods"))`
    },
    expect: 1,
    required: false,
    variants: [
      {
        // The sequence-expression wrapper webpack emits went away.
        label: 'called without the (0,ns.t) wrapper',
        find: /([\w$]+\.)?t\("ui\|mainMenu\|mods"\)/g,
        replace: (...args) => {
          const [full] = args
          return `((globalThis.${GLOBAL}&&globalThis.${GLOBAL}.menuLabel)||${full})`
        },
        expect: 'any',
      },
      {
        // Last resort: wrap whatever call encloses the key. Only the literal is
        // assumed, which is the one thing that has never moved.
        label: 'any call taking the translation key',
        find: /([\w$.]{1,40}\()\s*"ui\|mainMenu\|mods"\s*\)/g,
        replace: (...args) => {
          const [full] = args
          return `((globalThis.${GLOBAL}&&globalThis.${GLOBAL}.menuLabel)||${full})`
        },
        expect: 'any',
      },
    ],
  },
  {
    id: 'smln:sandkit-get-api',
    owner: 'smln',
    description: 'Define state.sandkit.getApi(), which the renderer calls but never defines',
    anchorLiteral: 'sandkit=',
    /*
     * The renderer builds its Sandkit object as registries only:
     *
     *   g.sandkit={mods:{items:{},projectiles:{},misc:{},elements:{},
     *              matters:{},structures:{},triggers:{},terrains:{}},
     *              graphics:{},events:{},hooks:{},keyBindings:{}}
     *
     * then calls `state.sandkit.getApi()` in 44 places without ever defining
     * it. Only the simulation worker defines one, as `getApi:()=>FH`. The
     * method is a field the mod host is expected to attach, and Sandustry ships
     * no host - it delegates to whatever occupies the Workshop loader slot,
     * which is us. So we owe it.
     *
     * Anchored on the property-name-plus-shape of the literal rather than the
     * minified state identifier, which is regenerated every build. The single
     * capture is the object body; we re-emit it with getApi appended.
     *
     * getApi returns the same FH the worker's implementation returns, resolved
     * lazily through the captured runtime so this stays correct no matter
     * whether the patch or the capture runs first. Falling back to the raw
     * global keeps the game's own 44 call sites working even if SMLN is
     * somehow absent, because those calls are the game's, not ours - breaking
     * them would break vanilla gameplay, which outranks loading any mod.
     */
    /*
     * Two shapes, because the game changed which one it emits.
     *
     * Up to 0.5.5 the registry was an object literal assigned straight to
     * `sandkit`, and the capture is its body, re-emitted with getApi appended.
     * 0.5.6 builds the object first and assigns only the identifier:
     *
     *   …keyBindings:{}});E.jsonConfigs=x,M.sandkit=E,…
     *
     * A literal-only pattern misses that entirely, which left the game's own
     * 45 getApi call sites pointing at undefined - every mod registration on
     * the build, dead. The second branch anchors on the assignment instead, so
     * how the object got built stops mattering, and `getApi||` leaves a build
     * that starts defining its own alone.
     */
    find: /sandkit=(?:\{(mods:\{[^]{0,400}?keyBindings:\{\})\}|([A-Za-z_$][\w$]*)(?=[,;]))/g,
    replace: (...args) => {
      const [, body, id] = args
      const impl = `function(){` +
        `var g=globalThis.${GLOBAL};` +
        `return (g&&g.game)||(g&&g.state&&g.state.FH)||null}`
      if (body) return `sandkit={${body},getApi:${impl}}`
      return `sandkit=${id},${id}.getApi=${id}.getApi||${impl}`
    },
    expect: 1,
    // Not required: a build that starts defining getApi itself is a fixed
    // build, not a broken one. official-host.js reports the outcome either way.
    required: false,
    variants: [
      {
        // Registry set changed (a new `mods:` bucket, a renamed one). Anchor
        // only on the two ends that have been stable across 0.5.x.
        label: 'registry object with a different field set',
        find: /sandkit=\{(mods:\{[^]{0,800}?\})\}(?=[,;])/g,
        replace: (...args) => {
          const [, body] = args
          return `sandkit={${body},getApi:function(){` +
            `var g=globalThis.${GLOBAL};` +
            `return (g&&g.game)||(g&&g.state&&g.state.FH)||null}}`
        },
        expect: 'any',
      },
    ],
  },
  {
    id: 'smln:story-speakers',
    owner: 'smln',
    description: 'Give the story portrait table an identity mods can register speakers into',
    anchorLiteral: 'labelKey:"story|speaker|zoe"',
    /*
     * The dialogue box picks its portrait, its label and its frame colour out
     * of one module-scope const:
     *
     *   const mN={zoe:{portrait:"img/cool_cat2.png",labelKey:"story|speaker|zoe",…},
     *             pri:{…}};
     *
     * with no accessor, no export and no write site anywhere in the 4.3 MB
     * bundle - measured, three whole-identifier occurrences, all inside the
     * component that reads it. The read is
     * `O=I.speaker in mN?I.speaker:"zoe"`, so a speaker the table does not
     * know silently becomes ZOE. That silence is the reason this patch exists:
     * without it a mod's character wears someone else's face and nothing
     * anywhere says so.
     *
     * The rewrite keeps the table's *identity* on the global instead of in the
     * module, so mods can write into it long after this line has run:
     *
     *   const mN=Object.assign(<the shared table>,{zoe:{…},pri:{…}});
     *
     * Two properties this has to preserve, and both come from the shape:
     * `Object.assign` returns its target, so `mN` still names the same object
     * the module reads; and the vanilla entries are assigned *after* the table
     * is adopted, so a mod that registered early cannot have deleted ZOE.
     *
     * Anchored on `labelKey:"story|speaker|zoe"` - a property name plus a
     * game-authored locale key. Verified against the shipped 0.5.6 bundle:
     * exactly one occurrence, because the only other appearance of that key is
     * in the English locale table without the `labelKey:` prefix.
     *
     * NOT required. A build that reshapes this literal costs mod portraits and
     * nothing else - unknown speakers already fall back to ZOE, so the failure
     * is cosmetic - and src/renderer/story-sdk.js refuses `story.speaker()` by
     * name when the table is absent rather than registering a face that would
     * never be worn.
     */
    find: /(const|let|var) ([A-Za-z_$][\w$]*)=(\{[^;]{0,400}labelKey:"story\|speaker\|zoe"[^;]{0,400}\});/g,
    replace: (...args) => {
      const [, kw, name, body] = args
      return `${kw} ${name}=Object.assign(${SPEAKER_TABLE},${body});`
    },
    expect: 1,
    required: false,
    variants: [
      {
        // The table gained speakers, or an entry grew a field, and the body
        // outgrew the window. Same shape, more room.
        label: 'a longer speaker table',
        find: /(const|let|var) ([A-Za-z_$][\w$]*)=(\{[^;]{0,1500}labelKey:"story\|speaker\|zoe"[^;]{0,1500}\});/g,
        replace: (...args) => {
          const [, kw, name, body] = args
          return `${kw} ${name}=Object.assign(${SPEAKER_TABLE},${body});`
        },
        expect: 1,
      },
      {
        // Last resort: the declaration keyword or the statement boundary moved
        // - the table is built inside a comma sequence, or assigned to an
        // already-declared name. Only the assignment and the literal are
        // assumed. The lookbehind keeps `x.mN={…}` out, where dropping the
        // `x.` would turn a property write into a global one.
        label: 'assigned without a declaration keyword',
        find: /(?<![\w$.])([A-Za-z_$][\w$]*)=(\{[^;]{0,1500}labelKey:"story\|speaker\|zoe"[^;]{0,1500}\})/g,
        replace: (...args) => {
          const [, name, body] = args
          return `${name}=Object.assign(${SPEAKER_TABLE},${body})`
        },
        expect: 'any',
      },
    ],
  },
  /*
   * THE TWO FLIGHT CEILINGS
   *
   * The game keeps a no-fly strip along the top of the world, and reads its
   * height out of the active external map:
   *
   *   soft  hovering is cancelled above it   ...topBounds.soft)&&void 0!==r?r:600
   *   hard  the collision ceiling            ...topBounds.hard)&&void 0!==o?o:550
   *
   * `y` is in world pixels and y=0 is the top, so both numbers are the strip's
   * absolute height in pixels - not a fraction of anything.
   *
   * A SandLoader custom map leaves `store.world.externalMap` null, so both
   * fallbacks apply, and they were picked for the world the game itself ships:
   * 3840x3840 cells at cellSize 4, so 15360 pixels tall. There a 600-pixel
   * strip is 3.9% of the world. Put the same 600 pixels on the smallest map
   * the editor will make - 201 cells, 804 pixels - and it is 75% of the world.
   * The map gets shorter; the ceiling does not.
   *
   * WHY NOT JUST SET `externalMap`
   *
   * Because it is not a bag of optional fields. `getActive` clones every
   * descriptor through a normaliser that reads `t.spawn.x`, `t.unstuck.x`,
   * `t.topBounds.hard` and `t.depthLight.startY` with no optional chaining, so
   * a partial descriptor throws the moment anything asks for the active map,
   * and a complete one would mean inventing a spawn point, an unstuck point
   * and a depth-light curve. The fallback is the only thing that is wrong, so
   * the fallback is the only thing these two patches touch.
   *
   * ANCHORING
   *
   * On `topBounds.soft` / `topBounds.hard` plus the shape of the fallback the
   * TypeScript downlevelling emits around it. Verified against the shipped
   * 0.5.6 bundle: `topBounds` appears nine times, and each of these matches
   * exactly one of them. The other seven are the normaliser above (which reads
   * the property, never defaults it) and an `Object.freeze`.
   *
   * NEITHER IS REQUIRED. A build that reshapes either literal costs the
   * ceiling fix and nothing else: the expression falls back to the game's own
   * number, which is what an unpatched game uses, so the map is still
   * playable - just with vanilla's ceiling over it.
   */
  {
    id: 'smln:top-bound-soft',
    owner: 'smln',
    description: "Scale the hover ceiling to a custom map's height instead of the vanilla 600px",
    anchorLiteral: 'topBounds.soft',
    // const a=null!==(r=null===(n=e.store.world.externalMap)||void 0===n?void 0:n.topBounds.soft)&&void 0!==r?r:600
    find: /(null===\(([\w$]+)=([\w$.]+?)\.store\.world\.externalMap\)\|\|void 0===\2\?void 0:\2\.topBounds\.soft\)&&void 0!==([\w$]+)\?\4):600/g,
    replace: (...args) => {
      const [, head, , state] = args
      return `${head}:${topBoundCall(state, 'soft', 600)}`
    },
    expect: 1,
    required: false,
    variants: [
      {
        // The game retuned its own default. Whatever it now is, that number
        // stays the vanilla answer and the ceiling scales from it.
        label: 'a different vanilla fallback',
        find: /(null===\(([\w$]+)=([\w$.]+?)\.store\.world\.externalMap\)\|\|void 0===\2\?void 0:\2\.topBounds\.soft\)&&void 0!==([\w$]+)\?\4):(\d+)/g,
        replace: (...args) => {
          const [, head, , state, , n] = args
          return `${head}:${topBoundCall(state, 'soft', n)}`
        },
        expect: 1,
      },
      {
        // The build stopped downlevelling and emits `?.` and `??` natively.
        label: 'native optional chaining',
        find: /([\w$.]+?)\.store\.world\.externalMap\?\.topBounds\.soft\s*\?\?\s*(\d+)/g,
        replace: (...args) => {
          const [, state, n] = args
          return `${state}.store.world.externalMap?.topBounds.soft??${topBoundCall(state, 'soft', n)}`
        },
        expect: 1,
      },
    ],
  },
  {
    id: 'smln:top-bound-hard',
    owner: 'smln',
    description: "Scale the collision ceiling to a custom map's height instead of the vanilla 550px",
    anchorLiteral: 'topBounds.hard',
    // m=null!==(o=null===(n=e.store.world.externalMap)||void 0===n?void 0:n.topBounds.hard)&&void 0!==o?o:550
    find: /(null===\(([\w$]+)=([\w$.]+?)\.store\.world\.externalMap\)\|\|void 0===\2\?void 0:\2\.topBounds\.hard\)&&void 0!==([\w$]+)\?\4):550/g,
    replace: (...args) => {
      const [, head, , state] = args
      return `${head}:${topBoundCall(state, 'hard', 550)}`
    },
    expect: 1,
    required: false,
    variants: [
      {
        label: 'a different vanilla fallback',
        find: /(null===\(([\w$]+)=([\w$.]+?)\.store\.world\.externalMap\)\|\|void 0===\2\?void 0:\2\.topBounds\.hard\)&&void 0!==([\w$]+)\?\4):(\d+)/g,
        replace: (...args) => {
          const [, head, , state, , n] = args
          return `${head}:${topBoundCall(state, 'hard', n)}`
        },
        expect: 1,
      },
      {
        label: 'native optional chaining',
        find: /([\w$.]+?)\.store\.world\.externalMap\?\.topBounds\.hard\s*\?\?\s*(\d+)/g,
        replace: (...args) => {
          const [, state, n] = args
          return `${state}.store.world.externalMap?.topBounds.hard??${topBoundCall(state, 'hard', n)}`
        },
        expect: 1,
      },
    ],
  },
]

/**
 * Patches for the simulation worker.
 *
 * Kept separate from corePatches because those are all routed to the renderer
 * bundle by src/main/entry.js; these go to js/simulation-worker.js.
 */
const workerPatches = [
  {
    id: 'smln:capture-worker-state',
    owner: 'smln',
    description: "Publish the simulation worker's state so worker mods can reach its Sandkit",
    anchorLiteral: 'workerEventTriggerCounts:{}',
    /*
     * The worker builds a complete Sandkit of its own - getApi, the event and
     * interceptor tables, workerLocal - but the state holding it is
     * module-local, so an injected script cannot see it. That is the whole of
     * `ReferenceError: sandkit is not defined`: the API was always there, the
     * handle was not.
     *
     * Anchored on the tail of the Sandkit literal plus the statement that
     * follows it, because that statement names the state. In the shipped build
     * it is `ue`; the name is read out of the match, since minified names are
     * regenerated every release and shapes are not.
     */
    find: /(sandkit:\{getApi:\(\)=>[\w$.]+,[^]{0,400}?workerEventTriggerCounts:\{\}\}\}),(\w+)\.session\.mainSensorCache/g,
    replace: (...args) => {
      const [, literal, state] = args
      return `${literal},(globalThis.__SMLN_WORKER__=globalThis.__SMLN_WORKER__||{}).state=${state},` +
        `${state}.session.mainSensorCache`
    },
    expect: 1,
    // Worker mods losing their API is a bad day; a worker that will not parse
    // is a game that will not run. This one always yields.
    required: false,
  },
]

module.exports = { corePatches, workerPatches, GLOBAL, captureCall }
