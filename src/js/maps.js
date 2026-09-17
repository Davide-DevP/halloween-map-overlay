const {ipcRenderer} = require("electron");
const {debugLog} = require("./logger");
const {findClosestMapMatch, nextMap, prevMap, listCreators, CUSTOM_CREATOR} = require("../core/map-catalog");
const {escapeHtml} = require("../shared/escape-html");

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

        // CLI second instance: `halloween-map-overlay.exe show-map=<key>`
        ipcRenderer.on('show-map-command', (event, key) => {
            const entry = findClosestMapMatch(key, self.catalog);
            if (!entry) {
                debugLog("maps::show-map-command::no-match", key);
                return;
            }
            self.sendMap(entry.key);
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
        select.empty().append($('<option>').val('').text('All creators'));
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
            $results.append(`<p class="text-secondary">No maps found. Run <code>npm run prepare-maps</code> to build them.</p>`);
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
     */
    sendMap(key) {
        // Leaving "set position" mode on would keep the overlay grabbing clicks
        if (this.options && this.options.setting) $("#unset-pos").click();

        const value = key || "";
        if (value) this.lastKey = value;
        this.currentKey = value;
        window.__activeMapKey = value;

        ipcRenderer.send('map-change', value);

        // A map arriving mid-preview must not replace the sample image on screen
        if (this.options && this.options.previewActive) this.options.sendPreview();

        this.highlightActive();
        $("#currentMap").text(value ? value.split("/").pop() : "None");
        return true;
    }
}

module.exports = Maps;
