const fs = require('fs');
const path = require('path');

module.exports.ensureDirectoryExistence = function (filePath) {
    let dirname = path.dirname(filePath);
    if (fs.existsSync(dirname)) {
        return true;
    }
    module.exports.ensureDirectoryExistence(dirname);
    fs.mkdirSync(dirname);
}

module.exports.getFilesFromDir = function (dirPath) {
    let results = [];
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
        const filePath = path.join(dirPath, file);
        if (fs.statSync(filePath).isDirectory()) {
            results = results.concat(module.exports.getFilesFromDir(filePath));
        } else {
            results.push(filePath);
        }
    }
    return results;
}