const {ipcRenderer} = require("electron");
const {debugLog} = require("./logger");
const {listCreators, CUSTOM_CREATOR} = require("../core/map-catalog");
const {escapeHtml} = require("../shared/escape-html");
const {t, onChange} = require("./i18n");

/**
 * Home view: the map gallery and the readout of which map the overlay shows.
 *
 * **This class decides nothing.** The map state lives in main
 * (`shared/map-state.js`, `core/map-controller.js`); this asks on load
 * (`get-map-state`), sends intents (`map-intent`) and re-renders on the
 * `map-state` pushes. That inversion is what makes the window disposable.
 */
class Maps {

    constructor(settings) {
        this.settings = settings;
        this.catalog = [];
        this.options = null;
        /** Mirrors of main's state, for rendering only — never a source of truth. */
        this.currentKey = "";
        this.lastKey = "";
        this.thumbnails = {};
        /** The staggered fade-up plays once; a re-render must not replay it. */
        this.hasRendered = false;
        this.init();
        // All three are built with t(), so they follow a language change.
        onChange(() => {
            this.populateCreatorSelect();
            this.retranslateGallery();
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
            // The OBS window opens empty; the refresh makes main re-send.
            self.send({type: 'refresh', source: 'click'});
        });
        $("#hide").on("click", function () {
            self.send({type: 'hide', source: 'click'});
        });
        $("#creatorSelect").on("change", function () {
            self.renderGallery();
        });

        // The *only* way this window learns what is on the overlay.
        ipcRenderer.on('map-state', (event, state) => self.applyState(state));

        // Main's catalogue is already invalidated, so this only re-fetches and
        // redraws — the map on the overlay stays put.
        ipcRenderer.on('map-packs-updated', () => {
            debugLog("maps::map-packs-updated");
            self.invalidateCache().catch(err => debugLog("maps::map-packs-updated::failed", err && err.message));
        });

        // A map landed while the preview is up, and the sample image lives in
        // this window's canvas.
        ipcRenderer.on('refresh-preview', () => {
            if (self.options && self.options.previewActive) self.options.sendPreview();
        });
    }

    /**
     * `source` is present only when something actually landed on the overlay,
     * which is when "set position" has to end: left on, it keeps the overlay
     * grabbing the player's clicks.
     */
    applyState(state) {
        if (!state) return;
        this.currentKey = typeof state.currentKey === 'string' ? state.currentKey : "";
        this.lastKey = typeof state.lastKey === 'string' ? state.lastKey : "";
        if (state.source && this.options && this.options.setting) $("#unset-pos").click();
        this.highlightActive();
        this.renderCurrent();
        // A hotkey may have moved opacity, size or rotation.
        if (state.source === 'hotkey' && this.options) {
            this.settings.refresh()
                .then(() => this.options.syncFromSettings())
                .catch(err => debugLog("maps::applyState::sync", err && err.message));
        }
    }

    /** A map name is never translated; only the "nothing showing" word is. */
    renderCurrent() {
        $("#currentMap")
            .text(this.currentKey ? this.currentKey.split("/").pop() : t('home.none'))
            .toggleClass('is-showing', !!this.currentKey);
    }

    send(intent) {
        ipcRenderer.send('map-intent', intent);
    }

    /**
     * A fresh renderer has no preview up, so it says so first: only this window
     * can produce the sample image, and one that died with the Map tab open
     * left main believing a preview it can never refresh is on screen.
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
        // .val()/.text(), so a user-typed creator cannot break out of the markup
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
        // A concurrent read of the same key may have landed first: keep one URL.
        if (this.thumbnails[key]) return this.thumbnails[key];
        const url = URL.createObjectURL(new Blob([data]));
        this.thumbnails[key] = url;
        return url;
    }

    /** Only the one translated word on each card changes; the empty state is rebuilt. */
    retranslateGallery() {
        const $flags = $("#results .map-card-flag");
        if ($flags.length) {
            $flags.text(t('home.onOverlay'));
            return;
        }
        this.renderGallery().catch(err => debugLog("maps::onChange::render", err && err.message));
    }

    async renderGallery() {
        const creator = $("#creatorSelect").val() || "";
        const entries = this.catalog.filter(e => !creator || e.creator === creator);
        // All reads first, then one synchronous build: two renders in flight
        // cannot interleave their cards.
        const urls = await Promise.all(entries.map(entry => this.thumbnail(entry.key)));
        const $results = $("#results").empty();

        if (!entries.length) {
            // Catalogue strings, not user input: `home.noMaps` carries a
            // <code> element, so its markup is ours on purpose.
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
        entries.forEach((entry, index) => {
            const url = urls[index];
            // Custom map names are user-typed: an unescaped quote truncates
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
            // A cached object URL can be decoded before this runs, hence the
            // `complete` check as well as the listener.
            const $thumb = $card.find(".map-card-thumb");
            const img = $card.find("img")[0];
            const done = () => $thumb.addClass("is-loaded");
            $(img).on("load", done).on("error", done);
            if (img.complete && img.naturalWidth > 0) done();
            $results.append($card);
        });
        this.hasRendered = true;

        const self = this;
        $("#results .map-card").on("click", function () {
            self.send({type: 'select', key: $(this).attr("data-key"), source: 'click'});
        });
        this.highlightActive();
    }

    highlightActive() {
        const current = this.currentKey || "";
        $("#results .map-card").each(function () {
            $(this).toggleClass("active", $(this).attr("data-key") === current);
        });
    }
}

module.exports = Maps;
