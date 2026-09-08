'use strict'
/**
 * The map editor's drawing tools, as pure functions over a pixel buffer.
 *
 * No canvas, no DOM, no dependencies - which is the whole point. Flood fill and
 * brush geometry are the two places a pixel editor quietly goes wrong (a fill
 * that leaks through a diagonal, a "1 pixel" brush that paints 2x2), and both
 * are invisible on screen until an author has already drawn with them. Keeping
 * the logic here means `tools/selftest.js` can assert on actual pixels in plain
 * Node instead of on how a screenshot looks.
 *
 * `src/renderer/mapeditor.js` owns the document, the view and the undo stack;
 * it hands one layer's ImageData in and paints the result back.
 *
 * ## The buffer
 *
 * `{ data, width, height }` where `data` is a Uint8ClampedArray or a plain
 * Array of RGBA bytes, row-major, four per pixel - exactly what ImageData is,
 * so the caller passes ImageData itself.
 *
 * ## The dirty rectangle
 *
 * Every operation returns `{x, y, w, h}` bounding EXACTLY the pixels whose
 * bytes it changed, or `null` when it changed none. The caller repaints from
 * that rectangle and records undo from it, so reporting more than was touched
 * is a correctness bug and not a rounding convenience: an over-wide rectangle
 * makes undo restore pixels the stroke never had any business owning. A pixel
 * that already held the colour being written is not a change, and does not
 * widen the rectangle.
 *
 * ## Colour
 *
 * `rgba` is `[r, g, b, a]`, 0-255. Every channel is rounded and clamped on the
 * way in, so the comparison that decides "did this pixel change?" is made
 * against the same bytes that get stored - otherwise writing 300 into a
 * Uint8ClampedArray would land as 255, never compare equal, and every stroke
 * would report changes it did not make.
 *
 * ## Alpha 0 is not air
 *
 * A fully transparent terrain pixel does not resolve to empty space: it
 * resolves to Fog, which is collidable, floods when broken, and leaves nothing
 * behind. So nothing in this file invents a colour, and `eraser` takes the
 * colour to write rather than assuming transparency - the caller passes the
 * palette's real "empty" entry. `eraser` refuses a fully transparent colour
 * outright, because writing one is the exact defect this rule exists to
 * prevent.
 */

// -------------------------------------------------------------- validation

/** True when `buf` is a pixel buffer big enough for the size it claims. */
function bufferOk(buf) {
  if (!buf || !buf.data || typeof buf.data.length !== 'number') return false
  var w = Math.floor(buf.width)
  var h = Math.floor(buf.height)
  if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return false
  return buf.data.length >= w * h * 4
}

/** A coordinate as a whole number of pixels, or null if it is not one. */
function coord(v) {
  var n = Math.floor(Number(v))
  return isFinite(n) ? n : null
}

/** One colour channel, stored exactly as a Uint8ClampedArray would store it. */
function channel(v) {
  var n = Math.round(Number(v))
  if (!isFinite(n)) return 0
  return n < 0 ? 0 : (n > 255 ? 255 : n)
}

/**
 * `rgba` as four stored bytes, or null when it is not a colour.
 *
 * A missing alpha becomes opaque rather than transparent - see "alpha 0 is not
 * air" above. There is no default for the other three: a caller with no colour
 * has nothing to draw.
 */
function ink(rgba) {
  if (!rgba || typeof rgba.length !== 'number' || rgba.length < 3) return null
  return [
    channel(rgba[0]),
    channel(rgba[1]),
    channel(rgba[2]),
    rgba.length > 3 ? channel(rgba[3]) : 255,
  ]
}

/** A brush diameter as a whole number of pixels, at least one. */
function diameter(size) {
  var n = Math.floor(Number(size))
  if (!isFinite(n) || n < 1) return 1
  return n
}

// ---------------------------------------------------------------- the rect

/**
 * The bounding box of what actually changed, grown one pixel at a time.
 *
 * Grown from writes rather than computed from the requested geometry, because
 * those are different rectangles whenever a stroke is clipped by the edge or
 * lands on pixels that already hold the colour.
 */
function Dirty() {
  this.empty = true
  this.x0 = 0
  this.y0 = 0
  this.x1 = 0
  this.y1 = 0
}
Dirty.prototype.add = function (x, y) {
  if (this.empty) {
    this.empty = false
    this.x0 = this.x1 = x
    this.y0 = this.y1 = y
    return
  }
  if (x < this.x0) this.x0 = x
  else if (x > this.x1) this.x1 = x
  if (y < this.y0) this.y0 = y
  else if (y > this.y1) this.y1 = y
}
Dirty.prototype.rect = function () {
  if (this.empty) return null
  return { x: this.x0, y: this.y0, w: this.x1 - this.x0 + 1, h: this.y1 - this.y0 + 1 }
}

// ------------------------------------------------------------------ writes

/**
 * Fill an inclusive box, clipped to the buffer, recording only real changes.
 *
 * Clipping happens here rather than at each call site, so "starts off the left
 * edge" and "ends past the bottom" are the same ordinary case everywhere.
 */
function paintBox(buf, x0, y0, x1, y1, c, dirty) {
  var w = Math.floor(buf.width)
  var h = Math.floor(buf.height)
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > w - 1) x1 = w - 1
  if (y1 > h - 1) y1 = h - 1
  if (x1 < x0 || y1 < y0) return
  var d = buf.data
  var c0 = c[0], c1 = c[1], c2 = c[2], c3 = c[3]
  for (var y = y0; y <= y1; y++) {
    var base = y * w
    for (var x = x0; x <= x1; x++) {
      var i = (base + x) * 4
      if (d[i] === c0 && d[i + 1] === c1 && d[i + 2] === c2 && d[i + 3] === c3) continue
      d[i] = c0
      d[i + 1] = c1
      d[i + 2] = c2
      d[i + 3] = c3
      dirty.add(x, y)
    }
  }
}

/**
 * One square dab of `size` pixels across, centred on (x, y).
 *
 * Size 1 is one pixel: `half` is 0, so both edges land on the centre. The
 * classic defect here is a radius that rounds up and turns the finest brush
 * into a 2x2 block, which an author only discovers after drawing a whole map
 * with it. Even sizes cannot be centred on a pixel, and lean down-right - the
 * same choice the editor's own preview makes, so what is drawn is what was
 * shown.
 */
function dab(buf, x, y, size, c, dirty) {
  var half = Math.floor((size - 1) / 2)
  paintBox(buf, x - half, y - half, x - half + size - 1, y - half + size - 1, c, dirty)
}

/** True when the dab of `size` at any point of this box could touch the buffer. */
function touches(buf, minX, minY, maxX, maxY, size) {
  var half = Math.floor((size - 1) / 2)
  var back = size - 1 - half
  return !(maxX + back < 0 || minX - half > Math.floor(buf.width) - 1 ||
           maxY + back < 0 || minY - half > Math.floor(buf.height) - 1)
}

// ------------------------------------------------------------------- tools

/** A single dab. Returns what changed, or null. */
function brush(buf, x, y, size, rgba) {
  if (!bufferOk(buf)) return null
  var c = ink(rgba)
  if (!c) return null
  var px = coord(x)
  var py = coord(y)
  if (px === null || py === null) return null
  var dirty = new Dirty()
  dab(buf, px, py, diameter(size), c, dirty)
  return dirty.rect()
}

/**
 * A dab at every point of the segment, by Bresenham.
 *
 * Bresenham rather than "step along the vector and round", because the rounded
 * form drops pixels when the two endpoints are close together and leaves a
 * dotted diagonal on a fast drag. This visits exactly one pixel per step of the
 * major axis and never skips one.
 */
function line(buf, x0, y0, x1, y1, size, rgba) {
  if (!bufferOk(buf)) return null
  var c = ink(rgba)
  if (!c) return null
  var ax = coord(x0)
  var ay = coord(y0)
  var bx = coord(x1)
  var by = coord(y1)
  if (ax === null || ay === null || bx === null || by === null) return null
  var s = diameter(size)

  // A stroke wholly outside the buffer is a no-op, and saying so before
  // walking it keeps a drag that ran off the window from costing anything.
  if (!touches(buf, Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), s)) {
    return null
  }

  var dirty = new Dirty()
  var dx = Math.abs(bx - ax)
  var sx = ax < bx ? 1 : -1
  var dy = -Math.abs(by - ay)
  var sy = ay < by ? 1 : -1
  var err = dx + dy
  for (;;) {
    dab(buf, ax, ay, s, c, dirty)
    if (ax === bx && ay === by) break
    var e2 = 2 * err
    if (e2 >= dy) { err += dy; ax += sx }
    if (e2 <= dx) { err += dx; ay += sy }
  }
  return dirty.rect()
}

/**
 * A rectangle between two corners, inclusive of both, filled or one pixel of
 * outline. The corners may arrive in any order - a drag can go up and left.
 */
function rectangle(buf, x0, y0, x1, y1, rgba, filled) {
  if (!bufferOk(buf)) return null
  var c = ink(rgba)
  if (!c) return null
  var ax = coord(x0)
  var ay = coord(y0)
  var bx = coord(x1)
  var by = coord(y1)
  if (ax === null || ay === null || bx === null || by === null) return null
  var lx = Math.min(ax, bx)
  var rx = Math.max(ax, bx)
  var ty = Math.min(ay, by)
  var by2 = Math.max(ay, by)

  var dirty = new Dirty()
  if (filled) {
    paintBox(buf, lx, ty, rx, by2, c, dirty)
  } else {
    // Four one-pixel bands. They overlap at the corners, which costs nothing:
    // the second write finds the colour already there and is not a change.
    paintBox(buf, lx, ty, rx, ty, c, dirty)
    paintBox(buf, lx, by2, rx, by2, c, dirty)
    paintBox(buf, lx, ty, lx, by2, c, dirty)
    paintBox(buf, rx, ty, rx, by2, c, dirty)
  }
  return dirty.rect()
}

/**
 * Push the start of every run of seed-coloured pixels in row `y` between `lx`
 * and `rx`. One seed per run, not one per pixel, which is what keeps the stack
 * proportional to the region's shape rather than to its area.
 */
function scanRow(d, w, lx, rx, y, s0, s1, s2, s3, stack) {
  var base = y * w
  var inRun = false
  for (var x = lx; x <= rx; x++) {
    var i = (base + x) * 4
    if (d[i] === s0 && d[i + 1] === s1 && d[i + 2] === s2 && d[i + 3] === s3) {
      if (!inRun) { stack.push(x, y); inRun = true }
    } else {
      inRun = false
    }
  }
}

/**
 * Flood fill: 4-connected, exact colour match, no tolerance.
 *
 * Scanline with an explicit stack, never recursion. A map is a few thousand
 * pixels on a side and a fill can reach all of it, so the recursive form would
 * blow the JavaScript stack on the first large region - and would do it on the
 * author's machine, mid-stroke, not here.
 *
 * 4-connected and exact are both deliberate. Diagonal connectivity would let a
 * fill escape through the corner of a one-pixel-thick wall, which in this game
 * means paint leaking through a cave boundary an author drew on purpose; a
 * tolerance would smear two neighbouring palette entries into one material.
 *
 * Filling with the colour that is already there returns null and touches
 * nothing - the run would have no stopping condition, since a filled pixel
 * would still match the seed.
 */
function fill(buf, x, y, rgba) {
  if (!bufferOk(buf)) return null
  var c = ink(rgba)
  if (!c) return null
  var px = coord(x)
  var py = coord(y)
  if (px === null || py === null) return null
  var w = Math.floor(buf.width)
  var h = Math.floor(buf.height)
  if (px < 0 || py < 0 || px >= w || py >= h) return null

  var d = buf.data
  var seed = (py * w + px) * 4
  var s0 = d[seed], s1 = d[seed + 1], s2 = d[seed + 2], s3 = d[seed + 3]
  var c0 = c[0], c1 = c[1], c2 = c[2], c3 = c[3]
  if (s0 === c0 && s1 === c1 && s2 === c2 && s3 === c3) return null

  var minX = w, minY = h, maxX = -1, maxY = -1
  var stack = [px, py]
  while (stack.length) {
    var sy = stack.pop()
    var sx = stack.pop()
    var base = sy * w
    var i = (base + sx) * 4
    // The span may have been swallowed by another one since it was queued.
    if (!(d[i] === s0 && d[i + 1] === s1 && d[i + 2] === s2 && d[i + 3] === s3)) continue

    var lx = sx
    while (lx > 0) {
      var j = (base + lx - 1) * 4
      if (d[j] === s0 && d[j + 1] === s1 && d[j + 2] === s2 && d[j + 3] === s3) lx--
      else break
    }
    var rx = sx
    while (rx < w - 1) {
      var k = (base + rx + 1) * 4
      if (d[k] === s0 && d[k + 1] === s1 && d[k + 2] === s2 && d[k + 3] === s3) rx++
      else break
    }

    for (var t = lx; t <= rx; t++) {
      var p = (base + t) * 4
      d[p] = c0
      d[p + 1] = c1
      d[p + 2] = c2
      d[p + 3] = c3
    }
    // Every pixel in the span held the seed colour and now holds a different
    // one, so the whole span is a change and the box can grow by the span.
    if (lx < minX) minX = lx
    if (rx > maxX) maxX = rx
    if (sy < minY) minY = sy
    if (sy > maxY) maxY = sy

    if (sy > 0) scanRow(d, w, lx, rx, sy - 1, s0, s1, s2, s3, stack)
    if (sy < h - 1) scanRow(d, w, lx, rx, sy + 1, s0, s1, s2, s3, stack)
  }

  if (maxX < minX) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/** The colour at (x, y) as a fresh `[r, g, b, a]`, or null outside the buffer. */
function pick(buf, x, y) {
  if (!bufferOk(buf)) return null
  var px = coord(x)
  var py = coord(y)
  if (px === null || py === null) return null
  var w = Math.floor(buf.width)
  var h = Math.floor(buf.height)
  if (px < 0 || py < 0 || px >= w || py >= h) return null
  var i = (py * w + px) * 4
  var d = buf.data
  return [d[i], d[i + 1], d[i + 2], d[i + 3]]
}

/**
 * The brush, painting whatever the caller calls empty.
 *
 * It takes the colour instead of clearing to transparent because alpha 0 is
 * not air in this game - a transparent terrain pixel resolves to Fog, which
 * collides, floods when broken and leaves no element behind. So an eraser that
 * "just clears" would quietly fill a map with the worst material in it. A
 * fully transparent colour is refused for the same reason: there is no safe
 * way to honour it, and doing nothing is the honest answer.
 */
function eraser(buf, x, y, size, rgba) {
  var c = ink(rgba)
  if (!c || c[3] === 0) return null
  return brush(buf, x, y, size, c)
}

var TOOLS = {
  brush: brush,
  line: line,
  rectangle: rectangle,
  fill: fill,
  pick: pick,
  eraser: eraser,
}

/*
 * CommonJS is the shape the tests and the main process want. The global is for
 * the renderer, where prelude.js concatenates these files into one script and
 * `module` does not exist - assigning it here means neither side has to wrap
 * this file, and both get the same object.
 */
if (typeof module !== 'undefined' && module.exports) module.exports = TOOLS
if (typeof globalThis !== 'undefined') globalThis.__SMLN_MAPEDITOR_TOOLS__ = TOOLS
