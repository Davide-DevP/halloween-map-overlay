const {test} = require('node:test');
const assert = require('node:assert');
const {EventEmitter} = require('events');

const {fetchPackFile, MAX_REDIRECTS} = require('../src/core/map-pack-fetch');
const rules = require('../src/shared/map-pack-rules');

/*
 * The one network call map packs make.
 *
 * **No network and no local server.** The *transport* is injectable
 * (`opts.request`, defaulting to `https.get`) and that is the only seam: the
 * URLs below are real allowed URLs and `isAllowedUrl` runs on every one of
 * them, so nothing here weakens the policy in order to be testable. A local
 * server on 127.0.0.1 would have required exactly that — punching a hole in
 * the host allow-list — which is why it is done this way round.
 */

const OK = rules.INDEX_URL;
const DIR = 'https://raw.githubusercontent.com/Davide-DevP/halloween-map-overlay/main/packs/';

/**
 * A fake `https.get`.
 *
 * Each call consumes the next scripted step. A step is either
 * `{status, headers, chunks}` (a response), `{error}` (an `'error'` event),
 * `{timeout: true}` (the socket inactivity event), `{silent: true}` (nothing
 * ever happens, for the overall deadline) or `{throws: true}`.
 */
function fakeTransport(steps) {
    const calls = [];
    const state = {destroyed: 0};
    let index = 0;
    const get = (url, options) => {
        calls.push({url, headers: options && options.headers, timeout: options && options.timeout});
        const step = steps[index++] || {status: 404, headers: {}, chunks: []};
        if (step.throws) throw Object.assign(new Error('bad argument'), {code: 'ERR_INVALID_ARG'});

        const request = new EventEmitter();
        request.destroy = () => { state.destroyed++; };
        // Asynchronously, like the real thing: the caller attaches its
        // listeners after `get` returns.
        setImmediate(() => {
            if (step.silent) return;
            if (step.error) {
                request.emit('error', Object.assign(new Error('boom'), {code: step.error}));
                return;
            }
            if (step.timeout) {
                request.emit('timeout');
                return;
            }
            const response = new EventEmitter();
            response.statusCode = step.status;
            response.headers = step.headers || {};
            response.resume = () => {};
            response.destroy = () => { state.destroyed++; };
            request.emit('response', response);
            setImmediate(() => {
                for (const chunk of step.chunks || []) response.emit('data', Buffer.from(chunk));
                if (step.aborted) response.emit('aborted');
                else if (step.bodyError) response.emit('error', Object.assign(new Error('x'), {code: 'EBODY'}));
                else response.emit('end');
            });
        });
        return request;
    };
    return {get, calls, state};
}

function body(status, text, headers) {
    return {status, headers: headers || {}, chunks: [text]};
}

/* ────────────────────────────────────────────────────────────────────────── */

test('a 200 hands back the bytes, and the request says almost nothing', async () => {
    const t = fakeTransport([body(200, 'hello')]);
    const result = await fetchPackFile(OK, {limit: 1024, request: t.get});
    assert.deepStrictEqual(result, {ok: true, bytes: Buffer.from('hello'), status: 200, error: null});
    assert.strictEqual(t.calls.length, 1);
    // No cookie, no auth, no identifier — a bare product name, which is all
    // GitHub asks for.
    assert.deepStrictEqual(Object.keys(t.calls[0].headers).sort(), ['accept', 'user-agent']);
    assert.strictEqual(t.calls[0].headers['user-agent'], 'halloween-map-overlay');
    assert.ok(t.calls[0].timeout > 0, 'a socket timeout is always set');
});

test('the allow-list is checked here too, before any socket is opened', async () => {
    const hostile = [
        'http://raw.githubusercontent.com/Davide-DevP/halloween-map-overlay/a.png',
        'https://evil.com/Davide-DevP/halloween-map-overlay/a.png',
        'https://raw.githubusercontent.com/someone-else/repo/a.png',
        'file:///c:/windows/system32.png',
        'not a url', ''
    ];
    for (const url of hostile) {
        const t = fakeTransport([body(200, 'x')]);
        const result = await fetchPackFile(url, {limit: 16, request: t.get});
        assert.strictEqual(result.error, 'url-not-allowed', url);
        assert.deepStrictEqual(t.calls, [], `nothing was requested for ${url}`);
    }
});

test('a non-200 is reported with its status and the body is drained', async () => {
    for (const status of [204, 299, 403, 404, 500, 0]) {
        const t = fakeTransport([body(status, 'nope')]);
        const result = await fetchPackFile(OK, {limit: 1024, request: t.get});
        assert.strictEqual(result.ok, false, String(status));
        assert.strictEqual(result.status, status);
        assert.strictEqual(result.error, `http-${status}`);
        assert.strictEqual(result.bytes, null);
    }
});

test('a redirect inside the allow-list is followed, at most twice', async () => {
    const t = fakeTransport([
        {status: 302, headers: {location: `${DIR}one.json`}, chunks: []},
        {status: 302, headers: {location: `${DIR}two.json`}, chunks: []},
        body(200, 'arrived')
    ]);
    const result = await fetchPackFile(OK, {limit: 1024, request: t.get});
    assert.ok(result.ok, result.error);
    assert.strictEqual(result.bytes.toString(), 'arrived');
    assert.deepStrictEqual(t.calls.map(c => c.url), [OK, `${DIR}one.json`, `${DIR}two.json`]);

    // One hop more than the budget is a refusal, not a third request.
    const over = fakeTransport(Array.from({length: MAX_REDIRECTS + 2}, (_, i) => ({
        status: 302, headers: {location: `${DIR}hop${i}.json`}, chunks: []
    })));
    const refused = await fetchPackFile(OK, {limit: 1024, request: over.get});
    assert.strictEqual(refused.error, 'too-many-redirects');
    assert.strictEqual(over.calls.length, MAX_REDIRECTS + 1);
});

test('a redirect OFF the allow-list is a hard failure', async () => {
    // A redirect is just another URL somebody else chose, so it goes through
    // the same allow-list — including a *relative* Location, which is legal
    // HTTP and must not become a hole in it.
    const cases = [
        ['https://evil.com/x.png', 'redirect-off-host'],
        ['https://raw.githubusercontent.com/other/repo/x.png', 'redirect-off-host'],
        ['/etc/passwd', 'redirect-off-host'],
        ['../../../other/repo/x.png', 'redirect-off-host'],
        // Protocol-relative: the sneakiest spelling of "another host".
        ['//evil.com/x.png', 'redirect-off-host'],
        ['http://raw.githubusercontent.com/Davide-DevP/halloween-map-overlay/x.png', 'redirect-off-host'],
        [undefined, 'redirect-no-location'],
        ['', 'redirect-no-location']
    ];
    for (const [location, error] of cases) {
        const t = fakeTransport([{status: 302, headers: location === undefined ? {} : {location}, chunks: []}]);
        const result = await fetchPackFile(OK, {limit: 1024, request: t.get});
        assert.strictEqual(result.error, error, String(location));
        assert.strictEqual(t.calls.length, 1, `no second request for ${location}`);
    }
});

test('a relative redirect that stays inside the prefix is resolved and allowed', async () => {
    const t = fakeTransport([
        {status: 302, headers: {location: 'sub/thing.json'}, chunks: []},
        body(200, 'ok')
    ]);
    const result = await fetchPackFile(OK, {limit: 1024, request: t.get});
    assert.ok(result.ok, result.error);
    assert.strictEqual(t.calls[1].url, `${DIR}sub/thing.json`);
});

test('an oversize content-length is refused before a byte of body is read', async () => {
    const t = fakeTransport([body(200, 'x'.repeat(10), {'content-length': '999999'})]);
    const result = await fetchPackFile(OK, {limit: 100, request: t.get});
    assert.strictEqual(result.error, 'too-large');
    assert.ok(t.state.destroyed > 0, 'the response is destroyed');
});

test('a LYING content-length does not get past the running total', async () => {
    // The cap is enforced while reading as well, so a server that understates
    // its length still cannot overrun it.
    const t = fakeTransport({
        0: {status: 200, headers: {'content-length': '5'}, chunks: ['aaaaa', 'bbbbb', 'ccccc']},
        length: 1
    });
    const result = await fetchPackFile(OK, {limit: 10, request: t.get});
    assert.strictEqual(result.error, 'too-large');
    assert.strictEqual(result.bytes, null);
});

test('a body exactly at the cap is fine; one byte over is not', async () => {
    const at = fakeTransport([body(200, 'x'.repeat(10))]);
    assert.ok((await fetchPackFile(OK, {limit: 10, request: at.get})).ok);
    const over = fakeTransport([body(200, 'x'.repeat(11))]);
    assert.strictEqual((await fetchPackFile(OK, {limit: 10, request: over.get})).error, 'too-large');
});

test('no cap supplied is the strictest cap, not none', async () => {
    const t = fakeTransport([body(200, 'x', {'content-length': String(rules.LIMITS.image)})]);
    const result = await fetchPackFile(OK, {request: t.get});
    assert.strictEqual(result.error, 'too-large', 'the index cap applied, not the image cap');
});

test('the socket timeout, the overall deadline and a transport error are values', async () => {
    const stalled = fakeTransport([{timeout: true}]);
    assert.strictEqual((await fetchPackFile(OK, {limit: 16, request: stalled.get})).error, 'socket-timeout');

    // Nothing ever happens: only the overall deadline ends this, which is the
    // case a socket-inactivity timeout never fires on.
    const silent = fakeTransport([{silent: true}]);
    const result = await fetchPackFile(OK, {limit: 16, timeoutMs: 30, request: silent.get});
    assert.strictEqual(result.error, 'timeout');
    assert.ok(silent.state.destroyed > 0);

    const broken = fakeTransport([{error: 'ENOTFOUND'}]);
    assert.strictEqual((await fetchPackFile(OK, {limit: 16, request: broken.get})).error, 'net:ENOTFOUND');

    const throwing = fakeTransport([{throws: true}]);
    assert.strictEqual((await fetchPackFile(OK, {limit: 16, request: throwing.get})).error,
        'request:ERR_INVALID_ARG');
});

test('an aborted or failing body is reported, never left hanging', async () => {
    const aborted = fakeTransport([{status: 200, headers: {}, chunks: ['half'], aborted: true}]);
    assert.strictEqual((await fetchPackFile(OK, {limit: 64, request: aborted.get})).error, 'aborted');

    const failed = fakeTransport([{status: 200, headers: {}, chunks: ['half'], bodyError: true}]);
    assert.strictEqual((await fetchPackFile(OK, {limit: 64, request: failed.get})).error, 'body:EBODY');
});

test('a deadline already spent never opens a socket', async () => {
    const t = fakeTransport([body(200, 'x')]);
    const result = await fetchPackFile(OK, {limit: 16, timeoutMs: -1, request: t.get});
    assert.strictEqual(result.error, 'timeout');
    assert.deepStrictEqual(t.calls, []);
});
