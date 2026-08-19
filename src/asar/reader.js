'use strict'
/**
 * Minimal ASAR reader.
 *
 * Electron can already read inside an archive through its patched `fs`, but
 * SMLN needs to inspect archives from plain Node too - the installer and the
 * self-test both run outside Electron. This implements just the read side of
 * the format, with no dependencies.
 *
 * Layout: a Chromium Pickle holding the header size, then a Pickle holding the
 * header JSON, then the raw file data.
 *
 *   [0..3]   uint32  = 4        (payload size of the size-pickle)
 *   [4..7]   uint32  = headerPickleSize
 *   [8..11]  uint32  = header payload size
 *   [12..15] uint32  = header JSON length
 *   [16..]   header JSON
 *   [8 + headerPickleSize ..] file data
 */

const fs = require('fs')
const crypto = require('crypto')

const { SmlnError } = require('../core/errors')

/** Header JSON larger than this means we are not looking at a real archive. */
const MAX_HEADER = 64 * 1024 * 1024

/**
 * Read the archive as a plain file.
 *
 * Inside Electron this matters: the asar layer makes `app.asar` look like a
 * *directory* to fs, so opening it to parse the header fails with EISDIR.
 * `process.noAsar` turns that translation off for the duration. Outside
 * Electron the flag is simply an unused property and this is a no-op.
 */
function withRawFs(fn) {
  const previous = process.noAsar
  process.noAsar = true
  try {
    return fn()
  } finally {
    process.noAsar = previous
  }
}

class AsarArchive {
  /** @param {string} file */
  constructor(file) {
    this.path = file
    this.fd = withRawFs(() => fs.openSync(file, 'r'))
    try {
      const sizeBuf = Buffer.alloc(8)
      if (fs.readSync(this.fd, sizeBuf, 0, 8, 0) !== 8) {
        throw new SmlnError('E_ASAR_INVALID', `${file}: too small to be an asar archive`)
      }
      const headerPickleSize = sizeBuf.readUInt32LE(4)
      if (headerPickleSize <= 8 || headerPickleSize > MAX_HEADER) {
        throw new SmlnError('E_ASAR_INVALID', `${file}: implausible header size ${headerPickleSize}`)
      }
      const headerBuf = Buffer.alloc(headerPickleSize)
      fs.readSync(this.fd, headerBuf, 0, headerPickleSize, 8)
      const jsonLen = headerBuf.readUInt32LE(4)
      if (jsonLen <= 0 || jsonLen + 8 > headerPickleSize) {
        throw new SmlnError('E_ASAR_INVALID', `${file}: header JSON length ${jsonLen} out of range`)
      }
      const json = headerBuf.toString('utf8', 8, 8 + jsonLen)
      try {
        this.header = JSON.parse(json)
      } catch (e) {
        throw new SmlnError('E_ASAR_INVALID', `${file}: header is not valid JSON`, { cause: e })
      }
      if (!this.header || typeof this.header.files !== 'object') {
        throw new SmlnError('E_ASAR_INVALID', `${file}: header has no file table`)
      }
      this.baseOffset = 8 + headerPickleSize
    } catch (e) {
      try { fs.closeSync(this.fd) } catch (_) {}
      throw e
    }
  }

  /**
   * Look up an entry by archive-relative path ("dist/js/bundle.js").
   * @returns {any|null}
   */
  stat(entryPath) {
    let node = this.header
    for (const seg of String(entryPath).split(/[\\/]/).filter(Boolean)) {
      if (!node || !node.files) return null
      node = node.files[seg]
      if (!node) return null
    }
    return node || null
  }

  has(entryPath) { return this.stat(entryPath) != null }

  /**
   * Read a packed file. Entries marked `unpacked` live next to the archive in
   * `<name>.unpacked/` and are not stored inside it.
   * @returns {Buffer}
   */
  read(entryPath) {
    const node = this.stat(entryPath)
    if (!node) throw new SmlnError('E_ASAR_ENTRY_MISSING', `${entryPath} not present in ${this.path}`)
    if (node.files) throw new SmlnError('E_ASAR_ENTRY_MISSING', `${entryPath} is a directory`)
    if (node.unpacked) {
      const outside = this.path + '.unpacked'
      return withRawFs(() => fs.readFileSync(require('path').join(outside, entryPath)))
    }
    const size = Number(node.size) || 0
    const buf = Buffer.alloc(size)
    if (size > 0) {
      withRawFs(() => fs.readSync(this.fd, buf, 0, size, this.baseOffset + parseInt(node.offset, 10)))
    }
    return buf
  }

  readText(entryPath) { return this.read(entryPath).toString('utf8') }

  readJson(entryPath) {
    const text = this.readText(entryPath)
    try { return JSON.parse(text) } catch (e) {
      throw new SmlnError('E_ASAR_INVALID', `${entryPath} is not valid JSON`, { cause: e })
    }
  }

  /**
   * Flatten the file table.
   * @returns {{path:string,size:number,unpacked:boolean}[]}
   */
  list() {
    const out = []
    ;(function walk(node, prefix) {
      for (const [name, child] of Object.entries(node.files || {})) {
        const p = prefix ? `${prefix}/${name}` : name
        if (child.files) walk(child, p)
        else out.push({ path: p, size: Number(child.size) || 0, unpacked: !!child.unpacked })
      }
    })(this.header, '')
    return out
  }

  /** sha256 of a single entry - used to detect bundle drift between versions. */
  hashEntry(entryPath) {
    return crypto.createHash('sha256').update(this.read(entryPath)).digest('hex')
  }

  close() {
    try { fs.closeSync(this.fd) } catch (_) {}
    this.fd = -1
  }
}

/** @param {string} file @returns {AsarArchive} */
function open(file) {
  if (!withRawFs(() => fs.existsSync(file))) {
    throw new SmlnError('E_IO', `asar archive not found: ${file}`)
  }
  return new AsarArchive(file)
}

/** Cheap format probe that never throws. */
function looksLikeAsar(file) {
  return withRawFs(() => {
    try {
      const fd = fs.openSync(file, 'r')
      const buf = Buffer.alloc(8)
      const n = fs.readSync(fd, buf, 0, 8, 0)
      fs.closeSync(fd)
      if (n !== 8) return false
      return buf.readUInt32LE(0) === 4 && buf.readUInt32LE(4) > 8
    } catch (_) { return false }
  })
}

module.exports = { open, looksLikeAsar, AsarArchive }
