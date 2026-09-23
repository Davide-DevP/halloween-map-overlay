'use strict';
const path = require('path');
const {DEFAULT_SETTINGS} = require(path.join(__dirname, '..', '..', 'src/shared/settings-defaults'));

/*
 * A `core/settings.js` double with the real contract and no file:
 * `set`/`merge` return whether the write "reached the disk", `{rollback: true}`
 * restores the previous value on a failed write, and `onChange` listeners hear
 * only the keys that actually moved. Set `failWrites = true` to fail every
 * write; `writes` records each `set` as `{key, value, opts}` and each `merge`
 * as `{merge: partial, opts}`.
 *
 * @param {object} [over] values layered over the base
 * @param {{base?: object}} [options] the starting values (DEFAULT_SETTINGS)
 */
function fakeSettings(over, options) {
    const base = options && options.base ? options.base : DEFAULT_SETTINGS;
    const values = Object.assign({}, base, over || {});
    const listeners = [];
    const notify = (keys) => {
        if (!keys.length) return;
        for (const fn of listeners) fn(keys);
    };
    return {
        values,
        // `settings` and `fileSettings` are the real object's own fields.
        settings: values,
        fileSettings: values,
        writes: [],
        failWrites: false,
        get(key) { return values[key]; },
        raw(key) { return values[key]; },
        all() { return values; },
        onChange(fn) { if (typeof fn === 'function') listeners.push(fn); },
        set(key, value, opts) {
            this.writes.push({key, value, opts});
            const had = Object.prototype.hasOwnProperty.call(values, key);
            const before = values[key];
            values[key] = value;
            const ok = !this.failWrites;
            if (!ok && opts && opts.rollback) {
                if (had) values[key] = before;
                else delete values[key];
                return false;
            }
            if (before !== value) notify([key]);
            return ok;
        },
        merge(partial, opts) {
            const source = partial && typeof partial === 'object' ? partial : {};
            this.writes.push({merge: source, opts});
            const before = new Map(Object.keys(source).map(key =>
                [key, Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined]));
            Object.assign(values, source);
            const ok = !this.failWrites;
            if (!ok && opts && opts.rollback) {
                for (const [key, value] of before) {
                    if (value === undefined) delete values[key];
                    else values[key] = value;
                }
                return false;
            }
            notify([...before.keys()].filter(key => before.get(key) !== values[key]));
            return ok;
        }
    };
}

module.exports = {fakeSettings};
