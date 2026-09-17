'use strict';

/**
 * Text for the "update ready" banner on the home page.
 *
 * Pure so it can be unit tested: the banner itself can only be seen by running
 * a packaged build against a real release, which no test can do.
 *
 * The version string comes from the GitHub release feed, i.e. from outside the
 * app, and is interpolated into the DOM. The renderer sets it with jQuery
 * `.text()` so it can never be markup, but anything that is not a plausible
 * version is dropped here as well rather than being echoed back at the user.
 */

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

/** "Version 0.2.1 is ready." — or a version-less fallback. */
function updateReadyHeadline(version) {
    const value = typeof version === 'string' ? version.trim() : '';
    if (!value || !VERSION_PATTERN.test(value)) return 'A new version is ready.';
    return `Version ${value} is ready.`;
}

module.exports = {updateReadyHeadline, VERSION_PATTERN};
