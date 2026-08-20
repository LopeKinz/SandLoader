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
    find: /sandkit=\{(mods:\{[^]{0,400}?keyBindings:\{\})\}/g,
    replace: (...args) => {
      const [, body] = args
      return `sandkit={${body},getApi:function(){` +
        `var g=globalThis.${GLOBAL};` +
        `return (g&&g.game)||(g&&g.state&&g.state.FH)||null}}`
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
]

module.exports = { corePatches, GLOBAL, captureCall }
