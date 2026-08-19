'use strict'
/**
 * Mod permission model and classifier.
 *
 * This module is the honest description of a security boundary that mostly
 * already exists elsewhere, not the enforcement of one. It does no I/O, talks
 * to no persistence, and knows nothing about Electron - it only decides what
 * tier a mod's declared permissions and entrypoints put it in, and validates
 * the `permissions` field of a manifest. Other modules enforce (gating
 * SMLN.net / SMLN.storage / SMLN.fs calls, approving installs, rendering the
 * UI) and persist (remembering an approval) against the contract exported
 * here.
 *
 * The boundary, stated plainly:
 *
 *   - Sandustry's renderer runs with Electron's modern defaults
 *     (contextIsolation:true, nodeIntegration:false, no sandbox:false). That
 *     means renderer ("game") and worker mod code has NO Node - no `require`,
 *     `process`, `Buffer` or `module`. This is enforced by Chromium, not by
 *     SandLoader, and it cannot be turned off by anything in this file. A
 *     SANDBOXED mod is sandboxed because the browser process refuses it
 *     Node, full stop.
 *   - The only privileged execution class is the main process: an SMLN
 *     `main` entrypoint (loaded with a real `require`) and a Fluxloader
 *     `electronEntrypoint` (run through Node's `vm` module with real
 *     `require`/`process`/`Buffer` handed into the sandbox object by
 *     src/compat/fluxloader.js). `vm` there is a code-organisation tool, NOT
 *     a security boundary - the script gets literal Node. Both are modelled
 *     as NATIVE.
 *   - Between those two poles, SMLN can offer scoped capabilities
 *     (SMLN.net, SMLN.storage/SMLN.fs) to renderer/worker code that declares
 *     `network` or `filesystem`. That gate is real and enforceable, because
 *     the calling code has no other way to reach the network or disk - it
 *     has no Node. That is the ELEVATED tier.
 *   - A NATIVE mod already has Node, so "restrict its filesystem/network
 *     access" is not a thing SandLoader can do; the restriction would be
 *     cosmetic. `enforceable:false` on a NATIVE capability is this module
 *     saying that out loud instead of implying a guarantee nothing backs.
 *
 * Permissions are therefore modelled as tiers derived from *where code runs*
 * plus what it explicitly asks for, not as independent on/off switches that
 * could be composed into a false sense of granularity.
 */

const { SmlnError } = require('../core/errors')

/** @typedef {'sandboxed'|'elevated'|'native'} Tier */

const TIERS = Object.freeze({
  SANDBOXED: 'sandboxed',
  ELEVATED: 'elevated',
  NATIVE: 'native',
})

/**
 * @typedef {Object} PermissionDescriptor
 * @property {string} id
 * @property {Tier} tier              Tier this permission pushes a mod to.
 * @property {boolean} implemented
 * @property {string} titleKey        i18n key; English text lives in the i18n module.
 * @property {string} descriptionKey
 * @property {string} title           English fallback, used by main-process logs.
 * @property {string} description
 * @property {'info'|'warn'|'danger'} risk
 * @property {boolean} impliedByNode  True when raw Node access trivially bypasses
 *                                    whatever this permission would otherwise gate.
 * @property {string} [warning]       Extra caution text surfaced for dangerous grants.
 */

/**
 * Recognised permissions. `filesystem`/`network` are real, scoped grants that
 * SMLN can actually gate because the caller has no other route to disk or
 * network. `node` is not a grant SandLoader hands out - it is a name for the
 * privilege the environment already gives main-process code. `process`,
 * `shell` and `native-ipc` are reserved names for capabilities this build
 * does not implement; they exist here so `validate` can reject them by name
 * ("recognised but not supported yet") instead of lumping them in with
 * typos ("unknown").
 * @type {Record<string, PermissionDescriptor>}
 */

/** Shared shape for the not-yet-implemented native-tier reserved names. */
function reserved(id, title, description) {
  return Object.freeze({
    id,
    tier: TIERS.NATIVE,
    implemented: false,
    titleKey: `perm.${id}.title`,
    descriptionKey: `perm.${id}.desc`,
    title,
    description: `${description} Reserved for a future SandLoader version.`,
    risk: 'danger',
    impliedByNode: true,
    warning: 'Not implemented by this SandLoader version.',
  })
}

const PERMISSIONS = Object.freeze({
  filesystem: Object.freeze({
    id: 'filesystem',
    tier: TIERS.ELEVATED,
    implemented: true,
    titleKey: 'perm.filesystem.title',
    descriptionKey: 'perm.filesystem.desc',
    title: 'Filesystem access',
    description: 'Lets this mod read and write files through SMLN.storage/SMLN.fs, scoped to its own mod data.',
    risk: 'warn',
    impliedByNode: true,
  }),
  network: Object.freeze({
    id: 'network',
    tier: TIERS.ELEVATED,
    implemented: true,
    titleKey: 'perm.network.title',
    descriptionKey: 'perm.network.desc',
    title: 'Network access',
    description: 'Lets this mod contact remote servers through SMLN.net.',
    risk: 'warn',
    impliedByNode: true,
  }),
  node: Object.freeze({
    id: 'node',
    tier: TIERS.NATIVE,
    implemented: true,
    titleKey: 'perm.node.title',
    descriptionKey: 'perm.node.desc',
    title: 'Node.js / native code',
    description:
      'Runs in the Electron main process with real Node.js: require, process, filesystem and network are all ' +
      'directly available. SandLoader does not sandbox this - it is exactly as privileged as the game itself.',
    risk: 'danger',
    // Node access is the thing being described, not something bypassed by it.
    impliedByNode: false,
    warning:
      'Native mods execute with the same OS-level privileges as the game process. Only install a native/node ' +
      'mod from a source you trust completely - SandLoader cannot restrict what it does.',
  }),
  process: reserved('process', 'Process control', 'Spawn or control other OS processes.'),
  shell: reserved('shell', 'Shell execution', 'Run arbitrary shell commands.'),
  'native-ipc': reserved(
    'native-ipc', 'Native IPC',
    'Direct inter-process communication with the main process outside SMLN.callMain.'
  ),
})

/** @type {ReadonlyArray<string>} */
const KNOWN = Object.freeze(Object.keys(PERMISSIONS).sort())

/** @param {unknown} v */
function describeType(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

/** Deduplicate and sort a list of permission strings deterministically. */
function uniqueSorted(list) {
  const seen = Object.create(null)
  const out = []
  for (const v of list) {
    if (!Object.prototype.hasOwnProperty.call(seen, v)) {
      seen[v] = true
      out.push(v)
    }
  }
  out.sort()
  return out
}

/** Only the strings out of an arbitrary (possibly hostile) array-ish value. */
function stringsOnly(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []
}

/**
 * Validate `manifest.permissions`. Never throws - hostile input always comes
 * back as `{ok:false, error}`.
 *
 * Unknown names are never silently granted or silently dropped: an unknown
 * or not-yet-implemented entry fails validation outright rather than being
 * filtered out, so a mod cannot end up running with fewer restrictions than
 * its manifest asked for by accident.
 *
 * @param {unknown} raw            manifest.permissions
 * @param {{modId?:string, source?:string}} [ctx]
 * @returns {{ok:true, permissions:string[]}|{ok:false, error:SmlnError}}
 */
function validate(raw, ctx) {
  try {
    const context = ctx && typeof ctx === 'object' ? ctx : {}
    const modId = typeof context.modId === 'string' && context.modId ? context.modId : '(unknown mod)'
    const where = context.source ? ` (${context.source})` : ''
    const fail = (code, msg, detail) => ({
      ok: false,
      error: new SmlnError(code, `mod "${modId}"${where}: ${msg}`, { detail: { modId, ...detail } }),
    })

    if (raw === undefined || raw === null) return { ok: true, permissions: [] }
    if (!Array.isArray(raw)) {
      return fail('E_PERMISSION_INVALID', `"permissions" must be an array of strings, got ${describeType(raw)}`, { value: raw })
    }

    const nonStrings = raw.filter((p) => typeof p !== 'string')
    if (nonStrings.length) {
      return fail(
        'E_PERMISSION_INVALID',
        `"permissions" entries must all be strings, found ${nonStrings.map(describeType).join(', ')}`,
        { values: nonStrings }
      )
    }

    const unique = uniqueSorted(raw)

    const unknown = unique.filter((p) => !Object.prototype.hasOwnProperty.call(PERMISSIONS, p))
    if (unknown.length) {
      return fail('E_PERMISSION_UNKNOWN', `unknown permission(s): ${unknown.join(', ')}`, { permissions: unknown, reason: 'unknown' })
    }

    // Recognised but not implemented gets its own message, distinct from a
    // typo/unknown name, so the mod author knows to wait rather than fix a spelling.
    const notImplemented = unique.filter((p) => !PERMISSIONS[p].implemented)
    if (notImplemented.length) {
      return fail(
        'E_PERMISSION_UNKNOWN',
        `permission(s) recognised but not supported by this SandLoader version yet: ${notImplemented.join(', ')}`,
        { permissions: notImplemented, reason: 'not-implemented' }
      )
    }

    return { ok: true, permissions: unique }
  } catch (e) {
    return {
      ok: false,
      error: new SmlnError('E_PERMISSION_INVALID', `permissions could not be validated: ${e && e.message}`, { cause: e }),
    }
  }
}

/**
 * @typedef {Object} Capability
 * @property {Tier} tier
 * @property {string[]} permissions   Effective, sorted (includes `node` for a native mod even if undeclared).
 * @property {{node:boolean, filesystem:boolean, network:boolean}} granted
 * @property {{native:boolean, game:boolean, worker:boolean}} contexts
 * @property {string[]} reasons
 * @property {boolean} legacyNative   Runs with main-process privilege but declared no permissions asking for it.
 * @property {boolean} enforceable    False for `native` - restrictions there are advisory only.
 * @property {'SANDBOXED'|'NETWORK'|'FILESYSTEM'|'ELEVATED'|'NATIVE'} badge
 */

const SANDBOXED_FALLBACK = Object.freeze({
  tier: TIERS.SANDBOXED,
  permissions: [],
  granted: Object.freeze({ node: false, filesystem: false, network: false }),
  contexts: Object.freeze({ native: false, game: false, worker: false }),
  reasons: ['classification failed on malformed input; defaulted to sandboxed'],
  legacyNative: false,
  enforceable: true,
  badge: 'SANDBOXED',
})

/**
 * Classify a mod into a permission tier from where its code runs and what it
 * declared. This is the single place that decides `sandboxed` vs `elevated`
 * vs `native` - callers should not re-derive it.
 *
 * @param {{id?:string, version?:string, flavour?:string, permissions?:string[],
 *          entrypoints?:{native?:boolean, game?:boolean, worker?:boolean}}} info
 * @returns {Capability}
 */
function classify(info) {
  try {
    const input = info && typeof info === 'object' ? info : {}
    const permissions = uniqueSorted(stringsOnly(input.permissions))
    const ep = input.entrypoints && typeof input.entrypoints === 'object' ? input.entrypoints : {}
    const contexts = { native: !!ep.native, game: !!ep.game, worker: !!ep.worker }

    const declaresNode = permissions.includes('node')
    const declaresNetwork = permissions.includes('network')
    const declaresFilesystem = permissions.includes('filesystem')

    const reasons = []
    let tier
    let legacyNative = false

    if (contexts.native || declaresNode) {
      tier = TIERS.NATIVE
      if (contexts.native) reasons.push('declares a main-process entrypoint')
      if (declaresNode) reasons.push('declares the "node" permission')
      legacyNative = contexts.native && !declaresNode
      if (legacyNative) reasons.push('main-process code with no declared permissions (legacy)')
    } else if (declaresNetwork || declaresFilesystem) {
      tier = TIERS.ELEVATED
      if (declaresNetwork) reasons.push('declares the "network" permission')
      if (declaresFilesystem) reasons.push('declares the "filesystem" permission')
    } else {
      tier = TIERS.SANDBOXED
      reasons.push('no privileged entrypoint or permission declared')
    }

    const isNative = tier === TIERS.NATIVE
    // A native mod has real Node, so it already has filesystem/network by
    // construction - reporting those as false would be misleading, not safe.
    const granted = {
      node: isNative,
      filesystem: isNative || declaresFilesystem,
      network: isNative || declaresNetwork,
    }

    let effective = permissions.slice()
    if (isNative && !effective.includes('node')) effective.push('node')
    effective = uniqueSorted(effective)

    let badge
    if (isNative) badge = 'NATIVE'
    else if (tier === TIERS.ELEVATED) badge = declaresNetwork && declaresFilesystem ? 'ELEVATED' : declaresNetwork ? 'NETWORK' : 'FILESYSTEM'
    else badge = 'SANDBOXED'

    return {
      tier,
      permissions: effective,
      granted,
      contexts,
      reasons,
      legacyNative,
      enforceable: !isNative,
      badge,
    }
  } catch (_e) {
    return SANDBOXED_FALLBACK
  }
}

/**
 * Look up a permission's descriptor.
 * @param {string} permission
 * @returns {PermissionDescriptor|null}
 */
function describe(permission) {
  if (typeof permission !== 'string') return null
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, permission) ? PERMISSIONS[permission] : null
}

/**
 * Compare two permission sets. Removing permissions is never an escalation;
 * adding any is `escalation`, and adding `node` (or any other native-tier
 * permission) is specifically `privilegedEscalation` - the distinction a
 * re-approval prompt needs to decide how loud to be.
 * @param {string[]} oldPerms
 * @param {string[]} newPerms
 * @returns {{added:string[], removed:string[], escalation:boolean, privilegedEscalation:boolean}}
 */
function diff(oldPerms, newPerms) {
  const oldList = uniqueSorted(stringsOnly(oldPerms))
  const newList = uniqueSorted(stringsOnly(newPerms))
  const oldSet = Object.create(null)
  oldList.forEach((p) => { oldSet[p] = true })
  const newSet = Object.create(null)
  newList.forEach((p) => { newSet[p] = true })

  const added = newList.filter((p) => !oldSet[p])
  const removed = oldList.filter((p) => !newSet[p])
  const privilegedEscalation = added.some((p) => p === 'node' || (PERMISSIONS[p] && PERMISSIONS[p].tier === TIERS.NATIVE))

  return { added, removed, escalation: added.length > 0, privilegedEscalation }
}

/**
 * A stable, order-independent key identifying one approval decision: this
 * exact mod id, at this exact version, requesting this exact permission set.
 * Bumping the version or changing the permission set is a different key by
 * design, so a stale approval can never silently cover a changed mod.
 * @param {string} modId
 * @param {string} version
 * @param {string[]} permissions
 * @returns {string}
 */
function approvalKey(modId, version, permissions) {
  const id = modId === undefined || modId === null ? '' : String(modId)
  const ver = version === undefined || version === null ? '' : String(version)
  const perms = uniqueSorted(stringsOnly(permissions))
  return `${id}@${ver}#${perms.join(',')}`
}

/**
 * True when `permission` is already covered by what has been `granted`,
 * either directly or because raw Node access (which trivially bypasses
 * anything `impliedByNode`) is in the granted set.
 * @param {string} permission
 * @param {string[]} granted
 * @returns {boolean}
 */
function isImpliedBy(permission, granted) {
  if (typeof permission !== 'string') return false
  const list = stringsOnly(granted)
  if (list.includes(permission)) return true
  if (list.includes('node')) {
    const desc = PERMISSIONS[permission]
    return !!(desc && desc.impliedByNode)
  }
  return false
}

/**
 * Short human-readable summary of a {@link Capability}, e.g.
 * `'NATIVE - Node.js, filesystem, network'` or `'NETWORK - network'`.
 * @param {Capability} capability
 * @returns {string}
 */
function summarise(capability) {
  if (!capability || typeof capability !== 'object') return 'SANDBOXED'
  const badge = typeof capability.badge === 'string' ? capability.badge : 'SANDBOXED'
  if (capability.tier === TIERS.NATIVE) return `${badge} - Node.js, filesystem, network`
  const granted = capability.granted && typeof capability.granted === 'object' ? capability.granted : {}
  const parts = []
  if (granted.network) parts.push('network')
  if (granted.filesystem) parts.push('filesystem')
  return parts.length ? `${badge} - ${parts.join(', ')}` : `${badge} - no elevated capabilities`
}

module.exports = {
  PERMISSIONS,
  TIERS,
  KNOWN,
  validate,
  classify,
  describe,
  diff,
  approvalKey,
  isImpliedBy,
  summarise,
}
