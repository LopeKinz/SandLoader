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
 * Anchor choice: `FH.events.emit(state,"game:ready",{state:state})`. The
 * string literal "game:ready" is authored source, not minifier output, and the
 * surrounding shape is stable. Local variable names are captured as
 * backreferences so renaming them across builds changes nothing.
 */

/** Global the injected runtime installs itself on. Kept ugly on purpose. */
const GLOBAL = '__SMLN__'

/** @type {import('./engine').Patch[]} */
const corePatches = [
  {
    id: 'smln:capture-api',
    owner: 'smln',
    description: "Capture the game's internal FH modding API and live state at game:ready",
    // ie.FH.events.emit(p,"game:ready",{state:p})
    find: /(\w+)\.FH\.events\.emit\((\w+),"game:ready",\{state:\2\}\)/g,
    replace: (...args) => {
      const [full, ns, st] = args
      return `(globalThis.${GLOBAL}&&globalThis.${GLOBAL}.__capture(${ns}.FH,${st},"game:ready"),${full})`
    },
    expect: 1,
    required: true,
  },
  {
    id: 'smln:capture-started',
    owner: 'smln',
    description: 'Second capture point after the manager loop starts, for late boot paths',
    // ie.FH.events.emit(e,"game:started",{state:e})
    find: /(\w+)\.FH\.events\.emit\((\w+),"game:started",\{state:\2\}\)/g,
    replace: (...args) => {
      const [full, ns, st] = args
      return `(globalThis.${GLOBAL}&&globalThis.${GLOBAL}.__capture(${ns}.FH,${st},"game:started"),${full})`
    },
    expect: 1,
    required: false,
  },
  {
    id: 'smln:mods-menu-open',
    owner: 'smln',
    description: "Open SandLoader's mod manager instead of the game's Workshop screen",
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
  },
  {
    id: 'smln:mods-menu-label',
    owner: 'smln',
    description: 'Rename the main-menu entry to "SandLoader Mods"',
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
  },
]

module.exports = { corePatches, GLOBAL }
