const {ipcRenderer} = require("electron");
const {debugLog} = require("./logger");
const {findClosestMapMatch, nextMap, prevMap, listCreators, CUSTOM_CREATOR} = require("../core/map-catalog");
const {escapeHtml} = require("../shared/escape-html");
const {showStatus} = require("./status");
const {t, onChange} = require("./i18n");
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
        this.init();
        // The gallery, the creator filter and the "showing" line are all built
        // with t(), so they have to be rebuilt when the language changes.
        onChange(() => {
            this.populateCreatorSelect();
            this.renderGallery();
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
            self.sendMap(self.currentKey);
        });
        $("#hide").on("click", function () {
            self.sendMap("");
        });
        $("#creatorSelect").on("change", function () {
            self.renderGallery();
        });

        // CLI second instance (`halloween-map-overlay.exe show-map=<key>`) and
        // the automatic map detector, which reuses the same channel.
        ipcRenderer.on('show-map-command', (event, key, opts = {}) => {
            const entry = findClosestMapMatch(key, self.catalog);
            if (!entry) {
                debugLog("maps::show-map-command::no-match", key);
                return;
            }
            debugLog("maps::show-map-command", entry.key, opts.fromDetector ? "(detector)" : "(cli)");
            // An automatic switch names the map on the overlay for a moment —
            // the player never asked for it, so it has to say what it did.
            self.sendMap(entry.key, opts.fromDetector ? {mapLabel: entry.name} : {});
        });

        ipcRenderer.on('hotkey-pressed', (event, mapKey) => {
            const entry = findClosestMapMatch(mapKey, self.catalog);
            if (!entry) {
                debugLog("maps::hotkey-pressed::no-match", mapKey);
                return;
            }
            self.sendMap(entry.key);
        });

        ipcRenderer.on('toggle-map', () => {
            if (self.currentKey === "") {
                self.sendMap(self.lastKey);
            } else {
                self.sendMap("");
            }
        });

        ipcRenderer.on('rotate-map', async () => {
            const current = parseInt(self.settings.raw("rotation"), 10) || 0;
            const next = (current + 90) % 360;
            await self.settings.set("rotation", next);
            if ($("#rotationSelect").length) $("#rotationSelect").val(String(next));
            // Re-apply whatever is on screen so the new angle takes effect
            self.sendMap(self.currentKey || self.lastKey);
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
            self.sendMap("");
        });

        // The detector saw the game's main menu again: the match this map
        // belonged to is over. `lastKey` is deliberately kept, so Ctrl+H still
        // brings the same map back if the player wants it.
        ipcRenderer.on('menu-hide-map', () => {
            if (self.currentKey === "") return;
            debugLog("maps::menu-hide-map", self.currentKey);
            self.sendMap("");
        });

        // Opacity/size from the keyboard. Same shape as rotate-map: write the
        // setting, keep an open settings slider in step, then re-send whatever
        // the overlay is showing so main recomputes the window bounds.
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
        this.sendMap(this.currentKey || this.lastKey);
        showStatus(t('toast.opacity', {percent: Math.round(next * 100)}));
    }

    /** Ctrl+Shift+Up / Ctrl+Shift+Down: overlay width in 25 px steps. */
    async nudgeSize(delta) {
        const next = stepSize(this.settings.raw("size"), delta);
        await this.settings.set("size", next);
        if ($("#sizeRange").length) $("#sizeRange").val(String(next));
        this.sendMap(this.currentKey || this.lastKey);
        showStatus(t('toast.size', {size: next}));
    }

    step(pick) {
        const entry = pick(this.currentKey || this.lastKey, this.catalog);
        if (!entry) return;
        this.sendMap(entry.key);
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
            // Catalogue string, not user input — its markup is ours.
            $results.append(`<p class="text-secondary">${t('home.noMaps')}</p>`);
            return;
        }

        for (const entry of entries) {
            const url = await this.thumbnail(entry.key);
            // Custom map names are user-typed; an unescaped quote truncates
            // data-key and an unescaped tag would run with Node access
            const $card = $(`
                <div class="col-12 col-md-6 col-xl-4">
                    <button type="button" class="map-card" data-key="${escapeHtml(entry.key)}">
                        <img src="${escapeHtml(url)}" alt="${escapeHtml(entry.name)}" loading="lazy"/>
                        <span class="map-card-name">${escapeHtml(entry.name)}</span>
                        <span class="map-card-creator">${escapeHtml(entry.creator)}</span>
                    </button>
                </div>
            `);
            $results.append($card);
        }

        const self = this;
        $("#results .map-card").on("click", function () {
            self.sendMap($(this).attr("data-key"));
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
     * @param {{mapLabel?: string}} [opts] `mapLabel` names the map on the
     *   overlay for a few seconds — used for automatic switches only.
     */
    sendMap(key, opts = {}) {
        // Leaving "set position" mode on would keep the overlay grabbing clicks
        if (this.options && this.options.setting) $("#unset-pos").click();

        const value = key || "";
        if (value) this.lastKey = value;
        this.currentKey = value;
        window.__activeMapKey = value;

        ipcRenderer.send('map-change', value, opts.mapLabel ? {mapLabel: opts.mapLabel} : {});

        // A map arriving mid-preview must not replace the sample image on screen
        if (this.options && this.options.previewActive) this.options.sendPreview();

        this.highlightActive();
        // A map name is never translated; only the "nothing showing" word is.
        $("#currentMap").text(value ? value.split("/").pop() : t('home.none'));
        return true;
    }
}

module.exports = Maps;
