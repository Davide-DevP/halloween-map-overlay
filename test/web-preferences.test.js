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

/** Every `.js` file under `dir`, recursively. */
function sourceFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...sourceFiles(full));
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

/** The argument text of every `new BrowserWindow(…)` in `src`, parens balanced. */
function browserWindowCalls(src) {
    const calls = [];
    const needle = 'new BrowserWindow(';
    for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + 1)) {
        let depth = 0;
        let end = at + needle.length - 1;
        for (; end < src.length; end++) {
            if (src[end] === '(') depth += 1;
            else if (src[end] === ')' && --depth === 0) break;
        }
        calls.push({line: src.slice(0, at).split('\n').length, args: src.slice(at + needle.length, end)});
    }
    return calls;
}

test('every BrowserWindow in the app is built through this one builder', () => {
    // Found by grep, not listed by hand, so a sixth window cannot skip the
    // builder unnoticed — an inline object is how three windows ran with
    // spellcheck on for years.
    const root = path.join(__dirname, '..');
    const sites = [];
    for (const file of sourceFiles(path.join(root, 'src'))) {
        const src = fs.readFileSync(file, 'utf8');
        const calls = browserWindowCalls(src);
        if (!calls.length) continue;
        const rel = path.relative(root, file).split(path.sep).join('/');
        assert.ok(/require\(['"]\.\.\/shared\/web-preferences['"]\)/.test(src),
            `${rel} builds a window but does not require the shared builder`);
        for (const call of calls) {
            sites.push(rel);
            assert.ok(/webPreferences:\s*webPreferences\(/.test(call.args),
                `${rel}:${call.line} builds a BrowserWindow without webPreferences()`);
        }
    }
    // A floor, so a grep that silently matched nothing cannot pass: main,
    // overlay, OBS, Tab markers, controller input.
    for (const file of ['main-window', 'overlay-window', 'obs-window', 'tab-overlay-window', 'pad-window']) {
        assert.ok(sites.includes(`src/core/${file}.js`), `no BrowserWindow found in ${file}.js`);
    }
});
