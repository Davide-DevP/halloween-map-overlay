const {test} = require('node:test');
const assert = require('node:assert');

const rules = require('../src/shared/map-pack-rules');
const {CUSTOM_CREATOR, sortCatalog, buildCatalog} = require('../src/core/map-catalog');
const {DEFAULT_SIZE} = require('../src/core/map-detector/matcher');
const {DEFAULT_SETTINGS} = require('../src/shared/settings-defaults');

/*
 * The pure half of map packs (docs/SPEC-MAP-PACKS.md). Everything a pack
 * carries is untrusted JSON fetched over the network, so most of what is below
 * is a hostile input and its refusal.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Constants that must agree with the rest of the app
 * ──────────────────────────────────────────────────────────────────────────── */

test('the reserved creator is the catalogue\'s own', () => {
    // Duplicated as a literal because this module imports nothing; if the
    // catalogue ever renames it, a pack could claim the user's own namespace.
    assert.strictEqual(rules.RESERVED_CREATOR, CUSTOM_CREATOR);
});

test('the pack-check setting exists and is on by default', () => {
    assert.strictEqual(DEFAULT_SETTINGS.checkForMapPacks, true);
});

test('the index URL is itself on the allow-list', () => {
    assert.ok(rules.isAllowedUrl(rules.INDEX_URL), rules.INDEX_URL);
});

/* ────────────────────────────────────────────────────────────────────────────
 * File names
 * ──────────────────────────────────────────────────────────────────────────── */

test('isValidFileName: the shapes a pack really uses', () => {
    for (const name of ['pack.json', 'templates.json', 'markers.json',
        'East Haddonfield.png', 'map_1.png', 'a-b.png']) {
        assert.ok(rules.isValidFileName(name), name);
    }
});

test('isValidFileName: traversal, separators and absolute paths are refused', () => {
    const hostile = [
        '../pack.json', '..\\pack.json', 'a/../../b.png', 'sub/dir.png', 'sub\\dir.png',
        '/etc/passwd.png', 'C:\\windows\\system32.png', 'C:/x.png', '..', '.', './a.png',
        '.hidden.png', '\\\\server\\share.png', 'a:b.png'
    ];
    for (const name of hostile) assert.strictEqual(rules.isValidFileName(name), false, name);
});

test('isValidFileName: the Windows device names are refused', () => {
    // `CON.png` is not a file on Windows, it is the console: the write
    // succeeds, the bytes go nowhere, and the size check afterwards fails — so
    // a pack naming its image that would install nothing and be retried
    // forever. The one deny-list in the module, because they are ordinary
    // letters as far as the allow-list is concerned.
    for (const name of ['CON.png', 'con.png', 'Con.PNG', 'NUL.json', 'aux.png', 'PRN.json',
        'COM1.png', 'lpt9.json', 'COM0.png', 'con .png']) {
        assert.strictEqual(rules.isValidFileName(name), false, name);
    }
    // Names that merely start with one are fine.
    for (const name of ['console.png', 'contents.json', 'com10.png', 'nullmap.png']) {
        assert.ok(rules.isValidFileName(name), name);
    }
    for (const stem of rules.WINDOWS_RESERVED_STEMS) {
        assert.strictEqual(rules.isValidFileName(`${stem}.png`), false, stem);
    }
});

test('isValidFileName: only .png and .json, and only sane lengths', () => {
    for (const name of ['pack.exe', 'pack.dll', 'pack.js', 'pack.node', 'pack.bat',
        'pack.json.exe', 'pack', 'pack.', 'pack.PNG.exe']) {
        assert.strictEqual(rules.isValidFileName(name), false, name);
    }
    // Case does not matter for the extension itself.
    assert.ok(rules.isValidFileName('Map.PNG'));
    assert.strictEqual(rules.isValidFileName('x'.repeat(62) + '.png'), false);
    for (const junk of [null, undefined, 42, {}, [], '', '\n.png', 'a\u0000.png']) {
        assert.strictEqual(rules.isValidFileName(junk), false, JSON.stringify(junk));
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Keys
 * ──────────────────────────────────────────────────────────────────────────── */

test('isValidPackKey: Creator/Map Name, exactly one slash', () => {
    for (const key of ["deftyconchgaming/East Haddonfield", "someone/O'Malley's Farm",
        'a/b', 'Creator_1/Map (Night)']) {
        assert.ok(rules.isValidPackKey(key), key);
    }
    for (const key of ['nocreator', 'a/b/c', '/b', 'a/', 'a//b', 'a/ b', 'a /b', 'a/b ',
        'a/b\nc', 'a/b=c', '../x', 'a/..', '', null, 7]) {
        assert.strictEqual(rules.isValidPackKey(key), false, JSON.stringify(key));
    }
});

test('isValidPackKey: the reserved Custom creator can never be claimed', () => {
    // Those keys mean "a file in the user's own custom/ folder"; a pack
    // pretending to be one would make the catalogue ambiguous about where an
    // image lives, and would launder a user-typed name into the log.
    for (const key of ['Custom/My Map', 'custom/My Map', 'CUSTOM/My Map', 'CuStOm/x']) {
        assert.strictEqual(rules.isValidPackKey(key), false, key);
    }
});

test('packDirName: derived from the key, never supplied', () => {
    assert.strictEqual(rules.packDirName('deftyconchgaming/East Haddonfield'),
        'deftyconchgaming-east-haddonfield');
    assert.strictEqual(rules.packDirName("a/O'Malley (Night)"), 'a-o-malley-night');
    assert.strictEqual(rules.packDirName('../../etc'), null);
    assert.strictEqual(rules.packDirName('Custom/x'), null);
    // Nothing it returns can escape a directory or hide.
    for (const key of ['a/b', "x_1/Map .. Name", 'Z/9']) {
        const dir = rules.packDirName(key);
        assert.ok(/^[a-z0-9-]+$/.test(dir), `${key} -> ${dir}`);
        assert.ok(!dir.startsWith('.') && !dir.includes('..'), dir);
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Versions
 * ──────────────────────────────────────────────────────────────────────────── */

test('compareVersions: numeric, component by component', () => {
    assert.ok(rules.compareVersions('0.7.0', '0.6.9') > 0);
    assert.ok(rules.compareVersions('0.10.0', '0.9.0') > 0, 'not a string compare');
    assert.strictEqual(rules.compareVersions('1.0', '1.0.0'), 0);
    assert.ok(rules.compareVersions('1.0.0-beta.1', '1.0.0') === 0, 'a pre-release is its release');
    assert.strictEqual(rules.compareVersions('', ''), 0);
    assert.ok(rules.compareVersions('1', 'nonsense') > 0);
});

test('appSatisfies: a pack that needs a newer app is skipped', () => {
    assert.ok(rules.appSatisfies('0.7.0', null));
    assert.ok(rules.appSatisfies('0.7.0', undefined));
    assert.ok(rules.appSatisfies('0.7.0', ''));
    assert.ok(rules.appSatisfies('0.7.0', '0.7.0'));
    assert.ok(rules.appSatisfies('0.7.1', '0.7.0'));
    assert.strictEqual(rules.appSatisfies('0.7.0', '0.8.0'), false);
    assert.strictEqual(rules.appSatisfies('0.7.0', '1.0'), false);
    assert.strictEqual(rules.appSatisfies('0.7.0', 7), false);
    assert.strictEqual(rules.appSatisfies('0.7.0', 'latest'), false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * URLs
 * ──────────────────────────────────────────────────────────────────────────── */

test('isAllowedUrl: one host, one prefix, https only', () => {
    const ok = 'https://raw.githubusercontent.com/Davide-DevP/halloween-map-overlay/main/packs/a.png';
    assert.ok(rules.isAllowedUrl(ok));
    const hostile = [
        'http://raw.githubusercontent.com/Davide-DevP/halloween-map-overlay/main/packs/a.png',
        'https://evil.com/Davide-DevP/halloween-map-overlay/main/packs/a.png',
        // The host alone is not enough: anybody can create a repository on it.
        'https://raw.githubusercontent.com/someone-else/repo/main/a.png',
        'https://raw.githubusercontent.com.evil.com/Davide-DevP/halloween-map-overlay/a.png',
        'https://user:pass@raw.githubusercontent.com/Davide-DevP/halloween-map-overlay/a.png',
        'https://raw.githubusercontent.com:8443/Davide-DevP/halloween-map-overlay/a.png',
        // `new URL` normalises `..` away, so this one lands back *inside* the
        // prefix and would otherwise open a socket for a URL nobody meant.
        'https://raw.githubusercontent.com/Davide-DevP/halloween-map-overlay/main/packs/../../a.png',
        'https://raw.githubusercontent.com/Davide-DevP/halloween-map-overlay/main/../../a.png',
        'https://raw.githubusercontent.com/Davide-DevP/halloween-map-overlay/main\\a.png',
        'https://raw.githubusercontent.com/Davide-DevP/halloween-map-overlay/a.png?x=1',
        'https://raw.githubusercontent.com/Davide-DevP/halloween-map-overlay/a.png#f',
        'file:///c:/windows/system32.png',
        'https://localhost/Davide-DevP/halloween-map-overlay/a.png',
        'not a url', '', null, 42
    ];
    for (const url of hostile) assert.strictEqual(rules.isAllowedUrl(url), false, String(url));
});

test('packFileUrl: derived from the index URL plus a validated name', () => {
    const index = rules.INDEX_URL;
    assert.strictEqual(
        rules.packFileUrl(index, 'silver-shamrock', 'templates.json'),
        'https://raw.githubusercontent.com/Davide-DevP/halloween-map-overlay/main/packs/silver-shamrock/templates.json');
    // A trailing slash and a nested base both work.
    assert.strictEqual(
        rules.packFileUrl(index, 'a/b', 'x.png'),
        'https://raw.githubusercontent.com/Davide-DevP/halloween-map-overlay/main/packs/a/b/x.png');
    // An absolute base is allowed but wins nothing.
    assert.ok(rules.packFileUrl(index,
        'https://raw.githubusercontent.com/Davide-DevP/halloween-map-overlay/main/packs/x', 'a.png'));
});

test('packFileUrl: a base or a name that tries to leave is refused', () => {
    const index = rules.INDEX_URL;
    const bases = ['../../../other', '/absolute', 'a\\b', '..', './a', 'a/../..', '',
        'https://evil.com/x', 'https://raw.githubusercontent.com/other/repo',
        'a b', 'a%2e%2e'];
    for (const base of bases) {
        assert.strictEqual(rules.packFileUrl(index, base, 'a.png'), null, base);
    }
    for (const name of ['../a.png', 'a/b.png', 'a.exe', '.env.json', '']) {
        assert.strictEqual(rules.packFileUrl(index, 'ok', name), null, name);
    }
    // An index URL that is not itself allowed derives nothing.
    assert.strictEqual(rules.packFileUrl('https://evil.com/index.json', 'ok', 'a.png'), null);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The index
 * ──────────────────────────────────────────────────────────────────────────── */

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function indexEntry(over) {
    return Object.assign({
        key: 'deftyconchgaming/Silver Shamrock',
        version: 1,
        minAppVersion: '0.7.0',
        base: 'silver-shamrock',
        files: [
            {name: 'Silver Shamrock.png', bytes: 1000, sha256: HASH_A},
            {name: 'templates.json', bytes: 2000, sha256: HASH_B}
        ]
    }, over || {});
}

function indexDoc(packs) {
    return {formatVersion: 1, packs};
}

test('validateIndex: the committed empty index is valid', () => {
    const committed = require('../packs/index.json');
    const result = rules.validateIndex(committed);
    assert.ok(result.ok, result.error);
    assert.deepStrictEqual(result.packs, []);
});

test('validateIndex: a well-formed entry survives whole', () => {
    const result = rules.validateIndex(indexDoc([indexEntry()]));
    assert.ok(result.ok, result.error);
    assert.strictEqual(result.packs.length, 1);
    assert.strictEqual(result.packs[0].bytes, 3000);
    assert.deepStrictEqual(result.rejected, []);
});

test('validateIndex: a malformed document drops everything', () => {
    for (const json of [null, 'x', 42, [], {}, {formatVersion: 2, packs: []},
        {formatVersion: 1}, {formatVersion: 1, packs: {}}]) {
        assert.strictEqual(rules.validateIndex(json).ok, false, JSON.stringify(json));
    }
});

test('validateIndex: a malformed entry drops only that entry, with a reason', () => {
    const cases = [
        [indexEntry({key: '../x'}), 'bad-key'],
        [indexEntry({key: 'Custom/x'}), 'bad-key'],
        [indexEntry({version: 0}), 'bad-version'],
        [indexEntry({version: 1.5}), 'bad-version'],
        [indexEntry({version: NaN}), 'bad-version'],
        [indexEntry({version: Infinity}), 'bad-version'],
        [indexEntry({version: '2'}), 'bad-version'],
        [indexEntry({minAppVersion: 'soon'}), 'bad-min-app-version'],
        [indexEntry({base: ''}), 'bad-base'],
        [indexEntry({files: []}), 'bad-files'],
        [indexEntry({files: [{name: '../a.png', bytes: 1, sha256: HASH_A}]}), 'bad-file'],
        [indexEntry({files: [{name: 'a.png', bytes: 1, sha256: 'short'}]}), 'bad-file'],
        [indexEntry({files: [{name: 'a.png', bytes: 1, sha256: HASH_A.toUpperCase()}]}), 'bad-file'],
        [indexEntry({files: [{name: 'a.png', bytes: -1, sha256: HASH_A}]}), 'bad-file'],
        [indexEntry({files: [{name: 'a.png', bytes: NaN, sha256: HASH_A}]}), 'bad-file'],
        [indexEntry({files: [{name: 'a.png', bytes: Infinity, sha256: HASH_A}]}), 'bad-file'],
        // Over the per-file cap.
        [indexEntry({files: [{name: 'a.png', bytes: 9 * 1024 * 1024, sha256: HASH_A},
            {name: 'templates.json', bytes: 1, sha256: HASH_B}]}), 'bad-file'],
        [indexEntry({files: [{name: 'a.png', bytes: 1, sha256: HASH_A},
            {name: 'A.PNG', bytes: 1, sha256: HASH_B}]}), 'duplicate-file'],
        // No templates, or no image: not a map pack.
        [indexEntry({files: [{name: 'a.png', bytes: 1, sha256: HASH_A}]}), 'no-templates'],
        [indexEntry({files: [{name: 'templates.json', bytes: 1, sha256: HASH_A}]}), 'no-image'],
        // The manifest describes the files; it is not one of them.
        [indexEntry({files: [{name: 'pack.json', bytes: 1, sha256: HASH_A},
            {name: 'a.png', bytes: 1, sha256: HASH_B},
            {name: 'templates.json', bytes: 1, sha256: HASH_A}]}), 'manifest-listed']
    ];
    for (const [entry, reason] of cases) {
        const result = rules.validateIndex(indexDoc([entry]));
        assert.ok(result.ok, 'the document itself is fine');
        assert.deepStrictEqual(result.packs, [], JSON.stringify(entry).slice(0, 90));
        assert.strictEqual(result.rejected[0].reason, reason, JSON.stringify(entry).slice(0, 90));
    }
});

test('validateIndex: a duplicate key is refused rather than resolved', () => {
    const result = rules.validateIndex(indexDoc([indexEntry(), indexEntry({version: 9})]));
    assert.strictEqual(result.packs.length, 1);
    assert.strictEqual(result.packs[0].version, 1, 'the first entry stands');
    assert.strictEqual(result.rejected[0].reason, 'duplicate-key');
    // Case-insensitively, too — two spellings of one key are still one key.
    const other = rules.validateIndex(indexDoc([
        indexEntry(), indexEntry({key: 'deftyconchgaming/silver shamrock'})]));
    assert.strictEqual(other.packs.length, 1);
});

test('validateIndex: two keys that share one install directory are refused', () => {
    /*
     * `packDirName` folds every non-alphanumeric character to `-`, so these
     * five keys all install into `a-b-c`. Published together they reinstall
     * over each other on **every** check forever: each sees the other's
     * manifest, decides its own key is not installed, downloads, commits, and
     * makes the other map vanish — with a toast and a gallery refresh each
     * time. The first entry stands; the rest are dropped with a reason.
     */
    const keys = ['a/b c', 'a/b-c', 'a/b.c', "a/b'c", 'a-b/c'];
    for (const key of keys) assert.strictEqual(rules.packDirName(key), 'a-b-c', key);

    const result = rules.validateIndex(indexDoc(keys.map(key => indexEntry({key}))));
    assert.ok(result.ok);
    assert.deepStrictEqual(result.packs.map(p => p.key), ['a/b c']);
    assert.deepStrictEqual(result.rejected.map(r => r.reason),
        ['duplicate-dir', 'duplicate-dir', 'duplicate-dir', 'duplicate-dir']);
});

test('validateIndex: the hard caps hold', () => {
    const many = Array.from({length: rules.LIMITS.packs + 1},
        (_, i) => indexEntry({key: `creator/Map ${i}`}));
    assert.strictEqual(rules.validateIndex(indexDoc(many)).ok, false);

    const files = Array.from({length: rules.LIMITS.files + 1},
        (_, i) => ({name: `f${i}.json`, bytes: 1, sha256: HASH_A}));
    assert.strictEqual(rules.validateIndex(indexDoc([indexEntry({files})])).rejected[0].reason,
        'too-many-files');

    // Under every per-file cap, over the per-pack one.
    const big = rules.validateIndex(indexDoc([indexEntry({files: [
        {name: 'a.png', bytes: 8 * 1024 * 1024, sha256: HASH_A},
        {name: 'templates.json', bytes: 8 * 1024 * 1024, sha256: HASH_B},
        {name: 'b.json', bytes: 1024 * 1024, sha256: HASH_A}
    ]})]));
    assert.strictEqual(big.rejected[0].reason, 'pack-too-large');
});

/* ────────────────────────────────────────────────────────────────────────────
 * The manifest
 * ──────────────────────────────────────────────────────────────────────────── */

function manifest(over) {
    return Object.assign({
        formatVersion: 1,
        key: 'deftyconchgaming/Silver Shamrock',
        name: 'Silver Shamrock',
        creator: 'deftyconchgaming',
        credit: 'u/deftyconchgaming',
        version: 1,
        minAppVersion: '0.7.0',
        image: 'Silver Shamrock.png',
        markers: null,
        files: [
            {name: 'Silver Shamrock.png', bytes: 1000, sha256: HASH_A},
            {name: 'templates.json', bytes: 2000, sha256: HASH_B}
        ]
    }, over || {});
}

test('validateManifest: name and creator come from the key, not from the file', () => {
    const result = rules.validateManifest(manifest({name: undefined, creator: undefined}), null, {});
    assert.ok(result.ok, result.error);
    assert.strictEqual(result.manifest.name, 'Silver Shamrock', 'from the key half');
    assert.strictEqual(result.manifest.creator, 'deftyconchgaming');
    assert.strictEqual(result.manifest.markers, null);
    // Present is fine — as long as it is the key's own spelling.
    assert.ok(rules.validateManifest(manifest(), null, {}).ok);
});

test('validateManifest: a name or creator that disagrees with the key is refused', () => {
    /*
     * Four separate problems, one rule. A pack `aaa/Foo` calling itself
     * "East Haddonfield" sorts ahead of the real one and hijacks
     * `show-map=east haddonfield`; `creator: "Custom"` lands in the reserved
     * group with `custom: false`; `creator: "constructor"`/`"__proto__"`
     * reaches `byCreator[creator] || []` in the renderer's map picker and
     * inherits a function, breaking the picker for every map; and free text is
     * a rendering surface that one forgotten `escapeHtml` turns into RCE.
     */
    const cases = [
        [manifest({name: 'East Haddonfield'}), 'name-mismatch'],
        [manifest({name: ''}), 'name-mismatch'],
        [manifest({name: 'x'.repeat(65)}), 'name-mismatch'],
        [manifest({name: ' Silver Shamrock'}), 'name-mismatch'],
        [manifest({name: '<img src=x onerror=alert(1)>'}), 'name-mismatch'],
        [manifest({name: 'Silver\u202EShamrock'}), 'name-mismatch'],
        [manifest({creator: 'Custom'}), 'creator-mismatch'],
        [manifest({creator: 'constructor'}), 'creator-mismatch'],
        [manifest({creator: '__proto__'}), 'creator-mismatch'],
        [manifest({creator: 12}), 'creator-mismatch']
    ];
    for (const [json, error] of cases) {
        const result = rules.validateManifest(json, null, {});
        assert.strictEqual(result.ok, false, JSON.stringify(json.name || json.creator));
        assert.strictEqual(result.error, error, JSON.stringify(json.name || json.creator));
    }
});

test('validateManifest: credit is free text, but sanitised and bounded', () => {
    // Nothing renders it yet, so it is stripped rather than refused — a stray
    // zero-width space is a copy-paste accident, not a reason to throw a map
    // away. What must never survive is anything that rewrites a line's
    // direction or breaks a log line.
    const dirty = manifest({credit: 'u/someone\u202E evil\u0000\u200B'});
    const result = rules.validateManifest(dirty, null, {});
    assert.ok(result.ok, result.error);
    assert.strictEqual(result.manifest.credit, 'u/someone evil');
    assert.strictEqual(rules.validateManifest(manifest({credit: 12}), null, {}).error, 'bad-credit');
    assert.strictEqual(rules.validateManifest(manifest({credit: '   '}), null, {}).manifest.credit, null);
    assert.strictEqual(
        rules.validateManifest(manifest({credit: 'x'.repeat(500)}), null, {}).manifest.credit.length, 200);
    assert.strictEqual(rules.sanitizeText('\u0000\u200B', 200), null);
    assert.strictEqual(rules.sanitizeText(null, 200), null);
});

test('the validator and this test are text files, not binary ones', () => {
    // `UNSAFE_TEXT` used to spell its character class out in **literal** control
    // characters, and the inputs in this file carried them too. That put NUL
    // and C1 bytes in both, so git classified the project's one security
    // validator as binary: every diff of it read `Bin 0 -> 52314 bytes`, i.e.
    // unreviewable. Worse, any editor or tool that normalises text could have
    // dropped a byte out of the middle of that class and silently stopped
    // filtering it, with nothing in a diff to show for it.
    //
    // Both files therefore use escapes, which are the same strings to
    // JavaScript and plain ASCII on disk. Asserted rather than left to
    // discipline, because the failure is invisible.
    const fs = require('fs');
    const path = require('path');
    // Built from a string so this assertion cannot itself reintroduce the
    // characters it is looking for.
    const forbidden = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F'
        + '\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]');
    for (const file of ['../src/shared/map-pack-rules.js', './map-pack-rules.test.js']) {
        const text = fs.readFileSync(path.join(__dirname, file), 'utf-8');
        const match = forbidden.exec(text);
        assert.strictEqual(match, null, match
            ? `${file} contains a literal U+`
                + match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
                + ` at offset ${match.index} - write it as an escape`
            : file);
    }
    // ...and the class still catches every range it describes, whichever way it
    // is written: one assertion per range, so a mangled escape is caught here
    // rather than by a pack sneaking a bidi override past the sanitiser.
    for (const code of [0x0000, 0x001F, 0x007F, 0x009F, 0x200B, 0x200F,
        0x202A, 0x202E, 0x2066, 0x2069, 0xFEFF]) {
        const ch = String.fromCharCode(code);
        assert.strictEqual(rules.sanitizeText('a' + ch + 'b', 200), 'ab',
            'U+' + code.toString(16).toUpperCase().padStart(4, '0') + ' survived');
    }
    // Ordinary text just outside those ranges is untouched: an accented letter,
    // an em dash and a curly apostrophe are all legitimate in a credit line.
    const ok = 'u/deftyconchgaming ' + String.fromCharCode(0xE9, 0x2014, 0x2019) + ' ok';
    assert.strictEqual(rules.sanitizeText(ok, 200), ok);
});

test('validateManifest: every self-inconsistency is refused', () => {
    const cases = [
        [manifest({formatVersion: 2}), 'format-version:2'],
        [manifest({key: 'Custom/x'}), 'bad-key'],
        [manifest({version: 0}), 'bad-version'],
        [manifest({image: 'a.json'}), 'bad-image'],
        [manifest({image: '../a.png'}), 'bad-image'],
        [manifest({markers: 'other.json'}), 'bad-markers-name'],
        [manifest({image: 'missing.png'}), 'image-not-listed'],
        [manifest({files: [{name: 'Silver Shamrock.png', bytes: 1, sha256: HASH_A}]}), 'templates-not-listed'],
        [manifest({markers: 'markers.json'}), 'markers-not-listed']
    ];
    for (const [json, error] of cases) {
        const result = rules.validateManifest(json, null, {});
        assert.strictEqual(result.ok, false, JSON.stringify(json).slice(0, 80));
        assert.strictEqual(result.error, error);
    }
});

test('validateManifest: it must agree with the index entry field for field', () => {
    const entry = rules.validateIndex(indexDoc([indexEntry()])).packs[0];
    assert.ok(rules.validateManifest(manifest(), entry, {}).ok);

    // A different key, spelled consistently with itself, so this is the index
    // cross-check failing rather than the name rule.
    assert.strictEqual(
        rules.validateManifest(manifest({key: 'a/b', name: 'b', creator: 'a'}), entry, {}).error,
        'key-mismatch');
    assert.strictEqual(rules.validateManifest(manifest({version: 2}), entry, {}).error, 'version-mismatch');
    // A file the index never promised.
    const extra = manifest({files: manifest().files.concat([{name: 'markers.json', bytes: 5, sha256: HASH_A}])});
    assert.strictEqual(rules.validateManifest(extra, entry, {}).error, 'file-list-mismatch');
    // The same files with a different hash — the substitution this check exists for.
    const swapped = manifest({files: [
        {name: 'Silver Shamrock.png', bytes: 1000, sha256: HASH_B},
        {name: 'templates.json', bytes: 2000, sha256: HASH_B}
    ]});
    assert.strictEqual(rules.validateManifest(swapped, entry, {}).error, 'file-hash-mismatch');
});

test('validateManifest: minAppVersion too new is a refusal, not an install', () => {
    const result = rules.validateManifest(manifest({minAppVersion: '9.0.0'}), null, {appVersion: '0.7.0'});
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'needs-app:9.0.0');
    assert.ok(rules.validateManifest(manifest({minAppVersion: '0.7.0'}), null, {appVersion: '0.7.0'}).ok);
});

/* ────────────────────────────────────────────────────────────────────────────
 * Templates
 * ──────────────────────────────────────────────────────────────────────────── */

const KEY = 'deftyconchgaming/Silver Shamrock';

function templates(size, variants, key) {
    return {
        format: 2,
        size,
        templates: {[key || KEY]: variants}
    };
}

function flat(size, value) {
    return new Array(size * size).fill(value === undefined ? 0.5 : value);
}

test('validateTemplates: the shape the matcher indexes into', () => {
    const result = rules.validateTemplates(templates(4, [flat(4), flat(4, 0.25)]), {key: KEY, size: 4});
    assert.ok(result.ok, result.error);
    assert.strictEqual(result.variants, 2);
    // And against the real template size the detector uses.
    assert.ok(rules.validateTemplates(templates(DEFAULT_SIZE, [flat(DEFAULT_SIZE)]),
        {key: KEY, size: DEFAULT_SIZE}).ok);
});

test('validateTemplates: wrong array lengths are refused', () => {
    const short = templates(4, [new Array(15).fill(0.5)]);
    assert.strictEqual(rules.validateTemplates(short, {key: KEY, size: 4}).error, 'variant-length:15');
    const long = templates(4, [new Array(17).fill(0.5)]);
    assert.strictEqual(rules.validateTemplates(long, {key: KEY, size: 4}).error, 'variant-length:17');
    // A declared size that is not the matcher's.
    assert.strictEqual(rules.validateTemplates(templates(8, [flat(8)]), {key: KEY, size: 4}).error, 'size:8');
});

test('validateTemplates: NaN, Infinity and non-numbers are refused element by element', () => {
    // One NaN poisons the whole NCC, so every map would score NaN and the
    // detector would silently stop working. This is the check that stops it.
    for (const poison of [NaN, Infinity, -Infinity, null, undefined, '0.5', {}]) {
        const variant = flat(4);
        variant[7] = poison;
        assert.strictEqual(rules.validateTemplates(templates(4, [variant]), {key: KEY, size: 4}).error,
            'variant-not-finite', String(poison));
    }
    const hole = flat(4);
    delete hole[3];
    assert.strictEqual(rules.validateTemplates(templates(4, [hole]), {key: KEY, size: 4}).error,
        'variant-not-finite');
});

test('validateTemplates: values outside 0..1 are a corrupt file', () => {
    const over = flat(4);
    over[0] = 1.5;
    assert.strictEqual(rules.validateTemplates(templates(4, [over]), {key: KEY, size: 4}).error,
        'variant-out-of-range');
    const under = flat(4);
    under[0] = -0.001;
    assert.strictEqual(rules.validateTemplates(templates(4, [under]), {key: KEY, size: 4}).error,
        'variant-out-of-range');
});

test('validateTemplates: a pack may only carry its own map', () => {
    const other = templates(4, [flat(4)], 'someone/Other Map');
    assert.strictEqual(rules.validateTemplates(other, {key: KEY, size: 4}).error, 'key-mismatch');
    const two = templates(4, [flat(4)]);
    two.templates['someone/Other Map'] = [flat(4)];
    assert.strictEqual(rules.validateTemplates(two, {key: KEY, size: 4}).error, 'keys:2');
    assert.strictEqual(rules.validateTemplates({format: 2, size: 4, templates: {}},
        {key: KEY, size: 4}).error, 'keys:0');
});

test('validateTemplates: the rest of the hostile shapes', () => {
    for (const json of [null, 'x', 42, [], {}, {format: 1, size: 4, templates: {}},
        {format: 2, size: 0, templates: {}}, {format: 2, size: 4, templates: []}]) {
        assert.strictEqual(rules.validateTemplates(json, {key: KEY, size: 4}).ok, false,
            JSON.stringify(json));
    }
    assert.strictEqual(rules.validateTemplates(templates(4, []), {key: KEY, size: 4}).error,
        'variants-not-an-array');
    assert.strictEqual(rules.validateTemplates(templates(4, ['nope']), {key: KEY, size: 4}).error,
        'variant-not-an-array');
    const many = templates(4, Array.from({length: 9}, () => flat(4)));
    assert.strictEqual(rules.validateTemplates(many, {key: KEY, size: 4}).error, 'too-many-variants:9');
});

/* ────────────────────────────────────────────────────────────────────────────
 * Markers
 * ──────────────────────────────────────────────────────────────────────────── */

test('validateMarkers: the documented top-level shape', () => {
    const result = rules.validateMarkers({
        layers: {chests: [{x: 0, y: 1}, {x: 0.5, y: 0.5}], gas: []},
        tab: {sx: 1, sy: 2, tx: 3, ty: 4}
    });
    assert.ok(result.ok, result.error);
    assert.strictEqual(result.layers, 2);
    assert.strictEqual(result.points, 2);
    // `tab` is optional.
    assert.ok(rules.validateMarkers({layers: {}}).ok);
});

test('validateMarkers: hostile shapes are refused', () => {
    const cases = [
        [null, 'not-an-object'],
        [{}, 'layers-not-an-object'],
        [{layers: []}, 'layers-not-an-object'],
        [{layers: {'../x': []}}, 'bad-layer-name'],
        [{layers: {a: 'x'}}, 'layer-not-an-array'],
        [{layers: {a: [1]}}, 'point-not-an-object'],
        [{layers: {a: [{x: NaN, y: 0}]}}, 'point-not-finite'],
        [{layers: {a: [{x: Infinity, y: 0}]}}, 'point-not-finite'],
        [{layers: {a: [{x: '0.5', y: 0}]}}, 'point-not-finite'],
        [{layers: {a: [{x: 1.5, y: 0}]}}, 'point-out-of-range'],
        [{layers: {a: [{x: -0.1, y: 0}]}}, 'point-out-of-range'],
        [{layers: {a: []}, tab: {sx: 1, sy: 1, tx: 1}}, 'tab-ty'],
        [{layers: {a: []}, tab: 4}, 'tab-not-an-object'],
        [{layers: {a: new Array(513).fill({x: 0, y: 0})}}, 'layer-too-long']
    ];
    for (const [json, error] of cases) {
        const result = rules.validateMarkers(json);
        assert.strictEqual(result.ok, false, JSON.stringify(json).slice(0, 70));
        assert.strictEqual(result.error, error, JSON.stringify(json).slice(0, 70));
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Precedence
 * ──────────────────────────────────────────────────────────────────────────── */

test('selectPacksToInstall: newer installs, same and older do not', () => {
    const packs = rules.validateIndex(indexDoc([
        indexEntry({key: 'c/New', version: 1, minAppVersion: null}),
        indexEntry({key: 'c/Same', version: 3, minAppVersion: null}),
        indexEntry({key: 'c/Newer', version: 4, minAppVersion: null}),
        indexEntry({key: 'c/Older', version: 1, minAppVersion: null}),
        indexEntry({key: 'c/Future', version: 1, minAppVersion: '9.0.0'})
    ])).packs;
    const installed = [
        {key: 'c/Same', version: 3},
        {key: 'c/Newer', version: 3},
        {key: 'c/Older', version: 5}
    ];
    const plan = rules.selectPacksToInstall(packs, installed, '0.7.0');
    assert.deepStrictEqual(plan.install.map(p => p.key), ['c/New', 'c/Newer']);
    const reasons = Object.fromEntries(plan.skipped.map(s => [s.key, s.reason]));
    assert.deepStrictEqual(reasons, {
        'c/Same': 'up-to-date',
        // A botched revert of the index must not roll every user's map back.
        'c/Older': 'downgrade',
        'c/Future': 'needs-app'
    });
});

test('mergeMapPacks: a pack replaces the bundled map with the same key', () => {
    const bundled = buildCatalog([
        'deftyconchgaming/East Haddonfield.png',
        'deftyconchgaming/Orange Grove Estates.png'
    ]);
    const merged = rules.mergeMapPacks(bundled, [
        {key: 'deftyconchgaming/East Haddonfield', name: 'East Haddonfield',
            creator: 'deftyconchgaming', version: 2, dir: 'd-eh', image: 'East Haddonfield.png'},
        {key: 'newcreator/Silver Shamrock', name: 'Silver Shamrock',
            creator: 'newcreator', version: 1, dir: 'n-ss', image: 'Silver Shamrock.png', markers: 'markers.json'}
    ], sortCatalog);

    assert.strictEqual(merged.length, 3, 'the replacement is not a second entry');
    const fixed = merged.find(e => e.key === 'deftyconchgaming/East Haddonfield');
    assert.strictEqual(fixed.pack, 'd-eh');
    assert.strictEqual(fixed.packVersion, 2);
    // Untouched bundled maps keep exactly what they had.
    const untouched = merged.find(e => e.key === 'deftyconchgaming/Orange Grove Estates');
    assert.strictEqual(untouched.pack, undefined);
    // A new map is an ordinary entry, sorted with the rest.
    assert.deepStrictEqual(merged.map(e => e.key), [
        'deftyconchgaming/East Haddonfield',
        'deftyconchgaming/Orange Grove Estates',
        'newcreator/Silver Shamrock'
    ]);
    assert.strictEqual(merged.find(e => e.key === 'newcreator/Silver Shamrock').markers, true);
    // Nothing is `custom`, so the first-run Ctrl+Alt+1..9 defaults see them.
    assert.ok(merged.every(e => e.custom === false));
});

test('mergeMapPacks: a pack can never touch a custom map', () => {
    const catalog = [
        {key: 'Custom/My Map', creator: 'Custom', name: 'My Map', file: 'My Map.png', custom: true}
    ];
    const merged = rules.mergeMapPacks(catalog, [
        {key: 'Custom/My Map', name: 'x', creator: 'Custom', version: 9, dir: 'c', image: 'a.png'}
    ], sortCatalog);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].custom, true, 'the pack was refused by isValidPackKey');
    assert.strictEqual(merged[0].pack, undefined);
});

test('mergeTemplateSources: a pack wins on a shared key and adds new ones', () => {
    const bundled = {'a/One': [[1]], 'a/Two': [[2]]};
    const {templates: merged, replaced} = rules.mergeTemplateSources(bundled, [
        {key: 'a/One', templates: {'a/One': [[9], [9]]}},
        {key: 'b/Three', templates: {'b/Three': [[3]]}},
        // Ignored: the file's key is not the pack's key.
        {key: 'c/Four', templates: {'a/Two': [[0]]}}
    ]);
    assert.deepStrictEqual(merged['a/One'], [[9], [9]]);
    assert.deepStrictEqual(merged['a/Two'], [[2]], 'not replaced by a mislabelled pack');
    assert.deepStrictEqual(merged['b/Three'], [[3]]);
    assert.deepStrictEqual(replaced, ['a/One']);
    // The bundled object itself is not mutated.
    assert.deepStrictEqual(bundled['a/One'], [[1]]);
});

test('mergeTemplateSources: key comparison folds case, exactly like mergeMapPacks', () => {
    // It was exact here and case-insensitive there, so a pack published as
    // `a/one` replaced the bundled map in the *gallery* while the bundled
    // *templates* stayed — i.e. the one thing the pack existed to fix (a map
    // auto-detect keeps missing) was the one thing it could not fix.
    const bundled = {'a/One': [[1]]};
    const {templates: merged, replaced} = rules.mergeTemplateSources(bundled, [
        {key: 'a/one', templates: {'a/one': [[9]]}}
    ]);
    assert.deepStrictEqual(Object.keys(merged), ['a/one'], 'one entry, the pack\'s own spelling');
    assert.deepStrictEqual(merged['a/one'], [[9]]);
    assert.deepStrictEqual(replaced, ['a/One']);
    // And the catalogue merge agrees about it being one map.
    const catalog = buildCatalog(['a/One.png']);
    const entries = rules.mergeMapPacks(catalog, [
        {key: 'a/one', version: 1, dir: 'a-one', image: 'one.png'}
    ], sortCatalog);
    assert.strictEqual(entries.length, 1);
});

test('mergeTemplateSources: the global variant budget is enforced, bundled first', () => {
    // Every variant of every key is scored on every frame that passes the Tab
    // gate. 200 packs x 8 variants would be seconds per tick, so packs past
    // the budget are dropped — and named, so the detector can log it.
    const bundled = {'a/One': [[1], [1]]};
    const packs = Array.from({length: 6}, (_, i) => ({
        key: `p/Map ${i}`,
        templates: {[`p/Map ${i}`]: [[0], [0]]}
    }));
    const result = rules.mergeTemplateSources(bundled, packs, {maxVariants: 8});
    assert.strictEqual(result.variants, 8);
    assert.deepStrictEqual(Object.keys(result.templates),
        ['a/One', 'p/Map 0', 'p/Map 1', 'p/Map 2']);
    assert.deepStrictEqual(result.dropped, ['p/Map 3', 'p/Map 4', 'p/Map 5']);
    // A pack replacing a key frees that key's variants rather than adding to
    // them, so an upgrade of a bundled map always fits.
    const replacing = rules.mergeTemplateSources({'a/One': [[1], [1]]},
        [{key: 'a/One', templates: {'a/One': [[9], [9]]}}], {maxVariants: 2});
    assert.deepStrictEqual(replacing.dropped, []);
    assert.strictEqual(replacing.variants, 2);
    // The real budget is big enough for the bundled set many times over.
    assert.ok(rules.LIMITS.variants >= 16);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The 24 h gate
 * ──────────────────────────────────────────────────────────────────────────── */

test('shouldCheckPacks: the setting is the gate for every check but the button', () => {
    assert.deepStrictEqual(rules.shouldCheckPacks({enabled: false, lastCheckAt: 0, now: 1000}),
        {check: false, reason: 'disabled'});
    // …and the timer is refused however long it has been.
    assert.strictEqual(
        rules.shouldCheckPacks({enabled: false, lastCheckAt: 0, now: 1e12}).reason, 'disabled');
});

test('shouldCheckPacks: the button overrides the setting, because the click is the consent', () => {
    // 1.0 merged the two network switches into one, so there is no "check for
    // new maps" switch left to point the user at — and the app's own update
    // check has always worked this way (`planManualUpdateCheck`). A user who
    // presses *Check now* over an off switch asked for this one request.
    const manual = rules.shouldCheckPacks({enabled: false, lastCheckAt: 0, now: 1000, force: true});
    assert.deepStrictEqual(manual, {check: true, reason: 'manual'});
    // `manual` rather than `forced`, so the log says which of the two it was.
    assert.strictEqual(
        rules.shouldCheckPacks({enabled: true, lastCheckAt: 0, now: 1000, force: true}).reason, 'forced');
    // Only a real force: a missing or falsy flag is still gated.
    for (const force of [undefined, null, false, 0, '']) {
        assert.strictEqual(rules.shouldCheckPacks({enabled: false, now: 1000, force}).check, false,
            JSON.stringify(force));
    }
});

test('shouldCheckPacks: at most once per 24 h, and the button ignores the interval', () => {
    const day = rules.CHECK_INTERVAL_MS;
    const now = 1000 * day;
    assert.strictEqual(rules.shouldCheckPacks({enabled: true, lastCheckAt: 0, now}).reason, 'never');
    assert.strictEqual(rules.shouldCheckPacks({enabled: true, lastCheckAt: now - day, now}).reason, 'due');
    assert.strictEqual(rules.shouldCheckPacks({enabled: true, lastCheckAt: now - day + 1, now}).check, false);
    assert.strictEqual(rules.shouldCheckPacks({enabled: true, lastCheckAt: now - 1, now}).reason, 'too-soon');
    assert.strictEqual(rules.shouldCheckPacks({enabled: true, lastCheckAt: now - 1, now, force: true}).reason,
        'forced');
});

test('shouldCheckPacks: a check that FAILED is retried in an hour, not tomorrow', () => {
    // A laptop launched on a train fails in a second and writes `lastCheckAt`
    // anyway; without this it would get nothing until tomorrow however long it
    // is online afterwards.
    const now = 1000 * rules.CHECK_INTERVAL_MS;
    const hour = rules.RETRY_INTERVAL_MS;
    assert.ok(hour < rules.CHECK_INTERVAL_MS);
    const at = (ago, lastFailed) => rules.shouldCheckPacks({
        enabled: true, lastCheckAt: now - ago, now, lastFailed
    });
    assert.strictEqual(at(hour - 1, true).check, false);
    assert.strictEqual(at(hour, true).reason, 'retry');
    // A *successful* check still waits the full day.
    assert.strictEqual(at(hour, false).check, false);
    assert.strictEqual(at(rules.CHECK_INTERVAL_MS, false).reason, 'due');
    // And the retry never makes the wait longer than the ordinary one.
    assert.strictEqual(rules.shouldCheckPacks({
        enabled: true, lastCheckAt: now - 5000, now, lastFailed: true,
        intervalMs: 1000, retryMs: 60000
    }).reason, 'retry');
});

test('shouldCheckPacks: a clock that moved backwards does not lock the check out', () => {
    const now = 1000;
    assert.strictEqual(rules.shouldCheckPacks({enabled: true, lastCheckAt: now + 99999999, now}).reason,
        'clock-moved');
    for (const junk of [NaN, Infinity, 'x', null, undefined, -5]) {
        assert.strictEqual(rules.shouldCheckPacks({enabled: true, lastCheckAt: junk, now}).check, true,
            String(junk));
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Images
 * ──────────────────────────────────────────────────────────────────────────── */

test('hasPngSignature: the bytes, not the file name', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    assert.ok(rules.hasPngSignature(png));
    assert.strictEqual(rules.hasPngSignature(Buffer.from('MZ\u0090\u0000not a png at all')), false);
    assert.strictEqual(rules.hasPngSignature(Buffer.from([0x89, 0x50])), false);
    assert.strictEqual(rules.hasPngSignature(Buffer.alloc(0)), false);
    assert.strictEqual(rules.hasPngSignature(null), false);
});

test('isPlausiblePngBytes: a header with no image behind it is refused', () => {
    // 33 bytes — signature + IHDR — passes the signature check and
    // `image-size` reads 8192x8192 out of it happily. Installing it costs
    // nothing and gains nothing: the map is then permanently blank, and
    // because the pack counts as installed the next check says up-to-date.
    const header = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(25)
    ]);
    assert.ok(rules.hasPngSignature(header));
    assert.strictEqual(rules.isPlausiblePngBytes(header, {width: 8192, height: 8192}), false);
    assert.strictEqual(rules.isPlausiblePngBytes(header, {width: 600, height: 600}), false);
    assert.strictEqual(rules.hasPngEnd(header), false);

    // The floor is far below anything an encoder produces: the four bundled
    // maps are ~600x600 and 221-313 KB against a 155-byte floor.
    const withEnd = (length) => {
        const bytes = Buffer.alloc(length);
        bytes.write('IEND', length - 8, 'latin1');
        return bytes;
    };
    assert.ok(rules.hasPngEnd(withEnd(200)));
    assert.ok(rules.isPlausiblePngBytes(withEnd(300000), {width: 600, height: 600}));
    assert.ok(rules.isPlausiblePngBytes(withEnd(155), {width: 600, height: 600}), 'the floor itself');
    assert.strictEqual(rules.isPlausiblePngBytes(withEnd(100), {width: 600, height: 600}), false);
    // 8192x8192 needs 16451 bytes at a quarter of a bit per pixel.
    assert.ok(rules.isPlausiblePngBytes(withEnd(16451), {width: 8192, height: 8192}));
    assert.strictEqual(rules.isPlausiblePngBytes(withEnd(16450), {width: 8192, height: 8192}), false);
    assert.strictEqual(rules.isPlausiblePngBytes(null, {width: 1, height: 1}), false);
    assert.strictEqual(rules.isPlausiblePngBytes(withEnd(200), null), false);
    assert.strictEqual(rules.hasPngEnd(Buffer.alloc(4)), false);
    assert.strictEqual(rules.hasPngEnd(null), false);
});

test('isSaneImageSize: a map image, not a 1x1 or a 40000px bomb', () => {
    assert.ok(rules.isSaneImageSize({width: 600, height: 607, type: 'png'}));
    for (const size of [null, {}, {width: 1, height: 1}, {width: 600, height: 40000},
        {width: 0, height: 600}, {width: -600, height: 600}, {width: 600.5, height: 600},
        {width: NaN, height: 600}, {width: 600, height: 600, type: 'gif'}]) {
        assert.strictEqual(rules.isSaneImageSize(size), false, JSON.stringify(size));
    }
});
