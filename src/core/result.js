'use strict'
/**
 * Result<T> — explicit success/failure without exceptions crossing module
 * boundaries. The loader must never die because one mod threw; every fallible
 * operation returns a Result and the caller decides how loud to be.
 */

/** @template T @typedef {{ok:true,value:T}|{ok:false,error:import('./errors').SmlnError}} Result */

const { SmlnError, toSmlnError } = require('./errors')

/** @template T @param {T} value @returns {Result<T>} */
function Ok(value) {
  return { ok: true, value }
}

/** @param {SmlnError|Error|string} error @returns {Result<never>} */
function Err(error) {
  return { ok: false, error: toSmlnError(error) }
}

/**
 * Run `fn`, converting any throw into an Err. `context` is prepended to the
 * message so a failure deep inside a mod still says which mod it came from.
 * @template T @param {() => T} fn @param {string} context @returns {Result<T>}
 */
function attempt(fn, context) {
  try {
    return Ok(fn())
  } catch (e) {
    return Err(toSmlnError(e, context))
  }
}

/**
 * Async twin of {@link attempt}.
 * @template T @param {() => Promise<T>} fn @param {string} context @returns {Promise<Result<T>>}
 */
async function attemptAsync(fn, context) {
  try {
    return Ok(await fn())
  } catch (e) {
    return Err(toSmlnError(e, context))
  }
}

/** @template T @param {Result<T>} r @param {T} fallback @returns {T} */
function unwrapOr(r, fallback) {
  return r.ok ? r.value : fallback
}

module.exports = { Ok, Err, attempt, attemptAsync, unwrapOr }
