/* eslint-env browser */
'use strict'
/**
 * One API surface across two Sandkit generations.
 *
 * Sandustry's official API exists in two shapes right now:
 *
 *   legacy (0.5.4, default branch) - state-first, older names
 *     api.elements.createAt(state, x, y, type, opts)
 *     api.elements.getElementTypeFromId(state, "copper")
 *     api.structures.isTypeAt(state, x, y, "goldBattery")
 *
 *   v1 (mods branch) - state bound, "...AtCell" naming
 *     api.elements.createAtCellWhenIdle(x, y, type, opts)
 *     api.elements.getTypeFromId("copper")
 *     api.structures.isTypeAtCell(x, y, "goldBattery")
 *
 * `SMLN.api` presents the **v1 names** on both, so a mod is written once. On a
 * legacy build the adapter binds the live state as the first argument and
 * translates the handful of names that were renamed.
 *
 * Two deliberate properties:
 *
 *  - Unknown methods still work. Anything not in the alias table is passed
 *    through under its own name, state-bound on legacy builds, so the adapter
 *    never becomes the reason a call is unavailable.
 *  - `SMLN.api.generation` says which shape was detected, and `SMLN.sandkit`
 *    remains the raw, unadapted object for anyone who needs it.
 */
;(function installSandkitAdapter(global) {
  var SMLN = global.__SMLN__
  if (!SMLN) return

  /**
   * v1 name -> legacy name, for the calls whose names actually changed.
   * Verified against 0.5.4's bundle; anything absent here passes through.
   */
  var ALIASES = {
    elements: {
      createAtCellWhenIdle: 'createAt',
      replaceAtCellWhenIdle: 'replaceAt',
      removeAtCellWhenIdle: 'removeAt',
      teleportBetweenCellsWhenIdle: 'teleport',
      addParticleVelocityAtCellWhenIdle: 'addParticleVelocity',
      refreshColorAtCellWhenIdle: 'refreshColorAt',
      setPhysicsAtCellWhenIdle: 'setPhysics',
      setDataFieldAtCellWhenIdle: 'setDataField1',
      getTypeFromId: 'getElementTypeFromId',
      getTypeAtCell: 'getElementTypeAtPos',
      getResolvedTypeAtCell: 'getResolvedTypeAtPos',
      getResolvedTypeFromCellId: 'getResolvedTypeFromCellId',
      getMatterTypeAtCell: 'getMatterTypeAtPos',
      getInfoAtCell: 'getInfoAtPos',
      getNameByType: 'getName',
      addInteractionInfo: 'addInteraction',
    },
    terrains: {
      createAtCellWhenIdle: 'createAt',
      replaceAtCellWhenIdle: 'replaceAt',
      removeAtCellWhenIdle: 'removeAt',
      getTypeFromId: 'getTerrainTypeFromId',
      isAtCell: 'isPosTerrain',
      isTypeAtCell: 'isPosTerrainId',
      getDataAtCell: 'getTerrainData',
      setHpAtCellWhenIdle: 'setTerrainHP',
    },
    structures: {
      isTypeAtCell: 'isTypeAt',
      getAtCell: 'getAtCell',
      hasBuiltAtCell: 'hasBuiltAtCell',
      buildAtCellWhenIdle: 'build',
      removeAtCellWhenIdle: 'removeAt',
      removeBetweenCellsWhenIdle: 'removeBetween',
      getTypeFromId: 'resolveTypeName',
      isBlockedByPlayerAtCell: 'isBlockedByPlayer',
      isLauncherAtCell: 'isLauncherAt',
    },
    world: {
      getCellIdAtCell: 'getCellId',
      isCellEmptyAtCell: 'isCellEmpty',
      isTerrainAtCell: 'isTerrainAt',
      excavateAtCell: 'excavate',
      reportActivityAtCell: 'reportActivityToChunk',
      redrawAroundCellWhenIdle: 'redrawSurroundingCells',
    },
    player: {
      getWorldPosition: 'getPosition',
      setWorldPosition: 'setPosition',
      isWithinRadiusOfCell: 'isWithinRadiusOfCell',
      isWorldPositionClear: 'isPositionClear',
    },
  }

  /** A method only the newer generation has. */
  function detect(raw) {
    if (!raw || !raw.elements) return 'unknown'
    if (typeof raw.elements.createAtCellWhenIdle === 'function') return 'v1'
    if (typeof raw.elements.createAt === 'function') return 'legacy'
    return 'unknown'
  }

  /**
   * Wrap one namespace. On legacy builds every call gets the live state
   * injected ahead of its own arguments.
   */
  function adaptNamespace(raw, nsName, bindState) {
    var aliases = ALIASES[nsName] || {}
    var out = {}

    function wrap(fn) {
      if (!bindState) return fn.bind(raw)
      return function () {
        var args = new Array(arguments.length + 1)
        args[0] = SMLN.getState()
        for (var i = 0; i < arguments.length; i++) args[i + 1] = arguments[i]
        return fn.apply(raw, args)
      }
    }

    // Pass everything through under its own name first.
    for (var key in raw) {
      try {
        var value = raw[key]
        if (typeof value === 'function') out[key] = wrap(value)
        else out[key] = value
      } catch (_) { /* exotic getter; skip it rather than fail the whole namespace */ }
    }

    // Then add the v1 spellings on top, where the target exists.
    for (var v1 in aliases) {
      var legacyName = aliases[v1]
      if (typeof out[v1] === 'function') continue
      if (raw && typeof raw[legacyName] === 'function') out[v1] = wrap(raw[legacyName])
    }

    return out
  }

  function build(raw) {
    var generation = detect(raw)
    if (generation === 'unknown') return null
    var bindState = generation === 'legacy'

    var api = { generation: generation, raw: raw }
    for (var ns in raw) {
      try {
        var value = raw[ns]
        api[ns] = value && typeof value === 'object'
          ? adaptNamespace(value, ns, bindState)
          : value
      } catch (_) { /* keep going; one bad namespace must not lose the rest */ }
    }
    return api
  }

  SMLN.on('ready', function () {
    try {
      var raw = SMLN.sandkit
      if (!raw) { SMLN.api = null; return }
      SMLN.api = build(raw)
      if (SMLN.api) {
        SMLN.log('info', 'sandkit adapter ready (' + SMLN.api.generation + ' API, ' +
          Object.keys(raw).length + ' namespaces)')
      } else {
        SMLN.log('warn', 'sandkit present but its shape was not recognised; use SMLN.sandkit directly')
      }
    } catch (e) {
      SMLN.api = null
      SMLN.log('error', 'sandkit adapter failed: ' + (e && e.message))
    }
  })

  /** Exposed for the self-test. */
  SMLN.__adapter = { build: build, detect: detect, ALIASES: ALIASES }
})(typeof globalThis !== 'undefined' ? globalThis : window)
