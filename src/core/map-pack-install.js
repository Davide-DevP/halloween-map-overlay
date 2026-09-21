'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rules = require('../shared/map-pack-rules');

/**
 * Download, verify and install map packs. **fs only, never electron**, with the
 * network as one injected function, so every path — hostile inputs included —
 * is driven by tests without a network.
 * The order **is** the security property, and it is "verify everything, then
 * move one directory": validate the index, pick what to install, then per pack,
 * into a staging directory inside userData, cross-check `pack.json` against the
 * index entry and fetch every file from a URL **derived** from the index's base
 * plus a validated name, under its own byte cap, length and SHA-256 checked and
 * content-validated — and only then rename staging into place. A pack that
 * fails **any** of those is discarded whole and a previously installed good
 * version is exactly as it was. See `docs/agents/map-packs.md`.
 */

/** Lower-case hex SHA-256 of a buffer. */
function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** A hash is not a secret, so timing does not matter; `timingSafeEqual` is
 * used because it refuses unequal lengths instead of comparing prefixes. */
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

/** How long the whole check may take. `MapPacks` holds a single-flight flag for
 * the duration, and 30 s per request × 200 packs × 4 files would leave the
 * button dead for hours. Packs not reached wait for the next check. */
const CHECK_DEADLINE_MS = 180000;

/** Wrapped, because `checkForPacks` must never throw and the injected `fetch`
 * is the one piece of somebody else's code in it. */
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
 * Check the remote index and install whatever is newer. **Never throws**: every
 * failure is a field of the result, because the caller's answer to all of them
 * is the same — log it, toast "could not check", leave the packs alone.
 * @param {{store: object, fetch: FetchFn, appVersion: string, indexUrl?: string,
 *          probeImage: Function, log?: Function, deadlineMs?: number}} deps
 *   `probeImage` is **required** — see below.
 * @returns {Promise<{ok, error, notPublished, installed, skipped, failed,
 *                    checkedAt}>}
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

    // `probeImage` is mandatory: it is the only check that looks at what the
    // PNG *claims to be*, so a missing decoder is an error, not a reduced mode.
    if (!store || typeof fetch !== 'function' || typeof probeImage !== 'function') {
        result.error = 'not-configured';
        return result;
    }

    const indexResponse = await safeFetch(fetch, indexUrl, {limit: rules.LIMITS.index});
    if (!indexResponse.ok) {
        // A 404 on the index is "nothing published yet", not a failure: it must
        // neither raise "could not check" nor shorten the retry interval.
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
            // Neither installed nor failed: the next check picks them up.
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

/** Download and install exactly one pack. Exported so a test can drive one
 * pack's failure modes directly. */
async function installPack(deps) {
    const {store, fetch, appVersion, indexUrl, probeImage, entry} = deps;
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    const fail = (error, staging) => {
        if (staging) store.discard(staging);
        log('map-pack-failed', {key: entry.key, version: entry.version, reason: error});
        return {ok: false, error};
    };

    // The manifest is fetched by name and is *not* one of the hashed files
    // (circular). It is pinned by cross-checking every field against the index
    // entry, so every byte on disk is hash-checked or agrees with the index.
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
        // Size first (free, and what a truncated download looks like), then the
        // digest (what a substituted file looks like).
        if (bytes.length !== file.bytes) return fail(`bytes:${file.name}`, staging);
        if (!sameDigest(sha256(bytes), file.sha256)) return fail(`sha256:${file.name}`, staging);
        total += bytes.length;
        if (total > rules.LIMITS.pack) return fail('pack-too-large', staging);

        // Content checks run *before* the write, so staging never holds
        // something that failed validation.
        if (file.name === manifest.image) {
            if (!rules.hasPngSignature(bytes)) return fail('not-a-png', staging);
            let size = null;
            try {
                size = probeImage(bytes);
            } catch (err) {
                return fail('image-undecodable', staging);
            }
            if (!rules.isSaneImageSize(size)) return fail('image-size', staging);
            // The header is not the file: a 33-byte signature+IHDR declaring
            // 8192² satisfies everything above and installs a blank map.
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
            // A file the format has no meaning for is refused, not stored.
            return fail(`unknown-file:${file.name}`, staging);
        }

        try {
            fs.writeFileSync(path.join(staging, file.name), bytes);
        } catch (err) {
            return fail(`write:${file.name}:${(err && err.code) || 'failed'}`, staging);
        }
    }

    // Last, and verbatim: the validated bytes, not a re-serialised copy, so
    // `store.readPack` re-runs the same check on the same text on every start.
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
