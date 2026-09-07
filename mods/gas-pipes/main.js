'use strict'

const fs = require('fs')
const path = require('path')

const TARGET = 'js/bundle.js'
const GAS_MATTER_TYPE = 4
const VERSION = '1.4.0'

function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matches(re, source) {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g'
  const rx = new RegExp(re.source, flags)
  const out = []
  let m
  while ((m = rx.exec(source)) !== null) {
    out.push(m)
    if (!m[0].length) rx.lastIndex++
  }
  return out
}

function countLiteral(source, needle) {
  if (!needle) return 0
  let count = 0
  let at = 0
  while ((at = source.indexOf(needle, at)) !== -1) {
    count++
    at += Math.max(1, needle.length)
  }
  return count
}

function bundlePath(smln) {
  const install = smln && smln.install
  if (install && install.distDir) return path.join(install.distDir, 'js', 'bundle.js')
  if (install && install.asar) return path.join(install.asar, 'dist', 'js', 'bundle.js')
  if (process.resourcesPath) return path.join(process.resourcesPath, 'app.asar', 'dist', 'js', 'bundle.js')
  return null
}

function uniqueExact(source, start, end) {
  let before = 0
  let after = 0
  for (let i = 0; i < 12; i++) {
    const from = Math.max(0, start - before)
    const to = Math.min(source.length, end + after)
    const text = source.slice(from, to)
    if (countLiteral(source, text) === 1) return { text, from, to }
    before += 120
    after += 120
  }
  return null
}

function findMatterTable(source) {
  const patterns = [
    /([\w$]+)\s*=\s*function\s*\(\s*([\w$]+)\s*,\s*([\w$]+)\s*\)\s*\{\s*return\s+([\w$]+)\s*\[\s*\2\s*\]\s*\.matterType\s*(?:===|==)\s*\3\s*;?\s*\}/g,
    /return\s+([\w$]+)\s*\[\s*([\w$]+)\s*\]\s*\.matterType\s*(?:===|==)\s*([\w$]+)/g,
  ]
  for (let p = 0; p < patterns.length; p++) {
    const all = matches(patterns[p], source)
    if (!all.length) continue
    // Pattern 1: table is capture 4. Pattern 2: table is capture 1.
    return p === 0 ? all[0][4] : all[0][1]
  }
  return null
}

function applyEdits(text, base, edits) {
  const sorted = edits.slice().sort((a, b) => b.start - a.start)
  let out = text
  let last = Infinity
  for (const e of sorted) {
    if (e.end > last) throw new Error(`overlapping generated edits near ${e.label}`)
    const from = e.start - base
    const to = e.end - base
    if (from < 0 || to > out.length || from > to) {
      throw new Error(`generated edit outside Pump anchor: ${e.label}`)
    }
    out = out.slice(0, from) + e.replace + out.slice(to)
    last = e.start
  }
  return out
}

function analyse(source, logger) {
  // The recurring vanilla Pump path is anchored by its authored Water check.
  const waterChecks = matches(
    /([\w$]+)\(\s*([\w$]+)\s*,\s*([\w$]+)\s*,\s*([\w$]+)\s*\)\s*(?:===|==)\s*([\w$]+)\.Water/g,
    source
  )

  const candidates = []

  for (const check of waterChecks) {
    const getType = check[1]
    const state = check[2]
    const x = check[3]
    const y = check[4]
    const elements = check[5]

    const beforeStart = Math.max(0, check.index - 8000)
    const before = source.slice(beforeStart, check.index)
    const after = source.slice(check.index, Math.min(source.length, check.index + 9000))

    if (!before.includes('.data.connectedVents') || !before.includes('.data.waterBuffer')) continue

    // Find the Pump object from: pump.data.waterBuffer = pump.data.waterBuffer || 0
    const pumpInits = matches(
      /([\w$]+)\.data\.waterBuffer\s*=\s*\1\.data\.waterBuffer\s*\|\|\s*0/g,
      before
    )
    if (!pumpInits.length) continue
    const pumpInit = pumpInits[pumpInits.length - 1]
    const pump = pumpInit[1]
    const pumpInitAbs = beforeStart + pumpInit.index

    // The exact worker removal for the same intake cell.
    const removalRe = new RegExp(
      '\\[\\s*([\\w$]+)\\.QueueSetCell\\s*,\\s*\\[\\s*' + esc(x) +
      '\\s*,\\s*' + esc(y) + '\\s*,\\s*([\\w$]+)\\.Empty\\s*,\\s*' +
      esc(elements) + '\\.Water\\s*\\]\\s*\\]',
      'g'
    )
    const removals = matches(removalRe, after)
    if (!removals.length) continue
    const removal = removals[0]
    const removalAbs = check.index + removal.index

    // Current Sandustry increments a LOCAL moved-count (not waterBuffer++).
    const afterRemovalStart = removal.index + removal[0].length
    const countSearch = after.slice(afterRemovalStart, afterRemovalStart + 700)
    const countMatches = matches(/\+\+([\w$]+)\s*>=\s*([\w$]+)/g, countSearch)
    if (!countMatches.length) continue
    const countMatch = countMatches[0]
    const movedCount = countMatch[1]
    const capacity = countMatch[2]
    const countAbs = check.index + afterRemovalStart + countMatch.index

    // Find the `(movedCount = 0),` initialization immediately before intake.
    const countInitRe = new RegExp('\\(\\s*' + esc(movedCount) + '\\s*=\\s*0\\s*\\)\\s*,', 'g')
    const countInits = matches(countInitRe, before)
    if (!countInits.length) continue
    const countInit = countInits[countInits.length - 1]
    const countInitAbs = beforeStart + countInit.index
    if (countInitAbs < pumpInitAbs) continue

    // Vanilla saves an output shortfall back into waterBuffer. Our typed queue
    // already retains those entries, so that assignment must be neutralized.
    const tail = source.slice(countAbs, Math.min(source.length, countAbs + 7000))
    const shortfallRe = new RegExp(
      esc(pump) + '\\.data\\.waterBuffer\\s*=\\s*' + esc(movedCount) + '\\s*-\\s*([\\w$]+)\\.length',
      'g'
    )
    const shortfalls = matches(shortfallRe, tail)
    if (!shortfalls.length) continue
    const shortfall = shortfalls[0]
    const slots = shortfall[1]
    const shortfallAbs = countAbs + shortfall.index

    // Vanilla emits Water via the element constructor into a selected vent cell.
    const ctorRe = new RegExp(
      '([\\w$]+)\\(\\s*' + esc(elements) + '\\.Water\\s*,\\s*([\\w$]+)\\.x\\s*,\\s*\\2\\.y\\s*\\)',
      'g'
    )
    const ctors = matches(ctorRe, tail)
    const viableCtors = ctors.filter((m) => m.index > shortfall.index)
    if (!viableCtors.length) continue
    const ctor = viableCtors[0]
    const makeElement = ctor[1]
    const dest = ctor[2]
    const ctorAbs = countAbs + ctor.index

    // Ensure the ctor is really in the same vent-output path.
    const outputNeighborhood = tail.slice(Math.max(0, ctor.index - 1800), ctor.index + 500)
    if (!outputNeighborhood.includes(`${slots}.length`) || !outputNeighborhood.includes('.QueueSetCell')) continue

    candidates.push({
      check,
      getType,
      state,
      x,
      y,
      elements,
      pump,
      pumpInit,
      pumpInitAbs,
      removal,
      removalAbs,
      workerMessages: removal[1],
      cellTypes: removal[2],
      movedCount,
      capacity,
      countMatch,
      countAbs,
      countInit,
      countInitAbs,
      shortfall,
      shortfallAbs,
      slots,
      ctor,
      ctorAbs,
      makeElement,
      dest,
    })
  }

  if (candidates.length !== 1) {
    throw new Error(`expected one live vanilla Pump water path, found ${candidates.length}`)
  }

  const c = candidates[0]
  const matterTable = findMatterTable(source)
  const buffer = `${c.pump}.data.__smlnGasPipeBuffer`
  const current = `${c.pump}.data.__smlnGasPipeCurrent`
  const stats = 'globalThis.__SMLN_GAS_PIPES_STATS__'

  const gasTest = matterTable
    ? `(${matterTable}[T]&&${matterTable}[T].matterType===${GAS_MATTER_TYPE})`
    : `(T===${c.elements}.Steam||T===${c.elements}.Fire)`

  const statsInit =
    `(${stats}||(${stats}={version:"${VERSION}",checks:0,gasSeen:0,moved:0,lastType:null,lastMove:null}))`

  // One large exact anchor means all edits happen atomically in the same Pump
  // lexical scope. No generated local identifier ever escapes the function.
  const anchor = uniqueExact(source, c.pumpInitAbs, c.ctorAbs + c.ctor[0].length)
  if (!anchor) throw new Error('could not make the live Pump flow anchor unique')

  const edits = []

  // Convert any pre-existing vanilla buffered Water once, initialize our typed
  // queue, then keep vanilla waterBuffer at zero to avoid double-accounting.
  const initOriginal = c.pumpInit[0]
  const initReplacement =
    `(${initOriginal}),` +
    `(${buffer}=${buffer}||[]),` +
    `(${c.pump}.data.waterBuffer>0&&function(B,N,T){for(var __smlnQ=0;__smlnQ<N;__smlnQ++)B.push(T)}(${buffer},${c.pump}.data.waterBuffer,${c.elements}.Water)),` +
    `(${c.pump}.data.waterBuffer=0),` +
    statsInit
  edits.push({
    label: 'typed buffer initialization',
    start: c.pumpInitAbs,
    end: c.pumpInitAbs + c.pumpInit[0].length,
    replace: initReplacement,
  })

  // Start the vanilla moved-count with already-buffered typed elements.
  edits.push({
    label: 'typed buffered count',
    start: c.countInitAbs,
    end: c.countInitAbs + c.countInit[0].length,
    replace: `(${c.movedCount}=Math.min(${buffer}.length,${c.capacity})),`,
  })

  // Accept Water OR any element whose live definition says matterType=Gas.
  const generalizedCheck =
    `(function(T){var Z=${statsInit};Z.checks++;${current}=T;` +
    `if(T===${c.elements}.Water)return true;` +
    `if(${gasTest}){Z.gasSeen++;Z.lastType=T;return true}` +
    `return false})(${c.check[0].replace(/\s*(?:===|==)\s*[\w$]+\.Water\s*$/, '')})`
  edits.push({
    label: 'Water-or-Gas intake check',
    start: c.check.index,
    end: c.check.index + c.check[0].length,
    replace: generalizedCheck,
  })

  // QueueSetCell's old element type must match the cell we actually remove.
  const dynamicRemoval = c.removal[0].replace(
    new RegExp(esc(c.elements) + '\\.Water'),
    current
  )
  edits.push({
    label: 'dynamic intake removal type',
    start: c.removalAbs,
    end: c.removalAbs + c.removal[0].length,
    replace: dynamicRemoval,
  })

  // Preserve the exact type in FIFO order before incrementing vanilla's count.
  edits.push({
    label: 'queue accepted element type',
    start: c.countAbs,
    end: c.countAbs + c.countMatch[0].length,
    replace: `(${buffer}.push(${current}),++${c.movedCount}>=${c.capacity})`,
  })

  // Do not duplicate leftovers into the old untyped waterBuffer.
  edits.push({
    label: 'disable untyped shortfall buffer',
    start: c.shortfallAbs,
    end: c.shortfallAbs + c.shortfall[0].length,
    replace: `${c.pump}.data.waterBuffer=0`,
  })

  // Emit the next queued type using the SAME vanilla element constructor and
  // SAME selected Liquid Vent coordinate that Water uses.
  const emitReplacement =
    `(function(T){var Z=${statsInit};if(T==null)T=${c.elements}.Water;` +
    `if(T!==${c.elements}.Water){Z.moved++;Z.lastType=T;Z.lastMove={type:T,x:${c.dest}.x,y:${c.dest}.y}}` +
    `return ${c.makeElement}(T,${c.dest}.x,${c.dest}.y)})(${buffer}.shift())`
  edits.push({
    label: 'typed Liquid Vent output',
    start: c.ctorAbs,
    end: c.ctorAbs + c.ctor[0].length,
    replace: emitReplacement,
  })

  const replacement = applyEdits(anchor.text, anchor.from, edits)

  logger.info(
    `Gas Pipes ${VERSION}: live Pump path resolved ` +
    `(pump=${c.pump}, getType=${c.getType}, count=${c.movedCount}, capacity=${c.capacity}, ` +
    `ctor=${c.makeElement}, matter=${matterTable || 'Steam/Fire fallback'})`
  )

  return { find: anchor.text, replace: replacement }
}

module.exports.setup = ({ logger, smln }) => {
  const gameVersion = (smln && smln.install && smln.install.version) || 'unknown'
  logger.info(`Gas Pipes ${VERSION} loading for Sandustry ${gameVersion}`)

  const file = bundlePath(smln)
  if (!file) {
    logger.error('Gas Pipes: could not resolve installed js/bundle.js path')
    return { patches: [] }
  }

  let source
  try {
    source = fs.readFileSync(file, 'utf8')
  } catch (e) {
    logger.error(`Gas Pipes: could not read installed bundle: ${e.message}`)
    return { patches: [] }
  }

  let patch
  try {
    patch = analyse(source, logger)
  } catch (e) {
    logger.error(`Gas Pipes: live Pump hook unavailable: ${e.message}`)
    return { patches: [] }
  }

  return {
    patches: [
      {
        id: 'gas-pipes:vanilla-pump-water-or-gas',
        description: 'Extend the live vanilla Pump -> Pipe -> Liquid Vent flow from Water to Gas while preserving element type',
        find: patch.find,
        replace: patch.replace,
        expect: 1,
        required: true,
        target: TARGET,
      },
    ],
  }
}

// Exported only so the local fixture test can validate the resolver without
// needing Electron/SandLoader. SandLoader itself only calls setup().
module.exports._test = { analyse, findMatterTable }
