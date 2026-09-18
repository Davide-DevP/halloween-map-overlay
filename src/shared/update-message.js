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

const {t} = require('./i18n');

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

/**
 * "Version 0.2.1 is ready." — or a version-less fallback.
 * @param {string} lang 'en' | 'it'
 * @param {string} version from the GitHub release feed
 */
function updateReadyHeadline(lang, version) {
    const value = typeof version === 'string' ? version.trim() : '';
    if (!value || !VERSION_PATTERN.test(value)) return t(lang, 'update.ready.headlineUnknown');
    return t(lang, 'update.ready.headline', {version: value});
}

/**
 * "Updating to 0.5.1" — the headline of the full-window "updating" view, and
 * the same sentence `hmo-updater.exe` draws a moment later (the `headline` key
 * in `updater/strings.json`). The two have to stay word for word identical:
 * the helper opens at this window's exact bounds and the swap is meant to be
 * invisible.
 *
 * Same version guard as above — the string comes off the release feed.
 *
 * @param {string} lang 'en' | 'it'
 * @param {string} version
 */
function updatingHeadline(lang, version) {
    const value = typeof version === 'string' ? version.trim() : '';
    if (!value || !VERSION_PATTERN.test(value)) return t(lang, 'update.installing.headlineUnknown');
    return t(lang, 'update.installing.headline', {version: value});
}

module.exports = {updateReadyHeadline, updatingHeadline, VERSION_PATTERN};
