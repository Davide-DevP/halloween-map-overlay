const {ipcRenderer} = require("electron");
const {debugLog} = require("./logger");
const {listCreators, CUSTOM_CREATOR} = require("../core/map-catalog");
const {escapeHtml} = require("../shared/escape-html");
const {t, onChange} = require("./i18n");

/**
 * Home view: the map gallery and the readout of which map the overlay is
 * showing.
 *
 * **This class decides nothing.** Since 0.7 the map state — `currentKey`,
 * `lastKey`, every hotkey, the detector's route to the overlay, the menu clear,
 * the markers toggle — lives in the main process (`src/shared/map-state.js` and
 * `src/core/map-controller.js`). This is a *view*: it asks main for the state
 * when it loads (`get-map-state`), renders it, sends user intents
 * (`map-intent`) and re-renders on the `map-state` pushes that come back.
 *
 * That inversion is what makes the main window disposable — it is destroyed
 * while the app sits in the tray during a match, which is ~32 MB of private
 * working set (`docs/MEMORY-REPORT-2.md` §3.3). It also means a renderer crash
 * costs nothing: `currentKey` used to be *here*, so a reloaded renderer came
 * back believing nothing was on the overlay while main knew better.
 *
 * The catalogue itself still comes from the main process, which owns the file
 * system side of it; the gallery, the object URLs for the thumbnails and the
 * creator filter are all genuinely view state and stay here.
 */
class Maps {

    constructor(settings) {
        this.settings = settings;
        this.catalog = [];
        this.options = null;
        // Mirrors of main's map state, for rendering only. `get-map-state`
        // fills them before the first paint and `map-state` keeps them current;
        // nothing here is ever the source of truth.
        this.currentKey = "";
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
            this.renderCurrent();
        });
    }

    setOptions(options) {
        this.options = options;
    }

    init() {
        const self = this;

        $("#obsOpen").on("click", function () {
            ipcRenderer.send('obs-open');
            // The OBS window opens empty; main re-sends whatever is on the
            // overlay so the stream shows the same picture.
            self.send({type: 'refresh', source: 'click'});
        });
        $("#hide").on("click", function () {
            self.send({type: 'hide', source: 'click'});
        });
        $("#creatorSelect").on("change", function () {
            self.renderGallery();
        });

        // The one push. It arrives after every change main makes — a hotkey, a
        // detector switch, the menu clear, a slider — and it is the *only* way
        // this window learns what is on the overlay.
        ipcRenderer.on('map-state', (event, state) => self.applyState(state));

        // A map pack landed. The catalogue main holds has already been
        // invalidated, so this only has to re-fetch it and redraw — no restart,
        // and the map the overlay is showing is left exactly where it is.
        ipcRenderer.on('map-packs-updated', () => {
            debugLog("maps::map-packs-updated");
            self.invalidateCache().catch(err => debugLog("maps::map-packs-updated::failed", err && err.message));
        });

        // "A map was applied while your preview is up." The sample image lives
        // in this window's canvas, so only this window can put it back on top.
        ipcRenderer.on('refresh-preview', () => {
            if (self.options && self.options.previewActive) self.options.sendPreview();
        });
    }

    /**
     * Adopt a `map-state` push (or the `get-map-state` answer).
     *
     * `source` is present only when something actually landed on the overlay,
     * which is when "set position" mode has to end — leaving it on would keep
     * the overlay grabbing the player's clicks.
     */
    applyState(state) {
        if (!state) return;
        this.currentKey = typeof state.currentKey === 'string' ? state.currentKey : "";
        this.lastKey = typeof state.lastKey === 'string' ? state.lastKey : "";
        window.__activeMapKey = this.currentKey;
        if (state.source && this.options && this.options.setting) $("#unset-pos").click();
        this.highlightActive();
        this.renderCurrent();
        // A hotkey may have moved opacity, size or rotation; the Settings
        // controls have to follow, exactly as they did when the renderer wrote
        // those settings itself.
        if (state.source === 'hotkey' && this.options) {
            this.settings.refresh()
                .then(() => this.options.syncFromSettings())
                .catch(err => debugLog("maps::applyState::sync", err && err.message));
        }
    }

    /** A map name is never translated; only the "nothing showing" word is. */
    renderCurrent() {
        $("#currentMap").text(this.currentKey ? this.currentKey.split("/").pop() : t('home.none'));
    }

    /** Post an intent to the map controller in main. */
    send(intent) {
        ipcRenderer.send('map-intent', intent);
    }

    /**
     * Load-time sync. Called from `renderer.js` before the gallery is drawn.
     *
     * A fresh renderer has no preview up, so it says so first: this window is
     * the only thing that can produce the sample image, and if it died (or was
     * torn down) with the Overlay tab open, main would be left believing a
     * preview it can never refresh is still on screen. A no-op in the ordinary
     * case, and it re-asserts the real map in the one that is not.
     */
    async loadState() {
        this.send({type: 'preview-stop'});
        this.applyState(await ipcRenderer.invoke('get-map-state'));
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
            self.send({type: 'select', key: $(this).attr("data-key"), source: 'click'});
        });
        this.highlightActive();
    }

    highlightActive() {
        $("#results .map-card").each(function () {
            $(this).toggleClass("active", $(this).attr("data-key") === (window.__activeMapKey || ""));
        });
    }
}

module.exports = Maps;
