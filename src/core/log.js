'use strict'
/**
 * Logging. One file per launch plus console mirroring, with per-scope child
 * loggers so a line always says which subsystem (or which mod) produced it.
 *
 * Deliberately dependency-free and failure-tolerant: if the log file cannot be
 * opened we degrade to console-only rather than taking the loader down with
 * us. A mod loader that crashes while reporting a crash is useless.
 */

const fs = require('fs')
const path = require('path')

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, off: 99 }

/** @type {{stream: import('fs').WriteStream|null, file: string|null, minLevel: number, mirror: boolean}} */
const state = { stream: null, file: null, minLevel: LEVELS.info, mirror: true }

function ts() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/**
 * Point the logger at a directory. Keeps the newest `keep` logs and drops the
 * rest so a long-lived install does not accumulate thousands of files.
 * @param {{dir:string, level?:keyof typeof LEVELS, mirror?:boolean, keep?:number}} opts
 */
function init(opts) {
  const { dir, level = 'info', mirror = true, keep = 10 } = opts
  state.minLevel = LEVELS[level] ?? LEVELS.info
  state.mirror = mirror
  try {
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    state.file = path.join(dir, `smln-${stamp}.log`)
    state.stream = fs.createWriteStream(state.file, { flags: 'a' })
    // Never let a broken pipe/full disk escalate into an unhandled 'error'.
    state.stream.on('error', () => { state.stream = null })
    rotate(dir, keep)
  } catch (e) {
    state.stream = null
    if (state.mirror) console.warn('[SMLN] file logging unavailable:', e && e.message)
  }
  return state.file
}

function rotate(dir, keep) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('smln-') && f.endsWith('.log')).sort()
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      try { fs.unlinkSync(path.join(dir, f)) } catch (_) { /* best effort */ }
    }
  } catch (_) { /* directory unreadable; nothing to rotate */ }
}

function write(level, scope, parts) {
  if ((LEVELS[level] ?? 0) < state.minLevel) return
  const msg = parts.map(fmt).join(' ')
  const line = `${ts()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`
  if (state.stream) { try { state.stream.write(line + '\n') } catch (_) {} }
  if (state.mirror) {
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    sink(`[SMLN:${scope}]`, msg)
  }
}

function fmt(v) {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.stack || String(v)
  try { return JSON.stringify(v) } catch (_) { return String(v) }
}

/**
 * @param {string} scope
 * @returns {{trace:Function,debug:Function,info:Function,warn:Function,error:Function,child:(s:string)=>any}}
 */
function createLogger(scope) {
  const mk = (level) => (...parts) => write(level, scope, parts)
  return {
    trace: mk('trace'), debug: mk('debug'), info: mk('info'),
    warn: mk('warn'), error: mk('error'),
    child: (sub) => createLogger(`${scope}/${sub}`),
  }
}

/** @param {keyof typeof LEVELS} level */
function setLevel(level) {
  if (LEVELS[level] != null) state.minLevel = LEVELS[level]
}

function currentFile() { return state.file }

async function close() {
  const s = state.stream
  state.stream = null
  if (!s) return
  await new Promise((res) => s.end(res))
}

module.exports = { init, createLogger, setLevel, currentFile, close, LEVELS }
