'use strict';

const https = require('https');

const rules = require('../shared/map-pack-rules');

/**
 * The one network call map packs make: an HTTPS GET of one file on
 * `raw.githubusercontent.com`. **Main process only** — the renderer's CSP is
 * `connect-src 'none'`. `node:https` and nothing else: no dependency, no
 * `fetch` polyfill, no redirect library. It returns bytes and never parses
 * them; the installer validates.
 * Every property here is a refusal:
 * - **The URL must pass `rules.isAllowedUrl`** — checked again here, because
 *   this is the function that opens the socket.
 * - **A redirect is another URL somebody else chose**, so each `Location` is
 *   resolved and re-validated, at most twice; off-host is a hard failure.
 * - **The cap is enforced while reading**, not after: `content-length` when
 *   present, and the running total, which destroys an endless response.
 * - **Two timeouts**: socket inactivity, plus an overall deadline for a server
 *   that dribbles one byte a second forever and never trips the first.
 * - **Nothing is sent.** No cookies, no auth, no query; the `User-Agent` is the
 *   bare product name (GitHub asks for one) with no version or identifier.
 * The **transport** is injectable (`opts.request`) so the tests drive the
 * redirect, cap and timeout paths. The seam is the socket, not the policy:
 * `isAllowedUrl` still runs on every URL.
 */

/** Socket inactivity, and the whole request, in milliseconds. */
const SOCKET_TIMEOUT_MS = 10000;
const TOTAL_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 2;

/**
 * GET one `url` (which must pass `rules.isAllowedUrl`), resolving
 * `{ok, bytes, status, error}`. **Never throws and never rejects**: a failure
 * is a value, because every caller's answer to one is the same. `opts.limit` is
 * the hard byte cap, `opts.request` the transport seam the tests replace.
 */
function fetchPackFile(url, opts) {
    const options = opts || {};
    const get = typeof options.request === 'function' ? options.request : https.get;
    // No cap supplied falls back to the smallest one, never to no cap.
    const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : rules.LIMITS.index;
    const deadline = Date.now() + (options.timeoutMs || TOTAL_TIMEOUT_MS);

    return new Promise((resolve) => {
        let settled = false;
        const done = (result) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };

        const attempt = (target, redirectsLeft) => {
            if (!rules.isAllowedUrl(target)) {
                done({ok: false, bytes: null, status: 0, error: 'url-not-allowed'});
                return;
            }
            if (Date.now() >= deadline) {
                done({ok: false, bytes: null, status: 0, error: 'timeout'});
                return;
            }

            let request;
            try {
                request = get(target, {
                    headers: {
                        // The product name only: no version, no identifier.
                        'user-agent': options.userAgent || 'halloween-map-overlay',
                        'accept': '*/*'
                    },
                    agent: options.agent,
                    timeout: SOCKET_TIMEOUT_MS
                });
            } catch (err) {
                done({ok: false, bytes: null, status: 0, error: `request:${(err && err.code) || 'failed'}`});
                return;
            }

            const overall = setTimeout(() => {
                request.destroy();
                done({ok: false, bytes: null, status: 0, error: 'timeout'});
            }, Math.max(1, deadline - Date.now()));
            if (overall.unref) overall.unref();

            request.on('timeout', () => {
                request.destroy();
                clearTimeout(overall);
                done({ok: false, bytes: null, status: 0, error: 'socket-timeout'});
            });
            request.on('error', (err) => {
                clearTimeout(overall);
                done({ok: false, bytes: null, status: 0, error: `net:${(err && err.code) || 'failed'}`});
            });

            request.on('response', (response) => {
                const status = response.statusCode || 0;

                if (status >= 300 && status < 400) {
                    response.resume();
                    clearTimeout(overall);
                    const location = response.headers && response.headers.location;
                    if (!redirectsLeft) {
                        done({ok: false, bytes: null, status, error: 'too-many-redirects'});
                        return;
                    }
                    if (typeof location !== 'string' || !location) {
                        done({ok: false, bytes: null, status, error: 'redirect-no-location'});
                        return;
                    }
                    // Resolved against the current URL, then re-validated: a
                    // relative `Location` is legal HTTP and must not become a
                    // hole in the allow-list.
                    let next;
                    try {
                        next = new URL(location, target).toString();
                    } catch (err) {
                        done({ok: false, bytes: null, status, error: 'redirect-bad-location'});
                        return;
                    }
                    if (!rules.isAllowedUrl(next)) {
                        done({ok: false, bytes: null, status, error: 'redirect-off-host'});
                        return;
                    }
                    attempt(next, redirectsLeft - 1);
                    return;
                }

                if (status !== 200) {
                    response.resume();
                    clearTimeout(overall);
                    done({ok: false, bytes: null, status, error: `http-${status}`});
                    return;
                }

                // Refuse an oversize body before a byte of it is read.
                const declared = parseInt((response.headers && response.headers['content-length']) || '', 10);
                if (Number.isFinite(declared) && declared > limit) {
                    response.destroy();
                    clearTimeout(overall);
                    done({ok: false, bytes: null, status, error: 'too-large'});
                    return;
                }

                const chunks = [];
                let read = 0;
                response.on('data', (chunk) => {
                    read += chunk.length;
                    if (read > limit) {
                        response.destroy();
                        clearTimeout(overall);
                        done({ok: false, bytes: null, status, error: 'too-large'});
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on('aborted', () => {
                    clearTimeout(overall);
                    done({ok: false, bytes: null, status, error: 'aborted'});
                });
                response.on('error', (err) => {
                    clearTimeout(overall);
                    done({ok: false, bytes: null, status, error: `body:${(err && err.code) || 'failed'}`});
                });
                response.on('end', () => {
                    clearTimeout(overall);
                    done({ok: true, bytes: Buffer.concat(chunks), status, error: null});
                });
            });
        };

        attempt(url, MAX_REDIRECTS);
    });
}

module.exports = {fetchPackFile, SOCKET_TIMEOUT_MS, TOTAL_TIMEOUT_MS, MAX_REDIRECTS};
