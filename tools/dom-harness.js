'use strict'
/**
 * A DOM small enough to boot the console in a plain Node VM.
 *
 * Not a browser emulation - just the handful of operations the console
 * actually performs, so the injected runtime can be exercised end to end
 * without launching Electron. Anything the console starts relying on that is
 * missing here will throw loudly, which is the point.
 *
 * It also carries a real 2D canvas, because the map editor's whole claim is
 * that a document survives being written to a PNG and read back. A stub that
 * remembered pixels without encoding them would prove nothing, so the pixels
 * genuinely go through a PNG encoder and decoder here (zlib is in Node; there
 * is no image library to add).
 */

const zlib = require('zlib')

/**
 * There is no layout engine here, so every element reports the same nominal
 * box. The map editor sizes its view from its container and hit-tests clicks
 * against it, so "zero-sized forever" would be a worse lie than a fixed size.
 */
const NOMINAL = { width: 320, height: 240 }

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** 8-bit RGBA, no interlacing, one filter type: what a canvas would produce. */
function encodePng(width, height, pixels) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    for (let i = 0; i < stride; i++) raw[y * (stride + 1) + 1 + i] = pixels[y * stride + i]
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** All five filter types, because a decoder that only reads its own encoder proves less. */
function decodePng(buf) {
  let width = 0
  let height = 0
  const parts = []
  let off = 8
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) {
        throw new Error('the harness decodes 8-bit RGBA, non-interlaced PNGs only')
      }
    } else if (type === 'IDAT') {
      parts.push(Buffer.from(data))
    } else if (type === 'IEND') break
    off += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(parts))
  const stride = width * 4
  const out = new Uint8ClampedArray(stride * height)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride))
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? line[i - 4] : 0
      const b = prev[i]
      const c = i >= 4 ? prev[i - 4] : 0
      let v = line[i]
      if (filter === 1) v = (v + a) & 255
      else if (filter === 2) v = (v + b) & 255
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
      line[i] = v
    }
    out.set(line, y * stride)
    prev = line
  }
  return { width, height, data: out }
}

function parseColour(style) {
  const s = String(style || '')
  let m = /^rgba?\(([^)]+)\)$/i.exec(s)
  if (m) {
    const p = m[1].split(',').map((v) => parseFloat(v))
    return [p[0] | 0, p[1] | 0, p[2] | 0,
      p.length > 3 ? Math.round(Math.max(0, Math.min(1, p[3])) * 255) : 255]
  }
  m = /^#([0-9a-f]{6})$/i.exec(s)
  if (m) {
    const n = parseInt(m[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]
  }
  return [0, 0, 0, 255]
}

/** Source-over, with the two exact cases spelled out so they cannot round. */
function composite(dst, di, src, si) {
  const sa = src[si + 3]
  if (sa === 0) return
  if (sa === 255 || dst[di + 3] === 0) {
    dst[di] = src[si]; dst[di + 1] = src[si + 1]
    dst[di + 2] = src[si + 2]; dst[di + 3] = sa
    return
  }
  const a = sa / 255
  const da = dst[di + 3] / 255
  const oa = a + da * (1 - a)
  for (let k = 0; k < 3; k++) {
    dst[di + k] = Math.round((src[si + k] * a + dst[di + k] * da * (1 - a)) / oa)
  }
  dst[di + 3] = Math.round(oa * 255)
}

function makeImageData(width, height, data) {
  return { width, height, data: data || new Uint8ClampedArray(width * height * 4) }
}

/**
 * The 2D context, doing for real only what the editor asks of it: rectangles,
 * pixel reads and writes, and a nearest-neighbour drawImage. Everything to do
 * with paths and strokes is decoration on a canvas nothing asserts against, so
 * those are accepted and ignored rather than faked.
 */
function makeContext(canvas) {
  const noop = () => {}
  const ctx = {
    canvas,
    imageSmoothingEnabled: true,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    save: noop, restore: noop, beginPath: noop, closePath: noop, moveTo: noop,
    lineTo: noop, stroke: noop, strokeRect: noop, fill: noop, rect: noop,
    arc: noop, setLineDash: noop, translate: noop, scale: noop, setTransform: noop,

    clearRect(x, y, w, h) {
      const d = canvas._data()
      for (let iy = Math.max(0, y | 0); iy < Math.min(d.height, (y | 0) + h); iy++) {
        for (let ix = Math.max(0, x | 0); ix < Math.min(d.width, (x | 0) + w); ix++) {
          const i = (iy * d.width + ix) * 4
          d.pixels[i] = d.pixels[i + 1] = d.pixels[i + 2] = d.pixels[i + 3] = 0
        }
      }
    },

    fillRect(x, y, w, h) {
      const d = canvas._data()
      const c = parseColour(this.fillStyle)
      for (let iy = Math.max(0, y | 0); iy < Math.min(d.height, (y | 0) + h); iy++) {
        for (let ix = Math.max(0, x | 0); ix < Math.min(d.width, (x | 0) + w); ix++) {
          const i = (iy * d.width + ix) * 4
          d.pixels[i] = c[0]; d.pixels[i + 1] = c[1]
          d.pixels[i + 2] = c[2]; d.pixels[i + 3] = c[3]
        }
      }
    },

    createImageData(w, h) { return makeImageData(w, h) },

    getImageData(x, y, w, h) {
      const d = canvas._data()
      const out = makeImageData(w, h)
      for (let iy = 0; iy < h; iy++) {
        for (let ix = 0; ix < w; ix++) {
          const sx = (x | 0) + ix
          const sy = (y | 0) + iy
          if (sx < 0 || sy < 0 || sx >= d.width || sy >= d.height) continue
          const si = (sy * d.width + sx) * 4
          const di = (iy * w + ix) * 4
          out.data[di] = d.pixels[si]; out.data[di + 1] = d.pixels[si + 1]
          out.data[di + 2] = d.pixels[si + 2]; out.data[di + 3] = d.pixels[si + 3]
        }
      }
      return out
    },

    putImageData(image, dx, dy) {
      const d = canvas._data()
      for (let iy = 0; iy < image.height; iy++) {
        for (let ix = 0; ix < image.width; ix++) {
          const tx = (dx | 0) + ix
          const ty = (dy | 0) + iy
          if (tx < 0 || ty < 0 || tx >= d.width || ty >= d.height) continue
          const si = (iy * image.width + ix) * 4
          const di = (ty * d.width + tx) * 4
          d.pixels[di] = image.data[si]; d.pixels[di + 1] = image.data[si + 1]
          d.pixels[di + 2] = image.data[si + 2]; d.pixels[di + 3] = image.data[si + 3]
        }
      }
    },

    drawImage(src) {
      const s = src && typeof src._data === 'function' ? src._data() : null
      if (!s || !s.width || !s.height) return
      const a = Array.prototype.slice.call(arguments, 1)
      let sx = 0; let sy = 0; let sw = s.width; let sh = s.height
      let dx = 0; let dy = 0; let dw = s.width; let dh = s.height
      if (a.length === 2) { dx = a[0]; dy = a[1] } else if (a.length === 4) {
        dx = a[0]; dy = a[1]; dw = a[2]; dh = a[3]
      } else if (a.length === 8) {
        sx = a[0]; sy = a[1]; sw = a[2]; sh = a[3]
        dx = a[4]; dy = a[5]; dw = a[6]; dh = a[7]
      }
      const d = canvas._data()
      const ow = Math.round(dw)
      const oh = Math.round(dh)
      const ox = Math.round(dx)
      const oy = Math.round(dy)
      for (let y = 0; y < oh; y++) {
        const ty = oy + y
        if (ty < 0 || ty >= d.height) continue
        const syy = sy + Math.floor((y * sh) / oh)
        if (syy < 0 || syy >= s.height) continue
        for (let x = 0; x < ow; x++) {
          const tx = ox + x
          if (tx < 0 || tx >= d.width) continue
          const sxx = sx + Math.floor((x * sw) / ow)
          if (sxx < 0 || sxx >= s.width) continue
          composite(d.pixels, (ty * d.width + tx) * 4, s.pixels, (syy * s.width + sxx) * 4)
        }
      }
    },
  }
  return ctx
}

/** Turn a plain element into a canvas: real pixels, real PNG in and out. */
function makeCanvas(el) {
  let width = 300
  let height = 150
  let pixels = new Uint8ClampedArray(width * height * 4)
  let ctx = null

  function resize(w, h) {
    width = Math.max(0, w | 0)
    height = Math.max(0, h | 0)
    // A real canvas clears when either dimension is assigned, even to the
    // same value; the editor relies on that not being a surprise.
    pixels = new Uint8ClampedArray(width * height * 4)
  }

  Object.defineProperty(el, 'width', {
    get() { return width }, set(v) { resize(v, height) }, configurable: true,
  })
  Object.defineProperty(el, 'height', {
    get() { return height }, set(v) { resize(width, v) }, configurable: true,
  })
  el._data = () => ({ width, height, pixels })
  el.getContext = () => { if (!ctx) ctx = makeContext(el); return ctx }
  el.toDataURL = () => 'data:image/png;base64,' + encodePng(width, height, pixels).toString('base64')
  return el
}

/**
 * `new Image()`, decoding a data URL the way the game's own loader does.
 *
 * onload fires on a later turn, as a browser's would, so code that assigns
 * `src` before `onload` is not accidentally proven to work.
 */
function makeImageClass() {
  return class HarnessImage {
    constructor() {
      this.onload = null
      this.onerror = null
      this.width = 0
      this.height = 0
      this._pixels = new Uint8ClampedArray(0)
      this._src = ''
    }

    _data() { return { width: this.width, height: this.height, pixels: this._pixels } }

    get naturalWidth() { return this.width }
    get naturalHeight() { return this.height }

    get src() { return this._src }
    set src(value) {
      this._src = String(value || '')
      let decoded = null
      let error = null
      try {
        const head = 'data:image/png;base64,'
        if (this._src.slice(0, head.length) !== head) throw new Error('not a PNG data URL')
        decoded = decodePng(Buffer.from(this._src.slice(head.length), 'base64'))
      } catch (e) { error = e }
      setTimeout(() => {
        if (error) { if (this.onerror) this.onerror(error); return }
        this.width = decoded.width
        this.height = decoded.height
        this._pixels = decoded.data
        if (this.onload) this.onload()
      }, 0)
    }
  }
}

function makeElement(tag, doc) {
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    id: '',
    className: '',
    textContent: '',
    _html: '',
    style: {},
    dataset: {},
    childNodes: [],
    parentNode: null,
    scrollTop: 0,
    scrollHeight: 0,
    value: '',
    selectionStart: 0,
    _listeners: Object.create(null),

    // The console builds its tree with createElement, so innerHTML only ever
    // needs to support clearing.
    get innerHTML() { return this._html },
    set innerHTML(v) { this._html = String(v); if (!v) this.childNodes = [] },

    attributes: {},
    setAttribute(k, v) { this.attributes[k] = String(v) },
    getAttribute(k) { return this.attributes[k] },

    appendChild(child) {
      child.parentNode = this
      this.childNodes.push(child)
      this.scrollHeight = this.childNodes.length * 20
      return child
    },
    removeChild(child) {
      const i = this.childNodes.indexOf(child)
      if (i >= 0) this.childNodes.splice(i, 1)
      return child
    },
    get firstChild() { return this.childNodes[0] || null },

    addEventListener(type, fn) { (this._listeners[type] || (this._listeners[type] = [])).push(fn) },
    removeEventListener(type, fn) {
      const a = this._listeners[type] || []
      const i = a.indexOf(fn)
      if (i >= 0) a.splice(i, 1)
    },
    dispatch(type, ev) {
      for (const fn of this._listeners[type] || []) fn(ev)
    },

    setSelectionRange(a) { this.selectionStart = a },
    focus() { doc.activeElement = this },
    blur() { if (doc.activeElement === this) doc.activeElement = null },
    scrollIntoView() {},

    classList: {
      _set: new Set(),
      add(c) { this._set.add(c) },
      remove(c) { this._set.delete(c) },
      toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c) },
      contains(c) { return this._set.has(c) },
    },

    querySelector(sel) { return doc._find(this, sel) },
    closest() { return null },
  }
  el.classList = { ...el.classList, _set: new Set() }
  el.classList.add = function (c) { this._set.add(c) }
  el.classList.remove = function (c) { this._set.delete(c) }
  el.classList.toggle = function (c, on) { if (on) this._set.add(c); else this._set.delete(c) }
  el.classList.contains = function (c) { return this._set.has(c) }

  // No layout engine, one nominal box - see NOMINAL. Every element sits at the
  // origin, which is what makes a click at (x, y) mean (x, y) in the test.
  el.clientWidth = NOMINAL.width
  el.clientHeight = NOMINAL.height
  el.getBoundingClientRect = function () {
    return {
      left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight,
      width: this.clientWidth, height: this.clientHeight, x: 0, y: 0,
    }
  }

  if (el.tagName === 'CANVAS') makeCanvas(el)
  return el
}

function createDom() {
  const doc = {
    readyState: 'complete',
    activeElement: null,
    _all: [],
    createElement(tag) {
      const el = makeElement(tag, doc)
      doc._all.push(el)
      return el
    },
    addEventListener() {},
    _find(root, sel) {
      // Only #id and .class are used by the console.
      const walk = (node, out) => {
        for (const c of node.childNodes || []) { out.push(c); walk(c, out) }
        return out
      }
      const pool = walk(root, []).concat(doc._all)
      if (sel.startsWith('#')) return pool.find((e) => e.id === sel.slice(1)) || null
      if (sel.startsWith('.')) return pool.find((e) => (e.className || '').split(/\s+/).includes(sel.slice(1))) || null
      return null
    },
  }
  doc.head = makeElement('head', doc)
  doc.body = makeElement('body', doc)
  doc.querySelector = (sel) => doc._find(doc.body, sel)
  doc.getElementById = (id) => doc._all.find((e) => e.id === id) || null

  const win = {
    _listeners: Object.create(null),
    addEventListener(type, fn) { (win._listeners[type] || (win._listeners[type] = [])).push(fn) },
    removeEventListener() {},
    /** Deliver a keydown the way a browser would: capture listeners on window. */
    key(init) {
      const ev = {
        type: 'keydown',
        key: init.key || '',
        code: init.code || '',
        ctrlKey: !!init.ctrlKey,
        altKey: !!init.altKey,
        shiftKey: !!init.shiftKey,
        target: init.target || null,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() { this.defaultPrevented = true },
        stopPropagation() { this.propagationStopped = true },
      }
      for (const fn of win._listeners.keydown || []) fn(ev)
      return ev
    },
    /** Anything else a listener was registered for on window - mouseup, resize. */
    emit(type, init) {
      const ev = Object.assign({ type, preventDefault() {}, stopPropagation() {} }, init || {})
      for (const fn of win._listeners[type] || []) fn(ev)
      return ev
    },
  }

  return { document: doc, window: win, Image: makeImageClass() }
}

/** A mouse event shaped like the ones the editor reads off a canvas. */
function mouseEvent(type, init) {
  return Object.assign({
    type,
    button: 0,
    clientX: 0,
    clientY: 0,
    shiftKey: false,
    deltaY: 0,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() {},
  }, init || {})
}

module.exports = {
  createDom, makeElement, mouseEvent,
  encodePng, decodePng, NOMINAL,
}
