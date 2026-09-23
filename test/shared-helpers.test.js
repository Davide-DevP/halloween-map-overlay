const {test} = require('node:test');
const assert = require('node:assert');
const {errorMessage} = require('../src/shared/errors');
const {clearTimer, unrefTimer} = require('../src/shared/timers');

test('errorMessage: an Error gives its message, anything else is stringified', () => {
    assert.strictEqual(errorMessage(new Error('boom')), 'boom');
    assert.strictEqual(errorMessage('plain'), 'plain');
    assert.strictEqual(errorMessage(null), 'null');
    assert.strictEqual(errorMessage(undefined), 'undefined');
    assert.strictEqual(errorMessage({message: ''}), '[object Object]');
});

test('clearTimer: cancels, tolerates null, and always answers null', () => {
    let fired = false;
    const handle = setTimeout(() => { fired = true; }, 5);
    assert.strictEqual(clearTimer(handle), null);
    assert.strictEqual(clearTimer(null), null);
    assert.strictEqual(clearTimer(undefined), null);
    return new Promise(resolve => setTimeout(() => {
        assert.strictEqual(fired, false, 'a cleared timer fired');
        resolve();
    }, 20));
});

test('unrefTimer: unrefs a real handle, passes anything else through', () => {
    const handle = setTimeout(() => {}, 1000);
    assert.strictEqual(unrefTimer(handle), handle);
    assert.strictEqual(handle.hasRef(), false);
    clearTimeout(handle);
    assert.strictEqual(unrefTimer(null), null);
    const bare = {};
    assert.strictEqual(unrefTimer(bare), bare);
});
