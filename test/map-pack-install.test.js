const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const MapPackStore = require('../src/core/map-pack-store');
const {checkForPacks} = require('../src/core/map-pack-install');
const rules = require('../src/shared/map-pack-rules');

/*
 * The whole install, driven with an injected `fetch` — no network, no
 * electron. Every test below is "a hostile or broken pack is discarded whole
 * and the previously installed good version stays".
 *
 * Templates are built at size 4 rather than the matcher's 64 so the fixtures
 * stay readable; `test/map-pack-rules.test.js` covers the real size.
 */

const SIZE = 4;
const KEY = 'someone/Test Map';
const DIR = rules.packDirName(KEY);
const BASE = 'test-map';
const APP_VERSION = '0.7.0';

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'hmo-install-'));
}

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** A whole PNG of a blank image — signature, IHDR, deflated pixels, IEND. */
function pngBytes(width, height) {
    const chunk = (type, data) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length, 0);
        const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(zlib.crc32(body), 0);
        return Buffer.concat([length, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(Buffer.alloc(height * (width + 1)))),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

/** Just the signature and IHDR: a header with no image behind it. */
function pngHeaderOnly(width, height) {
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write('IHDR', 4);
    ihdr.writeUInt32BE(width, 8);
    ihdr.writeUInt32BE(height, 12);
    ihdr[16] = 8;
    ihdr[17] = 6;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}

/** `image-size` is header-only, so the fixture above is enough for it. */
function probeImage(bytes) {
    return require('image-size').imageSize(bytes);
}

/**
 * A whole publishable pack: the files, the manifest and the index entry, all
 * consistent with each other — the shape `scripts/build-pack.js` produces.
 *
 * @param {{key?, version?, minAppVersion?, markers?, variants?}} [over]
 */
function buildPack(over) {
    const options = over || {};
    const key = options.key || KEY;
    const name = key.split('/')[1];
    const image = `${name}.png`;
    const files = {};
    files[image] = pngBytes(600, 600);
    files[rules.TEMPLATES_NAME] = Buffer.from(JSON.stringify({
        format: 2,
        size: SIZE,
        templates: {[key]: (options.variants || [1]).map(() => new Array(SIZE * SIZE).fill(0.5))}
    }), 'utf-8');
    if (options.markers) {
        files[rules.MARKERS_NAME] = Buffer.from(JSON.stringify(options.markers), 'utf-8');
    }
    const listed = Object.entries(files).map(([n, bytes]) => ({
        name: n, bytes: bytes.length, sha256: sha256(bytes)
    }));
    const manifest = {
        formatVersion: 1,
        key,
        name,
        creator: key.split('/')[0],
        credit: null,
        version: options.version || 1,
        minAppVersion: options.minAppVersion || null,
        image,
        markers: options.markers ? rules.MARKERS_NAME : null,
        files: listed
    };
    files[rules.MANIFEST_NAME] = Buffer.from(JSON.stringify(manifest), 'utf-8');
    return {
        key,
        image,
        files,
        manifest,
        base: options.base || BASE,
        entry: {
            key,
            version: manifest.version,
            minAppVersion: manifest.minAppVersion,
            base: options.base || BASE,
            files: listed
        }
    };
}

/**
 * A `fetch` that serves the given packs and records every URL asked for.
 * Anything not on the menu is a 404, exactly as GitHub raw would answer.
 */
function fakeNetwork(packs, overrides) {
    const served = {};
    for (const pack of packs) {
        for (const [name, bytes] of Object.entries(pack.files)) {
            served[`${pack.base}/${name}`] = bytes;
        }
    }
    const index = Buffer.from(JSON.stringify({
        formatVersion: 1,
        packs: packs.map(p => p.entry)
    }), 'utf-8');

    const calls = [];
    const fetch = async (url, opts) => {
        calls.push({url, limit: opts && opts.limit});
        if (overrides && overrides[url] !== undefined) return overrides[url];
        if (url === rules.INDEX_URL) {
            return {ok: true, bytes: (overrides && overrides.index) || index, status: 200, error: null};
        }
        const prefix = 'https://raw.githubusercontent.com/Davide-DevP/halloween-map-overlay/main/packs/';
        if (!url.startsWith(prefix)) return {ok: false, bytes: null, status: 0, error: 'url-not-allowed'};
        // The derived URL percent-encodes the file name; the fixtures are
        // keyed by the plain one.
        const relative = decodeURIComponent(url.slice(prefix.length));
        if (overrides && overrides[relative] !== undefined) {
            const value = overrides[relative];
            if (Buffer.isBuffer(value)) return {ok: true, bytes: value, status: 200, error: null};
            return value;
        }
        const bytes = served[relative];
        if (!bytes) return {ok: false, bytes: null, status: 404, error: 'http-404'};
        return {ok: true, bytes, status: 200, error: null};
    };
    return {fetch, calls, index};
}

function run(root, packs, overrides, appVersion) {
    const store = new MapPackStore(root, {appVersion: appVersion || APP_VERSION, templateSize: SIZE});
    const net = fakeNetwork(packs, overrides);
    const events = [];
    return checkForPacks({
        store,
        fetch: net.fetch,
        appVersion: appVersion || APP_VERSION,
        probeImage,
        log: (event, fields) => events.push(Object.assign({event}, fields))
    }).then(result => ({result, store, net, events}));
}

/** Nothing installed, and no staging folder left behind. */
function assertNothingInstalled(root, store) {
    store.invalidate();
    assert.deepStrictEqual(store.list(), []);
    const leftovers = fs.readdirSync(root).filter(n => n.startsWith('.staging-') || n.startsWith('.old-'));
    assert.deepStrictEqual(leftovers, [], 'a failed install leaves no staging folder');
}

/* ────────────────────────────────────────────────────────────────────────── */

test('the happy path: one pack is fetched, verified and installed', async () => {
    const root = tempDir();
    const pack = buildPack({markers: {layers: {chests: [{x: 0.5, y: 0.5}]}}});
    const {result, store, events} = await run(root, [pack]);

    assert.ok(result.ok, result.error);
    assert.deepStrictEqual(result.installed, [{key: KEY, version: 1}]);
    assert.deepStrictEqual(result.failed, []);

    store.invalidate();
    const installed = store.list();
    assert.strictEqual(installed.length, 1);
    assert.strictEqual(installed[0].key, KEY);
    assert.strictEqual(installed[0].dir, DIR);
    // Everything the pack promised is on disk, and nothing else.
    assert.deepStrictEqual(fs.readdirSync(path.join(root, DIR)).sort(),
        ['Test Map.png', 'markers.json', 'pack.json', 'templates.json']);
    // The templates and the markers load back through the store.
    assert.strictEqual(store.readTemplates(installed[0]).variants, 1);
    assert.deepStrictEqual(store.readMarkers(installed[0]), {layers: {chests: [{x: 0.5, y: 0.5}]}});
    // The pack's key is logged in full — it is catalogue data, not user text.
    const line = events.find(e => e.event === 'map-pack-installed');
    assert.strictEqual(line.key, KEY);
});

test('every URL is derived from the index base plus a validated name', async () => {
    const root = tempDir();
    const pack = buildPack();
    const {net} = await run(root, [pack]);
    const prefix = 'https://raw.githubusercontent.com/Davide-DevP/halloween-map-overlay/main/packs/';
    assert.deepStrictEqual(net.calls.map(c => c.url), [
        rules.INDEX_URL,
        `${prefix}${BASE}/${rules.MANIFEST_NAME}`,
        `${prefix}${BASE}/Test%20Map.png`,
        `${prefix}${BASE}/${rules.TEMPLATES_NAME}`
    ]);
    // Every request carries its own cap, and every one of them is on the
    // allow-list.
    for (const call of net.calls) {
        assert.ok(rules.isAllowedUrl(call.url), call.url);
        assert.ok(call.limit > 0, call.url);
    }
    assert.strictEqual(net.calls[0].limit, rules.LIMITS.index);
    assert.strictEqual(net.calls[1].limit, rules.LIMITS.manifest);
    assert.strictEqual(net.calls[2].limit, rules.LIMITS.image);
    assert.strictEqual(net.calls[3].limit, rules.LIMITS.templates);
});

test('a wrong hash discards the whole pack', async () => {
    const root = tempDir();
    const pack = buildPack();
    // The right length, different bytes: only the digest catches this.
    const swapped = Buffer.from(pack.files['Test Map.png']);
    swapped[20] = swapped[20] ^ 0xff;
    const {result, store} = await run(root, [pack], {[`${BASE}/Test Map.png`]: swapped});
    assert.ok(result.ok, 'the check itself worked');
    assert.deepStrictEqual(result.installed, []);
    assert.strictEqual(result.failed[0].reason, 'sha256:Test Map.png');
    assertNothingInstalled(root, store);
});

test('a wrong size discards the whole pack', async () => {
    const root = tempDir();
    const pack = buildPack();
    const truncated = pack.files[rules.TEMPLATES_NAME].subarray(0, 40);
    const {result, store} = await run(root, [pack], {[`${BASE}/templates.json`]: truncated});
    assert.strictEqual(result.failed[0].reason, 'bytes:templates.json');
    assertNothingInstalled(root, store);
});

test('a file the network refused as oversize discards the pack', async () => {
    const root = tempDir();
    const pack = buildPack();
    const {result, store} = await run(root, [pack], {
        [`${BASE}/Test Map.png`]: {ok: false, bytes: null, status: 200, error: 'too-large'}
    });
    assert.strictEqual(result.failed[0].reason, 'fetch:Test Map.png:too-large');
    assertNothingInstalled(root, store);
});

test('an image that is not a PNG, or an absurd one, is refused', async () => {
    const root = tempDir();
    // Not a PNG at all: an executable dressed as one.
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]);
    let pack = buildPack();
    pack.manifest.files.find(f => f.name === 'Test Map.png').bytes = exe.length;
    pack.manifest.files.find(f => f.name === 'Test Map.png').sha256 = sha256(exe);
    pack.entry.files = pack.manifest.files;
    pack.files[rules.MANIFEST_NAME] = Buffer.from(JSON.stringify(pack.manifest), 'utf-8');
    pack.files['Test Map.png'] = exe;
    let out = await run(root, [pack], {});
    assert.strictEqual(out.result.failed[0].reason, 'not-a-png');
    assertNothingInstalled(root, out.store);

    // A real PNG header claiming 1x1 — nothing a map overlay could be.
    const root2 = tempDir();
    const tiny = pngBytes(1, 1);
    pack = buildPack();
    const listed = pack.manifest.files.find(f => f.name === 'Test Map.png');
    listed.bytes = tiny.length;
    listed.sha256 = sha256(tiny);
    pack.entry.files = pack.manifest.files;
    pack.files[rules.MANIFEST_NAME] = Buffer.from(JSON.stringify(pack.manifest), 'utf-8');
    pack.files['Test Map.png'] = tiny;
    out = await run(root2, [pack], {});
    assert.strictEqual(out.result.failed[0].reason, 'image-size');
    assertNothingInstalled(root2, out.store);
});

test('templates the matcher could not use are refused before they are written', async () => {
    const root = tempDir();
    const pack = buildPack();
    // The array length the matcher indexes into, filled with NaN-producing
    // nulls: one of them would make every map score NaN.
    const poisoned = Buffer.from(JSON.stringify({
        format: 2, size: SIZE, templates: {[KEY]: [new Array(SIZE * SIZE).fill(null)]}
    }), 'utf-8');
    const listed = pack.manifest.files.find(f => f.name === rules.TEMPLATES_NAME);
    listed.bytes = poisoned.length;
    listed.sha256 = sha256(poisoned);
    pack.entry.files = pack.manifest.files;
    pack.files[rules.MANIFEST_NAME] = Buffer.from(JSON.stringify(pack.manifest), 'utf-8');
    pack.files[rules.TEMPLATES_NAME] = poisoned;

    const {result, store} = await run(root, [pack], {});
    assert.strictEqual(result.failed[0].reason, 'templates:variant-not-finite');
    assertNothingInstalled(root, store);
});

test('a manifest that disagrees with the index is refused', async () => {
    const root = tempDir();
    const pack = buildPack();
    const lying = Object.assign({}, pack.manifest, {version: 99});
    const {result, store} = await run(root, [pack], {
        [`${BASE}/pack.json`]: Buffer.from(JSON.stringify(lying), 'utf-8')
    });
    assert.strictEqual(result.failed[0].reason, 'manifest:version-mismatch');
    assertNothingInstalled(root, store);
});

test('a traversal file name never reaches the network, let alone the disk', async () => {
    const root = tempDir();
    const pack = buildPack();
    pack.entry.files = pack.entry.files.concat([
        {name: '../../../settings-app.json', bytes: 10, sha256: 'c'.repeat(64)}
    ]);
    const {result, store, net} = await run(root, [pack], {});
    // The index validator drops the entry outright, so no pack is even tried.
    assert.ok(result.ok);
    assert.deepStrictEqual(result.installed, []);
    assert.deepStrictEqual(net.calls.map(c => c.url), [rules.INDEX_URL]);
    assertNothingInstalled(root, store);
});

test('a file the format has no meaning for is refused rather than stored', async () => {
    const root = tempDir();
    const extra = Buffer.from('{}', 'utf-8');
    const pack = buildPack();
    pack.manifest.files.push({name: 'extra.json', bytes: extra.length, sha256: sha256(extra)});
    pack.entry.files = pack.manifest.files;
    pack.files[rules.MANIFEST_NAME] = Buffer.from(JSON.stringify(pack.manifest), 'utf-8');
    pack.files['extra.json'] = extra;
    const {result, store} = await run(root, [pack], {});
    assert.strictEqual(result.failed[0].reason, 'unknown-file:extra.json');
    assertNothingInstalled(root, store);
});

test('minAppVersion too new: skipped, never downloaded', async () => {
    const root = tempDir();
    const pack = buildPack({minAppVersion: '9.9.9'});
    const {result, net, store} = await run(root, [pack], {});
    assert.ok(result.ok);
    assert.deepStrictEqual(result.installed, []);
    assert.deepStrictEqual(result.skipped, [{key: KEY, reason: 'needs-app', version: 1}]);
    assert.deepStrictEqual(net.calls.map(c => c.url), [rules.INDEX_URL]);
    assertNothingInstalled(root, store);
});

test('up-to-date and downgrade are both no-ops that keep what is installed', async () => {
    const root = tempDir();
    // Install v3 first.
    await run(root, [buildPack({version: 3})]);
    const store = new MapPackStore(root, {appVersion: APP_VERSION, templateSize: SIZE});
    assert.strictEqual(store.list()[0].version, 3);

    // The index now offers the same version…
    let out = await run(root, [buildPack({version: 3})]);
    assert.deepStrictEqual(out.result.skipped, [{key: KEY, reason: 'up-to-date', version: 3}]);
    assert.deepStrictEqual(out.net.calls.map(c => c.url), [rules.INDEX_URL]);

    // …and then an older one, which a botched revert of the index looks like.
    out = await run(root, [buildPack({version: 2})]);
    assert.deepStrictEqual(out.result.skipped, [{key: KEY, reason: 'downgrade', version: 2}]);
    out.store.invalidate();
    assert.strictEqual(out.store.list()[0].version, 3, 'the newer installed version stays');
});

test('a failed upgrade leaves the previously installed good version alone', async () => {
    const root = tempDir();
    await run(root, [buildPack({version: 1})]);
    const imageBefore = fs.readFileSync(path.join(root, DIR, 'Test Map.png'));

    const v2 = buildPack({version: 2});
    const corrupt = Buffer.from(v2.files[rules.TEMPLATES_NAME]);
    corrupt[10] = corrupt[10] === 0x20 ? 0x21 : 0x20;
    const {result, store} = await run(root, [v2], {[`${BASE}/templates.json`]: corrupt});

    assert.strictEqual(result.failed[0].reason, 'sha256:templates.json');
    store.invalidate();
    const installed = store.list();
    assert.strictEqual(installed.length, 1);
    assert.strictEqual(installed[0].version, 1);
    assert.deepStrictEqual(fs.readFileSync(path.join(root, DIR, 'Test Map.png')), imageBefore);
    assert.deepStrictEqual(fs.readdirSync(root).filter(n => n.startsWith('.')), []);
});

test('a PNG header with no image behind it is refused', async () => {
    const root = tempDir();
    const header = pngHeaderOnly(8192, 8192);
    assert.ok(rules.hasPngSignature(header));
    assert.ok(rules.isSaneImageSize(probeImage(header)), 'it passes every other check');

    const pack = buildPack();
    const listed = pack.manifest.files.find(f => f.name === 'Test Map.png');
    listed.bytes = header.length;
    listed.sha256 = sha256(header);
    pack.entry.files = pack.manifest.files;
    pack.files[rules.MANIFEST_NAME] = Buffer.from(JSON.stringify(pack.manifest), 'utf-8');
    pack.files['Test Map.png'] = header;

    const {result, store} = await run(root, [pack], {});
    assert.strictEqual(result.failed[0].reason, 'image-truncated');
    assertNothingInstalled(root, store);
});

test('no image decoder is a configuration error, not a reduced mode', async () => {
    // It used to be optional, which made "the dimensions are checked"
    // conditional on the caller remembering to pass a decoder.
    const root = tempDir();
    const store = new MapPackStore(root, {appVersion: APP_VERSION, templateSize: SIZE});
    const net = fakeNetwork([buildPack()]);
    const result = await checkForPacks({store, fetch: net.fetch, appVersion: APP_VERSION});
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'not-configured');
    assert.deepStrictEqual(net.calls, [], 'nothing is even requested');
});

test('a fetch that THROWS is a failed check, not a thrown one', async () => {
    // The contract is "never throws", and the injected fetch is the one piece
    // of somebody else's code in it.
    const root = tempDir();
    const store = new MapPackStore(root, {appVersion: APP_VERSION, templateSize: SIZE});
    const boom = async () => { throw Object.assign(new Error('nope'), {code: 'EBOOM'}); };
    const result = await checkForPacks({store, fetch: boom, appVersion: APP_VERSION, probeImage});
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'threw:EBOOM');

    // …and the same for a fetch that answers with nonsense.
    for (const [answer, error] of [
        [async () => null, 'no-response'],
        [async () => 'yes', 'no-response'],
        [async () => ({ok: true, bytes: 'not a buffer'}), 'no-bytes']
    ]) {
        const out = await checkForPacks({store, fetch: answer, appVersion: APP_VERSION, probeImage});
        assert.strictEqual(out.ok, false);
        assert.strictEqual(out.error, error);
    }
});

test('a 404 on the index is "nothing published yet", not a failure', async () => {
    // Which is the state the repository is in until the first pack ships, so
    // it must not raise "could not check" or shorten the retry as if the
    // network were broken.
    const root = tempDir();
    const {result, store} = await run(root, [], {
        [rules.INDEX_URL]: {ok: false, bytes: null, status: 404, error: 'http-404'}
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.notPublished, true);
    assert.strictEqual(result.error, null);
    assert.deepStrictEqual(result.installed, []);
    assertNothingInstalled(root, store);
});

test('the overall deadline stops the check instead of holding it for hours', async () => {
    // 200 packs x 4 files x a 30 s per-request timeout is hours, and the
    // single-flight flag is held for all of it — the button would be dead.
    const root = tempDir();
    const a = buildPack({key: 'someone/A Map', base: 'a'});
    const b = buildPack({key: 'someone/B Map', base: 'b'});
    const store = new MapPackStore(root, {appVersion: APP_VERSION, templateSize: SIZE});
    const net = fakeNetwork([a, b]);
    const result = await checkForPacks({
        store, fetch: net.fetch, appVersion: APP_VERSION, probeImage,
        // Already spent: the index is fetched, then nothing is installed.
        deadlineMs: -1
    });
    assert.ok(result.ok);
    assert.deepStrictEqual(result.installed, []);
    assert.deepStrictEqual(result.skipped.map(s => s.reason), ['deadline', 'deadline']);
    store.invalidate();
    assert.deepStrictEqual(store.list(), []);
});

test('an index that is not JSON, or not an index, installs nothing', async () => {
    for (const body of ['not json', '[]', '{}', JSON.stringify({formatVersion: 2, packs: []})]) {
        const root = tempDir();
        const {result, store} = await run(root, [], {index: Buffer.from(body, 'utf-8')});
        assert.strictEqual(result.ok, false, body);
        assert.ok(result.error, body);
        assertNothingInstalled(root, store);
    }
});

test('a network failure is a value, never a throw', async () => {
    const root = tempDir();
    const {result, store} = await run(root, [], {
        [rules.INDEX_URL]: {ok: false, bytes: null, status: 0, error: 'net:ENOTFOUND'}
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'net:ENOTFOUND');
    assertNothingInstalled(root, store);
});

test('one bad pack does not stop a good one in the same index', async () => {
    const root = tempDir();
    const good = buildPack({key: 'someone/Good Map', base: 'good'});
    const bad = buildPack({key: 'someone/Bad Map', base: 'bad'});
    const {result, store} = await run(root, [good, bad], {
        'bad/Bad Map.png': {ok: false, bytes: null, status: 404, error: 'http-404'}
    });
    assert.ok(result.ok);
    assert.deepStrictEqual(result.installed, [{key: 'someone/Good Map', version: 1}]);
    assert.strictEqual(result.failed[0].key, 'someone/Bad Map');
    store.invalidate();
    assert.deepStrictEqual(store.list().map(p => p.key), ['someone/Good Map']);
});

test('nothing is configured: a value, not a crash', async () => {
    const result = await checkForPacks({});
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'not-configured');
});
