'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rules = require('../shared/map-pack-rules');

/**
 * Download, verify and install map packs. **fs only, never electron**, and the
 * network is a single injected function — which is what lets
 * `test/map-pack-install.test.js` drive every path, hostile inputs included,
 * with no network and no Electron.
 *
 * The order below is the security story, and it is deliberately
 * "verify everything, then move one directory":
 *
 *   1. GET the index (≤ 256 KB) and validate it (`rules.validateIndex`).
 *   2. Decide what to install (`rules.selectPacksToInstall`): newer than what
 *      is installed, and not needing a newer app.
 *   3. Per pack, into a staging directory **inside userData**:
 *      a. GET `pack.json` and cross-check it against the index entry — same
 *         key, same version, same file list with the same sizes and hashes.
 *      b. GET every listed file, with the URL **derived** from the index's
 *         base plus a validated name (never a URL the pack supplied), each
 *         under its own byte cap, and check the bytes' length and SHA-256
 *         against the index before they are written.
 *      c. Validate the content: PNG signature + plausible dimensions for the
 *         image, the exact template shape the matcher indexes into, the
 *         documented top-level shape for `markers.json`.
 *   4. Only then rename the staging directory into place (`store.commit`),
 *      which parks any previous version aside first and restores it if the
 *      swap fails.
 *
 * A pack that fails **any** of those is discarded whole — the staging
 * directory is deleted, the reason is logged, and a previously installed good
 * version is exactly as it was. Nothing from a pack is ever executed: JSON is
 * read with `JSON.parse` and the PNG is bytes.
 */

/** Lower-case hex SHA-256 of a buffer. */
function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Constant-time-ish digest comparison. Not a secret, so timing does not
 * matter; `timingSafeEqual` is used anyway because it also refuses two strings
 * of different lengths instead of silently comparing prefixes.
 */
function sameDigest(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
    } catch (err) {
        return false;
    }
}

/**
 * @typedef {(url: string, opts: {limit: number}) =>
 *   Promise<{ok: boolean, bytes: ?Buffer, status: number, error: ?string}>} FetchFn
 */

/**
 * How long the whole check may take, installs included.
 *
 * `MapPacks` holds a single-flight flag for the duration, so without a bound
 * the "Check for new maps" button could be dead for hours: the per-request
 * timeout is 30 s, and an index may list 200 packs of 4 files each. Three
 * minutes is far more than a real check (one index plus a few hundred KB) and
 * far less than a stall anybody would wait through. Packs not reached are
 * simply left for the next check.
 */
const CHECK_DEADLINE_MS = 180000;

/**
 * `fetch`, wrapped.
 *
 * The contract of `checkForPacks` is that it never throws, and the injected
 * `fetch` is the one thing in it that is somebody else's code — `https.get`
 * raising synchronously inside a rejected promise, an `ERR_INVALID_ARG_TYPE`,
 * a test double with a bug. A throw here used to come straight out of
 * `checkForPacks` past every "this returns a value" comment in the file.
 */
async function safeFetch(fetch, url, opts) {
    try {
        const response = await fetch(url, opts);
        if (!response || typeof response !== 'object') {
            return {ok: false, bytes: null, status: 0, error: 'no-response'};
        }
        if (response.ok && !Buffer.isBuffer(response.bytes)) {
            return {ok: false, bytes: null, status: response.status || 0, error: 'no-bytes'};
        }
        return response;
    } catch (err) {
        return {ok: false, bytes: null, status: 0, error: `threw:${(err && err.code) || 'error'}`};
    }
}

/**
 * Check the remote index and install whatever is newer.
 *
 * Never throws: every failure is a field of the result, because the caller's
 * answer to all of them is the same — log it, toast nothing worse than "could
 * not check", and leave the installed packs alone.
 *
 * @param {{store: object, fetch: FetchFn, appVersion: string, indexUrl?: string,
 *          probeImage: Function, log?: Function, deadlineMs?: number}} deps
 *   `probeImage` is **required** — see below.
 * @returns {Promise<{ok: boolean, error: ?string, notPublished: boolean,
 *                    installed: Array, skipped: Array, failed: Array,
 *                    checkedAt: number}>}
 */
async function checkForPacks(deps) {
    const {store, fetch, appVersion} = deps || {};
    const indexUrl = (deps && deps.indexUrl) || rules.INDEX_URL;
    const probeImage = deps && deps.probeImage;
    const log = (deps && typeof deps.log === 'function') ? deps.log : () => {};
    const deadline = Date.now() + ((deps && deps.deadlineMs) || CHECK_DEADLINE_MS);
    const result = {
        ok: false, error: null, notPublished: false,
        installed: [], skipped: [], failed: [], checkedAt: Date.now()
    };

    // `probeImage` used to be optional, which made "the dimensions are checked"
    // conditional on the caller remembering to pass a decoder. It is the only
    // check that looks at what the PNG *claims to be*, so a missing one is a
    // configuration error, not a reduced mode.
    if (!store || typeof fetch !== 'function' || typeof probeImage !== 'function') {
        result.error = 'not-configured';
        return result;
    }

    const indexResponse = await safeFetch(fetch, indexUrl, {limit: rules.LIMITS.index});
    if (!indexResponse.ok) {
        // A 404 on the index is not a failure — it is the state the repository
        // is in until the first pack is published, and it is also what a user
        // running a build older than the packs folder sees. Distinguished so it
        // neither raises "could not check" nor burns the retry budget as if the
        // network were broken.
        if (indexResponse.status === 404) {
            result.ok = true;
            result.notPublished = true;
            log('map-pack-check', {result: 'not-published'});
            return result;
        }
        result.error = indexResponse.error || 'index-fetch-failed';
        log('map-pack-check', {result: 'fetch-failed', reason: result.error});
        return result;
    }
    let indexJson;
    try {
        indexJson = JSON.parse(indexResponse.bytes.toString('utf-8'));
    } catch (err) {
        result.error = 'index-not-json';
        log('map-pack-check', {result: 'bad-index', reason: result.error});
        return result;
    }
    const index = rules.validateIndex(indexJson);
    if (!index.ok) {
        result.error = `index:${index.error}`;
        log('map-pack-check', {result: 'bad-index', reason: result.error});
        return result;
    }
    for (const bad of index.rejected) {
        log('map-pack-rejected', {key: bad.key || '(unnamed)', reason: bad.reason});
    }

    const installed = store.list();
    const plan = rules.selectPacksToInstall(index.packs, installed, appVersion);
    result.ok = true;
    result.skipped = plan.skipped;
    log('map-pack-check', {
        result: 'ok',
        listed: index.packs.length,
        install: plan.install.length,
        skipped: plan.skipped.length
    });

    for (const entry of plan.install) {
        if (Date.now() >= deadline) {
            // Out of time. The packs not reached are neither installed nor
            // failed — the next check picks them up, which is exactly what
            // happens today for a pack published while the app is running.
            result.skipped.push({key: entry.key, reason: 'deadline', version: entry.version});
            log('map-pack-check', {result: 'deadline', key: entry.key});
            continue;
        }
        const outcome = await installPack({store, fetch, appVersion, indexUrl, probeImage, log, entry, deadline});
        if (outcome.ok) result.installed.push({key: entry.key, version: entry.version});
        else result.failed.push({key: entry.key, reason: outcome.error});
    }
    return result;
}

/**
 * Download and install exactly one pack. Used by `checkForPacks`; exported so
 * a test can drive one pack's failure modes directly.
 *
 * @returns {Promise<{ok: boolean, error: ?string}>}
 */
async function installPack(deps) {
    const {store, fetch, appVersion, indexUrl, probeImage, entry} = deps;
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    const fail = (error, staging) => {
        if (staging) store.discard(staging);
        log('map-pack-failed', {key: entry.key, version: entry.version, reason: error});
        return {ok: false, error};
    };

    // The manifest is fetched by name and is *not* one of the hashed files: it
    // is the pack's description of the hashed files, and listing it among them
    // would be circular. It is pinned instead by cross-checking every field
    // against the index entry, so every byte that ends up on disk is either
    // hash-checked (image, templates, markers) or agrees with the index
    // field-for-field (the manifest).
    const manifestUrl = rules.packFileUrl(indexUrl, entry.base, rules.MANIFEST_NAME);
    if (!manifestUrl) return fail('bad-manifest-url');
    const manifestResponse = await safeFetch(fetch, manifestUrl, {limit: rules.LIMITS.manifest});
    if (!manifestResponse.ok) {
        return fail(`manifest-fetch:${manifestResponse.error || 'failed'}`);
    }
    const manifestText = manifestResponse.bytes.toString('utf-8');
    const parsed = store.parseManifest(manifestText, entry);
    if (!parsed.ok) return fail(`manifest:${parsed.error}`);
    const manifest = parsed.manifest;
    if (!rules.appSatisfies(appVersion, manifest.minAppVersion)) return fail('needs-app');

    const staging = store.staging();
    if (!staging) return fail('no-staging-dir');

    let total = manifestResponse.bytes.length;
    for (const file of manifest.files) {
        if (deps.deadline && Date.now() >= deps.deadline) return fail('deadline', staging);
        const url = rules.packFileUrl(indexUrl, entry.base, file.name);
        if (!url) return fail(`bad-url:${file.name}`, staging);
        const limit = rules.limitForFile(file.name);
        const response = await safeFetch(fetch, url, {limit});
        if (!response.ok) {
            return fail(`fetch:${file.name}:${response.error || 'failed'}`, staging);
        }
        const bytes = response.bytes;
        // Size first: it is free, and it is what a truncated download looks
        // like. Then the digest, which is what a *substituted* file looks like.
        if (bytes.length !== file.bytes) return fail(`bytes:${file.name}`, staging);
        if (!sameDigest(sha256(bytes), file.sha256)) return fail(`sha256:${file.name}`, staging);
        total += bytes.length;
        if (total > rules.LIMITS.pack) return fail('pack-too-large', staging);

        // Content checks happen *before* the file is written, so staging never
        // holds something that failed validation.
        if (file.name === manifest.image) {
            if (!rules.hasPngSignature(bytes)) return fail('not-a-png', staging);
            let size = null;
            try {
                size = probeImage(bytes);
            } catch (err) {
                return fail('image-undecodable', staging);
            }
            if (!rules.isSaneImageSize(size)) return fail('image-size', staging);
            // The header is not the file. A 33-byte signature+IHDR declaring
            // 8192x8192 satisfies everything above, installs, and leaves the
            // map permanently blank while the next check says "up to date".
            if (!rules.isPlausiblePngBytes(bytes, size)) return fail('image-truncated', staging);
        } else if (file.name === rules.TEMPLATES_NAME) {
            let json;
            try {
                json = JSON.parse(bytes.toString('utf-8'));
            } catch (err) {
                return fail('templates-not-json', staging);
            }
            const check = rules.validateTemplates(json, {key: manifest.key, size: store.templateSize});
            if (!check.ok) return fail(`templates:${check.error}`, staging);
        } else if (file.name === rules.MARKERS_NAME) {
            let json;
            try {
                json = JSON.parse(bytes.toString('utf-8'));
            } catch (err) {
                return fail('markers-not-json', staging);
            }
            const check = rules.validateMarkers(json);
            if (!check.ok) return fail(`markers:${check.error}`, staging);
        } else {
            // A file the manifest lists but the format has no meaning for.
            // Refused rather than stored: "we do not know what this is" is not
            // a reason to put it on the user's disk.
            return fail(`unknown-file:${file.name}`, staging);
        }

        try {
            fs.writeFileSync(path.join(staging, file.name), bytes);
        } catch (err) {
            return fail(`write:${file.name}:${(err && err.code) || 'failed'}`, staging);
        }
    }

    // The manifest goes in last and verbatim — the bytes that were validated,
    // not a re-serialised copy, so `store.readPack` re-runs exactly the same
    // check on exactly the same text on every later start.
    try {
        fs.writeFileSync(path.join(staging, rules.MANIFEST_NAME), manifestResponse.bytes);
    } catch (err) {
        return fail(`write:${rules.MANIFEST_NAME}:${(err && err.code) || 'failed'}`, staging);
    }

    const committed = store.commit(staging, manifest.key);
    if (!committed.ok) return fail(`commit:${committed.error}`, staging);
    log('map-pack-installed', {key: manifest.key, version: manifest.version, bytes: total});
    return {ok: true, error: null};
}

module.exports = {checkForPacks, installPack, sha256, safeFetch, CHECK_DEADLINE_MS};
