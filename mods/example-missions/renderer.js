/* eslint-env browser */
'use strict'
/**
 * A worked example of SandLoader's mission and story SDK: `SMLN.story`.
 *
 * Read it top to bottom and you have the whole surface: a face, a mission the
 * player can genuinely finish, a beat that uses both, and the three ways this
 * content reaches across to other mods. Field-by-field reference is in
 * README.md under "Missions and story".
 *
 * Everything registers under `example-missions:`. That prefix is not
 * decoration - both tables this writes into are the game's own, and the game
 * assumes it is the only writer, so a bare `briefing` from two mission mods
 * would be one mod silently overwriting the other.
 *
 * Honest about what has been seen: every registration below is covered by
 * `tools/selftest.js` against fakes of both game tables, and the SDK's mission
 * half has been watched registering and completing in the running game with a
 * throwaway probe. This mod has not itself been run in the game, and a
 * data-URL portrait has not been seen drawn - both said again where they
 * matter.
 */
;(function registerExampleMissions(story) {
  // The SDK is a prelude part, so it is normally there before any mod runs.
  // Saying so by name beats a TypeError from `undefined.speaker` on a build
  // where it is not - which is the same rule the SDK itself follows.
  if (!story) {
    SMLN.log('warn', 'this build has no story SDK, so the missions example registered nothing')
    return
  }

  /** Gold the player must hold at once. Small enough to reach by playing. */
  var QUOTA = 250

  /**
   * How much of a resource the player has.
   *
   * Two shapes, because the game keeps two: most counters on
   * `store.resources` are plain numbers (the game's own `find_fluxite` reads
   * `store.resources.fluxite > 0` and nothing else), while a few - artifacts
   * among them - are objects carrying `available` or `found`. A predicate that
   * assumed one shape would be quietly false forever on the other, and a
   * mission that can never complete is exactly the failure this SDK exists to
   * prevent.
   */
  function count(state, name) {
    var r = state && state.store && state.store.resources
    var v = r ? r[name] : null
    if (typeof v === 'number') return v
    if (v && typeof v.available === 'number') return v.available
    if (v && typeof v.found === 'number') return v.found
    return 0
  }

  /**
   * The portrait, inline, so the whole character fits in the file you are
   * reading. A portrait is a plain `<img src>` and never reaches the renderer's
   * texture pipeline, which is why a `data:` URL is a legal value at all.
   *
   * NOT YET SEEN IN THE RUNNING GAME. The table write and the colour are
   * tested; a `data:` URL being drawn as a face is not. If the dialogue box
   * shows a broken image, this line is the only suspect - swap it for a PNG in
   * this folder, which `SMLN.assets` resolves the same way.
   */
  var PORTRAIT = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
    '<rect width="96" height="96" fill="rgb(16,20,28)"/>' +
    '<circle cx="48" cy="38" r="19" fill="rgb(142,197,255)"/>' +
    '<rect x="19" y="64" width="58" height="32" rx="14" fill="rgb(142,197,255)"/>' +
    '</svg>'
  )

  // ------------------------------------------------------------- the speaker
  /*
   * Registering the face is not optional politeness. The game picks a portrait
   * with `speaker in table ? speaker : "zoe"`, so an unregistered speaker is
   * drawn as ZOE with no error in any log - MARA would wear someone else's
   * face and nothing would say so. That silence is the whole reason
   * `speaker()` exists rather than a documented table write.
   */
  story.speaker('surveyor', {
    name: 'MARA',
    portrait: PORTRAIT,
    color: '#8ec5ff',
  })

  // ------------------------------------------------------------ the mission
  /*
   * Hold 250 gold at once.
   *
   * A player finishes this by mining and hauling, which is what the first hour
   * of the game already is. To watch it complete in ten seconds instead, open
   * the console and type `give gold 250` - that marks the save, see
   * "Achievements" in the README.
   *
   * The predicate is a cheap read on purpose. The SDK runs it about once a
   * second for as long as the objective is open, because the game's own
   * evaluator fires at three event sites and would never reach a mod's `check`
   * at all. Anything expensive here is a cost the simulation pays every second.
   *
   * `title` and `description` are literals; a string containing `|` is treated
   * as an i18n key instead, so a translated mod passes keys here and nothing
   * else changes.
   */
  story.objective({
    id: 'first-quota',
    title: 'Fill the survey quota',
    description: 'Hold ' + QUOTA + ' gold at one time.',
    check: function (state) { return count(state, 'gold') >= QUOTA },
  })

  // --------------------------------------------------------------- the beat
  /*
   * Two dialogue boxes, finished by the mission above.
   *
   * `after` names the game's own first story step by its bare id. Bare ids the
   * game already owns stay the game's, which is what stops a mod's step called
   * `establish_wet_sand_processing` from shadowing it. On 0.5.6 that step is
   * index 0, so this beat lands at index 1 and the chain runs
   * `establish_wet_sand_processing -> example-missions:briefing ->
   * establish_burnt_residue_processing`.
   *
   * KNOWN LIMIT: in a save where the player is already past
   * `establish_wet_sand_processing`, this beat never plays. Chaining is array
   * order and the chain has already run past that index. A new world shows it;
   * an old one does not, and nothing in the SDK can change that.
   *
   * `speaker: 'surveyor'` is this mod's, because a bare id that the game does
   * not own resolves into the calling mod's namespace. `speaker: 'zoe'` is
   * still the game's ZOE, by the same rule that keeps `after` honest.
   *
   * REACHING ACROSS, 1 of 3: REFERENCE BY ID.
   * `completeWhen: {objective: 'first-quota'}` names another registration by
   * id, and bare means this mod's own. Written with a colon -
   * `other.mod:their-goal` - it names another mod's, and a reference nothing
   * ever registers is reported by name instead of waited on forever. Use it
   * when the two pieces of content genuinely belong to one chain.
   */
  story.step({
    id: 'briefing',
    after: 'establish_wet_sand_processing',
    messages: [
      {
        speaker: 'surveyor',
        text: 'Core sample says this seam runs deep. Two hundred and fifty grams in hand and I can file the claim.',
      },
      {
        speaker: 'zoe',
        // `characterSwitch` is the game's own field for "the face changed", and
        // `style` its own shape for colour and italics - the message vocabulary
        // is the game's throughout, so a beat reads like the ones beside it.
        characterSwitch: true,
        style: { color: '#88aaff', italic: true },
        text: 'File it once the sand is moving, surveyor.',
        showObjective: true,
      },
    ],
    objectiveDescription: 'Hold ' + QUOTA + ' gold at one time.',
    completeWhen: { objective: 'first-quota' },
  })

  // ------------------------------------------------- reaching across, 2 of 3
  /*
   * DECLARED DEPENDENCY. This beat is registered only when `gas-pipes` is
   * installed and enabled; otherwise it is refused, and the log names both
   * mods and which of the two failures it was.
   *
   * That refusal is the point, not a fault. The alternative - registering a
   * beat about pipes on a machine with no pipes - is a story step the player
   * reaches and cannot make sense of, and there is no way for them to find out
   * why. Content that depends on another mod says so here; the mod itself
   * still loads either way, which is what makes this different from the
   * manifest's `dependencies`.
   *
   * The `after` is written in its full `mod:id` form. Here it happens to name
   * this mod's own step, where a bare `briefing` would mean the same - but the
   * long form is exactly what you write for someone else's step, so it is
   * worth seeing once.
   *
   * No `completeWhen`: a beat with no completion condition is finished the
   * moment the player has read it. That is deliberate in the SDK, because a
   * step nothing can finish stops the whole story dead behind it.
   */
  story.step({
    id: 'pipe-talk',
    requires: ['gas-pipes'],
    after: 'example-missions:briefing',
    messages: [
      {
        speaker: 'surveyor',
        text: 'Somebody ran gas lines down here before us. Whoever they were, they left the pumps running.',
      },
    ],
  })

  // ------------------------------------------------- reaching across, 3 of 3
  /*
   * EVENTS, the loose end of the three.
   *
   * The SDK publishes `story:complete` for every objective it finishes. This
   * mod listens for its own and republishes it under its own namespace, so
   * another mod can write
   *
   *   completeWhen: { event: 'example-missions:quota-met' }
   *
   * and needs to know nothing about this file beyond that one string - not
   * when it loads, not whether it is installed, not what a quota is. That is
   * the difference from `requires`: a dependency refuses to exist without the
   * other mod, an event does not care whether anyone is listening.
   *
   * `story.emit('quota-met')` publishes `example-missions:quota-met`; the
   * namespace is added for the same reason ids get one. The subscription goes
   * through the mod's own facade, so unloading this mod takes it with it.
   */
  story.on('story:complete', function (e) {
    if (!e || e.id !== story.modId + ':first-quota') return
    story.emit('quota-met', { resource: 'gold', threshold: QUOTA })
  })

  // ---------------------------------------------------------------- console
  /*
   * A way to see the state of all this without reading a log file. Completion
   * is asked of the SDK rather than of the game: the game deletes a completed
   * objective from its active list a few seconds later and keeps no record
   * that it ever happened, so `store.objectives.active` is the wrong place to
   * look for an answer and `isComplete` is the right one.
   */
  SMLN.registerCommand({
    name: 'missions',
    summary: 'Show what the missions example has finished',
    usage: 'missions',
    args: [],
    run: function () {
      var state = SMLN.getState()
      return [
        'quota (' + QUOTA + ' gold): ' + (story.isComplete('first-quota') ? 'complete' : 'open'),
        'briefing beat:      ' + (story.isStepComplete('briefing') ? 'played' : 'not played'),
        'gold now:           ' + (state ? count(state, 'gold') : 'no game loaded'),
      ]
    },
  })
})(SMLN.story)
