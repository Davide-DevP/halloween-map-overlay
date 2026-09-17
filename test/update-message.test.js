const test = require('node:test');
const assert = require('node:assert');

const {updateReadyHeadline} = require('../src/shared/update-message');

test('names the version it was given', () => {
    assert.strictEqual(updateReadyHeadline('en', '0.2.1'), 'Version 0.2.1 is ready.');
    assert.strictEqual(updateReadyHeadline('en', '1.0.0-beta.2'), 'Version 1.0.0-beta.2 is ready.');
});

test('trims surrounding whitespace', () => {
    assert.strictEqual(updateReadyHeadline('en', '  0.3.0\n'), 'Version 0.3.0 is ready.');
});

test('falls back when the version is missing or not a version', () => {
    for (const bad of [undefined, null, '', '   ', 42, {}, '<img src=x onerror=alert(1)>', 'a b', '"0.1.0"']) {
        assert.strictEqual(updateReadyHeadline('en', bad), 'A new version is ready.',
            `expected the fallback for ${JSON.stringify(bad)}`);
    }
});

test('speaks the language it is given, and names the version in both', () => {
    const italian = updateReadyHeadline('it', '0.3.0');
    assert.ok(italian.includes('0.3.0'), italian);
    assert.notStrictEqual(italian, updateReadyHeadline('en', '0.3.0'));
    assert.notStrictEqual(updateReadyHeadline('it'), updateReadyHeadline('en'));
    // An unknown language falls back to English rather than showing a key.
    assert.strictEqual(updateReadyHeadline('de', '0.3.0'), updateReadyHeadline('en', '0.3.0'));
});
