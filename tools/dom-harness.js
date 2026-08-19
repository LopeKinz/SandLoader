'use strict'
/**
 * A DOM small enough to boot the console in a plain Node VM.
 *
 * Not a browser emulation - just the handful of operations the console
 * actually performs, so the injected runtime can be exercised end to end
 * without launching Electron. Anything the console starts relying on that is
 * missing here will throw loudly, which is the point.
 */

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
  }

  return { document: doc, window: win }
}

module.exports = { createDom, makeElement }
