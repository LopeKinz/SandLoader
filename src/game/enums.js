'use strict'
/**
 * Static type tables extracted from Sandustry's renderer bundle
 * (verified against 0.5.4, Steam app id 2764460).
 *
 * These are a convenience layer only. At runtime SMLN prefers the live tables
 * reached through the captured `FH` API, because those follow the game across
 * updates. Everything here is a fallback for when the live lookup fails, plus
 * a source of stable human-readable names for console completion.
 */

/**
 * Vendored content reference tables (src/game/content.json).
 *
 * Data only. Everything below degrades to the hand-written fallbacks if the
 * file is missing or unreadable, so nothing here can stop the loader booting.
 */
let CONTENT = { elements: [], structures: [], items: [], __meta: {} }
try {
  // eslint-disable-next-line global-require
  CONTENT = require('./content.json')
} catch (_) { /* fallbacks below cover it */ }

/** @param {Record<number,string>} table @returns {Record<string,number>} */
function invert(table) {
  const out = {}
  for (const [id, name] of Object.entries(table)) out[name.toLowerCase()] = Number(id)
  return out
}

/** Particle materials - what `spawn` places into the world. */
const ElementType = {
  1: 'Sand', 2: 'Particle', 3: 'Water', 4: 'WetSand', 5: 'Sandium',
  6: 'Residue', 7: 'Gold', 8: 'Gloom', 9: 'Shake', 10: 'Steam',
  11: 'Fire', 12: 'FreezingIce', 13: 'Flame', 14: 'BurntResidue', 15: 'Seed',
  16: 'WetSeed', 17: 'Seedling', 18: 'Petalium', 19: 'Lava', 20: 'Basalt',
}

/** Physical phase of a material. Drives the console's `list gas|liquid|...`. */
const MatterType = {
  1: 'Solid', 2: 'Liquid', 3: 'Particle', 4: 'Gas',
  5: 'Static', 6: 'Slushy', 7: 'Wisp', 8: 'Powder',
}

/**
 * Phase grouping, used to bucket console output when the live element
 * definition is unreachable (before a save is loaded, mostly).
 *
 * This used to be twenty hand-written guesses and was wrong in fourteen of the
 * eighteen cases that could be checked - `sand` is Solid, not Powder;
 * `gloom` is Slushy, not Gas; `flame` is Solid, not Gas - and it covered
 * only twenty of the fifty elements. It is now derived from content.json,
 * whose `matterType` values come from the game's own registry.
 *
 * Keys are the lower-camel element ids the game uses (`wetSand`), with the
 * capitalised `ElementType` spellings (`WetSand`) mirrored in for callers
 * that hold a legacy enum name.
 */
const ELEMENT_PHASE = (() => {
  const out = {}
  for (const el of CONTENT.elements || []) {
    if (!el || !el.id || !el.matterType) continue
    out[el.id] = el.matterType
    out[el.id.charAt(0).toUpperCase() + el.id.slice(1)] = el.matterType
  }
  return out
})()

/** Element id -> {name, description, color, density, matterType}, for the console. */
const ELEMENT_INFO = (() => {
  const out = {}
  for (const el of CONTENT.elements || []) if (el && el.id) out[el.id] = el
  return out
})()

/** Structure id -> {name, description, category}. */
const STRUCTURE_INFO = (() => {
  const out = {}
  for (const st of CONTENT.structures || []) if (st && st.id) out[st.id] = st
  return out
})()

/** Item id -> {name, description, category}. */
const ITEM_INFO = (() => {
  const out = {}
  for (const it of CONTENT.items || []) if (it && it.id) out[it.id] = it
  return out
})()

/** Terrain / cell kinds (the grid itself, as opposed to loose particles). */
const CellType = {
  0: 'Empty', 1: 'Element', 2: 'Dirt', 3: 'SporeSoil', 4: 'Fog',
  5: 'FogJetpackBlock', 6: 'FogWater', 7: 'FreezingIceSoil', 8: 'Divider',
  9: 'Grass', 10: 'Moss', 11: 'GoldSoil', 12: 'Petal', 13: 'FogLava',
  14: 'Fluxite', 15: 'Block', 16: 'SlidingBlock', 17: 'SlidingBlockLeft',
  18: 'SlidingBlockRight', 19: 'ConveyorLeft', 20: 'ConveyorRight',
  21: 'ShakerLeft', 22: 'ShakerRight', 23: 'Stone', 24: 'VelocitySoaker',
  25: 'Ice', 26: 'Grower', 27: 'NascentWater', 28: 'SandiumSoil',
  29: 'Obsidian', 30: 'Crackstone',
}

/** Placeable machines. */
const StructureType = {
  1: 'ConveyorLeft', 2: 'ConveyorRight', 3: 'ShakerLeft', 4: 'ShakerRight',
  5: 'LauncherUp', 6: 'LauncherLeft', 7: 'LauncherRight', 8: 'SplitterLeft',
  9: 'SplitterRight', 10: 'Dropper', 11: 'Foundation', 12: 'FoundationAngledLeft',
  13: 'FoundationTriangleLeftDel', 14: 'FoundationAngledRight',
  15: 'FoundationTriangleRightDel', 16: 'Collector', 17: 'FilterLeft',
  18: 'FilterRight', 19: 'SlidingFoundation', 20: 'VelocitySoaker', 21: 'Grower',
  22: 'SoundBox', 23: 'Pipe', 24: 'Pump', 25: 'LiquidVent', 26: 'Light',
  27: 'GloomEmitter',
}

const ToolType = {
  1: 'Shovel', 2: 'Grabber', 3: 'Demolisher', 4: 'GrapplingHook', 5: 'Vacuum',
  6: 'Gun', 7: 'Copier', 8: 'RocketLauncher', 9: 'Digger', 10: 'Shotgun',
  11: 'Teleporter', 12: 'Flamethrower', 13: 'PipeRemover', 14: 'Hauler',
  15: 'Cryoblaster', 16: 'MegaShotgun',
}

/**
 * Simulation-worker message protocol: `manager.postMessage([type, ...args])`.
 * The Register* entries are the game's own mod-registration channel and are
 * what the future gameplay API will drive.
 */
const WorkerMessage = {
  Init: 1, RunUpdate: 2, SetCell: 3, Blast: 4, Dig: 5, Vacuum: 6,
  AddStructure: 7, AddStructures: 8, RemoveStructuresBetween: 9,
  HandleGrabber: 10, SwapElement: 11, SetChunkActive: 12, Tally: 13,
  Ignite: 14, StartFogReveal: 15, SetTutorialStep: 16, StartWaterFreeze: 17,
  StartMelt: 18, Burn: 19, RedrawSurroundingCells: 20, IncrementFluxite: 21,
  SpawnFluxiteParticles: 22, DebugCell: 23, StartLavaFreeze: 24, PingChunk: 25,
  QueueSetCell: 26, SetUpgradeLevel: 27, BuildCheck: 28,
  RegisterModElements: 29, RegisterModTerrains: 30, RegisterWorkerEventHandler: 31,
  RegisterWorkerHook: 32, LogTriggers: 33, CollectEventCounts: 34,
  ClearEventCounts: 35, InitFinished: 36, UpdateFinished: 37, SetPixel: 38,
  Collector: 39, TutorialStep: 40, PlaySound: 41, AddLight: 42, MoveCamera: 43,
  SpawnWorldItem: 44, ForceCompleteObjective: 45, SandkitEvent: 46,
  SandkitCreateParticles: 47, SandkitCreateEffect: 48, ShowToast: 49,
  EventCountsResponse: 50, RunConveyorBelts: 51, UpdateStructure: 52,
  PostUpdate: 53, SetPaused: 54, Save: 55, RegisterManagerTrigger: 56,
  StartManagerLoop: 57, RegisterModSharedBuffer: 58, RegisterConveyorType: 59,
  SaveComplete: 60, FlameBurn: 61, RegisterLauncherType: 62,
  RegisterModStructures: 63, ElementSlabsExhausted: 64, ReallocSimState: 65,
  UpdateStructures: 66, RunTick: 67, SetSimulationSpeed: 68, UtilityInit: 69,
  UtilitySave: 70, ComputeShadowClassifyAndRow: 71,
  ComputeShadowClassifyAndRowFinished: 72, ComputeShadowColumnAndAssemble: 73,
  ComputeShadowColumnAndAssembleFinished: 74, RegisterModMatters: 75,
  FlameBurnBatch: 76, AddLightBatch: 77, SandkitCreateParticlesBatch: 78,
  SandkitEventBatch: 79, UpdateDefinition: 80, TerrainDestroyedBatch: 81,
}

/** UI screens, used to ask the game to re-render after a console mutation. */
const UIScreen = {
  Hotbar: 1, SoundBoxConfig: 2, Debug: 3, Root: 4, Menu: 5, Management: 6,
  FilterConfig: 7, Resources: 8, TechTree: 9, Tutorial: 10, Loader: 11,
  Options: 12, ShortcutHelper: 13, Upgrades: 14, Tooltip: 15, Notifications: 16,
  Objectives: 17, DroneAdminList: 18, HotbarOverlays: 19, IntroScreen: 20,
  StoryNotifications: 21, FactoryProgress: 22, Dialogs: 23, GlobalOverlays: 24,
  Lexicon: 25, ModsScreen: 26, CustomMapsScreen: 27, CinematicPanel: 28,
  Feedback: 29,
}

/**
 * Content keys as the game names them in its own translation table
 * (`elements|<key>|name`, `terrains|<key>|name`).
 *
 * These are the authoritative *names*; numeric element ids are resolved at
 * runtime because the live registry is larger than the legacy `ElementType`
 * enum and grows when mods register their own content.
 */
const ELEMENT_KEYS_FALLBACK = [
  'auralite', 'aurixite', 'basalt', 'burntResidue', 'caulk', 'cloud', 'coolant',
  'copper', 'dryPetalium', 'fire', 'flame', 'florin', 'florinol', 'freezingIce',
  'gloom', 'gold', 'growingVoidSeed', 'heatedWater', 'hyperpressure',
  'irradiatedCrystal', 'lava', 'liquidCopper', 'liquidGold', 'moonhop', 'oil',
  'petalium', 'pressurizedWater', 'prismaline', 'prismite', 'pyronol',
  'reactorCore', 'residue', 'retroConsoleCasing', 'retroConsolePixelOff',
  'retroConsolePixelOn', 'sand', 'sandium', 'seed', 'seedling', 'slowFlow',
  'steam', 'sunsand', 'voidPetal', 'voidSeeds', 'voidhusk', 'voidjuice',
  'water', 'waterPressure', 'wetSand', 'wetSeed',
]

/** Prefer the vendored table; fall back to the literal list above. */
const ELEMENT_KEYS = (CONTENT.elements || []).length
  ? CONTENT.elements.map((e) => e.id)
  : ELEMENT_KEYS_FALLBACK

/** Terrains are created by name: `FH.terrains.createAt(state, x, y, "copper")`. */
const TERRAIN_KEYS = [
  'auraliteCrystal', 'bedrock', 'blackrock', 'caldera', 'copper', 'crackstone',
  'crystal', 'dirt', 'dissolvingTerrain', 'dune', 'earth', 'florinolSoil',
  'fluxite', 'frostbed', 'gameOfLifeRandom', 'gameOfLifeStrict', 'glassTerrain',
  'golGrow', 'grass', 'ice', 'limestone', 'moss', 'puffMushroom', 'redsoil',
  'sand2', 'sandstone', 'scoria', 'shatterstone', 'solidite', 'sporemound',
  'spreadingTerrain', 'stone', 'vine', 'voidFlowerSoil',
]

/** Countable resources on `store.resources`. */
const RESOURCES = ['gold', 'fluxite', 'energy', 'artifacts', 'lumlings', 'shinelets']

module.exports = {
  ElementType, MatterType, ELEMENT_PHASE, CellType, StructureType, ToolType,
  WorkerMessage, UIScreen, RESOURCES, ELEMENT_KEYS, TERRAIN_KEYS,
  ELEMENT_INFO, STRUCTURE_INFO, ITEM_INFO,
  /** Provenance of the vendored tables; shown by the self-test. */
  CONTENT_META: CONTENT.__meta || {},
  ElementByName: invert(ElementType),
  CellByName: invert(CellType),
  StructureByName: invert(StructureType),
  ToolByName: invert(ToolType),
  /** Bundle facts SMLN was verified against; drift is reported, never fatal. */
  VERIFIED: { gameVersion: '0.5.5', appId: 2764460 },
}
