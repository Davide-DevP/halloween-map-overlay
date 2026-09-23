'use strict';

/**
 * PURE timer idioms shared by main's loops and watchdogs.
 */

/**
 * `clearTimeout` on a handle that may be null. Returns null, so a caller
 * writes `this.timer = clearTimer(this.timer)`.
 * @returns {null}
 */
function clearTimer(handle) {
    if (handle) clearTimeout(handle);
    return null;
}

/**
 * A background timer must never be the reason the process stays alive; the
 * `unref` guard is for runtimes whose handles have none.
 * @returns the same handle
 */
function unrefTimer(handle) {
    if (handle && typeof handle.unref === 'function') handle.unref();
    return handle;
}

module.exports = {clearTimer, unrefTimer};
