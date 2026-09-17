const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
    t, has, msg, translateMessage, resolveLanguage, format,
    LANGUAGES, LANGUAGE_SETTING_VALUES, CATALOGUES
} = require('../src/shared/i18n');
const {SYSTEM_HOTKEY_DEFS} = require('../src/shared/hotkeys-constants');
const {DEFAULT_SETTINGS} = require('../src/shared/settings-defaults');

const ROOT = path.join(__dirname, '..');
const EN = CATALOGUES.en;
const IT = CATALOGUES.it;

/* ────────────────────────────────────────────────────────────────────────────
 * t()
 * ──────────────────────────────────────────────────────────────────────────── */

test('t: returns the string for the requested language', () => {
    assert.strictEqual(t('en', 'common.close'), EN['common.close']);
    assert.strictEqual(t('it', 'common.close'), IT['common.close']);
    assert.notStrictEqual(t('en', 'common.close'), t('it', 'common.close'));
});

test('t: falls back to English, then to the key itself', () => {
    // An unknown language is English, not a crash and not an empty string.
    assert.strictEqual(t('de', 'common.close'), EN['common.close']);
    assert.strictEqual(t(undefined, 'common.close'), EN['common.close']);
    assert.strictEqual(t(null, 'common.close'), EN['common.close']);
    // A key in neither catalogue shows the key: visible in the UI, and a
    // missing translation never blanks an element.
    assert.strictEqual(t('it', 'nope.not.a.key'), 'nope.not.a.key');
    assert.strictEqual(t('en', 'nope.not.a.key'), 'nope.not.a.key');
    assert.strictEqual(t('en', ''), '');
    assert.strictEqual(t('en', null), '');
});

test('t: a key missing from Italian falls back to the English string', () => {
    // Simulated rather than relying on a real gap — the suite below asserts
    // there are none.
    const originalHas = has('it', 'common.close');
    assert.ok(originalHas);
    const saved = IT['common.close'];
    try {
        delete IT['common.close'];
        assert.strictEqual(has('it', 'common.close'), false);
        assert.strictEqual(t('it', 'common.close'), EN['common.close']);
    } finally {
        IT['common.close'] = saved;
    }
});

test('t: substitutes {name} placeholders', () => {
    assert.strictEqual(t('en', 'toast.size', {size: 275}), 'Size 275 px');
    assert.ok(t('it', 'toast.size', {size: 275}).includes('275'));
    assert.strictEqual(t('en', 'detector.detectedAt', {map: 'East Haddonfield', time: '21:37'}),
        'Detected East Haddonfield at 21:37');
});

test('t: leaves a placeholder alone when nothing is supplied for it', () => {
    // electron-updater substitutes {appName} and {version} in the notification
    // body *after* we have translated it. Eating them would break that.
    const body = t('en', 'update.notify.body');
    assert.ok(body.includes('{appName}'), body);
    assert.ok(body.includes('{version}'), body);
    assert.ok(t('it', 'update.notify.body').includes('{appName}'));
    assert.strictEqual(format('a {x} b {y}', {x: 1}), 'a 1 b {y}');
    assert.strictEqual(format('a {x}', null), 'a {x}');
    assert.strictEqual(format('a {x}', {x: null}), 'a {x}');
});

test('t: a parameter that is itself a message is translated too', () => {
    // "X is already bound to <action>": main builds both halves without
    // knowing the language, so the inner noun travels as a message.
    const message = msg('hotkeys.error.boundTo', {
        accelerator: 'Ctrl + R',
        action: msg('hotkeys.action.rotate-map')
    });
    const english = translateMessage('en', message);
    const italian = translateMessage('it', message);
    assert.ok(english.includes(EN['hotkeys.action.rotate-map']), english);
    assert.ok(italian.includes(IT['hotkeys.action.rotate-map']), italian);
    assert.ok(english.includes('Ctrl + R') && italian.includes('Ctrl + R'));
});

test('msg / translateMessage: the IPC shape round-trips', () => {
    assert.deepStrictEqual(msg('common.ok'), {key: 'common.ok'});
    assert.deepStrictEqual(msg('toast.size', {size: 1}), {key: 'toast.size', params: {size: 1}});
    assert.strictEqual(translateMessage('en', msg('common.close')), EN['common.close']);
    // A plain string from an unconverted path still shows, rather than vanishing.
    assert.strictEqual(translateMessage('en', 'literal'), 'literal');
    for (const junk of [null, undefined, 42, {}, {key: 7}]) {
        assert.strictEqual(translateMessage('en', junk), '', JSON.stringify(junk));
    }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Language resolution
 * ──────────────────────────────────────────────────────────────────────────── */

test('resolveLanguage: an explicit choice wins over the locale', () => {
    assert.strictEqual(resolveLanguage('en', 'it-IT'), 'en');
    assert.strictEqual(resolveLanguage('it', 'en-US'), 'it');
});

test('resolveLanguage: "system" follows the OS locale by prefix', () => {
    for (const locale of ['it', 'it-IT', 'it-CH', 'IT-it', 'it_IT']) {
        assert.strictEqual(resolveLanguage('system', locale), 'it', locale);
    }
    for (const locale of ['en', 'en-GB', 'de-DE', 'fr', 'italian', '', null, undefined]) {
        assert.strictEqual(resolveLanguage('system', locale), 'en', String(locale));
    }
});

test('resolveLanguage: anything unrecognised behaves like "system"', () => {
    assert.strictEqual(resolveLanguage('klingon', 'it-IT'), 'it');
    assert.strictEqual(resolveLanguage(undefined, 'it-IT'), 'it');
    assert.strictEqual(resolveLanguage(null, 'en-US'), 'en');
});

test('the language setting agrees with the catalogues it can choose from', () => {
    assert.deepStrictEqual(LANGUAGE_SETTING_VALUES, ['system'].concat(LANGUAGES));
    assert.ok(LANGUAGE_SETTING_VALUES.includes(DEFAULT_SETTINGS.language));
    for (const lang of LANGUAGES) assert.ok(CATALOGUES[lang], `no catalogue for ${lang}`);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The catalogues themselves
 *
 * Nothing below lists a key by hand: the source *is* the list. Adding a
 * `data-i18n` attribute or a `t('…')` call and forgetting the JSON therefore
 * fails here rather than showing a raw key to a user.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Files that may use translation keys. */
function sourceFiles() {
    const files = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === 'i18n') continue;
                walk(full);
            } else if (/\.(js|html)$/i.test(entry.name)) {
                files.push(full);
            }
        }
    };
    walk(path.join(ROOT, 'src'));
    files.push(path.join(ROOT, 'index.js'));
    return files;
}

/**
 * Every translation key referenced by the source, by the four ways a key can
 * appear. All keys are dotted, which is what keeps these patterns from
 * matching ordinary `t(x)` calls or unrelated `key:` properties.
 */
const KEY = String.raw`[A-Za-z][\w-]*(?:\.[\w-]+)+`;
const KEY_PATTERNS = [
    // t('a.b')  ·  t(lang, 'a.b')  ·  this.t('a.b')  ·  i18n.t('a.b')
    new RegExp(String.raw`\bt\(\s*(?:[A-Za-z_$][\w.$]*\s*,\s*)?['"](${KEY})['"]`, 'g'),
    // msg('a.b')
    new RegExp(String.raw`\bmsg\(\s*['"](${KEY})['"]`, 'g'),
    // data-i18n="a.b", data-i18n-html/-title/-placeholder/-aria-label
    new RegExp(String.raw`data-i18n(?:-[a-z-]+)?="(${KEY})"`, 'g'),
    // descriptionKey: 'a.b' and any other …Key: '<dotted>' property
    new RegExp(String.raw`\w*Key:\s*['"](${KEY})['"]`, 'g')
];

function keysUsedIn(text) {
    const found = new Set();
    for (const pattern of KEY_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) found.add(match[1]);
    }
    return found;
}

const USED = (() => {
    const byKey = new Map();
    for (const file of sourceFiles()) {
        const text = fs.readFileSync(file, 'utf-8');
        for (const key of keysUsedIn(text)) {
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key).push(path.relative(ROOT, file));
        }
    }
    return byKey;
})();

test('the key scan actually found the keys (guard against a broken regex)', () => {
    // If the patterns above ever stop matching, every test below would pass
    // vacuously. These are keys used by all four forms.
    assert.ok(USED.size > 80, `only ${USED.size} keys found in the source`);
    for (const key of ['common.close', 'update.checking', 'settings.title', 'hotkeys.action.toggle-map']) {
        assert.ok(USED.has(key), `${key} was not found by the scan`);
    }
});

test('every key used in the code exists in both catalogues', () => {
    const missing = [];
    for (const [key, files] of USED) {
        for (const lang of LANGUAGES) {
            if (!has(lang, key)) missing.push(`${lang}: ${key} (${files.join(', ')})`);
        }
    }
    assert.deepStrictEqual(missing, [], `missing translations:\n  ${missing.join('\n  ')}`);
});

test('no catalogue key is dead weight', () => {
    // The reverse direction: a string nothing uses is either a typo at the
    // call site or a leftover, and both are worth knowing about.
    const orphans = Object.keys(EN).filter(key => !USED.has(key));
    assert.deepStrictEqual(orphans, [], `unused catalogue keys:\n  ${orphans.join('\n  ')}`);
});

test('both catalogues have exactly the same keys', () => {
    const enKeys = Object.keys(EN).sort();
    const itKeys = Object.keys(IT).sort();
    assert.deepStrictEqual(itKeys, enKeys);
});

test('no catalogue string is empty, and every placeholder is matched across languages', () => {
    const placeholders = (s) => (s.match(/\{(\w+)\}/g) || []).sort();
    for (const [key, value] of Object.entries(EN)) {
        assert.strictEqual(typeof value, 'string', key);
        assert.ok(value.trim().length > 0, `${key} is empty in en`);
        const italian = IT[key];
        assert.ok(italian && italian.trim().length > 0, `${key} is empty in it`);
        // A translation that dropped a {param} would render a sentence with a
        // hole in it, which no other test would notice.
        assert.deepStrictEqual(placeholders(italian), placeholders(value),
            `${key}: placeholders differ between en and it`);
    }
});

test('every system hotkey action has a translated name', () => {
    for (const [actionId, def] of Object.entries(SYSTEM_HOTKEY_DEFS)) {
        assert.ok(def.descriptionKey, `${actionId} has no descriptionKey`);
        for (const lang of LANGUAGES) {
            assert.ok(has(lang, def.descriptionKey), `${lang}: ${def.descriptionKey}`);
        }
        // The English catalogue string is the definition's own description, so
        // the two can never drift into saying different things.
        assert.strictEqual(EN[def.descriptionKey], def.description, actionId);
    }
});

test('no user-facing literal is left in the markup', () => {
    // Every <label>, <button>, <h1..h6>, <option> and <th> in the main window
    // must carry a data-i18n attribute. Exempt: elements whose visible text all
    // lives in translated children, purely numeric text (the 90° rotation
    // options, the blank action columns), and anything explicitly marked
    // `data-i18n-ignore` — the language names, which stay in their own
    // language, and the hotkey modal title, which JS owns.
    const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf-8');
    const offenders = [];
    const tagPattern = /<(label|button|h1|h2|h3|h4|h5|h6|option|th)\b([^>]*)>([\s\S]*?)<\/\1>/g;
    let match;
    while ((match = tagPattern.exec(html)) !== null) {
        const [, tag, attrs, body] = match;
        if (/data-i18n/.test(attrs)) continue;
        // A wrapper whose children are all translated is fine.
        if (/data-i18n/.test(body)) continue;
        const text = body.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;|&#\d+;/gi, ' ').trim();
        if (!text) continue;
        if (/^[\d\s°.+-]*$/.test(text)) continue;
        offenders.push(`<${tag}> ${text.slice(0, 60)}`);
    }
    assert.deepStrictEqual(offenders, [],
        `untranslated markup:\n  ${offenders.join('\n  ')}`);
});
