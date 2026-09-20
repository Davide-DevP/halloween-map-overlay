'use strict';

const https = require('https');

const rules = require('../shared/map-pack-rules');

/**
 * The one network call map packs make: an HTTPS GET of a file under
 * `raw.githubusercontent.com/Davide-DevP/halloween-map-overlay/`.
 *
 * **Main process only.** The renderer's CSP is `connect-src 'none'` and stays
 * that way; nothing about this feature runs in a window. `node:https` and
 * nothing else — no new dependency, no `fetch` polyfill, no redirect library.
 *
 * It returns bytes and never parses them. The installer does the parsing and
 * the validation, which is what lets `test/map-pack-install.test.js` drive the
 * whole install with a fake `fetch` and no network at all.
 *
 * This function itself is tested the same way, one level down: the **transport**
 * is injectable (`opts.request`, defaulting to `https.get`), so
 * `test/map-pack-fetch.test.js` drives the redirect, cap, lying-`content-length`
 * and timeout paths against a fake request object. The allow-list is *not*
 * bypassable that way — the URLs in those tests are real allowed URLs and
 * `isAllowedUrl` runs on every one of them, which is the point: the seam is the
 * socket, not the policy.
 *
 * Every property worth having is a refusal:
 *
 * - **The URL must pass `rules.isAllowedUrl`** — https, one host, one path
 *   prefix, no port, no credentials, no query. The caller derives it with
 *   `rules.packFileUrl`; it is checked again here, because this is the function
 *   that actually opens the socket.
 * - **A redirect is just another URL somebody else chose**, so each `Location`
 *   goes through the same allow-list, and there are at most two. Refusing them
 *   outright was the first draft; two re-validated hops cost nothing and mean a
 *   future `raw.githubusercontent.com` reshuffle does not break the feature,
 *   while a redirect to anywhere else is still a hard failure with a log line.
 * - **The cap is enforced while reading**, not after: both `content-length`
 *   (when present, which lets an oversize file be refused before a byte of body
 *   arrives) and the running total. A response that keeps coming is destroyed.
 * - **Two timeouts.** A socket-inactivity timeout catches a stalled connection;
 *   an overall deadline catches a server that dribbles one byte a second
 *   forever, which no inactivity timeout ever fires on.
 * - **Nothing is sent.** No cookies, no auth header, no query string. The only
 *   header that says anything is a bare `User-Agent` of `halloween-map-overlay`
 *   (GitHub asks every client for one) — the product name and nothing else: no
 *   version, no platform, no identifier. Deliberately less than the update
 *   check's own user agent, because nothing here needs it.
 */

/** Socket inactivity, and the whole request, in milliseconds. */
const SOCKET_TIMEOUT_MS = 10000;
const TOTAL_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 2;

/**
 * GET one file.
 *
 * Never throws and never rejects: a failure is a value, because every caller's
 * answer to one is the same — log it and leave the installed packs alone.
 *
 * @param {string} url must pass `rules.isAllowedUrl`
 * @param {{limit: number, timeoutMs?: number, userAgent?: string,
 *          agent?: object, request?: Function}} [opts] `limit` is the hard byte
 *   cap; `request` is the transport seam (`https.get`) the tests replace.
 * @returns {Promise<{ok: boolean, bytes: ?Buffer, status: number, error: ?string}>}
 */
function fetchPackFile(url, opts) {
    const options = opts || {};
    const get = typeof options.request === 'function' ? options.request : https.get;
    // No cap supplied is the index's cap, the smallest one — a caller that
    // forgot to say how big a file may be gets the strictest answer, not none.
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
                        // GitHub asks every client to identify itself. The
                        // product name, nothing else — see the note above.
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
                    // Resolved against the current URL, then re-validated. A
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

                // Refuse an oversize body before reading it, when the server
                // says how big it is.
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
