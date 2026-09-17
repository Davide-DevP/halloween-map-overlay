const {test} = require('node:test');
const assert = require('node:assert');
const {escapeHtml} = require('../src/shared/escape-html');

test('escapes every character that can break out of markup', () => {
    assert.strictEqual(escapeHtml('<script>'), '&lt;script&gt;');
    assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
    assert.strictEqual(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
    assert.strictEqual(escapeHtml("it's"), 'it&#39;s');
});

test('ampersands are escaped first, so nothing is double-decoded', () => {
    assert.strictEqual(escapeHtml('&lt;'), '&amp;lt;');
});

test('a custom map name cannot inject an element', () => {
    const name = '<img src=x onerror="alert(1)">';
    const escaped = escapeHtml(name);
    assert.ok(!escaped.includes('<'));
    assert.ok(!escaped.includes('>'));
    assert.ok(!escaped.includes('"'));
});

test('a quote in a map name cannot truncate a data attribute', () => {
    const html = `<button data-key="${escapeHtml('My " Map')}">`;
    assert.strictEqual(html, '<button data-key="My &quot; Map">');
});

test('nullish and non-string input is handled', () => {
    assert.strictEqual(escapeHtml(null), '');
    assert.strictEqual(escapeHtml(undefined), '');
    assert.strictEqual(escapeHtml(''), '');
    assert.strictEqual(escapeHtml(0), '0');
    assert.strictEqual(escapeHtml(false), 'false');
});

test('ordinary text is left alone', () => {
    assert.strictEqual(escapeHtml('East Haddonfield'), 'East Haddonfield');
    assert.strictEqual(escapeHtml('deftyconchgaming/East Haddonfield'), 'deftyconchgaming/East Haddonfield');
});
