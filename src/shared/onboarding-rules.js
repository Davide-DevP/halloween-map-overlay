'use strict';

/**
 * PURE decisions for the setup tutorial (`src/js/onboarding.js`).
 * See docs/agents/settings-and-onboarding.md.
 */

const {
    SYSTEM_HOTKEY_DEFS,
    ACTION_TO_SETTING_KEY,
    isUnbound,
    resolveSystemAccelerator
} = require('./hotkeys-constants');
const {sameAccelerator} = require('./hotkeys-rules');
const {normalisePlacement} = require('./map-placement');

/**
 * Bumped whenever the tutorial changes enough that everybody should see it
 * again; 2 is the 1.0 rewrite. A `tourSeenVersion` behind this shows it once
 * more. Why a version and not a flag: the doc § The first-run setup tutorial.
 */
const TOUR_VERSION = 2;

// Hand-ordered, not derived; `src/index.html` carries one `[data-tour-step]`
// section per id. Why these six and in this order: the doc § The setup tutorial.
const ONBOARDING_STEPS = Object.freeze(['welcome', 'where', 'setup', 'layers', 'hotkeys', 'done']);

/**
 * Exactly the actions that **ship with a key**, in reading order: the step
 * must not invite a press that does nothing. Which five: docs/agents/hotkeys.md.
 */
const ONBOARDING_HOTKEY_ACTIONS = Object.freeze([
    'toggle-map', 'toggle-markers', 'next-map', 'prev-map', 'clear-map'
]);

/** How many map keys the "each map has its own key too" line names. */
const ONBOARDING_MAP_HOTKEY_SAMPLE = 3;

/**
 * A hand-edited or missing `tourSeenVersion` reads as 0, i.e. "show it once":
 * a garbage value must not silently suppress the tutorial for ever.
 */
function seenVersion(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
    return Math.floor(value);
}

/**
 * Two reasons to open by itself — `onboardingPending` (the fresh-install
 * marker) and `tourSeenVersion` behind `TOUR_VERSION`. `onboardingDone` is
 * deliberately **not** one of them. Why: the doc § The first-run setup tutorial.
 */
function shouldShowOnboarding(state) {
    const s = state || {};
    if (s.onboardingPending === true) return true;
    return seenVersion(s.tourSeenVersion) < TOUR_VERSION;
}

function stepIndex(id) {
    return ONBOARDING_STEPS.indexOf(id);
}

/**
 * An unknown id answers as the *first* step rather than throwing.
 * @returns {Object} `index` 0-based, `number` as the indicator shows it
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
 * registration use, or the tutorial teaches a combination that is not
 * registered. Every row carries `actionId`: each has an inline *change* that
 * opens the **real** bind dialog. `labelKey` is `hotkeys.notBound` if unbound.
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

/** `sameAccelerator`, never string equality, so tutorial and banner agree. */
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
 * The map keys the hotkeys step names, out of `hotkeys.json` — never a
 * hard-coded "1, 2, 3", which is only what the *shipped* defaults happen to
 * be. With none bound the caller gets a parameter-less sentence, not a gap.
 * @returns {{keys: Array<string>, promptKey: string}} `keys` in file order
 */
function onboardingMapHotkeys(mapHotkeys) {
    const store = mapHotkeys && typeof mapHotkeys === 'object' ? mapHotkeys : {};
    const keys = [];
    for (const accelerator of Object.keys(store)) {
        if (isUnbound(accelerator)) continue;
        const entry = store[accelerator];
        // A row with no map is a broken file, not a key worth teaching.
        if (!entry || typeof entry !== 'object' || typeof entry.mapKey !== 'string'
            || !entry.mapKey.trim()) continue;
        if (keys.some(kept => sameAccelerator(kept, accelerator))) continue;
        keys.push(accelerator);
        if (keys.length === ONBOARDING_MAP_HOTKEY_SAMPLE) break;
    }
    // A literal key per `return`: `test/i18n.test.js` finds a key held as data
    // by the `…Key: '<dotted>'` shape.
    if (!keys.length) return {keys: [], promptKey: 'onboarding.hotkeys.maps.none'};
    return {keys, promptKey: 'onboarding.hotkeys.maps'};
}

/**
 * The last step's "you chose …" line. One literal key per branch, for the
 * same reason as above.
 */
function placementRecap(placement) {
    const p = normalisePlacement(placement);
    if (p === 'tab') return {placement: p, labelKey: 'onboarding.recap.tab'};
    if (p === 'both') return {placement: p, labelKey: 'onboarding.recap.both'};
    return {placement: p, labelKey: 'onboarding.recap.corner'};
}

// Keeping the panel modal: the tutorial is not a Bootstrap modal, so these
// rules are ours. What keeps working — the panel, the status toast drawn above
// it, grain, the **real** bind dialog with its toast, and the FAQ.
const INERT_EXEMPT_IDS = Object.freeze([
    'tour', 'logStatus', 'addHotkeyModal', 'hotkeyToast', 'faqModal'
]);
const INERT_EXEMPT_CLASSES = Object.freeze(['grain']);

/**
 * Everything but the exemptions, so the rule cannot forget the section
 * somebody adds next week.
 * @param {Array<{id?: *, className?: *}>} children descriptions of
 *   `document.body.children`, so this stays testable without a DOM
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
 * The backstop `inert` and the Tab trap both miss: a click on a paragraph
 * lands focus on `<body>` and Esc is dead. `focusin`, never a second
 * `document` keydown listener, so it cannot collide with the recorder's.
 * `dialogOpen` is the bind dialog: two traps fighting leave it unfocusable.
 */
function shouldRecaptureFocus(state) {
    const s = state || {};
    if (s.dialogOpen === true) return false;
    return s.open === true && s.insidePanel !== true;
}

/**
 * Focus outside the panel is pulled to whichever end the direction implies.
 * @returns {?('first'|'last')} `null` = let the browser move focus itself
 */
function tabWrapTarget(state) {
    const s = state || {};
    if (s.insidePanel !== true) return s.shiftKey === true ? 'last' : 'first';
    if (s.shiftKey === true) return s.atFirst === true ? 'last' : null;
    return s.atLast === true ? 'first' : null;
}

module.exports = {
    TOUR_VERSION,
    ONBOARDING_STEPS,
    ONBOARDING_HOTKEY_ACTIONS,
    ONBOARDING_MAP_HOTKEY_SAMPLE,
    INERT_EXEMPT_IDS,
    INERT_EXEMPT_CLASSES,
    seenVersion,
    shouldShowOnboarding,
    stepIndex,
    stepPosition,
    nextStep,
    previousStep,
    onboardingHotkeyRows,
    isConflicting,
    onboardingConflictList,
    onboardingTryIt,
    onboardingMapHotkeys,
    placementRecap,
    backgroundInertTargets,
    shouldRecaptureFocus,
    tabWrapTarget
};
