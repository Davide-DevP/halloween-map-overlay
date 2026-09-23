'use strict';

/**
 * Dev-only: serve `dist/` as an electron-updater "generic" feed on
 * 127.0.0.1, so an installed app can be updated from a local build instead of
 * GitHub Releases. Static files with Range support (the blockmap download
 * asks for ranges), nothing else. Loopback only.
 * Why: docs/agents/updater-and-installer.md § Testing an update locally.
 *
 *   node scripts/serve-updates.js [--dir dist] [--port 8765]
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const root = path.resolve(arg('--dir', 'dist'));
const port = parseInt(arg('--port', '8765'), 10) || 8765;

const TYPES = {'.yml': 'text/yaml', '.exe': 'application/octet-stream', '.blockmap': 'application/octet-stream'};

const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
    const file = path.join(root, name);
    // Inside `root` only, never a parent.
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404);
        res.end('not found');
        console.log(`404 ${req.method} ${name}`);
        return;
    }
    const size = fs.statSync(file).size;
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let start = 0;
    let end = size - 1;
    if (range) {
        if (range[1]) start = parseInt(range[1], 10);
        if (range[2]) end = parseInt(range[2], 10);
        if (!range[1] && range[2]) { start = Math.max(0, size - parseInt(range[2], 10)); end = size - 1; }
        if (start > end || end >= size) {
            res.writeHead(416, {'Content-Range': `bytes */${size}`});
            res.end();
            return;
        }
        res.writeHead(206, {
            'Content-Type': type, 'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1
        });
    } else {
        res.writeHead(200, {'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size});
    }
    console.log(`${res.statusCode} ${req.method} ${name}${range ? ` [${start}-${end}]` : ''}`);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file, {start, end}).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
    const files = fs.existsSync(root) ? fs.readdirSync(root).filter(f => /\.(yml|exe|blockmap)$/i.test(f)) : [];
    console.log(`serving ${root} on http://127.0.0.1:${port}/`);
    console.log(files.length ? files.map(f => `  ${f}`).join('\n') : '  (no yml/exe/blockmap here yet — run the build first)');
    console.log('Ctrl+C stops it.');
});
