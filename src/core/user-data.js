const {ensureDirectoryExistence, getFilesFromDir} = require("./utils");
const {app, ipcMain} = require("electron");
const fs = require("fs");
const path = require("path");

/**
 * User-imported map images, stored flat in userData `custom/`; the shipped maps
 * are read-only and belong to `map-library.js`. Every `fileName` below goes
 * through `path.basename`, so a name the user typed cannot escape `custom/`.
 */
class UserData {
    constructor(mapLibrary) {
        this.mapLibrary = mapLibrary || null;
        const customDir = () => path.join(app.getPath('userData'), "custom");
        const invalidate = () => {
            if (this.mapLibrary) this.mapLibrary.invalidate();
        };

        ipcMain.handle('read-custom-data', async (event, fileName) => {
            const fileDir = path.join(customDir(), path.basename(String(fileName || '')))
            ensureDirectoryExistence(fileDir)
            if (!fs.existsSync(fileDir)) {
                return Buffer.from("")
            }
            return await fs.promises.readFile(fileDir);
        })
        ipcMain.handle('write-custom-data', async (event, fileName, data) => {
            const fileDir = path.join(customDir(), path.basename(String(fileName || '')))
            ensureDirectoryExistence(fileDir)
            fs.writeFileSync(fileDir, Buffer.from(data));
            invalidate();
        })
        ipcMain.handle('delete-custom-data', async (event, fileName) => {
            const fileDir = path.join(customDir(), path.basename(String(fileName || '')))
            if (fs.existsSync(fileDir)) fs.unlinkSync(fileDir);
            invalidate();
        })
        ipcMain.handle('get-custom-photos', async () => {
            const fileDir = customDir()
            if (!fs.existsSync(fileDir)) {
                fs.mkdirSync(fileDir, {recursive: true})
            }
            return getFilesFromDir(fileDir).map(file => path.relative(fileDir, file))
        })
    }
}

module.exports = UserData;
