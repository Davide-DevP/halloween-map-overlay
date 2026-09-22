const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {webPreferences} = require('../src/shared/web-preferences');

test('the architecture flags are what the rest of the app assumes', () => {
    const prefs = webPreferences();
    // Every renderer in this app `require`s jQuery, Bootstrap and the shared
    // modules straight out of its <script> tags. Flipping either of these
    // breaks every window at once — see "No context isolation" in docs/agents/architecture.md.
    assert.strictEqual(prefs.nodeIntegration, true);
    assert.strictEqual(prefs.contextIsolation, false);
});

test('the subsystems this app does not have are off', () => {
    const prefs = webPreferences();
    // Electron defaults `spellcheck` to true, which builds a SpellCheckHost
    // and loads a dictionary in every renderer. The app has one editable text
    // field (a map name) and one read-only one (the hotkey box).
    assert.strictEqual(prefs.spellcheck, false);
    // Nothing draws with WebGL: the settings preview is a 2D canvas and the
    // overlay is a PNG plus an SVG.
    assert.strictEqual(prefs.webgl, false);
    assert.strictEqual(prefs.enableWebSQL, false);
});

test('backgroundThrottling is left alone on purpose', () => {
    // The main window sits hidden in the tray for a whole match; throttling
    // its timers there is exactly right, and its hotkeys arrive as IPC, not
    // as timers. Pinning it either way would be a decision with no evidence
    // behind it, so the key must simply not be here.
    assert.ok(!Object.prototype.hasOwnProperty.call(webPreferences(), 'backgroundThrottling'));
});

test('extras are merged last and each call is a fresh object', () => {
    const prefs = webPreferences({spellcheck: true, preload: '/x'});
    assert.strictEqual(prefs.spellcheck, true);
    assert.strictEqual(prefs.preload, '/x');
    // A `webPreferences` object handed to two BrowserWindows is a shared
    // mutable object Electron writes back into.
    assert.notStrictEqual(webPreferences(), webPreferences());
});

test('every window in the app is built through this one builder', () => {
    // Five windows now (main, overlay, OBS, Tab markers, controller input) and the next one must
    // not quietly go back to an inline object — that is how three of them ended
    // up with spellcheck on for years.
    const files = [
        'src/core/main-window.js',
        'src/core/overlay-window.js',
        'src/core/obs-window.js',
        'src/core/tab-overlay-window.js',
        'src/core/pad-window.js'
    ];
    for (const file of files) {
        const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        assert.ok(/webPreferences:\s*webPreferences\(/.test(src),
            `${file} does not build its webPreferences with the shared builder`);
        assert.ok(/require\(['"]\.\.\/shared\/web-preferences['"]\)/.test(src),
            `${file} does not require the shared builder`);
    }
});
