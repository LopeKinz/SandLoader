'use strict'
/**
 * Serves the game's own files, patching them on the way past.
 *
 * Sandustry loads its UI with `mainWindow.loadFile(dist/index.html)`, so every
 * asset - the renderer bundle and both worker bundles included - arrives as a
 * `file://` request. Taking over that protocol lets SMLN rewrite them in
 * memory, which means:
 *
 *   - the installed game files are never touched,
 *   - Steam file validation stays green,
 *   - a game update cannot leave a stale patched bundle behind.
 *
 * The host has a similar interceptor of its own, but it is commented out in
 * 0.5.4 and its path maths is wrong for packaged builds anyway (it resolves the
 * game directory as `<resources>/dist` while the files actually live at
 * `<resources>/app.asar/dist`). We compute paths from the real dist location
 * and never rely on the host's version.
 */

const fs = require('fs')
const path = require('path')

const { apply } = require('../patch/engine')
const conflicts = require('../patch/conflicts')

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.glsl': 'text/plain', '.txt': 'text/plain',
}

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

/**
 * Turn a file:// URL into an absolute OS path.
 * Windows arrives as `/C:/...`; the leading slash has to go.
 */
function urlToPath(rawUrl) {
  const url = new URL(rawUrl)
  let p = decodeURIComponent(url.pathname)
  if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1)
  return path.normalize(p)
}

/**
 * @param {Object} opts
 * @param {import('electron').Protocol} opts.protocol
 * @param {string} opts.distDir  Absolute path of the game's dist/ directory.
 * @param {Record<string, import('../patch/engine').Patch[]>} opts.patchesByFile
 *        Keys are dist-relative posix paths, e.g. "js/bundle.js".
 * @param {(rel:string) => string|null} [opts.preludeFor]
 *        Text to prepend to a given file, if any.
 * @param {Record<string,string>} [opts.modAssets]
 *        modId -> absolute mod directory. Serves a mod's own files under the
 *        virtual `smln-mods/<modId>/...` path so `SMLN.assets.url()` resolves
 *        through the interceptor that is already here, instead of standing up
 *        a second server just to hand a sprite to the page.
 * @param {(problem:{error:any, scope:string, modId?:string}) => void} [opts.onProblem]
 * @param {any} opts.logger
 */
function install(opts) {
  const { protocol, distDir, patchesByFile, logger } = opts
  const preludeFor = opts.preludeFor || (() => null)
  /** dist-relative path -> absolute replacement file, from mod overrides. */
  const redirects = opts.redirects || {}
  /** modId -> absolute mod directory, for the virtual asset path. */
  const modAssets = opts.modAssets || {}
  const onProblem = opts.onProblem || (() => {})
  const ASSET_PREFIX = 'smln-mods/'

  const stats = { requests: 0, served: {}, failures: 0, outcomes: {} }
  /** @type {Map<string,string>} rel -> transformed source */
  const cache = new Map()

  /** dist-relative posix path, or null if the request is outside dist. */
  function relativeOf(filePath) {
    const rel = path.relative(distDir, filePath)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
    return rel.split(path.sep).join('/')
  }

  function transform(rel, filePath) {
    if (cache.has(rel)) return cache.get(rel)

    const original = fs.readFileSync(filePath, 'utf8')
    const patches = patchesByFile[rel] || []
    let body = original

    if (patches.length) {
      // Preflight before anything is rewritten. Two mods editing overlapping
      // source is a conflict nobody can debug after the fact - the resulting
      // bundle fails at runtime naming neither mod. See src/patch/conflicts.js.
      const pre = conflicts.preflight(original, patches, { target: rel })
      if (pre.report.conflicts.length) logger.warn(conflicts.formatReport(pre.report))
      if (!pre.ok) {
        stats.failures++
        stats.outcomes[rel] = (pre.report.conflicts || []).map((c) => ({
          id: `${c.a.id} x ${c.b.id}`, status: 'failed', matches: 0,
          reason: `overlaps ${c.b.owner}:${c.b.id} at ${c.overlap.start}..${c.overlap.end}`,
        }))
        logger.error(`${rel}: ${String(pre.error)} - serving it unmodified so the game still boots`)
        onProblem({ error: pre.error, scope: 'patch' })
        cache.set(rel, original)
        return original
      }

      const result = apply(original, patches, { logger })
      stats.outcomes[rel] = result.outcomes
      if (!result.ok) {
        stats.failures++
        logger.error(`patching ${rel} failed - serving it unmodified so the game still boots`)
        for (const o of result.outcomes) {
          if (o.status === 'failed') logger.error(`  ${o.id}: ${o.reason}`)
        }
        onProblem({ error: result.error, scope: 'patch' })
        // Deliberate: a broken loader must not become a broken game.
        cache.set(rel, original)
        return original
      }
      body = result.source
      const applied = result.outcomes.filter((o) => o.status === 'applied').length
      logger.info(`${rel}: ${applied}/${patches.length} patch(es) applied`)
    }

    const head = preludeFor(rel)
    if (head) body = head + '\n' + body

    if (body !== original) {
      stats.served[rel] = (stats.served[rel] || 0) + 1
      logger.info(`${rel}: serving transformed (${body.length - original.length >= 0 ? '+' : ''}${body.length - original.length} chars)`)
    }
    cache.set(rel, body)
    return body
  }

  try {
    protocol.handle('file', async (request) => {
      stats.requests++
      let filePath
      try {
        filePath = urlToPath(request.url)
      } catch (_) {
        return new Response('Bad request', { status: 400 })
      }

      const rel = relativeOf(filePath)

      // A mod's own assets, under a virtual path inside dist so the page can
      // reach them with an ordinary relative URL. Containment is re-checked
      // here rather than trusted from the URL: the request comes from the
      // page, and a mod could have built the string by hand.
      if (rel && rel.startsWith(ASSET_PREFIX)) {
        const rest = rel.slice(ASSET_PREFIX.length)
        const slash = rest.indexOf('/')
        const modId = slash < 0 ? rest : rest.slice(0, slash)
        const wanted = slash < 0 ? '' : rest.slice(slash + 1)
        const root = modAssets[modId]
        if (!root || !wanted) return new Response('Not found', { status: 404 })
        const abs = path.resolve(root, wanted)
        if (abs !== path.resolve(root) && !abs.startsWith(path.resolve(root) + path.sep)) {
          logger.warn(`refused an asset request escaping ${modId}: ${wanted}`)
          return new Response('Forbidden', { status: 403 })
        }
        try {
          return new Response(fs.readFileSync(abs), { headers: { 'Content-Type': mimeFor(abs) } })
        } catch (e) {
          if (e && e.code === 'ENOENT') return new Response('Not found', { status: 404 })
          logger.warn(`asset read failed for ${modId}/${wanted}: ${e && e.message}`)
          return new Response('Read error', { status: 500 })
        }
      }

      // Config and texture overrides: serve the mod's file in place of the
      // game's. Doing it here means overrides work on any build, without the
      // game needing to know about them.
      if (rel && redirects[rel]) {
        try {
          const body = fs.readFileSync(redirects[rel])
          stats.served[rel] = (stats.served[rel] || 0) + 1
          return new Response(body, { headers: { 'Content-Type': mimeFor(redirects[rel]) } })
        } catch (e) {
          logger.error(`override for ${rel} unreadable, serving the original: ${e && e.message}`)
        }
      }

      const wanted = rel && ((patchesByFile[rel] && patchesByFile[rel].length) || preludeFor(rel))

      if (wanted) {
        try {
          return new Response(transform(rel, filePath), {
            headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
          })
        } catch (e) {
          stats.failures++
          logger.error(`failed to serve transformed ${rel}: ${e && e.message}`)
          // fall through to the untouched file
        }
      }

      try {
        return new Response(fs.readFileSync(filePath), {
          headers: { 'Content-Type': mimeFor(filePath) },
        })
      } catch (e) {
        if (e && e.code === 'ENOENT') return new Response('Not found', { status: 404 })
        logger.warn(`read failed for ${filePath}: ${e && e.message}`)
        return new Response('Read error', { status: 500 })
      }
    })
  } catch (e) {
    logger.error('could not take over the file protocol: ' + (e && e.message))
    return { ok: false, error: e, stats: () => stats }
  }

  const targets = Object.keys(patchesByFile).filter((k) => patchesByFile[k].length)
  const overrideCount = Object.keys(redirects).length
  logger.info(
    `file interceptor active (dist: ${distDir}; targets: ${targets.join(', ') || 'prelude only'}` +
    (overrideCount ? `; ${overrideCount} override(s)` : '') + ')'
  )
  return {
    ok: true,
    stats: () => stats,
    invalidate() { cache.clear() },
  }
}

module.exports = { install, urlToPath, mimeFor }
