'use strict'
/**
 * Minimal ZIP reader.
 *
 * Node ships deflate but no archive reader, and SMLN takes no dependencies, so
 * this implements the read side of the format directly. Only what mod archives
 * actually use: stored and deflated entries, read via the central directory.
 *
 * Security is the point of most of this file. An archive is untrusted input:
 * entry names are attacker-controlled, and the classic "zip slip" attack uses
 * `../` or absolute paths to write outside the target directory. Every path is
 * therefore normalised and re-checked against the destination before a single
 * byte is written.
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const { SmlnError } = require('../core/errors')

const EOCD_SIG = 0x06054b50
const CDIR_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/** Refuse absurd archives rather than exhausting memory on them. */
const MAX_ENTRIES = 5000
const MAX_TOTAL_BYTES = 512 * 1024 * 1024

/**
 * @typedef {Object} ZipEntry
 * @property {string} name          Archive-relative path, forward slashes.
 * @property {number} size          Uncompressed size.
 * @property {number} method        0 = stored, 8 = deflate.
 * @property {number} headerOffset
 * @property {boolean} directory
 */

/** Locate the end-of-central-directory record by scanning backwards. */
function findEocd(buf) {
  // The record is 22 bytes plus an optional comment of up to 64 KiB.
  const min = 22
  const start = Math.max(0, buf.length - (min + 0xffff))
  for (let i = buf.length - min; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

/**
 * Read the entry table.
 * @param {Buffer} buf
 * @returns {ZipEntry[]}
 */
function readEntries(buf) {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new SmlnError('E_IO', 'not a ZIP archive (no end-of-central-directory record)')

  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  if (count > MAX_ENTRIES) {
    throw new SmlnError('E_IO', `archive has ${count} entries, refusing (limit ${MAX_ENTRIES})`)
  }

  const entries = []
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CDIR_SIG) {
      throw new SmlnError('E_IO', `central directory entry ${i} is malformed`)
    }
    const method = buf.readUInt16LE(offset + 10)
    const size = buf.readUInt32LE(offset + 24)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const headerOffset = buf.readUInt32LE(offset + 42)
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen)

    entries.push({
      name: name.replace(/\\/g, '/'),
      size,
      method,
      headerOffset,
      directory: name.endsWith('/'),
    })
    offset += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Decompress one entry. */
function readEntry(buf, entry) {
  const off = entry.headerOffset
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== LOCAL_SIG) {
    throw new SmlnError('E_IO', `local header for "${entry.name}" is malformed`)
  }
  const nameLen = buf.readUInt16LE(off + 26)
  const extraLen = buf.readUInt16LE(off + 28)
  const start = off + 30 + nameLen + extraLen

  // Compressed size can be zero in the local header when a data descriptor is
  // used, so take the authoritative value from the central directory instead.
  const compressedSize = buf.readUInt32LE(off + 18) || centralCompressedSize(buf, entry)
  const raw = buf.subarray(start, start + compressedSize)

  if (entry.method === 0) return Buffer.from(raw)
  if (entry.method === 8) {
    try {
      return zlib.inflateRawSync(raw)
    } catch (e) {
      throw new SmlnError('E_IO', `"${entry.name}" could not be decompressed: ${e.message}`)
    }
  }
  throw new SmlnError('E_IO', `"${entry.name}" uses unsupported compression method ${entry.method}`)
}

function centralCompressedSize(buf, entry) {
  // Re-walk the directory only in the rare data-descriptor case.
  for (const e of readEntries(buf)) {
    if (e.name === entry.name) {
      const eocd = findEocd(buf)
      let offset = buf.readUInt32LE(eocd + 16)
      const count = buf.readUInt16LE(eocd + 10)
      for (let i = 0; i < count; i++) {
        const nameLen = buf.readUInt16LE(offset + 28)
        const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen).replace(/\\/g, '/')
        if (name === entry.name) return buf.readUInt32LE(offset + 20)
        offset += 46 + nameLen + buf.readUInt16LE(offset + 30) + buf.readUInt16LE(offset + 32)
      }
    }
  }
  return 0
}

/**
 * Reject anything that would escape the destination directory.
 * @returns {string|null} safe absolute path, or null if the entry must be skipped
 */
function safeJoin(destRoot, entryName) {
  const cleaned = entryName.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || cleaned.includes('\0')) return null
  // Absolute or drive-qualified names never belong in an archive.
  if (path.isAbsolute(cleaned) || /^[A-Za-z]:/.test(cleaned)) return null

  const target = path.resolve(destRoot, cleaned)
  const root = path.resolve(destRoot)
  if (target !== root && !target.startsWith(root + path.sep)) return null
  return target
}

/**
 * Extract an archive into `destDir`.
 *
 * If every entry sits under a single top-level folder, that folder is stripped -
 * so both `mod.zip/(files)` and `mod.zip/my-mod/(files)` land correctly.
 *
 * @param {string} zipPath
 * @param {string} destDir
 * @returns {{files:number, skipped:string[], bytes:number}}
 */
function extract(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath)
  const entries = readEntries(buf)
  const files = entries.filter((e) => !e.directory)
  if (!files.length) throw new SmlnError('E_IO', 'archive contains no files')

  const total = files.reduce((n, e) => n + e.size, 0)
  if (total > MAX_TOTAL_BYTES) {
    throw new SmlnError('E_IO', `archive expands to ${Math.round(total / 1048576)} MiB, refusing`)
  }

  // Strip a single common top-level directory, if there is one.
  const tops = new Set(files.map((e) => e.name.split('/')[0]))
  const strip = tops.size === 1 && files.every((e) => e.name.includes('/')) ? [...tops][0] + '/' : ''

  const skipped = []
  let written = 0
  let bytes = 0

  for (const entry of files) {
    const relative = strip && entry.name.startsWith(strip) ? entry.name.slice(strip.length) : entry.name
    const target = safeJoin(destDir, relative)
    if (!target) { skipped.push(entry.name); continue }

    const data = readEntry(buf, entry)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data)
    written++
    bytes += data.length
  }

  return { files: written, skipped, bytes }
}

/** Read a single named entry without extracting anything. */
function readFile(zipPath, entryName) {
  const buf = fs.readFileSync(zipPath)
  const wanted = entryName.replace(/\\/g, '/')
  for (const entry of readEntries(buf)) {
    if (entry.directory) continue
    const tail = entry.name.split('/').slice(-1)[0]
    if (entry.name === wanted || tail === wanted) return readEntry(buf, entry)
  }
  return null
}

module.exports = { extract, readEntries, readEntry, readFile, safeJoin }
