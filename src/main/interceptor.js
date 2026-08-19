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
 * @param {any} opts.logger
 */
function install(opts) {
  const { protocol, distDir, patchesByFile, logger } = opts
  const preludeFor = opts.preludeFor || (() => null)

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
      const result = apply(original, patches, { logger })
      stats.outcomes[rel] = result.outcomes
      if (!result.ok) {
        stats.failures++
        logger.error(`patching ${rel} failed - serving it unmodified so the game still boots`)
        for (const o of result.outcomes) {
          if (o.status === 'failed') logger.error(`  ${o.id}: ${o.reason}`)
        }
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
  logger.info(`file interceptor active (dist: ${distDir}; targets: ${targets.join(', ') || 'prelude only'})`)
  return {
    ok: true,
    stats: () => stats,
    invalidate() { cache.clear() },
  }
}

module.exports = { install, urlToPath, mimeFor }
