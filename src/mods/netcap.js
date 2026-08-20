'use strict'
/**
 * Per-mod restricted network access, running in the main process.
 *
 * This is the scoped alternative to a mod reaching for Node's `http`/`https`
 * or the global `fetch` directly. It is enforced only for code that calls
 * through this API: a "native" tier mod (an SMLN `main` entrypoint or a
 * Fluxloader `electronEntrypoint`, see RESEARCH.md section 1) already has
 * real Node in the main process and can open a socket however it likes -
 * this module does not pretend to stop that, it only gives such a mod (and
 * every sandboxed mod, which has no other way to reach the network at all) a
 * safer default path that is worth using.
 *
 * Unlike storage, network access is gated behind the "network" permission for
 * every mod, no exceptions: an ordinary gameplay mod has no business phoning
 * home, and a mod that legitimately needs it should say so in its manifest.
 *
 * The important design point is the redirect handling: `fetch(url, {redirect:
 * 'follow'})` would happily follow a 302 from an allowed public host straight
 * to `127.0.0.1` without this module ever seeing the private address, so
 * every request is issued with `redirect:'manual'` and each hop is re-checked
 * against the same policy as the original URL before it is followed.
 */

const { SmlnError, toSmlnError } = require('../core/errors')

/**
 * The capability object produced by `src/mods/permissions.js` (`classify`).
 * Taken as a plain input here - this module never requires permissions.js.
 * See the matching typedef in storage.js for the full shape; only
 * `granted.network` is consulted here.
 *
 * @typedef {Object} ModCapability
 * @property {'sandboxed'|'native'|string} tier
 * @property {string[]} [permissions]
 * @property {{node:boolean, filesystem:boolean, network:boolean}} granted
 * @property {boolean} [enforceable]
 */

/**
 * @typedef {Object} NetPolicy
 * @property {string[]} allowedProtocols
 * @property {boolean} allowPrivateHosts
 * @property {number} maxRedirects
 * @property {number} timeoutMs
 * @property {number} maxBytes
 * @property {string[]} allowedMethods
 */

/** @type {NetPolicy} */
const DEFAULT_POLICY = Object.freeze({
  allowedProtocols: ['http:', 'https:'],
  allowPrivateHosts: false,
  maxRedirects: 5,
  timeoutMs: 15000,
  maxBytes: 8 * 1024 * 1024,
  allowedMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
})

const NOOP_LOGGER = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
  child() { return NOOP_LOGGER },
}

// Headers a caller must never set directly - either meaningless on a fetch
// this module drives itself (Host, Content-Length) or a spoofing vector
// (Origin, Cookie) an ordinary mod has no business setting.
const FORBIDDEN_REQUEST_HEADERS = new Set(['host', 'origin', 'referer', 'cookie', 'set-cookie', 'content-length'])
// Meaningful only on the wire between two specific hops, never something a
// caller should be forwarding through us.
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

function isIPv4Literal(host) {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

function isPrivateIPv4(host) {
  const octets = host.split('.').map(Number)
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = octets
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 10) return true // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  if (a === 0) return true // 0.0.0.0/8
  return false
}

/** Loopback / private / link-local, covering both IPv4 and IPv6 forms. */
function isPrivateHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (isIPv4Literal(host)) return isPrivateIPv4(host)
  if (host === '::1' || host === '0:0:0:0:0:0:0:1' || host === '::') return true
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true // fe80::/10 link-local
  const v4mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
  if (v4mapped) return isPrivateIPv4(v4mapped[1])
  return false
}

/**
 * Pure policy check against a URL - no I/O. Used both for the initial
 * request and for every redirect hop, so a public URL cannot 302 its way to
 * a private address.
 *
 * @param {string|URL} url
 * @param {NetPolicy} policy
 * @returns {{ok:true,url:URL}|{ok:false,reason:string}}
 */
function isAllowedUrl(url, policy) {
  const pol = policy || DEFAULT_POLICY
  let parsed
  try {
    parsed = url instanceof URL ? url : new URL(String(url))
  } catch (_) {
    return { ok: false, reason: 'not a valid URL' }
  }
  const allowedProtocols = pol.allowedProtocols || DEFAULT_POLICY.allowedProtocols
  if (!allowedProtocols.includes(parsed.protocol)) {
    return { ok: false, reason: `protocol "${parsed.protocol}" is not allowed - only ${allowedProtocols.join(', ')}` }
  }
  if (!pol.allowPrivateHosts && isPrivateHost(parsed.hostname)) {
    return { ok: false, reason: `"${parsed.hostname}" is a loopback, private or link-local address and is blocked by default` }
  }
  return { ok: true, url: parsed }
}

function sanitiseHeaders(initHeaders) {
  const out = new Headers()
  if (!initHeaders) return out
  const entries = initHeaders instanceof Headers
    ? Array.from(initHeaders.entries())
    : Array.isArray(initHeaders)
      ? initHeaders
      : Object.entries(initHeaders)
  for (const [rawKey, value] of entries) {
    const key = String(rawKey).toLowerCase()
    if (FORBIDDEN_REQUEST_HEADERS.has(key) || HOP_BY_HOP_HEADERS.has(key)) continue
    out.set(rawKey, String(value))
  }
  return out
}

function headersToObject(headers) {
  const out = {}
  for (const [k, v] of headers.entries()) out[k] = v
  return out
}

/** Read a response body up to `maxBytes`, aborting the stream if it is exceeded. */
async function readBodyCapped(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.byteLength > maxBytes) {
      return { ok: false, error: new SmlnError('E_IO', `response exceeded the ${maxBytes} byte cap`) }
    }
    return { ok: true, buffer: buf }
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      try { await reader.cancel() } catch (_) { /* best effort */ }
      return { ok: false, error: new SmlnError('E_IO', `response exceeded the ${maxBytes} byte cap while streaming`) }
    }
    chunks.push(Buffer.from(value))
  }
  return { ok: true, buffer: Buffer.concat(chunks) }
}

/**
 * @param {{modId:string, capability?:ModCapability, logger?:any, policy?:Partial<NetPolicy>}} opts
 */
function createNetwork(opts) {
  const o = opts || {}
  const modId = o.modId
  const log = o.logger || NOOP_LOGGER
  const pol = Object.assign({}, DEFAULT_POLICY, o.policy || {})
  const granted = !!(o.capability && o.capability.granted && o.capability.granted.network)

  function denied(url) {
    const err = new SmlnError('E_PERMISSION_DENIED',
      `mod "${modId}" has no "network" permission - declare "network" in its manifest to use SMLN.net`,
      { detail: { modId, url: url == null ? undefined : String(url) } })
    log.warn(`${modId}: network request denied - no "network" permission`)
    return Promise.resolve({ ok: false, error: err })
  }

  /** @returns {Promise<{ok:true,response:{status:number,statusText:string,headers:Record<string,string>,body:Buffer}}|{ok:false,error:SmlnError}>} */
  async function doFetch(rawUrl, init) {
    if (!granted) return denied(rawUrl)

    let requestUrl
    try {
      requestUrl = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl))
    } catch (_) {
      return { ok: false, error: new SmlnError('E_IO', 'not a valid URL', { detail: { modId, url: String(rawUrl) } }) }
    }

    const method = String((init && init.method) || 'GET').toUpperCase()
    const allowedMethods = pol.allowedMethods || DEFAULT_POLICY.allowedMethods
    if (!allowedMethods.includes(method)) {
      return { ok: false, error: new SmlnError('E_IO', `method "${method}" is not allowed`, { detail: { modId, method } }) }
    }

    const originalUrl = requestUrl
    const headers = sanitiseHeaders(init && init.headers)
    const body = (method === 'GET' || method === 'HEAD') ? undefined : (init && init.body)
    let signal
    try {
      signal = AbortSignal.timeout(pol.timeoutMs || DEFAULT_POLICY.timeoutMs)
    } catch (_) {
      signal = undefined
    }

    let current = requestUrl
    let response
    let hops = 0
    try {
      for (;;) {
        const check = isAllowedUrl(current, pol)
        if (!check.ok) {
          log.warn(`${modId}: denied ${current} - ${check.reason}`)
          return {
            ok: false,
            error: new SmlnError('E_PERMISSION_DENIED', `request to "${current}" blocked: ${check.reason}`,
              { detail: { modId, url: String(current), reason: check.reason } }),
          }
        }
        // Manual redirects: a public URL must not be able to 302 its way to
        // a private address without this loop re-checking the new target.
        response = await fetch(check.url, { method, headers, body, redirect: 'manual', signal })
        const isRedirect = response.status >= 300 && response.status < 400 && response.headers.has('location')
        if (!isRedirect) break
        hops += 1
        if (hops > (pol.maxRedirects != null ? pol.maxRedirects : DEFAULT_POLICY.maxRedirects)) {
          return {
            ok: false,
            error: new SmlnError('E_IO', `more than ${pol.maxRedirects} redirect(s) following "${originalUrl}"`,
              { detail: { modId, url: String(originalUrl) } }),
          }
        }
        current = new URL(response.headers.get('location'), current)
      }
    } catch (e) {
      const err = toSmlnError(e, `fetch(${modId})`)
      log.warn(`${modId}: request to ${originalUrl} failed - ${err.message}`)
      return { ok: false, error: err }
    }

    const bodyResult = await readBodyCapped(response, pol.maxBytes || DEFAULT_POLICY.maxBytes)
    if (!bodyResult.ok) {
      log.warn(`${modId}: response for ${originalUrl} exceeded the size cap`)
      return bodyResult
    }

    log.debug(`${modId} ${method} ${originalUrl.protocol}//${originalUrl.host}${originalUrl.pathname} -> ${response.status}`)
    return {
      ok: true,
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: headersToObject(response.headers),
        body: bodyResult.buffer,
      },
    }
  }

  async function doJson(url, init) {
    const r = await doFetch(url, init)
    if (!r.ok) return r
    try {
      return { ok: true, value: JSON.parse(r.response.body.toString('utf8')) }
    } catch (e) {
      return { ok: false, error: new SmlnError('E_IO', `response body is not valid JSON: ${e.message}`, { detail: { modId } }) }
    }
  }

  async function doText(url, init) {
    const r = await doFetch(url, init)
    if (!r.ok) return r
    return { ok: true, value: r.response.body.toString('utf8') }
  }

  return { fetch: doFetch, json: doJson, text: doText }
}

module.exports = { createNetwork, isAllowedUrl, DEFAULT_POLICY }
