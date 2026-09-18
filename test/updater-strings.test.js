'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * `updater/strings.json` is the only source of the text `hmo-updater.exe`
 * draws: `scripts/build-updater.js` generates the C# table from it, so a key
 * that exists in one language and not the other is not a compile error — it is
 * an Italian user looking at an English word, or at a raw dotted key, during
 * the one minute of the app's life when nothing else is on screen.
 *
 * Same contract as `test/i18n.test.js` keeps for the app's own catalogues, and
 * for the same reason: nothing here names a key, the files are the list.
 */

const root = path.join(__dirname, '..');
const updaterDir = path.join(root, 'updater');
const strings = JSON.parse(fs.readFileSync(path.join(updaterDir, 'strings.json'), 'utf-8'));

const LANGS = ['en', 'it'];
const PLACEHOLDER = /\{([a-zA-Z]+)\}/g;

function placeholders(value) {
    return (String(value).match(PLACEHOLDER) || []).sort();
}

/** Every key the C# actually asks for, from all three call shapes. */
function keysUsedInSources() {
    const used = new Set();
    const patterns = [
        // Strings.Get(_options.Lang, "key") / Get(lang, "key", "param", value).
        // Only the first literal — the later ones are placeholder names.
        /Strings\.Get\(\s*[A-Za-z_][A-Za-z0-9_.]*\s*,\s*"([^"]+)"/g,
        // Runner.Fail("error.something", …)
        /\bFail\(\s*"([^"]+)"/g,
        // _window.SetStep("step.something")
        /\bSetStep\(\s*"([^"]+)"/g,
        // Anything dotted with one of the three families, wherever it appears —
        // the Close button picks its label inside a ternary, and a scan that
        // only understood call sites would have called that string an orphan.
        // Deliberately narrow: `"dwmapi.dll"` must not look like a key.
        /"((?:step|error|button)\.[A-Za-z]+)"/g
    ];
    for (const name of fs.readdirSync(updaterDir)) {
        if (!name.endsWith('.cs')) continue;
        const source = fs.readFileSync(path.join(updaterDir, name), 'utf-8');
        for (const pattern of patterns) {
            let match;
            pattern.lastIndex = 0;
            while ((match = pattern.exec(source)) !== null) used.add(match[1]);
        }
    }
    return used;
}

test('the two tables hold exactly the same keys', () => {
    const en = Object.keys(strings.en).sort();
    const it = Object.keys(strings.it).sort();
    const missingInIt = en.filter(key => !strings.it[key]);
    const missingInEn = it.filter(key => !strings.en[key]);
    assert.deepStrictEqual(missingInIt, [], 'keys with no Italian translation');
    assert.deepStrictEqual(missingInEn, [], 'Italian keys with no English original');
    assert.deepStrictEqual(en, it);
});

test('no string is empty or nothing but whitespace', () => {
    for (const lang of LANGS) {
        for (const [key, value] of Object.entries(strings[lang])) {
            assert.ok(typeof value === 'string' && value.trim().length > 0, `${lang}.${key} is empty`);
        }
    }
});

test('a {placeholder} one language drops is a sentence with a hole in it', () => {
    for (const key of Object.keys(strings.en)) {
        assert.deepStrictEqual(placeholders(strings.it[key]), placeholders(strings.en[key]),
            `${key}: the two languages do not agree on their placeholders`);
    }
});

test('every key the C# sources ask for exists', () => {
    const used = [...keysUsedInSources()].sort();
    // A guard on the guard: if the scan ever stops matching, this test would
    // pass by finding nothing at all.
    assert.ok(used.length >= 10, `only ${used.length} keys found in updater/*.cs — the scan is broken`);
    const unknown = used.filter(key => !(key in strings.en));
    assert.deepStrictEqual(unknown, [], 'keys drawn by the helper with no entry in strings.json');
});

test('every string in the table is actually drawn', () => {
    const used = keysUsedInSources();
    const orphans = Object.keys(strings.en).filter(key => !used.has(key));
    assert.deepStrictEqual(orphans, [], 'strings nothing asks for');
});

test('the helper and the app say the same sentence at the hand-over', () => {
    // The app draws its "updating" view and the helper opens on top of it at
    // the same window bounds. Two different wordings would be a visible flicker
    // of text at the swap, which is the one thing this feature exists to avoid.
    for (const lang of LANGS) {
        const app = JSON.parse(fs.readFileSync(path.join(root, 'src', 'i18n', `${lang}.json`), 'utf-8'));
        assert.strictEqual(strings[lang]['headline'], app['update.installing.headline'], `${lang}: headline`);
        assert.strictEqual(strings[lang]['step.closing'], app['update.installing.step'], `${lang}: first step`);
        assert.strictEqual(strings[lang]['subline'], app['update.installing.sub'], `${lang}: sub-line`);
    }
});

test('the generated C# is pure ASCII, whatever the strings hold', () => {
    // csc's default source encoding follows the machine's ANSI codepage, so an
    // `è` written straight into the generated .cs is a coin toss between this
    // laptop and a GitHub runner. Everything non-ASCII is escaped instead.
    const {csharpLiteral, generateStrings} = require('../scripts/build-updater.js');
    assert.strictEqual(csharpLiteral('è più'), '"\\u00e8 pi\\u00f9"');
    assert.strictEqual(csharpLiteral('a "b" \\ c'), '"a \\"b\\" \\\\ c"');
    assert.strictEqual(csharpLiteral('line\r\nbreak'), '"line\\r\\nbreak"');

    const italian = Object.values(strings.it).join('');
    assert.ok(/[^\x20-\x7e]/.test(italian),
        'the Italian table has no non-ASCII character left, so this guard proves nothing');
    const generated = generateStrings(strings);
    const offenders = [...generated].filter(ch => ch.codePointAt(0) > 0x7e);
    assert.deepStrictEqual(offenders, [], 'raw non-ASCII reached the generated source');
});
