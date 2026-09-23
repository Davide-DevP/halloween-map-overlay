'use strict';

/**
 * PURE. The text of anything a `catch` or a rejection hands over: an `Error`'s
 * message, or the value itself stringified when there is none.
 * @returns {string}
 */
function errorMessage(err) {
    return (err && err.message) || String(err);
}

module.exports = {errorMessage};
