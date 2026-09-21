const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const {LANGUAGES} = require('../src/shared/i18n');

/*
 * The installer ships only the Chromium locales in `build.electronLanguages`,
 * and the files a `build.files` exclusion removes are gone for good. Neither
 * mistake shows up until a packaged build runs, so both are pinned here.
 * See docs/agents/i18n.md § Adding a language.
 */

test('every app language ships its Chromium locale', () => {
    const shipped = pkg.build.electronLanguages.map(l => l.toLowerCase());
    for (const lang of LANGUAGES) {
        const primary = lang.toLowerCase().split('-')[0];
        assert.ok(shipped.some(l => l === lang.toLowerCase() || l.split('-')[0] === primary),
            `build.electronLanguages has no locale for "${lang}": "System" would fall back to English`);
    }
    assert.ok(shipped.includes('en-us'), 'en-US is Chromium\'s own fallback and must always ship');
});

test('the packaging exclusions do not remove a file the app loads', () => {
    const exclusions = pkg.build.files.filter(p => p.startsWith('!')).map(p => p.slice(1));
    // The entry points `require()` and the HTML resolve to, written out: a
    // glob engine is a dev dependency this tier does not have.
    const loaded = [
        'node_modules/jquery/dist/jquery.js',
        'node_modules/bootstrap/dist/js/bootstrap.js',
        'node_modules/bootstrap/dist/css/bootstrap.min.css',
        'node_modules/@popperjs/core/dist/cjs/popper.js',
        'node_modules/@fontsource-variable/geist/index.css',
        'node_modules/@fontsource-variable/geist-mono/index.css'
    ];
    for (const file of loaded) {
        assert.ok(fs.existsSync(path.join(__dirname, '..', file)), `${file} is not where the app expects it`);
        assert.ok(!exclusions.includes(file), `${file} is excluded from the package`);
    }
    assert.strictEqual(require.resolve('jquery').split(path.sep).join('/').endsWith(loaded[0]), true);
    assert.strictEqual(require.resolve('bootstrap').split(path.sep).join('/').endsWith(loaded[1]), true);
    assert.strictEqual(require.resolve('@popperjs/core').split(path.sep).join('/').endsWith(loaded[3]), true);
});
