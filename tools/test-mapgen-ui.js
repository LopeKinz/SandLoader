#!/usr/bin/env node
'use strict'
/**
 * Regression tests for the way into the map generator.
 *
 * The four generator modules have had their own tests since the day they were
 * written, and every one of them passed while nothing in the game could reach
 * the generator at all. These are the tests for the other half: the dialog, the
 * button that runs it, and the document the result lands in.
 *
 * Everything here drives the real overlay through tools/dom-harness.js - real
 * elements, real click events, real canvas pixels - against the real prelude,
 * because "the generator works" and "a person can get to the generator" are
 * separate claims and only the second one is new.
 *
 * What is deliberately NOT asserted: that anything looks right. There is no
 * layout engine here and no screen. These tests can say that the four presets
 * are offered by name, that a seed reproduces its map, that the busy overlay
 * comes back down and that a refusal reaches the player with its own words.
 * They cannot say the dialog is legible or the wait feels short.
 */

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const prelude = require('../src/renderer/prelude')
const mapgenParams = require('../src/game/mapgen-params')
const mapgen = require('../src/game/mapgen')

function assert(value, message) {
  if (!value) throw new Error(message)
}

/* ------------------------------------------------------------------ *
 * The renderer, in a VM, with a canvas
 * ------------------------------------------------------------------ */

/**
 * The whole injected prelude in a sandbox, exactly as the game receives it.
 *
 * Shaped after tools/selftest.js's bootEditor(), and for the same reason: the
 * editor is the one part that needs real pixels, and the generator writes
 * 40,000 of them per test.
 */
function bootEditor() {
  const { createDom } = require('./dom-harness')
  const dom = createDom()
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: dom.document,
    window: dom.window,
    navigator: { language: 'en-US' },
    location: { search: '' },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    WeakSet,
    Promise,
    Image: dom.Image,
    electron: { log() {}, customMaps: null },
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  sandbox.window.document = dom.document
  vm.createContext(sandbox)
  new vm.Script(prelude.build({ reload: true, mods: [], locale: 'en' }),
    { filename: 'prelude.js' }).runInContext(sandbox)
  return { sandbox, dom, S: sandbox.__SMLN__ }
}

/** Every descendant of a node, in document order. */
function nodes(root) {
  const out = []
  ;(function walk(node) {
    for (const child of node.childNodes || []) { out.push(child); walk(child) }
  })(root)
  return out
}

/**
 * Read the class off the attribute rather than off classList.
 *
 * The harness's classList only knows what add/toggle put in it, and the editor
 * sets most of these by assigning className - so asking classList would answer
 * "no" to every one and quietly pass every assertion.
 */
function hasClass(el, cls) {
  return (el.className || '').split(/\s+/).indexOf(cls) >= 0
}

function byClass(root, cls) {
  return nodes(root).filter((e) => hasClass(e, cls))
}

/** A map size just above the editor's own floor, so the runs stay short. */
const W = 160
const H = 204

/* ------------------------------------------------------------------ *
 * The dialog, as a handle
 * ------------------------------------------------------------------ */

/**
 * Open the generator and hand back the controls a person would touch.
 *
 * Everything is found the way it is on screen - by class, by attribute, by the
 * text on the button - rather than through a property the editor happens to
 * keep, so a control that stops being reachable fails a test here.
 */
function openDialog(S, dom) {
  S.mapEditor.openGenerate({})
  return handle(dom)
}

function handle(dom) {
  const overlay = dom.document.getElementById('smln-mapedit')
  assert(overlay, 'the editor overlay was never built')
  const dialog = byClass(overlay, 'dialog')[0] || null
  const busy = byClass(overlay, 'busy')[0]
  const note = byClass(overlay, 'note')[0]
  if (!dialog) return { overlay, dialog: null, busy, note }

  const inputs = nodes(dialog).filter((e) => e.tagName === 'INPUT')
  const buttons = nodes(dialog).filter((e) => e.tagName === 'BUTTON')
  const knobs = Object.create(null)
  for (const input of inputs) {
    const name = input.getAttribute('data-knob')
    if (name) knobs[name] = input
  }
  const plain = inputs.filter((e) => !e.getAttribute('data-knob'))
  const pair = byClass(dialog, 'pair')[0] || null
  const sized = pair ? nodes(pair).filter((e) => e.tagName === 'INPUT') : []

  return {
    overlay,
    dialog,
    busy,
    note,
    card: byClass(dialog, 'card')[0],
    presets: byClass(dialog, 'presets')[0]
      ? (byClass(dialog, 'presets')[0].childNodes || []) : [],
    seed: plain[0] || null,
    width: sized[0] || null,
    height: sized[1] || null,
    knobs,
    hints: byClass(dialog, 'hint'),
    costs: byClass(dialog, 'cost'),
    more: byClass(dialog, 'more')[0] || null,
    moreBtn: byClass(dialog, 'moreBtn')[0] || null,
    button: (text) => buttons.filter((b) => b.textContent === text)[0] || null,
  }
}

/** The generator's own refusal or success sentence, as the footer shows it. */
function noteText(dom) {
  const overlay = dom.document.getElementById('smln-mapedit')
  return byClass(overlay, 'note')[0].textContent || ''
}

/** The refused hint inside the dialog, if there is one. */
function refusal(ui) {
  const hit = ui.hints.filter((h) => hasClass(h, 'refused'))[0]
  return hit ? hit.textContent : ''
}

/** Fill in the dialog and press Generate; resolves when the run is done. */
function generateThrough(ui, opts) {
  const o = opts || {}
  if (o.preset != null) ui.presets[o.preset].dispatch('click', {})
  if (o.seed !== undefined) ui.seed.value = o.seed
  if (o.width !== undefined) ui.width.value = String(o.width)
  if (o.height !== undefined) ui.height.value = String(o.height)
  if (o.knobs) {
    for (const key of Object.keys(o.knobs)) {
      assert(ui.knobs[key], key + ' is not a knob this dialog offers')
      ui.knobs[key].value = String(o.knobs[key])
    }
  }
  ui.button('Generate').dispatch('click', {})
  return ui.overlay._generating || null
}

/** The six layer canvases at this size, in the order the editor made them. */
function layersOf(dom, width, height) {
  return dom.document._all.filter((e) => e.tagName === 'CANVAS' &&
    !e.className && e.width === width && e.height === height)
}

function pixelsOf(canvas) {
  return canvas._data().pixels
}

/* ------------------------------------------------------------------ *
 * The tests
 * ------------------------------------------------------------------ */

function testPreludeCarriesTheGenerator() {
  // The generator modules are plain CommonJS in src/game/, required by the
  // tests beside this one. The renderer reaches them through prelude.js's
  // module shim, and two of them - caves and ore - require the validator at
  // top level with no guard, so an entry listed above them in MODULES is the
  // whole difference between a working dialog and a dead menu item.
  const wanted = [
    '__SMLN_MAPGEN_PARAMS__', '__SMLN_MAPGEN_SHAPE__', '__SMLN_MAPGEN_CAVES__',
    '__SMLN_MAPGEN_ORE__', '__SMLN_MAPGEN__',
  ]
  for (const name of wanted) {
    assert(prelude.MODULES.some((m) => m.global === name), name + ' is not in prelude.MODULES')
  }
  const at = (name) => prelude.MODULES.findIndex((m) => m.global === name)
  assert(at('__SMLN_MAPEDITOR_VALIDATE__') < at('__SMLN_MAPGEN_CAVES__') &&
    at('__SMLN_MAPEDITOR_VALIDATE__') < at('__SMLN_MAPGEN_ORE__'),
  'the validator is installed after the two modules whose unguarded require needs it')
  assert(at('__SMLN_TERRAIN_PALETTE__') < at('__SMLN_MAPGEN_SHAPE__'),
    'the palette is installed after a stage that requires it')
  assert(at('__SMLN_MAPGEN__') > at('__SMLN_MAPGEN_ORE__'),
    'mapgen.js is installed before the stages it composes')

  const { sandbox, S } = bootEditor()
  assert(sandbox.__SMLN_MAPGEN__ && typeof sandbox.__SMLN_MAPGEN__.generate === 'function',
    'the generator did not reach the renderer')
  assert(sandbox.__SMLN_MAPGEN_PARAMS__ && sandbox.__SMLN_MAPGEN_PARAMS__.PRESETS,
    'the generator parameters did not reach the renderer')
  assert(S.mapEditor.canGenerate(), 'the editor says it cannot generate')

  // The renderer's copy is the same source, so it agrees with this process's.
  const here = mapgen.generate(W, H, { seed: 'shim-agreement' })
  const there = sandbox.__SMLN_MAPGEN__.generate(W, H, { seed: 'shim-agreement' })
  assert(here.ok && there.ok, 'the agreement run was refused')
  assert(Buffer.compare(Buffer.from(here.buf.data.buffer, here.buf.data.byteOffset, here.buf.data.length),
    Buffer.from(there.buf.data.buffer, there.buf.data.byteOffset, there.buf.data.length)) === 0,
  'the renderer generator and the Node one produced different maps from one seed')
}

function testEveryPresetIsOffered() {
  const { S, dom } = bootEditor()
  const ui = openDialog(S, dom)
  assert(ui.dialog, 'Generate map... opened no dialog')

  const ids = Object.keys(mapgenParams.PRESETS)
  assert(ids.length === 4, 'there are ' + ids.length + ' presets, not the four this checks')
  assert(ui.presets.length === ids.length,
    'the dialog offers ' + ui.presets.length + ' presets for ' + ids.length)

  for (const id of ids) {
    const spec = mapgenParams.PRESETS[id]
    const found = ui.presets.filter((b) => (b.childNodes[0] || {}).textContent === spec.name)[0]
    assert(found, 'the preset "' + spec.name + '" is not offered by name')
    // A name alone is four buttons that only mean something to whoever wrote
    // them, so the one-line description has to be on the button too.
    assert((found.childNodes[1] || {}).textContent === spec.description,
      '"' + spec.name + '" is offered without its description')
  }

  // Choosing one moves the size to the size that preset suggests.
  const second = mapgenParams.PRESETS[ids[1]]
  ui.presets[1].dispatch('click', {})
  assert(Number(ui.width.value) === second.suggestedSize.width &&
    Number(ui.height.value) === second.suggestedSize.height,
  'choosing a preset did not take its suggested size: ' + ui.width.value + ' x ' + ui.height.value)
}

function testFirstScreenIsShort() {
  // Someone who wants a world types nothing and presses the button. That is
  // only true if the first screen is the preset, the seed and the size - the
  // sixteen stage parameters have to start behind the disclosure.
  const { S, dom } = bootEditor()
  const ui = openDialog(S, dom)
  assert(ui.more && ui.more.hidden === true, 'the extra parameters are open before anyone asked')
  assert(ui.moreBtn, 'there is no way to open them')
  assert(ui.moreBtn.getAttribute('aria-expanded') === 'false', 'the disclosure lies about its state')
  ui.moreBtn.dispatch('click', {})
  assert(ui.more.hidden === false, 'the disclosure did not open')
  assert(ui.moreBtn.getAttribute('aria-expanded') === 'true', 'the disclosure did not say it opened')

  // Nothing typed, nothing chosen: pressing Generate has to produce a map.
  return generateThrough(ui, {}).then((ok) => {
    assert(ok === true, 'a world could not be had without typing anything')
  })
}

function testOnlyKnobsThatDoSomethingAreOffered() {
  // mapgen.js's MAPPING is the one record of whether a user-facing name reaches
  // a stage at all, and eight of them reach nothing today. A control that
  // quietly does nothing is worse than a missing one.
  const { S, dom } = bootEditor()
  const ui = openDialog(S, dom)
  ui.moreBtn.dispatch('click', {})

  let dead = 0
  let live = 0
  for (const group of ['shape', 'caves', 'ore']) {
    for (const key of Object.keys(mapgen.MAPPING[group])) {
      const name = group + '.' + key
      if (mapgen.MAPPING[group][key] == null) {
        dead++
        assert(!ui.knobs[name], name + ' reaches no stage but the dialog offers it')
        continue
      }
      // The ore table is rows of colours and depth bands, not a knob; it is
      // the one live mapping this dialog leaves to the preset.
      if (typeof mapgenParams.DEFAULTS[group][key] === 'object') continue
      live++
      assert(ui.knobs[name], name + ' reaches a stage but the dialog does not offer it')
      // A label saying what it does, not what it is called.
      const label = ui.knobs[name].getAttribute('aria-label') || ''
      assert(label && label !== key, name + ' is labelled with its own name: "' + label + '"')
    }
  }
  assert(dead >= 8, 'only ' + dead + ' names map to nothing; this check has stopped proving anything')
  assert(live >= 15, 'only ' + live + ' knobs are offered, which is fewer than the stages read')
}

function testTerrainOnlyAndUnsaved() {
  const { S, dom } = bootEditor()
  const ui = openDialog(S, dom)
  return generateThrough(ui, { seed: 'granite-shelf-12', width: W, height: H }).then((ok) => {
    assert(ok === true, 'the run failed: ' + noteText(dom))
    const layers = layersOf(dom, W, H)
    assert(layers.length === 6, 'the document has ' + layers.length + ' layers, not six')

    // Terrain: every pixel written, every one opaque. A transparent terrain
    // pixel is Fog, which is the worst material in the game.
    const terrain = pixelsOf(layers[0])
    let clear = 0
    for (let i = 3; i < terrain.length; i += 4) if (terrain[i] !== 255) clear++
    assert(clear === 0, clear + ' terrain pixels came back not fully opaque')

    // And the other five stay empty, which is a valid world - the generator
    // writes one layer, and inventing lights or zones here would be inventing
    // content nobody asked for.
    for (let n = 1; n < 6; n++) {
      const px = pixelsOf(layers[n])
      let painted = 0
      for (let i = 3; i < px.length; i += 4) if (px[i] !== 0) painted++
      assert(painted === 0, 'layer ' + n + ' came back with ' + painted + ' painted pixels')
    }

    // Unsaved on purpose: a generated map is a starting point, and nothing
    // goes to disk behind the author's back. The unsaved-changes guard is what
    // proves it - Escape once refuses to close and says why.
    dom.window.key({ key: 'Escape' })
    assert(S.mapEditor.isOpen(), 'a generated map closed without asking, so it was not unsaved work')
    assert(/nsaved/.test(noteText(dom)),
      'closing a generated map said nothing about unsaved changes: "' + noteText(dom) + '"')
    dom.window.key({ key: 'Escape' })
    assert(!S.mapEditor.isOpen(), 'the second Escape did not discard it')
    return null
  })
}

function testSeedReproducesThroughTheUi() {
  // The whole point of a seed. Two separate boots of the whole renderer, the
  // same seed typed into the same dialog, and the pixels have to match.
  const seed = 'cobalt-gulch-41'
  const run = (which) => {
    const { S, dom } = bootEditor()
    const ui = openDialog(S, dom)
    return generateThrough(ui, { preset: which, seed, width: W, height: H }).then((ok) => {
      assert(ok === true, 'the run failed: ' + noteText(dom))
      return Buffer.from(pixelsOf(layersOf(dom, W, H)[0]))
    })
  }
  return run(0).then((first) => run(0).then((second) => {
    assert(Buffer.compare(first, second) === 0,
      'the same seed produced two different maps through the dialog')
    // And it is the seed doing the work, not the size: a different one differs.
    const { S, dom } = bootEditor()
    const ui = openDialog(S, dom)
    return generateThrough(ui, { preset: 0, seed: 'quartz-mesa-77', width: W, height: H })
      .then(() => {
        const other = Buffer.from(pixelsOf(layersOf(dom, W, H)[0]))
        assert(Buffer.compare(first, other) !== 0, 'two different seeds produced the same map')
      })
  }))
}

function testTheSeedIsShownAndCanBeTypedBack() {
  // A generator whose result cannot be got back is a toy. An empty seed field
  // means "pick one for me", and the one that was picked has to end up where
  // the author can read it and type it in again.
  const { S, dom } = bootEditor()
  const ui = openDialog(S, dom)
  return generateThrough(ui, { preset: 2, seed: '', width: W, height: H }).then((ok) => {
    assert(ok === true, 'the run failed: ' + noteText(dom))
    const box = byClass(ui.overlay, 'seedbox')[0]
    assert(box && box.hidden === false, 'the seed the map came from is nowhere on screen')
    const field = nodes(box).filter((e) => e.tagName === 'INPUT')[0]
    const shown = field.value
    assert(shown, 'the seed readout is empty after a generated map')
    assert(field.getAttribute('readonly') === 'readonly',
      'the seed readout is editable, which would claim to change a map already made')

    const first = Buffer.from(pixelsOf(layersOf(dom, W, H)[0]))

    // Type it back into a fresh renderer and get the same world.
    const second = bootEditor()
    const again = openDialog(second.S, second.dom)
    return generateThrough(again, { preset: 2, seed: shown, width: W, height: H }).then(() => {
      const back = Buffer.from(pixelsOf(layersOf(second.dom, W, H)[0]))
      assert(Buffer.compare(first, back) === 0,
        'the seed the editor showed did not reproduce the map it came from')
    })
  })
}

function testRefusalReachesThePlayer() {
  // normalise() refuses with a sentence that names the parameter and the bound
  // it missed. Nothing in the dialog knows better than that sentence, so it has
  // to arrive whole rather than as "generation failed".
  const { S, dom } = bootEditor()
  const ui = openDialog(S, dom)
  ui.moreBtn.dispatch('click', {})

  // Two refusals with different shapes: one parameter out of its own bounds,
  // and one pair that is legal apart and impossible together.
  ui.knobs['shape.surfaceAmplitude'].value = ''
  return generateThrough(ui, { seed: 'refused-1', width: W, height: H }).then((ok) => {
    assert(ok === false, 'a blank parameter still generated a map')
    const said = noteText(dom)
    assert(/surfaceAmplitude/.test(said),
      'the refusal did not name the parameter: "' + said + '"')
    // The same words the module chose, not a paraphrase of them.
    const direct = mapgenParams.normalise({ shape: { surfaceAmplitude: '' } })
    assert(!direct.ok && said.indexOf(direct.reason) >= 0,
      'the refusal was reworded on the way out: "' + said + '" does not carry "' + direct.reason + '"')
    assert(ui.busy.hidden === true, 'the busy overlay was left over the stage after a refusal')

    // The cross-parameter one: topsoil below the hard layer is impossible, and
    // hardLayerDepth is not even a knob this dialog offers.
    const two = bootEditor()
    const ui2 = openDialog(two.S, two.dom)
    ui2.moreBtn.dispatch('click', {})
    return generateThrough(ui2, {
      seed: 'refused-2', width: W, height: H, knobs: { 'shape.topsoilDepth': 4000 },
    }).then((ok2) => {
      assert(ok2 === false, 'topsoil below the hard layer still generated a map')
      const said2 = noteText(two.dom)
      assert(/topsoilDepth/.test(said2) && /hardLayerDepth/.test(said2),
        'the refusal did not say which two parameters disagree: "' + said2 + '"')
      assert(ui2.busy.hidden === true, 'the busy overlay was left up after the second refusal')
      // And nothing was replaced. The refusal happens before the document
      // does, so the blank map the dialog opened over is still the one on
      // screen - and a blank map has no seed.
      const box = byClass(ui2.overlay, 'seedbox')[0]
      assert(box && box.hidden === true, 'a refused run still replaced the document')
    })
  })
}

function testBusyOverlayComesBackDown() {
  // It covers the whole stage and takes pointer events. Left up with no text it
  // is an invisible sheet over the canvas that eats every click - that has
  // shipped once - so every way out has to put it back.
  const success = () => {
    const { S, dom } = bootEditor()
    const ui = openDialog(S, dom)
    assert(ui.busy.hidden === true, 'the busy overlay was up before anything ran')
    const running = generateThrough(ui, { seed: 'busy-ok', width: W, height: H })
    // It is up while the run is queued, which is the whole reason the run waits
    // two frames before it starts.
    assert(ui.busy.hidden === false, 'the busy overlay never went up at all')
    assert(ui.busy.textContent, 'the busy overlay went up with nothing to say')
    return running.then((ok) => {
      assert(ok === true, 'the run failed: ' + noteText(dom))
      assert(ui.busy.hidden === true, 'the busy overlay was left up after a successful run')
      assert(!ui.busy.textContent, 'the busy overlay kept its text after it was hidden')
    })
  }

  const thrown = () => {
    const { S, dom, sandbox } = bootEditor()
    const ui = openDialog(S, dom)
    // The generator promises never to throw, so the only way to exercise the
    // path is to make it break that promise. The module object the editor read
    // at install is the one in the sandbox, so replacing the function on it is
    // what the editor will call.
    sandbox.__SMLN_MAPGEN__.generate = function () { throw new Error('the cave solver gave up') }
    return generateThrough(ui, { seed: 'busy-throw', width: W, height: H }).then((ok) => {
      assert(ok === false, 'a throwing generator reported success')
      assert(ui.busy.hidden === true, 'the busy overlay was left up after a failure')
      assert(/gave up/.test(noteText(dom)), 'the failure was not reported: "' + noteText(dom) + '"')
    })
  }

  const refused = () => {
    const { S, dom, sandbox } = bootEditor()
    const ui = openDialog(S, dom)
    sandbox.__SMLN_MAPGEN__.generate = function () {
      return { ok: false, reason: 'a map needs a width and a height in cells' }
    }
    return generateThrough(ui, { seed: 'busy-refuse', width: W, height: H }).then((ok) => {
      assert(ok === false, 'a refused run reported success')
      assert(ui.busy.hidden === true, 'the busy overlay was left up after a refusal')
    })
  }

  // A size the editor will not hold never reaches the generator at all, so the
  // overlay must never go up in the first place.
  const neverStarted = () => {
    const { S, dom } = bootEditor()
    const ui = openDialog(S, dom)
    const running = generateThrough(ui, { seed: 'busy-none', width: 4, height: 4 })
    assert(running === null, 'a refused size still started a run')
    assert(ui.busy.hidden === true, 'the busy overlay went up for a size that was refused')
    return Promise.resolve()
  }

  return success().then(thrown).then(refused).then(neverStarted)
}

function testSizeRespectsTheEditorsOwnLimits() {
  // The floor comes from the game's fixed spawn, the ceiling from what the
  // editor can hold, and both are the editor's numbers. A second copy in the
  // generator's dialog is how the two come to disagree, so this asks the editor
  // what they are and then holds the dialog to exactly them.
  const { S, dom } = bootEditor()
  const limits = S.mapEditor.limits()
  assert(limits.minWidth > 1 && limits.minHeight > 1 && limits.maxCells > 1e6,
    'the editor reported no usable limits')

  const ui = openDialog(S, dom)

  // One cell under the floor on either axis is refused, with the reason.
  const under = generateThrough(ui, {
    seed: 'floor', width: limits.minWidth - 1, height: limits.minHeight,
  })
  assert(under === null, 'a width below the floor was generated anyway')
  const said = refusal(ui)
  assert(said && said.indexOf(String(limits.minWidth)) >= 0 &&
    said.indexOf(String(limits.minHeight)) >= 0,
  'the refusal does not carry the editor floor: "' + said + '"')
  assert(ui.width.className === 'bad', 'the field that was wrong was not marked')

  const underHeight = generateThrough(ui, {
    seed: 'floor', width: limits.minWidth, height: limits.minHeight - 1,
  })
  assert(underHeight === null, 'a height below the floor was generated anyway')

  // Past the cell ceiling, on a shape both axes would allow on their own.
  const side = Math.ceil(Math.sqrt(limits.maxCells)) + 100
  const over = generateThrough(ui, { seed: 'ceiling', width: side, height: side })
  assert(over === null, 'a map past the cell ceiling was generated anyway')
  assert(refusal(ui).indexOf(String(Math.round(limits.maxCells / 1e6))) >= 0,
    'the ceiling refusal does not carry the editor cell limit: "' + refusal(ui) + '"')

  // And exactly the floor is accepted, which is what makes the two numbers the
  // same number rather than merely similar ones.
  return generateThrough(ui, {
    seed: 'floor-ok', width: limits.minWidth, height: limits.minHeight,
  }).then((ok) => {
    assert(ok === true, 'a map at exactly the editor floor was refused: ' + noteText(dom))
    assert(layersOf(dom, limits.minWidth, limits.minHeight).length === 6,
      'the map at the floor size was not the size that was asked for')
  })
}

function testUnsavedWorkIsAskedAboutFirst() {
  // Generating replaces all six layers and undo does not reach back across it,
  // so from inside the editor an author with unsaved pixels is asked first.
  const { S, dom } = bootEditor()
  return S.mapEditor.open(null, { width: W, height: H, name: 'Handmade' }).then(() => {
    const overlay = dom.document.getElementById('smln-mapedit')

    // A clean document has nothing to lose, so it goes straight through.
    S.mapEditor.openGenerate({})
    assert(handle(dom).button('Generate'), 'a clean map did not open the generator directly')
    handle(dom).button('Cancel').dispatch('click', {})

    // Now make it dirty the way typing in the name field does.
    const name = byClass(overlay, 'name')[0]
    name.value = 'Handmade, changed'
    name.dispatch('input', {})

    S.mapEditor.openGenerate({})
    const asked = handle(dom)
    assert(!asked.button('Generate'), 'unsaved work was about to be replaced with no warning')
    const confirm = asked.button('Discard and generate')
    assert(confirm, 'the confirmation offers no way forward')
    assert(asked.button('Cancel'), 'the confirmation offers no way out')
    assert(/not been saved/.test(refusal(asked)),
      'the confirmation does not say what is at stake: "' + refusal(asked) + '"')

    // Cancelling leaves the document exactly where it was.
    asked.button('Cancel').dispatch('click', {})
    assert(!handle(dom).dialog, 'cancelling left the confirmation on screen')
    assert(byClass(overlay, 'name')[0].value === 'Handmade, changed',
      'cancelling the confirmation still replaced the map')

    // Confirming opens the generator proper.
    S.mapEditor.openGenerate({})
    handle(dom).button('Discard and generate').dispatch('click', {})
    assert(handle(dom).button('Generate'), 'confirming did not reach the generator')
    return null
  })
}

function testTheMapsOverlayCanReachIt() {
  // The maps browser is where somebody who wants a world starts, so the way in
  // has to be there - and it has to be the same dialog, not a second copy that
  // can come to disagree about what a map may be.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'mapsui.js'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert(/openGenerate/.test(code), 'the maps overlay never calls into the generator')
  assert(!/mapgen/i.test(code), 'the maps overlay reaches the generator modules directly')

  const { S, dom } = bootEditor()
  S.mapsUI.toggle(true)
  const browser = dom.document.getElementById('smln-maps')
  assert(browser, 'the maps overlay was never built')
  const footer = nodes(browser).filter((e) => e.tagName === 'FOOTER')[0]
  const buttons = nodes(footer).filter((e) => e.tagName === 'BUTTON')
  const labels = buttons.map((b) => b.textContent)
  assert(labels.indexOf('New map...') >= 0, 'New map... is gone from the footer')
  const gen = buttons.filter((b) => b.textContent === 'Generate map...')[0]
  assert(gen, 'there is no way into the generator from the maps overlay: ' + labels.join(', '))
  assert(labels.indexOf('Generate map...') === labels.indexOf('New map...') + 1,
    'Generate map... does not sit beside New map...')

  gen.dispatch('click', {})
  assert(S.mapEditor.isOpen(), 'the footer button did not open the editor')
  const ui = handle(dom)
  assert(ui.dialog && ui.button('Generate'), 'the footer button did not open the generator')
  assert(ui.presets.length === Object.keys(mapgenParams.PRESETS).length,
    'the dialog reached from the maps overlay is not the same one')

  // And it produces a map, from an overlay that had no document at all.
  return generateThrough(ui, { seed: 'from-the-browser', width: W, height: H }).then((ok) => {
    assert(ok === true, 'the run from the maps overlay failed: ' + noteText(dom))
    assert(layersOf(dom, W, H).length === 6, 'no document came out of it')
  })
}

function testTheCostIsSaidBeforeTheClick() {
  // Both figures the author needs before they commit: what the size costs to
  // hold, from the editor's own measured figure, and roughly what it costs to
  // wait for. Neither is worth anything discovered after the click.
  const { S, dom } = bootEditor()
  const limits = S.mapEditor.limits()
  const ui = openDialog(S, dom)

  ui.width.value = String(W)
  ui.height.value = String(H)
  ui.width.dispatch('input', {})
  const small = ui.costs.map((c) => c.textContent).join(' ')
  assert(/memory while open/.test(small), 'the memory cost is not said: "' + small + '"')
  // 160 x 204 is 33,000 cells - about 35 ms. Nothing worth warning about.
  assert(!/Roughly/.test(small), 'a size that generates instantly warned about the wait')

  ui.width.value = '1200'
  ui.height.value = '900'
  ui.width.dispatch('input', {})
  const big = ui.costs.map((c) => c.textContent).join(' ')
  assert(/Roughly/.test(big) && /seconds/.test(big),
    'a size that takes over a second did not say so: "' + big + '"')
  assert(/floor rather than a promise/.test(big),
    'the estimate is presented as a measurement rather than an extrapolation')

  // The memory figure is the editor's, not a second one kept in the dialog.
  const bytes = 1200 * 900 * limits.bytesPerCell
  assert(big.indexOf(Math.round(bytes / (1024 * 1024)) + ' MB') >= 0,
    'the memory figure does not match the editor\'s own bytes-per-cell: "' + big + '"')

  // Over the ceiling the cost line says so in the way a refusal looks.
  const side = Math.ceil(Math.sqrt(limits.maxCells)) + 500
  ui.width.value = String(side)
  ui.height.value = String(side)
  ui.width.dispatch('input', {})
  assert(ui.costs.some((c) => hasClass(c, 'over')),
    'a size past the cell ceiling did not show as one')
}

/* ------------------------------------------------------------------ *
 * Run them
 * ------------------------------------------------------------------ */

const TESTS = [
  ['the prelude carries the generator into the renderer', testPreludeCarriesTheGenerator],
  ['every preset is offered by name and description', testEveryPresetIsOffered],
  ['the first screen is short, and a world needs no typing', testFirstScreenIsShort],
  ['only knobs that reach a stage are offered', testOnlyKnobsThatDoSomethingAreOffered],
  ['generating fills terrain and leaves the other five layers empty', testTerrainOnlyAndUnsaved],
  ['the same seed produces the same map twice through the dialog', testSeedReproducesThroughTheUi],
  ['the seed is shown, and typing it back reproduces the map', testTheSeedIsShownAndCanBeTypedBack],
  ['a refusal reaches the player with its own reason', testRefusalReachesThePlayer],
  ['the busy overlay comes back down on every path out', testBusyOverlayComesBackDown],
  ['the size respects the editor\'s own floor and ceiling', testSizeRespectsTheEditorsOwnLimits],
  ['unsaved work is asked about before it is replaced', testUnsavedWorkIsAskedAboutFirst],
  ['the maps overlay reaches the same dialog', testTheMapsOverlayCanReachIt],
  ['the size says what it costs before it runs', testTheCostIsSaidBeforeTheClick],
]

let failed = 0

;(async function main() {
  for (const [name, run] of TESTS) {
    try {
      await run()
      console.log('  ok   ' + name)
    } catch (e) {
      failed++
      console.error('  FAIL ' + name + ': ' + ((e && e.message) || e))
    }
  }
  if (failed > 0) {
    console.error('FAIL map generator interface tests: ' + failed + ' of ' + TESTS.length + ' failed')
    process.exit(1)
  }
  console.log('PASS map generator interface tests (' + TESTS.length + ' checks)')
})()
