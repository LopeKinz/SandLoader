'use strict'
/**
 * Typed errors. Every failure carries a stable machine-readable `code` so the
 * UI, the log and the self-test can branch on it without string matching.
 */

/** @typedef {'E_GAME_NOT_FOUND'|'E_ASAR_INVALID'|'E_ASAR_ENTRY_MISSING'|'E_HOST_ABI'|'E_PATCH_FAILED'|'E_PATCH_AMBIGUOUS'|'E_PATCH_CONFLICT'|'E_MANIFEST_INVALID'|'E_DEPENDENCY'|'E_MOD_LOAD'|'E_CONFIG'|'E_IO'|'E_PERMISSION_INVALID'|'E_PERMISSION_UNKNOWN'|'E_PERMISSION_DENIED'|'E_UNSAFE_HANDOFF'|'E_UNSUPPORTED'|'E_HOST_UNSUPPORTED'|'E_NOT_READY'|'E_UNKNOWN'} SmlnCode */

class SmlnError extends Error {
  /**
   * @param {SmlnCode} code
   * @param {string} message
   * @param {{cause?:unknown, detail?:Record<string,unknown>}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message)
    this.name = 'SmlnError'
    /** @type {SmlnCode} */
    this.code = code
    this.detail = opts.detail || {}
    if (opts.cause) this.cause = opts.cause
  }

  /** Stable one-line form used by the logger and the self-test. */
  toString() {
    return `[${this.code}] ${this.message}`
  }

  toJSON() {
    return { code: this.code, message: this.message, detail: this.detail }
  }
}

/**
 * Normalise anything throwable into a SmlnError, preserving an existing code.
 * @param {unknown} e @param {string} [context]
 * @returns {SmlnError}
 */
function toSmlnError(e, context) {
  const prefix = context ? `${context}: ` : ''
  if (e instanceof SmlnError) {
    if (!context) return e
    const wrapped = new SmlnError(e.code, prefix + e.message, { cause: e, detail: e.detail })
    wrapped.stack = e.stack
    return wrapped
  }
  if (e instanceof Error) {
    // Map the handful of node errno codes we actually care about.
    const code = e.code === 'ENOENT' || e.code === 'EACCES' || e.code === 'EPERM' ? 'E_IO' : 'E_UNKNOWN'
    const err = new SmlnError(code, prefix + e.message, { cause: e })
    err.stack = e.stack
    return err
  }
  return new SmlnError('E_UNKNOWN', prefix + String(e))
}

module.exports = { SmlnError, toSmlnError }
