const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
    t, has, msg, translateMessage, systemLanguage, resolveLanguage, format,
    LANGUAGES, LANGUAGE_SETTING_VALUES, CATALOGUES
} = require('../src/shared/i18n');
const {SYSTEM_HOTKEY_DEFS} = require('../src/shared/hotkeys-constants');
const {DEFAULT_SETTINGS} = require('../src/shared/settings-defaults');

const ROOT = path.join(__dirname, '..');
const EN = CATALOGUES.en;
const IT = CATALOGUES.it;

/** Every language that has to match English key for key. English is the source. */
const TRANSLATIONS = LANGUAGES.filter(lang => lang !== 'en');

/** A language code that will never have a catalogue, for the fallback tests. */
const NO_SUCH_LANGUAGE = 'zz';

/**
 * Key order, captured at load time. The fallback test below deletes a key from
 * the Italian catalogue and puts it back, and `obj[key] = value` re-adds it at
 * the *end* — so asking for `Object.keys()` later would compare a shuffled
 * object and blame the JSON file.
 */
const KEY_ORDER = Object.fromEntries(
    LANGUAGES.map(lang => [lang, Object.keys(CATALOGUES[lang])])
);

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
    assert.ok(!LANGUAGES.includes(NO_SUCH_LANGUAGE));
    assert.strictEqual(t(NO_SUCH_LANGUAGE, 'common.close'), EN['common.close']);
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
        'Map detected: East Haddonfield at 21:37');
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

/**
 * The detection rule, as a pure function of the locale alone. Every case is
 * listed here rather than derived from `SYSTEM_LANGUAGE_RULES`, because a typo
 * in the rule table would otherwise be copied into its own test.
 */
const SYSTEM_LOCALE_CASES = [
    // Italian
    ['it', 'it'], ['it-IT', 'it'], ['it-CH', 'it'], ['IT-it', 'it'], ['it_IT', 'it'],
    // Spanish — Spain, Latin America and the region-neutral tag
    ['es', 'es'], ['es-ES', 'es'], ['es-MX', 'es'], ['es-419', 'es'], ['es_AR', 'es'],
    // German — Germany, Austria, Switzerland
    ['de', 'de'], ['de-DE', 'de'], ['de-AT', 'de'], ['de-CH', 'de'],
    // French — France, Canada, Belgium
    ['fr', 'fr'], ['fr-FR', 'fr'], ['fr-CA', 'fr'], ['fr-BE', 'fr'],
    // Every Portuguese locale, not only pt-BR: there is one Portuguese
    // catalogue and Brazilian Portuguese serves a pt-PT reader far better
    // than English does.
    ['pt', 'pt-BR'], ['pt-BR', 'pt-BR'], ['pt-PT', 'pt-BR'], ['pt_BR', 'pt-BR'],
    // Everything else, including languages we do not ship
    ['en', 'en'], ['en-GB', 'en'], ['ja', 'en'], ['pl-PL', 'en'], ['nl', 'en'],
    // A whole word that merely starts with a prefix is NOT that prefix: the
    // rules match a BCP 47 subtag, not a substring.
    ['italian', 'en'], ['espanol', 'en'], ['deutsch', 'en'], ['french', 'en'],
    ['portuguese', 'en'], ['esperanto', 'en'], ['frisian', 'en'],
    // Junk
    ['', 'en'], [null, 'en'], [undefined, 'en'], ['-', 'en']
];

test('systemLanguage: the rule is a pure function of the locale', () => {
    for (const [locale, expected] of SYSTEM_LOCALE_CASES) {
        assert.strictEqual(systemLanguage(locale), expected, String(locale));
    }
});

test('systemLanguage: never answers with a language that has no catalogue', () => {
    for (const [locale] of SYSTEM_LOCALE_CASES) {
        assert.ok(LANGUAGES.includes(systemLanguage(locale)), String(locale));
    }
});

test('resolveLanguage: "system" follows the OS locale by prefix', () => {
    for (const [locale, expected] of SYSTEM_LOCALE_CASES) {
        assert.strictEqual(resolveLanguage('system', locale), expected, String(locale));
    }
});

test('resolveLanguage: anything unrecognised behaves like "system"', () => {
    assert.strictEqual(resolveLanguage('klingon', 'it-IT'), 'it');
    assert.strictEqual(resolveLanguage(undefined, 'it-IT'), 'it');
    assert.strictEqual(resolveLanguage(null, 'en-US'), 'en');
    assert.strictEqual(resolveLanguage('pt', 'de-DE'), 'de'); // 'pt' is not a setting value
    assert.strictEqual(resolveLanguage('pt-BR', 'de-DE'), 'pt-BR');
});

test('the language setting agrees with the catalogues it can choose from', () => {
    assert.deepStrictEqual(LANGUAGE_SETTING_VALUES, ['system'].concat(LANGUAGES));
    assert.ok(LANGUAGE_SETTING_VALUES.includes(DEFAULT_SETTINGS.language));
    for (const lang of LANGUAGES) assert.ok(CATALOGUES[lang], `no catalogue for ${lang}`);
    assert.strictEqual(LANGUAGES[0], 'en', 'English must stay the fallback');
    // No catalogue without a language, either: a file added to src/i18n/ and
    // never wired up would show nobody anything.
    const files = fs.readdirSync(path.join(ROOT, 'src', 'i18n'))
        .filter(name => name.endsWith('.json'))
        .map(name => name.replace(/\.json$/, ''))
        .sort();
    assert.deepStrictEqual(files, LANGUAGES.slice().sort());
});

test('the language picker offers exactly the languages that exist', () => {
    // Settings › General. The welcome tour's own select is filled by cloning
    // these options (`Onboarding.mirror`), so it cannot drift on its own.
    const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf-8');
    const select = html.match(/<select[^>]*id="languageSelect"[\s\S]*?<\/select>/);
    assert.ok(select, 'no #languageSelect in src/index.html');
    const values = [...select[0].matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
    assert.deepStrictEqual(values, LANGUAGE_SETTING_VALUES);
    // Every language name stays in its own language, so it must be exempt from
    // the "no untranslated markup" rule below rather than carry a data-i18n.
    for (const option of select[0].match(/<option[^>]*>/g)) {
        if (/value="system"/.test(option)) continue;
        assert.match(option, /data-i18n-ignore/, option);
    }
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

test('every key used in the code exists in every catalogue', () => {
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

test('every catalogue has exactly the same keys as English, in the same order', () => {
    // Same order too: the files are meant to diff line against line, and a
    // reviewer comparing a translation with the source reads them side by side.
    for (const lang of TRANSLATIONS) {
        assert.deepStrictEqual(KEY_ORDER[lang], KEY_ORDER.en,
            `${lang}: key set or key order differs from en`);
    }
});

/** `{name}` placeholders, as a sorted multiset. */
const placeholders = (s) => (s.match(/\{(\w+)\}/g) || []).sort();

/**
 * HTML tag *names*, as a sorted multiset — `["/em", "em", "kbd"]`.
 *
 * Only the `data-i18n-html` strings carry markup, and it is inserted with
 * `innerHTML`, so a translation that lost a `</strong>` or gained a stray
 * `<em>` would silently reflow the rest of the paragraph. Attributes are
 * deliberately not compared: only `credits.basedOn` has any, and its `href`
 * is checked by the whole-fragment rule below.
 */
const tagNames = (s) => (s.match(/<\/?([a-zA-Z][\w-]*)/g) || [])
    .map(tag => tag.slice(1).toLowerCase())
    .sort();

/**
 * Named/numeric entities, as a sorted multiset, minus the ones that are
 * *content* rather than structure and legitimately differ per language:
 *
 * - `&amp;` is a literal ampersand in a sentence. English writes the Windows
 *   screen's name as "Virus &amp; threat protection"; the same screen is
 *   "Proteção contra vírus e ameaças" in Portuguese, with no ampersand at all.
 * - `&mdash;` / `&ndash;` are punctuation. A language that sets an aside with
 *   a colon or a comma instead of a dash is not missing anything — Italian
 *   already does exactly that in `faq.keyboard.a` and `faq.updates.a`.
 *
 * What is left — `&rarr;`, `&nbsp;` and anything like them — is part of the
 * sentence's shape (a menu path, a space that must not break) and has to
 * survive translation, so those stay compared one for one.
 */
const CONTENT_ENTITIES = new Set(['&amp;', '&mdash;', '&ndash;']);
const entities = (s) => (s.match(/&[a-zA-Z]+;|&#\d+;/g) || [])
    .filter(entity => !CONTENT_ENTITIES.has(entity))
    .sort();

test('no catalogue string is empty', () => {
    for (const lang of LANGUAGES) {
        for (const [key, value] of Object.entries(CATALOGUES[lang])) {
            assert.strictEqual(typeof value, 'string', `${lang}: ${key}`);
            assert.ok(value.trim().length > 0, `${lang}: ${key} is empty`);
        }
    }
});

test('every placeholder survives every translation', () => {
    // A translation that dropped a {param} would render a sentence with a hole
    // in it, and one that invented a {param} would print the braces.
    for (const lang of TRANSLATIONS) {
        for (const [key, english] of Object.entries(EN)) {
            assert.deepStrictEqual(placeholders(CATALOGUES[lang][key]), placeholders(english),
                `${lang}: ${key}: placeholders differ from en`);
        }
    }
});

test('every HTML fragment survives every translation', () => {
    for (const lang of TRANSLATIONS) {
        for (const [key, english] of Object.entries(EN)) {
            const translated = CATALOGUES[lang][key];
            assert.deepStrictEqual(tagNames(translated), tagNames(english),
                `${lang}: ${key}: HTML tags differ from en`);
            assert.deepStrictEqual(entities(translated), entities(english),
                `${lang}: ${key}: HTML entities differ from en`);
        }
    }
});

test('the one link in the catalogues is the same link in every language', () => {
    // `credits.basedOn` is the only string with an attribute-carrying tag, and
    // the attribution it carries is a licence obligation (see NOTICE).
    const anchor = /<a target="_blank" href="https:\/\/github\.com\/LucaFontanot\/dbd-map-overlay">/;
    for (const lang of LANGUAGES) {
        assert.match(CATALOGUES[lang]['credits.basedOn'], anchor, lang);
        assert.ok(CATALOGUES[lang]['credits.basedOn'].includes('DBD Map Overlay'), lang);
        assert.ok(CATALOGUES[lang]['credits.basedOn'].includes('LucaFontanot'), lang);
    }
});

/**
 * Strings that are allowed to come out of a translation unchanged. Everything
 * else that matches English is an untranslated string, not a coincidence.
 *
 * Kept small and listed by hand: each one is either a borrowed word this app
 * uses as its own term, a bare placeholder with a unit, or a label that really
 * is spelled the same in more than one of our languages.
 */
const MAY_MATCH_ENGLISH = new Set([
    'common.ok',              // "OK" everywhere
    'common.error',           // "Error: {message}" — Spanish spells it the same
    'nav.faq',                // the app's own abbreviation, kept in the nav bar
    'settings.tab.general',   // "General" in Spanish
    'settings.tab.overlay',   // "Overlay" is this app's term for the window
    'settings.tab.hotkeys',   // "Hotkeys" in German
    'settings.monitor',       // "Monitor"
    'settings.value.px',      // "{value} px"
    'settings.value.percent', // "{value} %"
    'settings.glideX',        // "Horizontal (X)"
    'settings.glideY',        // "Vertical (Y)"
    'settings.rotation',      // "Rotation" in French
    'hotkeys.system',         // "System" in German
    'hotkeys.col.action',     // "Action" in French
    'hotkeys.col.hotkey'      // "Hotkey" in German
]);

test('nothing is left untranslated', () => {
    const untranslated = [];
    for (const lang of TRANSLATIONS) {
        for (const [key, english] of Object.entries(EN)) {
            if (MAY_MATCH_ENGLISH.has(key)) continue;
            if (CATALOGUES[lang][key] === english) untranslated.push(`${lang}: ${key}`);
        }
    }
    assert.deepStrictEqual(untranslated, [],
        `identical to English:\n  ${untranslated.join('\n  ')}`);
});

test('the whitelist earns its place', () => {
    // A key that no longer matches English in any language is a leftover here,
    // and the exemption would then hide a real regression in that string.
    const pointless = [...MAY_MATCH_ENGLISH].filter(key => (
        typeof EN[key] === 'string' &&
        !TRANSLATIONS.some(lang => CATALOGUES[lang][key] === EN[key])
    ));
    assert.deepStrictEqual(pointless, [],
        `no longer needed in MAY_MATCH_ENGLISH:\n  ${pointless.join('\n  ')}`);
    for (const key of MAY_MATCH_ENGLISH) {
        assert.ok(typeof EN[key] === 'string', `${key} is not a catalogue key`);
    }
});

test('the catalogue files are UTF-8 without a BOM and indented like en.json', () => {
    // They are `require`d, so a BOM would be a parse error at startup rather
    // than here — but the indentation and the blank-line grouping are what
    // keep a translation diffable against the English it came from.
    const read = (lang) => fs.readFileSync(path.join(ROOT, 'src', 'i18n', `${lang}.json`));
    const blankLines = (text) => text.split('\n')
        .map((line, index) => [index, line.trim()])
        .filter(([, line]) => line === '')
        .map(([index]) => index);
    const english = read('en').toString('utf-8');
    for (const lang of LANGUAGES) {
        const raw = read(lang);
        assert.notStrictEqual(raw[0], 0xEF, `${lang}.json starts with a BOM`);
        const text = raw.toString('utf-8');
        // Whatever en.json does, every translation does too — a file that
        // disagrees rewrites every line the first time anyone touches it.
        assert.strictEqual(/\r\n/.test(text), /\r\n/.test(english),
            `${lang}.json does not use the same line endings as en.json`);
        for (const line of text.split('\n')) {
            if (/^\s+"/.test(line)) assert.match(line, /^ {2}"/, `${lang}.json: ${line.slice(0, 40)}`);
        }
        if (lang === 'en') continue;
        assert.deepStrictEqual(blankLines(text), blankLines(english),
            `${lang}.json: the blank-line grouping differs from en.json`);
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

/* ────────────────────────────────────────────────────────────────────────────
 * The English left inside src/index.html is a *fallback*
 *
 * `applyDom()` overwrites it on the first pass, so nobody running the app ever
 * sees it — which is exactly why it rots. Before this test there were 35 stale
 * ones: a button reading "Check for new maps" whose catalogue string is
 * "Check for new maps now", a `settings.checkForUpdates.help` still claiming
 * this is "the only network request this app makes", and most of the FAQ cut
 * down to its first sentence. A reader of the markup — or of a diff — believed
 * all of it.
 * ──────────────────────────────────────────────────────────────────────────── */

const HTML_ENTITIES = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'",
    '&nbsp;': ' ', '&rarr;': '→', '&larr;': '←', '&mdash;': '—', '&ndash;': '–',
    '&hellip;': '…', '&deg;': '°', '&times;': '×'
};

function decodeEntities(text) {
    return text.replace(/&[a-zA-Z]+;|&#\d+;/g, entity => (
        Object.prototype.hasOwnProperty.call(HTML_ENTITIES, entity) ? HTML_ENTITIES[entity] : entity
    ));
}

/** Compare on meaning, not on layout: entities decoded, whitespace collapsed. */
const normaliseMarkup = (text) => decodeEntities(text).replace(/\s+/g, ' ').trim();

test('every English fallback in the markup matches the English catalogue', () => {
    // Covered: the text inside a `data-i18n` / `data-i18n-html` element, and
    // the literal `title` / `placeholder` / `aria-label` sitting beside a
    // `data-i18n-title` / `-placeholder` / `-aria-label`.
    //
    // NOT covered, deliberately: anything a view module builds with `t()` at
    // render time (it carries no attribute and has no fallback to compare),
    // `data-i18n-ignore` elements (no catalogue string by definition), and
    // attribute values that are absent altogether — an attribute with no
    // fallback is not wrong, only undecorated.
    const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf-8');
    const stale = [];
    let elements = 0;

    // The body of an element carrying data-i18n / data-i18n-html.
    const bodyPattern = /<(\w+)([^>]*\bdata-i18n(-html)?="([^"]+)"[^>]*)>([\s\S]*?)<\/\1>/g;
    let match;
    while ((match = bodyPattern.exec(html)) !== null) {
        const [, , , htmlFlag, key, body] = match;
        elements++;
        if (!Object.prototype.hasOwnProperty.call(EN, key)) {
            stale.push(`${key}: not in en.json`);
            continue;
        }
        // The markup form keeps its tags; the text form has none to keep.
        const strip = (s) => (htmlFlag ? s : s.replace(/<[^>]*>/g, ''));
        const want = normaliseMarkup(strip(EN[key]));
        const got = normaliseMarkup(strip(body));
        if (want !== got) stale.push(`${key}\n      en.json: ${want}\n      markup : ${got}`);
    }

    // title / placeholder / aria-label beside their data-i18n-* twin.
    for (const attribute of ['title', 'placeholder', 'aria-label']) {
        const attrPattern = new RegExp(
            String.raw`data-i18n-${attribute}="([^"]+)"[^>]*?\s${attribute}="([^"]*)"`, 'g');
        while ((match = attrPattern.exec(html)) !== null) {
            const [, key, value] = match;
            elements++;
            if (!Object.prototype.hasOwnProperty.call(EN, key)) {
                stale.push(`${key}: not in en.json`);
                continue;
            }
            const want = normaliseMarkup(EN[key]);
            const got = normaliseMarkup(value);
            if (want !== got) stale.push(`${attribute}=${key}: en.json "${want}" vs markup "${got}"`);
        }
    }

    // Guard against a regex that quietly stops matching, which would make the
    // whole test pass on nothing at all.
    assert.ok(elements > 120, `only ${elements} fallbacks found in src/index.html`);
    assert.deepStrictEqual(stale, [],
        `stale English fallbacks in src/index.html:\n    ${stale.join('\n    ')}`);
});
