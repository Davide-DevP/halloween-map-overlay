'use strict';

/**
 * PURE: "where do you want to see the map?", derived from the `tabMarkers` +
 * `tabHidesMinimap` pair and written back to it — no setting of its own.
 * Why: docs/agents/settings-and-onboarding.md § Where do you want to see the map?
 */

/** In card order. `tab` is the experimental one. */
const MAP_PLACEMENTS = Object.freeze(['corner', 'tab', 'both']);
const PLACEMENTS_NEEDING_DETECTION = Object.freeze(['tab', 'both']);

function isPlacement(value) {
    return MAP_PLACEMENTS.includes(value);
}

/** Anything else is `corner`: a hand-edited file must not add a fourth state. */
function normalisePlacement(placement) {
    return isPlacement(placement) ? placement : 'corner';
}

/** `tabMarkers` off is `corner` whatever `tabHidesMinimap` says. */
function placementFromSettings(settings) {
    const s = settings && typeof settings === 'object' ? settings : {};
    if (s.tabMarkers !== true) return 'corner';
    return s.tabHidesMinimap === true ? 'tab' : 'both';
}

/** Both keys, always, so switching back cannot leave the other behind. */
function settingsForPlacement(placement) {
    const p = normalisePlacement(placement);
    if (p === 'corner') return {tabMarkers: false, tabHidesMinimap: false};
    return {tabMarkers: true, tabHidesMinimap: p === 'tab'};
}

function placementNeedsDetection(placement) {
    return PLACEMENTS_NEEDING_DETECTION.includes(normalisePlacement(placement));
}

/**
 * Which blocks of the Map tab (and the tutorial's "set it up" step) a choice
 * owns. Every choice leaves at least one map on screen.
 */
function placementSections(placement) {
    const p = normalisePlacement(placement);
    return {
        corner: p !== 'tab',
        gameMap: p !== 'corner',
        troubleshooting: p !== 'corner'
    };
}

/**
 * The *Recognise the map automatically* switch, wherever it is drawn.
 * `blocked` is a stored game's-map placement with the loop **off**: nothing may
 * switch a screen capture on without a click (AGENTS.md rule 1), so it reports
 * the truth and invites one. A literal key per branch — `test/i18n.test.js`
 * finds a key held as data by the `…Key: '<dotted>'` shape.
 */
function autoDetectSwitchState(placement, running) {
    const on = running === true;
    if (!placementNeedsDetection(placement)) {
        return {checked: on, disabled: false, blocked: false, reasonKey: 'settings.autoDetect.help'};
    }
    if (on) {
        return {checked: true, disabled: true, blocked: false, reasonKey: 'settings.autoDetect.lockedHelp'};
    }
    return {checked: false, disabled: false, blocked: true, reasonKey: 'settings.autoDetect.blockedHelp'};
}

/** Never stops a detector switched on for its own sake. */
function shouldStartDetection(placement, running) {
    return placementNeedsDetection(placement) && running !== true;
}

/**
 * Ctrl+Alt+M is the only master `markers` control now, so the one state the
 * chips cannot explain says so. Only an explicit `false` is off.
 */
function markerMasterNotice(markers) {
    return {hidden: markers === false};
}

module.exports = {
    MAP_PLACEMENTS,
    PLACEMENTS_NEEDING_DETECTION,
    isPlacement,
    normalisePlacement,
    placementFromSettings,
    settingsForPlacement,
    placementNeedsDetection,
    placementSections,
    autoDetectSwitchState,
    shouldStartDetection,
    markerMasterNotice
};
