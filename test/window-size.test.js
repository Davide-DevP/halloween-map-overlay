'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
    MAIN_WINDOW_DEFAULT,
    MAIN_WINDOW_MIN,
    readSize,
    clampWindowSize,
    minimumSize,
    sizeToPersist
} = require('../src/shared/window-size');

const FULL_HD = {x: 0, y: 0, width: 1920, height: 1040};

test('the default is 1100x820 and the minimum 900x640', () => {
    assert.deepStrictEqual({...MAIN_WINDOW_DEFAULT}, {width: 1100, height: 820});
    assert.deepStrictEqual({...MAIN_WINDOW_MIN}, {width: 900, height: 640});
});

test('clampWindowSize: nothing stored opens at the default', () => {
    for (const saved of [null, undefined, {}, [], 'big', 42, {width: 'x', height: 700},
        {width: NaN, height: 700}, {width: Infinity, height: 700}, {width: -5, height: 700}, {width: 0, height: 0}]) {
        assert.deepStrictEqual(clampWindowSize(saved, FULL_HD), {width: 1100, height: 820}, JSON.stringify(saved));
    }
});

test('clampWindowSize: a stored size inside the screen is used as it is', () => {
    assert.deepStrictEqual(clampWindowSize({width: 1300, height: 900}, FULL_HD), {width: 1300, height: 900});
    assert.deepStrictEqual(clampWindowSize({width: 1250.6, height: 899.4}, FULL_HD), {width: 1251, height: 899});
});

test('clampWindowSize: never below the minimum, never past the work area', () => {
    assert.deepStrictEqual(clampWindowSize({width: 400, height: 300}, FULL_HD), {width: 900, height: 640});
    // Saved on a bigger monitor that is no longer there.
    assert.deepStrictEqual(clampWindowSize({width: 3800, height: 2100}, FULL_HD), {width: 1920, height: 1040});
});

test('clampWindowSize: the default itself shrinks on a small screen', () => {
    const laptop = {x: 0, y: 0, width: 1366, height: 728};
    assert.deepStrictEqual(clampWindowSize(null, laptop), {width: 1100, height: 728});
    // A work area smaller than the minimum wins over the minimum.
    const tiny = {x: 0, y: 0, width: 800, height: 560};
    assert.deepStrictEqual(clampWindowSize(null, tiny), {width: 800, height: 560});
    assert.deepStrictEqual(minimumSize(tiny), {width: 800, height: 560});
    assert.deepStrictEqual(minimumSize(FULL_HD), {width: 900, height: 640});
});

test('clampWindowSize: an unknown work area only applies the minimum', () => {
    assert.deepStrictEqual(clampWindowSize({width: 5000, height: 300}, null), {width: 5000, height: 640});
    assert.deepStrictEqual(minimumSize(undefined), {width: 900, height: 640});
});

test('sizeToPersist: a maximised, minimised or full-screen window stores nothing', () => {
    const size = {width: 1920, height: 1040};
    assert.strictEqual(sizeToPersist(size, {maximized: true}, null), null);
    assert.strictEqual(sizeToPersist(size, {minimized: true}, null), null);
    assert.strictEqual(sizeToPersist(size, {fullScreen: true}, null), null);
});

test('sizeToPersist: only a real change is written, and only the size', () => {
    assert.deepStrictEqual(sizeToPersist({width: 1200, height: 850, x: 10, y: 20}, {}, null),
        {width: 1200, height: 850});
    assert.strictEqual(sizeToPersist({width: 1200, height: 850}, {}, {width: 1200, height: 850}), null);
    assert.deepStrictEqual(sizeToPersist({width: 1201, height: 850}, null, {width: 1200, height: 850}),
        {width: 1201, height: 850});
    assert.strictEqual(sizeToPersist(null, {}, null), null);
    assert.strictEqual(sizeToPersist({width: 0, height: 850}, {}, null), null);
});

test('readSize: rejects anything that is not two positive numbers', () => {
    assert.strictEqual(readSize({width: 10}), null);
    assert.strictEqual(readSize([10, 10]), null);
    assert.deepStrictEqual(readSize({width: 10, height: 20}), {width: 10, height: 20});
});
