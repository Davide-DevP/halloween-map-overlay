'use strict';

/**
 * PURE decisions for the first-run welcome tour.
 *
 * The tour itself is a panel inside the main window (`#tour` in
 * `src/index.html`, driven by `src/js/onboarding.js`); everything here is the
 * part that can be wrong in a way a user would notice, so it is pure and
 * tested: *should it open at all*, *which step comes next*, *what does a step
 * say about a hotkey that is not bound or that another application already
 * owns*, and the two focus rules that keep the panel modal.
 *
 * Imports nothing but `hotkeys-constants` and `hotkeys-rules`, both pure.
 */

const {
    SYSTEM_HOTKEY_DEFS,
    ACTION_TO_SETTING_KEY,
    isUnbound,
    resolveSystemAccelerator
} = require('./hotkeys-constants');
const {sameAccelerator} = require('./hotkeys-rules');

/**
 * The six steps, in order.
 *
 * Frozen and ordered by hand rather than derived: the sequence *is* the design,
 * and `src/index.html` carries one `[data-tour-step]` section per id.
 *
 * - language before anything that is rendered in it;
 * - placement before the markers drawn on the thing placed;
 * - **markers** before the hotkeys, so the *Show / hide markers* row lands on
 *   something the user was told about one step earlier. It is a step of its own
 *   rather than a paragraph on the placement step because the one thing it has
 *   to get across — a marker is a *possible* location, not a promise — is the
 *   single most misreadable piece of information this app shows, and folding it
 *   into a step about corners is how it would be missed;
 * - the opt-in capture switch last but one, with Tab-map mode inside it because
 *   it cannot work without it.
 */
const ONBOARDING_STEPS = Object.freeze(['welcome', 'placement', 'markers', 'hotkeys', 'detect', 'done']);

/**
 * The actions the hotkeys step lists, in reading order.
 *
 * A subset on purpose: five of the ten system hotkeys (clear, and the four
 * opacity/size steps) are refinements nobody needs in the first minute, and the
 * full table is one click away under Settings › Hotkeys. `toggle-map` is first
 * because it is the one the step invites the user to press.
 *
 * `toggle-markers` earns its place for the same reason `toggle-map` does: the
 * markers are a thing the player will want off *during* a match — they are
 * drawn over the map they are reading — and the alternative is alt-tabbing to
 * Settings mid-game. It is listed last because it is the newest idea of the
 * five and the step above it has just explained what a marker is.
 */
const ONBOARDING_HOTKEY_ACTIONS = Object.freeze([
    'toggle-map', 'next-map', 'prev-map', 'rotate-map', 'toggle-markers'
]);

/**
 * Does the tour open by itself on this start?
 *
 * Two **stored** flags, and the pair is the whole model:
 *
 * - `onboardingPending` is written once, by `core/settings.js`, on the start
 *   that creates `settings-app.json`. It means "this user is owed the tour".
 *   An existing install has it back-filled from `DEFAULT_SETTINGS` as `false`,
 *   so an upgrade is never interrupted.
 * - `onboardingDone` is written when the tour is finished or skipped, and is
 *   what keeps it from opening twice.
 *
 * It is deliberately **not** `Settings.freshInstall` ("the file did not exist
 * when this process started") any more. That reads as first-run only for the
 * length of one session: a user who quits, crashes, or takes an update restart
 * before reaching Skip or Finish had a settings file on the next start and was
 * never greeted at all. A marker on disk survives all three.
 *
 * Anything other than a literal `true` counts as not set, on both sides, so a
 * hand-edited settings file cannot suppress the tour with `"yes"` — nor summon
 * it on an install that was never owed one.
 *
 * @param {{onboardingPending: *, onboardingDone: *}} state
 * @returns {boolean}
 */
function shouldShowOnboarding(state) {
    const s = state || {};
    return s.onboardingPending === true && s.onboardingDone !== true;
}

/** Position of a step id in the sequence, or -1. */
function stepIndex(id) {
    return ONBOARDING_STEPS.indexOf(id);
}

/**
 * Where the user is, for the "Step 2 of 5" line and the Back/Next buttons.
 *
 * An unknown id answers as the first step rather than throwing: the caller
 * would otherwise have to guard every render, and "start at the beginning" is
 * the only sane recovery from a state nobody can reach on purpose.
 *
 * @param {string} id
 * @returns {{id: string, index: number, number: number, total: number, first: boolean, last: boolean}}
 *   `index` is 0-based, `number` is what the user is shown.
 */
function stepPosition(id) {
    const found = stepIndex(id);
    const index = found === -1 ? 0 : found;
    return {
        id: ONBOARDING_STEPS[index],
        index,
        number: index + 1,
        total: ONBOARDING_STEPS.length,
        first: index === 0,
        last: index === ONBOARDING_STEPS.length - 1
    };
}

/**
 * The step after this one, or `null` on the last step — which is how the caller
 * knows Next means "finish" rather than "advance".
 * @param {string} id
 * @returns {?string}
 */
function nextStep(id) {
    const {index, last} = stepPosition(id);
    return last ? null : ONBOARDING_STEPS[index + 1];
}

/**
 * The step before this one, or `null` on the first.
 * @param {string} id
 * @returns {?string}
 */
function previousStep(id) {
    const {index, first} = stepPosition(id);
    return first ? null : ONBOARDING_STEPS[index - 1];
}

/**
 * What the hotkeys step prints, one row per action.
 *
 * The accelerators are **read from the live bindings**, never from a hard-coded
 * list: the defaults moved once already (0.7), every one of them is rebindable,
 * and any of them can be switched off entirely. So this goes through the same
 * `resolveSystemAccelerator` the Hotkeys table and the registration itself use —
 * `''` (deliberately unbound) must not turn back into the shipped default here,
 * or the tour would teach a key combination that is not registered.
 *
 * An unbound action carries `labelKey` instead of an accelerator, and it is the
 * same `hotkeys.notBound` string the Hotkeys table shows, so the two cannot
 * drift into wording it differently.
 *
 * @param {Object<string, *>} systemHotkeys stored accelerators by action id, as
 *   `get-system-hotkeys` returns them (a missing action = never stored)
 * @returns {Array<{actionId: string, descriptionKey: string, accelerator: string,
 *   bound: boolean, labelKey: ?string, settingKey: string}>}
 */
function onboardingHotkeyRows(systemHotkeys) {
    const stored = systemHotkeys && typeof systemHotkeys === 'object' ? systemHotkeys : {};
    const rows = [];
    for (const actionId of ONBOARDING_HOTKEY_ACTIONS) {
        const def = SYSTEM_HOTKEY_DEFS[actionId];
        // Defensive: an action id removed from the definitions would otherwise
        // render a row with no name and no binding.
        if (!def) continue;
        const accelerator = resolveSystemAccelerator(stored[actionId], def.defaultAccelerator);
        const bound = !isUnbound(accelerator);
        rows.push({
            actionId,
            descriptionKey: def.descriptionKey,
            accelerator: bound ? accelerator : '',
            bound,
            labelKey: bound ? null : 'hotkeys.notBound',
            settingKey: ACTION_TO_SETTING_KEY[actionId]
        });
    }
    return rows;
}

/**
 * Is this accelerator one of the ones the last hotkey load could not register?
 *
 * The conflict list is `[{accelerator, action, reason}]` from `Hotkeys`, the
 * same data the home-page conflict banner is built from. Compared with
 * `sameAccelerator`, never as strings: `Ctrl+Alt+H` and `CommandOrControl+Alt+H`
 * are one combination, and the banner and the tour must not disagree about
 * which of them is in trouble.
 *
 * @param {string} accelerator
 * @param {Array<{accelerator: *}>} conflicts
 * @returns {boolean}
 */
function isConflicting(accelerator, conflicts) {
    if (isUnbound(accelerator) || !Array.isArray(conflicts)) return false;
    return conflicts.some(entry => entry && sameAccelerator(entry.accelerator, accelerator));
}

/**
 * The accelerators to name on the hotkeys step when something else on the PC
 * already owns them, de-duplicated and in the order they were reported.
 *
 * The step needs this because the home-page banner that normally says it is
 * *behind the tour's backdrop*: without this, the first thing a new user is
 * told to try would silently do nothing, and the explanation would be hidden
 * under the panel giving the instruction.
 *
 * @param {Array<{accelerator: *}>} conflicts
 * @returns {Array<string>}
 */
function onboardingConflictList(conflicts) {
    if (!Array.isArray(conflicts)) return [];
    const seen = [];
    for (const entry of conflicts) {
        const accelerator = entry && entry.accelerator;
        if (isUnbound(accelerator)) continue;
        if (seen.some(kept => sameAccelerator(kept, accelerator))) continue;
        seen.push(accelerator);
    }
    return seen;
}

/**
 * The "press it now" half of the hotkeys step.
 *
 * `toggle-map` is the invitation because the app's own windows count as the
 * foreground for `hotkeysGameOnly`, so pressing it while the tour is on screen
 * really does fire. Three outcomes, and the two unhappy ones exist because the
 * step otherwise invites a press that can never be acknowledged:
 *
 * - **unbound** — nothing to press; say so instead of drawing an empty key cap.
 * - **taken** — the combination is registered to something else on this PC, so
 *   the key never reaches us. Without this branch the user presses it, nothing
 *   happens, and the banner that would explain why is behind the backdrop.
 * - otherwise the ordinary invitation.
 *
 * @param {Object<string, *>} systemHotkeys
 * @param {Array<{accelerator: *}>} [conflicts] from `get-hotkey-conflicts`
 * @returns {{bound: boolean, conflicting: boolean, accelerator: string, promptKey: string}}
 */
function onboardingTryIt(systemHotkeys, conflicts) {
    const stored = systemHotkeys && typeof systemHotkeys === 'object' ? systemHotkeys : {};
    const def = SYSTEM_HOTKEY_DEFS['toggle-map'];
    const accelerator = def ? resolveSystemAccelerator(stored['toggle-map'], def.defaultAccelerator) : '';
    // One `return` per outcome rather than ternaries: `test/i18n.test.js` finds
    // a key held as data by the `…Key: '<dotted>'` shape, so each string has to
    // sit directly after the property name.
    if (isUnbound(accelerator)) {
        return {bound: false, conflicting: false, accelerator: '', promptKey: 'onboarding.hotkeys.tryIt.unbound'};
    }
    if (isConflicting(accelerator, conflicts)) {
        return {bound: true, conflicting: true, accelerator, promptKey: 'onboarding.hotkeys.tryIt.taken'};
    }
    return {bound: true, conflicting: false, accelerator, promptKey: 'onboarding.hotkeys.tryIt'};
}

/**
 * Whether the tour's *Markers on the in-game map* switch can be used, and what
 * to say when it cannot.
 *
 * Both prerequisites are real, not presentational. The mode places its brackets
 * on the map **the detector recognised**, so with auto-detect off there is
 * nothing to place them by; and with the markers master switch off there are no
 * brackets to place anywhere. `core/tab-mode.js` takes the mode down for either
 * (SPEC-MARKERS §5.6), so a switch the tour let you turn on would do nothing
 * visible — which `src/js/options.js` already calls the worst of the three
 * options for the auto-detect half. The tour therefore disables it and says
 * why, and both fixes are one switch away: auto-detect is on the same step and
 * the markers master switch is on the step before.
 *
 * The reason for the auto-detect case is Settings' **own** string, so the two
 * cannot drift into explaining the same state two different ways.
 *
 * `checked` always reports the stored setting, disabled or not: the tour never
 * shows a switch in a position the settings file does not hold.
 *
 * @param {{autoDetect: *, markers: *, tabMarkers: *}} state `markers` follows
 *   the app-wide "only an explicit false is off" rule, so a settings file
 *   written before markers existed reads as on.
 * @returns {{enabled: boolean, checked: boolean, reasonKey: ?string}}
 */
function tabMarkersSwitchState(state) {
    const s = state || {};
    const checked = s.tabMarkers === true;
    // One `return` per outcome, each with its key as a literal: `test/i18n.test.js`
    // finds a key held as data by the `…Key: '<dotted>'` shape.
    if (s.autoDetect !== true) {
        return {enabled: false, checked, reasonKey: 'settings.tabMarkers.needsDetect'};
    }
    if (s.markers === false) {
        return {enabled: false, checked, reasonKey: 'onboarding.detect.tab.needsMarkers'};
    }
    return {enabled: true, checked, reasonKey: null};
}

/*
 * ─── Keeping the panel modal ────────────────────────────────────────────────
 *
 * The tour is not a Bootstrap modal, so nothing else provides these. All three
 * rules are here rather than inline in the renderer because each one is a
 * one-line condition that is wrong in a way no test would otherwise catch —
 * and the symptom (focus quietly outside the panel, Esc dead, Enter reaching a
 * map card hidden behind the backdrop) looks like nothing at all until it is
 * reproduced by hand.
 */

/**
 * Top-level regions that keep working while the tour is open.
 *
 * `tour` is the panel itself; `logStatus` is the status toast, which is drawn
 * *above* the tour on purpose (the throttled "could not be saved" warning has
 * to stay readable) and must therefore stay out of the a11y tree's inert half.
 */
const INERT_EXEMPT_IDS = Object.freeze(['tour', 'logStatus']);
/** The film-grain layer: decorative, `aria-hidden`, and never focusable. */
const INERT_EXEMPT_CLASSES = Object.freeze(['grain']);

/**
 * Which of `<body>`'s children get `inert` while the tour is open.
 *
 * Everything but the exemptions, rather than a list of the regions to disable:
 * the markup of this window grows, and a blanket rule cannot forget the section
 * somebody adds next week. Without it the page behind the backdrop is still
 * tabbable — which is how Enter on an invisible map card ends up changing the
 * overlay while the tour is on screen.
 *
 * @param {Array<{id?: *, className?: *}>} children plain descriptions of
 *   `document.body.children`, so this stays testable without a DOM
 * @returns {Array<number>} indexes into `children`
 */
function backgroundInertTargets(children) {
    if (!Array.isArray(children)) return [];
    const targets = [];
    children.forEach((child, index) => {
        const id = child && typeof child.id === 'string' ? child.id : '';
        const className = child && typeof child.className === 'string' ? child.className : '';
        if (INERT_EXEMPT_IDS.includes(id)) return;
        if (className.split(/\s+/).some(name => INERT_EXEMPT_CLASSES.includes(name))) return;
        targets.push(index);
    });
    return targets;
}

/**
 * Should a `focusin` outside the panel be pulled back in?
 *
 * The backstop for the case `inert` and the Tab trap both miss: a **click** on
 * a paragraph, a table or an alert inside the panel moves focus to the nearest
 * focusable ancestor, and if there is none it lands on `<body>` — after which
 * the panel's own keydown listener never fires again and Esc is dead. It is
 * watched with `focusin` rather than with a second `document` keydown listener
 * precisely so it cannot collide with the hotkey recorder's.
 *
 * @param {{open: *, insidePanel: *}} state
 * @returns {boolean}
 */
function shouldRecaptureFocus(state) {
    const s = state || {};
    return s.open === true && s.insidePanel !== true;
}

/**
 * Where Tab should go, or `null` to let the browser move focus itself.
 *
 * Focus that is already outside the panel (the click case above, before the
 * `focusin` guard has run) is pulled to whichever end the direction implies,
 * so a trap that was escaped repairs itself on the next keypress instead of
 * walking the page behind.
 *
 * @param {{insidePanel: *, shiftKey: *, atFirst: *, atLast: *}} state
 * @returns {?('first'|'last')}
 */
function tabWrapTarget(state) {
    const s = state || {};
    if (s.insidePanel !== true) return s.shiftKey === true ? 'last' : 'first';
    if (s.shiftKey === true) return s.atFirst === true ? 'last' : null;
    return s.atLast === true ? 'first' : null;
}

module.exports = {
    ONBOARDING_STEPS,
    ONBOARDING_HOTKEY_ACTIONS,
    INERT_EXEMPT_IDS,
    INERT_EXEMPT_CLASSES,
    shouldShowOnboarding,
    stepIndex,
    stepPosition,
    nextStep,
    previousStep,
    onboardingHotkeyRows,
    isConflicting,
    onboardingConflictList,
    onboardingTryIt,
    tabMarkersSwitchState,
    backgroundInertTargets,
    shouldRecaptureFocus,
    tabWrapTarget
};
