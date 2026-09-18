const {ipcRenderer} = require("electron");
const {debugLog} = require("./logger");
const {findClosestMapMatch, nextMap, prevMap, listCreators, CUSTOM_CREATOR} = require("../core/map-catalog");
const {escapeHtml} = require("../shared/escape-html");
const {showStatus} = require("./status");
const {t, onChange} = require("./i18n");
const {shouldApplyDetected} = require("../shared/detector-rules");
const {
    OPACITY_STEP,
    SIZE_STEP,
    stepOpacity,
    stepSize
} = require("../shared/hotkeys-constants");

/**
 * Home view: the map gallery and everything that decides which map the overlay
 * is currently showing. The catalogue itself comes from the main process, which
 * owns the file system side of it.
 */
class Maps {

    constructor(settings) {
        this.settings = settings;
        this.catalog = [];
        this.options = null;
        // Key of the map the overlay shows, "" while hidden (Ctrl+H)
        this.currentKey = "";
        // Last map picked, kept across hide/show so Ctrl+H can restore it
        this.lastKey = "";
        this.thumbnails = {};
        // The staggered fade-up plays once, on the first gallery render. A
        // filter change or a language change must not replay it.
        this.hasRendered = false;
        this.init();
        // The gallery, the creator filter and the "showing" line are all built
        // with t(), so they have to be rebuilt when the language changes.
        onChange(() => {
            this.populateCreatorSelect();
            this.renderGallery().catch(err => debugLog("maps::onChange::render", err && err.message));
            $("#currentMap").text(this.currentKey ? this.currentKey.split("/").pop() : t('home.none'));
        });
    }

    setOptions(options) {
        this.options = options;
    }

    init() {
        const self = this;

        $("#obsOpen").on("click", function () {
            ipcRenderer.send('obs-open');
            self.sendMap(self.currentKey, {source: 'click'});
        });
        $("#hide").on("click", function () {
            self.sendMap("", {source: 'click'});
        });
        $("#creatorSelect").on("change", function () {
            self.renderGallery();
        });

        // CLI second instance (`halloween-map-overlay.exe show-map=<key>`) and
        // the automatic map detector, which reuses the same channel.
        //
        // The detector now sends **every** accepted match (throttled per key in
        // main), because main cannot know what the overlay is showing: it only
        // knows what it last recognised, and after a manual pick those two are
        // different. So this is where the decision is made — `currentKey` is
        // owned here — and the answer goes back over `map-detector-applied` so
        // the detector log records what actually happened.
        ipcRenderer.on('show-map-command', (event, key, opts = {}) => {
            const entry = findClosestMapMatch(key, self.catalog);
            if (!entry) {
                debugLog("maps::show-map-command::no-match", key);
                if (opts.fromDetector) ipcRenderer.send('map-detector-applied', {key, applied: false, reason: 'no-match'});
                return;
            }
            if (opts.fromDetector && !shouldApplyDetected(self.currentKey, entry.key)) {
                // Already on screen: no re-send, and above all no label flash.
                debugLog("maps::show-map-command::same-as-current", entry.key);
                ipcRenderer.send('map-detector-applied', {key: entry.key, applied: false, reason: 'same-as-current'});
                return;
            }
            debugLog("maps::show-map-command", entry.key, opts.fromDetector ? "(detector)" : "(cli)");
            // An automatic switch names the map on the overlay for a moment —
            // the player never asked for it, so it has to say what it did. The
            // name comes from the catalogue entry, not from the key main sent:
            // the catalogue is the single source for a map's name.
            self.sendMap(entry.key, opts.fromDetector
                ? {mapLabel: entry.name, source: 'detector'}
                : {source: 'cli'});
            if (opts.fromDetector) ipcRenderer.send('map-detector-applied', {key: entry.key, applied: true});
        });

        ipcRenderer.on('hotkey-pressed', (event, mapKey) => {
            const entry = findClosestMapMatch(mapKey, self.catalog);
            if (!entry) {
                debugLog("maps::hotkey-pressed::no-match", mapKey);
                return;
            }
            self.sendMap(entry.key, {source: 'hotkey'});
        });

        ipcRenderer.on('toggle-map', () => {
            if (self.currentKey === "") {
                self.sendMap(self.lastKey, {source: 'hotkey'});
            } else {
                self.sendMap("", {source: 'hotkey'});
            }
        });

        ipcRenderer.on('rotate-map', async () => {
            const current = parseInt(self.settings.raw("rotation"), 10) || 0;
            const next = (current + 90) % 360;
            await self.settings.set("rotation", next);
            if ($("#rotationSelect").length) $("#rotationSelect").val(String(next));
            // Re-apply whatever is on screen so the new angle takes effect
            self.sendMap(self.currentKey || self.lastKey, {source: 'hotkey'});
        });

        ipcRenderer.on('next-map', () => self.step(nextMap));
        ipcRenderer.on('prev-map', () => self.step(prevMap));

        // Clear (Ctrl+Shift+D) is not toggle-map: it also tells the detector to
        // forget what it last saw, so the next Tab press re-detects even the
        // same map. Without that the loop would see no change and the overlay
        // would stay blank until the map actually changed.
        ipcRenderer.on('clear-map', () => {
            ipcRenderer.send('map-detector-reset');
            self.lastKey = "";
            self.sendMap("", {source: 'hotkey'});
        });

        // The detector saw the game's main menu again: the match this map
        // belonged to is over. `lastKey` is deliberately kept, so Ctrl+H still
        // brings the same map back if the player wants it.
        ipcRenderer.on('menu-hide-map', () => {
            if (self.currentKey === "") return;
            debugLog("maps::menu-hide-map", self.currentKey);
            self.sendMap("", {source: 'detector'});
        });

        // Opacity/size from the keyboard. Same shape as rotate-map: write the
        // setting, keep an open settings slider in step, then re-send whatever
        // the overlay is showing so main recomputes the window bounds.
        // Say what is on the overlay once at load, before anything is clicked.
        // A renderer that came back from a `render-process-gone` reload starts
        // with `currentKey = ""` while main still holds the key from before the
        // crash, and a stale `shownKey` would have the menu check clearing a
        // map this renderer no longer knows about (VERIFICATION-6, finding 4).
        // Main collapses repeats, so the ordinary start costs nothing.
        ipcRenderer.send('map-detector-shown', {key: self.currentKey || null});

        ipcRenderer.on('opacity-up', () => self.nudgeOpacity(OPACITY_STEP));
        ipcRenderer.on('opacity-down', () => self.nudgeOpacity(-OPACITY_STEP));
        ipcRenderer.on('size-up', () => self.nudgeSize(SIZE_STEP));
        ipcRenderer.on('size-down', () => self.nudgeSize(-SIZE_STEP));
    }

    /** Ctrl+Up / Ctrl+Down: opacity in tenths, clamped to 0.1..1.0. */
    async nudgeOpacity(delta) {
        const next = stepOpacity(this.settings.raw("opacity"), delta);
        await this.settings.set("opacity", next);
        // The slider only exists while the settings modal has been built; when
        // it is open it has to follow, or the next drag would snap back.
        if ($("#opacityRange").length) $("#opacityRange").val(String(next));
        // The slider's numeric readout is written by Options, not by the input
        // event (firing that would re-save the setting a second time).
        if (this.options) this.options.syncReadouts();
        this.sendMap(this.currentKey || this.lastKey, {source: 'hotkey'});
        showStatus(t('toast.opacity', {percent: Math.round(next * 100)}));
    }

    /** Ctrl+Shift+Up / Ctrl+Shift+Down: overlay width in 25 px steps. */
    async nudgeSize(delta) {
        const next = stepSize(this.settings.raw("size"), delta);
        await this.settings.set("size", next);
        if ($("#sizeRange").length) $("#sizeRange").val(String(next));
        if (this.options) this.options.syncReadouts();
        this.sendMap(this.currentKey || this.lastKey, {source: 'hotkey'});
        showStatus(t('toast.size', {size: next}));
    }

    step(pick) {
        const entry = pick(this.currentKey || this.lastKey, this.catalog);
        if (!entry) return;
        this.sendMap(entry.key, {source: 'hotkey'});
    }

    async loadCatalog() {
        this.catalog = await ipcRenderer.invoke('get-map-catalog') || [];
        debugLog("maps::loadCatalog", this.catalog.length);
        this.populateCreatorSelect();
    }

    async invalidateCache() {
        this.catalog = await ipcRenderer.invoke('invalidate-map-catalog') || [];
        this.thumbnails = {};
        this.populateCreatorSelect();
        await this.renderGallery();
    }

    populateCreatorSelect() {
        const select = $("#creatorSelect");
        if (!select.length) return;
        const previous = select.val();
        const creators = listCreators(this.catalog);
        // Built with .val()/.text() so a user-typed custom creator can never
        // break out of the markup
        select.empty().append($('<option>').val('').text(t('home.allCreators')));
        creators.forEach(c => select.append($('<option>').val(c).text(c)));
        if (previous && creators.includes(previous)) select.val(previous);

        // One shipped creator and no imports: the filter has nothing to do
        const shipped = creators.filter(c => c !== CUSTOM_CREATOR);
        select.closest('.creator-filter').toggleClass('d-none', shipped.length <= 1 && creators.length <= 1);
    }

    /** Object URL for a map's image, fetched from the main process once. */
    async thumbnail(key) {
        if (this.thumbnails[key]) return this.thumbnails[key];
        const data = await ipcRenderer.invoke('read-map-image', key);
        if (!data || data.length === 0) return "";
        const url = URL.createObjectURL(new Blob([data]));
        this.thumbnails[key] = url;
        return url;
    }

    async renderGallery() {
        const creator = $("#creatorSelect").val() || "";
        const entries = this.catalog.filter(e => !creator || e.creator === creator);
        const $results = $("#results").empty();

        if (!entries.length) {
            // A composed empty state rather than a bare line of text. Both
            // strings are catalogue strings, not user input — `home.noMaps`
            // carries a <code> element, so its markup is ours on purpose.
            $results.append(`
                <div class="map-empty">
                    <div class="map-empty-mark" aria-hidden="true"></div>
                    <p class="map-empty-title">${escapeHtml(t('home.empty.title'))}</p>
                    <p class="map-empty-body">${t('home.noMaps')}</p>
                </div>
            `);
            return;
        }

        const stagger = !this.hasRendered;
        let index = 0;
        for (const entry of entries) {
            const url = await this.thumbnail(entry.key);
            // Custom map names are user-typed; an unescaped quote truncates
            // data-key and an unescaped tag would run with Node access
            const $card = $(`
                <div class="map-cell${stagger ? ' is-entering' : ''}" style="--hmo-i: ${index}">
                    <button type="button" class="map-card" data-key="${escapeHtml(entry.key)}">
                        <span class="map-card-thumb">
                            <img src="${escapeHtml(url)}" alt="${escapeHtml(entry.name)}" loading="lazy"/>
                        </span>
                        <span class="map-card-body">
                            <span>
                                <span class="map-card-name">${escapeHtml(entry.name)}</span>
                                <span class="map-card-creator">${escapeHtml(entry.creator)}</span>
                            </span>
                            <span class="map-card-flag">${escapeHtml(t('home.onOverlay'))}</span>
                        </span>
                    </button>
                </div>
            `);
            // The skeleton shimmer clears when the thumbnail reports in. A
            // cached object URL can be decoded before this runs, hence the
            // `complete` check as well as the listener.
            const $thumb = $card.find(".map-card-thumb");
            const img = $card.find("img")[0];
            const done = () => $thumb.addClass("is-loaded");
            $(img).on("load", done).on("error", done);
            if (img.complete && img.naturalWidth > 0) done();
            $results.append($card);
            index += 1;
        }
        this.hasRendered = true;

        const self = this;
        $("#results .map-card").on("click", function () {
            self.sendMap($(this).attr("data-key"), {source: 'click'});
        });
        this.highlightActive();
    }

    highlightActive() {
        $("#results .map-card").each(function () {
            $(this).toggleClass("active", $(this).attr("data-key") === (window.__activeMapKey || ""));
        });
    }

    /**
     * Put a map on the overlay. `""` hides it.
     * @param {string} key catalogue key
     * @param {{mapLabel?: string, source?: string}} [opts] `mapLabel` names the
     *   map on the overlay for a few seconds — used for automatic switches
     *   only. `source` is for `app.log` alone (click/hotkey/cli/detector/
     *   preview/hide): "the map changed and I did not do it" is a real support
     *   question, and only this side knows which of the six it was.
     */
    sendMap(key, opts = {}) {
        // Leaving "set position" mode on would keep the overlay grabbing clicks
        if (this.options && this.options.setting) $("#unset-pos").click();

        const value = key || "";
        if (value) this.lastKey = value;
        this.currentKey = value;
        window.__activeMapKey = value;

        const payload = {source: opts.source || 'click'};
        if (opts.mapLabel) payload.mapLabel = opts.mapLabel;
        ipcRenderer.send('map-change', value, payload);

        // Tell the detector what is on the overlay — on every send, hides
        // included. This renderer owns `currentKey`, and the detector's
        // "back in the menu, clear the map" check needs to know a map is up
        // whoever put it there: gating that on the *detector's* own last
        // detection meant a match whose map was picked by hand was never
        // cleared in the menu (0.3.2 field log, fixed in 0.3.3). Main
        // collapses repeats, so re-sends from a slider drag cost nothing.
        ipcRenderer.send('map-detector-shown', {key: value || null});

        // A map arriving mid-preview must not replace the sample image on screen
        if (this.options && this.options.previewActive) this.options.sendPreview();

        this.highlightActive();
        // A map name is never translated; only the "nothing showing" word is.
        $("#currentMap").text(value ? value.split("/").pop() : t('home.none'));
        return true;
    }
}

module.exports = Maps;
