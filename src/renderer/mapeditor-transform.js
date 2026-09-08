'use strict'
/**
 * Pure, DOM-free canvas transform operations for the map editor's document.
 *
 * The document (src/renderer/mapeditor.js) holds a map as six pixel layers -
 * terrain, lights, lightsMeta, sensors, authorization, wall - that must stay
 * exactly the same size as each other: the game allocates its grids at world
 * size but fills them using the source image's own width as stride, so a size
 * mismatch between layers corrupts the world silently. Resizing, cropping,
 * mirroring and shifting a document therefore has to run the same operation
 * on all six layers with the same arguments, which is much easier to get
 * right - and to test - as plain functions with no canvas, no context and no
 * DOM at all. This module is that: it never touches `document` or
 * `CanvasRenderingContext2D`, so it runs anywhere a buffer can be handed to
 * it, including plain Node in tools/selftest.js.
 *
 * A buffer is `{ data, width, height }` - RGBA, 4 bytes per pixel, row-major,
 * exactly the shape ImageData has (`data` may be a Uint8ClampedArray, as
 * ImageData gives, or a plain Array, which is all a hand-built test buffer
 * needs). Every function below returns a NEW buffer and never mutates the
 * one it was given - the caller is very often about to do the same operation
 * to five other layers from the same original pixels, and a function that
 * mutated its input would make that impossible to reason about.
 *
 * fillRgba is never defaulted. In this game a fully transparent terrain pixel
 * resolves to Fog, not air (see
 * docs/superpowers/specs/2026-09-08-map-editor-design.md), so guessing a fill
 * colour is exactly the kind of silent-corruption bug this module exists to
 * keep out. `resize` and `shift` can expose new pixels - on growth, and on
 * any shift at all - and both take fillRgba and throw if it is missing,
 * unconditionally, so the contract does not change shape depending on
 * whether a particular call happens to grow, shrink, or shift by zero.
 */

/** The nine places existing content can sit in a resized document, as
 * fractional (x, y) anchors: 0 pins to the top/left edge, 1 to the
 * bottom/right edge, 0.5 centres. */
var ANCHORS = {
  'top-left': [0, 0],
  top: [0.5, 0],
  'top-right': [1, 0],
  left: [0, 0.5],
  center: [0.5, 0.5],
  right: [1, 0.5],
  'bottom-left': [0, 1],
  bottom: [0.5, 1],
  'bottom-right': [1, 1],
}

function requireSize(width, height) {
  if (!(width > 0) || Math.floor(width) !== width) {
    throw new Error('width must be a positive integer, got ' + width)
  }
  if (!(height > 0) || Math.floor(height) !== height) {
    throw new Error('height must be a positive integer, got ' + height)
  }
}

function requireFill(fillRgba, fnName) {
  if (!fillRgba || typeof fillRgba.length !== 'number' || fillRgba.length !== 4) {
    throw new Error(fnName + ' requires a 4-element fillRgba (r,g,b,a), got ' + JSON.stringify(fillRgba))
  }
}

function requireAnchor(anchor) {
  if (!Object.prototype.hasOwnProperty.call(ANCHORS, anchor)) {
    throw new Error("resize: unknown anchor '" + anchor + "'")
  }
}

function makeBuffer(width, height) {
  return { data: new Uint8ClampedArray(width * height * 4), width: width, height: height }
}

/** Fill every pixel of a freshly made buffer with one RGBA colour. */
function fillAll(buf, rgba) {
  var data = buf.data
  var r = rgba[0], g = rgba[1], b = rgba[2], a = rgba[3]
  for (var i = 0; i < data.length; i += 4) {
    data[i] = r
    data[i + 1] = g
    data[i + 2] = b
    data[i + 3] = a
  }
}

/**
 * Copy one row's worth of bytes. Uses the typed-array fast path
 * (subarray/set, a native bulk copy) when both sides support it, and falls
 * back to a byte loop for a plain-Array buffer such as a hand-built test
 * fixture - either way this is the only per-pixel work any function here
 * does, and it is numeric indexing throughout, never a string key.
 */
function copyRow(dstData, dOff, srcData, sOff, len) {
  if (typeof srcData.subarray === 'function' && typeof dstData.set === 'function') {
    dstData.set(srcData.subarray(sOff, sOff + len), dOff)
  } else {
    for (var i = 0; i < len; i++) dstData[dOff + i] = srcData[sOff + i]
  }
}

/**
 * Copy the `w` x `h` rect read from `src` at (srcX, srcY) into `dst` at
 * (dstX, dstY), clipping automatically to whatever part of that rect is
 * actually inside both buffers. Anything in the rect that falls outside
 * `src`, or that would land outside `dst`, is simply skipped - which is how
 * every function below gets "outside the source" and "off the edge" for
 * free instead of as a special case.
 */
function copyRegion(dst, dstX, dstY, src, srcX, srcY, w, h) {
  var lx0 = Math.max(0, -srcX, -dstX)
  var ly0 = Math.max(0, -srcY, -dstY)
  var lx1 = Math.min(w, src.width - srcX, dst.width - dstX)
  var ly1 = Math.min(h, src.height - srcY, dst.height - dstY)
  if (lx1 <= lx0 || ly1 <= ly0) return
  var rowBytes = (lx1 - lx0) * 4
  for (var ly = ly0; ly < ly1; ly++) {
    var sOff = ((srcY + ly) * src.width + (srcX + lx0)) * 4
    var dOff = ((dstY + ly) * dst.width + (dstX + lx0)) * 4
    copyRow(dst.data, dOff, src.data, sOff, rowBytes)
  }
}

/**
 * Resize a buffer to (width, height), keeping existing content anchored at
 * one of the nine positions in ANCHORS. Growing exposes new area, filled
 * with fillRgba; shrinking crops whatever falls outside the new size.
 * Growing one axis while shrinking the other works the same way, one axis
 * at a time, because the two axes are independent throughout.
 */
function resize(buf, width, height, anchor, fillRgba) {
  requireSize(width, height)
  requireAnchor(anchor)
  requireFill(fillRgba, 'resize')

  var out = makeBuffer(width, height)
  fillAll(out, fillRgba)

  var frac = ANCHORS[anchor]
  var dx = Math.round((width - buf.width) * frac[0])
  var dy = Math.round((height - buf.height) * frac[1])
  copyRegion(out, dx, dy, buf, 0, 0, buf.width, buf.height)
  return out
}

/**
 * Crop to the width x height rect starting at (x, y) in `buf`'s own
 * coordinates. The rect may extend outside `buf` on any side; whatever part
 * of the result is not covered by `buf` comes back transparent black
 * (0,0,0,0), which is what a freshly allocated buffer already is, rather
 * than an error.
 */
function crop(buf, x, y, width, height) {
  requireSize(width, height)
  var out = makeBuffer(width, height)
  copyRegion(out, 0, 0, buf, x, y, width, height)
  return out
}

/** Flip horizontally: column x becomes column (width - 1 - x). */
function mirrorX(buf) {
  var w = buf.width, h = buf.height
  var out = makeBuffer(w, h)
  var src = buf.data, dst = out.data
  for (var y = 0; y < h; y++) {
    var rowBase = y * w
    for (var x = 0; x < w; x++) {
      var sOff = (rowBase + x) * 4
      var dOff = (rowBase + (w - 1 - x)) * 4
      dst[dOff] = src[sOff]
      dst[dOff + 1] = src[sOff + 1]
      dst[dOff + 2] = src[sOff + 2]
      dst[dOff + 3] = src[sOff + 3]
    }
  }
  return out
}

/** Flip vertically: row y becomes row (height - 1 - y). Whole rows move,
 * so this is a handful of bulk copies rather than a per-pixel swap. */
function mirrorY(buf) {
  var w = buf.width, h = buf.height
  var out = makeBuffer(w, h)
  var rowBytes = w * 4
  for (var y = 0; y < h; y++) {
    var sOff = y * rowBytes
    var dOff = (h - 1 - y) * rowBytes
    copyRow(out.data, dOff, buf.data, sOff, rowBytes)
  }
  return out
}

/**
 * Move content by (dx, dy), filling every pixel vacated by the move with
 * fillRgba. Content pushed off any edge is discarded, not wrapped - a shift
 * larger than the buffer in either axis leaves nothing of the original
 * visible, and the whole result is fillRgba.
 */
function shift(buf, dx, dy, fillRgba) {
  requireFill(fillRgba, 'shift')
  var out = makeBuffer(buf.width, buf.height)
  fillAll(out, fillRgba)
  copyRegion(out, dx, dy, buf, 0, 0, buf.width, buf.height)
  return out
}

module.exports = { resize: resize, crop: crop, mirrorX: mirrorX, mirrorY: mirrorY, shift: shift }
