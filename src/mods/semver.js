'use strict'
/**
 * Dependency-free semantic version parsing and range matching.
 *
 * Why hand-roll this instead of pulling in `semver` from npm: the project
 * takes no dependencies (see house style), and mod manifests only ever need a
 * small, well-defined slice of the spec - basic comparators, `^`/`~`, x-ranges
 * and `||`. Implementing that slice directly keeps the surface small enough
 * to read in one sitting and to reason about when a manifest fails to parse.
 *
 * This module never throws. `compare` and `satisfies` are called from mod
 * resolution paths where a malformed version string is user input (a mod
 * author's typo), not a program bug - the correct response is "sorts last" /
 * "does not match", not an exception that aborts the whole resolver.
 * `explain` is the one function that turns a mismatch into the human-readable
 * reason the dependency resolver puts in its error message.
 */

/** @typedef {{major:number, minor:number, patch:number, prerelease:string[], build:string[]}} Version */
/** @typedef {{op:'='|'>'|'>='|'<'|'<=', version:Version}} Comparator */
/** @typedef {Comparator[][]} ParsedRange  outer array is OR'd, inner array is AND'd */

// major.minor.patch, each a plain non-negative integer with no leading zero
// (leading zeros are rejected by the spec because "01" is ambiguous between
// decimal and octal readers) - optional -prerelease and +build suffixes.
const CORE_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/
const PRERELEASE_ID_RE = /^[0-9A-Za-z-]+$/
const NUMERIC_ID_RE = /^(0|[1-9]\d*)$/

/**
 * Parse a strict `major.minor.patch[-prerelease][+build]` version string.
 * @param {string} version
 * @returns {Version|null}
 */
function parse(version) {
  if (typeof version !== 'string') return null
  const v = version.trim().replace(/^v/, '')
  const m = CORE_RE.exec(v)
  if (!m) return null
  const [, major, minor, patch, pre, build] = m
  const prerelease = pre ? pre.split('.') : []
  // Reject prerelease identifiers that look numeric but have a leading zero
  // (e.g. "01"), and anything outside [0-9A-Za-z-] - same ambiguity as above.
  for (const id of prerelease) {
    if (!PRERELEASE_ID_RE.test(id)) return null
    if (/^\d+$/.test(id) && !NUMERIC_ID_RE.test(id)) return null
  }
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease,
    build: build ? build.split('.') : [],
  }
}

/** @param {string} version */
function valid(version) {
  return parse(version) !== null
}

/** Compare two dot-separated prerelease identifier arrays per semver precedence. */
function comparePrerelease(a, b) {
  // No prerelease field outranks any prerelease field (1.0.0 > 1.0.0-beta).
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (i >= a.length) return -1 // a ran out of fields -> fewer fields sorts lower
    if (i >= b.length) return 1
    const x = a[i]
    const y = b[i]
    const xNum = NUMERIC_ID_RE.test(x)
    const yNum = NUMERIC_ID_RE.test(y)
    if (xNum && yNum) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff < 0 ? -1 : 1
    } else if (xNum !== yNum) {
      // Numeric identifiers always sort lower than alphanumeric ones.
      return xNum ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/**
 * Compare two version strings. Build metadata never affects the result.
 * Invalid input sorts last so callers that feed it through `.sort()` get a
 * stable, non-throwing order instead of a crash mid-sort.
 * @param {string} a @param {string} b
 * @returns {-1|0|1}
 */
function compare(a, b) {
  const va = parse(a)
  const vb = parse(b)
  if (!va && !vb) return 0
  if (!va) return 1
  if (!vb) return -1
  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1
  return comparePrerelease(va.prerelease, vb.prerelease)
}

// ---------------------------------------------------------------------------
// Range parsing
// ---------------------------------------------------------------------------

const OP_RE = /^(=|>=|<=|>|<)?\s*v?(\d+|\*|x|X)(?:\.(\d+|\*|x|X))?(?:\.(\d+|\*|x|X))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

/** True if the token stands for "any value at this position". */
function isWild(t) {
  return t == null || t === '*' || t === 'x' || t === 'X'
}

/**
 * Parse one whitespace-delimited comparator token (`^1.2.3`, `~1.2`, `1.x`,
 * `>=1.2.0`, ...) into one or two concrete comparators. Returns null on any
 * syntax it does not recognise - callers must treat that as a hard parse
 * failure, not as "no constraint".
 * @returns {Comparator[]|null}
 */
function parseComparator(token) {
  if (token === '') return [] // caller maps a wholly-empty range to "any"

  const caret = token[0] === '^'
  const tilde = token[0] === '~'
  const body = caret || tilde ? token.slice(1) : token
  const m = OP_RE.exec(body)
  if (!m) return null
  const [, op, xMajor, xMinor, xPatch, pre, build] = m

  // `^`/`~` never combine with an explicit comparison operator - `^>=1.2.3`
  // is not a thing either upstream or here, so reject it rather than guess
  // which one the author meant.
  if ((caret || tilde) && op) return null

  const wildMinor = isWild(xMinor)
  const wildPatch = isWild(xPatch)
  const wildMajor = isWild(xMajor)
  if (wildMajor && (op || caret || tilde || pre || build)) return null // "*" takes no qualifiers

  const major = wildMajor ? 0 : Number(xMajor)
  const minor = wildMinor ? 0 : Number(xMinor)
  const patch = wildPatch ? 0 : Number(xPatch)
  const prerelease = pre ? pre.split('.') : []
  const base = { major, minor, patch, prerelease, build: [] }

  if (wildMajor) return [] // "*" / "" - unconstrained

  if (caret) {
    // ^ pins the leftmost non-zero component and allows everything up to
    // (but not including) the next bump of the component to its left. This
    // is npm's "won't break my require" rule, extended to cover the 0.x.y
    // and 0.0.x corners where a minor/patch bump is itself a breaking change.
    const upper = wildMinor
      ? { major: major + 1, minor: 0, patch: 0, prerelease: [], build: [] }
      : wildPatch
        ? major === 0
          ? { major, minor: minor + 1, patch: 0, prerelease: [], build: [] }
          : { major: major + 1, minor: 0, patch: 0, prerelease: [], build: [] }
        : major === 0 && minor === 0
          ? { major, minor, patch: patch + 1, prerelease: [], build: [] }
          : major === 0
            ? { major, minor: minor + 1, patch: 0, prerelease: [], build: [] }
            : { major: major + 1, minor: 0, patch: 0, prerelease: [], build: [] }
    return [{ op: '>=', version: base }, { op: '<', version: upper }]
  }

  if (tilde) {
    // ~ allows patch-level changes if minor is given, otherwise minor-level.
    const upper = wildMinor
      ? { major: major + 1, minor: 0, patch: 0, prerelease: [], build: [] }
      : { major, minor: minor + 1, patch: 0, prerelease: [], build: [] }
    return [{ op: '>=', version: base }, { op: '<', version: upper }]
  }

  if (wildMinor) {
    // Bare "1" / "1.x" - any minor/patch within that major.
    if (op) return null // ">1" etc. is ambiguous (>1.0.0? >1.x.x?) - reject
    return [
      { op: '>=', version: base },
      { op: '<', version: { major: major + 1, minor: 0, patch: 0, prerelease: [], build: [] } },
    ]
  }

  if (wildPatch) {
    // "1.2" / "1.2.x" - any patch within that minor.
    if (op) return null
    return [
      { op: '>=', version: base },
      { op: '<', version: { major, minor: minor + 1, patch: 0, prerelease: [], build: [] } },
    ]
  }

  // Fully concrete version, with an explicit or implied "=" operator.
  return [{ op: op || '=', version: base }]
}

/**
 * Parse a full range string: OR ("||") of AND-joined ("space") comparator
 * sets. Malformed input is rejected outright rather than defaulted to "any" -
 * a manifest with a typo'd range (`^^1.0`, `>=`) that silently became
 * unconstrained would let an incompatible mod load anyway, turning a typo
 * into a mystery crash somewhere else entirely. Failing loudly at manifest
 * load time is far cheaper to debug.
 * @param {string} range
 * @returns {{ok:true, range:ParsedRange}|{ok:false, reason:string}}
 */
function parseRange(range) {
  if (typeof range !== 'string') return { ok: false, reason: 'range must be a string' }
  const trimmed = range.trim()
  if (trimmed === '') return { ok: true, range: [[]] } // empty range = any version

  /** @type {ParsedRange} */
  const out = []
  const orParts = trimmed.split('||')
  for (const rawSet of orParts) {
    const set = rawSet.trim()
    if (set === '') return { ok: false, reason: `range "${range}" has an empty clause between "||"` }
    const tokens = set.split(/\s+/).filter(Boolean)
    /** @type {Comparator[]} */
    const comparators = []
    for (const token of tokens) {
      const parsed = parseComparator(token)
      if (parsed === null) return { ok: false, reason: `range "${range}" has an unparseable term "${token}"` }
      comparators.push(...parsed)
    }
    out.push(comparators)
  }
  return { ok: true, range: out }
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Compare only [major,minor,patch], ignoring prerelease/build. */
function compareTuple(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return 0
}

function satisfiesComparator(v, c) {
  const cmp = compare(
    `${v.major}.${v.minor}.${v.patch}${v.prerelease.length ? '-' + v.prerelease.join('.') : ''}`,
    `${c.version.major}.${c.version.minor}.${c.version.patch}${c.version.prerelease.length ? '-' + c.version.prerelease.join('.') : ''}`,
  )
  switch (c.op) {
    case '=': return cmp === 0
    case '>': return cmp > 0
    case '>=': return cmp >= 0
    case '<': return cmp < 0
    case '<=': return cmp <= 0
    default: return false
  }
}

/**
 * A comparator set matches a prerelease version only if at least one
 * comparator in the set names the exact same [major,minor,patch] tuple and
 * itself carries a prerelease tag. Without this rule `^1.2.0` (meaning
 * "anything a caller compiled against 1.2.0 can safely receive") would also
 * accept `1.3.0-alpha`, a build nobody has finished yet and that the range's
 * author never had a chance to test against. Mirrors node-semver exactly so
 * range strings copied from npm mod manifests behave the same way here.
 */
function setAllowsPrerelease(set, v) {
  if (v.prerelease.length === 0) return true
  return set.some((c) => c.version.prerelease.length > 0 && compareTuple(c.version, v) === 0)
}

function setSatisfies(set, v) {
  if (!setAllowsPrerelease(set, v)) return false
  return set.every((c) => satisfiesComparator(v, c))
}

/**
 * @param {string} version @param {string} range
 * @returns {boolean} false on any malformed input - never throws.
 */
function satisfies(version, range) {
  const v = parse(version)
  if (!v) return false
  const parsed = parseRange(range)
  if (!parsed.ok) return false
  return parsed.range.some((set) => setSatisfies(set, v))
}

/**
 * Human-facing version of `satisfies`, for the dependency resolver's error
 * messages. Distinguishes *why* a version failed (bad version string, bad
 * range string, or a genuine mismatch) so the resolver doesn't have to
 * re-derive that itself.
 * @param {string} version @param {string} range
 * @returns {{ok:true}|{ok:false, code:'E_RANGE_MALFORMED'|'E_VERSION_MALFORMED'|'E_VERSION_MISMATCH', reason:string}}
 */
function explain(version, range) {
  const parsedRange = parseRange(range)
  if (!parsedRange.ok) {
    return { ok: false, code: 'E_RANGE_MALFORMED', reason: `dependency range "${range}" is malformed: ${parsedRange.reason}` }
  }
  const v = parse(version)
  if (!v) {
    return { ok: false, code: 'E_VERSION_MALFORMED', reason: `version "${version}" is not a valid semver version` }
  }
  const ok = parsedRange.range.some((set) => setSatisfies(set, v))
  if (ok) return { ok: true }
  return {
    ok: false,
    code: 'E_VERSION_MISMATCH',
    reason: `version ${version} does not satisfy range ${formatRange(range)}`,
  }
}

/**
 * Normalise a range to a stable display string (mainly so error messages
 * don't echo back oddities like doubled whitespace). Falls back to the input
 * unchanged if it does not parse - `explain`/`satisfies` already reject those,
 * this is display-only and must not throw either.
 * @param {string} range
 * @returns {string}
 */
function formatRange(range) {
  const parsed = parseRange(range)
  if (!parsed.ok) return range
  if (parsed.range.length === 1 && parsed.range[0].length === 0) return '*'
  return parsed.range
    .map((set) => set.map((c) => `${c.op}${c.version.major}.${c.version.minor}.${c.version.patch}${c.version.prerelease.length ? '-' + c.version.prerelease.join('.') : ''}`).join(' '))
    .join(' || ')
}

module.exports = { parse, compare, valid, parseRange, satisfies, explain, formatRange }
