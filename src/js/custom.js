const {ipcRenderer} = require("electron");
const {debugLog} = require("./logger");
const {escapeHtml} = require("../shared/escape-html");

/** Image MIME type → the extension the imported file is stored under. */
const MIME_EXTENSIONS = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
    'image/avif': '.avif'
};

/**
 * Extension to save an imported image under. Stored files keep the format they
 * actually contain, rather than every import being called `.png`.
 */
function extensionFor(file) {
    const byMime = MIME_EXTENSIONS[String(file && file.type || '').toLowerCase()];
    if (byMime) return byMime;
    const match = /\.[a-z0-9]+$/i.exec(String(file && file.name || ''));
    return match ? match[0].toLowerCase() : '.png';
}

/** "Add custom image" modal: import, list and delete user map images. */
class Custom {

    constructor(maps) {
        this.maps = maps;
    }

    async getFileAsBase64($file) {
        return new Promise(function (resolve) {
            const reader = new FileReader();
            reader.onload = function () {
                resolve(reader.result.split("base64,")[1]);
            };
            reader.onerror = function (e) {
                debugLog("custom::getFileAsBase64::error", e.message);
                resolve(false);
            };
            reader.readAsDataURL($file.prop('files')[0]);
        });
    }

    async addCustomMap() {
        $('#loadingOverlay').slideDown();
        $("#loadingContent").text("Saving...");
        try {
            if ($("#custom_file").prop('files').length === 0) throw "Pick an image file";
            if ($("#custom_name").val().length === 0) throw "Enter a map name";

            const file = $("#custom_file").prop('files')[0];
            if (!/^image\//.test(file.type || '')) throw "That file is not an image";

            const imageBase64 = await this.getFileAsBase64($("#custom_file"));
            if (imageBase64 === false) throw "Could not read the image";

            // Slashes/dots would escape the flat custom/ directory or confuse
            // the extension stripping in the catalogue.
            let name = $("#custom_name").val()
                .replace(/[\\/]/g, " ")
                .replace(/\./g, " ")
                .trim();
            if (!name) throw "Enter a map name";

            await ipcRenderer.invoke('write-custom-data', name + extensionFor(file), Buffer.from(imageBase64, "base64"));
            await this.maps.invalidateCache();

            $("#custom_name").val("");
            $("#custom_file").val("");
            await this.generateCustomList();
        } catch (e) {
            debugLog("custom::addCustomMap::error", e);
            alert("Error: " + e);
        } finally {
            $('#loadingOverlay').slideUp();
        }
    }

    async deleteCustomMap(fileName) {
        try {
            if (!fileName) throw "Missing file name";
            await ipcRenderer.invoke('delete-custom-data', fileName);
            await this.maps.invalidateCache();
            await this.generateCustomList();
        } catch (e) {
            debugLog("custom::deleteCustomMap::error", e);
            alert("Error: " + e);
        }
    }

    async generateCustomList() {
        try {
            const $list = $("#customList").html("");
            const files = await ipcRenderer.invoke('get-custom-photos');
            if (!files.length) {
                $list.append(`<tr><td class="text-secondary">No custom images yet.</td></tr>`);
                return;
            }
            for (const file of files) {
                const name = file.replace(/\.[^.]+$/, "");
                const url = await this.maps.thumbnail(`Custom/${name}`);
                // `name` and `file` both come from a user-typed map name
                $list.append(`<tr>
                    <td><img style="width: 220px" class="rounded" src="${escapeHtml(url)}" alt="${escapeHtml(name)}"></td>
                    <td class="align-middle">${escapeHtml(name)}</td>
                    <td class="align-middle">
                        <button type="button" class="btn btn-danger btn-sm" onclick="deleteImage(this)" data-img="${escapeHtml(file)}">Delete</button>
                    </td>
                </tr>`);
            }
        } catch (e) {
            debugLog("custom::generateCustomList::error", e.message);
        }
    }
}

module.exports = Custom;
