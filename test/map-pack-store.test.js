const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const MapPackStore = require('../src/core/map-pack-store');
const rules = require('../src/shared/map-pack-rules');

/*
 * The fs half of map packs. No electron anywhere — the directory is injected,
 * which is exactly what lets these tests run against `mkdtemp`.
 *
 * The templates are built at size 4 (16 numbers) rather than the matcher's 64
 * (4096) so the fixtures stay readable; the store takes the size as an option
 * for that reason, and `test/map-pack-rules.test.js` covers the real one.
 */

const SIZE = 4;
const KEY = 'someone/Test Map';
const DIR = rules.packDirName(KEY);

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'hmo-packs-'));
}

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * A real, complete PNG of a blank image: signature, IHDR, a deflated all-zero
 * image and IEND, every chunk with its own CRC.
 *
 * A bare signature + IHDR would be shorter, and that is exactly what the
 * installer now refuses (`isPlausiblePngBytes`) — a header with no pixels
 * behind it installs and leaves the map blank. So the fixtures are whole files.
 */
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
    ihdr[8] = 8;    // bit depth
    ihdr[9] = 0;    // colour type: greyscale
    // One filter byte per row, then the row itself — all zeroes.
    const raw = Buffer.alloc(height * (width + 1));
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

function templatesBytes(key, variants) {
    return Buffer.from(JSON.stringify({
        format: 2,
        size: SIZE,
        templates: {[key]: (variants || [1]).map(() => new Array(SIZE * SIZE).fill(0.5))}
    }), 'utf-8');
}

/**
 * Write a complete, valid pack into `dir` and return its manifest.
 * @param {{key?, version?, minAppVersion?, markers?, dirName?}} [over]
 */
function writePack(root, over) {
    const options = over || {};
    const key = options.key || KEY;
    const name = key.split('/')[1];
    const image = `${name}.png`;
    const dirName = options.dirName || rules.packDirName(key);
    const dir = path.join(root, dirName);
    fs.mkdirSync(dir, {recursive: true});

    const files = [
        {name: image, bytes: pngBytes(600, 600)},
        {name: rules.TEMPLATES_NAME, bytes: templatesBytes(key, options.variants)}
    ];
    if (options.markers) {
        files.push({name: rules.MARKERS_NAME, bytes: Buffer.from(JSON.stringify(options.markers), 'utf-8')});
    }
    const listed = files.map(f => ({name: f.name, bytes: f.bytes.length, sha256: sha256(f.bytes)}));
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
    for (const file of files) fs.writeFileSync(path.join(dir, file.name), file.bytes);
    fs.writeFileSync(path.join(dir, rules.MANIFEST_NAME), JSON.stringify(manifest));
    return {dir, dirName, manifest, files};
}

function store(root) {
    return new MapPackStore(root, {appVersion: '0.7.0', templateSize: SIZE});
}

/* ────────────────────────────────────────────────────────────────────────── */

test('list: nothing at all is an empty list, not a throw', () => {
    const s = store(path.join(tempDir(), 'never-created'));
    assert.deepStrictEqual(s.list(), []);
    assert.deepStrictEqual(store(null).list(), []);
});

test('list: a valid pack is read back whole', () => {
    const root = tempDir();
    writePack(root, {markers: {layers: {chests: [{x: 0.5, y: 0.5}]}}});
    const packs = store(root).list();
    assert.strictEqual(packs.length, 1);
    assert.strictEqual(packs[0].key, KEY);
    assert.strictEqual(packs[0].name, 'Test Map');
    assert.strictEqual(packs[0].creator, 'someone');
    assert.strictEqual(packs[0].version, 1);
    assert.strictEqual(packs[0].dir, DIR);
    assert.strictEqual(packs[0].image, 'Test Map.png');
    assert.strictEqual(packs[0].markers, rules.MARKERS_NAME);
});

test('list: packs are re-validated on every start, not trusted', () => {
    const root = tempDir();
    const pack = writePack(root);

    // A file edited in place — the size no longer matches the manifest.
    fs.appendFileSync(path.join(pack.dir, rules.TEMPLATES_NAME), ' ');
    let s = store(root);
    assert.deepStrictEqual(s.list(), []);
    assert.strictEqual(s.skipped[0].reason, `bytes:${rules.TEMPLATES_NAME}`);

    // A file the manifest promises and that is not there.
    const root2 = tempDir();
    const pack2 = writePack(root2);
    fs.unlinkSync(path.join(pack2.dir, 'Test Map.png'));
    s = store(root2);
    assert.deepStrictEqual(s.list(), []);
    assert.strictEqual(s.skipped[0].reason, 'missing:Test Map.png');
});

test('list: a file corrupted IN PLACE is caught — the size is not enough', () => {
    // The failure the size-only check missed: a power cut or a bad sector
    // zero-fills a sector of `map.png` without changing its length. The pack
    // then passed re-validation, was offered to the catalogue, and (for a pack
    // replacing a bundled map) left that map permanently blank while the next
    // check reported "up to date" — it could never heal.
    const root = tempDir();
    const pack = writePack(root);
    const image = path.join(pack.dir, 'Test Map.png');
    const bytes = fs.readFileSync(image);
    const same = Buffer.from(bytes);
    same.fill(0, 40, 60);
    assert.strictEqual(same.length, bytes.length, 'the fixture must keep its size');

    fs.writeFileSync(image, same);
    const s = store(root);
    assert.deepStrictEqual(s.list(), [], 'the damaged pack is not offered');
    assert.strictEqual(s.skipped[0].reason, 'sha256:Test Map.png');
    // …and because it is not in `list()`, it is not in the installed set the
    // next check compares against, so the pack is downloaded again.
    assert.ok(!s.list().some(p => p.key === KEY));
});

test('list: a manifest that is not JSON, or not a manifest, is skipped', () => {
    const root = tempDir();
    const pack = writePack(root);
    fs.writeFileSync(path.join(pack.dir, rules.MANIFEST_NAME), '{not json');
    let s = store(root);
    assert.deepStrictEqual(s.list(), []);
    assert.strictEqual(s.skipped[0].reason, 'manifest-not-json');

    const root2 = tempDir();
    const pack2 = writePack(root2);
    fs.unlinkSync(path.join(pack2.dir, rules.MANIFEST_NAME));
    s = store(root2);
    assert.deepStrictEqual(s.list(), []);
    assert.strictEqual(s.skipped[0].reason, 'no-manifest');
});

test('list: a folder somebody renamed cannot claim a key', () => {
    // The directory name is derived from the key; two folders could otherwise
    // claim one map.
    const root = tempDir();
    writePack(root, {dirName: 'something-else'});
    const s = store(root);
    assert.deepStrictEqual(s.list(), []);
    assert.strictEqual(s.skipped[0].reason, 'dir-key-mismatch');
});

test('list: a pack that needs a newer app is not offered', () => {
    const root = tempDir();
    writePack(root, {minAppVersion: '9.0.0'});
    const s = store(root);
    assert.deepStrictEqual(s.list(), []);
    assert.strictEqual(s.skipped[0].reason, 'needs-app:9.0.0');
});

test('list: state.json and the staging folders are not packs', () => {
    const root = tempDir();
    writePack(root);
    const s = store(root);
    s.writeState({lastCheckAt: 5});
    fs.mkdirSync(path.join(root, '.staging-abc'));
    fs.mkdirSync(path.join(root, '.old-abc'));
    s.invalidate();
    assert.deepStrictEqual(s.list().map(p => p.key), [KEY]);
    assert.deepStrictEqual(s.skipped, []);
});

test('readTemplates / readMarkers: validated, never required()', () => {
    const root = tempDir();
    writePack(root, {variants: [1, 2], markers: {layers: {chests: [{x: 0.1, y: 0.2}]}}});
    const s = store(root);
    const pack = s.list()[0];

    const templates = s.readTemplates(pack);
    assert.strictEqual(templates.key, KEY);
    assert.strictEqual(templates.variants, 2);
    assert.strictEqual(templates.templates[KEY][0].length, SIZE * SIZE);

    assert.deepStrictEqual(s.readMarkers(pack), {layers: {chests: [{x: 0.1, y: 0.2}]}});
});

test('readTemplates: a templates file the matcher could not use is null', () => {
    const root = tempDir();
    const pack = writePack(root);
    const s = store(root);
    const entry = s.list()[0];
    // Rewritten after the manifest check, so this is purely the content check.
    fs.writeFileSync(path.join(pack.dir, rules.TEMPLATES_NAME), JSON.stringify({
        format: 2, size: SIZE, templates: {[KEY]: [new Array(SIZE * SIZE).fill(null)]}
    }));
    assert.strictEqual(s.readTemplates(entry), null);
});

test('filePath: only a name a pack may contain', () => {
    const root = tempDir();
    const s = store(root);
    const pack = {dir: DIR};
    assert.strictEqual(s.filePath(pack, 'a.png'), path.join(root, DIR, 'a.png'));
    for (const name of ['../../etc/passwd', 'a/b.png', 'a.exe', '']) {
        assert.strictEqual(s.filePath(pack, name), null, name);
    }
});

/* ── install ──────────────────────────────────────────────────────────────── */

test('staging: a fresh hidden folder inside the packs directory', () => {
    const root = path.join(tempDir(), 'packs');
    const s = store(root);
    const a = s.staging();
    const b = s.staging();
    assert.ok(a && b && a !== b);
    // Inside userData, never %TEMP% — see the spec.
    assert.strictEqual(path.dirname(a), root);
    assert.ok(path.basename(a).startsWith('.staging-'));
    assert.ok(fs.existsSync(a));
});

test('commit: a first install lands under the derived directory name', () => {
    const root = tempDir();
    const s = store(root);
    const staging = s.staging();
    fs.writeFileSync(path.join(staging, 'x.txt'), 'hello');
    const result = s.commit(staging, KEY);
    assert.ok(result.ok, result.error);
    assert.strictEqual(result.dir, DIR);
    assert.strictEqual(fs.readFileSync(path.join(root, DIR, 'x.txt'), 'utf-8'), 'hello');
    assert.strictEqual(fs.existsSync(staging), false);
});

test('commit: an upgrade replaces the whole directory, leaving no leftovers', () => {
    const root = tempDir();
    const s = store(root);
    writePack(root, {version: 1});
    fs.writeFileSync(path.join(root, DIR, 'stale.json'), '{}');

    const staging = s.staging();
    // A complete v2 built in staging, exactly as the installer does it.
    const built = writePack(path.dirname(staging), {version: 2, dirName: path.basename(staging)});
    assert.ok(built);
    assert.ok(s.commit(staging, KEY).ok);

    const packs = s.list();
    assert.strictEqual(packs.length, 1);
    assert.strictEqual(packs[0].version, 2);
    assert.strictEqual(fs.existsSync(path.join(root, DIR, 'stale.json')), false,
        'the old directory is gone, not merged');
    assert.deepStrictEqual(fs.readdirSync(root).filter(n => n.startsWith('.old-')), []);
});

test('commit: a swap that fails puts the previous version back', () => {
    const root = tempDir();
    const s = store(root);
    writePack(root, {version: 3});
    // A staging directory that is not there: the second rename throws, so the
    // parked copy has to be restored.
    const result = s.commit(path.join(root, '.staging-does-not-exist'), KEY);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.startsWith('swap:'), result.error);
    const packs = s.list();
    assert.strictEqual(packs.length, 1, 'the good version is still installed');
    assert.strictEqual(packs[0].version, 3);
});

test('commit: a directory that belongs to another key is refused', () => {
    // `packDirName` folds punctuation, so `someone/Test Map` and
    // `someone/Test-Map` are two keys with one directory. Without this check
    // they overwrite each other on every check, forever, each one making the
    // other map vanish — with a toast and a gallery refresh every time.
    const root = tempDir();
    const s = store(root);
    writePack(root, {key: KEY});
    const other = 'someone/Test-Map';
    assert.strictEqual(rules.packDirName(other), DIR, 'the fixture must actually collide');

    const staging = s.staging();
    fs.writeFileSync(path.join(staging, 'x.txt'), 'intruder');
    const result = s.commit(staging, other);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'dir-owned-by-other-key');
    // The map that was there is exactly as it was.
    assert.deepStrictEqual(s.list().map(p => p.key), [KEY]);
    assert.strictEqual(fs.existsSync(path.join(root, DIR, 'x.txt')), false);
});

test('commit: an unreadable manifest in the way does not block the install', () => {
    // A half-written pack must be able to heal, so "nobody can tell whose this
    // is" is not a claim on the directory.
    const root = tempDir();
    const s = store(root);
    const pack = writePack(root);
    fs.writeFileSync(path.join(pack.dir, rules.MANIFEST_NAME), '{ truncated');
    const staging = s.staging();
    writePack(path.dirname(staging), {version: 2, dirName: path.basename(staging)});
    assert.ok(s.commit(staging, KEY).ok);
    assert.strictEqual(s.list()[0].version, 2);
});

test('commit: a key a pack may not claim installs nothing', () => {
    const root = tempDir();
    const s = store(root);
    const staging = s.staging();
    assert.strictEqual(s.commit(staging, 'Custom/Mine').ok, false);
    assert.strictEqual(s.commit(staging, '../escape').ok, false);
    assert.deepStrictEqual(fs.readdirSync(root).filter(n => !n.startsWith('.')), []);
});

test('sweep: staging goes, and a parked copy whose live folder is there goes too', () => {
    const root = tempDir();
    writePack(root);
    fs.mkdirSync(path.join(root, '.staging-1'));
    // A parked copy of a swap that *completed*: the live folder exists, so this
    // is the old version and is dead weight.
    fs.mkdirSync(path.join(root, `.old-aaaaaaaaaaaa-${DIR}`));
    const s = store(root);
    assert.deepStrictEqual(s.sweep(), {removed: 2, restored: 0});
    assert.deepStrictEqual(fs.readdirSync(root).sort(), [DIR]);
    assert.deepStrictEqual(store(path.join(root, 'nope')).sweep(), {removed: 0, restored: 0});
});

test('sweep: a parked copy whose live folder is GONE is restored, not deleted', () => {
    // The crash window: the process died between `rename(live, parked)` and
    // `rename(staging, live)`, so this folder is the only copy of the pack.
    // Deleting it (which the first draft did) lost an installed map for good.
    const root = tempDir();
    const pack = writePack(root, {version: 4});
    const parked = path.join(root, `.old-bbbbbbbbbbbb-${DIR}`);
    fs.renameSync(pack.dir, parked);

    const s = store(root);
    assert.deepStrictEqual(s.sweep(), {removed: 0, restored: 1});
    assert.deepStrictEqual(fs.readdirSync(root).sort(), [DIR]);
    // And it is a working pack afterwards, not just a folder.
    assert.strictEqual(s.list()[0].version, 4);
});

test('sweep: a folder that only looks parked is left alone', () => {
    const root = tempDir();
    for (const name of ['.old', '.old-', '.old-zz-x', '.old-aaaaaaaaaaaa', '.oldish-x', '.other']) {
        fs.mkdirSync(path.join(root, name));
    }
    assert.deepStrictEqual(store(root).sweep(), {removed: 0, restored: 0});
    assert.strictEqual(fs.readdirSync(root).length, 6);
    // The parser is the single source for what a parked name is.
    assert.strictEqual(MapPackStore.parkedDirName(`.old-aaaaaaaaaaaa-${DIR}`), DIR);
    for (const name of ['.old-zz-x', '.staging-abc', 'plain', '.old-aaaaaaaaaaaa']) {
        assert.strictEqual(MapPackStore.parkedDirName(name), null, name);
    }
});

/* ── state ────────────────────────────────────────────────────────────────── */

test('state: an empty, missing or corrupt file reads as "never"', () => {
    const root = tempDir();
    const s = store(root);
    assert.deepStrictEqual(s.state(), {
        lastCheckAt: 0, lastResult: 'never', lastError: null, installed: 0, offeredHotkeys: []
    });
    fs.writeFileSync(path.join(root, 'state.json'), 'not json');
    assert.strictEqual(s.state().lastResult, 'never');
});

test('state: a check is remembered, and merged rather than replaced', () => {
    const root = tempDir();
    const s = store(root);
    assert.ok(s.writeState({lastCheckAt: 1700000000000, lastResult: 'up-to-date'}));
    assert.strictEqual(s.state().lastCheckAt, 1700000000000);
    s.writeState({lastResult: 'installed:1', installed: 1});
    assert.deepStrictEqual(s.state(), {
        lastCheckAt: 1700000000000, lastResult: 'installed:1', lastError: null, installed: 1,
        offeredHotkeys: []
    });
});

test('state: the offered-hotkey list is additive, deduplicated and bounded', () => {
    // It has to outlive `hotkeys.json`: a binding the user *deleted* must not
    // come back on the next start, so "was one ever offered for this map" is
    // remembered here rather than inferred from the file.
    const root = tempDir();
    const s = store(root);
    assert.ok(s.noteOfferedHotkeys(['a/One']));
    s.noteOfferedHotkeys(['a/One', 'a/Two']);
    assert.deepStrictEqual(s.state().offeredHotkeys, ['a/One', 'a/Two']);
    // Nothing to record is a success, not a write.
    assert.ok(s.noteOfferedHotkeys([]));
    assert.ok(s.noteOfferedHotkeys(['Custom/Mine', '../nope', 42]));
    assert.deepStrictEqual(s.state().offeredHotkeys, ['a/One', 'a/Two'], 'only keys a pack may claim');

    s.noteOfferedHotkeys(Array.from({length: MapPackStore.MAX_OFFERED_HOTKEYS + 50},
        (_, i) => `c/Map ${i}`));
    assert.strictEqual(s.state().offeredHotkeys.length, MapPackStore.MAX_OFFERED_HOTKEYS);
});

test('state: nonsense in the file is clamped, not believed', () => {
    const root = tempDir();
    const s = store(root);
    fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({
        lastCheckAt: 'tomorrow', lastResult: 'x'.repeat(500), lastError: 42, installed: NaN,
        offeredHotkeys: 'all of them'
    }));
    const state = s.state();
    assert.strictEqual(state.lastCheckAt, 0);
    assert.strictEqual(state.lastResult.length, 64);
    assert.strictEqual(state.lastError, null);
    assert.strictEqual(state.installed, 0);
    assert.deepStrictEqual(state.offeredHotkeys, []);
});
