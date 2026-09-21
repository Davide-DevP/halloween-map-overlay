'use strict';

/**
 * PURE decisions for the first-run welcome tour (`src/js/onboarding.js`).
 * See docs/agents/settings-and-onboarding.md.
 */

const {
    SYSTEM_HOTKEY_DEFS,
    ACTION_TO_SETTING_KEY,
    isUnbound,
    resolveSystemAccelerator
} = require('./hotkeys-constants');
const {sameAccelerator} = require('./hotkeys-rules');

// Hand-ordered, not derived; `src/index.html` carries one `[data-tour-step]`
// section per id. The hotkeys step lists five of the ten actions. Why both
// lists are what they are: the doc § The first-run welcome tour.
const ONBOARDING_STEPS = Object.freeze(['welcome', 'placement', 'markers', 'hotkeys', 'detect', 'done']);
const ONBOARDING_HOTKEY_ACTIONS = Object.freeze([
    'toggle-map', 'next-map', 'prev-map', 'rotate-map', 'toggle-markers'
]);

/**
 * Two **stored** flags, never `Settings.freshInstall`, and only a literal
 * `true` counts on either side, so a hand-edited "yes" can neither suppress
 * nor summon the tour. Why two flags: the doc § The first-run welcome tour.
 * @param {{onboardingPending: *, onboardingDone: *}} state
 */
function shouldShowOnboarding(state) {
    const s = state || {};
    return s.onboardingPending === true && s.onboardingDone !== true;
}

function stepIndex(id) {
    return ONBOARDING_STEPS.indexOf(id);
}

/**
 * An unknown id answers as the *first* step rather than throwing.
 * @returns {{id: string, index: number, number: number, total: number,
 *   first: boolean, last: boolean}} `index` 0-based, `number` as shown
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

/** `null` on the last step is how the caller knows Next means "finish". */
function nextStep(id) {
    const {index, last} = stepPosition(id);
    return last ? null : ONBOARDING_STEPS[index + 1];
}

function previousStep(id) {
    const {index, first} = stepPosition(id);
    return first ? null : ONBOARDING_STEPS[index - 1];
}

/**
 * Through the same `resolveSystemAccelerator` the Hotkeys table and the
 * registration use, or the tour teaches a combination that is not registered.
 * @param {Object<string, *>} systemHotkeys as `get-system-hotkeys` returns them
 * @returns {Array<{actionId: string, descriptionKey: string, accelerator: string,
 *   bound: boolean, labelKey: ?string, settingKey: string}>} `labelKey` is the
 *   table's `hotkeys.notBound` when there is no accelerator
 */
function onboardingHotkeyRows(systemHotkeys) {
    const stored = systemHotkeys && typeof systemHotkeys === 'object' ? systemHotkeys : {};
    const rows = [];
    for (const actionId of ONBOARDING_HOTKEY_ACTIONS) {
        const def = SYSTEM_HOTKEY_DEFS[actionId];
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
 * `sameAccelerator`, never string equality, so the tour and the banner agree.
 * @param {Array<{accelerator: *}>} conflicts from `get-hotkey-conflicts`
 */
function isConflicting(accelerator, conflicts) {
    if (isUnbound(accelerator) || !Array.isArray(conflicts)) return false;
    return conflicts.some(entry => entry && sameAccelerator(entry.accelerator, accelerator));
}

/** De-duplicated, in the order reported; the banner is behind the backdrop. */
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
 * The "press it now" half of the hotkeys step; the unbound and taken branches
 * keep it from inviting a press that can never be acknowledged.
 * @returns {{bound: boolean, conflicting: boolean, accelerator: string, promptKey: string}}
 */
function onboardingTryIt(systemHotkeys, conflicts) {
    const stored = systemHotkeys && typeof systemHotkeys === 'object' ? systemHotkeys : {};
    const def = SYSTEM_HOTKEY_DEFS['toggle-map'];
    const accelerator = def ? resolveSystemAccelerator(stored['toggle-map'], def.defaultAccelerator) : '';
    // A literal key per `return`, not ternaries: `test/i18n.test.js` finds a
    // key held as data by the `…Key: '<dotted>'` shape.
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
 * to say when it cannot. Why the two prerequisites, why the auto-detect reason
 * is Settings' own string, and why `checked` ignores `enabled`: the doc
 * § The first-run welcome tour.
 * @param {{autoDetect: *, markers: *, tabMarkers: *}} state `markers` follows
 *   the "only an explicit false is off" rule
 * @returns {{enabled: boolean, checked: boolean, reasonKey: ?string}}
 */
function tabMarkersSwitchState(state) {
    const s = state || {};
    const checked = s.tabMarkers === true;
    // A literal key per `return`: `test/i18n.test.js` finds a key held as data
    // by the `…Key: '<dotted>'` shape.
    if (s.autoDetect !== true) {
        return {enabled: false, checked, reasonKey: 'settings.tabMarkers.needsDetect'};
    }
    if (s.markers === false) {
        return {enabled: false, checked, reasonKey: 'onboarding.detect.tab.needsMarkers'};
    }
    return {enabled: true, checked, reasonKey: null};
}

// Keeping the panel modal: the tour is not a Bootstrap modal, so the next three
// rules are ours and all three are needed. Why:
// the doc § The first-run welcome tour. These are the regions
// that keep working — the panel, the status toast (drawn *above* it) and grain.
const INERT_EXEMPT_IDS = Object.freeze(['tour', 'logStatus']);
const INERT_EXEMPT_CLASSES = Object.freeze(['grain']);

/**
 * Everything but the exemptions, so the rule cannot forget the section somebody
 * adds next week.
 * @param {Array<{id?: *, className?: *}>} children descriptions of
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
 * The backstop `inert` and the Tab trap both miss: a click on a paragraph lands
 * focus on `<body>` and Esc is dead. `focusin`, never a second `document`
 * keydown listener, so it cannot collide with the recorder's.
 */
function shouldRecaptureFocus(state) {
    const s = state || {};
    return s.open === true && s.insidePanel !== true;
}

/**
 * Focus outside the panel is pulled to whichever end the direction implies, so
 * an escaped trap repairs itself.
 * @returns {?('first'|'last')} `null` = let the browser move focus itself
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
