'use strict';

const appLog = require('./app-log');
const {errorMessage} = require('../shared/errors');
const {PAD_SCAN_INTERVAL, PAD_SLOTS} = require('../shared/tab-mode-rules');
const {padButtonDown} = require('../shared/pad-codes');

/** XInput 1.4 ships with Windows 8+; the older names cover anything else. */
const XINPUT_DLLS = ['xinput1_4.dll', 'xinput9_1_0.dll', 'xinput1_3.dll'];

/** `ERROR_DEVICE_NOT_CONNECTED`: the normal answer for an empty slot. */
const NOT_CONNECTED = 1167;

/**
 * ELECTRON tier: koffi → `XInputGetState`, the controller half of the map
 * key's trigger. **One slot is read per tick** once a pad is found; with none
 * found, the four slots are scanned at `PAD_SCAN_INTERVAL`, not every tick.
 * The reading is the pad's whole state — XInput has no per-button call — and
 * `padButtonDown` looks at the one configured bit; nothing else is kept,
 * logged or returned. Loaded lazily, every step wrapped, and a failure here
 * never costs the keyboard half. Why: docs/agents/markers-and-tab-mode.md
 * § The controller button.
 */
class PadInput {

    /** @param {{load?, now?}} [opts] `load` returns koffi (injected in tests). */
    constructor(opts) {
        const o = opts || {};
        this.loader = typeof o.load === 'function' ? o.load : () => require('koffi');
        this.now = typeof o.now === 'function' ? o.now : () => Date.now();
        this.fn = null;
        /** **Tri-state**, like the key trigger's: null = untried. */
        this.usable = null;
        this.reason = null;
        this.dll = null;
        /** The slot a pad was last seen in, or null while scanning. */
        this.slot = null;
        this.lastScanAt = null;
        this.counters = {reads: 0, scans: 0, errors: 0};
        this.loggedAvailable = false;
    }

    /** Load koffi and bind XInput. Idempotent, and it never throws. */
    open() {
        if (this.fn) return {ok: true, reason: null};
        if (this.usable === false) return {ok: false, reason: this.reason};
        let koffi;
        try {
            koffi = this.loader();
        } catch (err) {
            return this.fail('load', err);
        }
        if (!koffi || typeof koffi.load !== 'function' || typeof koffi.struct !== 'function') {
            return this.fail('load', new Error('no koffi.load'));
        }
        let lib = null;
        let lastErr = null;
        for (const dll of XINPUT_DLLS) {
            try {
                lib = koffi.load(dll);
                this.dll = dll;
                break;
            } catch (err) {
                lastErr = err;
            }
        }
        if (!lib) return this.fail('bind', lastErr || new Error('no xinput'));
        try {
            // Anonymous structs: a named one is process-global in koffi and a
            // second `open()` after a failure would try to redefine it.
            const gamepad = koffi.struct({
                wButtons: 'uint16_t', bLeftTrigger: 'uint8_t', bRightTrigger: 'uint8_t',
                sThumbLX: 'int16_t', sThumbLY: 'int16_t', sThumbRX: 'int16_t', sThumbRY: 'int16_t'
            });
            const state = koffi.struct({dwPacketNumber: 'uint32_t', Gamepad: gamepad});
            this.fn = {
                // DWORD XInputGetState(DWORD dwUserIndex, XINPUT_STATE *pState)
                getState: lib.func('__stdcall', 'XInputGetState', 'uint32_t',
                    ['uint32_t', koffi.out(koffi.pointer(state))])
            };
        } catch (err) {
            return this.fail('bind', err);
        }
        this.usable = true;
        this.reason = null;
        if (!this.loggedAvailable) {
            this.loggedAvailable = true;
            appLog.event('tab-pad-input', {available: 'yes', dll: this.dll});
        }
        return {ok: true, reason: null};
    }

    probe() {
        return this.open();
    }

    fail(where, err) {
        this.fn = null;
        this.usable = false;
        this.reason = where;
        appLog.warn('tab-pad-input', {available: 'no', where, message: errorMessage(err)});
        console.error(`Tab markers: the controller input is unavailable (${where}):`, err && err.message);
        return {ok: false, reason: where};
    }

    isAvailable() {
        if (this.usable === null) this.open();
        return this.usable === true;
    }

    /**
     * One slot's reading. @returns {?{connected: boolean, gamepad: object}}
     *   null when the call threw.
     */
    readSlot(slot) {
        if (!this.fn) return null;
        try {
            const out = [{}];
            const rc = this.fn.getState(slot, out);
            this.counters.reads++;
            if (rc === NOT_CONNECTED) return {connected: false, gamepad: null};
            if (rc !== 0) return {connected: false, gamepad: null};
            return {connected: true, gamepad: out[0].Gamepad || {}};
        } catch (err) {
            this.counters.errors++;
            return null;
        }
    }

    /**
     * Is the configured button down on the pad? The known slot is read every
     * time; without one, the slots are scanned at most every
     * `PAD_SCAN_INTERVAL` and the first connected pad is kept.
     * @returns {?boolean} false with no pad; **null** when a call threw.
     */
    isDown(code) {
        if (!this.fn) return null;
        if (this.slot !== null) {
            const reading = this.readSlot(this.slot);
            if (reading === null) return null;
            if (reading.connected) return padButtonDown(reading.gamepad, code);
            // Unplugged: back to scanning, and this tick reads as "up".
            this.slot = null;
            this.lastScanAt = this.now();
            return false;
        }
        const now = this.now();
        if (this.lastScanAt !== null && now - this.lastScanAt < PAD_SCAN_INTERVAL) return false;
        this.lastScanAt = now;
        this.counters.scans++;
        for (let slot = 0; slot < PAD_SLOTS; slot++) {
            const reading = this.readSlot(slot);
            if (reading === null) return null;
            if (!reading.connected) continue;
            this.slot = slot;
            return padButtonDown(reading.gamepad, code);
        }
        return false;
    }

    /**
     * For the recorder: every connected pad's reading, scanning all slots
     * (the button may be pressed on any of them). @returns {?object[]} null on a throw.
     */
    readAll() {
        if (!this.fn) return null;
        const readings = [];
        for (let slot = 0; slot < PAD_SLOTS; slot++) {
            const reading = this.readSlot(slot);
            if (reading === null) return null;
            if (reading.connected) readings.push(reading.gamepad);
        }
        return readings;
    }

    /** Forget the slot: the next reading scans again. */
    reset() {
        this.slot = null;
        this.lastScanAt = null;
    }

    /** What `system.txt` prints: availability, a slot number and counters. */
    status() {
        return {
            available: this.usable,
            reason: this.reason,
            slot: this.slot,
            reads: this.counters.reads,
            scans: this.counters.scans,
            errors: this.counters.errors
        };
    }

    destroy() {
        this.fn = null;
        this.reset();
    }
}

module.exports = PadInput;
